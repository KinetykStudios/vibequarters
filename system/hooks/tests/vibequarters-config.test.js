// vibequarters-config.js: the settings every hook reads, the documented example, and what is off or gated by default.
'use strict';
const C = require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../vibequarters-config');

const HOOKS = path.join(__dirname, '..');
const EXAMPLE = path.join(HOOKS, '..', 'config', 'vibequarters.config.example.json');
const load = (env) => JSON.parse(spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).load()))', path.join(HOOKS, 'vibequarters-config.js')], { encoding: 'utf8', env: { ...process.env, ...env } }).stdout);
const raw = (text) => { const f = C.write({}); fs.writeFileSync(f, text); return f; };
const hook = (name, payload, env) => {
  const r = spawnSync(process.execPath, [path.join(HOOKS, name)], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : {};
};

test('no file, a broken file and a wrong shape all mean the defaults', () => {
  const none = load({ VIBEQUARTERS_CONFIG: path.join(os.tmpdir(), 'vibequarters-no-such-file.json') });
  assert.deepStrictEqual(none, JSON.parse(JSON.stringify(P.DEFAULTS)));
  for (const text of ['{ not json', '[]', '"x"', 'null', '']) assert.deepStrictEqual(load({ VIBEQUARTERS_CONFIG: raw(text) }), none, text);
});

test('objects merge key by key, lists and values replace', () => {
  const c = load({ VIBEQUARTERS_CONFIG: raw(JSON.stringify({ coordination: { lockMinutes: 5 }, mergeGate: { liveBranches: ['trunk'] }, locks: [] })) });
  assert.strictEqual(c.coordination.lockMinutes, 5);
  assert.strictEqual(c.coordination.liveHours, 72);
  assert.deepStrictEqual(c.mergeGate.liveBranches, ['trunk']);
  assert.deepStrictEqual(c.locks, []);
});

test('a value of the wrong kind where the default is an object or a list keeps the default', () => {
  const none = JSON.parse(JSON.stringify(P.DEFAULTS));
  const objects = Object.keys(none).filter((k) => none[k] && typeof none[k] === 'object' && !Array.isArray(none[k]));
  for (const bad of [null, 'x', 3, true, []]) {
    for (const k of objects) assert.deepStrictEqual(load({ VIBEQUARTERS_CONFIG: raw(JSON.stringify({ [k]: bad })) })[k], none[k], `${k}: ${JSON.stringify(bad)}`);
  }
  for (const bad of [null, 'main', {}]) {
    const c = load({ VIBEQUARTERS_CONFIG: raw(JSON.stringify({ mergeGate: { liveBranches: bad }, locks: bad })) });
    assert.deepStrictEqual(c.mergeGate.liveBranches, none.mergeGate.liveBranches);
    assert.deepStrictEqual(c.locks, none.locks);
  }
  // and the guard that reads them still denies
  const env = { VIBEQUARTERS_CONFIG: raw('{"mergeGate":null}') };
  const o = hook('guard-deny-catastrophic.js', { session_id: 's', cwd: os.tmpdir(), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: ['git', 'push', '--force', 'origin', 'main'].join(' ') } }, env);
  assert.strictEqual(o.permissionDecision, 'deny');
});

test('the example documents every key, holds every default, and loads as the defaults', () => {
  const ex = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  const { _about: about, ...values } = ex;
  assert.deepStrictEqual(values, JSON.parse(JSON.stringify(P.DEFAULTS)));
  for (const [k, v] of Object.entries(P.DEFAULTS)) {
    const keys = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).map((x) => `${k}.${x}`) : [k];
    for (const key of keys) assert.ok(about[key] && about[key].length > 10, `_about documents ${key}`);
  }
  for (const key of Object.keys(about)) {
    if (key === 'readMe') continue;
    const [a, b] = key.split('.');
    assert.ok(b === undefined ? a in P.DEFAULTS : b in P.DEFAULTS[a], `_about.${key} names a real key`);
  }
});

test('off by default: the fixer feature, auto /evolve, the PR declaration and every batch repo', () => {
  assert.strictEqual(P.DEFAULTS.coordination.fixerPrefix, '');
  assert.strictEqual(P.DEFAULTS.loop.autoEvolve, false);
  assert.strictEqual(P.DEFAULTS.mergeGate.requirePrDeclaration, false);
  assert.deepStrictEqual(P.DEFAULTS.mergeGate.batchRepos, []);
  assert.strictEqual(P.DEFAULTS.mergeGate.requireReview, true, 'control: the review is on by default');
});

test('the lock table covers Supabase, Vercel, Netlify and Fly deploys, and a row that does not compile is skipped', () => {
  const rows = P.lockRows();
  const lockOf = (cmd) => rows.filter((r) => r.shell && r.shell.test(cmd)).map((r) => r.lock);
  assert.deepStrictEqual(lockOf('supabase db push'), ['db-migration']);
  assert.deepStrictEqual(lockOf('supabase functions deploy hello'), ['edge-deploy']);
  assert.deepStrictEqual(lockOf('vercel deploy --prod'), ['prod-deploy']);
  assert.deepStrictEqual(lockOf('netlify deploy --prod'), ['prod-deploy']);
  assert.deepStrictEqual(lockOf('fly deploy'), ['prod-deploy']);
  assert.deepStrictEqual(lockOf('vercel deploy'), [], 'control: a preview deploy takes no lock');
  assert.deepStrictEqual(lockOf('git status'), []);
  const was = process.env.VIBEQUARTERS_CONFIG;
  process.env.VIBEQUARTERS_CONFIG = C.write({ locks: [{ lock: 'a', shell: '(' }, { lock: 'bad name' }, { lock: 'mine', shell: 'make ship', deployGate: true }] });
  try {
    const own = P.lockRows();
    assert.deepStrictEqual(own.map((r) => [r.lock, !!r.shell]), [['a', false], ['mine', true]]);
    assert.ok(own[1].shell.test('make ship') && own[1].deployGate);
  } finally { process.env.VIBEQUARTERS_CONFIG = was; }
});

test('branch patterns, ~ paths and a bad expression', () => {
  assert.ok(P.branchIn('release/1.2', ['main', 'release/*']));
  assert.ok(!P.branchIn('release/', ['release/*']) && !P.branchIn('maintenance', ['main']));
  assert.strictEqual(P.expand('~/x'), path.join(os.homedir(), 'x'));
  assert.strictEqual(P.expand(''), '');
  assert.strictEqual(P.regex('('), null);
});

test('the Windows shell checks do nothing on another system', () => {
  const heredoc = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat > a.txt <<EOF\na' + '\\' + 'b\nEOF' } };
  assert.strictEqual(hook('guard-heredoc-backslash.js', heredoc, { VIBEQUARTERS_TEST_PLATFORM: 'win32' }).permissionDecision, 'deny', 'control');
  assert.strictEqual(hook('guard-heredoc-backslash.js', heredoc, { VIBEQUARTERS_TEST_PLATFORM: 'linux' }).permissionDecision, undefined);
});
