// Tests for guard-deny-catastrophic.js, the hard-deny tier: SQL wipes, force pushes, mass deletes, and nothing goes
// live without its tests.
// Run: node --test system/hooks/tests/guard-deny-catastrophic.test.js
// Drives the hook as Claude Code does: a payload on stdin, the decision off stdout.
'use strict';
const C = require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'guard-deny-catastrophic.js');

function decide(query, toolName = 'mcp__plugin_supabase_supabase__apply_migration') {
  const env = { ...process.env };
  delete env.VIBEQUARTERS_GUARD;
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: toolName, tool_input: { query } }), encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, `guard must always exit 0, got ${r.status}: ${r.stderr}`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
}

test('denies a real TRUNCATE in every form', () => {
  assert.strictEqual(decide('truncate orders;'), 'deny');
  assert.strictEqual(decide('TRUNCATE TABLE public.orders;'), 'deny');
  assert.strictEqual(decide('truncate "orders" cascade;'), 'deny');
  assert.strictEqual(decide('truncate table only public.orders restart identity;'), 'deny');
  assert.strictEqual(decide('truncate on_hold;'), 'deny');
  assert.strictEqual(decide('truncate  public.x, public.y;'), 'deny');
});

test('allows "truncate on", the trigger event and privilege wording', () => {
  assert.strictEqual(decide('create or replace trigger orders_guard\n  before truncate on public.orders\n  for each statement execute function public.orders_guard_fn();'), 'allow');
  assert.strictEqual(decide('revoke update, delete, truncate on table public.orders from service_role;'), 'allow');
  assert.strictEqual(decide('grant truncate on all tables in schema app to admin;'), 'allow');
});

test('a real TRUNCATE still denies when "truncate on" sits beside it', () => {
  assert.strictEqual(decide('revoke truncate on table public.a from anon;\ntruncate public.b;'), 'deny');
});

test('fails open on a malformed payload', () => {
  const r = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual((r.stdout || '').trim(), '');
});

test('a DELETE whose WHERE matches every row is still a wipe', () => {
  assert.strictEqual(decide('delete from orders where true;'), 'deny');
  assert.strictEqual(decide('DELETE FROM orders WHERE 1 = 1;'), 'deny');
  assert.strictEqual(decide('delete from orders where id = 5;'), 'allow');
});

// Inside the hooks folder on purpose: the guard waves through anything under the system temp folder.
const FIX = fs.mkdtempSync(path.join(__dirname, '.fixture-'));
test.after(() => fs.rmSync(FIX, { recursive: true, force: true }));
// PR heads are full shas: the review gate proves a review of exactly that head.
const H7 = '7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';
const H5 = '5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b';
const H6 = '6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c';
// One tested batch (merge-batch.js record): PR 7 at head H7, batch PR 900 at head bh.
const BATCHES = path.join(FIX, 'batches');
fs.mkdirSync(BATCHES);
fs.writeFileSync(path.join(BATCHES, '20300101000000.json'), JSON.stringify({
  id: '20300101000000', repo: 'acme/app', base: 'b0', head: 'bh', batchPr: 900, state: 'opened',
  members: [{ pr: 7, head: H7, title: 'Fix x' }], dropped: [],
}));

// The review home every merge reads unless a test names another: a clean fresh review of each PR head the merge tests
// land, by an Opus reviewer subagent of session SID (review-proof.js). Never the real ~/.claude.
const RF = require('./helpers/review-fixture.js');
const SID = RF.SID;
let homes = 0;
// A fake home holding a clean review of each { repo, pr, head, base } given.
function reviewHome(...reviews) {
  const home = path.join(FIX, `home-${homes++}`);
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  reviews.forEach((r, i) => RF.writeCleanReview(home, { agent: `a00000000000000${String(i).padStart(2, '0')}`, ...r }));
  return home;
}
const REVIEWED = reviewHome(
  { repo: 'app', pr: 7, head: H7 }, { repo: 'app', pr: 5, head: H5 },
  { repo: 'app', pr: 6, head: H6 }, { repo: 'other-repo', pr: 7, head: H7 },
);

// The user home the guard sees, so an ask's hq-ask-mark.js file lands here, never in the real ~/.claude/hq-feed.
const USER_HOME = path.join(FIX, 'user');
fs.mkdirSync(USER_HOME);

function run(command, { cwd = FIX, fake, tool = 'Bash', input, env: extra, sid = SID } = {}) {
  const env = { ...process.env, VIBEQUARTERS_REVIEW_HOME: REVIEWED, USERPROFILE: USER_HOME, HOME: USER_HOME, ...extra };
  delete env.VIBEQUARTERS_GUARD;
  env.VIBEQUARTERS_BATCH_DIR = BATCHES; // the real ~/.claude/coordination/batches never leaks into a test
  if (fake) env.VIBEQUARTERS_GUARD_FAKE_GH = JSON.stringify(fake);
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: tool, cwd, session_id: sid, tool_input: input || { command } }), encoding: 'utf8', env,
  });
  assert.strictEqual(r.status, 0, `guard must always exit 0, got ${r.status}: ${r.stderr}`);
  const out = (r.stdout || '').trim();
  if (!out) return { decision: 'allow', reason: '' };
  const h = JSON.parse(out).hookSpecificOutput;
  return { decision: h.permissionDecision, reason: h.permissionDecisionReason };
}

function fill(dir, n) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
}

const TREE = path.join(FIX, 'tree');
fill(path.join(TREE, 'big'), 11);
fill(path.join(TREE, 'nested', 'a', 'b'), 11);
fill(path.join(TREE, 'small'), 10);
fill(path.join(TREE, 'dist'), 11);
fill(path.join(TREE, 'src'), 2);
fill(path.join(TREE, 'tests'), 2);

test('every spelling of a force push is denied, on any branch', () => {
  for (const cmd of [
    'git push --force origin main', 'git push -f origin main', 'git push -f', 'git push --force',
    'git push --force-with-lease origin main', 'git push --force-with-lease', 'git push --force-with-lease=main:abc origin main',
    'git push --force-if-includes origin x', 'git push --force origin feature/x', 'git push -f origin feature/x',
    'git push origin +main', 'git push origin +HEAD:main', 'git push origin +feature/x', 'git push -fu origin main',
    'git -C /c/x push --force origin main', 'git --no-pager push -f origin x', 'git push --mirror origin',
    'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true',
    'gh api repos/o/r/git/refs/heads/x -F force=true --method PATCH',
  ]) assert.strictEqual(run(cmd).decision, 'deny', cmd);
});

test('deleting a protected branch on the remote is denied', () => {
  for (const cmd of [
    'git push origin --delete main', 'git push --delete origin main', 'git push -d origin main', 'git push origin :main',
    'git push origin :refs/heads/main', 'git push origin --delete release/1.2',
    'gh api -X DELETE repos/o/r/git/refs/heads/main', 'gh repo delete o/r --yes', 'gh api -X DELETE repos/o/r',
  ]) assert.strictEqual(run(cmd).decision, 'deny', cmd);
});

test('negative control: ordinary pushes and reads stay allowed', () => {
  for (const cmd of [
    'git push origin feature/x', 'git push -u origin feature/x', 'git push --follow-tags origin feature/x',
    'git push origin feature/-f', 'git push origin --delete old-branch', 'git push origin :old-branch',
    'gh api repos/o/r/git/refs/heads/main', 'git status', 'npm test',
  ]) assert.strictEqual(run(cmd).decision, 'allow', cmd);
});

test('a recursive delete of more than 10 files is denied in every spelling', () => {
  for (const cmd of [
    'rm -rf big', 'rm -r -f big', 'rm -f -r big', 'rm --recursive --force big', 'rm -R big', 'rm -rf nested',
    `rm -rf "${path.join(TREE, 'big').replace(/\\/g, '/')}"`, 'git rm -r big', 'Remove-Item big -Recurse -Force',
    'Remove-Item -Force -Recurse big', 'Remove-Item -Recurse big', 'Remove-Item -Path big -Recurse', 'ri -r -fo big',
    'cmd /c rd /s /q big', 'rmdir /s /q big', 'del /s /q big', 'rimraf big', 'npx rimraf big', 'bunx rimraf big',
  ]) assert.strictEqual(run(cmd, { cwd: TREE }).decision, 'deny', cmd);
});

test('a project folder is denied by name, whatever its size or spelling', () => {
  for (const cmd of [
    'rm -rf src', 'rm -f -r src', 'rm --recursive --force src', 'rm -rf tests', 'Remove-Item src -Recurse -Force',
    'Remove-Item -Force -Recurse tests', 'git rm -r src', 'rm -rf not-here/supabase', 'rm -rf not-here/migrations',
  ]) assert.strictEqual(run(cmd, { cwd: TREE }).decision, 'deny', cmd);
});

test('a recursive delete whose size cannot be counted is denied', () => {
  for (const cmd of [
    'rm -rf *', 'rm -rf .', 'rm -rf ./', 'rm -rf ..', 'rm -rf ~', 'rm -rf /', 'rm -rf C:/', 'rm -rf "$X"', 'rm -rf $HOME',
    'rm -rf "$(pwd)/x"', 'rm -rf big/*', 'git rm -rf .', 'Remove-Item -Recurse -Force *', 'Remove-Item -Recurse $env:USERPROFILE',
    'cd elsewhere && rm -rf x', '(cd elsewhere && rm -rf x)',
  ]) assert.strictEqual(run(cmd, { cwd: TREE }).decision, 'deny', cmd);
});

