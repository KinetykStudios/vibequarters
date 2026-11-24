#!/usr/bin/env node
// merge-batch.js: the batch helper each session lands its own PRs with (/land), for the repos in mergeGate.batchRepos.
//
// A batch is origin/main plus several PRs merged in order on a local batch/<id> branch. CI runs the whole suite on its
// draft PR once; the members then land on main as squash merges in that order, and verify proves main's tree equals
// the tested batch head. This file never pushes, opens a PR or merges: it prints those commands for the landing session to run
// one call at a time, so every guard still sees each one.
//
//   build     --dir <worktree> --repo <owner/name> --prs <n,n,...>
//   opened    --id <id> --batch-pr <n>
//   plan-land --id <id> --bodies <dir>     (reads <dir>/<pr>.md, writes <dir>/<pr>.body.md)
//   verify    --id <id>
//
// Records: ~/.claude/coordination/batches/<id>.json (VIBEQUARTERS_BATCH_DIR overrides). Output is JSON on stdout; exit 1 refuses.
// The checks a batch PR must pass are the repo's mergeGate.requiredChecks entry; a repo with none listed needs every
// check on the batch PR to pass, and at least one to have run.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('./vibequarters-config');

const BATCH_DIR = process.env.VIBEQUARTERS_BATCH_DIR || path.join(os.homedir(), '.claude', 'coordination', 'batches');
const MG = P.load().mergeGate;
function requiredFor(repo) {
  const k = String(repo || '').toLowerCase();
  for (const [r, v] of Object.entries(MG.requiredChecks || {})) if (r.toLowerCase() === k) return [].concat(v).filter((s) => typeof s === 'string' && s);
  return [];
}
// null when the checks prove the batch: every required check passing, or with none named every check passing (one at
// least). Otherwise what is not passing, for the refusal.
function checksProblem(repo, checks) {
  const list = Array.isArray(checks) ? checks : [];
  const req = requiredFor(repo);
  if (req.length) {
    const bad = req.filter((n) => !list.some((c) => c.name === n && c.bucket === 'pass'));
    return bad.length ? bad.map((n) => { const c = list.find((x) => x.name === n); return `"${n}" is ${c ? c.bucket : 'missing'}`; }).join(', ') : null;
  }
  if (!list.length) return 'no check ran';
  const bad = list.filter((c) => c.bucket !== 'pass' && c.bucket !== 'skipping');
  return bad.length ? bad.map((c) => `"${c.name}" is ${c.bucket}`).join(', ') : null;
}
// true when a check is known to have failed, so the batch no longer holds the line
function checksFailed(repo, checks) {
  const list = Array.isArray(checks) ? checks : [];
  const req = requiredFor(repo);
  return list.some((c) => (!req.length || req.includes(c.name)) && ['fail', 'cancel'].includes(c.bucket));
}
const FAKE = process.env.VIBEQUARTERS_BATCH_FAKE_GH ? JSON.parse(process.env.VIBEQUARTERS_BATCH_FAKE_GH) : null;
const SELF = __filename.replace(/\\/g, '/');

const parsed = (s) => { try { return JSON.parse(s); } catch (_e) { return null; } };
const slash = (p) => p.replace(/\\/g, '/');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const subject = (m) => `${m.title} (#${m.pr})`;

// The Vercel ignore step (system/templates/vercel-ignore-build.mjs, copied into the repo) skips a production build for
// this shape and no other: line 2 of the commit message, the first body line under "<subject>\n\n", is exactly
// [batch-part], with only a trailing \r stripped. guard-deny-catastrophic.js uses this one; keep the .mjs copy equal to it.
const isBatchPart = (message) => String(message ?? '').split('\n')[2]?.replace(/\r$/, '') === '[batch-part]';
// rev-parse prints nothing when it fails, and two failures are not a match.
const sameTree = (a, b) => !!a && a === b;

