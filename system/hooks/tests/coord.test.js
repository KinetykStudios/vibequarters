// Tests for coord.js.
// Run: node --test system/hooks/tests/coord.test.js
'use strict';
require('./helpers/config');
const { execGit } = require('./helpers/git');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..');
const GUARD = path.join(HOOKS, 'coord-guard.js');
const SESSION = path.join(HOOKS, 'coord-session.js');
const CLI = path.join(HOOKS, 'coord.js');
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';

test('/c/x is drive C on Windows only; elsewhere it is a folder of its own', () => {
  const lib = path.join(HOOKS, 'coord-lib.js');
  const script = `const L = require(${JSON.stringify(lib)}); console.log(JSON.stringify([L.fromShellPath('/c/x'), L.fromShellPath('/c')]))`;
  const ask = (...pre) => JSON.parse(spawnSync(process.execPath, ['-e', pre.join('') + script], { encoding: 'utf8' }).stdout);
  for (const got of [ask("Object.defineProperty(process, 'platform', { value: 'linux' });"), ...(process.platform === 'win32' ? [] : [ask()])]) {
    assert.ok(got[0].endsWith('/c/x') && got[1].endsWith('/c'), got.join(' ')); // a faked platform on Windows still resolves to a drive
  }
  if (process.platform === 'win32') assert.deepStrictEqual(ask(), ['C:/x', 'C:/']);
});

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-')));
  const env = { ...process.env };
  delete env.VIBEQUARTERS_GUARD;
  delete env.VIBEQUARTERS_COORD_FAKE_BEHIND;
  Object.assign(env, {
    VIBEQUARTERS_COORD_DIR: path.join(root, 'state'),
    VIBEQUARTERS_BATCH_DIR: path.join(root, 'batches'), // merge-batch.js records; the real folder never leaks in
    VIBEQUARTERS_COORD_FAKE_SPAWN: path.join(root, 'spawned.txt'), // no test ever opens a real VS Code tab
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  });
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const git = (cwd, ...args) =>
    execGit(args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = path.join(root, 'origin.git');
  const main = path.join(root, 'repo');
  fs.mkdirSync(main);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(main, 'b.txt'), 'b\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'push', '-q', '-u', 'origin', 'main');
  git(main, 'remote', 'set-head', 'origin', 'main');
  const wtA = path.join(root, 'wt-a');
  const wtB = path.join(root, 'wt-b');
  git(main, 'worktree', 'add', '-q', wtA, '-b', 'a');
  git(main, 'worktree', 'add', '-q', wtB, '-b', 'b');
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);

  function run(script, input, extraEnv = {}, raw) {
    const r = spawnSync(process.execPath, [script], {
      input: raw !== undefined ? raw : JSON.stringify(input),
      env: { ...env, ...extraEnv }, encoding: 'utf8',
    });
    let out = null;
    try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch (_e) { out = { unparsed: r.stdout }; }
    const h = (out && out.hookSpecificOutput) || {};
    return {
      status: r.status, stdout: r.stdout, out,
      decision: h.permissionDecision || 'allow',
      reason: h.permissionDecisionReason || '',
      context: h.additionalContext || '',
    };
  }
  const pre = (session, cwd, tool, toolInput, extraEnv) =>
    run(GUARD, { session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput }, extraEnv);
  const edit = (session, cwd, file) => pre(session, cwd, 'Edit', { file_path: file, old_string: 'x', new_string: 'y' });
  const sh = (session, cwd, command, extraEnv) => pre(session, cwd, 'Bash', { command }, extraEnv);
  const register = (session, cwd, name, task = 'test task') =>
    sh(session, cwd, `node "${CLI.replace(/\\/g, '/')}" register --name ${name} --task "${task}"`);
  // PostToolUse: Claude Code sends it only after the tool really ran (approved, not blocked).
  const post = (session, cwd, tool, toolInput) =>
    run(GUARD, { session_id: session, cwd, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: toolInput, tool_response: {} });
  const registered = (session, cwd, name, task = 'test task') =>
    post(session, cwd, 'Bash', { command: `node "${CLI.replace(/\\/g, '/')}" register --name ${name} --task "${task}"` });
  const start = (session, cwd, source = 'startup') =>
    run(SESSION, { session_id: session, cwd, hook_event_name: 'SessionStart', source });
  const end = (session, cwd, reason = 'other') =>
    run(SESSION, { session_id: session, cwd, hook_event_name: 'SessionEnd', reason });
  const registry = () => JSON.parse(fs.readFileSync(path.join(env.VIBEQUARTERS_COORD_DIR, 'registry.json'), 'utf8'));
  const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: root });
  return { root, env, git, main, wtA, wtB, plain, run, pre, edit, sh, register, post, registered, start, end, registry, cli };
}

// alice (A) works in wt-a and has an unmerged edit to a.txt; bob (B) is registered in wt-b.
function aliceOwnsA(t) {
  assert.equal(t.register(A, t.wtA, 'alice').decision, 'allow');
  assert.equal(t.register(B, t.wtB, 'bob').decision, 'allow');
  assert.equal(t.edit(A, t.wtA, path.join(t.wtA, 'a.txt')).decision, 'allow');
  fs.writeFileSync(path.join(t.wtA, 'a.txt'), 'alice change\n');
}

test('unregistered session is told to register before editing inside a git repo', () => {
  const t = setup();
  const r = t.edit(A, t.wtA, path.join(t.wtA, 'a.txt'));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /ListAgents/);
  assert.match(r.reason, /register --name/);
});

test('unregistered session may edit files outside any git repo', () => {
  const t = setup();
  assert.equal(t.edit(A, t.plain, path.join(t.plain, 'notes.md')).decision, 'allow');
});

test('register is applied by the hook with the real session id', () => {
  const t = setup();
  assert.equal(t.register(A, t.wtA, 'alice', 'build the thing').decision, 'allow');
  const s = t.registry().sessions[A];
  assert.equal(s.name, 'alice');
  assert.equal(s.task, 'build the thing');
});

// The hook reads the command's text, so the folder the path names does not have to exist.
test('a coord.js path with a space or an apostrophe is read whole, so registering works under any home folder', () => {
  const t = setup();
  const paths = ['"C:/Users/Jane Doe/.claude/vibequarters/hooks/coord.js"', '"C:/Users/Jane O\'Neil/.claude/vibequarters/hooks/coord.js"',
    "'/home/jane doe/.claude/vibequarters/hooks/coord.js'", '/home/jane/.claude/vibequarters/hooks/coord.js'];
  paths.forEach((p, i) => {
    const id = `${A}-${i}`;
    assert.equal(t.sh(id, t.wtA, `node ${p} register --name jane${i} --task "the task"`).decision, 'allow', p);
    const s = t.registry().sessions[id];
    assert.equal(s && s.name, `jane${i}`, p);
    assert.equal(s.task, 'the task', p);
    // a takeover of a live name lands after it ran, through the PostToolUse path
    const taken = `${B}-${i}`;
    t.post(taken, t.wtB, 'Bash', { command: `node ${p} register --name after${i} --task x` });
    assert.equal((t.registry().sessions[taken] || {}).name, `after${i}`, p);
    // the board is a read, and a call that does more than read is still refused when chained
    assert.equal(t.sh(id, t.wtA, `node ${p} task "next"; node ${p}`).decision, 'allow', p);
    assert.equal(t.sh(id, t.wtA, `echo hi && node ${p} task "x"`).decision, 'deny', p);
    assert.equal(t.sh(id, t.wtA, `node ${p} force-release a.txt`).decision, 'ask', p);
  });
});

test('a live name cannot be taken by a second session', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  const r = t.register(B, t.wtB, 'alice');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /already/);
});

test('editing a file claims it for the editing session', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  t.edit(A, t.wtA, path.join(t.wtA, 'a.txt'));
  const c = t.registry().claims.find((x) => x.path === 'a.txt');
  assert.ok(c, 'claim recorded');
  assert.equal(c.session, A);
});

test('another session editing a claimed file with unmerged changes is blocked with a handoff', () => {
  const t = setup();
  aliceOwnsA(t);
  const r = t.edit(B, t.wtB, path.join(t.wtB, 'a.txt'));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /alice/);
  assert.match(r.reason, /SendMessage/);
  assert.match(r.reason, /release/);
});

test('negative control: another session editing an unclaimed file is allowed', () => {
  const t = setup();
  aliceOwnsA(t);
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'b.txt')).decision, 'allow');
});

test('the owner keeps editing its own claimed file', () => {
  const t = setup();
  aliceOwnsA(t);
  assert.equal(t.edit(A, t.wtA, path.join(t.wtA, 'a.txt')).decision, 'allow');
});

test('a claim releases itself once the file matches origin/main again (merged or reverted)', () => {
  const t = setup();
  aliceOwnsA(t);
  fs.writeFileSync(path.join(t.wtA, 'a.txt'), 'a\n');
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'allow');
});

test('a claim stays active after the owner commits but has not merged', () => {
  const t = setup();
  aliceOwnsA(t);
  t.git(t.wtA, 'commit', '-q', '-am', 'alice work');
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'deny');
});

test('owner release frees the file', () => {
  const t = setup();
  aliceOwnsA(t);
  const rel = t.sh(A, t.wtA, `node "${CLI.replace(/\\/g, '/')}" release "${path.join(t.wtA, 'a.txt').replace(/\\/g, '/')}"`);
  assert.equal(rel.decision, 'allow');
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'allow');
});

test('releasing or ending another session is gated behind the user (ask)', () => {
  const t = setup();
  aliceOwnsA(t);
  assert.equal(t.sh(B, t.wtB, `node "${CLI.replace(/\\/g, '/')}" force-release a.txt`).decision, 'ask');
  assert.equal(t.sh(B, t.wtB, `node "${CLI.replace(/\\/g, '/')}" end-session alice`).decision, 'ask');
});

test('editing inside a worktree another live session is using is blocked', () => {
  const t = setup();
  aliceOwnsA(t);
  const r = t.edit(B, t.wtB, path.join(t.wtA, 'b.txt'));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /worktree add/);
});

test('mutating git in a worktree another live session is using is blocked; read-only git is not', () => {
  const t = setup();
  aliceOwnsA(t);
  const wtA = t.wtA.replace(/\\/g, '/');
  assert.equal(t.sh(B, t.wtB, `git -C "${wtA}" checkout -b other`).decision, 'deny');
  assert.equal(t.sh(B, t.wtB, `cd "${wtA}" && git commit -am x`).decision, 'deny');
  assert.equal(t.sh(B, t.wtB, `git -C "${wtA}" status`).decision, 'allow');
  assert.equal(t.sh(B, t.wtB, 'git checkout -b mine').decision, 'allow');
});

test('push is blocked when the branch changes a file another session owns (shell edits caught)', () => {
  const t = setup();
  aliceOwnsA(t);
  fs.writeFileSync(path.join(t.wtB, 'a.txt'), 'bob via sed\n');
  t.git(t.wtB, 'commit', '-q', '-am', 'bob edit');
  const r = t.sh(B, t.wtB, 'git push -u origin b');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /alice/);
});

test('negative control: push touching only unowned files is allowed and claims them', () => {
  const t = setup();
  aliceOwnsA(t);
  fs.writeFileSync(path.join(t.wtB, 'b.txt'), 'bob\n');
  t.git(t.wtB, 'commit', '-q', '-am', 'bob edit');
  assert.equal(t.sh(B, t.wtB, 'git push -u origin b').decision, 'allow');
  assert.ok(t.registry().claims.find((c) => c.path === 'b.txt' && c.session === B));
});

test('push claims exact paths for uncommitted changes and for files inside untracked folders', () => {
  const t = setup();
  t.register(B, t.wtB, 'bob');
  fs.writeFileSync(path.join(t.wtB, 'b.txt'), 'uncommitted\n');
  fs.mkdirSync(path.join(t.wtB, 'newdir'));
  fs.writeFileSync(path.join(t.wtB, 'newdir', 'n.txt'), 'n\n');
  assert.equal(t.sh(B, t.wtB, 'git push -u origin b').decision, 'allow');
  const mine = t.registry().claims.filter((c) => c.session === B).map((c) => c.path).sort();
  assert.deepEqual(mine, ['b.txt', 'newdir/n.txt']);
});

// ---- carrying another session's committed work ----

// alice (A) commits an edit to a.txt on branch a and keeps an uncommitted edit on top; bob (B) merges branch a.
function bobCarriesAlice(t) {
  assert.equal(t.register(A, t.wtA, 'alice').decision, 'allow');
  assert.equal(t.register(B, t.wtB, 'bob').decision, 'allow');
  assert.equal(t.edit(A, t.wtA, path.join(t.wtA, 'a.txt')).decision, 'allow');
  fs.writeFileSync(path.join(t.wtA, 'a.txt'), 'alice committed\n');
  t.git(t.wtA, 'commit', '-q', '-am', 'alice edit');
  fs.writeFileSync(path.join(t.wtA, 'a.txt'), 'alice committed\nalice still typing\n');
  t.git(t.wtB, 'merge', '-q', '--no-ff', '-m', 'merge a', 'a');
}

test('a push that only carries the owner committed work is allowed', () => {
  const t = setup();
  bobCarriesAlice(t);
  assert.equal(t.sh(B, t.wtB, 'git push -u origin b').decision, 'allow');
});

test('the owner can push again after another session carried its work', () => {
  const t = setup();
  bobCarriesAlice(t);
  assert.equal(t.sh(B, t.wtB, 'git push -u origin b').decision, 'allow');
  t.git(t.wtA, 'commit', '-q', '-am', 'alice second edit');
  assert.equal(t.sh(A, t.wtA, 'git push -u origin a').decision, 'allow');
});

test('negative control: a carrier that also changed the file is blocked while the owner has uncommitted edits', () => {
  const t = setup();
  bobCarriesAlice(t);
  fs.writeFileSync(path.join(t.wtB, 'a.txt'), 'alice committed\nbob on top\n');
  t.git(t.wtB, 'commit', '-q', '-am', 'bob edit on top');
  const r = t.sh(B, t.wtB, 'git push -u origin b');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /alice/);
});

test('negative control: two different committed edits to one file still block, owner clean', () => {
  const t = setup();
  assert.equal(t.register(A, t.wtA, 'alice').decision, 'allow');
  assert.equal(t.register(B, t.wtB, 'bob').decision, 'allow');
  assert.equal(t.edit(A, t.wtA, path.join(t.wtA, 'a.txt')).decision, 'allow');
  fs.writeFileSync(path.join(t.wtA, 'a.txt'), 'alice\n');
  t.git(t.wtA, 'commit', '-q', '-am', 'alice edit');
  fs.writeFileSync(path.join(t.wtB, 'a.txt'), 'bob\n');
  t.git(t.wtB, 'commit', '-q', '-am', 'bob edit');
  const r = t.sh(B, t.wtB, 'git push -u origin b');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /alice/);
});

test('migrations run one session at a time; SessionEnd releases the lock', () => {
  const t = setup();
  aliceOwnsA(t);
  const mig = 'mcp__plugin_supabase_supabase__apply_migration';
  assert.equal(t.pre(A, t.wtA, mig, { name: 'x', query: 'select 1' }).decision, 'allow');
  const r = t.pre(B, t.wtB, mig, { name: 'y', query: 'select 1' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /alice/);
  assert.equal(t.pre(A, t.wtA, mig, { name: 'x2', query: 'select 1' }).decision, 'allow');
  t.end(A, t.wtA);
  assert.equal(t.pre(B, t.wtB, mig, { name: 'y', query: 'select 1' }).decision, 'allow');
});

test('merge is blocked while the PR is behind its base, allowed when current', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  const behind = t.sh(A, t.wtA, 'gh pr merge 5 --squash', { VIBEQUARTERS_COORD_FAKE_BEHIND: '3' });
  assert.equal(behind.decision, 'deny');
  assert.match(behind.reason, /update-branch/);
  assert.equal(t.sh(A, t.wtA, 'gh pr merge 5 --squash', { VIBEQUARTERS_COORD_FAKE_BEHIND: '0' }).decision, 'allow');
  t.register(B, t.wtB, 'bob');
  assert.equal(t.sh(B, t.wtB, 'gh pr merge 6 --squash', { VIBEQUARTERS_COORD_FAKE_BEHIND: '0' }).decision, 'deny');
});

