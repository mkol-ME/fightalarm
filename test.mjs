// Replays a fake fight night against a saved ESPN scoreboard: node test.mjs espn.json
import { readFileSync } from 'node:fs';
import { bouts, changes, activeEvent, pickedIds } from './fightalarm.mjs';

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

const scenarios = {
  'no picks (all fights)': null,
  'picked main event only': { eventId: event.id, bouts: [comps[last].id] },
  'picks for a different card': { eventId: 'other', bouts: [comps[last].id] },
};
for (const [label, picks] of Object.entries(scenarios)) {
  console.log(`\n--- ${label} ---`);
  comps.forEach(c => { c.status.type.state = 'pre'; c.competitors.forEach(x => delete x.winner); });
  const picked = pickedIds(picks, event);
  let prev = new Map(bouts(event).map(b => [b.id, b.state]));
  const tick = () => {
    const list = bouts(event);
    changes(prev, list, picked).forEach(n => console.log(`[p${n.priority}] ${n.title} | ${n.message}`));
    prev = new Map(list.map(b => [b.id, b.state]));
  };
  step(0, 'in'); tick();
  step(0, 'post', 0); tick();
  for (let i = 1; i < last - 1; i++) step(i, 'post', 1);
  step(last - 1, 'in'); tick();      // co-main live
  step(last - 1, 'post', 0); tick(); // co-main ends -> main event up next
  step(last, 'in'); tick();
}