test('negative control: everyday commands that only look like a delete stay allowed', () => {
  for (const cmd of [
    'grep -nE "cp|rm|mv" notes.txt', 'grep -nE "force-release|del|erase" notes.txt',
    'gh pr create --title x --body "we del the first one and then we keep all of the others that are left in the list"',
    'Remove-Item -Force $tmpFile', 'Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue', 'rm -f "$TMP_FILE"',
  ]) assert.strictEqual(run(cmd, { cwd: TREE }).decision, 'allow', cmd);
});

test('bulk deletes that hide the count are denied', () => {
  for (const cmd of [
    'find . -type f -delete', 'find big -name "*.txt" -exec rm {} +', 'find . -execdir rm {} ;', 'find . | xargs rm',
    'git ls-files | xargs git rm', 'Get-ChildItem big | Remove-Item', 'gci big -Recurse | ri', 'git clean -fdx', 'git clean -f',
    'git clean --force -d', 'node -e "fs.rmSync(\'big\',{recursive:true})"', 'python -c "import shutil; shutil.rmtree(\'big\')"',
    'git worktree remove --force ../wt', 'git worktree remove ../wt -f', 'supabase projects delete abc', 'vercel remove my-site',
  ]) assert.strictEqual(run(cmd, { cwd: TREE }).decision, 'deny', cmd);
});

test('more than 10 files named or globbed in one delete is denied', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => `f${i}.txt`).join(' ');
  for (const cmd of [`rm -f ${eleven}`, 'rm big/*', 'rm big/*.txt', 'del big/*', 'rm "$X"/*']) {
    assert.strictEqual(run(cmd, { cwd: TREE }).decision, 'deny', cmd);
  }
});

test('negative control: small deletes, build folders and the temp folder stay allowed', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'catastrophic-'));
  fill(temp, 11);
  try {
    const ten = Array.from({ length: 10 }, (_, i) => `f${i}.txt`).join(' ');
    for (const cmd of [
      'rm -rf small', 'rm -rf dist', 'rm -rf node_modules', 'rm -rf .next', 'rm -rf not-here', 'rm one.txt', `rm -f ${ten}`,
      'rm small/*', 'rm "$X/a.txt"', 'rm "${LOOP:?}"/*.md.bak-20300101-000000', 'rmdir small', 'git rm one.txt', 'git clean -n',
      'git clean -fdn', 'git clean --dry-run', 'git worktree remove ../wt', 'npm rm lodash', 'docker run --rm img', 'cmd1 || rm one.txt',
      `rm -rf "${temp.replace(/\\/g, '/')}"`, 'Remove-Item one.txt -Force', 'grep -rn "find . -delete-me" docs', 'git status',
    ]) assert.strictEqual(run(cmd, { cwd: TREE }).decision, 'allow', cmd);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

const PROD = 'https://github.com/acme/app.git';
const CONFIG = 'https://github.com/acme/other-repo.git';
const view = (over) => ({ number: 7, url: 'https://github.com/acme/app/pull/7', baseRefName: 'main', headRefOid: H7, files: [{ path: 'a', changeType: 'MODIFIED' }], ...over });
const noCiView = view({ url: 'https://github.com/acme/other-repo/pull/7' });
const TESTS = { name: 'ci', bucket: 'pass' };
const GREEN = [TESTS, { name: 'smoke', bucket: 'skipping' }, { name: 'Vercel', bucket: 'pass' }];
// --match-head-commit: a merge to main must name the head its review proved.
const MERGE = `gh pr merge 7 --squash --body-file b.md --match-head-commit ${H7}`;
const deleted = (n) => Array.from({ length: n }, (_, i) => ({ path: `f${i}`, changeType: 'DELETED' }));
// The batch side of a green merge: batch PR 900 at the recorded head, its full suite passed, and it contains PR 7.
// mainSubjects: main's commit subjects since the batch base, so PR 7, the first member, is next in line.
// baseCompare: the batch head contains the batch base; vercelJson: main's vercel.json runs the batch ignore step.
const BATCHED = { batchView: { number: 900, headRefOid: 'bh' }, batchChecks: [TESTS], compare: 'ahead', mainSubjects: [],
  baseCompare: 'ahead', vercelJson: { ignoreCommand: 'node scripts/vercel-ignore-build.mjs' } };
// PR 7 is its batch's only member, so it is the last one: its body names the tested head, as plan-land writes it.
fs.writeFileSync(path.join(FIX, 'b.md'), 'Summary.\n\nBatch-Head: bh\n');
// A second batch: PR 5 (first) and PR 6 (last) at batch head bh2 on batch PR 901.
fs.writeFileSync(path.join(BATCHES, '20300101000002.json'), JSON.stringify({
  id: '20300101000002', repo: 'acme/app', base: 'b0', head: 'bh2', batchPr: 901, state: 'landing',
  members: [{ pr: 5, head: H5, title: 'Fix five' }, { pr: 6, head: H6, title: 'Fix six' }], dropped: [],
}));
const view5 = view({ number: 5, url: 'https://github.com/acme/app/pull/5', headRefOid: H5 });
const BATCHED2 = { ...BATCHED, batchView: { number: 901, headRefOid: 'bh2' } };
const body = (name, text) => { fs.writeFileSync(path.join(FIX, name), text); return name; };

test('a non-last batch member lands only with the [batch-part] body file plan-land wrote', () => {
  const merge5 = (rest) => run(`gh pr merge 5 -R acme/app --squash --subject 'Fix five (#5)' --match-head-commit ${H5} ${rest}`, { fake: { view: view5, checks: GREEN, ...BATCHED2 } });
  assert.strictEqual(merge5(`--body-file ${body('part.md', '[batch-part]\n\nSummary.\n')}`).decision, 'allow');
  assert.strictEqual(merge5(`-F ${body('part-crlf.md', '[batch-part]\r\n\r\nSummary.\r\n')}`).decision, 'allow');
  for (const rest of [
    "--body 'Five: plain summary, no marker'", "-b '[batch-part]'", '',
    `--body-file ${body('plain.md', 'Summary.\n')}`, `--body-file ${body('indented.md', '  [batch-part]\n\nSummary.\n')}`,
    `--body-file ${body('later.md', 'Summary.\n\n[batch-part]\n')}`, '--body-file missing.md', '--body-file -',
  ]) {
    const r = merge5(rest);
    assert.strictEqual(r.decision, 'deny', rest);
    assert.match(r.reason, /plan-land/, rest);
  }
});

test("the last batch member lands only with a body naming the tested head, never a [batch-part] one", () => {
  assert.strictEqual(run(MERGE, { fake: { view: view(), checks: GREEN, ...BATCHED } }).decision, 'allow');
  for (const rest of [
    `--body-file ${body('nohead.md', 'Summary.\n')}`, `--body-file ${body('otherhead.md', 'Summary.\n\nBatch-Head: bx\n')}`,
    `--body-file ${body('lastpart.md', '[batch-part]\n\nBatch-Head: bh\n')}`, '',
  ]) {
    const r = run(`gh pr merge 7 --squash ${rest}`, { fake: { view: view(), checks: GREEN, ...BATCHED } });
    assert.strictEqual(r.decision, 'deny', rest);
    assert.match(r.reason, /plan-land/, rest);
  }
});

test("a non-last member is denied while main's vercel.json has no batch ignore step", () => {
  for (const vercelJson of [{ buildCommand: 'bun run build' }, { ignoreCommand: 'exit 1' }, null]) {
    const r = run(`gh pr merge 5 -R acme/app --squash --body-file ${body('part.md', '[batch-part]\n\nSummary.\n')}`,
      { fake: { view: view5, checks: GREEN, ...BATCHED2, vercelJson } });
    assert.strictEqual(r.decision, 'deny', JSON.stringify(vercelJson));
    assert.match(r.reason, /vercel-ignore-build/);
  }
});

test('a batch head built on another base denies the merge', () => {
  for (const baseCompare of ['behind', 'diverged', '']) {
    const r = run(MERGE, { fake: { view: view(), checks: GREEN, ...BATCHED, baseCompare } });
    assert.strictEqual(r.decision, 'deny', baseCompare);
    assert.match(r.reason, /base/);
  }
});

test('GitHub reads that outrun the time budget deny the merge instead of hanging the hook', () => {
  const r = run(MERGE, { env: { VIBEQUARTERS_GUARD_GH_BUDGET_MS: '1' } });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /time budget/);
});

test('a merge to main with its tests green goes through', () => {
  assert.strictEqual(run(MERGE, { fake: { view: view(), checks: GREEN, ...BATCHED } }).decision, 'allow');
  assert.strictEqual(run(`gh pr -R acme/app merge 7 --squash --body-file b.md --match-head-commit=${H7}`, { fake: { view: view(), checks: GREEN, ...BATCHED } }).decision, 'allow');
});

test('a merge to main must name the proven head with --match-head-commit', () => {
  const green = { fake: { view: view(), checks: GREEN, ...BATCHED } };
  const missing = run('gh pr merge 7 --squash --body-file b.md', green);
  assert.strictEqual(missing.decision, 'deny');
  assert.match(missing.reason, new RegExp(`--match-head-commit ${H7}`));
  const wrong = run(`gh pr merge 7 --squash --body-file b.md --match-head-commit ${H5}`, green);
  assert.strictEqual(wrong.decision, 'deny');
  assert.match(wrong.reason, /--match-head-commit/);
  assert.strictEqual(run(`gh pr merge 7 --squash --body-file b.md --match-head-commit=${H5}`, green).decision, 'deny', 'the = form is judged too');
  assert.strictEqual(run(`gh pr merge 7 --squash --body-file b.md --subject "--match-head-commit ${H7}"`, green).decision, 'deny', 'a subject is text');
  assert.strictEqual(run(`gh pr merge 7 --squash --body-file b.md --match-head-commit ${H7}`, green).decision, 'allow');
  assert.strictEqual(run(`gh pr merge 7 --squash --body-file b.md --match-head-commit=${H7.toUpperCase()}`, green).decision, 'allow');
});