// A batch landing (merge-batch.js): members 5, 6, 7 of one tested batch go to main in that order, each behind base.
function batchSetup() {
  const t = setup();
  fs.mkdirSync(t.env.VIBEQUARTERS_BATCH_DIR, { recursive: true });
  fs.writeFileSync(path.join(t.env.VIBEQUARTERS_BATCH_DIR, '20300101000000.json'), JSON.stringify({
    id: '20300101000000', repo: 'acme/app', base: 'b0', head: 'bh', batchPr: 900, state: 'landing',
    members: [{ pr: 5, head: 'h5', title: 'A' }, { pr: 6, head: 'h6', title: 'B' }, { pr: 7, head: 'h7', title: 'C' }], dropped: [],
  }));
  t.register(A, t.wtA, 'alice');
  // b.md is the body plan-land writes: [batch-part] first for 5 and 6, Batch-Head last for 7, unless body says otherwise
  const merge = (n, head, subjects, body) => {
    fs.writeFileSync(path.join(t.wtA, 'b.md'), body !== undefined ? body : n === 7 ? 'C\n\nBatch-Head: bh\n' : '[batch-part]\n\nX\n');
    return t.sh(A, t.wtA, `gh pr merge ${n} -R acme/app --squash --body-file b.md`, {
      VIBEQUARTERS_COORD_FAKE_BEHIND: '2', VIBEQUARTERS_COORD_FAKE_PR_HEAD: head, VIBEQUARTERS_COORD_FAKE_MAIN_SUBJECTS: JSON.stringify(subjects),
    });
  };
  return { t, merge };
}

test("denies a member's turn whose body is not the one plan-land wrote, and says so", () => {
  const { merge } = batchSetup();
  for (const [n, subjects, body] of [[5, [], 'Plain summary.\n'], [6, ['A (#5)'], '  [batch-part]\n'], [7, ['A (#5)', 'B (#6)'], 'C\n'],
    [7, ['A (#5)', 'B (#6)'], '[batch-part]\n\nBatch-Head: bh\n']]) {
    const r = merge(n, `h${n}`, subjects, body);
    assert.equal(r.decision, 'deny', `#${n} ${JSON.stringify(body)}`);
    assert.match(r.reason, /plan-land/);
  }
});

test('a batch member that is behind may merge once only its predecessors reached main', () => {
  const { merge } = batchSetup();
  assert.equal(merge(5, 'h5', []).decision, 'allow');
  assert.equal(merge(6, 'h6', ['A (#5)']).decision, 'allow');
  assert.equal(merge(7, 'h7', ['A (#5)', 'B (#6)']).decision, 'allow');
});

test('a PR outside the batch must be up to date even in the middle of a batch', () => {
  const { merge } = batchSetup();
  for (const [n, head] of [[9, 'h9'], [6, 'moved-after-the-batch-ran']]) {
    const r = merge(n, head, ['A (#5)']);
    assert.equal(r.decision, 'deny', `#${n} at ${head}`);
    assert.match(r.reason, /behind its base/);
  }
});

test('a batch member out of turn is denied', () => {
  const { merge } = batchSetup();
  assert.equal(merge(7, 'h7', ['A (#5)']).decision, 'deny');
  assert.equal(merge(6, 'h6', []).decision, 'deny');
  assert.equal(merge(7, 'h7', ['A (#5)', 'X (#99)']).decision, 'deny');
  assert.equal(merge(5, 'h5', ['A (#5)']).decision, 'deny');
});

test('a finished gh pr merge frees its merge lock, ran or failed; a peer, background or other command does not', () => {
  const t = setup();
  const ok = { VIBEQUARTERS_COORD_FAKE_BEHIND: '0' };
  const merge = (n) => ({ command: `gh pr merge ${n} --squash` });
  const failed = (session, cwd, toolInput) => t.run(GUARD, { session_id: session, cwd, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: toolInput, error: 'Exit code 1', is_interrupt: false });
  t.register(A, t.wtA, 'alice');
  t.register(B, t.wtB, 'bob');
  assert.equal(t.sh(A, t.wtA, 'gh pr merge 5 --squash', ok).decision, 'allow');
  t.post(B, t.wtB, 'Bash', merge(6));
  t.post(A, t.wtA, 'Bash', { command: 'git status' });
  t.post(A, t.wtA, 'Bash', { ...merge(5), run_in_background: true });
  failed(B, t.wtB, merge(6));
  assert.equal(t.registry().locks.merge.session, A);
  assert.equal(t.sh(B, t.wtB, 'gh pr merge 6 --squash', ok).decision, 'deny');
  t.post(A, t.wtA, 'Bash', merge(5));
  assert.equal(t.registry().locks.merge, undefined);
  assert.equal(t.sh(B, t.wtB, 'gh pr merge 6 --squash', ok).decision, 'allow');
  failed(B, t.wtB, merge(6));
  assert.equal(t.registry().locks.merge, undefined);
  assert.equal(t.sh(A, t.wtA, 'gh pr merge 7 --squash', ok).decision, 'allow');
});

// A PreToolUse hook that blocks a call (guard-deny-catastrophic's review gate) runs in parallel with this guard,
// which has already taken the merge lock; the call never runs, so neither PostToolUse nor PostToolUseFailure
// fires, and PermissionDenied fires only for auto mode (code.claude.com/docs/en/hooks). PostToolBatch still lists the call.
test('a gh pr merge another hook or auto mode denied frees its merge lock once its batch resolves', () => {
  const t = setup();
  const ok = { VIBEQUARTERS_COORD_FAKE_BEHIND: '0' };
  const HOOK_DENY = 'PreToolUse:Bash hook error: denied by guard-deny-catastrophic';
  const BG_STARTED = 'Command running in background with ID: b1a2b3c4d. Output is being written to: x.output';
  const batch = (session, calls) => t.run(GUARD, { session_id: session, cwd: t.wtA, hook_event_name: 'PostToolBatch', tool_calls: calls });
  const call = (command, response, extra = {}) => ({ tool_name: 'Bash', tool_use_id: 'toolu_x', tool_input: { command, ...extra }, tool_response: response });
  t.register(A, t.wtA, 'alice');
  t.register(B, t.wtB, 'bob');

  assert.equal(t.sh(A, t.wtA, 'gh pr merge 5 --squash', ok).decision, 'allow');
  assert.equal(t.registry().locks.merge.session, A, 'the guard took the lock before the other hook denied the call');
  batch(B, [call('gh pr merge 5 --squash', HOOK_DENY)]);
  batch(A, [call('git status', 'ok'), { tool_name: 'Read', tool_use_id: 'toolu_r', tool_response: 'text' }]);
  assert.equal(t.registry().locks.merge.session, A, 'a peer batch or a batch with no merge frees nothing');
  batch(A, [call('gh pr merge 5 --squash', HOOK_DENY)]);
  assert.equal(t.registry().locks.merge, undefined, 'the denied merge holds nothing');
  assert.equal(t.sh(B, t.wtB, 'gh pr merge 6 --squash', ok).decision, 'allow');

  t.run(GUARD, { session_id: B, cwd: t.wtB, hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_use_id: 'toolu_p', tool_input: { command: 'gh pr merge 6 --squash' }, reason: 'auto mode' });
  assert.equal(t.registry().locks.merge, undefined, 'an auto mode deny frees it too');

  assert.equal(t.sh(A, t.wtA, 'gh pr merge 7 --squash', ok).decision, 'allow');
  batch(A, [call('gh pr merge 7 --squash', BG_STARTED, { run_in_background: true })]);
  assert.equal(t.registry().locks.merge.session, A, 'a merge still running in the background keeps the lock');
});

test('deploy from a worktree behind origin/main is blocked; up to date is allowed', () => {
  const t = setup();
  t.register(B, t.wtB, 'bob');
  fs.writeFileSync(path.join(t.main, 'b.txt'), 'newer on main\n');
  t.git(t.main, 'commit', '-q', '-am', 'newer');
  t.git(t.main, 'push', '-q', 'origin', 'main');
  t.git(t.main, 'fetch', '-q', 'origin');
  const stale = t.sh(B, t.wtB, 'supabase functions deploy hello');
  assert.equal(stale.decision, 'deny');
  assert.match(stale.reason, /behind/);
  t.git(t.wtB, 'merge', '-q', '--ff-only', 'origin/main');
  assert.equal(t.sh(B, t.wtB, 'supabase functions deploy hello').decision, 'allow');
});

test('MCP edge deploys take the lock but are not judged by the session cwd being stale', () => {
  const t = setup();
  t.register(B, t.wtB, 'bob');
  fs.writeFileSync(path.join(t.main, 'b.txt'), 'newer on main\n');
  t.git(t.main, 'commit', '-q', '-am', 'newer');
  t.git(t.main, 'push', '-q', 'origin', 'main');
  t.git(t.main, 'fetch', '-q', 'origin');
  const tool = 'mcp__plugin_supabase_supabase__deploy_edge_function';
  assert.equal(t.pre(B, t.wtB, tool, { name: 'hello', files: [] }).decision, 'allow');
  t.register(A, t.wtA, 'alice');
  assert.equal(t.pre(A, t.wtA, tool, { name: 'hello', files: [] }).decision, 'deny');
});

test('a closed owner still blocks its unmerged file and the message sends you to the user', () => {
  const t = setup();
  aliceOwnsA(t);
  t.end(A, t.wtA);
  const r = t.edit(B, t.wtB, path.join(t.wtB, 'a.txt'));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /the user/);
});

test('/clear hands the old record and claims to the new session id', () => {
  const t = setup();
  aliceOwnsA(t);
  t.end(A, t.wtA, 'clear');
  const s = t.start(C, t.wtA, 'clear');
  assert.equal(s.status, 0);
  const reg = t.registry();
  assert.equal(reg.sessions[C].name, 'alice');
  assert.equal(t.edit(C, t.wtA, path.join(t.wtA, 'a.txt')).decision, 'allow');
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'deny');
});

test('SessionStart injects the rules and the live board', () => {
  const t = setup();
  aliceOwnsA(t);
  const s = t.start(C, t.wtB);
  assert.match(s.context, /SESSION COORDINATION/);
  assert.match(s.context, /register --name/);
  assert.match(s.context, /"alice"/);
  assert.match(s.context, /1 claimed file\b/);
});

test('SessionStart for a registered session says so', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  assert.match(t.start(A, t.wtA, 'compact').context, /registered as "alice"/);
});

test('a registry write checks each worktree on disk once, not once per claim', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-gc-')));
  const live = path.join(root, 'wt-live');
  const gone = path.join(root, 'wt-gone');
  const dir = path.join(root, 'state');
  fs.mkdirSync(live);
  fs.mkdirSync(dir);
  const now = Date.now();
  const claims = [];
  for (let i = 0; i < 200; i++) claims.push({ repo: 'r', path: `f${i}.ts`, session: A, worktree: i % 2 ? live : gone, at: now });
  const reg = { sessions: { [A]: { id: A, name: 'alice', lastSeen: now } }, claims, locks: {}, notes: [], requests: [] };
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(reg));
  const libPath = require.resolve(path.join(HOOKS, 'coord-lib.js'));
  const saved = process.env.VIBEQUARTERS_COORD_DIR;
  const realExists = fs.existsSync;
  let stats = 0;
  process.env.VIBEQUARTERS_COORD_DIR = dir; // coord-lib reads its folder when it loads
  delete require.cache[libPath];
  try {
    const L = require(libPath);
    fs.existsSync = (p) => { if (p === live || p === gone) stats++; return realExists(p); };
    L.update(() => {});
  } finally {
    fs.existsSync = realExists;
    delete require.cache[libPath];
    if (saved === undefined) delete process.env.VIBEQUARTERS_COORD_DIR; else process.env.VIBEQUARTERS_COORD_DIR = saved;
  }
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
  assert.strictEqual(after.claims.length, 100, 'claims in a removed worktree still go');
  assert.ok(after.claims.every((c) => c.worktree === live));
  assert.ok(stats <= 2, `${stats} disk checks for 2 worktrees`);
});

test('the session start names peers in this repository and gives a number for the others', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  const repos = [1, 2, 3].map((n) => {
    const top = path.join(t.root, `r${n}`);
    fs.mkdirSync(path.join(top, '.git'), { recursive: true });
    return top;
  });
  const now = Date.now();
  const task = 'a long task line that says in full what this session is building and why it matters to the user '.repeat(2);
  age(t, (reg) => {
    const add = (id, name, top) => {
      reg.sessions[id] = { id, name, task, cwd: top, top, registeredAt: now, lastSeen: now };
      for (let k = 0; k < 8; k++) {
        reg.claims.push({ path: `src/components/some/deep/folder/file-number-${k}.tsx`, session: id, worktree: top, at: now });
      }
    };
    for (let i = 0; i < 10; i++) add(`peer-id-${i}`, `peer-${i}`, t.wtB);
    repos.forEach((top, r) => { for (let i = 0; i < 10; i++) add(`far-id-${r}-${i}`, `far-${r}-${i}`, top); });
  });
  const ctx = t.start(A, t.wtA, 'compact').context;
  assert.match(ctx, /registered as "alice"/);
  for (let i = 0; i < 10; i++) assert.match(ctx, new RegExp(`"peer-${i}"`));
  assert.doesNotMatch(ctx, /far-/);
  assert.match(ctx, /30 other live sessions/);
  assert.ok(ctx.length < 6000, `context is ${ctx.length} characters`);
});

test('the board file is rendered for humans', () => {
  const t = setup();
  aliceOwnsA(t);
  const board = fs.readFileSync(path.join(t.env.VIBEQUARTERS_COORD_DIR, 'BOARD.md'), 'utf8');
  assert.match(board, /alice/);
  assert.match(board, /^- alice in repo: 1 file$/m);
  assert.match(t.cli(), /alice/);
});

test('VIBEQUARTERS_GUARD=off disables the guard', () => {
  const t = setup();
  const r = t.pre(A, t.wtA, 'Edit', { file_path: path.join(t.wtA, 'a.txt') }, { VIBEQUARTERS_GUARD: 'off' });
  assert.equal(r.decision, 'allow');
});

test('fails open on garbage input', () => {
  const t = setup();
  const g = t.run(GUARD, null, {}, 'not json');
  assert.equal(g.status, 0);
  assert.equal(g.stdout, '');
  const s = t.run(SESSION, null, {}, 'not json');
  assert.equal(s.status, 0);
});

// ---- files whose change landed ----

// a.txt becomes ten lines on main; alice (A) commits a change to line 2 on her branch; bob (B) is registered.
function aliceCommitsLine2(t) {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(t.main, 'a.txt'), `${lines.join('\n')}\n`);
  t.git(t.main, 'commit', '-q', '-am', 'ten lines');
  t.git(t.main, 'push', '-q', 'origin', 'main');
  t.git(t.wtA, 'merge', '-q', '--ff-only', 'main');
  t.git(t.wtB, 'merge', '-q', '--ff-only', 'main');
  assert.equal(t.register(A, t.wtA, 'alice').decision, 'allow');
  assert.equal(t.register(B, t.wtB, 'bob').decision, 'allow');
  assert.equal(t.edit(A, t.wtA, path.join(t.wtA, 'a.txt')).decision, 'allow');
  lines[1] = 'alice line 2';
  fs.writeFileSync(path.join(t.wtA, 'a.txt'), `${lines.join('\n')}\n`);
  t.git(t.wtA, 'commit', '-q', '-am', 'alice line 2');
}

