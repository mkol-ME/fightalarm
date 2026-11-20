#!/usr/bin/env node
// Manage friends who get their own picks and alerts: node friends.mjs add|remove|list [name]
// The list lives in friends.txt (gitignored) and is uploaded as the FRIENDS secret,
// because GitHub secrets can't be read back.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('./friends.txt', import.meta.url);
const PAGE = 'https://mkol-me.github.io/fightalarm/';
const [cmd, name] = process.argv.slice(2);
const lines = existsSync(FILE) ? readFileSync(FILE, 'utf8').split('\n').filter(Boolean) : [];
const find = n => lines.findIndex(l => l.split(' ')[0] === n);
const show = line => {
  const [n, alert, picks] = line.split(' ');
  console.log(`${n}\n  ntfy topic: ${alert}\n  picker:     ${PAGE}#${picks}`);
};

function upload() {
  writeFileSync(FILE, lines.join('\n') + '\n');
  // gh rejects an empty secret, and the script ignores lines without topics.
  execFileSync('gh', ['secret', 'set', 'FRIENDS'], { input: lines.join('\n') || '-', stdio: ['pipe', 'inherit', 'inherit'] });
}

if (cmd === 'add' && /^\S+$/.test(name ?? '')) {
  if (find(name) !== -1) throw new Error(`${name} is already a friend`);
  const id = () => randomBytes(6).toString('hex');
  lines.push(`${name} fightalarm-${id()} fightpicks-${id()}`);
  upload();
  show(lines.at(-1));
} else if (cmd === 'remove' && name) {
  const i = find(name);
  if (i === -1) throw new Error(`no friend named ${name}`);
  lines.splice(i, 1);
  upload();
  console.log(`Removed ${name}`);
} else if (cmd === 'list') {
  lines.forEach(show);
} else {
  console.log('usage: node friends.mjs add|remove|list [name]');
}
