#!/usr/bin/env node
// UFC fight alarm: polls ESPN's public scoreboard and pushes phone notifications
// (via ntfy.sh) when the fight before a picked one ends and when it starts.
// Serves the owner (NTFY_TOPIC/PICKS_TOPIC) plus any friends listed in FRIENDS.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard';
const PICKS_DIR = new URL('./docs/picks/', import.meta.url);
const DRY_RUN = process.env.DRY_RUN === '1';
const ARMED_UNTIL = Date.parse(process.env.ARMED_UNTIL || '') || 0; // push the "armed" notice only before this date
const POLL_MS = 30_000;
const LEAD_MS = Number(process.env.LEAD_MIN || 75) * 60_000; // start watching this long before the first bout
const MAX_RUN_MS = 350 * 60_000; // GitHub Actions kills jobs at 6h; the next hourly run picks up from here

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Friends are "name alertTopic picksTopic" lines in FRIENDS (managed by friends.mjs).
export function parseUsers(env) {
  const users = [];
  if (env.NTFY_TOPIC) users.push({ name: 'owner', alert: env.NTFY_TOPIC, picks: env.PICKS_TOPIC });
  for (const line of (env.FRIENDS || '').split('\n')) {
    const [name, alert, picks] = line.trim().split(/\s+/);
    if (alert && picks) users.push({ name, alert, picks });
  }
  return users;
}

// Saved picks live in docs/picks/<key>.json; hashing keeps topic names out of the public repo.
export const picksKey = topic => createHash('sha256').update(topic).digest('hex').slice(0, 16);

// Flatten an ESPN event into bouts, opener first, main event last.
export function bouts(event) {
  const list = event.competitions.map(c => ({
    id: c.id,
    name: c.competitors.map(x => x.athlete?.displayName ?? 'TBA').join(' vs '),
    winner: c.competitors.find(x => x.winner)?.athlete?.displayName,
    division: c.type?.abbreviation ?? '',
    state: c.status.type.state, // 'pre' | 'in' | 'post'
    detail: c.status.type.shortDetail || c.status.type.detail,
    start: Date.parse(c.date),
  }));
  return list.length > 1 && list[0].start > list.at(-1).start ? list.reverse() : list;
}

// Picks are { updated, events: { [eventId]: { all: true } | { bouts: [ids] } } }.
// Older single-event picks ({ eventId, bouts, all }) are converted.
export function normalizePicks(p) {
  if (p?.events) return p;
  if (p?.eventId) return { updated: p.updated, events: { [p.eventId]: p } };
  return { updated: 0, events: {} };
}

// Bout ids picked for this event, or null when nothing was picked or every fight
// was (however it was saved): then only the start of each card segment alerts.
export function pickedIds(picks, event) {
  const e = normalizePicks(picks).events[event.id];
  if (!e || e.all) return null;
  const ids = new Set(e.bouts);
  return event.competitions.every(c => ids.has(c.id)) ? null : ids;
}

// Group bouts into card segments by scheduled start time; the latest is the main card.
export function segments(list) {
  const times = [...new Set(list.map(b => b.start))].sort((a, b) => a - b);
  const label = i => (i === times.length - 1 ? 'Main card' : i === times.length - 2 ? 'Prelims' : 'Early prelims');
  return times.map((t, i) => ({ label: label(i), start: t, first: list.find(b => b.start === t).id }));
}

// One alert per segment: ~10 min before the first segment's scheduled start, and
// when the last fight of the previous segment ends for the rest. Falls back to
// "is live" if ESPN skips straight to the segment's opener starting.
export function segmentAlerts(prev, list, segs, sent, now) {
  const out = [];
  for (const s of segs) {
    const i = list.findIndex(b => b.id === s.first);
    const opener = list[i];
    if (!opener || sent.has(s.first)) continue;
    let alert;
    if (opener.state === 'pre') {
      const due = i === 0 ? now >= s.start - 10 * 60_000 : list.slice(0, i).every(b => b.state === 'post');
      if (due) alert = { title: `${s.label}: starting in ~10 min`, message: `Opening fight: ${opener.name}` };
    } else if (opener.state === 'in' && prev.get(opener.id) === 'pre') {
      alert = { title: `${s.label}: live now`, message: `Opening fight: ${opener.name}` };
    }
    if (alert) {
      sent.add(s.first);
      out.push({ ...alert, priority: 5, tags: ['rotating_light'] });
    }
  }
  return out;
}

