// Run: node --test system/hooks/tests/merge-batch.test.js
// merge-batch.js against a real bare origin (git is real) and a canned gh (VIBEQUARTERS_BATCH_FAKE_GH, every call logged to
// VIBEQUARTERS_BATCH_GH_LOG). Landing is simulated the way GitHub squashes: one commit per member, subject "<title> (#<n>)".
require('./helpers/config');
const { execGit } = require('./helpers/git');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'merge-batch.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-batch-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execGit(args, {
  cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const parsed = (s) => { try { return JSON.parse(s); } catch (_e) { return null; } };
const REPO = 'acme/app';
const CI = 'ci';
const BASE = 'main';
const NL = '\r\n'; // Windows line ends

let count = 0;
// A bare origin whose main holds base.txt, plus refs/pull/<k>/head for each spec { k, file, text }.
// main's vercel.json carries the ignore step unless ignoreStep is false.
function fixture(specs, { ignoreStep = true } = {}) {
  const dir = path.join(ROOT, `f${count++}`);
  const fx = { dir, origin: path.join(dir, 'origin.git'), seed: path.join(dir, 'seed'), work: path.join(dir, 'work'),
    batches: path.join(dir, 'batches'), log: path.join(dir, 'gh.log'), bodies: path.join(dir, 'bodies'), prs: {} };
  fs.mkdirSync(fx.bodies, { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', fx.origin);
  git(dir, 'init', '-q', '-b', 'main', fx.seed);
  fs.writeFileSync(path.join(fx.seed, 'base.txt'), 'base\n');
  fs.writeFileSync(path.join(fx.seed, 'vercel.json'), JSON.stringify(ignoreStep
    ? { buildCommand: 'npm run build', ignoreCommand: 'node scripts/vercel-ignore-build.mjs' } : { buildCommand: 'npm run build' }));
  git(fx.seed, 'add', '.');
  git(fx.seed, 'commit', '-q', '-m', 'base');
  git(fx.seed, 'remote', 'add', 'origin', fx.origin);
  git(fx.seed, 'push', '-q', 'origin', 'main');
  for (const s of specs) {
    git(fx.seed, 'checkout', '-q', '-B', `pr${s.k}`, 'main');
    fs.writeFileSync(path.join(fx.seed, s.file), s.text);
    git(fx.seed, 'add', '.');
    git(fx.seed, 'commit', '-q', '-m', `pr ${s.k}`);
    git(fx.seed, 'push', '-q', 'origin', `HEAD:refs/pull/${s.k}/head`);
    fx.prs[s.k] = { title: `Fix ${s.k}`, headRefOid: git(fx.seed, 'rev-parse', 'HEAD'), body: (s.body ?? `Ships alone: fix ${s.k}.`) };
    fs.writeFileSync(path.join(fx.bodies, `${s.k}.md`), `Summary of ${s.k}.\n`);
  }
  git(fx.seed, 'checkout', '-q', 'main');
  git(dir, 'clone', '-q', fx.origin, fx.work);
  return fx;
}

function cli(fx, args, fake = {}) {
  const env = { ...process.env, ...GIT_ENV, VIBEQUARTERS_BATCH_DIR: fx.batches, VIBEQUARTERS_BATCH_GH_LOG: fx.log,
    VIBEQUARTERS_BATCH_FAKE_GH: JSON.stringify({ prs: fx.prs, ...fake }) };
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  return { code: r.status, out: parsed(r.stdout) || {}, raw: r.stdout + r.stderr };
}
const build = (fx, prs) => cli(fx, ['build', '--repo', REPO, '--prs', prs.join(','), '--dir', fx.work]);

function ready(fx, prs) {
  const rec = build(fx, prs).out;
  assert.strictEqual(cli(fx, ['opened', '--id', rec.id, '--batch-pr', '900']).code, 0);
  const green = { prs: { ...fx.prs, 900: { title: 'Batch', headRefOid: rec.head } }, checks: { 900: [{ name: CI, bucket: 'pass' }] } };
  return { rec, green };
}

// One GitHub squash merge of member k onto origin main.
function land(fx, rec, k) {
  const m = rec.members[k];
  git(fx.seed, 'fetch', '-q', 'origin', 'main', `refs/pull/${m.pr}/head`);
  git(fx.seed, 'checkout', '-q', '-B', 'main', 'origin/main');
  git(fx.seed, 'merge', '--squash', '-q', m.head);
  git(fx.seed, 'commit', '-q', '-m', `${m.title} (#${m.pr})`);
  git(fx.seed, 'push', '-q', 'origin', 'HEAD:main');
}

const THREE = [{ k: 1, file: 'a.txt', text: 'a\n' }, { k: 2, file: 'b.txt', text: 'b\n' }, { k: 3, file: 'c.txt', text: 'c\n' }];

test('a built batch holds its PRs in the given order, each at its recorded head', () => {
  const fx = fixture(THREE);
  const r = build(fx, [1, 2, 3]);
  assert.strictEqual(r.code, 0, r.raw);
  const rec = r.out;
  assert.deepStrictEqual(rec.members.map((m) => m.pr), [1, 2, 3]);
  assert.deepStrictEqual(rec.members.map((m) => m.head), [1, 2, 3].map((k) => fx.prs[k].headRefOid));
  assert.deepStrictEqual(rec.members.map((m) => m.title), ['Fix 1', 'Fix 2', 'Fix 3']);
  assert.strictEqual(rec.base, git(fx.work, 'rev-parse', 'origin/main'));
  assert.strictEqual(rec.head, git(fx.work, 'rev-parse', `batch/${rec.id}`));
  assert.strictEqual(rec.state, 'built');
  assert.strictEqual(rec.batchPr, null);
  const merged = git(fx.work, 'log', '--first-parent', '--reverse', '--format=%P', `${rec.base}..${rec.head}`)
    .split('\n').map((l) => l.split(' ')[1]);
  assert.deepStrictEqual(merged, rec.members.map((m) => m.head));
  const { next, ...stored } = rec;
  assert.ok(Array.isArray(next));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(fx.batches, `${rec.id}.json`), 'utf8')), stored);
});