// Lands a commit on main that sets the given 0-based lines of a.txt, as a squash merge or another PR would.
function mainSets(t, edits) {
  const file = path.join(t.main, 'a.txt');
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  for (const [i, text] of Object.entries(edits)) lines[Number(i)] = text;
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  t.git(t.main, 'commit', '-q', '-am', 'main moves');
  t.git(t.main, 'push', '-q', 'origin', 'main');
}

test('a closed owner whose edit already shipped stops blocking once main moves on past its worktree', () => {
  const t = setup();
  aliceCommitsLine2(t);
  mainSets(t, { 1: 'alice line 2' }); // her squash merge lands
  mainSets(t, { 7: 'later change on main' }); // then main moves on
  t.end(A, t.wtA);
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'allow');
  const left = t.registry().claims.find((c) => c.session === A && c.path === 'a.txt');
  assert.equal(left, undefined, 'the dead claim is dropped when bob claims the file');
});

test('negative control: main moving on does not free an owner edit that never shipped', () => {
  const t = setup();
  aliceCommitsLine2(t);
  mainSets(t, { 7: 'later change on main' });
  t.end(A, t.wtA);
  const r = t.edit(B, t.wtB, path.join(t.wtB, 'a.txt'));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /alice/);
});

test('negative control: main changing the owner lines differently keeps the claim', () => {
  const t = setup();
  aliceCommitsLine2(t);
  mainSets(t, { 1: 'someone else line 2' });
  t.end(A, t.wtA);
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'deny');
});

// ---- requests ----
const fwd = (p) => p.replace(/\\/g, '/');
const coord = (t, session, cwd, args) => t.sh(session, cwd, `node "${fwd(CLI)}" ${args}`);

// Rewrites the registry in place, to age timestamps the way minutes passing would.
function age(t, fn) {
  const file = path.join(t.env.VIBEQUARTERS_COORD_DIR, 'registry.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(reg);
  fs.writeFileSync(file, JSON.stringify(reg));
}

// alice owns a.txt (aliceOwnsA); bob asks her for a change to it. Returns the recorded request.
function bobRequestsA(t) {
  aliceOwnsA(t);
  const r = coord(t, B, t.wtB, `request "${fwd(path.join(t.wtB, 'a.txt'))}" "make line 1 say hi"`);
  assert.equal(r.decision, 'allow', r.reason);
  const q = t.registry().requests.find((x) => x.from === B);
  assert.ok(q, 'request recorded');
  return q;
}

test('request is recorded with the real session ids and the requester is told to SendMessage the owner', () => {
  const t = setup();
  aliceOwnsA(t);
  const r = coord(t, B, t.wtB, `request "${fwd(path.join(t.wtB, 'a.txt'))}" "make line 1 say hi"`);
  assert.equal(r.decision, 'allow');
  assert.match(r.context, /Request req-[0-9a-f]{6} recorded for "alice"/);
  assert.match(r.context, /SendMessage "alice"/);
  const q = t.registry().requests[0];
  assert.deepEqual([q.from, q.to, q.path, q.state, q.change], [B, A, 'a.txt', 'open', 'make line 1 say hi']);
});

test('request is refused when nobody else holds the file, when it repeats, and without a change', () => {
  const t = setup();
  bobRequestsA(t);
  const free = coord(t, B, t.wtB, `request "${fwd(path.join(t.wtB, 'b.txt'))}" "x"`);
  assert.equal(free.decision, 'deny');
  assert.match(free.reason, /edit it yourself/);
  const dup = coord(t, B, t.wtB, `request "${fwd(path.join(t.wtB, 'a.txt'))}" "again"`);
  assert.equal(dup.decision, 'deny');
  assert.match(dup.reason, /already asked/);
  assert.equal(coord(t, B, t.wtB, 'request').decision, 'deny');
});

test('only the owner can answer done, only the requester can withdraw, and only while open', () => {
  const t = setup();
  const q = bobRequestsA(t);
  assert.equal(coord(t, B, t.wtB, `done ${q.id}`).decision, 'deny');
  assert.equal(coord(t, A, t.wtA, `withdraw ${q.id}`).decision, 'deny');
  assert.equal(coord(t, A, t.wtA, `done ${q.id}`).decision, 'allow');
  assert.equal(t.registry().requests[0].state, 'done');
  assert.equal(coord(t, A, t.wtA, `done ${q.id}`).decision, 'deny');
});

test('withdraw cancels an open request', () => {
  const t = setup();
  const q = bobRequestsA(t);
  assert.equal(coord(t, B, t.wtB, `withdraw ${q.id}`).decision, 'allow');
  assert.equal(t.registry().requests[0].state, 'withdrawn');
});

test('the block message gives the request command with the absolute path', () => {
  const t = setup();
  aliceOwnsA(t);
  const r = t.edit(B, t.wtB, path.join(t.wtB, 'a.txt'));
  assert.equal(r.decision, 'deny');
  assert.ok(r.reason.includes(`request "${fwd(path.join(t.wtB, 'a.txt'))}"`), r.reason);
  assert.match(r.reason, /force-handoff/);
});

test('the board lists requests', () => {
  const t = setup();
  bobRequestsA(t);
  assert.match(t.cli(), /req-[0-9a-f]{6} open: bob -> alice, a\.txt/);
});

test('a corrupt requests entry in the registry does not switch coordination off', () => {
  const t = setup();
  aliceOwnsA(t);
  age(t, (reg) => { reg.requests = [null, 'junk', { id: 'req-junk' }]; });
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'deny');
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'b.txt')).decision, 'allow');
  const reg = t.registry();
  assert.ok(reg.claims.find((c) => c.path === 'b.txt' && c.session === B), 'registry writes still work');
  assert.ok(reg.requests.every((q) => q && typeof q === 'object'), 'junk entries are dropped');
});

// ---- delivery ----
const look = (t, session, wt) => t.pre(session, wt, 'Read', { file_path: path.join(wt, 'b.txt') });

test('the owner sees the request next to its next tool result, with no permission decision', () => {
  const t = setup();
  const q = bobRequestsA(t);
  const r = look(t, A, t.wtA);
  assert.ok(r.out && r.out.hookSpecificOutput, 'hook printed output');
  assert.equal(r.out.hookSpecificOutput.permissionDecision, undefined);
  assert.match(r.context, new RegExp(`COORD REQUEST ${q.id} from "bob"`));
  assert.match(r.context, new RegExp(`done ${q.id}`));
  assert.match(r.context, new RegExp(`handoff ${q.id}`));
  assert.match(r.context, /you seen \d+m ago, \d+ files? open/);
  assert.match(r.context, /make line 1 say hi/);
  t.register(C, t.plain, 'carol');
  assert.equal(look(t, C, t.plain).context, '', 'other sessions get nothing');
});

test('a long request is clipped to 600 characters with its commands intact', () => {
  const t = setup();
  aliceOwnsA(t);
  coord(t, B, t.wtB, `request "${fwd(path.join(t.wtB, 'a.txt'))}" "${'x'.repeat(1500)}"`);
  const r = look(t, A, t.wtA);
  assert.ok(r.context.length <= 600, String(r.context.length));
  assert.match(r.context, /handoff req-/);
});

test('a request is shown to its owner at most 3 times, 5 minutes apart', () => {
  const t = setup();
  const q = bobRequestsA(t);
  const id = new RegExp(q.id);
  assert.match(look(t, A, t.wtA).context, id);
  assert.equal(look(t, A, t.wtA).context, '', 'not twice in a row');
  for (let i = 0; i < 2; i++) {
    age(t, (reg) => { reg.requests[0].lastShown -= 5 * 60e3; });
    assert.match(look(t, A, t.wtA).context, id);
  }
  age(t, (reg) => { reg.requests[0].lastShown -= 5 * 60e3; });
  assert.equal(look(t, A, t.wtA).context, '', 'never a fourth time');
});

test('a request rides inside the deny reason when the same call is blocked', () => {
  const t = setup();
  const q = bobRequestsA(t);
  const r = t.edit(A, t.wtA, path.join(t.wtB, 'b.txt'));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /worktree add/);
  assert.match(r.reason, new RegExp(q.id));
});

test('done tells the requester once, on its next action', () => {
  const t = setup();
  const q = bobRequestsA(t);
  coord(t, A, t.wtA, `done ${q.id}`);
  assert.match(look(t, B, t.wtB).context, /made your change to a\.txt/);
  assert.equal(look(t, B, t.wtB).context, '');
});

// Starts one guard process per call at the same moment, as Claude Code does for parallel tool calls; resolves to their stdouts.
function preAll(t, calls) {
  return Promise.all(calls.map(([session, cwd, tool, toolInput]) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [GUARD], { env: t.env });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', () => resolve(out));
    p.stdin.end(JSON.stringify({ session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput }));
  })));
}

test('parallel tool calls show a due request once, not once per call', async () => {
  const t = setup();
  const q = bobRequestsA(t);
  const read = [A, t.wtA, 'Read', { file_path: path.join(t.wtA, 'b.txt') }];
  const outs = await preAll(t, [read, read, read]);
  assert.equal(outs.filter((o) => o.includes(`COORD REQUEST ${q.id}`)).length, 1, outs.join('\n---\n'));
  assert.equal(t.registry().requests[0].shown, 1);
});

test('workload counts the files this session changed, not work merged to main since its fork', () => {
  const t = setup();
  const q = bobRequestsA(t);
  fs.writeFileSync(path.join(t.main, 'b.txt'), 'b moved on main\n');
  fs.writeFileSync(path.join(t.main, 'c.txt'), 'new on main\n');
  t.git(t.main, 'add', '.');
  t.git(t.main, 'commit', '-q', '-m', 'other work lands on main');
  t.git(t.main, 'push', '-q', 'origin', 'main');
  const r = look(t, A, t.wtA);
  assert.match(r.context, new RegExp(`COORD REQUEST ${q.id}`));
  assert.match(r.context, /you seen \d+m ago, 1 file open;/);
});

test('an ask leaves the request for the next call, since its reason reaches the user and not the model', () => {
  const t = setup();
  const q = bobRequestsA(t);
  const r = coord(t, A, t.wtA, 'force-release b.txt');
  assert.equal(r.decision, 'ask');
  assert.doesNotMatch(r.reason, /COORD REQUEST/);
  assert.match(look(t, A, t.wtA).context, new RegExp(`COORD REQUEST ${q.id}`));
});

test('the call that answers a request does not also show it', () => {
  const t = setup();
  const q = bobRequestsA(t);
  const r = coord(t, A, t.wtA, `done ${q.id}`);
  assert.match(r.context, /marked done/);
  assert.doesNotMatch(r.context, new RegExp(`COORD REQUEST ${q.id}`));
});

test('a notice with no text is marked but never printed', () => {
  const t = setup();
  bobRequestsA(t);
  age(t, (reg) => {
    Object.assign(reg.requests[0], { state: 'withdrawn', told: false });
    reg.requests.push({ ...reg.requests[0], id: 'req-000000' });
  });
  const r = look(t, B, t.wtB);
  assert.equal(r.out, null, r.stdout);
  assert.ok(t.registry().requests.every((x) => x.told === true), 'marked, so it never loops');
});

// ---- handoff and force-handoff ----

test('handoff saves the owner unfinished change, moves the claim, and the requester applies it', () => {
  const t = setup();
  const q = bobRequestsA(t);
  const h = coord(t, A, t.wtA, `handoff ${q.id}`);
  assert.equal(h.decision, 'allow', h.reason);
  assert.match(h.context, /checkout [0-9a-f]{40} -- "a\.txt"/);
  const reg = t.registry();
  const x = reg.requests.find((r) => r.id === q.id);
  assert.equal(x.state, 'handed');
  assert.ok(fs.existsSync(x.patch), 'patch file written');
  const claim = reg.claims.find((c) => c.path === 'a.txt');
  assert.equal(claim.session, B);
  assert.equal(claim.worktree, fwd(t.wtB));
  assert.ok(claim.heldUntil > Date.now());
  const told = look(t, B, t.wtB).context;
  assert.ok(told.includes(`git -C "${fwd(t.wtB)}" apply --3way "${x.patch}"`), told);
  t.git(t.wtB, 'apply', '--3way', x.patch);
  assert.equal(fs.readFileSync(path.join(t.wtB, 'a.txt'), 'utf8'), 'alice change\n');
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'allow');
  assert.equal(t.edit(A, t.wtA, path.join(t.wtA, 'a.txt')).decision, 'deny');
});

test('handoff re-addresses other open requests for the file to the new owner', () => {
  const t = setup();
  const q = bobRequestsA(t);
  const wtC = path.join(t.root, 'wt-c');
  t.git(t.main, 'worktree', 'add', '-q', wtC, '-b', 'c');
  t.register(C, wtC, 'carol');
  assert.equal(coord(t, C, wtC, `request "${fwd(path.join(wtC, 'a.txt'))}" "carol needs line 1 too"`).decision, 'allow');
  coord(t, A, t.wtA, `handoff ${q.id}`);
  const carol = t.registry().requests.find((r) => r.from === C);
  assert.deepEqual([carol.to, carol.state], [B, 'open']);
});

// alice commits her change to a.txt and it lands on main as is (a squash merge), while bob's request is still open.
function aliceShips(t) {
  t.git(t.wtA, 'commit', '-q', '-am', 'alice change');
  fs.writeFileSync(path.join(t.main, 'a.txt'), 'alice change\n');
  t.git(t.main, 'commit', '-q', '-am', 'squash: alice change');
  t.git(t.main, 'push', '-q', 'origin', 'main');
}

test('a handed-over file that matches the shipped branch comes with no patch and no drop step', () => {
  const t = setup();
  const q = bobRequestsA(t);
  aliceShips(t);
  const h = coord(t, A, t.wtA, `handoff ${q.id}`);
  assert.equal(h.decision, 'allow', h.reason);
  assert.match(h.context, /already on origin\/main, so there is nothing to drop/);
  assert.doesNotMatch(h.context, /checkout [0-9a-f]{40}/, 'no command that would undo the shipped change');
  const x = t.registry().requests.find((r) => r.id === q.id);
  assert.deepEqual([x.state, x.patch, x.shipped], ['handed', null, 'origin/main']);
  assert.equal(fs.readFileSync(path.join(t.wtA, 'a.txt'), 'utf8'), 'alice change\n', 'the owner copy is untouched');
  const told = look(t, B, t.wtB).context;
  assert.match(told, /already on origin\/main: update your branch from origin\/main first/);
  assert.doesNotMatch(told, /apply --3way/, 'no patch to re-apply');
});

test('a forced handoff of a shipped change gives the owner no drop command', () => {
  const t = setup();
  const q = bobRequestsA(t);
  aliceShips(t);
  age(t, (reg) => { reg.requests[0].at -= 16 * 60e3; });
  assert.match(t.cli('force-handoff', q.id), /Handed a\.txt to "bob"/);
  assert.equal(look(t, A, t.wtA).context, '', 'nothing for the owner to drop');
  assert.match(look(t, B, t.wtB).context, /update your branch from origin\/main first/);
});

