#!/usr/bin/env node
// Personal UFC fight alarm: polls ESPN's public scoreboard and pushes a phone
// notification (via ntfy.sh) when the fight before yours ends and when yours starts.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard';
const TOPIC = process.env.NTFY_TOPIC;
const PICKS_TOPIC = process.env.PICKS_TOPIC;
const PICKS_FILE = new URL('./docs/watch.json', import.meta.url);
const DRY_RUN = process.env.DRY_RUN === '1';
const POLL_MS = 30_000;
const LEAD_MS = Number(process.env.LEAD_MIN || 75) * 60_000; // start watching this long before the first bout
const MAX_RUN_MS = 350 * 60_000; // GitHub Actions kills jobs at 6h; the next hourly run picks up from here

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Flatten an ESPN event into bouts, opener first, main event last.
export function bouts(event) {
  const list = event.competitions.map(c => ({
    id: c.id,
    name: c.competitors.map(x => x.athlete.displayName).join(' vs '),
    winner: c.competitors.find(x => x.winner)?.athlete.displayName,
    division: c.type?.abbreviation ?? '',
    state: c.status.type.state, // 'pre' | 'in' | 'post'
    detail: c.status.type.shortDetail || c.status.type.detail,
    start: Date.parse(c.date),
  }));
  return list.length > 1 && list[0].start > list.at(-1).start ? list.reverse() : list;
}

// Bout ids picked on the picker page for this event, or null (= alert for every fight).
export function pickedIds(picks, event) {
  return picks?.eventId === event.id ? new Set(picks.bouts) : null;
}

const watched = (bout, picked) => !picked || picked.has(bout.id);

// Compare previous bout states to the current ones and decide what to push.
export function changes(prev, list, picked) {
  const out = [];
  const announced = new Set();
  list.forEach((b, i) => {
    const was = prev.get(b.id);
    if (!was || was === b.state) return;
    if (b.state === 'in' && watched(b, picked)) {
      out.push({ title: `LIVE: ${b.name}`, message: `${b.division} is underway`, priority: 4, tags: ['boxing_glove'] });
    }
    if (b.state === 'post') {
      if (watched(b, picked)) {
        out.push({ title: `Result: ${b.name}`, message: b.winner ? `${b.winner} wins (${b.detail})` : b.detail, priority: 2, tags: ['checkered_flag'] });
      }
      const next = list.slice(i + 1).find(n => n.state !== 'post'); // skips cancelled bouts
      if (next?.state === 'pre' && !announced.has(next.id) && watched(next, picked)) {
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

// The picker page publishes picks to PICKS_TOPIC, where ntfy keeps them for 12h.
// Copy anything newer into docs/watch.json (committed by the workflow) so picks
// made days ahead of a card survive.
async function latestPicks() {
  let saved = null;
  try {
    saved = JSON.parse(readFileSync(PICKS_FILE, 'utf8'));
  } catch {}
  if (!PICKS_TOPIC) return saved;
  try {
    const res = await fetch(`https://ntfy.sh/${PICKS_TOPIC}/json?poll=1&since=12h`);
    const fresh = (await res.text()).split('\n').filter(Boolean).map(l => JSON.parse(l))
      .filter(m => m.event === 'message').map(m => { try { return JSON.parse(m.message); } catch { return null; } })
      .filter(p => p?.eventId).at(-1);
    if (fresh && fresh.updated > (saved?.updated ?? 0)) {
      writeFileSync(PICKS_FILE, JSON.stringify(fresh, null, 2) + '\n');
      console.log(`Picks updated: ${fresh.bouts.length} fights for ${fresh.event}`);
      return fresh;
    }
  } catch (err) {
    console.error(`picks: ${err.message}`);
  }
  return saved;
}

async function scoreboard() {
  const res = await fetch(SCOREBOARD, { cache: 'no-store' });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return res.json();
}

async function notify(n) {
  console.log(`[p${n.priority}] ${n.title} | ${n.message}`);
  if (DRY_RUN) return;
  const res = await fetch('https://ntfy.sh', { method: 'POST', body: JSON.stringify({ topic: TOPIC, ...n }) });
  if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
}

async function main() {
  if (!TOPIC && !DRY_RUN) throw new Error('Set NTFY_TOPIC (or DRY_RUN=1)');
  const started = Date.now();
  let picks = await latestPicks();
  const event = activeEvent(await scoreboard(), started);
  if (!event) return console.log('No card in progress or starting soon.');

  let list = bouts(event);
  let picked = pickedIds(picks, event);
  console.log(`Watching ${event.name}`);
  if (list.every(b => b.state === 'pre')) {
    const first = new Date(Math.min(...list.map(b => b.start)));
    const scope = picked ? `${picked.size} of ${list.length} fights picked` : 'All fights (no picks made)';
    await notify({ title: `Fight alarm armed: ${event.name}`, message: `${scope}. First bout ${first.toUTCString()}.`, priority: 2, tags: ['alarm_clock'] });
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
    picks = await latestPicks();
    picked = pickedIds(picks, ev);
    list = bouts(ev);
    for (const n of changes(prev, list, picked)) await notify(n).catch(err => console.error(err.message));
    prev = new Map(list.map(b => [b.id, b.state]));
    if (list.every(b => b.state === 'post')) return console.log('Card finished.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
