// Tests for reading merges and default-branch pushes (coord-land.js) and the merge lock.
// Run: node --test system/hooks/tests/coord-merges.test.js
'use strict';
require('./helpers/config');
const { execGit } = require('./helpers/git');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const HOOKS = process.env.COORD_TEST_HOOKS || path.join(__dirname, '..');
const GUARD = path.join(HOOKS, 'coord-guard.js');
const SESSION = path.join(HOOKS, 'coord-session.js');
const CLI = path.join(HOOKS, 'coord.js');
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const OK = { VIBEQUARTERS_COORD_FAKE_BEHIND: '0' }; // the PR is current with its base, so only the lock could deny

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-nm-')));
  const env = { ...process.env };
  delete env.VIBEQUARTERS_GUARD;
  delete env.VIBEQUARTERS_COORD_FAKE_BEHIND;
  Object.assign(env, {
    VIBEQUARTERS_COORD_DIR: path.join(root, 'state'),
    VIBEQUARTERS_BATCH_DIR: path.join(root, 'batches'),
    VIBEQUARTERS_COORD_FAKE_SPAWN: path.join(root, 'spawned.txt'), // no test ever opens a real VS Code tab
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  });
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const git = (cwd, ...args) => execGit(args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = path.join(root, 'origin.git');
  const main = path.join(root, 'repo');
  fs.mkdirSync(main);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'push', '-q', '-u', 'origin', 'main');
  git(main, 'remote', 'set-head', 'origin', 'main');
  const wtA = path.join(root, 'wt-a');
  const wtB = path.join(root, 'wt-b');
  git(main, 'worktree', 'add', '-q', wtA, '-b', 'a');
  git(main, 'worktree', 'add', '-q', wtB, '-b', 'b');

  function run(script, input, extraEnv = {}) {
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify(input), env: { ...env, ...extraEnv }, encoding: 'utf8' });
    const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
    const h = (out && out.hookSpecificOutput) || {};
    return { decision: h.permissionDecision || 'allow', reason: h.permissionDecisionReason || '', context: h.additionalContext || '' };
  }
  const sh = (session, cwd, command, extraEnv) =>
    run(GUARD, { session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, extraEnv);
  const post = (session, cwd, command) =>
    run(GUARD, { session_id: session, cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: {} });
  const coordCmd = (args) => `node "${CLI.replace(/\\/g, '/')}" ${args}`;
  const register = (session, cwd, name) => sh(session, cwd, coordCmd(`register --name ${name} --task "test task"`));
  const start = (session, cwd) => run(SESSION, { session_id: session, cwd, hook_event_name: 'SessionStart', source: 'startup' });
  const regFile = path.join(env.VIBEQUARTERS_COORD_DIR, 'registry.json');
  const registry = () => JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: root });
  return { root, env, main, wtA, wtB, sh, post, coordCmd, register, start, registry, cli };
}