test('handoff of a file the owner never tracked is refused with a commit-first hint', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  t.register(B, t.wtB, 'bob');
  const nf = path.join(t.wtA, 'new.txt');
  assert.equal(t.edit(A, t.wtA, nf).decision, 'allow');
  fs.writeFileSync(nf, 'new\n');
  assert.equal(coord(t, B, t.wtB, `request "${fwd(path.join(t.wtB, 'new.txt'))}" "add a line"`).decision, 'allow');
  const q = t.registry().requests[0];
  const h = coord(t, A, t.wtA, `handoff ${q.id}`);
  assert.equal(h.decision, 'deny');
  assert.match(h.reason, /not tracked yet/);
  const reg = t.registry();
  assert.equal(reg.requests[0].state, 'open');
  assert.equal(reg.claims.find((c) => c.path === 'new.txt').session, A);
});

test('a handoff the requester never applies stops blocking the old owner after 30 minutes', () => {
  const t = setup();
  const q = bobRequestsA(t);
  coord(t, A, t.wtA, `handoff ${q.id}`);
  assert.equal(t.edit(A, t.wtA, path.join(t.wtA, 'a.txt')).decision, 'deny');
  age(t, (reg) => { for (const c of reg.claims) if (c.heldUntil) c.heldUntil = Date.now() - 1; });
  assert.equal(t.edit(A, t.wtA, path.join(t.wtA, 'a.txt')).decision, 'allow');
});

test('force-handoff waits 15 minutes for a live owner, then asks the user', () => {
  const t = setup();
  const q = bobRequestsA(t);
  const early = coord(t, B, t.wtB, `force-handoff ${q.id}`);
  assert.equal(early.decision, 'deny');
  assert.match(early.reason, /15 minutes/);
  assert.equal(coord(t, A, t.wtA, `force-handoff ${q.id}`).decision, 'deny', 'only the requester');
  age(t, (reg) => { reg.requests[0].at -= 16 * 60e3; });
  const late = coord(t, B, t.wtB, `force-handoff ${q.id}`);
  assert.equal(late.decision, 'ask');
  assert.match(late.reason, /the user/);
});

test('force-handoff asks the user at once when the owner has closed', () => {
  const t = setup();
  const q = bobRequestsA(t);
  t.end(A, t.wtA);
  assert.equal(coord(t, B, t.wtB, `force-handoff ${q.id}`).decision, 'ask');
});

test('the CLI applies an approved force-handoff and the old owner is told on its next action', () => {
  const t = setup();
  const q = bobRequestsA(t);
  age(t, (reg) => { reg.requests[0].at -= 16 * 60e3; });
  assert.match(t.cli('force-handoff', q.id), /Handed a\.txt to "bob"/);
  const x = t.registry().requests[0];
  assert.deepEqual([x.state, x.forced], ['handed', true]);
  const told = look(t, A, t.wtA).context;
  assert.match(told, /the user approved handing a\.txt to "bob"/);
  assert.match(told, /checkout [0-9a-f]{40} -- "a\.txt"/);
  assert.equal(look(t, A, t.wtA).context, '');
});

// Runs a git command exactly as a message printed it (quoted arguments kept whole), from cwd; throws unless git exits 0.
function runPrinted(t, cwd, cmd) {
  const args = cmd.match(/"[^"]*"|\S+/g).map((s) => s.replace(/^"|"$/g, ''));
  assert.equal(args[0], 'git', cmd);
  return t.git(cwd, ...args.slice(1));
}

// alice adds new.txt on her branch and commits it; bob asks her for a change to it. Returns the recorded request.
function aliceCommitsNewFile(t) {
  t.register(A, t.wtA, 'alice');
  t.register(B, t.wtB, 'bob');
  assert.equal(t.edit(A, t.wtA, path.join(t.wtA, 'new.txt')).decision, 'allow');
  fs.writeFileSync(path.join(t.wtA, 'new.txt'), 'new\n');
  t.git(t.wtA, 'add', 'new.txt');
  t.git(t.wtA, 'commit', '-q', '-m', 'alice adds new.txt');
  assert.equal(coord(t, B, t.wtB, `request "${fwd(path.join(t.wtB, 'new.txt'))}" "add a line"`).decision, 'allow');
  return t.registry().requests[0];
}

test('handoff saves a change that is not UTF-8 byte for byte, and the requester applies it', () => {
  const t = setup();
  const q = bobRequestsA(t);
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "caf", a Latin-1 e with acute accent, newline
  fs.writeFileSync(path.join(t.wtA, 'a.txt'), latin1);
  const h = coord(t, A, t.wtA, `handoff ${q.id}`);
  assert.equal(h.decision, 'allow', h.reason);
  t.git(t.wtB, 'apply', '--3way', t.registry().requests[0].patch);
  assert.deepEqual(fs.readFileSync(path.join(t.wtB, 'a.txt')), latin1);
});

test('handoff saves a large binary change whole', () => {
  const t = setup();
  const q = bobRequestsA(t);
  const big = require('crypto').randomBytes(1024 * 1024);
  fs.writeFileSync(path.join(t.wtA, 'a.txt'), big);
  const h = coord(t, A, t.wtA, `handoff ${q.id}`);
  assert.equal(h.decision, 'allow', h.reason);
  t.git(t.wtB, 'apply', '--3way', t.registry().requests[0].patch);
  assert.ok(fs.readFileSync(path.join(t.wtB, 'a.txt')).equals(big), 'applied bytes match');
});

test('the drop command printed for a file the owner added on its branch removes it', () => {
  const t = setup();
  const q = aliceCommitsNewFile(t);
  const h = coord(t, A, t.wtA, `handoff ${q.id}`);
  assert.equal(h.decision, 'allow', h.reason);
  const drop = /drop it from your branch: (git .+?), and commit/.exec(h.context);
  assert.ok(drop, h.context);
  runPrinted(t, t.root, drop[1]);
  assert.equal(fs.existsSync(path.join(t.wtA, 'new.txt')), false);
});

test('a forced handoff of a file the owner added tells the owner the same working drop command', () => {
  const t = setup();
  const q = aliceCommitsNewFile(t);
  age(t, (reg) => { reg.requests[0].at -= 16 * 60e3; });
  t.cli('force-handoff', q.id);
  const told = look(t, A, t.wtA).context;
  const drop = /Drop it from your branch: (git .+?), then commit/.exec(told);
  assert.ok(drop, told);
  runPrinted(t, t.root, drop[1]);
  assert.equal(fs.existsSync(path.join(t.wtA, 'new.txt')), false);
});

test('the drop command for an added file the owner edited again after committing still works', () => {
  const t = setup();
  const q = aliceCommitsNewFile(t);
  fs.writeFileSync(path.join(t.wtA, 'new.txt'), 'new\nedited after the commit\n');
  const h = coord(t, A, t.wtA, `handoff ${q.id}`);
  assert.equal(h.decision, 'allow', h.reason);
  const drop = /drop it from your branch: (git .+?), and commit/.exec(h.context);
  assert.ok(drop, h.context);
  runPrinted(t, t.root, drop[1]);
  assert.equal(fs.existsSync(path.join(t.wtA, 'new.txt')), false);
  t.git(t.wtB, 'apply', '--3way', t.registry().requests[0].patch);
  assert.equal(fs.readFileSync(path.join(t.wtB, 'new.txt'), 'utf8'), 'new\nedited after the commit\n');
});

test('handoff is refused, nothing moved, when git cannot say whether the file existed at the fork', () => {
  const t = setup();
  bobRequestsA(t);
  // in a child process with the test env (throwaway registry): git cat-file times out, as L.git reports it (code -1)
  const script = [
    `const L = require(${JSON.stringify(path.join(HOOKS, 'coord-lib.js'))});`,
    `const R = require(${JSON.stringify(path.join(HOOKS, 'coord-requests.js'))});`,
    'const git = L.git;',
    "L.git = (cwd, args) => (args[0] === 'cat-file' ? { code: -1, out: '' } : git(cwd, args));",
    'const reg = L.load();',
    'process.stdout.write(JSON.stringify(R.handOver(reg, reg.requests[0], Date.now(), false)));',
  ].join('\n');
  const v = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: t.env, encoding: 'utf8' }));
  assert.equal(v.decision, 'deny', v.text);
  assert.match(v.text, /could not read the change to a\.txt.*try again/);
  const reg = t.registry();
  assert.equal(reg.requests[0].state, 'open');
  assert.equal(reg.claims.find((c) => c.path === 'a.txt').session, A);
});

test('the apply command printed to the requester works from a subfolder of its worktree', () => {
  const t = setup();
  const q = bobRequestsA(t);
  coord(t, A, t.wtA, `handoff ${q.id}`);
  const told = look(t, B, t.wtB).context;
  const apply = /(git (?:-C "[^"]+" )?apply --3way "[^"]+")/.exec(told);
  assert.ok(apply, told);
  const sub = path.join(t.wtB, 'sub');
  fs.mkdirSync(sub);
  runPrinted(t, sub, apply[1]);
  assert.equal(fs.readFileSync(path.join(t.wtB, 'a.txt'), 'utf8'), 'alice change\n');
});

test('force-handoff asks the user at once when the owner has gone quiet, and says so', () => {
  const t = setup();
  const q = bobRequestsA(t);
  age(t, (reg) => { reg.sessions[A].lastSeen -= 73 * 3600e3; });
  const r = coord(t, B, t.wtB, `force-handoff ${q.id}`);
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /has closed or gone quiet/);
});

test('handoff is refused, nothing moved, when the owner branch has no fork point with the shipped branch', () => {
  const t = setup();
  const q = bobRequestsA(t);
  t.git(t.wtA, 'checkout', '-q', '--orphan', 'lonely');
  t.git(t.wtA, 'commit', '-q', '-m', 'no history shared with main');
  const h = coord(t, A, t.wtA, `handoff ${q.id}`);
  assert.equal(h.decision, 'deny');
  assert.match(h.reason, /merge-base/);
  const reg = t.registry();
  assert.equal(reg.requests[0].state, 'open');
  assert.equal(reg.claims.find((c) => c.path === 'a.txt').session, A);
});

// ---- lifecycle ----
const D = 'dddddddd-0000-0000-0000-000000000004';

test('a request resolves itself once the owner file matches main again, checked at most every 5 minutes', () => {
  const t = setup();
  bobRequestsA(t);
  fs.writeFileSync(path.join(t.wtA, 'a.txt'), 'a\n');
  assert.equal(look(t, B, t.wtB).context, '');
  assert.equal(t.registry().requests[0].state, 'open', 'not checked before 5 minutes');
  age(t, (reg) => { reg.requests[0].at -= 5 * 60e3; });
  assert.match(look(t, B, t.wtB).context, /a\.txt is free now/);
  assert.equal(t.registry().requests[0].state, 'resolved');
});

test('negative control: an owner still holding unshipped changes keeps the request open', () => {
  const t = setup();
  bobRequestsA(t);
  age(t, (reg) => { reg.requests[0].at -= 5 * 60e3; });
  look(t, B, t.wtB);
  const x = t.registry().requests[0];
  assert.equal(x.state, 'open');
  assert.ok(x.checkedAt > 0, 'it was checked');
  look(t, B, t.wtB);
  assert.equal(t.registry().requests[0].checkedAt, x.checkedAt, 'not checked again within 5 minutes of the last check');
});

test('an open request from a closed requester is withdrawn once the /clear window has passed', () => {
  const t = setup();
  bobRequestsA(t);
  t.end(B, t.wtB);
  assert.equal(t.registry().requests[0].state, 'open', 'kept inside the 60 s /clear window');
  age(t, (reg) => { reg.sessions[B].endedAt -= 61e3; });
  coord(t, A, t.wtA, 'note "tick"');
  assert.equal(t.registry().requests[0].state, 'withdrawn');
  assert.equal(look(t, A, t.wtA).context, '');
});

test('requests follow a /clear handover on both sides', () => {
  const t = setup();
  const q = bobRequestsA(t);
  t.end(A, t.wtA, 'clear');
  t.start(C, t.wtA, 'clear');
  t.end(B, t.wtB, 'clear');
  t.start(D, t.wtB, 'clear');
  const x = t.registry().requests[0];
  assert.deepEqual([x.to, x.from, x.state], [C, D, 'open']);
  assert.match(look(t, C, t.wtA).context, new RegExp(q.id));
});

test('requests follow a session that re-registers its name, once the user approves the takeover', () => {
  const t = setup();
  bobRequestsA(t);
  t.end(A, t.wtA);
  assert.equal(t.register(C, t.wtA, 'alice').decision, 'ask');
  assert.equal(t.registry().requests[0].to, A, 'nothing moves before the command runs');
  t.registered(C, t.wtA, 'alice');
  assert.equal(t.registry().requests[0].to, C);
});

test('taking over a closed session by its name asks the user, and nothing moves unless the command runs', () => {
  const t = setup();
  aliceOwnsA(t);
  t.end(A, t.wtA);
  const r = t.register(C, t.wtA, 'alice');
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /takes over the closed session "alice"/);
  assert.match(r.reason, /1 file claim/);
  let reg = t.registry();
  assert.equal(reg.claims.find((c) => c.path === 'a.txt').session, A, 'a denied or blocked register leaves the claim with its owner');
  assert.equal(reg.sessions[C], undefined, 'and does not register the caller');
  t.registered(C, t.wtA, 'alice');
  reg = t.registry();
  assert.equal(reg.claims.find((c) => c.path === 'a.txt').session, C);
  assert.equal(reg.sessions[A], undefined);
  assert.equal(reg.sessions[C].name, 'alice');
  assert.equal(t.edit(C, t.wtA, path.join(t.wtA, 'a.txt')).decision, 'allow', 'the successor edits its own file');
  t.registered(C, t.wtA, 'carol');
  reg = t.registry();
  assert.equal(reg.sessions[C].name, 'carol', 'a plain re-register renames without asking');
  assert.equal(reg.claims.find((c) => c.path === 'a.txt').session, C, 'and keeps the claims');
});

test('a register under a live session name is never applied after the run either', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  t.registered(B, t.wtB, 'alice');
  const reg = t.registry();
  assert.equal(reg.sessions[A].name, 'alice');
  assert.equal(reg.sessions[B], undefined);
});