// The value of the first of these flags in a command's tokens (--flag value or --flag=value), or undefined.
function flagValue(t, ...names) {
  for (let i = 0; i < t.length; i++) {
    for (const n of names) {
      if (t[i] === n) return t[i + 1];
      if (n.startsWith('--') && t[i].startsWith(`${n}=`)) return t[i].slice(n.length + 1);
    }
  }
  return undefined;
}

// Why the merge command for member pr (its tokens t, run in cwd) would not land the commit plan-land planned, or null.
// Every member but the last needs --body-file whose file makes its commit [batch-part], so Vercel skips the build of a
// tree no test saw; a --body could say anything, so it is refused. The last needs a body naming the tested head.
function landingBodyProblem(rec, pr, t, cwd) {
  const i = rec.members.findIndex((m) => m.pr === Number(pr));
  if (i < 0) return `PR #${pr} is not a member of batch ${rec.id}`;
  const last = i === rec.members.length - 1;
  const file = flagValue(t, '--body-file', '-F');
  const inline = flagValue(t, '--body', '-b');
  const plan = `land it with the command plan-land printed: node ${q(SELF)} plan-land --id ${rec.id} --bodies <dir>`;
  let body;
  if (file !== undefined && file !== '-') {
    try { body = fs.readFileSync(path.resolve(cwd, file), 'utf8'); } catch (_e) { return `its body file ${file} cannot be read from ${slash(cwd)}; ${plan}`; }
  } else if (inline !== undefined && last && file === undefined) {
    body = inline;
  } else {
    return `${last ? 'the last member' : `member ${i + 1} of ${rec.members.length}`} needs the body file plan-land wrote; ${plan}`;
  }
  const message = `${subject(rec.members[i])}\n\n${body}`;
  if (!last) return isBatchPart(message) ? null : `its body does not open with the [batch-part] line, so Vercel would build an untested part of the batch to production; ${plan}`;
  if (isBatchPart(message)) return `the last member's body opens with [batch-part], so no production build would run for the whole batch; ${plan}`;
  return body.split('\n').some((l) => l.replace(/\r$/, '') === `Batch-Head: ${rec.head}`) ? null
    : `the last member's body does not name the tested head (Batch-Head: ${rec.head}); ${plan}`;
}

// Fetch and merge on a large repo take far longer than coord-lib's 8 s git timeout, and their stderr is the reason.
// A fetch whose connection broke (a network blip, or Git for Windows failing to start its shell) is tried again, twice.
const BROKEN = /Could not read from remote|hung up unexpectedly|early EOF|Could not resolve host|Connection (?:reset|timed out)|cygheap/;
function git(dir, ...args) {
  const run = () => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 300000, windowsHide: true });
  let r = run();
  for (let tries = 2; tries && args[0] === 'fetch' && r.status !== 0 && BROKEN.test(r.stderr || ''); tries--) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    r = run();
  }
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// gh pr checks exits non-zero while a check is pending yet still prints the JSON, so stdout decides, not the exit code.
function ghJson(args, fake) {
  if (process.env.VIBEQUARTERS_BATCH_GH_LOG) fs.appendFileSync(process.env.VIBEQUARTERS_BATCH_GH_LOG, `${args.join(' ')}\n`);
  if (FAKE) return fake() || null;
  return parsed(spawnSync('gh', args, { encoding: 'utf8', timeout: 60000, windowsHide: true }).stdout || '');
}
const prView = (repo, n) => ghJson(['pr', 'view', String(n), '-R', repo, '--json', 'title,headRefOid,body'], () => FAKE.prs && FAKE.prs[n]);