// Compare previous bout states to the current ones and decide what to push for picked fights.
export function changes(prev, list, picked) {
  const out = [];
  const announced = new Set();
  list.forEach((b, i) => {
    const was = prev.get(b.id);
    if (!was || was === b.state) return;
    if (b.state === 'in' && picked.has(b.id)) {
      out.push({ title: `LIVE: ${b.name}`, message: `${b.division} is underway`, priority: 4, tags: ['boxing_glove'] });
    }
    if (b.state === 'post') {
      if (picked.has(b.id)) {
        out.push({ title: `Result: ${b.name}`, message: b.winner ? `${b.winner} wins (${b.detail})` : b.detail, priority: 2, tags: ['checkered_flag'] });
      }
      const next = list.slice(i + 1).find(n => n.state !== 'post'); // skips cancelled bouts
      if (next?.state === 'pre' && !announced.has(next.id) && picked.has(next.id)) {
        announced.add(next.id);
        out.push({ title: `UP NEXT: ${next.name}`, message: `${next.division}, walkouts in ~10 min`, priority: 5, tags: ['rotating_light'] });
      }
    }
  });
  return out;
}

export function activeEvent(data, now) {
  return data.events.find(e => {
    const list = bouts(e);
    const first = Math.min(...list.map(b => b.start));
    if (list.every(b => b.state === 'post') || first < now - 12 * 3600_000) return false;
    return list.some(b => b.state === 'in') || first - now < LEAD_MS;
  });
}

// The picker page publishes picks to the user's picks topic, where ntfy keeps them
// for 12h. Copy anything newer into docs/picks (committed by the workflow) so picks
// made days ahead of a card survive.
async function latestPicks(user) {
  if (!user.picks) return null;
  const file = new URL(`${picksKey(user.picks)}.json`, PICKS_DIR);
  let saved = null;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  try {
    const res = await fetch(`https://ntfy.sh/${user.picks}/json?poll=1&since=12h`);
    const fresh = (await res.text()).split('\n').filter(Boolean).map(l => JSON.parse(l))
      .filter(m => m.event === 'message').map(m => { try { return JSON.parse(m.message); } catch { return null; } })
      .filter(p => p?.events || p?.eventId).map(normalizePicks).at(-1);
    if (fresh && fresh.updated > (saved?.updated ?? 0)) {
      mkdirSync(PICKS_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify(fresh, null, 2) + '\n');
      console.log(`Picks updated for ${user.name}: ${Object.keys(fresh.events).length} event(s)`);
      return fresh;
    }
  } catch (err) {
    console.error(`picks (${user.name}): ${err.message}`);
  }
  return saved;
}

async function scoreboard() {
  const res = await fetch(SCOREBOARD, { cache: 'no-store' });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return res.json();
}

async function notify(user, n) {
  console.log(`[${user.name} p${n.priority}] ${n.title} | ${n.message}`);
  if (DRY_RUN) return;
  const res = await fetch('https://ntfy.sh', { method: 'POST', body: JSON.stringify({ topic: user.alert, ...n }) });
  if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
}

async function main() {
  const users = parseUsers(process.env);
  if (!users.length && !DRY_RUN) throw new Error('Set NTFY_TOPIC (or DRY_RUN=1)');
  if (!users.length) users.push({ name: 'dry-run' });
  const started = Date.now();
  for (const u of users) u.saved = await latestPicks(u); // also persists new picks on runs with no card
  const event = activeEvent(await scoreboard(), started);
  if (!event) return console.log('No card in progress or starting soon.');

  let list = bouts(event);
  // Fixed for the run in case ESPN rewrites bout times to actual start times mid-card.
  const segs = segments(list);
  console.log(`Watching ${event.name} for ${users.length} user(s)`);
  for (const u of users) {
    u.sent = new Set();
    const picked = pickedIds(u.saved, event);
    if (list.every(b => b.state === 'pre') && picked?.size !== 0) {
      const first = new Date(Math.min(...list.map(b => b.start)));
      const scope = picked ? `${picked.size} of ${list.length} fights picked` : `Segment starts only (${segs.map(s => s.label).join(', ')})`;
      const armed = { title: `Fight alarm armed: ${event.name}`, message: `${scope}. First bout ${first.toUTCString()}.`, priority: 2, tags: ['alarm_clock'] };
      if (started < ARMED_UNTIL) await notify(u, armed).catch(err => console.error(err.message));
      else console.log(`[${u.name}] ${armed.title} | ${armed.message}`);
    }
  }

  let prev = new Map(list.map(b => [b.id, b.state]));
  while (Date.now() - started < MAX_RUN_MS) {
    await sleep(POLL_MS);
    let ev;
    try {
      ev = (await scoreboard()).events.find(e => e.id === event.id);
    } catch (err) {
      console.error(err.message);
      continue;
    }
    if (!ev) continue;
    list = bouts(ev);
    for (const u of users) {
      u.saved = await latestPicks(u);
      const picked = pickedIds(u.saved, ev);
      const alerts = picked ? changes(prev, list, picked) : segmentAlerts(prev, list, segs, u.sent, Date.now());
      for (const n of alerts) await notify(u, n).catch(err => console.error(err.message));
    }
    prev = new Map(list.map(b => [b.id, b.state]));
    if (list.every(b => b.state === 'post')) return console.log('Card finished.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