test('PostToolUse ignores every command except a whole coord register', () => {
  const t = setup();
  aliceOwnsA(t);
  const before = fs.readFileSync(path.join(t.env.VIBEQUARTERS_COORD_DIR, 'registry.json'), 'utf8');
  for (const command of ['git status', `echo node "${fwd(CLI)}" register --name x`, `node "${fwd(CLI)}" note "hi"`]) {
    const r = t.post(B, t.wtB, 'Bash', { command });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
  assert.equal(fs.readFileSync(path.join(t.env.VIBEQUARTERS_COORD_DIR, 'registry.json'), 'utf8'), before);
});

test('a takeover reopens the requests withdrawn when the requester closed, for its successor', () => {
  const t = setup();
  const q = bobRequestsA(t);
  t.end(B, t.wtB);
  age(t, (reg) => { reg.sessions[B].endedAt -= 61e3; });
  coord(t, A, t.wtA, 'note "tick"');
  assert.equal(t.registry().requests[0].state, 'withdrawn');
  assert.equal(t.register(C, t.wtB, 'bob').decision, 'ask', 'the lost request still counts as something to take over');
  t.registered(C, t.wtB, 'bob');
  const x = t.registry().requests[0];
  assert.deepEqual([x.id, x.from, x.state], [q.id, C, 'open']);
  assert.match(look(t, A, t.wtA).context, new RegExp(q.id), 'the owner is shown it again');
});

test('requests older than 7 days are forgotten with their patch files', () => {
  const t = setup();
  const q = bobRequestsA(t);
  coord(t, A, t.wtA, `handoff ${q.id}`);
  const patch = t.registry().requests[0].patch;
  assert.ok(fs.existsSync(patch));
  age(t, (reg) => { reg.requests[0].at -= 8 * 24 * 3600e3; });
  coord(t, A, t.wtA, 'note "tick"');
  assert.equal(t.registry().requests.length, 0);
  assert.equal(fs.existsSync(patch), false);
});

test('a requester /clear keeps the same open request: never withdrawn inside the 60 s window, live for the new id after', () => {
  const t = setup();
  const q = bobRequestsA(t);
  t.end(B, t.wtB, 'clear');
  age(t, (reg) => { reg.sessions[B].endedAt -= 50e3; }); // 50 of the 60 seconds gone, the new session not started yet
  coord(t, A, t.wtA, 'note "tick"'); // another session writes the registry, so GC runs mid-handover
  const mid = t.registry().requests.map((x) => [x.id, x.from, x.state, x.answeredAt]);
  assert.deepEqual(mid, [[q.id, B, 'open', undefined]], 'not withdrawn while the /clear successor may still arrive');
  t.start(D, t.wtB, 'clear');
  coord(t, A, t.wtA, 'note "tick"');
  const after = t.registry().requests.map((x) => [x.id, x.from, x.state, x.answeredAt, x.told]);
  assert.deepEqual(after, [[q.id, D, 'open', undefined, undefined]], 'the same record, moved, never answered');
  assert.equal(coord(t, A, t.wtA, `done ${q.id}`).decision, 'allow');
  assert.match(look(t, D, t.wtB).context, new RegExp(`COORD ${q.id}: "alice" made your change to a\\.txt`));
});

test('GC deletes only patch files inside the handoffs folder: a record naming any other file is dropped, the file kept', () => {
  const t = setup();
  const q = bobRequestsA(t);
  coord(t, A, t.wtA, `handoff ${q.id}`);
  const real = t.registry().requests[0].patch;
  const handoffs = fwd(path.join(t.env.VIBEQUARTERS_COORD_DIR, 'handoffs'));
  // both outside files live inside this test's throwaway dirs; the first is named through the handoffs folder with ..
  const outsideOld = path.join(t.env.VIBEQUARTERS_COORD_DIR, 'outside-old.txt');
  const outsideNoAt = path.join(t.root, 'outside-noat.txt');
  fs.writeFileSync(outsideOld, 'keep\n');
  fs.writeFileSync(outsideNoAt, 'keep\n');
  age(t, (reg) => {
    reg.requests[0].at -= 8 * 24 * 3600e3;
    reg.requests.push({ id: 'req-01d000', state: 'handed', from: B, to: A, at: Date.now() - 8 * 24 * 3600e3, patch: `${handoffs}/../outside-old.txt` });
    reg.requests.push({ id: 'req-0a0000', patch: fwd(outsideNoAt) });
  });
  coord(t, A, t.wtA, 'note "tick"');
  assert.deepEqual(t.registry().requests, [], 'all three records dropped');
  assert.deepEqual([fs.existsSync(outsideOld), fs.existsSync(outsideNoAt)], [true, true],
    'files outside handoffs are kept: one named through it with .., one named by a record with no at');
  assert.equal(fs.existsSync(real), false, 'positive control: the handoffs patch of the expired request is removed');
});

test('a handed request younger than 7 days keeps its record and its patch file', () => {
  const t = setup();
  const q = bobRequestsA(t);
  coord(t, A, t.wtA, `handoff ${q.id}`);
  const patch = t.registry().requests[0].patch;
  age(t, (reg) => { reg.requests[0].at -= 6 * 24 * 3600e3; });
  coord(t, A, t.wtA, 'note "tick"');
  assert.deepEqual(t.registry().requests.map((x) => [x.id, x.state]), [[q.id, 'handed']]);
  assert.ok(fs.existsSync(patch), 'its patch file is kept');
});

// ---- shell-write guard ----
const S = require(path.join(HOOKS, 'coord-shell.js'));

test('register and the heartbeat record each session worktree root', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  assert.equal(t.registry().sessions[A].top, fwd(t.wtA));
  age(t, (reg) => { delete reg.sessions[A].top; }); // a record with no worktree root
  t.sh(A, t.wtA, 'git status');
  assert.equal(t.registry().sessions[A].top, fwd(t.wtA), 'the heartbeat fills it in on the next call');
});

test('shell writes into another live session worktree are blocked', () => {
  const t = setup();
  aliceOwnsA(t);
  const a = fwd(t.wtA);
  const writes = [
    `echo hi > "${a}/new.txt"`,
    `echo hi >> "${a}/b.txt"`,
    `cp b.txt "${a}/b.txt"`,
    `sed -i s/a/b/ "${a}/a.txt"`,
    `echo x | tee "${a}/log.txt"`,
    `cd "${a}" && npm install`,
    `rm "${a}/b.txt"`,
    `find "${a}" -name b.txt -delete`,
  ];
  if (process.platform === 'win32') writes.push(`touch ${a.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`)}/n.txt`);
  for (const cmd of writes) assert.equal(t.sh(B, t.wtB, cmd).decision, 'deny', cmd);
  const ps = t.pre(B, t.wtB, 'PowerShell', { command: `Set-Content -Path "${a}/x.txt" -Value 1` });
  assert.equal(ps.decision, 'deny');
  assert.match(ps.reason, /alice/);
});

test('negative control: reading a peer worktree, writing your own, and a closed peer are allowed', () => {
  const t = setup();
  aliceOwnsA(t);
  const a = fwd(t.wtA);
  const b = fwd(t.wtB);
  const ok = [
    `cat "${a}/a.txt"`,
    `git -C "${a}" diff`,
    `cp "${a}/a.txt" ./copy.txt`,
    `ls "${a}" 2>&1`,
    `echo hi > "${b}/mine.txt"`,
    `grep -r alice "${a}" > out.txt`,
    `find "${a}" -name b.txt`,
    `pushd "${a}" && git status && popd && echo hi > mine.txt`,
  ];
  for (const cmd of ok) assert.equal(t.sh(B, t.wtB, cmd).decision, 'allow', cmd);
  t.end(A, t.wtA);
  assert.equal(t.sh(B, t.wtB, `echo hi > "${a}/new.txt"`).decision, 'allow', 'only live peers are guarded');
});

test('a worktree nested inside a live peer checkout is its own folder, not the peer', () => {
  const t = setup();
  t.register(C, t.main, 'carol');
  const nested = path.join(t.main, '.claude', 'worktrees', 'n');
  t.git(t.main, 'worktree', 'add', '-q', nested, '-b', 'n');
  t.register(B, nested, 'bob');
  assert.equal(t.sh(B, nested, `echo hi > "${fwd(nested)}/x.txt"`).decision, 'allow');
  assert.equal(t.sh(B, nested, `echo hi > "${fwd(t.main)}/x.txt"`).decision, 'deny');
  assert.equal(t.sh(B, nested, 'echo hi > ../../../x.txt').decision, 'deny', 'a relative path that never names the peer');
});

test('a command that names no peer folder is never parsed', () => {
  const t = setup();
  const top = fwd(t.wtA);
  const peers = [{ name: 'alice', top, k: top.toLowerCase(), spell: S.spellings(top) }];
  assert.equal(S.mentionsPeer('git status --short', peers), false);
  assert.equal(S.mentionsPeer(`cat "${top}/a.txt"`, peers), true);
  assert.equal(S.mentionsPeer(`cat "${top.replace(/\//g, '\\')}\\a.txt"`, peers), true);
  assert.equal(S.mentionsPeer('cat wt-a/a.txt', peers), true);
  assert.equal(S.mentionsPeer('echo hi > ../../x.txt', peers), true);
});

test('an error in the shell-write check still leaves the mutating-git check in place', () => {
  const t = setup();
  aliceOwnsA(t);
  age(t, (reg) => { reg.sessions[A].top = { toString: 1 }; }); // String() of this throws inside the guard
  const r = t.sh(B, t.wtB, `git -C "${fwd(t.wtA)}" checkout -b other`);
  assert.equal(r.decision, 'deny', 'the git check still judges the command');
  assert.match(r.reason, /in use by session "alice"/);
});

// Runs [tool, command, decision] rows as session from cwd; on failure lists every row that was decided the other way.
function rows(t, session, cwd, list) {
  const wrong = list.filter(([tool, command, want]) => t.pre(session, cwd, tool, { command }).decision !== want);
  assert.deepEqual(wrong, [], 'rows decided the other way');
}

test('a cd inside a subshell, a group or an if, and a write after an env assignment, are still seen', () => {
  const t = setup();
  aliceOwnsA(t);
  const a = fwd(t.wtA);
  const b = fwd(t.wtB);
  rows(t, B, t.wtB, [
    ['Bash', `(cd "${a}" && rm b.txt)`, 'deny'],
    ['Bash', `(cd "${a}" && npm install)`, 'deny'],
    ['Bash', `{ cd "${a}"; rm b.txt; }`, 'deny'],
    ['Bash', `if true; then cd "${a}"; rm b.txt; fi`, 'deny'],
    ['Bash', `if rm "${a}/b.txt"; then echo gone; fi`, 'deny'],
    ['Bash', `FOO=1 cp x "${a}/y"`, 'deny'],
    ['PowerShell', `Push-Location "${a}"; Remove-Item x.txt`, 'deny'],
    ['Bash', `(cd "${b}" && rm x)`, 'allow'],
  ]);
});

test('read pipelines after a cd into a peer are allowed; sed in place there is not', () => {
  const t = setup();
  aliceOwnsA(t);
  const a = fwd(t.wtA);
  rows(t, B, t.wtB, [
    ['Bash', `cd "${a}" && grep -rn foo . | sort | uniq -c`, 'allow'],
    ['Bash', `cd "${a}" && sed -n 1,20p a.txt`, 'allow'],
    ['PowerShell', `Set-Location "${a}"; Get-ChildItem | Select-Object Name`, 'allow'],
    ['PowerShell', `Set-Location "${a}"; Get-ChildItem | Where-Object { $_.Length -gt 0 } | Sort-Object Name`, 'allow'],
    ['Bash', `cd "${a}" && sed -i s/a/b/ a.txt`, 'deny'],
  ]);
});

test('removing or moving a folder that holds a live peer worktree is blocked', () => {
  const t = setup();
  t.register(C, t.main, 'carol');
  const nested = path.join(t.main, '.claude', 'worktrees', 'n');
  t.git(t.main, 'worktree', 'add', '-q', nested, '-b', 'n');
  t.register(B, nested, 'bob');
  rows(t, C, t.main, [
    ['Bash', 'rm -rf .claude/worktrees', 'deny'],
    ['Bash', 'rm -rf .claude/worktrees/*', 'deny'],
    ['Bash', 'mv .claude/worktrees /tmp/old', 'deny'],
    ['PowerShell', 'Remove-Item -Recurse -Force .claude\\worktrees', 'deny'],
    ['Bash', 'rm -rf node_modules', 'allow'],
    ['Bash', 'rm -f *.log', 'allow'],
  ]);
});

test('SessionStart records the worktree root of the folder it starts in', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  t.start(A, t.wtB, 'resume');
  assert.equal(t.registry().sessions[A].top, fwd(t.wtB));
  t.start(A, t.plain, 'resume');
  assert.equal(t.registry().sessions[A].top, null, 'outside any repo');
});

test('Tee-Object, md, >| and sed --in-place= write too', () => {
  const t = setup();
  aliceOwnsA(t);
  const a = fwd(t.wtA);
  rows(t, B, t.wtB, [
    ['PowerShell', `Get-Content b.txt | Tee-Object -FilePath "${a}/t.txt"`, 'deny'],
    ['PowerShell', `md "${a}/newdir"`, 'deny'],
    ['Bash', `echo hi >| "${a}/x.txt"`, 'deny'],
    ['Bash', `sed --in-place=.bak s/a/b/ "${a}/a.txt"`, 'deny'],
  ]);
});

test('more write shapes: into a peer denied, into your own worktree allowed', () => {
  const t = setup();
  aliceOwnsA(t);
  const a = fwd(t.wtA);
  const b = fwd(t.wtB);
  rows(t, B, t.wtB, [
    ['Bash', `npm test 2> "${a}/log.txt"`, 'deny'],
    ['PowerShell', `echo x | Out-File "${a}/x.txt"`, 'deny'],
    ['Bash', `mv x "${a}/y"`, 'deny'],
    ['PowerShell', `Set-Location "${a}"; New-Item z`, 'deny'],
    ['Bash', `cp x "${b}/y"`, 'allow'],
    ['Bash', `cp "${a}/a.txt" ../wt-b/y`, 'allow'],
    ['PowerShell', `Set-Content -Path "${b}/x.txt" -Value 1`, 'allow'],
    ['PowerShell', 'Set-Content -Path ../wt-b/x.txt -Value 1', 'allow'],
  ]);
});

test('sed with i clustered in its short flags is an in-place edit', () => {
  const t = setup();
  aliceOwnsA(t);
  const a = fwd(t.wtA);
  rows(t, B, t.wtB, [
    ['Bash', `cd "${a}" && sed -Ei s/a/b/ a.txt`, 'deny'],
    ['Bash', `sed -Ei s/a/b/ "${a}/a.txt"`, 'deny'],
    ['Bash', `cd "${a}" && sed -n 1,5p a.txt`, 'allow'],
    ['Bash', `cd "${a}" && sed --regexp-extended -n 1p a.txt`, 'allow'],
  ]);
});

test('mutating git after a cd into a peer is blocked, read-only git is not', () => {
  const t = setup();
  aliceOwnsA(t);
  const a = fwd(t.wtA);
  const b = fwd(t.wtB);
  rows(t, B, t.wtB, [
    ['Bash', `(cd "${a}" && git commit -am x)`, 'deny'],
    ['Bash', `{ cd "${a}"; git reset --hard; }`, 'deny'],
    ['PowerShell', `Push-Location "${a}"; git checkout -- .`, 'deny'],
    ['Bash', `cd "${b}" && cd "${a}" && git clean -fdx`, 'deny'],
    ['Bash', `(cd "${a}" && git status)`, 'allow'],
    ['Bash', `(cd "${a}" && git -c core.pager=cat log | head)`, 'allow'],
    ['Bash', `(cd "${b}" && git commit -am x)`, 'allow'],
  ]);
});

test('moving something into a folder that holds a peer worktree is allowed', () => {
  const t = setup();
  t.register(C, t.main, 'carol');
  const nested = path.join(t.main, '.claude', 'worktrees', 'n');
  t.git(t.main, 'worktree', 'add', '-q', nested, '-b', 'n');
  t.register(B, nested, 'bob');
  rows(t, C, t.main, [
    ['Bash', 'mv tmp/x.txt .', 'allow'],
    ['Bash', 'mv x ./', 'allow'],
    ['PowerShell', 'Move-Item tmp\\x.txt -Destination .', 'allow'],
    ['Bash', 'mv dist/app.js .claude/', 'allow'],
    ['Bash', 'mv .claude/worktrees /tmp/old', 'deny'],
  ]);
});

test('sort -o, uniq with an output file and tree -o write', () => {
  const t = setup();
  aliceOwnsA(t);
  const a = fwd(t.wtA);
  rows(t, B, t.wtB, [
    ['Bash', `cd "${a}" && sort -o a.txt b.txt`, 'deny'],
    ['Bash', `cd "${a}" && uniq a.txt out.txt`, 'deny'],
    ['Bash', `cd "${a}" && tree -o out.txt`, 'deny'],
  ]);
});

test('the session start explains file requests and the shell rule', () => {
  const t = setup();
  const s = t.start(A, t.plain);
  assert.match(s.context, /request "<path>"/);
  assert.match(s.context, /force-handoff/);
  assert.match(s.context, /COORD REQUEST/);
  assert.match(s.context, /Shell commands that would write there are blocked/);
});

// ---- commands chained with coord.js ----

test('a coord.js call chained with anything else is denied, so the rest never skips the checks', () => {
  const t = setup();
  aliceOwnsA(t);
  const a = fwd(t.wtA);
  const c = `node "${fwd(CLI)}"`;
  fs.writeFileSync(path.join(t.wtB, 'a.txt'), 'bob\n');
  t.git(t.wtB, 'commit', '-q', '-am', 'bob edit');
  assert.equal(t.sh(A, t.wtA, 'vercel --prod').decision, 'allow', 'alice takes the prod-deploy lock');
  const behind = { VIBEQUARTERS_COORD_FAKE_BEHIND: '3' };
  const shapes = [
    ['git push -u origin b', `git push -u origin b && ${c} note pushed`],
    [`echo x > "${a}/new.txt"`, `echo x > "${a}/new.txt"; ${c}`],
    [`rm -f "${a}/a.txt"`, `${c} && rm -f "${a}/a.txt"`],
    ['gh pr merge 5 --squash', `gh pr merge 5 --squash && node coord.js unlock merge`],
    ['vercel --prod', `vercel --prod && ${c} unlock prod-deploy`],
  ];
  for (const [alone, chained] of shapes) {
    assert.equal(t.sh(B, t.wtB, alone, behind).decision, 'deny', `control: ${alone}`);
    const r = t.sh(B, t.wtB, chained, behind);
    assert.equal(r.decision, 'deny', chained);
    assert.match(r.reason, /only command in its call/, chained);
  }
});

test('reads after a coord.js command are allowed', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  const c = `node "${fwd(CLI)}"`;
  for (const cmd of [
    `${c} note one && echo done`, `${c} note two; ls; cat a.txt`, `${c} note three && ${c}`,
    `${c} note four | cat`, `${c} note "five; six" && echo "it said: ok"`,
  ]) assert.equal(t.sh(A, t.wtA, cmd).decision, 'allow', cmd);
  assert.deepEqual(t.registry().notes.map((n) => n.text).slice(0, 5), ['one', 'two', 'three', 'four', 'five; six']);
});

test('anything else after a coord.js command is denied', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  const c = `node "${fwd(CLI)}"`;
  for (const cmd of [
    `${c} note x && git status`, `${c} note x && gh pr list`, `${c} note x && echo y > f.txt`, `${c} note x > f.txt; echo`,
    `${c} note x && echo $(git push)`, `${c} note x && echo \`git push\``, `${c} note x | sh`, `${c} note x && cat a.txt | tee b.txt`,
    `${c} note x && ${c} task other`, `echo hi && ${c} note x`, `${c} note x && cd ..`, `${c} force-handoff r1 && echo ok`,
    `${c} note "$(git push)" && echo ok`,
  ]) {
    const r = t.sh(A, t.wtA, cmd);
    assert.notEqual(r.decision, 'allow', cmd);
    if (!/force-handoff/.test(cmd)) assert.match(r.reason, /only command in its call/, cmd);
  }
  assert.deepEqual(t.registry().notes, []);
});