// Parts of one update ship together (on when mergeGate.requirePrDeclaration is true). Each member's PR body says, on a line of its own,
// one of two forms: "Ships alone: <reason>", or the Update form with its part number. A batch with one part of an update must
// hold all of them, so a part that only prepares for another never goes live first. The line may be in a bullet or in
// bold, and the update's name may hold spaces.
const SHIPS_ALONE = /^[ \t>*-]*(?:\*\*)?ships alone:(?:\*\*)?[ \t]*[^\s*]/im;
const MAX_PARTS = 20;
const UPDATE_LINE = /^[ \t>*-]*(?:\*\*)?update:/im;
const UPDATE_PART = /^[ \t>*-]*(?:\*\*)?update:(?:\*\*)?[ \t]*(\S.*?)[ \t]+part[ \t]+(\d+)[ \t]+of[ \t]+(\d+)[ \t]*\.?[ \t]*$/im;
function updatePart(body) {
  const u = UPDATE_PART.exec(body || '');
  return u && { name: u[1].trim().toLowerCase(), k: Number(u[2]), n: Number(u[3]) };
}
// Runs on every requested PR before anything is fetched or merged.
function declarationProblem(prs) {
  if (MG.requirePrDeclaration !== true) return null;
  for (const { pr, body } of prs) {
    const u = updatePart(body);
    if (u && u.k >= 1 && u.k <= u.n && u.n <= MAX_PARTS) continue;
    if (!u && SHIPS_ALONE.test(body || '')) continue;
    if (u || UPDATE_LINE.test(body || '')) {
      return `PR #${pr} has an Update line that does not read "Update: <name> part <k> of <n>" with k from 1 to n and n at most ${MAX_PARTS}: fix that line in its body`;
    }
    return `PR #${pr} does not say whether it ships alone. Add one line to its body: "Ships alone: <what people get from this change alone>" if it stands by itself, or "Update: <name> part <k> of <n>" if other PRs belong with it`;
  }
  return null;
}
// Runs on the members left after conflicts, so a dropped part refuses the batch too.
function missingPartProblem(members) {
  if (MG.requirePrDeclaration !== true) return null;
  const updates = {};
  for (const m of members) {
    const u = updatePart(m.body);
    if (!u) continue;
    const e = (updates[u.name] ||= { n: 0, have: new Set() });
    e.have.add(u.k);
    e.n = Math.max(e.n, u.n);
  }
  for (const [name, u] of Object.entries(updates)) {
    const missing = [];
    for (let k = 1; k <= u.n; k++) if (!u.have.has(k)) missing.push(k);
    if (missing.length) {
      return `update "${name}" has ${u.n} parts; this batch is missing part ${missing.join(', ')}. Parts of one update ship together: finish and preview the rest, then build one batch from all of them`;
    }
  }
  return null;
}
const prChecks = (repo, n) => ghJson(['pr', 'checks', String(n), '-R', repo, '--json', 'name,bucket'], () => FAKE.checks && FAKE.checks[n]);

const recordPath = (id) => path.join(BATCH_DIR, `${id}.json`);
function readBatch(id) {
  try { return JSON.parse(fs.readFileSync(recordPath(id), 'utf8')); } catch (_e) { return null; }
}
function save(rec) {
  fs.mkdirSync(BATCH_DIR, { recursive: true });
  fs.writeFileSync(recordPath(rec.id), `${JSON.stringify(rec, null, 2)}\n`);
}

// The newest batch not yet landed that lists this PR at this exact head. Ids are timestamps, so names sort by age.
function findBatchFor(repo, pr, head) {
  let names;
  try { names = fs.readdirSync(BATCH_DIR).filter((f) => f.endsWith('.json')).sort().reverse(); } catch (_e) { return null; }
  for (const f of names) {
    const rec = readBatch(f.slice(0, -'.json'.length));
    if (rec && rec.state !== 'landed' && String(rec.repo).toLowerCase() === String(repo).toLowerCase()
      && (rec.members || []).some((m) => m.pr === Number(pr) && m.head === head)) return rec;
  }
  return null;
}

// True when main's subjects since the batch base are exactly the first k members, in order.
function isBatchPrefix(rec, subjects) {
  return subjects.length <= rec.members.length && subjects.every((s, i) => s === subject(rec.members[i]));
}

