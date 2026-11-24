// Tests for loop-action-ledger.js.
// Run: node --test system/hooks/tests/loop-action-ledger.test.js
'use strict';
require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LEDGER = path.join(__dirname, '..', 'loop-action-ledger.js');
const GUARD = path.join(__dirname, '..', 'guard-runaway.js');

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgersig-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });
  const key = project.replace(/[^a-zA-Z0-9]/g, '-');
  return { home, project, loop: path.join(home, '.claude', 'projects', key, 'memory', 'loop') };
}

function run(hook, sb, tool, toolInput) {
  const env = { ...process.env, USERPROFILE: sb.home, HOME: sb.home };
  delete env.VIBEQUARTERS_GUARD;
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: sb.project, session_id: 's1' }),
    env,
    encoding: 'utf8',
  });
}

const runstate = (sb) => JSON.parse(fs.readFileSync(path.join(sb.loop, 'RUNSTATE.json'), 'utf8'));
const asks = (sb, tool, toolInput) => /"permissionDecision":"ask"/.test(run(GUARD, sb, tool, toolInput).stdout);

test('six different edits to one file are six signatures and do not ask', (t) => {
  const sb = sandbox(t);
  const fp = path.join(sb.project, 'plan.md');
  for (let i = 0; i < 6; i++) {
    const r = run(LEDGER, sb, 'Edit', { file_path: fp, old_string: `line ${i}`, new_string: `line ${i} fixed` });
    assert.equal(r.status, 0);
  }
  const recent = runstate(sb).recent;
  assert.equal(recent.length, 6);
  assert.equal(new Set(recent).size, 6);
  assert.equal(asks(sb, 'Edit', { file_path: fp, old_string: 'line 6', new_string: 'x' }), false);
});

test('the same edit retried six times still asks', (t) => {
  const sb = sandbox(t);
  const fp = path.join(sb.project, 'plan.md');
  for (let i = 0; i < 6; i++) run(LEDGER, sb, 'Edit', { file_path: fp, old_string: 'a', new_string: 'b' });
  assert.equal(new Set(runstate(sb).recent).size, 1);
  assert.equal(asks(sb, 'Edit', { file_path: fp, old_string: 'a', new_string: 'b' }), true);
});

test('Write, MultiEdit and NotebookEdit tell different content apart too', (t) => {
  const sb = sandbox(t);
  const fp = path.join(sb.project, 'a.js');
  run(LEDGER, sb, 'Write', { file_path: fp, content: 'one' });
  run(LEDGER, sb, 'Write', { file_path: fp, content: 'two' });
  run(LEDGER, sb, 'MultiEdit', { file_path: fp, edits: [{ old_string: 'a', new_string: 'b' }] });
  run(LEDGER, sb, 'MultiEdit', { file_path: fp, edits: [{ old_string: 'c', new_string: 'd' }] });
  run(LEDGER, sb, 'NotebookEdit', { notebook_path: fp, new_source: 'x = 1' });
  run(LEDGER, sb, 'NotebookEdit', { notebook_path: fp, new_source: 'x = 2' });
  assert.equal(new Set(runstate(sb).recent).size, 6);
});

test('a shell command repeated six times still asks (control)', (t) => {
  const sb = sandbox(t);
  for (let i = 0; i < 6; i++) run(LEDGER, sb, 'Bash', { command: 'npm test' });
  assert.equal(asks(sb, 'Bash', { command: 'npm test' }), true);
});

const LONG_HEAD = `node tools/build.js --out ${'deep/'.repeat(40)}result`;

test('different shell commands that share a 160-character head are different signatures and do not ask', (t) => {
  const sb = sandbox(t);
  for (let i = 0; i < 8; i++) run(LEDGER, sb, 'Bash', { command: `${LONG_HEAD} -Step ${i}` });
  assert.equal(new Set(runstate(sb).recent).size, 8);
  assert.equal(asks(sb, 'Bash', { command: `${LONG_HEAD} -Step 8` }), false);
});

test('the same long shell command retried six times still asks', (t) => {
  const sb = sandbox(t);
  for (let i = 0; i < 6; i++) run(LEDGER, sb, 'Bash', { command: `${LONG_HEAD} -Step 1` });
  assert.equal(asks(sb, 'Bash', { command: `${LONG_HEAD} -Step 1` }), true);
});

test('a question to the user is never held, even right after a real repeat', (t) => {
  const sb = sandbox(t);
  for (let i = 0; i < 6; i++) run(LEDGER, sb, 'Bash', { command: 'npm test' });
  assert.equal(asks(sb, 'AskUserQuestion', { questions: [{ question: 'Which?', header: 'Pick', options: [], multiSelect: false }] }), false);
});

test('each ledger row names the session that made it', (t) => {
  const sb = sandbox(t);
  run(LEDGER, sb, 'Bash', { command: 'npm test' });
  const row = JSON.parse(fs.readFileSync(path.join(sb.loop, 'ACTION-LEDGER.jsonl'), 'utf8').split('\n')[0]);
  assert.equal(row.sid, 's1');
});

test('the forensic ledger keeps the path only, never the edit text', (t) => {
  const sb = sandbox(t);
  const fp = path.join(sb.project, 'notes.md');
  run(LEDGER, sb, 'Edit', { file_path: fp, old_string: 'canary-old-7731', new_string: 'canary-new-7731' });
  const all = fs.readFileSync(path.join(sb.loop, 'ACTION-LEDGER.jsonl'), 'utf8') +
    fs.readFileSync(path.join(sb.loop, 'RUNSTATE.json'), 'utf8');
  assert.equal(all.includes('canary'), false);
  assert.equal(JSON.parse(all.split('\n')[0]).target, fp.replace(/\s+/g, ' '));
});

test('a secret shape in a command or a url is masked in the ledger', (t) => {
  const sb = sandbox(t);
  const secret = 'ghp_' + 'A1b2'.repeat(9);
  run(LEDGER, sb, 'Bash', { command: `curl -H "x: ${secret}" https://example.com` });
  run(LEDGER, sb, 'Bash', { command: `API_KEY=${'z9'.repeat(12)} node a.js --password hunter22hunter` });
  const text = fs.readFileSync(path.join(sb.loop, 'ACTION-LEDGER.jsonl'), 'utf8');
  assert.ok(text.includes('curl -H') && text.includes('node a.js'), text);
  for (const s of [secret, secret.slice(0, 20), 'z9z9', 'hunter22']) assert.ok(!text.includes(s), text);
});