test('a read-only tail that runs a command through ( ), @( ), { } or $\' quoting is denied', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  const c = `node "${fwd(CLI)}"`;
  for (const cmd of [
    `${c} note x; echo (gh pr merge 5 -R a/b)`, `${c} note x; ls @(git -C C:/peer reset --hard)`,
    `${c} note x; echo $'\\''; gh pr merge 5 -R a/b; echo ''`, `${c} note x; echo { git push }`,
  ]) {
    const r = t.sh(A, t.wtA, cmd);
    assert.notEqual(r.decision, 'allow', cmd);
    assert.match(r.reason, /only command in its call/, cmd);
  }
  assert.deepEqual(t.registry().notes, []);
});

test('a standalone coord.js call is still applied; a command that only mentions one is judged as itself', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  assert.equal(t.sh(A, t.wtA, 'node coord.js note bare spelling').decision, 'allow');
  assert.equal(coord(t, A, t.wtA, 'note "a; b | c && d"').decision, 'allow', 'separators inside quotes');
  assert.equal(coord(t, A, t.wtA, 'note redirected 2>&1').decision, 'allow', 'a redirect is not a separator');
  const notes = t.registry().notes.map((n) => n.text);
  assert.deepEqual(notes.slice(0, 2), ['bare spelling', 'a; b | c && d']);
  assert.match(notes[2], /^redirected/);
  const g = t.sh(B, t.wtB, 'grep "node coord.js register" notes.md');
  assert.equal(g.decision, 'allow');
  assert.doesNotMatch(g.reason, /register needs --name/);
  assert.equal(t.sh(B, t.wtB, 'cat coord.js').decision, 'allow');
});

test('force-release, end-session and force-handoff ask the user however coord.js is launched', () => {
  const t = setup();
  aliceOwnsA(t);
  const cli = fwd(CLI);
  const cmds = [
    `node --no-warnings ${cli} force-release ${fwd(path.join(t.wtA, 'a.txt'))}`,
    `bun ${cli} end-session alice`,
    `node.exe "${cli}" force-handoff req-abc123`,
  ];
  for (const cmd of cmds) {
    const r = t.sh(B, t.wtB, cmd);
    assert.equal(r.decision, 'ask', cmd);
    assert.match(r.reason, /the user/, cmd);
  }
});

// Runs the guard on one tool call in a child process with the test env (so the throwaway registry), after `prelude`:
// code that may wrap child_process or coord-lib before the guard loads them. Returns the decision and stderr.
function guardAfter(t, prelude, session, cwd, tool, toolInput) {
  const r = spawnSync(process.execPath, ['-e', `${prelude.join('\n')}\nrequire(${JSON.stringify(GUARD)});`], {
    input: JSON.stringify({ session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput }),
    env: t.env, encoding: 'utf8',
  });
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : {};
  return { decision: (out.hookSpecificOutput || {}).permissionDecision || 'allow', stderr: r.stderr };
}
const LIB = JSON.stringify(path.join(HOOKS, 'coord-lib.js'));

// Counts git spawns made while L.update holds the registry lock; prints the count to stderr on exit.
const COUNT_GIT_UNDER_LOCK = [
  "const cp = require('child_process');",
  'const spawn = cp.execFileSync;',
  'let held = 0;',
  'let under = 0;',
  "cp.execFileSync = function (file, ...rest) { if (held && file === 'git') under++; return spawn.call(this, file, ...rest); };",
  `const L = require(${LIB});`,
  'const update = L.update;',
  'L.update = (fn) => update((r) => { held++; try { return fn(r); } finally { held--; } });',
  "process.on('exit', () => require('fs').writeSync(2, `git under lock: ${under}`));",
];

test('no git runs while the registry lock is held: edit and push judge other claims before taking it', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  t.register(B, t.wtB, 'bob');
  // alice claims both files and changes neither, so both claims are stale
  t.edit(A, t.wtA, path.join(t.wtA, 'a.txt'));
  t.edit(A, t.wtA, path.join(t.wtA, 'b.txt'));
  const e = guardAfter(t, COUNT_GIT_UNDER_LOCK, B, t.wtB, 'Edit', { file_path: path.join(t.wtB, 'b.txt'), old_string: 'x', new_string: 'y' });
  assert.equal(e.decision, 'allow');
  assert.match(e.stderr, /git under lock: 0$/);
  fs.writeFileSync(path.join(t.wtB, 'a.txt'), 'bob\n');
  t.git(t.wtB, 'commit', '-q', '-am', 'bob edit');
  const p = guardAfter(t, COUNT_GIT_UNDER_LOCK, B, t.wtB, 'Bash', { command: 'git push -u origin b' });
  assert.equal(p.decision, 'allow');
  assert.match(p.stderr, /git under lock: 0$/);
  const claims = t.registry().claims.map((c) => [c.session === B ? 'bob' : 'alice', c.path]).sort();
  assert.deepEqual(claims, [['bob', 'a.txt'], ['bob', 'b.txt']], 'the stale claims are replaced');
});

test('an active claim another session adds between the snapshot and the lock survives', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  t.register(B, t.wtB, 'bob');
  const wtC = path.join(t.root, 'wt-c');
  t.git(t.main, 'worktree', 'add', '-q', wtC, '-b', 'c');
  t.register(C, wtC, 'carol');
  t.edit(A, t.wtA, path.join(t.wtA, 'b.txt')); // alice's stale claim
  fs.writeFileSync(path.join(wtC, 'b.txt'), 'carol\n'); // carol's unshipped change; her claim lands after bob's snapshot
  const prelude = [
    `const L = require(${LIB});`,
    'const update = L.update;',
    'let once = false;',
    'L.update = (fn) => {',
    '  if (!once) {',
    '    once = true;',
    `    const repo = L.findRepo(${JSON.stringify(wtC)});`,
    `    update((r) => { r.claims.push({ repo: repo.common, path: 'b.txt', session: ${JSON.stringify(C)}, worktree: L.norm(repo.top), at: Date.now() }); });`,
    '  }',
    '  return update(fn);',
    '};',
  ];
  const e = guardAfter(t, prelude, B, t.wtB, 'Edit', { file_path: path.join(t.wtB, 'b.txt'), old_string: 'x', new_string: 'y' });
  assert.equal(e.decision, 'allow', e.stderr);
  const who = { [A]: 'alice', [B]: 'bob', [C]: 'carol' };
  const claims = t.registry().claims.filter((c) => c.path === 'b.txt').map((c) => who[c.session]).sort();
  assert.deepEqual(claims, ['bob', 'carol'], 'alice\'s stale claim is dropped; carol\'s, never judged, is kept');
});

// Gives a.txt in wt a textconv diff driver, as Git for Windows' system gitattributes do for .pdf and .docx. The tests
// set GIT_CONFIG_NOSYSTEM, so the driver goes in the repo config; `js` prints the text form of the file in argv[2].
function textconv(t, wt, name, js) {
  const script = path.join(t.root, `${name}.js`);
  fs.writeFileSync(script, js);
  t.git(t.main, 'config', `diff.${name}.textconv`, `"${fwd(process.execPath)}" "${fwd(script)}"`);
  fs.writeFileSync(path.join(wt, '.gitattributes'), `a.txt diff=${name}\n`);
}
const UPPER = "process.stdout.write(require('fs').readFileSync(process.argv[2], 'utf8').toUpperCase());";
const SAME = "process.stdout.write('same\\n');";

test('a handoff patch ignores a textconv diff driver and restores the file byte for byte', () => {
  const t = setup();
  const q = bobRequestsA(t);
  textconv(t, t.wtA, 'upper', UPPER);
  assert.match(t.git(t.wtA, 'diff', '--', 'a.txt'), /ALICE CHANGE/, 'control: the driver is live');
  const h = coord(t, A, t.wtA, `handoff ${q.id}`);
  assert.equal(h.decision, 'allow', h.reason);
  t.git(t.wtB, 'apply', '--3way', t.registry().requests[0].patch);
  assert.deepEqual(fs.readFileSync(path.join(t.wtB, 'a.txt')), Buffer.from('alice change\n'));
});

test('a textconv diff driver does not free an unshipped claim', () => {
  // every version reads the same through the driver, so only the bytes show alice's change is not on main
  const t = setup();
  aliceCommitsLine2(t);
  textconv(t, t.wtA, 'same', SAME);
  assert.equal(t.git(t.wtA, 'diff', 'origin/main', '--', 'a.txt'), '', 'control: the driver is live');
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'deny');
});

test('a textconv diff driver does not keep a shipped claim', () => {
  // the driver changes every version's text, so only the bytes prove her shipped change reverse-applies onto main
  const t = setup();
  aliceCommitsLine2(t);
  mainSets(t, { 1: 'alice line 2' });
  mainSets(t, { 7: 'later change on main' });
  textconv(t, t.wtA, 'upper', UPPER);
  assert.match(t.git(t.wtA, 'diff', 'HEAD~1', 'HEAD', '--', 'a.txt'), /ALICE LINE 2/, 'control: the driver is live');
  t.end(A, t.wtA);
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'allow');
});

