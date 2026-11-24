// Tests for hq-ask-mark.js: a safety hook that asks leaves a mark HQ can read, so HQ never answers that ask for the user.
// Run: node --test system/hooks/tests/hq-ask-mark.test.js
//
// Claude Code's PermissionRequest input carries no reason and no tool_use_id, so HQ
// cannot tell a hook's ask from a plain permission prompt. Each asking hook writes one file keyed by the same askKey HQ
// computes from the request it sees. Sandboxed by overriding USERPROFILE/HOME, because os.homedir() is where the mark goes.
'use strict';
require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { askKey, markAsk } = require('../hq-ask-mark.js');

const homes = [];
test.after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });
function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'hqaskmark-'));
  homes.push(h);
  return h;
}
const marksDir = (h) => path.join(h, '.claude', 'hq-feed', 'hook-asks');

function withHome(h, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = h;
  process.env.USERPROFILE = h;
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('askKey is stable under key order at every depth', () => {
  assert.strictEqual(askKey('s1', 'Bash', { a: 1, b: 2 }), askKey('s1', 'Bash', { b: 2, a: 1 }));
  assert.strictEqual(askKey('s1', 'Bash', { o: { x: 1, y: [{ p: 1, q: 2 }] } }), askKey('s1', 'Bash', { o: { y: [{ q: 2, p: 1 }], x: 1 } }));
  assert.notStrictEqual(askKey('s1', 'Bash', { a: 1 }), askKey('s2', 'Bash', { a: 1 }));
  assert.notStrictEqual(askKey('s1', 'Bash', { a: 1 }), askKey('s1', 'Edit', { a: 1 }));
});

test('the key of a fixed call, which the app computes the same way', () => {
  assert.strictEqual(askKey('s1', 'Write', { file_path: 'a.txt', content: 'x' }),
    '63645b6dd5c280ad5045daf7be2ac7ad9125d5c0952531dded6af6cb9cdf0385');
});

test('markAsk writes one file with the hook and a reason capped at 300 characters', () => {
  const h = home();
  const input = { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'x' } };
  withHome(h, () => markAsk(input, 'guard-config.js', 'r'.repeat(500)));
  const files = fs.readdirSync(marksDir(h));
  assert.deepStrictEqual(files, ['63645b6dd5c280ad5045daf7be2ac7ad9125d5c0952531dded6af6cb9cdf0385.json']);
  const mark = JSON.parse(fs.readFileSync(path.join(marksDir(h), files[0]), 'utf8'));
  assert.strictEqual(mark.v, 1);
  assert.strictEqual(mark.hook, 'guard-config.js');
  assert.strictEqual(mark.reason, 'r'.repeat(300));
  assert.ok(Math.abs(Date.now() - mark.at) < 60000);
});

test('markAsk never throws, even on input with no session or a home it cannot write', () => {
  const h = home();
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'hq-feed'), 'a file where the folder should be');
  withHome(h, () => {
    assert.doesNotThrow(() => markAsk({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'x' } }, 'guard-bash.js', 'why'));
    assert.doesNotThrow(() => markAsk(null, 'guard-bash.js', undefined));
  });
});

test('guard-config.js still asks exactly as before and leaves the mark', () => {
  const h = home();
  const input = { session_id: 's9', tool_name: 'Write', tool_input: { file_path: 'C:/repo/eslint.config.js', content: 'x' } };
  const env = { ...process.env, USERPROFILE: h, HOME: h };
  delete env.VIBEQUARTERS_GUARD;
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'guard-config.js')], { input: JSON.stringify(input), env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const reason = 'vibequarters: you\'re editing a quality-gate config (eslint.config.js). Confirm you intend to change ' +
    'the rules, not just to make a failing check pass. Fixing the flagged code is usually the right move. ' +
    'Set VIBEQUARTERS_GUARD=off to disable.';
  assert.strictEqual(r.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }));
  const key = askKey('s9', 'Write', input.tool_input);
  const mark = JSON.parse(fs.readFileSync(path.join(marksDir(h), key + '.json'), 'utf8'));
  assert.strictEqual(mark.hook, 'guard-config.js');
  assert.strictEqual(mark.reason, reason.slice(0, 300));
});

