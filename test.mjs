// Replays a fake fight night against a saved ESPN scoreboard: node test.mjs espn.json
import { readFileSync } from 'node:fs';
import { bouts, changes, activeEvent, pickedIds, segments, segmentAlerts } from './fightalarm.mjs';

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const event = data.events[0];
const comps = event.competitions;
const last = comps.length - 1;
const step = (i, state, winner) => {
  comps[i].status.type.state = state;
  if (winner !== undefined) comps[i].competitors[winner].winner = true;
};

console.log('active 30 min before:', !!activeEvent(data, Date.parse(comps[0].date) - 30 * 60_000));
console.log('active 3 h before:   ', !!activeEvent(data, Date.parse(comps[0].date) - 180 * 60_000));

const opener = Date.parse(comps[0].date);
const mainStart = comps.findIndex(c => c.date === comps[last].date);
const scenarios = {
  'no picks (segment mode)': null,
  'every fight picked (segment mode)': { eventId: event.id, bouts: comps.map(c => c.id), all: true },
  'picked main event only': { eventId: event.id, bouts: [comps[last].id] },
  'picks for a different card': { eventId: 'other', bouts: [comps[last].id] },
};
for (const [label, picks] of Object.entries(scenarios)) {
  console.log(`\n--- ${label} ---`);
  comps.forEach(c => { c.status.type.state = 'pre'; c.competitors.forEach(x => delete x.winner); });
  const picked = pickedIds(picks, event);
  const segs = segments(bouts(event));
  const sent = new Set();
  let prev = new Map(bouts(event).map(b => [b.id, b.state]));
  const tick = (now, note) => {
    const list = bouts(event);
    const alerts = picked ? changes(prev, list, picked) : segmentAlerts(prev, list, segs, sent, now);
    alerts.forEach(n => console.log(`  ${note.padEnd(22)} [p${n.priority}] ${n.title} | ${n.message}`));
    prev = new Map(list.map(b => [b.id, b.state]));
  };
  tick(opener - 30 * 60_000, '30 min before');
  tick(opener - 9 * 60_000, '9 min before');
  step(0, 'in'); tick(opener, 'opener live');
  tick(opener, 'opener live (again)');
  step(0, 'post', 0); tick(opener, 'opener ends');
  for (let i = 1; i < mainStart - 1; i++) step(i, 'post', 1);
  step(mainStart - 1, 'in'); tick(opener, 'last prelim live');
  step(mainStart - 1, 'post', 0); tick(opener, 'last prelim ends');
  step(mainStart, 'in'); tick(opener, 'main card opener live');
  for (let i = mainStart; i < last; i++) step(i, 'post', 1);
  tick(opener, 'co-main ends');
  step(last, 'in'); tick(opener, 'main event live');
}