// Runs R.handOver for the first request in a child process with the test env, from a snapshot taken BEFORE `between`
// changes the registry, as a second session can between the owner's snapshot and its lock. Returns the verdict.
function staleHandOver(t, between) {
  const script = [
    `const L = require(${LIB});`,
    `const R = require(${JSON.stringify(path.join(HOOKS, 'coord-requests.js'))});`,
    'const reg = L.load();',
    between,
    'process.stdout.write(JSON.stringify(R.handOver(reg, reg.requests[0], Date.now(), false)));',
  ].join('\n');
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env: t.env, encoding: 'utf8' }));
}
const handoffFiles = (t) => {
  const dir = path.join(t.env.VIBEQUARTERS_COORD_DIR, 'handoffs');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

test('a handoff of a request withdrawn before the lock is refused: nothing moves and no patch is left', () => {
  const t = setup();
  bobRequestsA(t);
  const v = staleHandOver(t, "L.update((r) => { Object.assign(r.requests[0], { state: 'withdrawn', answeredAt: Date.now(), told: true }); });");
  assert.equal(v.decision, 'deny', v.text);
  assert.match(v.text, /no longer open \(state withdrawn\); nothing was handed over, keep your file/);
  const reg = t.registry();
  assert.deepEqual([reg.requests[0].state, reg.requests[0].patch], ['withdrawn', undefined]);
  assert.equal(reg.claims.find((c) => c.path === 'a.txt').session, A);
  assert.deepEqual(handoffFiles(t), [], 'the patch it wrote is removed');
});

test('a handoff that lost the race to another handoff of the same request keeps the winner patch', () => {
  const t = setup();
  bobRequestsA(t);
  const v = staleHandOver(t, 'R.handOver(L.load(), L.load().requests[0], Date.now(), false);');
  assert.equal(v.decision, 'deny', v.text);
  assert.match(v.text, /state handed/);
  const q = t.registry().requests[0];
  assert.equal(q.state, 'handed');
  assert.ok(fs.existsSync(q.patch), 'the record still points to its patch');
});

test('the request text says SendMessage a live owner, and force-handoff now when the owner has closed', () => {
  const t = setup();
  aliceOwnsA(t);
  const ask = () => coord(t, B, t.wtB, `request "${fwd(path.join(t.wtB, 'a.txt'))}" "make line 1 say hi"`);
  const live = ask();
  assert.match(live.context, /SendMessage "alice"/);
  assert.match(live.context, /No answer in 15 minutes/);
  coord(t, B, t.wtB, `withdraw ${t.registry().requests[0].id}`);
  t.end(A, t.wtA);
  const closed = ask();
  assert.equal(closed.decision, 'allow', closed.reason);
  const q = t.registry().requests.find((x) => x.state === 'open');
  assert.match(closed.context, /"alice" has closed or gone quiet/);
  assert.ok(closed.context.includes(`force-handoff ${q.id} can be run now (the user approves it)`), closed.context);
  assert.doesNotMatch(closed.context, /SendMessage|15 minutes/);
});

test('a request id that is not req- and 6 hex digits is dropped on load, so it never names a file', () => {
  const t = setup();
  const q = bobRequestsA(t);
  age(t, (reg) => { reg.requests.push({ ...reg.requests[0], id: '../x' }); });
  coord(t, A, t.wtA, 'note "tick"');
  assert.deepEqual(t.registry().requests.map((x) => x.id), [q.id]);
});


// Runs `body` (a function body that returns a value) with L = coord-lib, under the test env.
function libRun(t, body, extraEnv = {}) {
  const script = `const L = require(${LIB});\n` +
    `process.stdout.write(JSON.stringify((() => { ${body} })()));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...t.env, ...extraEnv }, encoding: 'utf8' }));
}
const board = (t) => fs.readFileSync(path.join(t.env.VIBEQUARTERS_COORD_DIR, 'BOARD.md'), 'utf8');
const worktree = (t, n) => { const p = path.join(t.root, n); t.git(t.main, 'worktree', 'add', '-q', p, '-b', n); return p; };
test('a registry field coord-lib does not know is dropped by the next write', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  age(t, (reg) => { reg.extra = { session: A }; });
  assert.ok('extra' in t.registry(), 'control: the field is on disk');
  assert.equal(libRun(t, "return 'extra' in L.load();"), false);
  coord(t, A, t.wtA, 'note "tick"');
  assert.equal('extra' in t.registry(), false);
});

test('the board names the gate records file', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  t.register(B, t.wtB, 'bob');
  coord(t, B, t.wtB, 'note "tick"');
  const b = board(t);
  assert.match(b, /\| bob \|/, 'control: the board was written');
  assert.match(b, /^Every gate record, kept for good: .*GATE-RECORDS\.md$/m);
});

const mcoord = (t, session, cwd, args, extraEnv = {}) => t.sh(session, cwd, `node "${fwd(CLI)}" ${args}`, extraEnv);

const shipArgs = (prs) => `ship ${prs}`;
const spawnFile = (t) => path.join(t.root, 'spawned.txt');
const spawned = (t) => (fs.existsSync(spawnFile(t)) ? fs.readFileSync(spawnFile(t), 'utf8').split('\n').filter(Boolean) : []);
const FAKE = (t, extra = {}) => ({ VIBEQUARTERS_COORD_FAKE_SPAWN: spawnFile(t), ...extra });
function threeWorking(t) {
  t.register(A, t.wtA, 'alice', 'build a');
  t.register(B, t.wtB, 'bob', 'build b');
  t.register(C, thirdWorktree(t), 'carol', 'build c'); // the count is per repo, so carol works in repo too
}

const LAND = /ship does not merge\. Run \/land in this session: it reviews the PR, you fix the findings, and you merge with: /;

test('ship in a repository without batches names a direct squash merge', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  t.register(B, t.wtB, 'bob');
  const r = mcoord(t, A, t.wtA, shipArgs(12), FAKE(t));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, LAND);
  assert.match(r.reason, /gh pr merge 12 --squash --body-file/);
  assert.doesNotMatch(r.reason, /merge-batch\.js/);
  assert.deepStrictEqual(spawned(t), []);
});

test('ship in a batch repository names the merge-batch build command', () => {
  const M = require('../coord-land.js');
  const r = { sessions: { me: { name: 'app-aa', task: 'build' } }, claims: [] };
  const out = M.shipJob(r, 'me', { repo: { common: 'x' }, repoName: 'acme/app', prs: [12] }, Date.now());
  assert.equal(out.decision, 'deny');
  assert.match(out.text, LAND);
  assert.match(out.text, /merge-batch\.js" build --repo acme\/app --prs 12/);
  assert.deepStrictEqual(r, { sessions: { me: { name: 'app-aa', task: 'build' } }, claims: [] }, 'the registry is unchanged');
});

test('ship is answered with the /land steps however many sessions work in the repository', () => {
  const t = setup();
  threeWorking(t);
  const E = 'eeeeeeee-0000-0000-0000-000000000005';
  t.register(D, worktree(t, 'wt-d'), 'dave', 'build d');
  t.register(E, worktree(t, 'wt-e'), 'erin', 'build e');
  const r = mcoord(t, A, t.wtA, shipArgs(12), FAKE(t));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, LAND);
  assert.match(r.reason, /gh pr merge 12 --squash/);
  assert.doesNotMatch(r.reason, /SendMessage/);
  assert.deepStrictEqual(spawned(t), []);
});

test('ship spawns no tab', () => {
  const t = setup();
  t.git(t.main, 'remote', 'set-url', 'origin', 'https://github.com/acme/site.git'); // a repo a Fixer tab could open for
  threeWorking(t);
  t.register(D, worktree(t, 'wt-d'), 'not-fixer', 'daily fix'); // only a name that starts fixer opens one
  for (const [s, cwd] of [[A, t.wtA], [D, path.join(t.root, 'wt-d')]]) {
    assert.equal(mcoord(t, s, cwd, shipArgs(12), FAKE(t)).decision, 'deny');
  }
  assert.equal(fs.existsSync(spawnFile(t)), false);
  assert.deepStrictEqual(t.registry().landTabs || {}, {}, 'no tab marker either');
});

const FIXER_PROMPT = (pr, name = 'fixer') =>
  `/land ${pr} for acme/site (shipped by the fixer session ${name}). Work in your own new worktree of the PR's branch.`;
const promptOf = (url) => decodeURIComponent(url.replace(/^vscode:\/\/anthropic\.claude-code\/open\?prompt=/, ''));
function fixerShips(t, name = 'fixer') {
  t.git(t.main, 'remote', 'set-url', 'origin', 'https://github.com/acme/site.git');
  t.register(D, t.wtA, name, 'daily fix');
  return (args) => mcoord(t, D, t.wtA, args, FAKE(t));
}

test('a Fixer ship opens exactly one /land tab for its PR', () => {
  const t = setup();
  const ship = fixerShips(t);
  const r = ship('ship 21');
  assert.equal(r.decision, 'allow', r.reason);
  const urls = spawned(t);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^vscode:\/\/anthropic\.claude-code\/open\?prompt=[\w.~*'()%-]+$/, 'the whole prompt is URL-encoded');
  assert.equal(promptOf(urls[0]), FIXER_PROMPT(21));
  assert.match(r.context, /#21 in acme\/site went to a fresh \/land tab/);
  assert.match(r.context, /your shift can end/i);
  assert.equal(typeof t.registry().landTabs['acme/site#21'], 'number');
});

test('a Fixer ship of several PRs opens one tab per PR, and a second ship of the same PR opens none', () => {
  const t = setup();
  const ship = fixerShips(t, 'fixer-2');
  assert.equal(ship('ship 21').decision, 'allow');
  const again = ship('ship 21');
  assert.equal(again.decision, 'allow', again.reason);
  assert.match(again.context, /#21 in acme\/site already has a \/land tab, opened at \d{4}-\d\d-\d\dT\S+Z; nothing new opened/);
  assert.equal(spawned(t).length, 1, 'no second tab for #21');
  assert.equal(ship('ship 21 22 #23').decision, 'allow');
  assert.deepStrictEqual(spawned(t).map(promptOf), [21, 22, 23].map((n) => FIXER_PROMPT(n, 'fixer-2')));
});

test('a Fixer ship with a bad PR or a repo with no GitHub name denies and opens nothing', () => {
  const t = setup();
  const ship = fixerShips(t);
  for (const args of ['ship "12;rm"', 'ship 12x', 'ship "12 && calc"']) assert.equal(ship(args).decision, 'deny', args);
  t.git(t.main, 'remote', 'set-url', 'origin', fwd(path.join(t.root, 'origin.git'))); // no owner/repo to name
  const local = ship('ship 12');
  assert.equal(local.decision, 'deny');
  assert.match(local.reason, /no \/land tab opened/);
  assert.equal(fs.existsSync(spawnFile(t)), false);
  assert.deepStrictEqual(t.registry().landTabs || {}, {});
});

test('shipJob checks the Fixer PR, repo and name before it builds a prompt', () => {
  const M = require('../coord-land.js');
  const run = (name, repoName, prs) => {
    const r = { sessions: { me: { name } }, claims: [] };
    return [M.shipJob(r, 'me', { repoName, prs }, Date.now()), r];
  };
  for (const [name, repoName, prs] of [['fixer', 'acme/site', ['12;rm']], ['fixer', 'acme/site', [12.5]],
    ['fixer', 'acme/site"&calc', [12]], ['fixer', 'repo', [12]], ['fixer-a;b', 'acme/site', [12]]]) {
    const [v, r] = run(name, repoName, prs);
    assert.equal(v.decision, 'deny', `${name} ${repoName} ${prs}`);
    assert.deepStrictEqual([v.open || [], r.landTabs || {}], [[], {}], `${name} ${repoName} ${prs}`);
  }
  const [ok, r] = run('fixer', 'acme/site', [12]);
  assert.equal(ok.decision, 'allow', 'control');
  assert.equal(ok.open.length, 1);
  assert.equal(typeof r.landTabs['acme/site#12'], 'number');
});

// A /land tab that never came must not strand the PR, so the stamp lasts 24 hours.
test('a Fixer re-ship inside 24 h opens nothing and names the manual /land; after 24 h it opens a new tab', () => {
  const M = require('../coord-land.js');
  const r = { sessions: { me: { name: 'fixer' } }, claims: [] };
  const t0 = Date.parse('2030-01-01T00:00:00Z');
  const ship = (now) => M.shipJob(r, 'me', { repoName: 'acme/site', prs: [12] }, now);
  assert.equal(ship(t0).open.length, 1);
  const soon = ship(t0 + 24 * 3600e3 - 1);
  assert.deepStrictEqual(soon.open, []);
  assert.match(soon.text, /already has a \/land tab, opened at 2030-01-01T00:00:00\.000Z; nothing new opened\. If no tab came, run \/land 12 for acme\/site in any tab\./);
  assert.equal(r.landTabs['acme/site#12'], t0, 'a re-ship inside 24 h keeps the first stamp');
  const later = ship(t0 + 24 * 3600e3);
  assert.equal(later.open.length, 1);
  assert.match(later.text, /#12 in acme\/site went to a fresh \/land tab/);
  assert.equal(r.landTabs['acme/site#12'], t0 + 24 * 3600e3);
});

test('ship leaves task and claims unchanged', () => {
  const t = setup();
  threeWorking(t);
  t.edit(A, t.wtA, path.join(t.wtA, 'a.txt'));
  fs.writeFileSync(path.join(t.wtA, 'a.txt'), 'alice change\n');
  const before = t.registry().claims.find((c) => c.path === 'a.txt');
  assert.ok(before, 'control: alice holds a claim on a.txt');
  assert.equal(mcoord(t, A, t.wtA, shipArgs(12), FAKE(t)).decision, 'deny');
  const reg = t.registry();
  assert.equal(reg.sessions[A].task, 'build a');
  assert.deepStrictEqual(reg.claims.find((c) => c.path === 'a.txt'), before);
});

test('ship is denied with the /land steps whoever else is registered, and opens no tab', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  t.register(D, t.main, 'dave', 'merging');
  const r = mcoord(t, A, t.wtA, shipArgs(12), FAKE(t));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, LAND);
  assert.deepStrictEqual(spawned(t), []);
});

const gateRecords = (t) => path.join(t.env.VIBEQUARTERS_COORD_DIR, 'GATE-RECORDS.md');

test('landed appends one GATE-RECORDS line', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  assert.equal(fs.existsSync(gateRecords(t)), false, 'control: no record yet');
  const r = mcoord(t, A, t.wtA, 'landed 12 --gate "abc1234; live check ok; control 404"');
  assert.equal(r.decision, 'allow', r.reason);
  const lines = fs.readFileSync(gateRecords(t), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /^- \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z alice repo #12 landed: abc1234; live check ok; control 404$/);
  assert.equal(mcoord(t, A, t.wtA, 'landed #13 --gate "def5678"').decision, 'allow');
  assert.match(fs.readFileSync(gateRecords(t), 'utf8').split('\n').filter(Boolean)[1], / alice repo #13 landed: def5678$/, 'a second landing adds a line');
});

test('landed without --gate denied', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  for (const args of ['landed 12', 'landed 12 --gate', 'landed 12 --gate ""', 'landed --gate "abc"', 'landed twelve --gate "abc"']) {
    const r = mcoord(t, A, t.wtA, args);
    assert.equal(r.decision, 'deny', args);
    assert.match(r.reason, /landed <PR#> --gate/, args);
  }
  assert.equal(mcoord(t, A, t.plain, 'landed 12 --gate "abc"').decision, 'deny', 'outside a repo');
  assert.equal(mcoord(t, C, t.wtB, 'landed 12 --gate "abc"').decision, 'deny', 'unregistered');
  assert.equal(fs.existsSync(gateRecords(t)), false);
});

test('landed with more than one PR number denied', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  for (const args of ['landed 12 13 --gate "abc"', 'landed 12 #13 --gate "abc"']) {
    const r = mcoord(t, A, t.wtA, args);
    assert.equal(r.decision, 'deny', args);
    assert.match(r.reason, /one PR per landed: run landed once for each PR/, args);
  }
  assert.equal(fs.existsSync(gateRecords(t)), false, 'nothing recorded');
  assert.equal(mcoord(t, A, t.wtA, 'landed 12 --gate "abc"').decision, 'allow', 'control: one PR lands');
});

test('ship takes PR numbers and nothing else', () => {
  const t = setup();
  threeWorking(t);
  for (const args of ['ship 12', 'ship #12']) {
    const r = mcoord(t, A, t.wtA, args, FAKE(t));
    assert.equal(r.decision, 'deny', args);
    assert.match(r.reason, LAND, args);
    assert.match(r.reason, /gh pr merge 12 --squash/, args);
    assert.doesNotMatch(r.reason, /usage:/, args);
  }
  for (const args of ['ship', 'ship --order "x"', 'ship 12 --order "x"', 'ship twelve']) {
    const r = mcoord(t, A, t.wtA, args, FAKE(t));
    assert.equal(r.decision, 'deny', args);
    assert.match(r.reason, /usage: .*ship <PR#>/, args);
  }
  assert.deepStrictEqual(spawned(t), []);
});

test('ship is denied outside any repository', () => {
  const t = setup();
  threeWorking(t);
  const r = mcoord(t, C, t.plain, shipArgs(12), FAKE(t));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /worktree/);
});

// Pushes and merges are judged only; nothing runs. FAKE_BEHIND keeps the merge check off the network.
const GH = { VIBEQUARTERS_COORD_FAKE_GITHUB: '1', VIBEQUARTERS_COORD_FAKE_BEHIND: '0' };

test('a session alone in its repository may merge a PR and push main', () => {
  const t = setup();
  t.register(B, t.wtB, 'bob');
  for (const cmd of ['gh pr merge 7 --squash', 'git push origin main']) {
    const r = t.sh(B, t.wtB, cmd, GH);
    assert.equal(r.decision, 'allow', `${cmd}: ${r.reason}`);
  }
});

test('the session start says to merge with /land', () => {
  const t = setup();
  t.register(B, t.wtB, 'bob');
  const solo = t.start(B, t.wtB).context;
  assert.match(solo, /Merge your own pull requests with \/land\. A lock lets one session merge at a time\./);
  assert.doesNotMatch(solo, /coord\.js" ship /);
});

test('end-session closes a session whose name has a space, quoted or not', () => {
  for (const args of [['end-session', 'docs helper'], ['end-session', 'docs', 'helper']]) {
    const t = setup();
    t.register(A, t.wtA, '"docs helper"', 'build');
    t.register(B, t.wtB, 'bob');
    assert.equal(t.registry().sessions[A].name, 'docs helper', 'control: registered under the spaced name');
    assert.match(t.cli(...args), /Marked 1 session\(s\) named "docs helper" closed/);
    assert.equal(typeof t.registry().sessions[A].endedAt, 'number', args.join(' '));
  }
});

test('help lists ship, and an unknown command prints the usage and exits 1', () => {
  const t = setup();
  const help = t.cli('help');
  assert.match(help, /^\s+ship <PR#>/m, 'control: help lists the commands');
  for (const args of [['nonsense'], ['nonsense', 'claim', '--ref', 'abc123']]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { env: t.env, encoding: 'utf8', cwd: t.root });
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stdout, /^usage: /m, args.join(' '));
  }
});

// ---- A slim board: live sessions, claim counts, locks, requests; commands print one line about it ----

test('the board lists live sessions and counts the rest', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  t.register(B, t.wtB, 'bob');
  t.register(C, t.plain, 'carol');
  coord(t, A, t.wtA, 'note "tick"');
  assert.doesNotMatch(board(t), /not shown/, 'negative control: every session live, nothing counted');
  age(t, (reg) => {
    reg.sessions[B].lastSeen = Date.now() - 4 * 24 * 3600e3; // quiet: unseen past the 72 hour live window
    reg.sessions[C].endedAt = Date.now() - 3600e3; // closed
  });
  coord(t, A, t.wtA, 'note "tock"');
  const b = board(t);
  assert.match(b, /\| alice \|.*\| live \|/);
  assert.doesNotMatch(b, /\| bob \|/);
  assert.doesNotMatch(b, /\| carol \|/);
  assert.match(b, /^2 closed or quiet sessions not shown\.$/m);
});

test('the board counts each owner\'s claimed files instead of listing them', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  t.register(B, t.wtB, 'bob');
  assert.equal(t.edit(A, t.wtA, path.join(t.wtA, 'a.txt')).decision, 'allow');
  assert.equal(t.edit(A, t.wtA, path.join(t.wtA, 'b.txt')).decision, 'allow');
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'c.txt')).decision, 'allow');
  assert.equal(t.registry().claims.length, 3);
  const b = board(t);
  const claimed = b.slice(b.indexOf('## Claimed files'), b.indexOf('## Locks'));
  assert.match(claimed, /^## Claimed files \(each releases itself once the file matches the shipped branch\)$/m);
  assert.match(claimed, /^- alice in repo: 2 files$/m);
  assert.match(claimed, /^- bob in repo: 1 file$/m);
  assert.doesNotMatch(claimed, /[abc]\.txt/);
});