test('a PR that conflicts is left out of the batch', () => {
  const fx = fixture([{ k: 1, file: 'a.txt', text: 'one\n' }, { k: 2, file: 'a.txt', text: 'two\n' }, { k: 3, file: 'c.txt', text: 'c\n' }]);
  const r = build(fx, [1, 2, 3]);
  assert.strictEqual(r.code, 0, r.raw);
  assert.deepStrictEqual(r.out.members.map((m) => m.pr), [1, 3]);
  assert.strictEqual(r.out.dropped.length, 1);
  assert.strictEqual(r.out.dropped[0].pr, 2);
  assert.match(r.out.dropped[0].reason, /conflict/i);
  assert.strictEqual(git(fx.work, 'status', '--porcelain'), '');
});

const noRecords = (fx) => (fs.existsSync(fx.batches) ? fs.readdirSync(fx.batches) : []);
const part = (k, n, file = `p${k}.txt`) => ({ k, file, text: `${k}\n`, body: `Summary.\n\nUpdate: search-page part ${k} of ${n}\n` });

test('build refuses a PR whose body does not say whether it ships alone', () => {
  for (const body of ['Summary only.', 'Ships alone:', 'We ships alone: no', '**Ships alone:**', '**Ships alone:** \r\n']) {
    const fx = fixture([{ k: 1, file: 'a.txt', text: 'a\n', body }]);
    const r = build(fx, [1]);
    assert.strictEqual(r.code, 1, r.raw);
    assert.match(r.out.reason, /PR #1 does not say whether it ships alone/);
    assert.match(r.out.reason, /Update: <name> part <k> of <n>/);
    assert.deepStrictEqual(noRecords(fx), []);
  }
});

test('build refuses an undeclared PR before it fetches or merges anything', () => {
  const fx = fixture([...THREE.slice(0, 2), { k: 3, file: 'c.txt', text: 'c\n', body: 'Summary only.' }]);
  const r = build(fx, [1, 2, 3]);
  assert.strictEqual(r.code, 1, r.raw);
  assert.match(r.out.reason, /PR #3 does not say/);
  assert.strictEqual(git(fx.work, 'branch', '--list', 'batch/*'), '');
});

test('declarations may sit in a bullet or bold, with spaces in the name and a closing period', () => {
  const fx = fixture([
    { k: 1, file: 'a.txt', text: 'a\n', body: 'x\r\n- **Update:** search page part 1 of 2.\r\n' },
    { k: 2, file: 'b.txt', text: 'b\n', body: '* Update: Search Page part 2 of 2' },
    { k: 3, file: 'c.txt', text: 'c\n', body: '**Ships alone:** a spelling fix\n\n- Update: the help page shows new hours' },
  ]);
  const r = build(fx, [1, 2, 3]);
  assert.strictEqual(r.code, 0, r.raw);
});

test('an Update line outside part 1..n is named as malformed, not as missing', () => {
  for (const line of ['Update: x part 3 of 2', 'Update: x part 0 of 1', 'Update: x', 'Update: x part 1 of 99999999999']) {
    const fx = fixture([{ k: 1, file: 'a.txt', text: 'a\n', body: line }]);
    const r = build(fx, [1]);
    assert.strictEqual(r.code, 1, r.raw);
    assert.match(r.out.reason, /PR #1 has an Update line that does not read/);
  }
});

test('build refuses one part of an update without the rest', () => {
  const fx = fixture([part(1, 2), part(2, 2)]);
  const r = build(fx, [1]);
  assert.strictEqual(r.code, 1, r.raw);
  assert.match(r.out.reason, /update "search-page" has 2 parts; this batch is missing part 2/);
  assert.deepStrictEqual(noRecords(fx), []);
});

test('build takes every part of an update together, beside a PR that ships alone', () => {
  const fx = fixture([part(1, 2), part(2, 2), { k: 3, file: 'c.txt', text: 'c\n', body: 'SHIPS ALONE: fixes a typo on /pricing' }]);
  const r = build(fx, [1, 2, 3]);
  assert.strictEqual(r.code, 0, r.raw);
  assert.deepStrictEqual(r.out.members.map((m) => m.pr), [1, 2, 3]);
});

test('a part dropped for a conflict refuses the batch, so its sibling never lands alone', () => {
  const fx = fixture([part(1, 2, 'same.txt'), { ...part(2, 2, 'same.txt'), text: 'other\n' }]);
  const r = build(fx, [1, 2]);
  assert.strictEqual(r.code, 1, r.raw);
  assert.match(r.out.reason, /missing part 2/);
  assert.strictEqual(r.out.dropped[0].pr, 2);
  assert.deepStrictEqual(noRecords(fx), []);
});

// One batch under test at a time: a second one on the same main is thrown away when the first lands.
const openOne = (fx, prs) => {
  const rec = build(fx, prs).out;
  assert.strictEqual(cli(fx, ['opened', '--id', rec.id, '--batch-pr', '900']).code, 0);
  return rec;
};
const buildWhile = (fx, prs, bucket) => cli(fx, ['build', '--repo', REPO, '--prs', prs.join(','), '--dir', fx.work], { checks: { 900: [{ name: CI, bucket }] } });

test('build waits while another batch is under test on this main', () => {
  const fx = fixture(THREE);
  const rec = openOne(fx, [1]);
  const r = buildWhile(fx, [2], 'pending');
  assert.strictEqual(r.code, 1);
  assert.match(r.out.reason, new RegExp(`${rec.id}.*under test`));
  assert.strictEqual(noRecords(fx).length, 1, 'no second batch was recorded');
});

test('a batch that failed CI does not hold the line', () => {
  const fx = fixture(THREE);
  openOne(fx, [1]);
  assert.strictEqual(buildWhile(fx, [2], 'fail').code, 0);
});

test('once main moves, the older batch no longer holds the line', () => {
  const fx = fixture(THREE);
  const rec = openOne(fx, [1]);
  land(fx, rec, 0);
  assert.strictEqual(buildWhile(fx, [2], 'pending').code, 0);
});

test('a batch past its 15 minute lease no longer holds the line', () => {
  const fx = fixture(THREE);
  const rec = openOne(fx, [1]);
  const file = path.join(fx.batches, `${rec.id}.json`);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.rmSync(file);
  fs.writeFileSync(path.join(fx.batches, '20200101000000.json'), JSON.stringify({ ...saved, id: '20200101000000' }));
  assert.strictEqual(buildWhile(fx, [2], 'pending').code, 0);
});

test('a tab may rebuild a batch holding its own PR', () => {
  const fx = fixture(THREE);
  openOne(fx, [1]);
  assert.strictEqual(buildWhile(fx, [1], 'pending').code, 0);
});

test('building a batch only reads from GitHub', () => {
  const fx = fixture(THREE);
  const r = build(fx, [1, 2, 3]);
  assert.strictEqual(git(fx.dir, 'ls-remote', fx.origin, 'refs/heads/batch/*'), '');
  const calls = fs.readFileSync(fx.log, 'utf8').split('\n').filter(Boolean);
  assert.ok(calls.length > 0);
  for (const c of calls) assert.match(c, /^pr view /, c);
  const next = r.out.next.join('\n');
  assert.match(next, new RegExp(`git -C .* push -u origin batch/${r.out.id}`));
  assert.match(next, new RegExp(`gh pr create --draft --base ${BASE} --head batch/${r.out.id}`));
});

test('plan-land refuses when main moved', () => {
  const fx = fixture(THREE);
  const { rec, green } = ready(fx, [1, 2, 3]);
  fs.writeFileSync(path.join(fx.seed, 'other.txt'), 'x\n');
  git(fx.seed, 'add', '.');
  git(fx.seed, 'commit', '-q', '-m', 'someone else');
  git(fx.seed, 'push', '-q', 'origin', 'main');
  const r = cli(fx, ['plan-land', '--id', rec.id, '--bodies', fx.bodies], green);
  assert.strictEqual(r.code, 1);
  assert.match(r.out.reason, /main/);
});

test('a PR pushed to after the build stops plan-land', () => {
  const fx = fixture(THREE);
  const { rec, green } = ready(fx, [1, 2, 3]);
  green.prs[2] = { ...green.prs[2], headRefOid: 'f'.repeat(40) };
  const r = cli(fx, ['plan-land', '--id', rec.id, '--bodies', fx.bodies], green);
  assert.strictEqual(r.code, 1);
  assert.match(r.out.reason, /#2/);
});

test('plan-land needs the batch check green', () => {
  const fx = fixture(THREE);
  const { rec, green } = ready(fx, [1, 2, 3]);
  for (const bucket of ['fail', 'pending']) {
    const r = cli(fx, ['plan-land', '--id', rec.id, '--bodies', fx.bodies], { ...green, checks: { 900: [{ name: CI, bucket }] } });
    assert.strictEqual(r.code, 1, bucket);
    assert.match(r.out.reason, /\bci\b/);
  }
  const moved = cli(fx, ['plan-land', '--id', rec.id, '--bodies', fx.bodies], { ...green, prs: { ...green.prs, 900: { headRefOid: 'e'.repeat(40) } } });
  assert.strictEqual(moved.code, 1);
});

test('isBatchPart matches only the shape plan-land writes: line 2 exactly [batch-part]', () => {
  const { isBatchPart } = require('../merge-batch.js');
  assert.strictEqual(isBatchPart('Fix x (#5)\n\n[batch-part]\n\nSummary.\n'), true);
  assert.strictEqual(isBatchPart(['Fix x (#5)', '', '[batch-part]', '', 'Summary.', ''].join(NL)), true);
  for (const m of [
    'Fix x (#5)\n\n  [batch-part]\n', 'Fix x (#5)\n\n[batch-part] \n', 'Fix x (#5)\n\n```\n[batch-part]\n```\n',
    'Fix x (#9)\n\n* Fix x (#5)\n\n[batch-part]\n', 'Fix x (#5)\n\nSummary.\n\n[batch-part]\n', '[batch-part]', '', null,
  ]) assert.strictEqual(isBatchPart(m), false, JSON.stringify(m));
});

test("plan-land refuses a last member's summary that would make its commit a [batch-part] one", () => {
  const fx = fixture(THREE);
  const { rec, green } = ready(fx, [1, 2, 3]);
  fs.writeFileSync(path.join(fx.bodies, '3.md'), '[batch-part]\n\nFix 3\n');
  const r = cli(fx, ['plan-land', '--id', rec.id, '--bodies', fx.bodies], green);
  assert.strictEqual(r.code, 1, r.raw);
  assert.match(r.out.reason, /#3/);
  assert.match(r.out.reason, /\[batch-part\]/);
});

test('a summary with [batch-part] on a later line is fine: only line 2 of the commit counts', () => {
  const fx = fixture(THREE);
  const { rec, green } = ready(fx, [1, 2, 3]);
  fs.writeFileSync(path.join(fx.bodies, '3.md'), 'Fix 3\n\n[batch-part]\n');
  assert.strictEqual(cli(fx, ['plan-land', '--id', rec.id, '--bodies', fx.bodies], green).code, 0);
});

test("plan-land refuses while main's vercel.json has no ignore step, since every [batch-part] commit would deploy", () => {
  const fx = fixture(THREE, { ignoreStep: false });
  const { rec, green } = ready(fx, [1, 2, 3]);
  const r = cli(fx, ['plan-land', '--id', rec.id, '--bodies', fx.bodies], green);
  assert.strictEqual(r.code, 1, r.raw);
  assert.match(r.out.reason, /vercel-ignore-build/);
});

test('plan-land writes [batch-part] bodies, then a Batch-Head body for the final PR', () => {
  const fx = fixture(THREE);
  const { rec, green } = ready(fx, [1, 2, 3]);
  const r = cli(fx, ['plan-land', '--id', rec.id, '--bodies', fx.bodies], green);
  assert.strictEqual(r.code, 0, r.raw);
  const body = (k) => fs.readFileSync(path.join(fx.bodies, `${k}.body.md`), 'utf8');
  for (const k of [1, 2]) {
    assert.strictEqual(body(k).split('\n')[0], '[batch-part]');
    assert.match(body(k), new RegExp(`Summary of ${k}`));
    assert.doesNotMatch(body(k), /Batch-Head/);
  }
  assert.doesNotMatch(body(3), /\[batch-part\]/);
  assert.strictEqual(body(3).trimEnd().split('\n').pop(), `Batch-Head: ${rec.head}`);
  assert.strictEqual(r.out.commands.length, 3);
  r.out.commands.forEach((c, i) => {
    const k = i + 1;
    assert.ok(c.startsWith(`gh pr merge ${k} -R ${REPO} --squash --subject 'Fix ${k} (#${k})' --body-file `), c);
    assert.ok(c.includes(`${k}.body.md`), c);
    assert.ok(c.includes(` --match-head-commit ${rec.members[i].head}`), c);
  });
});

test('a batch holding a single PR has only the Batch-Head body', () => {
  const fx = fixture(THREE.slice(0, 1));
  const { rec, green } = ready(fx, [1]);
  const r = cli(fx, ['plan-land', '--id', rec.id, '--bodies', fx.bodies], green);
  assert.strictEqual(r.code, 0, r.raw);
  const body = fs.readFileSync(path.join(fx.bodies, '1.body.md'), 'utf8');
  assert.doesNotMatch(body, /\[batch-part\]/);
  assert.match(body, new RegExp(`Batch-Head: ${rec.head}`));
});

const FIVE = [1, 2, 3, 4, 5].map((k) => ({ k, file: `f${k}.txt`, text: `${k}\n` }));

test('verify exits 1 and says partial while PRs are missing from main', () => {
  const fx = fixture(FIVE);
  const rec = build(fx, [1, 2, 3, 4, 5]).out;
  for (const k of [0, 1, 2]) land(fx, rec, k);
  const r = cli(fx, ['verify', '--id', rec.id]);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.out.landed, '3/5');
  assert.strictEqual(r.out.treeMatch, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(fx.batches, `${rec.id}.json`), 'utf8')).state, 'partial');
  // parts 1..3 skipped their production builds, so nothing of the batch is live: say so and say how to recover
  assert.match(r.out.recovery, /#4, #5/);
  assert.match(r.out.recovery, /deploy production/);
  assert.match(r.raw, /PRODUCTION IS BEHIND MAIN/);
});

test('sameTree never calls two unreadable trees a match', () => {
  const { sameTree } = require('../merge-batch.js');
  assert.strictEqual(sameTree('', ''), false);
  assert.strictEqual(sameTree('abc', ''), false);
  assert.strictEqual(sameTree('abc', 'abc'), true);
});

test('verify exits 0 once main has every PR and the tested tree', () => {
  const fx = fixture(FIVE);
  const rec = build(fx, [1, 2, 3, 4, 5]).out;
  for (const k of [0, 1, 2, 3, 4]) land(fx, rec, k);
  const r = cli(fx, ['verify', '--id', rec.id]);
  assert.strictEqual(r.code, 0, r.raw);
  assert.strictEqual(r.out.landed, '5/5');
  assert.strictEqual(r.out.treeMatch, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(fx.batches, `${rec.id}.json`), 'utf8')).state, 'landed');
  // A non-member commit on top leaves 5/5 subjects but a different tree.
  fs.writeFileSync(path.join(fx.seed, 'late.txt'), 'late\n');
  git(fx.seed, 'add', '.');
  git(fx.seed, 'commit', '-q', '-m', 'late');
  git(fx.seed, 'push', '-q', 'origin', 'HEAD:main');
  assert.strictEqual(cli(fx, ['verify', '--id', rec.id]).code, 1);
});

test('isBatchPrefix takes subjects that match the members from the start, in order', () => {
  const { isBatchPrefix } = require('../merge-batch.js');
  const rec = { members: [{ pr: 1, title: 'A' }, { pr: 2, title: 'B' }, { pr: 3, title: 'C' }] };
  assert.strictEqual(isBatchPrefix(rec, []), true);
  assert.strictEqual(isBatchPrefix(rec, ['A (#1)']), true);
  assert.strictEqual(isBatchPrefix(rec, ['A (#1)', 'B (#2)']), true);
  assert.strictEqual(isBatchPrefix(rec, ['B (#2)']), false);
  assert.strictEqual(isBatchPrefix(rec, ['A (#1)', 'X (#9)']), false);
  assert.strictEqual(isBatchPrefix(rec, ['A (#1)', 'B (#2)', 'C (#3)', 'D (#4)']), false);
});

test('findBatchFor finds the newest unlanded record listing that PR at that head', () => {
  const dir = path.join(ROOT, 'lib');
  fs.mkdirSync(dir, { recursive: true });
  const write = (rec) => fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec));
  write({ id: '20300101000000', repo: REPO, state: 'built', members: [{ pr: 7, head: 'a1' }] });
  write({ id: '20300102000000', repo: REPO, state: 'built', members: [{ pr: 7, head: 'a1' }, { pr: 8, head: 'b1' }] });
  write({ id: '20300103000000', repo: REPO, state: 'landed', members: [{ pr: 7, head: 'a1' }] });
  const r = spawnSync(process.execPath, ['-e', `const m = require(${JSON.stringify(CLI)});
    console.log(JSON.stringify([m.findBatchFor('ACME/APP', 7, 'a1'), m.findBatchFor('${REPO}', 7, 'zz'),
      m.findBatchFor('Other/repo', 7, 'a1'), m.readBatch('20300101000000'), m.readBatch('nope')].map((x) => x && x.id)))`],
  { encoding: 'utf8', env: { ...process.env, VIBEQUARTERS_BATCH_DIR: dir } });
  assert.deepStrictEqual(JSON.parse(r.stdout), ['20300102000000', null, null, '20300101000000', null]);
});