test('in a batch repository a PR outside every batch is denied', () => {
  for (const v of [view({ headRefOid: 'moved' }), view({ number: 8, url: 'https://github.com/acme/app/pull/8' })]) {
    const r = run(MERGE, { fake: { view: v, checks: GREEN, ...BATCHED } });
    assert.strictEqual(r.decision, 'deny', JSON.stringify(v));
    assert.match(r.reason, /merge-batch\.js" build/);
  }
});

test("a batch whose own check is not green at the recorded head denies the merge", () => {
  for (const over of [
    { batchChecks: [{ name: 'ci', bucket: 'fail' }] }, { batchChecks: [{ name: 'ci', bucket: 'pending' }] },
    { batchChecks: [] }, { batchChecks: null }, { batchView: { number: 900, headRefOid: 'pushed-later' } }, { batchView: null },
  ]) {
    const r = run(MERGE, { fake: { view: view(), checks: GREEN, ...BATCHED, ...over } });
    assert.strictEqual(r.decision, 'deny', JSON.stringify(over));
    assert.match(r.reason, /batch PR #900/);
  }
});

test('a batch that was tested without this PR head denies the merge', () => {
  for (const compare of ['behind', 'diverged', '']) {
    const r = run(MERGE, { fake: { view: view(), checks: GREEN, ...BATCHED, compare } });
    assert.strictEqual(r.decision, 'deny', compare);
    assert.match(r.reason, /does not contain/);
  }
});

test('a member is denied once main holds any commit besides the earlier members', () => {
  // an outside PR landed, the member already landed, or main could not be read: the tested tree is not what lands
  for (const mainSubjects of [['Other fix (#99)'], ['Fix x (#7)'], null]) {
    const r = run(MERGE, { fake: { view: view(), checks: GREEN, ...BATCHED, mainSubjects } });
    assert.strictEqual(r.decision, 'deny', JSON.stringify(mainSubjects));
    assert.match(r.reason, /main/);
  }
});

test('a batch record it cannot read through denies the merge instead of letting it pass', () => {
  fs.writeFileSync(path.join(BATCHES, '20300101000001.json'), JSON.stringify({
    id: '20300101000001', repo: 'acme/app', base: 'b0', batchPr: 900, state: 'opened',
    members: [{ pr: 7, head: 'h7m', title: 'Fix x' }], dropped: [],
  }));
  const r = run(MERGE, { fake: { view: view({ headRefOid: 'h7m' }), checks: GREEN, ...BATCHED } });
  assert.strictEqual(r.decision, 'deny');
});

test('a member lands when both its check and its batch are green', () => {
  for (const compare of ['ahead', 'identical']) {
    assert.strictEqual(run(MERGE, { fake: { view: view(), checks: GREEN, ...BATCHED, compare } }).decision, 'allow', compare);
  }
  // Its own check still counts: a green batch never covers a red PR.
  assert.strictEqual(run(MERGE, { fake: { view: view(), checks: [{ name: 'ci', bucket: 'fail' }], ...BATCHED } }).decision, 'deny');
});

test("a repository without batches is judged on its own checks", () => {
  assert.strictEqual(run(MERGE, { fake: { view: noCiView, checks: [{ name: 'node tests', bucket: 'pass' }] } }).decision, 'allow');
});

test('a merge to main is denied when any check failed, was canceled or is still running', () => {
  const failed = run(MERGE, { fake: { view: view(), checks: [...GREEN, { name: 'style-check', bucket: 'fail' }] } });
  assert.strictEqual(failed.decision, 'deny');
  assert.match(failed.reason, /style-check/);
  const canceled = run(MERGE, { fake: { view: view(), checks: [...GREEN, { name: 'Build', bucket: 'cancel' }] } });
  assert.strictEqual(canceled.decision, 'deny');
  assert.match(canceled.reason, /Build/);
  const running = run(MERGE, { fake: { view: view(), checks: [...GREEN, { name: 'Vercel Preview', bucket: 'pending' }] } });
  assert.strictEqual(running.decision, 'deny');
  assert.match(running.reason, /still running.*Vercel Preview/);
});

test('every spelling of a merge is judged, in any position', () => {
  const red = { view: view(), checks: [{ name: 'ci', bucket: 'fail' }] };
  for (const cmd of ['gh pr -R acme/app merge 7', 'gh pr --repo=acme/app merge 7', 'git status; gh pr merge 7', '(gh pr merge 7)', 'FOO=1 gh pr merge 7']) {
    assert.strictEqual(run(cmd, { fake: red }).decision, 'deny', cmd);
  }
});

test('the normal placements of a merge are judged, and --admin and --auto are denied in each', () => {
  const red = { view: view(), checks: [{ name: 'ci', bucket: 'fail' }] };
  const green = { view: view(), checks: GREEN };
  for (const cmd of ['gh -R acme/app pr merge 7', 'gh --repo=acme/app pr merge 7', 'gh pr -Racme/app merge 7',
    'gh pr -R "acme/app" merge 7', 'gh pr --repo "acme/app" merge 7', '"gh" pr merge 7', '"C:/Program Files/GitHub CLI/gh.exe" pr merge 7']) {
    assert.strictEqual(run(cmd, { fake: red }).decision, 'deny', cmd);
    assert.strictEqual(run(`${cmd} --admin`, { fake: green }).decision, 'deny', `${cmd} --admin`);
    assert.strictEqual(run(`${cmd} --auto`, { fake: green }).decision, 'deny', `${cmd} --auto`);
  }
});

test('a --admin or a URL inside a merge body is text, and the batch gate reads the repository the merge names', () => {
  const green = { view: view(), checks: GREEN, ...BATCHED };
  const text = `gh pr merge 7 --squash --body-file b.md --match-head-commit ${H7} --subject "mention --admin and --auto here"`;
  assert.strictEqual(run(text, { fake: green }).decision, 'allow');
  assert.strictEqual(run(`gh pr merge 7 --squash --body-file b.md --match-head-commit ${H7} -st "x --admin"`, { fake: green }).decision, 'allow');
  assert.strictEqual(run(`gh pr merge 7 --squash --body-file b.md --match-head-commit ${H7} --subject "a \\" --admin \\" b"`, { fake: green }).decision, 'allow', 'escaped quotes keep it one subject');
  for (const cmd of ['gh pr merge 7 --squash --admin # note', 'gh pr merge -sb "x" 7 --auto']) {
    assert.strictEqual(run(cmd, { fake: green }).decision, 'deny', cmd);
  }
  // PR 5 is a batch member only in acme/app; a body naming another repo or a heredoc is not the target
  const heredoc = "gh pr merge 5 -R acme/app --squash --subject 'Fix five (#5)' --body \"$(cat <<'EOF'\n[batch-part]\n-R o/other\nEOF\n)\"";
  const r = run(heredoc, { fake: { view: view5, checks: GREEN, ...BATCHED2 } });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /plan-land/);
});

test('a required check must have passed; nothing failing is not enough', () => {
  for (const checks of [[], [{ name: 'Vercel', bucket: 'pass' }], [{ name: 'ci', bucket: 'skipping' }]]) {
    const r = run(MERGE, { fake: { view: view(), checks } });
    assert.strictEqual(r.decision, 'deny', JSON.stringify(checks));
    assert.match(r.reason, /\bci\b/);
  }
});

test('a merge is denied when GitHub cannot say whether the tests passed', () => {
  const noChecks = run(MERGE, { fake: { view: view(), checks: null } });
  assert.strictEqual(noChecks.decision, 'deny');
  assert.match(noChecks.reason, /could not read/);
  const noView = run(MERGE, { fake: { view: null, checks: GREEN } });
  assert.strictEqual(noView.decision, 'deny');
  assert.match(noView.reason, /could not read/);
});

test('--admin, --auto and a merge through the GitHub API are denied even when green', () => {
  for (const cmd of ['gh pr merge 7 --squash --admin', 'gh pr merge 7 --auto --squash', 'gh api -X PUT repos/o/r/pulls/7/merge', 'gh api repos/o/r/merges -f base=main -f head=x']) {
    assert.strictEqual(run(cmd, { fake: { view: view(), checks: GREEN } }).decision, 'deny', cmd);
  }
});

test('a repo with no tests on GitHub asks the user before a merge', () => {
  for (const checks of [[], [{ name: 'Vercel', bucket: 'pass' }]]) {
    const r = run(MERGE, { fake: { view: noCiView, checks } });
    assert.strictEqual(r.decision, 'ask', JSON.stringify(checks));
    assert.match(r.reason, /no tests/i);
  }
  assert.strictEqual(run(MERGE, { fake: { view: noCiView, checks: [{ name: 'node tests', bucket: 'pass' }] } }).decision, 'allow');
  assert.strictEqual(run(MERGE, { fake: { view: noCiView, checks: [{ name: 'node tests', bucket: 'fail' }] } }).decision, 'deny');
});

test('mergeGate.requireReview false drops only the review: red CI and --admin are still denied', () => {
  const env = { VIBEQUARTERS_CONFIG: C.write({ mergeGate: { requireReview: false } }), VIBEQUARTERS_REVIEW_HOME: reviewHome() };
  const green = [{ name: 'node tests', bucket: 'pass' }];
  assert.strictEqual(run(MERGE, { fake: { view: noCiView, checks: green }, env: { VIBEQUARTERS_REVIEW_HOME: reviewHome() } }).decision, 'deny', 'negative control: the review is on by default');
  assert.strictEqual(run(MERGE, { fake: { view: noCiView, checks: green }, env }).decision, 'allow');
  assert.strictEqual(run(MERGE, { fake: { view: noCiView, checks: [{ name: 'node tests', bucket: 'fail' }] }, env }).decision, 'deny');
  assert.strictEqual(run('gh pr merge 7 --admin', { fake: { view: noCiView, checks: green }, env }).decision, 'deny');
});

test('a batch repo with no named check needs every check of its batch PR', () => {
  const env = { VIBEQUARTERS_CONFIG: C.write({ mergeGate: { requiredChecks: { 'acme/app': [] } } }) };
  const none = run(MERGE, { fake: { view: view(), checks: GREEN, ...BATCHED, batchChecks: [] }, env });
  assert.strictEqual(none.decision, 'deny');
  assert.match(none.reason, /no passing full suite/);
  assert.strictEqual(run(MERGE, { fake: { view: view(), checks: GREEN, ...BATCHED }, env }).decision, 'allow');
});

test('the required checks of a repo not listed in the config come from its branch protection', () => {
  const fake = { view: noCiView, protection: ['build'] };
  const missing = run(MERGE, { fake: { ...fake, checks: [{ name: 'node tests', bucket: 'pass' }] } });
  assert.strictEqual(missing.decision, 'deny');
  assert.match(missing.reason, /no passing "build" check/);
  assert.strictEqual(run(MERGE, { fake: { ...fake, checks: [{ name: 'build', bucket: 'pass' }] } }).decision, 'allow');
});

test('a PR that deletes more than 10 files asks the user, however green', () => {
  const r = run(MERGE, { fake: { view: view({ files: deleted(11) }), checks: GREEN, ...BATCHED } });
  assert.strictEqual(r.decision, 'ask');
  assert.match(r.reason, /11 files/);
  assert.strictEqual(run(MERGE, { fake: { view: view({ files: deleted(10) }), checks: GREEN, ...BATCHED } }).decision, 'allow');
});

test('negative control: a merge into a release branch does not go live, so it is not judged', () => {
  const red = { view: view({ baseRefName: 'release/1.2' }), checks: [{ name: 'x', bucket: 'fail' }] };
  assert.strictEqual(run(MERGE, { fake: red }).decision, 'allow');
});

test('the default branch of the repository is live whatever its name, unless liveBranches is set', () => {
  const develop = { view: view({ baseRefName: 'develop' }), checks: [{ name: 'x', bucket: 'fail' }] };
  assert.strictEqual(run(MERGE, { fake: { ...develop, defaultBranch: 'develop' } }).decision, 'deny');
  assert.match(run(MERGE, { fake: { ...develop, defaultBranch: 'develop' } }).reason, /did not pass/);
  assert.strictEqual(run(MERGE, { fake: { ...develop, defaultBranch: 'main' } }).decision, 'allow', 'control: not the default branch');
  const unread = run(MERGE, { fake: { ...develop, defaultBranch: null } });
  assert.strictEqual(unread.decision, 'deny');
  assert.match(unread.reason, /could not read the default branch/);
  const env = { VIBEQUARTERS_CONFIG: C.write({ mergeGate: { liveBranches: ['trunk'] } }) };
  assert.strictEqual(run(MERGE, { fake: { ...develop, defaultBranch: 'develop' }, env }).decision, 'allow', 'the list you set is the whole list');
});

const GREEN7 = { view: view(), checks: GREEN, ...BATCHED };
const short = (h) => h.slice(0, 9);

test('an unreviewed merge to main is denied', () => {
  const r = run(MERGE, { fake: GREEN7, env: { VIBEQUARTERS_REVIEW_HOME: reviewHome() } });
  assert.strictEqual(r.decision, 'deny');
  assert.ok(r.reason.includes(`PR #7 at ${short(H7)} has no clean fresh review: no review for head ${short(H7)}; delta review it. See section 2 of /land, then merge.`), r.reason);
});

test('a merge to main with a clean review of its head is allowed', () => {
  const home = reviewHome({ repo: 'app', pr: 7, head: H7 });
  assert.strictEqual(run(MERGE, { fake: GREEN7, env: { VIBEQUARTERS_REVIEW_HOME: home } }).decision, 'allow');
});

test('a review of an earlier head is not enough, and the deny names a delta review', () => {
  const home = reviewHome({ repo: 'app', pr: 7, head: H5 });
  const r = run(MERGE, { fake: GREEN7, env: { VIBEQUARTERS_REVIEW_HOME: home } });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /no clean fresh review: .*delta/);
});

