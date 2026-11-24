// Tests for guard-runaway.js: the repeat ask says what to do next.
// Run: node --test system/hooks/tests/guard-runaway.test.js
// Drives the hook as Claude Code does (JSON on stdin) against a throwaway home holding RUNSTATE.json.
'use strict';
require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'guard-runaway.js');

function run(state) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runaway-')));
  const cwd = path.join(home, 'work');
  const key = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(home, '.claude', 'projects', key, 'memory', 'loop');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'RUNSTATE.json'), JSON.stringify(state));
  const env = { ...process.env, HOME: home, USERPROFILE: home }; // hq-ask-mark writes under this throwaway home too
  delete env.VIBEQUARTERS_GUARD;
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'x' }, cwd }), env, encoding: 'utf8' });
  if (!r.stdout.trim()) return { decision: 'allow', reason: '' };
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
}

test('six identical actions in a row ask, and the ask says when to change approach', () => {
  const r = run({ actions: 7, recent: Array(6).fill('Bash:npm test') });
  assert.strictEqual(r.decision, 'ask');
  assert.ok(r.reason.includes('has repeated 6x in a row'), r.reason);
  assert.ok(r.reason.includes('repeating it will not help: use another approach'), r.reason);
  assert.ok(r.reason.includes('a temporary reason such as a timeout or a rate limit'), r.reason);
  assert.ok(r.reason.includes('approving lets it try again'), r.reason);
});

test('negative control: the same action alternating with another never asks', () => {
  const r = run({ actions: 7, recent: ['A', 'B', 'A', 'B', 'A', 'B', 'A'] });
  assert.strictEqual(r.decision, 'allow');
});