function out(obj, code = 0) {
  fs.writeSync(1, `${JSON.stringify(obj, null, 2)}\n`);
  process.exit(code);
}
const refuse = (reason, extra = {}) => out({ ok: false, reason, ...extra }, 1);
const need = (id) => readBatch(id) || refuse(`no batch record "${id}" in ${slash(BATCH_DIR)}`);

function newId() {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  let id = stamp;
  for (let n = 2; fs.existsSync(recordPath(id)); n++) id = `${stamp}-${n}`;
  return id;
}

// A second batch built on the same main is thrown away when the first lands, so
// a batch holds the line until main moves, its CI fails, or its lease ends. A batch left waiting on the user stops
// holding the line when the lease ends.
const LEASE_MS = 15 * 60e3;
function batchUnderTest(repo, base, prs, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(BATCH_DIR).filter((f) => f.endsWith('.json')); } catch (_e) { return null; }
  for (const f of names) {
    const rec = readBatch(f.slice(0, -'.json'.length));
    if (!rec || !['built', 'opened'].includes(rec.state) || rec.base !== base) continue;
    if (String(rec.repo).toLowerCase() !== String(repo).toLowerCase() || (rec.members || []).some((m) => prs.includes(m.pr))) continue;
    const t = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(rec.id);
    const left = t ? Date.UTC(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +t[6]) + LEASE_MS - now : 0;
    if (left <= 0) continue;
    if (rec.batchPr && checksFailed(rec.repo, prChecks(rec.repo, rec.batchPr))) continue;
    return { rec, minutes: Math.ceil(left / 60e3) };
  }
  return null;
}