test('every batch member needs a review of its own head', () => {
  const home5 = reviewHome({ repo: 'app', pr: 5, head: H5 });
  const merge5 = `gh pr merge 5 -R acme/app --squash --subject 'Fix five (#5)' --body-file ${body('part.md', '[batch-part]\n\nSummary.\n')} --match-head-commit ${H5}`;
  assert.strictEqual(run(merge5, { fake: { view: view5, checks: GREEN, ...BATCHED2 }, env: { VIBEQUARTERS_REVIEW_HOME: home5 } }).decision, 'allow');
  // PR 5 landed, so PR 6 is next and last: its own head needs its own review, PR 5's does not cover it
  const view6 = view({ number: 6, url: 'https://github.com/acme/app/pull/6', headRefOid: H6 });
  const merge6 = `gh pr merge 6 -R acme/app --squash --subject 'Fix six (#6)' --body-file ${body('last6.md', 'Summary.\n\nBatch-Head: bh2\n')} --match-head-commit ${H6}`;
  const fake6 = { view: view6, checks: GREEN, ...BATCHED2, mainSubjects: ['Fix five (#5)'] };
  const r = run(merge6, { fake: fake6, env: { VIBEQUARTERS_REVIEW_HOME: home5 } });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, new RegExp(`PR #6 at ${short(H6)} has no clean fresh review`));
  assert.strictEqual(run(merge6, { fake: fake6 }).decision, 'allow', 'with its own review');
});

test('a merge into a non-default branch needs no review', () => {
  const fake = { view: view({ baseRefName: 'release/x' }), checks: GREEN, ...BATCHED };
  assert.strictEqual(run(MERGE, { fake, env: { VIBEQUARTERS_REVIEW_HOME: reviewHome() } }).decision, 'allow');
});

test('a repo with no tests asks the user only once the review is proven; a missing review denies first', () => {
  const none = { view: noCiView, checks: [] };
  const r = run(MERGE, { fake: none, env: { VIBEQUARTERS_REVIEW_HOME: reviewHome() } });
  assert.strictEqual(r.decision, 'deny');
  assert.ok(r.reason.includes(`PR #7 at ${short(H7)} has no clean fresh review: no review for head ${short(H7)}; delta review it. See section 2 of /land, then merge.`), r.reason);
  const asked = run(MERGE, { fake: none });
  assert.strictEqual(asked.decision, 'ask');
  assert.match(asked.reason, /no tests ran/);
  assert.ok(fs.readdirSync(path.join(USER_HOME, '.claude', 'hq-feed', 'hook-asks')).length > 0, 'the ask mark lands in the test home');
});

test("the review must come from the merging session's own reviewer", () => {
  const r = run(MERGE, { fake: GREEN7, sid: '11111111-2222-4333-8444-555555555555' });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /not a subagent of session 11111111/);
  assert.strictEqual(run(MERGE, { fake: GREEN7, sid: '' }).decision, 'deny', 'no session id proves nothing');
});

test("the reviewer's base is the PR's base on GitHub", () => {
  const master = { view: { ...noCiView, baseRefName: 'master' }, checks: [{ name: 'node tests', bucket: 'pass' }] };
  const r = run(MERGE, { fake: master }); // REVIEWED briefed its other-repo reviewer against origin/main
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /against origin\/master/);
  const home = reviewHome({ repo: 'other-repo', pr: 7, head: H7, base: 'origin/master' });
  assert.strictEqual(run(MERGE, { fake: master, env: { VIBEQUARTERS_REVIEW_HOME: home } }).decision, 'allow');
});