test('a coord.js command prints one line about the board, not the whole board', () => {
  const t = setup();
  aliceOwnsA(t);
  const pointer = /^Full board: node ".*coord\.js" \(or ~\/\.claude\/coordination\/BOARD\.md\)\.$/m;
  for (const args of [['task', 'x'], ['note', 'hi'], ['end-session', 'nobody']]) {
    const out = t.cli(...args);
    assert.doesNotMatch(out, /# Session board/, args.join(' '));
    assert.match(out, pointer, args.join(' '));
    assert.equal(out.trim().split(/\r?\n/).length, 2, `${args.join(' ')} printed: ${out}`);
  }
  assert.match(t.cli('task', 'x'), /^"task" was applied by the coord-guard hook/m);
  for (const args of [[], ['board']]) {
    const out = t.cli(...args);
    assert.match(out, /^# Session board$/m, `bare: ${args.join(' ')}`);
    assert.match(out, /\| alice \|/);
  }
});

const thirdWorktree = (t) => worktree(t, 'wt-c');


test('the normal placements of a merge are recognized by the merge lock and the behind check', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  t.register(B, t.wtB, 'bob');
  assert.match(t.sh(A, t.wtA, 'gh --repo=o/x pr merge 5 --squash', { VIBEQUARTERS_COORD_FAKE_BEHIND: '3' }).reason, /update-branch/, 'behind check');
  assert.equal(t.sh(A, t.wtA, '"gh" -R o/x pr merge 5 --squash', GH).decision, 'allow');
  assert.equal(t.registry().locks.merge.session, A, 'the merge lock is taken');
  assert.equal(t.sh(B, t.wtB, '"C:/Program Files/GitHub CLI/gh.exe" pr merge 6 --squash', GH).decision, 'deny', 'and held against a peer');
});

test('mergeSelector skips every value flag and reads past a bundled one', () => {
  const t = setup();
  const sel = (...w) => libRun(t, `return L.mergeSelector(${JSON.stringify(w)});`);
  assert.equal(sel('gh', 'pr', 'merge', '--match-head-commit', 'abc', '7'), '7');
  assert.equal(sel('gh', 'pr', 'merge', '-A', 'a@b.c', '--author-email', 'x@y.z', '7'), '7');
  assert.equal(sel('gh', 'pr', 'merge', '-sb', 'body text', '7'), '7');
  assert.equal(sel('gh', 'pr', 'merge', '-sbtext', '7'), '7');
  assert.equal(sel('gh', 'pr', 'merge', '-R', 'o/r', '-t', 'subj', '8'), '8');
  assert.equal(sel('gh', 'pr', 'merge', '--squash', '--delete-branch'), '');
  assert.equal(sel('gh', 'pr', 'merge', '--body', 'x'), '');
  assert.equal(sel('gh', '-R', 'o/r', 'pr', 'merge', '9'), '9');
});

test('when git cannot say which repo this is, a solo merge and a main push still pass', () => {
  const t = setup();
  t.register(B, t.wtB, 'bob');
  const cfg = path.join(t.main, '.git', 'config');
  fs.writeFileSync(cfg, `${fs.readFileSync(cfg, 'utf8')}\n[broken\n`);
  assert.equal(t.sh(B, t.wtB, 'gh pr merge 7 --squash', GH).decision, 'allow', 'a solo merge');
  age(t, (reg) => { reg.locks = {}; });
  assert.equal(t.sh(B, t.wtB, 'git push origin main', GH).decision, 'allow', 'a solo push');
});

const STRING_PUSHES = ['bash -c "git push origin main" && echo "done"', "bash -c 'git push origin main' && echo 'done'", 'powershell -Command "git push origin main"; echo "done"'];

test('a solo main push in a shell string with quoted text after it passes', () => {
  const t = setup();
  t.register(B, t.wtB, 'bob');
  for (const cmd of STRING_PUSHES) assert.equal(t.sh(B, t.wtB, cmd, GH).decision, 'allow', `solo: ${cmd}`);
});

test('an unquoted # or ) in coord.js args keeps what the session typed', () => {
  const t = setup();
  t.register(B, t.wtB, 'bob');
  const task = (a) => { mcoord(t, B, t.wtB, a, GH); return t.registry().sessions[B].task; };
  const note = (a) => { mcoord(t, B, t.wtB, a, GH); return t.registry().notes.slice(-1)[0].text; };
  assert.equal(task('task #7: narrow fix'), '#7: narrow fix');
  assert.equal(task('task fix #7 login form'), 'fix #7 login form');
  assert.equal(task('task fix login (PR 7) now'), 'fix login (PR 7) now');
  assert.equal(note('note #7 merged abc123'), '#7 merged abc123');
  const shipped = mcoord(t, B, t.wtB, 'ship #7', GH);
  assert.equal(shipped.decision, 'deny');
  assert.ok(shipped.reason.includes('gh pr merge 7 --squash'), `the steps name PR 7: ${shipped.reason}`);
  assert.equal(task('task "fix #7 (login) a)b"'), 'fix #7 (login) a)b', 'control: quoted');
  assert.equal(note('note "merged #7 at abc (ok)"'), 'merged #7 at abc (ok)', 'control: quoted');
});

// alice owns a.txt with her change committed and pushed to origin/a, then her tab closes (SessionEnd).
function aliceClosedPushed(t) {
  aliceOwnsA(t);
  t.git(t.wtA, 'commit', '-q', '-am', 'alice work');
  t.git(t.wtA, 'push', '-q', 'origin', 'a');
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'deny', 'control: blocks while alice is live');
  t.end(A, t.wtA);
}

test('a closed session whose worktree is clean and pushed no longer blocks an edit', () => {
  const t = setup();
  aliceClosedPushed(t);
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'allow');
  const left = t.registry().claims.find((c) => c.session === A && c.path === 'a.txt');
  assert.equal(left, undefined, 'the closed claim is dropped when bob claims the file');
});

test('negative control: a closed session with an uncommitted file still blocks', () => {
  const t = setup();
  aliceClosedPushed(t);
  fs.writeFileSync(path.join(t.wtA, 'c.txt'), 'unsaved\n');
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'deny');
});

test('negative control: a closed session with a commit on no remote branch still blocks', () => {
  const t = setup();
  aliceClosedPushed(t);
  fs.writeFileSync(path.join(t.wtA, 'b.txt'), 'local only\n');
  t.git(t.wtA, 'commit', '-q', '-am', 'not pushed');
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'deny');
});

test('negative control: a live session pushed and clean still blocks, and force-release on it still asks', () => {
  const t = setup();
  aliceOwnsA(t);
  t.git(t.wtA, 'commit', '-q', '-am', 'alice work');
  t.git(t.wtA, 'push', '-q', 'origin', 'a');
  assert.equal(t.edit(B, t.wtB, path.join(t.wtB, 'a.txt')).decision, 'deny');
  assert.equal(coord(t, B, t.wtB, `force-release "${fwd(path.join(t.wtB, 'a.txt'))}"`).decision, 'ask');
  assert.equal(coord(t, B, t.wtB, 'end-session alice').decision, 'ask');
  assert.equal(coord(t, B, t.wtB, 'release-closed alice').decision, 'deny');
  assert.ok(t.registry().claims.some((c) => c.session === A), 'nothing released');
});

test('releasing the claims of a closed session with nothing unpushed is not asked about', () => {
  const t = setup();
  aliceClosedPushed(t);
  const f = coord(t, B, t.wtB, `force-release "${fwd(path.join(t.wtB, 'a.txt'))}"`);
  assert.equal(f.decision, 'allow', f.reason);
  assert.equal(t.sh(B, t.wtB, `bun ${fwd(CLI)} force-release ${fwd(path.join(t.wtB, 'a.txt'))}`).decision, 'allow', 'another launcher');
  age(t, (reg) => { delete reg.sessions[A].endedAt; reg.sessions[A].lastSeen = Date.now() - 73 * 3600e3; }); // heartbeat gone
  assert.equal(coord(t, B, t.wtB, 'end-session alice').decision, 'allow');
});

test('negative control: force-release still asks when the closed holder has unpushed work', () => {
  const t = setup();
  aliceClosedPushed(t);
  fs.writeFileSync(path.join(t.wtA, 'c.txt'), 'unsaved\n');
  assert.equal(coord(t, B, t.wtB, `force-release "${fwd(path.join(t.wtB, 'a.txt'))}"`).decision, 'ask');
  assert.equal(t.sh(B, t.wtB, `bun ${fwd(CLI)} force-release ${fwd(path.join(t.wtB, 'a.txt'))}`).decision, 'ask');
});

test('release-closed drops every claim and request of a closed, safe session with no ask', () => {
  const t = setup();
  assert.ok(bobRequestsA(t), 'request recorded');
  t.git(t.wtA, 'commit', '-q', '-am', 'alice work');
  t.git(t.wtA, 'push', '-q', 'origin', 'a');
  t.end(A, t.wtA);
  assert.equal(coord(t, B, t.wtB, 'release-closed alice').decision, 'allow');
  assert.match(t.cli('release-closed', 'alice'), /Released 1 claim\(s\) of "alice"/);
  const reg = t.registry();
  assert.equal(reg.claims.filter((c) => c.session === A).length, 0);
  const q = reg.requests.find((x) => x.to === A);
  assert.equal(q.state, 'resolved', 'bob is told the file is free');
  assert.equal(q.told, false);
});

test('release-closed keeps every request still owed a notice: a handed one stays, an open one from it is withdrawn', () => {
  const t = setup();
  aliceClosedPushed(t);
  age(t, (reg) => {
    const repo = reg.claims.find((c) => c.session === A).repo;
    const base = { repo, path: 'b.txt', change: 'x', at: Date.now(), shown: 0 };
    reg.requests.push({ ...base, id: 'req-aaaaaa', from: B, to: A, state: 'handed', answeredAt: Date.now(), told: false });
    reg.requests.push({ ...base, id: 'req-bbbbbb', from: A, to: B, state: 'open' });
  });
  assert.match(t.cli('release-closed', 'alice'), /Released 1 claim\(s\)/);
  const reg = t.registry();
  const handed = reg.requests.find((q) => q.id === 'req-aaaaaa');
  assert.ok(handed, 'a handed request still owed its notice is kept');
  assert.equal(handed.state, 'handed');
  assert.equal(handed.told, false);
  assert.equal(reg.requests.find((q) => q.id === 'req-bbbbbb').state, 'withdrawn');
});

test('release-closed releases nothing when the session comes back live before the registry lock', () => {
  const t = setup();
  aliceClosedPushed(t);
  const r = spawnSync(process.execPath, ['-e', [
    `const L = require(${LIB});`,
    'const update = L.update;',
    `L.update = (fn) => update((r) => { const s = r.sessions[${JSON.stringify(A)}]; delete s.endedAt; s.lastSeen = Date.now(); return fn(r); });`,
    `process.argv = [process.argv[0], ${JSON.stringify(CLI)}, 'release-closed', 'alice'];`,
    `require(${JSON.stringify(CLI)});`,
  ].join('\n')], { env: t.env, encoding: 'utf8' });
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(t.registry().claims.some((c) => c.session === A), 'nothing released');
});

test('force-release keeps the claim of a holder that comes back live before the registry lock', () => {
  const t = setup();
  aliceClosedPushed(t);
  const run = (revive) => spawnSync(process.execPath, ['-e', [
    `const L = require(${LIB});`,
    'const update = L.update;',
    revive ? `L.update = (fn) => update((r) => { const s = r.sessions[${JSON.stringify(A)}]; delete s.endedAt; s.lastSeen = Date.now(); return fn(r); });` : '',
    `process.argv = [process.argv[0], ${JSON.stringify(CLI)}, 'force-release', ${JSON.stringify(fwd(path.join(t.wtA, 'a.txt')))}];`,
    `require(${JSON.stringify(CLI)});`,
  ].join('\n')], { env: t.env, encoding: 'utf8', cwd: t.wtB }).stdout;
  assert.match(run(true), /Released 0 claim/);
  assert.ok(t.registry().claims.some((c) => c.session === A), 'kept');
  age(t, (reg) => { reg.sessions[A].endedAt = Date.now(); });
  assert.match(run(false), /Released 1 claim/, 'control: still closed, so released');
});

test('release-closed denies and names what is unpushed; the CLI refuses it too', () => {
  const t = setup();
  aliceClosedPushed(t);
  fs.writeFileSync(path.join(t.wtA, 'c.txt'), 'unsaved\n');
  const r = coord(t, B, t.wtB, 'release-closed alice');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /uncommitted/);
  assert.throws(() => t.cli('release-closed', 'alice'));
  assert.ok(t.registry().claims.some((c) => c.session === A), 'nothing released');
});

test('a git failure reading the closed worktree counts as not safe: it blocks and asks', () => {
  const t = setup();
  aliceClosedPushed(t);
  const failRevList = [
    "const cp = require('child_process');",
    'const run = cp.execFileSync;',
    "cp.execFileSync = function (file, args, ...rest) { if (file === 'git' && args[0] === 'rev-list') throw new Error('boom'); return run.call(this, file, args, ...rest); };",
  ];
  const e = guardAfter(t, failRevList, B, t.wtB, 'Edit', { file_path: path.join(t.wtB, 'a.txt'), old_string: 'x', new_string: 'y' });
  assert.equal(e.decision, 'deny');
  const sh = (command) => guardAfter(t, failRevList, B, t.wtB, 'Bash', { command }).decision;
  assert.equal(sh(`node "${fwd(CLI)}" force-release "${fwd(path.join(t.wtB, 'a.txt'))}"`), 'ask');
  assert.equal(sh(`node "${fwd(CLI)}" release-closed alice`), 'deny');
  assert.equal(coord(t, B, t.wtB, 'release-closed alice').decision, 'allow', 'control: the same call with git working');
});
