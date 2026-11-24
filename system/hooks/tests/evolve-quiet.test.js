// Tests for /evolve step 0b's quiet wait (commands/evolve.md): the quiet() line, run as the skill
// runs it, in Git Bash against a throwaway loop folder.
// Run: node --test system/hooks/tests/evolve-quiet.test.js
'use strict';
require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL = path.join(__dirname, '..', '..', 'commands', 'evolve.md');
const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const quietLine = () => fs.readFileSync(SKILL, 'utf8').split(/\r?\n/).find((l) => l.startsWith('quiet() {'));

function loopDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-loop-'));
  const old = new Date(Date.now() - 10 * 60000);
  for (const [name, fresh] of Object.entries(files)) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, 'x\n');
    if (!fresh) fs.utimesSync(f, old, old);
  }
  return dir;
}

// Exit code of quiet() for the folder: 0 quiet, 1 a peer is busy.
function quiet(dir, before = '') {
  const go = () => spawnSync(BASH, ['-c', `LOOP="$1"\n${before}\n${quietLine()}\nquiet`, 'quiet', dir.replace(/\\/g, '/')], { encoding: 'utf8' });
  let r = go();
  for (let i = 0; i < 5 && /\bfork\b|cygheap/.test(r.stderr); i++) r = go(); // Git Bash on a full machine could not start a process
  assert.ok(r.status === 0 || r.status === 1, `bash ran: ${r.status} ${r.stderr}`);
  return r.status;
}

const skip = !fs.existsSync(BASH) && process.platform === 'win32' ? 'Git Bash not found' : false;

test('step 0b defines quiet() before the backup', { skip }, () => {
  const text = fs.readFileSync(SKILL, 'utf8');
  assert.ok(quietLine(), 'the quiet() line is in evolve.md');
  const wait = text.indexOf('until quiet; do');
  assert.ok(wait >= 0 && wait < text.indexOf('STAMP=$(date'), 'the wait loop is there and runs before the backup');
});

test('a ledger or a .bak-<stamp> written under 3 minutes ago means wait', { skip }, () => {
  for (const name of ['LEARNING-LOG.md', 'PATTERNS.md', 'MISTAKES.md.bak-20300101-000000', 'EFFICIENCY.md', 'PREFERENCES.md.bak-20300101-000000']) {
    assert.strictEqual(quiet(loopDir({ 'PATTERNS.md': false, [name]: true })), 1, name);
  }
});

test('negative controls: old ledgers, and fresh SPOT, INBOX or a sibling ledger, are quiet', { skip }, () => {
  assert.strictEqual(quiet(loopDir({ 'LEARNING-LOG.md': false, 'PATTERNS.md': false, 'MISTAKES.md.bak-20300101-000000': false })), 0);
  assert.strictEqual(quiet(loopDir({ 'LEARNING-LOG.md': false, 'SPOT.md': true, 'INBOX.md': true, 'PATTERNS-MORE.md': true, 'ACTION-LEDGER.jsonl': true })), 0);
});

test('a find that cannot run means wait, not quiet', { skip }, () => {
  assert.strictEqual(quiet(loopDir({ 'PATTERNS.md': false }), 'find() { return 1; }'), 1);
});