// One ask per hook, each built from that hook's own tests. Slash, backslash and the em dash are made with
// String.fromCharCode so this file itself never trips guard-em-dash.js or guard-comment-stripper.js.
const SL = String.fromCharCode(47), BS = String.fromCharCode(92), EM = String.fromCharCode(0x2014);
const RF = require('./helpers/review-fixture.js');
const REVIEWED_HEAD = '7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';
const ASKERS = [
  { hook: 'guard-bash.js', input: { tool_name: 'Bash', tool_input: { command: 'gh run rerun 1' } } },
  { hook: 'guard-em-dash.js', input: { tool_name: 'Write', tool_input: { file_path: 'a.md', content: `a ${EM} b` } } },
  { hook: 'guard-comment-stripper.js', input: { tool_name: 'Write', tool_input: { file_path: 'a.js',
    content: `s.replace(${SL}${BS}${SL}${BS}*[${BS}s${BS}S]*?${BS}*${BS}${SL}${SL}g, '')` } } },
  { hook: 'guard-skillspector.js', input: { tool_name: 'Bash', tool_input: { command: 'claude mcp add foo' } } },
  { hook: 'guard-runaway.js', input: { tool_name: 'Bash', cwd: 'C:/x/proj', tool_input: { command: 'ls' } },
    setup: (h) => {
      const dir = path.join(h, '.claude', 'projects', 'C--x-proj', 'memory', 'loop');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'RUNSTATE.json'), JSON.stringify({ actions: 400, recent: [] }));
    } },
  // the no-tests ask comes only after the merge gate proves a clean review of the head, so the home holds one
  { hook: 'guard-deny-catastrophic.js', input: { session_id: RF.SID, tool_name: 'Bash', cwd: __dirname, tool_input: { command: `gh pr merge 7 --squash --body-file b.md --match-head-commit ${REVIEWED_HEAD}` } },
    setup: (h) => RF.writeCleanReview(h, { repo: 'other-repo', pr: 7, head: REVIEWED_HEAD }),
    env: { VIBEQUARTERS_GUARD_FAKE_GH: JSON.stringify({ checks: [], view: { number: 7, url: 'https://github.com/acme/other-repo/pull/7',
      baseRefName: 'main', headRefOid: REVIEWED_HEAD, files: [{ path: 'a', changeType: 'MODIFIED' }] } }) } },
  { hook: 'coord-guard.js', input: { tool_name: 'Bash', cwd: __dirname, tool_input: { command: 'bun "C:/h/.claude/hooks/coord.js" force-release a.txt' } } },
];

for (const a of ASKERS) {
  test(`${a.hook} still asks and leaves a mark with its printed reason`, () => {
    const h = home();
    if (a.setup) a.setup(h);
    const input = { session_id: 's-' + a.hook, ...a.input };
    const env = { ...process.env, USERPROFILE: h, HOME: h, ...(a.env || {}) };
    delete env.VIBEQUARTERS_GUARD;
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', a.hook)], { input: JSON.stringify(input), env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, a.hook + ': ' + r.stderr);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.strictEqual(out.permissionDecision, 'ask', a.hook);
    const file = path.join(marksDir(h), askKey(input.session_id, input.tool_name, input.tool_input) + '.json');
    assert.ok(fs.existsSync(file), a.hook + ' left no mark');
    const mark = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(mark.hook, a.hook);
    assert.strictEqual(mark.reason, out.permissionDecisionReason.slice(0, 300), a.hook);
  });
}

test('a hook copied without hq-ask-mark.js beside it still asks', () => {
  const h = home();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hqaskmark-alone-'));
  homes.push(dir);
  fs.copyFileSync(path.join(__dirname, '..', 'guard-config.js'), path.join(dir, 'guard-config.js'));
  const env = { ...process.env, USERPROFILE: h, HOME: h };
  delete env.VIBEQUARTERS_GUARD;
  const r = spawnSync(process.execPath, [path.join(dir, 'guard-config.js')], {
    input: JSON.stringify({ session_id: 's9', tool_name: 'Write', tool_input: { file_path: 'eslint.config.js', content: 'x' } }), env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
});