test('mergeStarts finds a merge in every spelling a shell runs, and mergeTarget reads the repo it names', () => {
  const M = require(path.join(HOOKS, 'coord-land.js'));
  const cwd = os.tmpdir();
  const target = (cmd) => { const s = M.mergeStarts(cmd); assert.ok(s.length >= 1, `no merge found in ${JSON.stringify(cmd)}`); return M.mergeTarget(cmd, s[0], cwd); };
  for (const cmd of ['gh pr -R o/repo merge 7 --squash', 'gh pr --repo=o/repo merge 7', 'for n in 7; do gh pr merge $n --squash; done',
    'if true; then gh pr merge 7; fi', 'timeout 60 gh pr merge 7', 'gh.exe pr merge 7', 'bash -c "gh pr merge 7"', 'if ($true) { gh pr merge 7 }',
    'gh pr \\\nmerge 7', "# don't\ngh pr merge 7\n# can't", 'echo "$(gh pr merge 7)"', 'powershell -NoProfile -ExecutionPolicy Bypass -Command "gh pr merge 7"']) {
    target(cmd);
  }
  for (const cmd of ['echo "gh pr merge 7"', 'git commit -m "then gh pr merge 7"', 'grep "gh pr merge" notes.md']) {
    assert.deepStrictEqual(M.mergeStarts(cmd), [], `text only: ${cmd}`);
  }
  for (const cmd of ['gh pr merge https://github.com/o/repo/pull/7 --squash', 'GH_REPO=o/repo gh pr merge 7 --squash', 'export GH_REPO=o/repo; gh pr merge 7 --squash',
    'gh pr merge 7 -R o/"repo"', 'gh pr merge 7 -sR o/repo', 'gh pr merge 7 -sRo/repo', 'gh pr merge -sR o/repo 7', 'gh pr merge 7 -dR=o/repo']) {
    assert.deepStrictEqual(target(cmd), { slug: 'o/repo' }, cmd);
  }
  const link = 'https://github.com/o/other/pull/3';
  for (const flags of [`--body "see ${link}"`, `--subject "see ${link}" --body-file x.md`, `-t "see ${link}"`, `-b "see ${link}"`, `--body=${link}`,
    `--subject=${link}`, `-t ${link}`, `--body ${link}`, '--body "-R o/other"', '--body -Ro/other', '--body=-R --subject o/other', `-b=${link}`,
    '--squash # -R o/other', `--squash # ${link}`]) {
    assert.deepStrictEqual(target(`gh pr merge 7 ${flags}`), { dir: cwd }, `text, not the target: ${flags}`);
  }
  assert.deepStrictEqual(target(`gh pr merge 7 --body "${link}" -R o/repo`), { slug: 'o/repo' }, 'a real -R after a linked body');
  for (const cmd of ['gh pr merge 7 --repo= o/other', 'gh pr merge 7 -R= o/other', 'gh pr merge $N -R "$REPO"']) {
    assert.strictEqual(target(cmd), null, `unreadable: ${cmd}`);
  }
  // A variable, a folder change it cannot follow or a URL that is not GitHub's hides the target: null, never a guess.
  const there = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-nm-there-'))).replace(/\\/g, '/');
  for (const cmd of ['gh pr merge 7 -R $REPO --squash', 'gh pr merge 7 -R "$REPO" --squash', 'gh pr merge 7 --repo=$env:R --squash', 'gh pr merge 7 -R $(cat repo.txt)',
    'gh pr -R $REPO merge 7', 'gh pr merge 7 -R', 'GH_REPO=$X gh pr merge 7 --squash', 'GH_REPO="$X" gh pr merge 7', 'GH_REPO=o/repo; gh pr merge 7', 'export GH_REPO=$X; gh pr merge 7',
    '$env:GH_REPO = $X; gh pr merge 7', 'gh pr merge $URL --squash', 'gh pr merge "$URL" --squash', 'gh pr merge https://ghe.example.com/o/repo/pull/7',
    'gh pr merge https://evilgithub.com/o/repo2/pull/7', 'Push-Location $d; gh pr merge 7', 'Pop-Location; gh pr merge 7', 'pushd $d && gh pr merge 7', 'popd; gh pr merge 7',
    'WT=x; cd "$WT" && gh pr merge 7', 'cd $WT && gh pr merge 7', 'cd; gh pr merge 7', 'cd - && gh pr merge 7', 'Set-Location -LiteralPath $d; gh pr merge 7', `cd "${there}" && cd .. && gh pr merge 7`,
    `(cd "${there}" && git fetch); gh pr merge 7`, `bash -c "cd ${there}"; gh pr merge 7`, 'if true; then cd $D; gh pr merge 7; fi', `env --chdir=${there} gh pr merge 7`]) {
    assert.strictEqual(target(cmd), null, `unreadable: ${cmd}`);
  }
  // A folder it can follow decides the target; a git -C, a GH_REPO set to nothing or an echo moves nothing.
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  for (const cmd of [`cd "${there}" && gh pr merge 7`, `Set-Location -LiteralPath "${there}"; gh pr merge 7`, `Push-Location "${there}"; gh pr merge 7`,
    `(cd "${there}" && gh pr merge 7)`, `env -C "${there}" gh pr merge 7`, `pushd "${there}" && gh pr merge 7`]) {
    const to = target(cmd);
    assert.ok(to && to.dir && same(to.dir, there), `${cmd}: ${JSON.stringify(to)}`);
  }
  for (const cmd of [`git -C "${there}" fetch; gh pr merge 7`, 'GH_REPO= gh pr merge 7', 'echo "GH_REPO=o/repo"; gh pr merge 7', 'gh pr merge 7 --squash', 'gh pr merge #7', 'gh pr merge my-branch']) {
    const to = target(cmd);
    assert.ok(to && to.dir && same(to.dir, cwd), `${cmd}: ${JSON.stringify(to)}`);
  }
});

test('pushesDefault is true for a push that writes main in every spelling, false for a feature branch', () => {
  const M = require(path.join(HOOKS, 'coord-land.js'));
  const t = setup();
  for (const cmd of ['git push origin main', 'git push origin HEAD:main', 'git push origin +main', 'git push origin x:refs/heads/main',
    'git --no-pager push origin main', 'git -P push origin main', 'bash -c "git push origin main"', 'if true; then git push origin main; fi',
    'timeout 60 git push origin main', 'git.exe push origin main', 'git push --all origin', `(cd "${t.wtA}" && git push origin main)`]) {
    assert.strictEqual(M.pushesDefault(cmd, t.wtA), true, cmd);
  }
  // --tags alone pushes tags and no branch, even from main
  assert.strictEqual(M.pushesDefault('git push --tags', t.main), false);
  for (const cmd of ['git push', 'git push --follow-tags', 'git push --tags origin main', 'git push --tags --no-tags']) assert.strictEqual(M.pushesDefault(cmd, t.main), true, cmd);
  for (const cmd of ['git push origin a', 'git push -u origin HEAD', 'git push origin main:feature', 'echo "git push origin main"']) {
    assert.strictEqual(M.pushesDefault(cmd, t.wtA), false, cmd);
  }
});

test('the merge lock still holds: one merge at a time, freed once the merge call returns', () => {
  const t = setup();
  t.register(A, t.wtA, 'alice');
  t.register(B, t.wtB, 'bob');
  assert.strictEqual(t.sh(A, t.wtA, 'gh pr merge 5 --squash', OK).decision, 'allow');
  assert.strictEqual(t.registry().locks.merge.session, A);
  const blocked = t.sh(B, t.wtB, 'gh pr merge 6 --squash', OK);
  assert.strictEqual(blocked.decision, 'deny');
  assert.match(blocked.reason, /alice/);
  t.post(A, t.wtA, 'gh pr merge 5 --squash');
  assert.strictEqual(t.registry().locks.merge, undefined);
  assert.strictEqual(t.sh(B, t.wtB, 'gh pr merge 6 --squash', OK).decision, 'allow');
});