// Reviewer records are write-protected: a tab that could write them could forge the review the merge gate proves.
const PROJECTS = path.join(REVIEWED, '.claude', 'projects');
const SUB = path.join(PROJECTS, 'C--Users-dev-wt-x', SID, 'subagents');
const REC = path.join(SUB, 'agent-a0000000000000000.jsonl');
const fwd = (p) => p.replace(/\\/g, '/');
const bashPath = (p) => (process.platform !== 'win32' ? fwd(p) : fwd(p).replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`)); // /c/x is Git Bash's
const MEMORY = path.join(PROJECTS, 'C--Users-dev-wt-x', 'memory', 'note.md');

test('Write, Edit, MultiEdit and NotebookEdit into a subagents folder are denied', () => {
  const NEW = path.join(PROJECTS, 'C--forged-key', SID, 'subagents', 'agent-forged.meta.json');
  for (const [tool, input] of [
    ['Write', { file_path: REC, content: 'x' }], ['Write', { file_path: NEW, content: '{}' }],
    ['Write', { file_path: path.join(SUB, '..', 'subagents', 'agent-x.jsonl'), content: 'x' }],
    ['Write', { file_path: fwd(REC), content: 'x' }],
    ['Edit', { file_path: REC, old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: REC, edits: [{ old_string: 'a', new_string: 'b' }] }],
    ['NotebookEdit', { notebook_path: path.join(SUB, 'x.ipynb'), new_source: 'x' }],
    ...(process.platform === 'win32' ? [['Write', { file_path: REC.toUpperCase(), content: 'x' }]] : []),
  ]) {
    const r = run('', { tool, input });
    assert.strictEqual(r.decision, 'deny', `${tool} ${JSON.stringify(input)}`);
    assert.match(r.reason, /reviewer/);
  }
});

test('a shell write into a subagents folder is denied', () => {
  for (const [tool, command] of [
    ['Bash', `echo x > "${fwd(REC)}"`], ['Bash', `echo x >> ${bashPath(REC)}`], ['Bash', `cp /tmp/a.jsonl "${fwd(REC)}"`],
    ['Bash', `sed -i 's/a/b/' "${fwd(REC)}"`], ['Bash', `echo x | tee "${fwd(REC)}"`], ['Bash', `rm "${fwd(REC)}"`],
    ['Bash', `cd "${fwd(SUB)}" && touch agent-y.jsonl`],
    ['PowerShell', `Set-Content -Path "${REC}" -Value x`], ['PowerShell', `"x" | Out-File -FilePath "${REC}"`],
    ['PowerShell', `Add-Content "${REC}" x`], ['PowerShell', `Copy-Item a.jsonl -Destination "${SUB}"`],
  ]) {
    const r = run(command, { tool });
    assert.strictEqual(r.decision, 'deny', command);
    assert.match(r.reason, /reviewer/, command);
  }
});

const KEY = path.join(PROJECTS, 'C--Users-dev-wt-x');
const UUID = '22222222-3333-4444-8555-666666666666';
fs.mkdirSync(path.join(KEY, 'memory'), { recursive: true });

test('a shell command cannot carry a forged session folder into projects', () => {
  for (const [tool, command] of [
    ['Bash', `mv /tmp/f/${SID} "${fwd(PROJECTS)}/C--forged-key/"`], ['Bash', `cp -r /tmp/f "${fwd(PROJECTS)}/C--forged-key"`],
    ['Bash', `ln -s /tmp/f "${fwd(PROJECTS)}/C--forged-key"`], ['Bash', `cp -r f "${fwd(KEY)}/${UUID}"`],
    ['Bash', `mv /tmp/f "${fwd(KEY)}/${UUID.toUpperCase()}"`],
    ['PowerShell', `New-Item -ItemType Junction -Path "${path.join(KEY, UUID)}" -Target C:/tmp/f`],
    ['PowerShell', `New-Item -ItemType SymbolicLink -Path "${path.join(PROJECTS, 'C--forged-key')}" -Target C:/tmp/f`],
    ['PowerShell', `New-Item -ItemType Directory -Path "${path.join(KEY, UUID)}"`],
  ]) assert.strictEqual(run(command, { tool }).decision, 'deny', command);
  // a command run from inside a session folder is judged as writing there
  assert.strictEqual(run('mv a b', { cwd: path.join(KEY, SID) }).decision, 'deny', 'mv inside a session folder');
});

test('negative control: ordinary file work in a key folder is not a forged session folder', () => {
  const mem = fwd(path.join(KEY, 'memory'));
  for (const [tool, command, cwd] of [
    ['Bash', `cp note.md "${mem}/"`], ['Bash', `cp note.md "${mem}"`],
    ['PowerShell', `Copy-Item note.md -Destination "${path.join(KEY, 'memory')}"`],
    ['PowerShell', `New-Item -ItemType Directory -Path "${path.join(KEY, 'memory')}"`],
    ['PowerShell', `New-Item -ItemType Directory -Path "${path.join(PROJECTS, 'C--new-key')}"`],
    ['Bash', 'mv memory/a.md memory/b.md', KEY], ['Bash', `cd "${fwd(KEY)}" && mv memory/a.md memory/b.md`],
  ]) assert.strictEqual(run(command, { tool, cwd }).decision, 'allow', command);
});

test('a rename cannot turn a planted folder into a session folder', () => {
  // step 1, a folder copied in under a plain name, passes; step 2 renames it to a session id. PowerShell resolves
  // -NewName against the item's parent, not the cwd, so it is judged by the source and the new name together.
  assert.strictEqual(run(`cp -r /tmp/foo "${fwd(KEY)}/foo"`).decision, 'allow', 'step 1');
  for (const command of [
    `Rename-Item -Path "${path.join(KEY, 'foo')}" -NewName ${UUID}`, `rni "${path.join(KEY, 'foo')}" ${UUID.toUpperCase()}`,
    `Rename-Item "${path.join(KEY, 'foo')}" "${path.join(KEY, UUID)}"`, `ren "${path.join(KEY, 'foo')}" ${UUID}`,
    `Rename-Item -Path "${path.join(KEY, 'foo')}" -NewName:${UUID}`, `Rename-Item -Path "${path.join(KEY, 'foo')}" -NewName:"${UUID}"`,
  ]) {
    const r = run(command, { tool: 'PowerShell' });
    assert.strictEqual(r.decision, 'deny', command);
    assert.match(r.reason, /reviewer/, command);
  }
  assert.strictEqual(run(`Rename-Item foo -NewName:${UUID}`, { tool: 'PowerShell', cwd: KEY }).decision, 'deny', 'cwd form');
  for (const command of [
    `Rename-Item -Path "${path.join(KEY, 'memory', 'a.md')}" -NewName b.md`, `ren "${path.join(KEY, 'memory', 'a.md')}" b.md`,
    `Rename-Item -Path "${path.join(KEY, 'memory', 'a.md')}" -NewName:b.md`,
  ]) assert.strictEqual(run(command, { tool: 'PowerShell' }).decision, 'allow', command);
});

test('New-Item at projects or key depth makes only a file or a folder, never a link', () => {
  const forged = path.join(PROJECTS, 'C--forged-key');
  for (const flag of ['-ItemType:Junction', '-ItemType j', '-Type SymbolicLink', '-itemtype:HARDLINK', '-It Junction', '-ItemType $t']) {
    for (const cmd of ['New-Item', 'ni']) {
      const command = `${cmd} ${flag} -Path "${forged}" -Target C:/tmp/f`;
      assert.strictEqual(run(command, { tool: 'PowerShell' }).decision, 'deny', command);
    }
  }
  for (const flag of ['-ItemType Directory', '-ItemType:dir', '-ItemType File', '-Type d', '', '-ItemType:"Directory"', "-ItemType:'File'"]) {
    const command = `New-Item ${flag} -Path "${forged}"`;
    assert.strictEqual(run(command, { tool: 'PowerShell' }).decision, 'allow', command);
  }
});

test('negative control: reading reviewer records, and writing elsewhere under projects, stay allowed', () => {
  assert.strictEqual(run('', { tool: 'Read', input: { file_path: REC } }).decision, 'allow');
  assert.strictEqual(run('', { tool: 'Write', input: { file_path: MEMORY, content: 'x' } }).decision, 'allow');
  assert.strictEqual(run('', { tool: 'Edit', input: { file_path: MEMORY, old_string: 'a', new_string: 'b' } }).decision, 'allow');
  for (const [tool, command] of [
    ['Bash', `cat "${fwd(REC)}"`], ['Bash', `grep VERDICT "${fwd(REC)}"`], ['Bash', `ls "${fwd(SUB)}"`],
    ['Bash', `echo x > "${fwd(MEMORY)}"`], ['Bash', `cp a.md "${fwd(MEMORY)}"`],
    ['Bash', `mkdir -p "${fwd(path.dirname(MEMORY))}"`], ['PowerShell', `Get-Content "${REC}"`],
  ]) assert.strictEqual(run(command, { tool }).decision, 'allow', command);
});

test('negative control: text that only mentions a merge reads nothing from GitHub', () => {
  const red = { view: view(), checks: [{ name: 'x', bucket: 'fail' }] };
  for (const cmd of ['git commit -m "run gh pr merge 7 later"', 'grep -rn "gh pr merge" docs']) {
    assert.strictEqual(run(cmd, { fake: red }).decision, 'allow', cmd);
  }
});

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const CONFIG_SLUG = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(CONFIG)[1];
let repos = 0;
function repo(url, { functions = false } = {}) {
  const dir = path.join(FIX, `repo-${repos++}`);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  if (functions) fill(path.join(dir, 'supabase', 'functions', 'fn'), 1);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'first');
  git(dir, 'remote', 'add', 'origin', url);
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}
const ahead = (dir) => {
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'second');
};

test('a direct push to main skips the tests: denied in a repository with required checks, asked elsewhere, feature pushes pass', () => {
  const prod = repo(PROD);
  for (const cmd of ['git push origin main', 'git push origin HEAD:main', 'git push', 'git --no-pager push origin main', `git -C "${prod.replace(/\\/g, '/')}" push origin main`]) {
    assert.strictEqual(run(cmd, { cwd: prod }).decision, 'deny', cmd);
  }
  assert.strictEqual(run('git push origin feature/x', { cwd: prod }).decision, 'allow');
  const config = repo(CONFIG);
  const asked = run('git push origin main', { cwd: config, fake: { protection: [] } });
  assert.strictEqual(asked.decision, 'ask');
  assert.match(asked.reason, /skips the review gate/, 'a direct push lands with no fresh review');
  assert.strictEqual(run('git push origin feature/x', { cwd: config }).decision, 'allow');
  const local = repo('C:/somewhere/else.git');
  assert.strictEqual(run('git push origin main', { cwd: local }).decision, 'allow');
});

test('when GitHub cannot say which checks a branch requires, a push, a deploy and a merge are denied', () => {
  const config = repo(CONFIG);
  const gone = { protection: null }; // the read failed
  const merge = run(MERGE, { fake: { view: noCiView, checks: [{ name: 'node tests', bucket: 'pass' }], ...gone } });
  for (const r of [run('git push origin main', { cwd: config, fake: gone }), run('vercel --prod', { cwd: config, fake: gone }), merge]) {
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.match(r.reason, /could not read which checks/);
    assert.match(r.reason, /gh auth login/);
    assert.match(r.reason, /mergeGate\.requiredChecks/);
  }
  // with the real gh, which reaches nothing: no fake and no network
  const out = { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' };
  assert.strictEqual(run('git push origin main', { cwd: config, env: out }).decision, 'deny');
  // the settings that answer without GitHub
  for (const mergeGate of [{ requiredChecks: { [CONFIG_SLUG]: [] } }, { readBranchProtection: false }]) {
    const env = { ...out, VIBEQUARTERS_CONFIG: C.write({ mergeGate }) };
    assert.strictEqual(run('git push origin main', { cwd: config, env }).decision, 'ask', JSON.stringify(mergeGate));
  }
});

test('a production deploy of what main already holds goes through', () => {
  const prod = repo(PROD, { functions: true });
  for (const cmd of ['vercel --prod', 'vercel deploy --prod --yes', 'vercel deploy --target production', 'vercel deploy --target=production', 'supabase functions deploy fn']) {
    assert.strictEqual(run(cmd, { cwd: prod }).decision, 'allow', cmd);
  }
});

test('a production deploy of uncommitted code is denied', () => {
  const prod = repo(PROD, { functions: true });
  fs.writeFileSync(path.join(prod, 'a.txt'), 'changed\n');
  const r = run('vercel --prod', { cwd: prod });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /uncommitted/);
  assert.strictEqual(run('supabase functions deploy fn', { cwd: prod }).decision, 'deny');
  const edge = repo(PROD, { functions: true });
  fill(path.join(edge, 'supabase', 'functions', 'new-fn'), 1);
  assert.strictEqual(run('supabase functions deploy new-fn', { cwd: edge }).decision, 'deny', 'an untracked function');
  assert.strictEqual(run('vercel --prod', { cwd: edge }).decision, 'allow', 'an untracked function is not in a Vercel build of tracked work');
});

test('a production deploy of a commit not on main needs that commit\'s test check green', () => {
  const prod = repo(PROD, { functions: true });
  ahead(prod);
  for (const cmd of ['vercel --prod', 'supabase functions deploy fn']) {
    assert.strictEqual(run(cmd, { cwd: prod, fake: { commit: 'success' } }).decision, 'allow', cmd);
    for (const commit of ['failure', 'cancelled', '', null]) {
      const r = run(cmd, { cwd: prod, fake: { commit } });
      assert.strictEqual(r.decision, 'deny', `${cmd} ${commit}`);
      assert.match(r.reason, /\bci\b/);
    }
  }
});

test('a production deploy of a [batch-part] commit on main needs that commit\'s own test check green', () => {
  // a batch member before the last lands on main, but only the whole batch's tree was tested
  const prod = repo(PROD, { functions: true });
  fs.writeFileSync(path.join(prod, 'b.txt'), 'b\n');
  git(prod, 'add', '.');
  git(prod, 'commit', '-qm', 'Fix x (#5)', '-m', '[batch-part]');
  git(prod, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  for (const cmd of ['vercel --prod', 'supabase functions deploy fn']) {
    for (const commit of ['failure', null]) {
      const r = run(cmd, { cwd: prod, fake: { commit } });
      assert.strictEqual(r.decision, 'deny', `${cmd} ${commit}`);
      assert.match(r.reason, /\bci\b/);
    }
    assert.strictEqual(run(cmd, { cwd: prod, fake: { commit: 'success' } }).decision, 'allow', cmd);
  }
});

test('a main commit whose body mentions [batch-part] on a later line deploys like any main commit, as Vercel builds it', () => {
  const prod = repo(PROD, { functions: true });
  fs.writeFileSync(path.join(prod, 'b.txt'), 'b\n');
  git(prod, 'add', '.');
  git(prod, 'commit', '-qm', 'Fix x (#5)', '-m', 'Summary.', '-m', '[batch-part]');
  git(prod, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.strictEqual(run('vercel --prod', { cwd: prod, fake: { commit: null } }).decision, 'allow');
});

test('a production deploy outside a repo is denied, and one from a repo with no tests asks', () => {
  assert.strictEqual(run('vercel --prod', { cwd: os.tmpdir() }).decision, 'deny');
  const config = repo(CONFIG);
  assert.strictEqual(run('vercel --prod', { cwd: config, fake: { protection: [] } }).decision, 'ask');
});

test('negative control: a preview deploy and an edge function test run are not judged', () => {
  for (const cmd of ['vercel deploy', 'vercel --target preview', 'supabase functions list']) {
    assert.strictEqual(run(cmd, { cwd: FIX }).decision, 'allow', cmd);
  }
});

test('promoting a preview to production is denied in every route', () => {
  assert.strictEqual(run('vercel promote https://x.vercel.app').decision, 'deny');
  assert.strictEqual(run('', { tool: 'mcp__plugin_vercel_vercel__request_promote', input: { projectId: 'p', deploymentId: 'd' } }).decision, 'deny');
});

test('the Vercel tool cannot make a production deployment', () => {
  const tool = 'mcp__plugin_vercel_vercel__create_deployment';
  for (const requestBody of [{ name: 'x', target: 'production' }, { name: 'x', gitSource: { type: 'github', ref: 'main', repoId: 1 } }]) {
    assert.strictEqual(run('', { tool, input: { requestBody } }).decision, 'deny', JSON.stringify(requestBody));
  }
  assert.strictEqual(run('', { tool, input: { requestBody: { name: 'x', gitSource: { type: 'github', ref: 'feature/x', repoId: 1 } } } }).decision, 'allow');
  assert.strictEqual(run('', { tool: 'mcp__plugin_vercel_vercel__list_deployments', input: { projectId: 'p' } }).decision, 'allow');
  assert.strictEqual(run('', { tool: 'mcp__plugin_vercel_vercel__request_rollback', input: { projectId: 'p', deploymentId: 'd' } }).decision, 'allow');
});

test('the edge deploy tool follows the same rule as the shell', () => {
  const tool = 'mcp__plugin_supabase_supabase__deploy_edge_function';
  const input = { project_id: 'p', name: 'fn', files: [{ name: 'index.ts', content: '@disk' }] };
  const prod = repo(PROD, { functions: true });
  assert.strictEqual(run('', { cwd: prod, tool, input }).decision, 'allow');
  ahead(prod);
  assert.strictEqual(run('', { cwd: prod, tool, input, fake: { commit: 'failure' } }).decision, 'deny');
  assert.strictEqual(run('', { cwd: prod, tool, input, fake: { commit: 'success' } }).decision, 'allow');
  assert.strictEqual(run('', { cwd: os.tmpdir(), tool, input }).decision, 'deny');
});

const ALLOWED = (cmds, opts) => { for (const cmd of cmds) assert.strictEqual(run(cmd, opts).decision, 'allow', cmd); };
const DENIED = (cmds, opts) => { for (const cmd of cmds) assert.strictEqual(run(cmd, opts).decision, 'deny', cmd); };

test('a force push is denied however the command ends', () => {
  DENIED([
    'git push origin main -f; echo ok', '(git push origin main --force)', 'git push origin feat/x -f; echo ok',
    'git push origin feat/x --force-with-lease; echo ok', 'git push origin x -f && echo ok', 'git push --mirror origin; echo ok',
    'git.exe push -f origin x', 'bash -c "git push -f origin x"',
  ]);
});

test('negative control: a push that only looks forced or aimed at main stays allowed', () => {
  ALLOWED([
    'git stash push -u -m "wip +tests"', 'git push origin --delete feat/main-page', 'git push origin --delete bots/release-bot',
    'git push origin :feat/main-page', 'git push origin --delete release-notes',
  ]);
});

test('a delete is judged on the folder it names, not on a word in it or on the next line', () => {
  fill(path.join(TREE, 'test-results'), 11);
  ALLOWED([
    'rm -rf test-results', 'rm -rf dist\nbun run test', 'Remove-Item -Recurse -Force test-results', 'rm -rf scripts-old',
    'rm -rf src/one/small-dir', 'rm -rf dist\ngit status',
  ], { cwd: TREE });
  DENIED(['rm -rf dist\nrm -rf src', 'rm -rf "src"', 'rm -rf ./tests/', 'Remove-Item -Recurse -Force "docs"', 'rm -rf .git'], { cwd: TREE });
});

test('text that only mentions a deploy is not judged as one, and every test deny names the way out', () => {
  ALLOWED(['grep -n "vercel --prod" AGENTS.md', 'git commit -m "note: supabase functions deploy needs a yes"'], { cwd: os.tmpdir() });
  const r = run('vercel --prod', { cwd: os.tmpdir() });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /put that text in a file/);
  assert.strictEqual(run('bash -c "vercel --prod"', { cwd: os.tmpdir() }).decision, 'deny');
});

test('a merge is judged inside a loop, a condition, a wrapper or a shell string', () => {
  const red = { view: view(), checks: [{ name: 'ci', bucket: 'fail' }] };
  DENIED([
    'for n in 5 6; do gh pr merge $n --squash; done', 'if gh pr checks 5; then gh pr merge 5 --squash; fi',
    'timeout 300 gh pr merge 5', 'gh.exe pr merge 5', 'bash -c "gh pr merge 5"', 'powershell -Command "gh pr merge 5"',
    'if ($true) { gh pr merge 5 }',
  ], { fake: red });
  DENIED(['if gh pr checks 5; then gh pr merge 5 --admin; fi'], { fake: { view: view(), checks: GREEN } });
});

test('a mass delete is denied inside a shell string, a substitution or a loop', () => {
  DENIED([
    'bash -c "rm -rf big"', "sh -c 'rm -rf big'", 'powershell -c "Remove-Item -Recurse -Force big"', 'rm -rf /c', 'rm -rf /c/', 'rimraf /d',
    'git rm $(git ls-files big)', 'rm `git ls-files big`', 'Get-ChildItem big | ForEach-Object { Remove-Item $_ }', 'gci big | % { ri $_ }',
    'foreach ($f in $files) { Remove-Item $f }', 'for f in big/*; do rm "$f"; done',
    'node -e "require(\'child_process\').execSync(\'rm -rf big\')"',
  ], { cwd: TREE });
});

test('negative control: small work and prose near those shapes stays allowed', () => {
  ALLOWED([
    'rm -f "$(pwd)/one.txt"', 'bash -c "rm one.txt"', 'for f in a b; do echo "$f"; done', 'git commit -m "for each file do rm x"',
    'rd /s /q small', 'git commit -m "rm -rf big was the old way"', 'echo "bash -c rm -rf big"',
  ], { cwd: TREE });
});

test('the other routes to production are denied', () => {
  DENIED([
    'vercel alias set x.vercel.app example.com', 'vercel alias x.vercel.app example.com', 'vercel api /v10/projects/p/promote/d -X POST',
    'gh api graphql -f query="mutation { mergePullRequest(input: {}) { clientMutationId } }"',
  ]);
  for (const name of ['assign_alias', 'start_rolling_release', 'approve_rolling_release_stage', 'complete_rolling_release']) {
    assert.strictEqual(run('', { tool: `mcp__plugin_vercel_vercel__${name}`, input: { projectId: 'p' } }).decision, 'deny', name);
  }
  ALLOWED(['vercel alias ls', 'vercel api /v9/projects', 'gh api graphql -f query="query { viewer { login } }"']);
  assert.strictEqual(run('', { tool: 'mcp__plugin_vercel_vercel__get_deployment', input: { idOrUrl: 'd' } }).decision, 'allow');
});

test('deletes are counted past the 100 files gh pr view returns, and an unreadable count denies', () => {
  const paths = Array.from({ length: 11 }, (_v, i) => `old/f${i}.txt`);
  const r = run(MERGE, { fake: { view: view({ files: [] }), checks: GREEN, ...BATCHED, deleted: paths } });
  assert.strictEqual(r.decision, 'ask');
  assert.match(r.reason, /11 files/);
  const blind = run(MERGE, { fake: { view: view({ files: [] }), checks: GREEN, ...BATCHED, deleted: null } });
  assert.strictEqual(blind.decision, 'deny');
  assert.match(blind.reason, /could not read/);
});

test('a git failure is not read as a clean tree', () => {
  const prod = repo(PROD);
  fs.writeFileSync(path.join(prod, '.git', 'index'), 'not an index');
  const r = run('vercel --prod', { cwd: prod });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /could not read/);
});

const RED = { view: view(), checks: [{ name: 'ci', bucket: 'fail' }] };

test('a quoted force flag is still a force push', () => {
  DENIED(['git push origin main "--force"', "git push origin x '-f'", 'git push "--mirror" origin', 'git push origin x "--force-with-lease"']);
});

test('a force push is denied however its words are quoted, escaped or shortened', () => {
  const forced = [
    'git push origin "+main"', "git push origin '+HEAD:main'", 'git push origin "+feature/x"', 'git push origin +"feature/x"',
    'git push --force-w origin x', 'git push --force-with-leas origin x', 'git push --force-i --force-with-lease=x', 'git push --forc origin x',
    'git push --mirr origin', '"git" push --force', 'git "push" --force', "git 'push' origin x -f", 'git push -"f"', 'git push --fo\\rce',
    'git p\\ush -f', '\\git push -f', '"/usr/bin/git" push -f', '"C:\\Program Files\\Git\\cmd\\git.exe" push -f origin x',
    'git send-pack --force origin x', 'git send-pack --mirr origin', 'git send-pack origin "+main"', 'git http-push --force https://example.com/r.git x',
    'git-push -f origin x', 'sudo "git" push -f', 'timeout 60 git "push" -f', 'env A=1 git "push" --mirr', 'echo x | xargs git "push" -f',
    'G=git; $G push -f', '"$GIT" push --force origin x', 'if true; then "git" push -f; fi', 'cd x && git "push" -f', '$(git "push" -f)', 'echo "$(git "push" -f)"',
    'bash -c \'git "push" -f\'', 'eval "git \\"push\\" -f"', 'git -C "a b" "push" -f', 'git "-C" x push --forc', 'git push 2>&1 origin "+x"',
    'git push origin x \\\n  "+y"', 'git.exe "push" -f', 'bash <<EOF\ngit "push" -f\nEOF',
  ];
  DENIED(forced);
  DENIED(['git pu`sh -f', 'git push --fo`rce origin x', '& "git" push -f', "& 'C:\\Program Files\\Git\\cmd\\git.exe' push --mirr origin", 'cmd /c git pu^sh -f', 'cmd /c "git pu^sh -f"'], { tool: 'PowerShell' });
});

test('a force push through a git alias or setting given with -c is denied, and so is saving one as an alias', () => {
  DENIED([
    'git -c alias.p="push -f" p', "git -c alias.p='push --force' p origin x", 'git -c alias.p=push p -f', 'git -c "alias.p=push" p origin +x',
    "git -c alias.p='!git push -f' p", "git -c alias.p='!f() { git push --force; }; f' p", 'git -c alias.a=b -c alias.b="push -f" a',
    'git -c alias.p="send-pack --force" p origin', 'git -c ALIAS.P="push -f" p', 'git -c alias.p="-c x.y=z push -f" p',
    'git -c remote.origin.push=+HEAD:main push origin', 'git -c remote.origin.mirror=true push', 'git -c "remote.origin.push=+refs/heads/*" "push"',
    'git config alias.p "push -f"', 'git config --global alias.pf "push --force-with-lease"', "git config set alias.p '!git push -f'",
  ]);
});

test('deleting a protected branch is denied however its words are quoted, escaped or shortened', () => {
  DENIED([
    'git push origin ":main"', "git push origin ':main'", 'git push origin ":refs/heads/main"', 'git push origin :"main"', 'git push --dele origin main',
    'git push --delete origin "main"', "git push -d origin 'main'", 'git push origin --delete "release/1.2"', 'git push -vd origin main',
    'git "push" origin :main', 'git push origin :heads/main', 'git push origin --delete x "main"', 'git push --de\\lete origin main', 'git send-pack origin ":main"',
    'git -c alias.p="push --delete" p origin main', 'git push origin ":\\main"',
  ]);
});

test('negative control: pushes and text that only look like a force push or a protected delete stay allowed', () => {
  const FEATURE = repo(PROD); // its own repo on a feature branch: a bare push of HEAD is judged by the branch it is on
  git(FEATURE, 'switch', '-q', '-c', 'feature/x');
  ALLOWED([
    'git push origin "feature/x"', '"git" push origin feature/x', 'git "push" -u origin feature/x', 'git push --follow origin feature/x',
    'git push --follow-tags "origin" feature/x', 'git push --dry-run origin x', 'git push -n origin x', 'git push --no-force origin x', 'git push --tags', 'git push origin --delete "old-branch"', 'git push origin ":old-branch"',
    'git push origin ":feat/main-page"', 'git push origin "HEAD:feature/x"', 'git push --set-upstream origin HEAD', 'git push -o ci.skip origin x', 'git push origin :',
    'git -c alias.p="push" p origin feature/x', 'git -c alias.s="status -f" s', 'git -c remote.origin.push=HEAD:feature/x push origin', 'git config alias.st "status -sb"',
    'git config --get alias.p', 'git stash push -u -m "+x"', 'git log --grep "git p\\ush -f"', 'echo "git pu" "sh -f"', 'git commit -m "git \'push\' -f is denied"', 'grep -rn \'git "push" --force\' docs', 'git checkout -f push', 'git branch -f push HEAD',
    'docker push -f x', 'npm run git-push-check -- -f', 'git fetch origin "+refs/heads/*:refs/remotes/origin/*"', 'git diff main "+x"',
    'cat a && git push origin x && ls -f', 'git push origin x; rm -f one.txt', 'git push origin x | tail -f',
    "git commit -F - <<'EOF'\ngit \"push\" -f was the old way\nEOF", "cat > \"$T/a.md\" <<'EOF'\nit's git \"push\" --force\nEOF",
  ], { cwd: FEATURE });
  ALLOWED(['git push origin feature/x', '& "git" push origin feature/x', 'git push origin HEAD:feature/x'], { tool: 'PowerShell', cwd: FEATURE });
});

test('a backslash or a path in front of rm hides no delete', () => {
  DENIED(['\\rm -rf big', '/bin/rm -rf big', '/usr/bin/rm -r big', '(\\rm -rf big)', 'true && /bin/rm -rf big', '/bin/rm.exe -rf big', 'for f in big/*; do \\rm "$f"; done',
    'for f in big/*; do /bin/rm "$f"; done', 'sudo /bin/rm -rf big', 'bash -c "/bin/rm -rf big"', '\\rm big/*'], { cwd: TREE });
  ALLOWED(['\\rm -rf small', '/bin/rm -rf dist', '/bin/rm one.txt', 'ls /bin/rm big', 'git commit -m "use /bin/rm -rf big"', 'echo "\\rm -rf big"'], { cwd: TREE });
});

test('a comment is not a command, and an apostrophe in one hides nothing', () => {
  DENIED(["# don't wait\ngh pr merge 5 --squash\n# that's it"], { fake: RED });
  DENIED(["# don't\nrm -rf big\n# can't"], { cwd: TREE });
  ALLOWED(['# then gh pr merge 5 runs\ngit status'], { fake: RED });
  ALLOWED(['# rm -rf big later\ngit status', 'git status # rm -rf big'], { cwd: TREE });
});

test('a substitution inside double quotes really runs', () => {
  DENIED(['echo "$(gh pr merge 5 --squash)"', 'x="$(gh pr merge 5)"', 'echo "`gh pr merge 5`"'], { fake: RED });
  DENIED(['echo "$(rm -rf big)"'], { cwd: TREE });
  DENIED(['x=$(gh pr merge 5 --admin)', 'echo "$(gh pr merge 5 --admin)"'], { fake: { view: view(), checks: GREEN } });
  ALLOWED(["git commit -m \"$(cat <<'EOF'\nthe old way was gh pr merge 5\nEOF\n)\"", 'echo "the merge ran at $(date)"'], { fake: RED });
});

test('a flag with a value before the string a shell is told to run hides nothing', () => {
  DENIED(['powershell -NoProfile -ExecutionPolicy Bypass -Command "gh pr merge 5"', 'cmd /s /c "gh pr merge 5"'], { fake: RED });
  DENIED(['powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item -Recurse -Force big"'], { cwd: TREE });
});

test('a line continuation hides nothing', () => {
  DENIED(['gh pr \\\nmerge 5', 'gh pr merge \\\n5', 'gh pr `\nmerge 5'], { fake: RED });
  DENIED(['git push origin x \\\n--force', 'rm -rf \\\nsrc'], { cwd: TREE });
});