function build(o) {
  const prs = String(o.prs || '').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
  if (!o.repo || !o.dir || !prs.length) refuse('build needs --dir <worktree>, --repo <owner/name> and --prs <n,n,...>');
  const dir = path.resolve(o.dir);
  const status = git(dir, 'status', '--porcelain', '--untracked-files=no');
  if (status.code !== 0 || status.out) refuse(`${slash(dir)} is not a clean git worktree: build checks out a new branch there`);
  const views = {};
  for (const pr of prs) views[pr] = prView(o.repo, pr);
  const undeclared = declarationProblem(prs.filter((pr) => views[pr] && views[pr].title).map((pr) => ({ pr, body: views[pr].body })));
  if (undeclared) refuse(undeclared);
  const fetched = git(dir, 'fetch', '-q', 'origin', 'main');
  if (fetched.code !== 0) refuse(`git fetch origin main failed: ${fetched.err}`);
  const base = git(dir, 'rev-parse', 'origin/main').out;
  const busy = batchUnderTest(o.repo, base, prs);
  if (busy) refuse(`batch ${busy.rec.id} (${busy.rec.members.map((m) => `#${m.pr}`).join(', ')}) is under test on this main, and a second batch now would be thrown away when it lands. Build again once it lands or its CI fails, at most ${busy.minutes} min from now`);
  const id = newId();
  const branch = `batch/${id}`;
  const co = git(dir, 'checkout', '-q', '-B', branch, base);
  if (co.code !== 0) refuse(`could not create ${branch}: ${co.err}`);

  const members = [];
  const dropped = [];
  for (const pr of prs) {
    const view = views[pr];
    if (!view || !view.title) { dropped.push({ pr, reason: 'could not read the PR from GitHub' }); continue; }
    const f = git(dir, 'fetch', '-q', 'origin', `pull/${pr}/head`);
    if (f.code !== 0) { dropped.push({ pr, reason: `git fetch pull/${pr}/head failed: ${f.err}` }); continue; }
    const head = git(dir, 'rev-parse', 'FETCH_HEAD').out;
    if (view.headRefOid && view.headRefOid !== head) {
      dropped.push({ pr, reason: `GitHub says head ${view.headRefOid.slice(0, 9)}, the fetch got ${head.slice(0, 9)}` });
      continue;
    }
    const m = git(dir, 'merge', '--no-ff', '--no-edit', head);
    if (m.code !== 0) {
      const files = git(dir, 'diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
      git(dir, 'merge', '--abort');
      dropped.push({ pr, reason: files.length ? `conflicts with main or an earlier member in ${files.join(', ')}` : `merge failed: ${m.err || m.out}` });
      continue;
    }
    members.push({ pr, head, title: view.title });
  }
  if (!members.length) refuse('every PR was dropped, so there is no batch', { dropped });
  const missing = missingPartProblem(members.map((m) => ({ pr: m.pr, body: views[m.pr].body })));
  if (missing) refuse(missing, { dropped });

  const rec = { id, repo: o.repo, dir: slash(dir), base, head: git(dir, 'rev-parse', 'HEAD').out, members, dropped, batchPr: null, state: 'built' };
  save(rec);
  const list = members.map((m) => `#${m.pr}`).join(', ');
  out({ ...rec, next: [
    `git -C ${q(rec.dir)} push -u origin ${branch}`,
    `gh pr create --draft --base main --head ${branch} -R ${o.repo} --title ${q(`Batch ${id}: ${list}`)} --body ${q(`Tested batch of ${list} on main ${base.slice(0, 9)}. Never merged itself: its members land on main as squash merges in this order.`)}`,
    `node ${q(SELF)} opened --id ${id} --batch-pr <the number gh printed>`,
  ] });
}

function opened(o) {
  const rec = need(o.id);
  const n = Number(o['batch-pr']);
  if (!(n > 0)) refuse('opened needs --batch-pr <number>');
  rec.batchPr = n;
  rec.state = 'opened';
  save(rec);
  out(rec);
}

function planLand(o) {
  const rec = need(o.id);
  if (!o.bodies) refuse('plan-land needs --bodies <dir> holding <pr>.md for each member');
  if (!rec.batchPr) refuse(`batch ${rec.id} has no batch PR: run opened --id ${rec.id} --batch-pr <n> first`);
  const bp = prView(rec.repo, rec.batchPr);
  if (!bp || bp.headRefOid !== rec.head) {
    refuse(`batch PR #${rec.batchPr} is at ${bp && bp.headRefOid ? bp.headRefOid.slice(0, 9) : 'an unreadable head'}, not the tested ${rec.head.slice(0, 9)}: rebuild the batch`);
  }
  const problem = checksProblem(rec.repo, prChecks(rec.repo, rec.batchPr));
  if (problem) refuse(`batch PR #${rec.batchPr}: ${problem}, not passing`);
  const f = git(rec.dir, 'fetch', '-q', 'origin', 'main');
  if (f.code !== 0) refuse(`git fetch origin main failed: ${f.err}`);
  const main = git(rec.dir, 'rev-parse', 'origin/main').out;
  if (main !== rec.base) refuse(`origin/main moved to ${main.slice(0, 9)} since the batch was built on ${rec.base.slice(0, 9)}: rebuild the batch`);
  for (const m of rec.members) {
    const v = prView(rec.repo, m.pr);
    if (!v || v.headRefOid !== m.head) refuse(`PR #${m.pr} is no longer at the tested head ${m.head.slice(0, 9)}: rebuild the batch`);
  }
  const last = rec.members.length - 1;
  // With no ignore step in main's vercel.json, Vercel builds every [batch-part] commit, each an untested tree, to
  // production. A repo with no vercel.json has no Vercel build to skip; mergeGate.batchIgnoreCheck 'none' skips this.
  if (last > 0 && MG.batchIgnoreCheck === 'vercel' && git(rec.dir, 'ls-tree', '--name-only', 'origin/main', 'vercel.json').out) {
    const v = parsed(git(rec.dir, 'show', 'origin/main:vercel.json').out) || {};
    if (!/vercel-ignore-build/.test(String(v.ignoreCommand || ''))) {
      refuse(`main's vercel.json has no ignoreCommand running scripts/vercel-ignore-build.mjs, so Vercel would build each [batch-part] commit to production: land that change first, or batch one PR at a time`);
    }
  }
  const summaries = rec.members.map((m, i) => {
    const p = path.join(o.bodies, `${m.pr}.md`);
    let s;
    try { s = fs.readFileSync(p, 'utf8').trim(); } catch (_e) { return refuse(`no merge summary at ${slash(p)}`); }
    // only plan-land marks a commit [batch-part]: on the last member that line would skip the batch's production build
    if (i === last && isBatchPart(`${subject(m)}\n\n${s}`)) refuse(`the summary for PR #${m.pr} (${slash(p)}) opens with a line that is exactly [batch-part], which would skip the batch's production build: reword that line`);
    return s;
  });
  const commands = rec.members.map((m, i) => {
    const file = path.join(o.bodies, `${m.pr}.body.md`);
    fs.writeFileSync(file, i === last ? `${summaries[i]}\n\nBatch-Head: ${rec.head}\n` : `[batch-part]\n\n${summaries[i]}\n`);
    // --match-head-commit: GitHub refuses the merge if the PR moved after the batch tested it.
    return `gh pr merge ${m.pr} -R ${rec.repo} --squash --subject ${q(subject(m))} --body-file ${q(slash(path.resolve(file)))} --match-head-commit ${m.head}`;
  });
  rec.state = 'landing';
  save(rec);
  out({ ok: true, id: rec.id, commands, then: `node ${q(SELF)} verify --id ${rec.id}` });
}

function verify(o) {
  const rec = need(o.id);
  const f = git(rec.dir, 'fetch', '-q', 'origin', 'main');
  if (f.code !== 0) refuse(`git fetch origin main failed: ${f.err}`);
  const subjects = git(rec.dir, 'log', '--reverse', '--format=%s', `${rec.base}..origin/main`).out.split('\n').filter(Boolean);
  let k = 0;
  while (k < rec.members.length && subjects[k] === subject(rec.members[k])) k++;
  const tree = (ref) => git(rec.dir, 'rev-parse', `${ref}^{tree}`).out;
  const treeMatch = sameTree(tree('origin/main'), tree(rec.head));
  const n = rec.members.length;
  const result = { id: rec.id, landed: `${k}/${n}`, treeMatch };
  if (k === n && treeMatch) {
    rec.state = 'landed';
    save(rec);
    out({ ...result, state: rec.state });
  }
  rec.state = 'partial';
  save(rec);
  const list = (ms) => ms.map((m) => `#${m.pr}`).join(', ');
  const deployLast = `wait for main's checks to pass on origin/main's tip, then deploy production from a worktree at origin/main`;
  let recovery;
  if (k > 0 && k < n) {
    // parts 1..k skipped their production builds by design; only the last member's commit builds production
    recovery = `PRODUCTION IS BEHIND MAIN: ${list(rec.members.slice(0, k))} landed as [batch-part] commits, which skip their production builds, and ${list(rec.members.slice(k))} did not land. Recover by landing ${list(rec.members.slice(k))} in order with the rest of the commands plan-land printed (the last one builds production); if they cannot land, ${deployLast}.`;
  } else if (k === n) {
    recovery = `every member landed, but main's tree is not the tested batch head ${rec.head.slice(0, 9)}, so what production built is a tree no batch tested: tell the user before anything else lands.`;
  } else {
    recovery = `none of the batch landed${subjects.length ? ` and main gained ${JSON.stringify(subjects)}` : ''}, so production did not move for it: rebuild the batch.`;
  }
  if (k > 0) fs.writeSync(2, `${recovery}\n`);
  out({ ...result, state: rec.state, recovery }, 1);
}

function opts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  return o;
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const run = { build, opened, 'plan-land': planLand, verify }[cmd];
  if (!run) refuse('usage: merge-batch.js build|opened|plan-land|verify (see the header of this file)');
  run(opts(rest));
}

module.exports = { BATCH_DIR, checksProblem, readBatch, findBatchFor, isBatchPrefix, isBatchPart, sameTree, landingBodyProblem };