test('a delete in a while loop is denied', () => {
  DENIED(['ls | while read f; do rm -f "$f"; done'], { cwd: TREE });
  ALLOWED(['ls | while read f; do echo "$f"; done'], { cwd: TREE });
});

test('every git option before push is seen', () => {
  DENIED(['git -P push origin feat/x --force', 'git -p push origin feat/x -f', 'git --work-tree . push origin feat/x -f', 'git --git-dir .git push origin feat/x --force']);
});

test('a delete in a shell string, or a Windows path ending in a backslash, still reads its target', () => {
  const win = TREE.replace(/\//g, '\\');
  DENIED([
    'bash -c "rm -rf big" && echo "done"', "bash -c 'rm -rf big' && echo 'done'",
    'powershell -Command "Remove-Item -Recurse -Force big"; echo "done"',
  ], { cwd: TREE });
  if (process.platform !== 'win32') return; // a backslash path names a folder on Windows only
  DENIED([
    `Remove-Item -Recurse -Force "${win}\\big\\"; Write-Host "done"`,
    `Remove-Item -Recurse -Force "${win}\\small\\" "${win}\\big\\"`,
    `rd /s /q "${win}\\big\\" && echo "done"`,
  ], { cwd: TREE });
  DENIED([`Remove-Item -Recurse -Force "${win}\\big\\"; Write-Host "done"`], { cwd: TREE, tool: 'PowerShell' });
});

test('an unquoted ) or # ends no delete before its later flag or path', () => {
  DENIED([
    "Remove-Item (Join-Path $PWD 'big') -Recurse -Force", "Remove-Item -LiteralPath (Join-Path $PWD 'big') -Recurse -Force",
    `Remove-Item -Path (Join-Path "${TREE.replace(/\\/g, '/')}" "big") -Recurse -Force`,
    "Remove-Item ('big') -Recurse -Force", 'Remove-Item ("big") -Recurse -Force', "Remove-Item @('big','src') -Recurse -Force",
    'rm -rf a\\(1\\) big', 'rm a(1) b c d e f g h i j k l', 'rm -rf #tmp big',
  ], { cwd: TREE });
  DENIED(["Remove-Item ('big') -Recurse -Force"], { cwd: TREE, tool: 'PowerShell' });
});

test('negative control: a small delete in those same shapes stays allowed', () => {
  const win = TREE.replace(/\//g, '\\');
  ALLOWED([
    'rm -rf small', 'bash -c "rm -rf small" && echo "done"', "bash -c 'rm -rf small' && echo 'done'",
    'powershell -Command "Remove-Item -Recurse -Force small"; echo "done"',
    `Remove-Item -Recurse -Force "${win}\\small\\"; Write-Host "done"`, "Remove-Item ('small') -Recurse -Force",
  ], { cwd: TREE });
});

test('a main push in a shell string with quoted text after it is denied from a clone of a repository with required checks', () => {
  const prod = repo(PROD);
  DENIED(['bash -c "git push origin main" && echo "done"', "bash -c 'git push origin main' && echo 'done'", 'powershell -Command "git push origin main"; echo "done"'], { cwd: prod });
  DENIED(['powershell -Command "git push origin main"; echo "done"'], { cwd: prod, tool: 'PowerShell' });
  ALLOWED(['bash -c "git push origin feature/x" && echo "done"', 'powershell -Command "git push origin feature/x"; echo "done"'], { cwd: prod });
});

test('negative control: a delete of a few split quoted paths counts each path once', () => {
  const split = (n) => Array.from({ length: n }, (_v, i) => `"$L"/f${i}.bak`).join(' ');
  const names = (n) => Array.from({ length: n }, (_v, i) => `f${i}`).join(' ');
  ALLOWED([`L=x; rm ${split(5)}`, `L=x; rm ${split(10)}`, `rm "$L"/a ${names(9)}`], { cwd: TREE });
  DENIED([`L=x; rm ${split(11)}`, `rm "$L"/a ${names(10)}`, `rm ${names(11)}`, `bash -c "rm ${names(11)}" && echo "done"`], { cwd: TREE });
});

test('a PowerShell comma list of quoted files counts each file', () => {
  const list = (n, q, sep) => Array.from({ length: n }, (_v, i) => `${q}f${i}.txt${q}`).join(sep);
  for (const tool of ['Bash', 'PowerShell']) {
    DENIED([`Remove-Item ${list(12, '"', ',')}`, `Remove-Item ${list(12, "'", ',')}`, `Remove-Item -Path ${list(12, '"', ',')} -Force`, `Remove-Item ${list(12, '"', ', ')}`], { cwd: TREE, tool });
    ALLOWED([`Remove-Item ${list(6, "'", ', ')}`, `Remove-Item ${list(6, '"', ',')}`, `Remove-Item ${list(10, '"', ',')} -Force`], { cwd: TREE, tool });
  }
});

test('a PowerShell comma list with mixed quoting counts each file', () => {
  const n = (k) => Array.from({ length: k }, (_v, i) => `f${i}.txt`);
  const alt = (k, a, b) => n(k).map((x, i) => (i % 2 ? b(x) : a(x))).join(',');
  const q = (x) => `"${x}"`;
  const bare = (x) => x;
  const tri = (k) => n(k).map((x, i) => [`"${x}"`, `'${x}'`, x][i % 3]).join(',');
  const under = (k) => n(k).map((x) => `"$D"\\${x}`).join(',');
  for (const tool of ['Bash', 'PowerShell']) {
    DENIED([`Remove-Item ${alt(12, q, bare)}`, `Remove-Item ${alt(12, bare, q)}`, `Remove-Item ${tri(12)}`,
      `Remove-Item -Path ${alt(12, q, bare)} -Force`, `Remove-Item ${under(12)}`], { cwd: TREE, tool, env: { D: TREE } });
    ALLOWED([`Remove-Item ${alt(6, q, bare)}`, `Remove-Item ${tri(9)}`, `Remove-Item ${under(6)}`], { cwd: TREE, tool, env: { D: TREE } });
  }
});

test('a quoted path ending in a backslash, then quoted text, is ordinary cleanup', () => {
  ALLOWED(['Remove-Item -Recurse -Force "dist\\"; Write-Host "removed $n files"', 'Remove-Item -Recurse -Force "dist\\"; Write-Host "next: src"'], { cwd: TREE, tool: 'PowerShell' });
  ALLOWED(['rm -rf "dist\\"; echo "x $y"'], { cwd: TREE });
  DENIED(['Remove-Item -Recurse -Force "big\\"; Write-Host "removed $n files"', 'rm -rf "big\\"; echo "x $y"'], { cwd: TREE });
});

test('cmd.exe switches are not counted as files', () => {
  const names = (n) => Array.from({ length: n }, (_v, i) => `f${i}.txt`).join(' ');
  ALLOWED([`del /q /f ${names(9)}`, `del /q ${names(10)}`, `erase /q ${names(10)}`], { cwd: TREE });
  DENIED([`del /q /f ${names(11)}`, `del ${names(11)}`], { cwd: TREE });
});
