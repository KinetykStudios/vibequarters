#!/usr/bin/env node
// vibequarters :: PreToolUse(Bash|PowerShell|deploy MCP tools|Edit|Write|MultiEdit|NotebookEdit)
// Denies outright what guard-bash.js only asks about. An unattended session can approve an ask by itself, so actions that
// cannot be undone are refused here: dropping or truncating a production database, force pushes, committed secrets, mass
// deletes, disk wipes, disabling access rules, and releasing code whose tests did not pass. The user can still do any of
// them with VIBEQUARTERS_GUARD=off. FAILS OPEN on a bug of its own; a GitHub read that fails is not a bug, and it denies.
// Tunable in vibequarters.config.json: mergeGate.* (required checks, batch repos, live and protected branches, the GitHub
// read budget), massDelete.* (file limit, project folder names) and the `locks` rows marked deployGate.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('./vibequarters-config');
const CFG = P.load();
const MG = CFG.mergeGate;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function allow() { process.exit(0); }

function respond(permissionDecision, permissionDecisionReason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason },
  }));
  process.exit(0);
}

const TEXT_ROUTE = 'If the words only appear in text (a commit message, a PR body), put that text in a file with Write and pass the file.';

function deny(kind, cmd) {
  respond('deny',
    `vibequarters [DENY]: "${kind}" is on the catastrophic-irreversible deny list and is ` +
    `blocked for the autonomous agent - this is a hard safety rule that no self-approval can ` +
    `override. If YOU intend to do this deliberately, set VIBEQUARTERS_GUARD=off and run it yourself. ` +
    `${TEXT_ROUTE} Payload: ${cmd.length > 200 ? cmd.slice(0, 200) + '...' : cmd}`);
}

// Nothing goes live without its tests.
const gate = (text) => respond('deny', `vibequarters [DENY]: ${text} No self-approval overrides this: tell the user, ` +
  `who can do it themselves or set VIBEQUARTERS_GUARD=off. ${TEXT_ROUTE}`);
let input = {};
const askUser = (text) => {
  const reason = `vibequarters: ${text} Only the user can approve this.`;
  try { require('./hq-ask-mark.js').markAsk(input, 'guard-deny-catastrophic.js', reason); } catch (_e) { /* the ask still prints */ }
  respond('ask', reason);
};

const FILE_LIMIT = Number(CFG.massDelete.fileLimit) > 0 ? Number(CFG.massDelete.fileLimit) : 10; // a mass delete: over this many files
// The project folders a recursive delete may never take whole (massDelete.projectDirs).
const PROJECT_NAMES = (Array.isArray(CFG.massDelete.projectDirs) ? CFG.massDelete.projectDirs : P.DEFAULTS.massDelete.projectDirs)
  .filter((n) => typeof n === 'string' && n).map(escapeRe).join('|') || 'src';
const BUILD_DIR = /^(node_modules|\.next|\.nuxt|dist|build|out|\.turbo|\.cache|coverage|__pycache__|\.pytest_cache|\.vercel|target|\.svelte-kit|\.parcel-cache|test-results|playwright-report)$/i;
const PROJECT_DIR = new RegExp(`^(?:${PROJECT_NAMES})$`, 'i');
const RM_FRONT = String.raw`(?:\\|[^\s;&|("']*[\\/]bin[\\/])?`; // \rm and /bin/rm are rm
const DELETE_AT = new RegExp(String.raw`(?:^|[\s;&|("'])${RM_FRONT}(rm|ri|del|erase|rd|rmdir|remove-item|rimraf)(?=(?:\.exe)?\s)`, 'gi');
const UNCOUNTABLE = /[$%`*?]|^\.{1,2}[\\/]*$|^[\\/]+$|^~[\\/]*$|^[a-z]:[\\/]*$|^\/[a-z]\/?$/i; // /c is Git Bash's C drive
const LISTED_BY_COMMAND = /\$\([^)]*$|^`[^`]*$/; // the first word of rm $(git ls-files src), split on its spaces
const CMD_VERB = /^(?:del|erase|rd|rmdir)$/; // only cmd.exe's verbs take /s; to rm, /c is a path
const LOOP_DELETE = new RegExp(String.raw`(?:\b(?:(?:for\s+\S+\s+in|while)\b[^\n]*?\bdo\b|foreach\s*\([^)]*\)\s*\{|foreach(?:-object)?\s*\{)|%\s*\{)[^\n}]*?[\s;&|("']${RM_FRONT}(?:rm|del|erase|ri|remove-item)(?:\.exe)?\s`, 'i');
const MOVES = /(?:^|[;&|\n(]\s*)(?:cd|pushd|set-location|sl)\s/i;
const RECURSIVE_FLAG = /^(?:-[fidv]*r[fidv]*|--recursive|-rec[a-z]*)$/i; // -r, -rf, -fR, -Recurse; never -Force or -ErrorAction
// Spelled out, not L.GIT_OPTS: the regex tier must still work when coord-lib cannot load. Not git stash push.
const GIT_PUSH = String.raw`\bgit(?:\.exe)?(?:\s+-[cC]\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)|\s+-[pP](?=\s)|\s+--(?:git-dir|work-tree|namespace|exec-path|config-env)\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+push\b`;
const FLAG_END = String.raw`(?=[\s=;&|)"']|$)`;
const PROJECT_TARGET = String.raw`(?:\s|["'\/\\])(?:${PROJECT_NAMES})[\/\\]*["']?(?=[\s;&|)]|$)`;
// The remote branches a push may never delete (mergeGate.protectedBranches; a trailing /* means any branch below it).
const PROTECTED = (Array.isArray(MG.protectedBranches) ? MG.protectedBranches : ['main', 'master'])
  .map((b) => (String(b).endsWith('/*') ? `${escapeRe(String(b).slice(0, -1))}[^\\s;&|)]+` : escapeRe(b))).join('|') || 'main';
const PROTECTED_REF = new RegExp(`^(?:${PROTECTED})$`, 'i');
const FORCE_PUSH = 'force-push (rewrites shared history; any branch, --force-with-lease and +refspec included)';
const DELETE_PROTECTED = 'deleting a protected branch on the remote';

// The files under a path, counting no further than one past the limit. An unreadable folder cannot be proved small.
function countFiles(p) {
  let n = 0;
  const walk = (x) => {
    if (n > FILE_LIMIT) return;
    let st;
    try { st = fs.lstatSync(x); } catch (_e) { return; }
    if (!st.isDirectory()) { n++; return; }
    let names;
    try { names = fs.readdirSync(x); } catch (_e) { n = FILE_LIMIT + 1; return; }
    for (const name of names) walk(path.join(x, name));
  };
  walk(p);
  return n;
}

// Why these delete arguments are a mass delete, or null. A relative path means nothing after a cd.
function deleteVerdict(args, recursive, cwd, moved, L, named) {
  const lost = (a) => moved && !path.isAbsolute(a) && !a.startsWith('~');
  if (recursive) {
    for (const a of args) {
      if (UNCOUNTABLE.test(a) || lost(a)) return `a recursive delete of "${a}", whose size cannot be counted`;
      const p = L.fromShellPath(a, cwd);
      const name = path.basename(p);
      if (BUILD_DIR.test(name) || L.key(p).startsWith(`${L.key(os.tmpdir())}/`)) continue;
      if (PROJECT_DIR.test(name)) return `a recursive delete of the project folder "${a}"`;
      if (countFiles(p) > FILE_LIMIT) return `a recursive delete of "${a}", which holds more than ${FILE_LIMIT} files`;
    }
    return null;
  }
  if (args.some((a) => LISTED_BY_COMMAND.test(a))) return 'a delete whose list comes from a command, so its size cannot be counted';
  if (named > FILE_LIMIT) return `a delete naming more than ${FILE_LIMIT} files`;
  for (const a of args) {
    if (!/[*?]/.test(a) || /[$%`]/.test(a)) continue;
    if (lost(a)) return `a delete of "${a}", whose size cannot be counted`;
    let hits;
    try { hits = fs.globSync(a, { cwd }); } catch (_e) { return `a delete of "${a}", whose size cannot be counted`; }
    if (hits.length > FILE_LIMIT) return `a delete of "${a}", which matches more than ${FILE_LIMIT} files`;
  }
  return null;
}

function massDelete(cmd, cwd, L) {
  const run = L.runnable(cmd); // a commit message saying rm -rf deletes nothing; bash -c "rm -rf x" does
  if (LOOP_DELETE.test(run)) deny('a delete inside a loop, whose size cannot be counted', cmd);
  const moved = MOVES.test(run);
  for (const m of run.matchAll(DELETE_AT)) {
    const at = cmd.slice(m.index + m[0].length - m[1].length);
    const t = L.denyWords(at);
    const verb = m[1].toLowerCase();
    let recursive = verb === 'rimraf';
    const args = [];
    for (const a of t.slice(1)) {
      if (CMD_VERB.test(verb) && /^\/[a-z]$/i.test(a)) { // cmd.exe: rd /s /q x
        if (a.toLowerCase() === '/s') recursive = true;
      } else if (a.startsWith('-')) {
        if (RECURSIVE_FLAG.test(a)) recursive = true;
      } else {
        const target = a.replace(/\)+$/, '');
        if (target) args.push(target);
      }
    }
    if ((verb === 'rd' || verb === 'rmdir') && !recursive) continue; // only removes an empty folder
    // the count takes each path whole: "$L"/a is one file, however many words it reads as
    const named = L.plainRead(at).runs.slice(1).filter((a) => !a.startsWith('-') && !(CMD_VERB.test(verb) && /^\/[a-z]$/i.test(a)) && a.replace(/\)+$/, '')).length;
    const why = deleteVerdict(args, recursive, cwd, moved, L, named);
    if (why) deny(why, cmd);
  }
}

const FAKE = process.env.VIBEQUARTERS_GUARD_FAKE_GH ? JSON.parse(process.env.VIBEQUARTERS_GUARD_FAKE_GH) : null;

// Every GitHub read shares one time budget, under this hook's settings.json timeout: a hook that times out lets the
// call through, so past the budget the merge or deploy is denied instead.
const GH_BUDGET_MS = Number(process.env.VIBEQUARTERS_GUARD_GH_BUDGET_MS) || Number(MG.ghBudgetMs) || 40000;
const GH_DEADLINE = Date.now() + GH_BUDGET_MS;
const overBudget = () => gate(`GitHub reads ran past this guard's ${GH_BUDGET_MS / 1000} s time budget, so nothing proves this is safe. Retry when gh answers faster.`);

function gh(args, cwd) {
  const left = GH_DEADLINE - Date.now();
  if (left <= 0) overBudget();
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: Math.min(20000, left), windowsHide: true });
  if (r.error && r.error.code === 'ETIMEDOUT' && Date.now() >= GH_DEADLINE) overBudget();
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const parsed = (s) => { try { return JSON.parse(s); } catch (_e) { return null; } };

// The checks that prove a repo's tests: its mergeGate.requiredChecks entry, else the required status checks of the
// branch's protection on GitHub (mergeGate.readBranchProtection). [] when there are none: then a merge, push or deploy
// asks the user. A read that fails denies, except for a branch that is not on GitHub yet, which has no protection.
function requiredChecks(slug, branch, cwd) {
  const k = String(slug || '').toLowerCase();
  for (const [repo, v] of Object.entries(MG.requiredChecks || {})) {
    if (repo.toLowerCase() === k) return [].concat(v).filter((s) => typeof s === 'string' && s);
  }
  if (!k || !branch || MG.readBranchProtection === false) return [];
  const unread = () => gate(`could not read which checks "${branch}" of ${slug} requires from GitHub, so nothing proves this is safe. ` +
    'Retry when gh works (gh auth login), or list the repository in mergeGate.requiredChecks of vibequarters.config.json (an empty list when it has none).');
  if (FAKE) return FAKE.protection === null ? unread() : Array.isArray(FAKE.protection) ? FAKE.protection : [];
  const r = gh(['api', `repos/${slug}/branches/${encodeURIComponent(branch)}`, '--jq', '.protection.required_status_checks.contexts // [] | .[]'], cwd);
  if (r.code === 0) return r.out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (/HTTP 404/.test(r.err) && gh(['api', `repos/${slug}`, '--jq', '.id'], cwd).code === 0) return [];
  return unread();
}
const names = (list) => list.map((n) => `"${n}"`).join(', ');

function readPr(selector, repoFlag, cwd) {
  if (FAKE) return FAKE.view;
  return parsed(gh(['pr', 'view', ...(selector ? [selector] : []), ...(repoFlag ? ['-R', repoFlag] : []), '--json', 'number,url,baseRefName,headRefOid'], cwd).out);
}

// The repository's default branch on GitHub, or null when it cannot be read
function readDefault(slug, cwd) {
  if (FAKE) return FAKE.defaultBranch === undefined ? 'main' : FAKE.defaultBranch;
  const r = gh(['api', `repos/${slug}`, '--jq', '.default_branch'], cwd);
  return r.code === 0 ? r.out.trim() || null : null;
}

function readBatchPr(number, slug, cwd) {
  if (FAKE) return FAKE.batchView;
  return parsed(gh(['pr', 'view', String(number), '-R', slug, '--json', 'number,headRefOid'], cwd).out);
}

function readBatchChecks(number, slug, cwd) {
  if (FAKE) return FAKE.batchChecks;
  return parsed(gh(['pr', 'checks', String(number), '-R', slug, '--json', 'name,bucket'], cwd).out);
}

// GitHub's compare of base...head: "ahead" or "identical" means head contains base.
function readCompare(slug, base, head, cwd, fakeKey = 'compare') {
  if (FAKE) return FAKE[fakeKey];
  return gh(['api', `repos/${slug}/compare/${base}...${head}`, '--jq', '.status'], cwd).out.trim();
}

// main's vercel.json, parsed, or null when GitHub could not say.
function readMainVercel(slug, cwd) {
  if (FAKE) return FAKE.vercelJson;
  const r = gh(['api', `repos/${slug}/contents/vercel.json?ref=main`, '--jq', '.content'], cwd);
  return r.code === 0 ? parsed(Buffer.from(r.out, 'base64').toString('utf8')) : null;
}

// main's commit subjects since the batch base, oldest first, or null when GitHub could not say.
function readMainSubjects(slug, base, cwd) {
  if (FAKE) return FAKE.mainSubjects;
  const r = gh(['api', `repos/${slug}/compare/${base}...main`, '--jq', '[.commits[].commit.message | split("\\n")[0]]'], cwd);
  return r.code === 0 ? parsed(r.out) : null;
}

// A PR reaches main only inside a tested batch (merge-batch.js): merged with main and the rest of its batch, and that
// exact tree passed the full suite on the batch PR. A single PR is a batch of one.
function batchGate(pr, slug, required, cwd, t) {
  try { batchChecks(pr, slug, required, cwd, t); } catch (_e) {
    gate(`could not read PR #${pr.number}'s batch record through, so nothing proves it passed in a tested batch.`);
  }
}

// t: the merge command's tokens, whose body decides whether Vercel builds the commit it lands.
function batchChecks(pr, slug, required, cwd, t) {
  const build = `node "${path.join(__dirname, 'merge-batch.js').replace(/\\/g, '/')}" build --repo ${slug} --prs ${pr.number} --dir <your worktree>`;
  let MB;
  try { MB = require('./merge-batch.js'); } catch (_e) { gate(`could not load merge-batch.js, so nothing proves PR #${pr.number} passed in a tested batch.`); }
  const rec = pr.headRefOid ? MB.findBatchFor(slug, pr.number, pr.headRefOid) : null;
  if (!rec) gate(`PR #${pr.number} at ${String(pr.headRefOid || '?').slice(0, 9)} is in no tested batch, so its code was never tested merged with main. Build one, even for a single PR: ${build}`);
  if (!rec.batchPr) gate(`batch ${rec.id} has no batch PR yet, so its full suite never ran. Run the push and gh pr create --draft that merge-batch.js build printed.`);
  const bp = readBatchPr(rec.batchPr, slug, cwd);
  if (!bp || bp.headRefOid !== rec.head) gate(`batch PR #${rec.batchPr} is not at the tested head ${rec.head.slice(0, 9)}. Rebuild the batch: ${build}`);
  const bc = readBatchChecks(rec.batchPr, slug, cwd) || [];
  const unproven = required.length ? !required.every((n) => bc.some((c) => c.name === n && c.bucket === 'pass')) : MB.checksProblem(slug, bc);
  if (unproven) {
    gate(`batch PR #${rec.batchPr} has no passing ${required.length ? names(required) : 'full suite'} at ${rec.head.slice(0, 9)}. Wait for its full suite: gh pr checks ${rec.batchPr} -R ${slug} --watch`);
  }
  const status = readCompare(slug, pr.headRefOid, rec.head, cwd);
  if (status !== 'ahead' && status !== 'identical') {
    gate(`batch head ${rec.head.slice(0, 9)} does not contain PR #${pr.number}'s head (GitHub compare: ${status || 'unreadable'}). Rebuild the batch: ${build}`);
  }
  const baseStatus = readCompare(slug, rec.base, rec.head, cwd, 'baseCompare');
  if (baseStatus !== 'ahead' && baseStatus !== 'identical') {
    gate(`batch head ${rec.head.slice(0, 9)} does not contain the batch base ${String(rec.base).slice(0, 9)} (GitHub compare: ${baseStatus || 'unreadable'}), so the tested tree is not main plus its members. Rebuild the batch: ${build}`);
  }
  // main may hold only the members before this one, in order; anything else means the tested tree is not what lands
  const subjects = readMainSubjects(slug, rec.base, cwd);
  const next = Array.isArray(subjects) && MB.isBatchPrefix(rec, subjects) ? rec.members[subjects.length] : null;
  if (!next || next.pr !== pr.number) {
    gate(`main is not where batch ${rec.id} expects it before PR #${pr.number} (since ${String(rec.base).slice(0, 9)} it holds ${Array.isArray(subjects) ? JSON.stringify(subjects) : 'unreadable commits'}), so what lands is not the tree that passed. Rebuild the batch: ${build}`);
  }
  const problem = MB.landingBodyProblem(rec, pr.number, t, cwd);
  if (problem) gate(`PR #${pr.number} is next in batch ${rec.id}, but ${problem}.`);
  if (next !== rec.members[rec.members.length - 1] && MG.batchIgnoreCheck === 'vercel') {
    const v = readMainVercel(slug, cwd);
    if (!v || !/vercel-ignore-build/.test(String(v.ignoreCommand || ''))) {
      gate(`main's vercel.json ${v ? 'has no' : 'could not be read to prove its'} ignoreCommand running scripts/vercel-ignore-build.mjs, so Vercel would build this [batch-part] commit, a tree no test saw, to production. Land that change first, or batch one PR at a time.`);
    }
  }
}

// The paths a PR deletes, or null when GitHub could not say. gh pr view --json files stops at 100 files.
function readDeleted(number, slug, cwd) {
  if (FAKE) {
    if (FAKE.deleted !== undefined) return FAKE.deleted;
    return ((FAKE.view && FAKE.view.files) || []).filter((f) => f.changeType === 'DELETED').map((f) => f.path);
  }
  const r = gh(['api', `repos/${slug}/pulls/${number}/files`, '--paginate', '--jq', '.[] | select(.status=="removed") | .filename'], cwd);
  return r.code === 0 ? r.out.split('\n').filter(Boolean) : null;
}

// [] when GitHub says no check ever ran; null when it could not say. gh prints the JSON whatever the checks' state.
function readChecks(number, slug, cwd) {
  if (FAKE) return FAKE.checks;
  const r = gh(['pr', 'checks', String(number), '-R', slug, '--json', 'name,bucket'], cwd);
  return parsed(r.out) || (/no checks reported/i.test(r.err) ? [] : null);
}

function readCommitCheck(slug, sha, name, cwd) {
  if (FAKE) return FAKE.commit;
  return gh(['api', '-X', 'GET', `repos/${slug}/commits/${sha}/check-runs`, '-f', `check_name=${name}`, '--jq', '.check_runs[0].conclusion'], cwd).out.trim();
}

// The home whose reviews and reviewer records review-proof.js reads; tests point it at a fixture.
const REVIEW_HOME = process.env.VIBEQUARTERS_REVIEW_HOME || os.homedir();

// A merge to main needs a fresh reviewer subagent (on mergeGate.reviewerModel) of this session to have passed this exact head
// (review-proof.js), briefed against the PR's base as GitHub names it, never as the tab or the verdict file says. The
// merge must also carry --match-head-commit <that head>, so GitHub refuses it if the PR moves after this check.
function reviewGate(pr, slug, sessionId, matchHead) {
  if (MG.requireReview === false) return;
  let r;
  try {
    r = require('./review-proof.js').proveReview({
      repo: String(slug).split('/')[1], pr: pr.number, head: pr.headRefOid, sessionId, base: `origin/${pr.baseRefName}`, home: REVIEW_HOME,
    });
  } catch (e) { r = { ok: false, reason: `review-proof.js could not run (${e && e.message})` }; }
  if (!r.ok) gate(`PR #${pr.number} at ${String(pr.headRefOid || '?').slice(0, 9)} has no clean fresh review: ${r.reason}. See section 2 of /land, then merge.`);
  if (String(matchHead || '').toLowerCase() !== String(pr.headRefOid).toLowerCase()) {
    gate(`PR #${pr.number}'s merge must carry --match-head-commit ${pr.headRefOid}, the head its review proved (it has ${matchHead ? `--match-head-commit ${matchHead}` : 'none'}), so GitHub refuses the merge if the PR moved since.`);
  }
}

// Reviewer subagent records (<home>/.claude/projects/<key>/<session>/subagents) are what reviewGate trusts, so no tab
// may write them. A command that moves, copies or links a folder tree into projects, a whole key folder, or a
// session-shaped folder (a UUID, as Claude Code names sessions) could carry a forged <session>/subagents in, so those
// destinations count too. New-Item only carries a tree in as a link, or by making a session-shaped folder.
const TREE_CARRIER = /^(?:mv|move|move-item|mi|cp|copy|copy-item|cpi|rsync|ln|install|new-item|ni|rename-item|rni|ren)$/;
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Rename-Item resolves -NewName against the item's parent, not the cwd, so any session-shaped word renames into one.
const RENAME = /^(?:rename-item|rni|ren)$/;
// A word as PowerShell passes its value: -NewName:"x" and "x" both mean x.
const bareValue = (x) => String(x).replace(/^-[a-z][\w-]*:/i, '').replace(/^["']|["']$/g, '');
// New-Item's -ItemType (alias -Type, any abbreviation, -Name:value too): only a file or a folder carries nothing in.
// No type means a file. Any other value, a link type or a variable, could make a junction to a forged tree.
function newItemMakesLink(words) {
  for (let i = 0; i < words.length; i++) {
    const m = /^-([a-z]+)(?::(.*))?$/i.exec(words[i]);
    if (!m) continue;
    const flag = m[1].toLowerCase();
    if (!('itemtype'.startsWith(flag) || (flag.length > 1 && 'type'.startsWith(flag)))) continue;
    const value = bareValue(m[2] !== undefined ? m[2] : words[i + 1] || '').toLowerCase();
    if (!value || !('file'.startsWith(value) || 'directory'.startsWith(value))) return true;
  }
  return false;
}
function recordsFind(L) {
  const projects = L.key(path.join(REVIEW_HOME, '.claude', 'projects'));
  const HIT = { name: 'reviewer records' };
  return (p, dir, _peers, head, ctx = {}) => {
    const k = L.key(L.fromShellPath(p, dir));
    if (k !== projects && !k.startsWith(`${projects}/`)) return null;
    const rest = k === projects ? [] : k.slice(projects.length + 1).split('/');
    if (rest[2] === 'subagents') return HIT;
    const h = String(head || '');
    if (!TREE_CARRIER.test(h)) return null;
    const session = rest.length === 2 && SESSION_DIR.test(rest[1]);
    if (session) return HIT;
    if (ctx.here) return null; // the folder a command runs in is judged only when it is a session
    if (RENAME.test(h) && (ctx.words || []).some((x) => SESSION_DIR.test(bareValue(x).split(/[\\/]/).pop()))) return HIT;
    if (rest.length > 1) return null;
    if (/^(?:new-item|ni)$/.test(h)) return newItemMakesLink(ctx.words || []) ? HIT : null;
    return HIT;
  };
}
const recordsDeny = (what) => respond('deny', `vibequarters [DENY]: ${what}. Reviewer subagent records ` +
  '(~/.claude/projects/<project>/<session>/subagents) are the proof the merge gate trusts that a review ran, so only ' +
  'Claude Code itself writes them: a tab that could would forge a review. Reading them is fine. No self-approval ' +
  'overrides this: tell the user.');

function judgeMerge(cmd, start, cwd, L, M, sessionId) {
  const t = L.tokens(L.unquoteWords(cmd).slice(start)).map((a) => a.replace(/[)`]+$/, '')); // "`gh pr merge 5 --admin`" ends in its closing backtick
  const args = L.mergeArgs(t);
  if (args.admin || args.auto) {
    gate('gh pr merge --admin and --auto both skip the tests: without branch protection, --auto merges at once.');
  }
  const to = M.mergeTarget(cmd, start, cwd); // the repo a PR URL, -R, GH_REPO or a cd names; null when none can be read
  const repoFlag = (to && to.slug) || args.repo || '';
  const pr = readPr(args.pr, repoFlag, (to && to.dir) || cwd);
  if (!pr) gate('could not read this PR from GitHub, so nothing proves its tests passed. Retry when gh works.');
  const slug = (/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url) || [])[1] || repoFlag;
  if (!P.branchIn(pr.baseRefName, MG.liveBranches)) {
    if (JSON.stringify(MG.liveBranches) !== JSON.stringify(P.DEFAULTS.mergeGate.liveBranches)) return; // the list you set is the whole list
    const def = readDefault(slug, cwd);
    if (!def) gate(`could not read the default branch of ${slug} from GitHub, so nothing proves ${pr.baseRefName} is not live. Retry when gh works.`);
    if (pr.baseRefName !== def) return; // a release branch is not live
  }
  const checks = readChecks(pr.number, slug, cwd);
  if (!checks) gate(`could not read PR #${pr.number}'s checks from GitHub, so nothing proves its tests passed. Retry when gh works.`);
  const named = (...buckets) => checks.filter((c) => buckets.includes(c.bucket)).map((c) => c.name);
  const red = named('fail', 'cancel');
  if (red.length) gate(`PR #${pr.number} did not pass: ${red.join(', ')}. Nothing goes live without its tests passing. Fix it and let CI rerun.`);
  const waiting = named('pending');
  if (waiting.length) gate(`PR #${pr.number}'s checks are still running: ${waiting.join(', ')}. Wait with gh pr checks ${pr.number} -R ${slug} --watch, then merge.`);
  const required = requiredChecks(slug, pr.baseRefName, cwd);
  let noTests = null;
  if (required.length) {
    const missing = required.filter((n) => !named('pass').includes(n));
    if (missing.length) gate(`PR #${pr.number} has no passing ${names(missing)} check, the one that proves its tests ran. Nothing goes live without it.`);
  } else if (!named('pass').some((n) => !/vercel/i.test(n))) {
    noTests = `PR #${pr.number} in ${slug}: no tests ran on GitHub, so nothing proves it safe to go live.`;
  }
  if (M.batchRepo(slug)) batchGate(pr, slug, required, cwd, t);
  reviewGate(pr, slug, sessionId, args.matchHead); // before the no-tests ask, so the user is never asked about an unreviewed merge
  if (noTests) askUser(noTests);
  const gone = readDeleted(pr.number, slug, cwd);
  if (!gone) gate(`could not read which files PR #${pr.number} deletes, so nothing proves it is not a mass delete. Retry when gh works.`);
  if (gone.length > FILE_LIMIT) {
    askUser(`PR #${pr.number} deletes ${gone.length} files (${gone.slice(0, 5).join(', ')}, ...): a mass delete, however green.`);
  }
}

// Whether a production deploy from this folder ships code that passed its tests: exactly what main holds, or a commit
// whose own test check is green. Never uncommitted work.
function deployGate(dir, what, watchPaths, L, M) {
  const repo = L.findRepo(dir);
  if (!repo) gate(`${what} from ${dir} has no commit to prove: run it from a worktree of the repo.`);
  const slug = M.githubSlug(repo.top);
  const base = L.baseRef(repo.top);
  const required = requiredChecks(slug, base ? base.replace(/^origin\//, '') : 'main', repo.top);
  if (!required.length) askUser(`${what} from ${slug || repo.top}: this repo has no tests on GitHub, so nothing proves it safe to go live.`);
  const statuses = [L.git(repo.top, ['status', '--porcelain', '--untracked-files=no'])];
  for (const w of watchPaths || []) statuses.push(L.git(repo.top, ['status', '--porcelain', '--', w]));
  if (statuses.some((s) => s.code !== 0)) gate(`${what} from ${repo.top}: could not read its git status, so nothing proves the code is committed. Retry.`);
  if (statuses.some((s) => s.out)) gate(`${what} would ship uncommitted changes in ${repo.top}, which no test has seen. Commit them, let CI pass, then deploy.`);
  // a [batch-part] commit is on main but its own tree was never tested (only its batch's was), so it needs its own check
  const body = L.git(repo.top, ['log', '-1', '--format=%B', 'HEAD']);
  let batchPart = true;
  try { batchPart = body.code !== 0 || require('./merge-batch.js').isBatchPart(body.out); } catch (_e) { /* unprovable: needs its own check */ }
  if (base && !batchPart && L.git(repo.top, ['merge-base', '--is-ancestor', 'HEAD', base]).code === 0) return;
  const sha = L.git(repo.top, ['rev-parse', 'HEAD']).out;
  const failing = required.filter((n) => readCommitCheck(slug, sha, n, repo.top) !== 'success');
  if (failing.length) {
    gate(`${what} of ${sha.slice(0, 9)}: that commit is ${batchPart ? 'a [batch-part] commit, whose own tree no test saw,' : `not on ${base}`} and its ${names(failing)} check has not passed. Nothing goes live without its tests passing.`);
  }
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') allow();

  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const ti = input.tool_input || {};
  const tool = String(input.tool_name || '');
  const cwd = String(input.cwd || process.cwd());
  if (/^(?:Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
    const target = String(ti.file_path || ti.notebook_path || '');
    if (target && recordsFind(require('./coord-lib'))(target, cwd, [], null)) recordsDeny(`${tool} would write ${target}, inside a reviewer records folder`);
    allow();
  }
  // Shell tools put the payload in `command`; MCP database tools put raw SQL in `query` or `sql`.
  // The two sources stay separate so SQL rules can require a SQL context (below) and are then
  // joined for matching.
  const shellPayload = String(ti.command || '');
  const sqlPayload = [ti.query, ti.sql].map((v) => String(v || '')).filter(Boolean).join('\n');
  const cmd = [shellPayload, sqlPayload].filter(Boolean).join('\n');
  // an MCP tool on a lock row marked deployGate runs the deploy gate; Vercel's tools are checked for production moves
  const toolRow = P.lockRows().find((r) => r.deployGate && r.tool && r.tool.test(tool));
  const liveTool = !!toolRow || /vercel/i.test(tool);
  if (!cmd.trim() && !liveTool) allow();

  // A SQL keyword in a shell command is a statement only if something can execute it; otherwise it
  // may be prose in a heredoc. MCP `query`/`sql` fields always count. A shell command counts when it
  // names a SQL client or a database endpoint, as every way of running SQL from a shell does.
  const SQL_CLIENT = /(\bpsql\b|\bmysql\b|\bmariadb\b|\bsqlite3?\b|\bpg_dump\b|\bpg_restore\b|\bpgcli\b|\bsupabase\b|\bprisma\b|\bdrizzle\b|\bknex\b|\bsequelize\b|\bcockroach\b|database\/query|execute_sql|apply_migration|DATABASE_URL|postgres(?:ql)?:\/\/|mysql:\/\/)/i;
  const sqlContext = Boolean(sqlPayload.trim()) || SQL_CLIENT.test(shellPayload);
  const NO_REAL_WHERE = () => !/\bwhere\b/i.test(cmd) || /\bwhere\s+(?:true|1\s*=\s*1)\b/i.test(cmd);

  // Only actions that are both irreversible and wide in effect; guard-bash.js asks about the rest.
  // Rules flagged `sql: true` only apply when sqlContext is true (see above).
  const CATASTROPHIC = [
    { kind: FORCE_PUSH,
      re: new RegExp(String.raw`${GIT_PUSH}[^;&|\n]*(?:\s["']?(?:--force(?:-with-lease|-if-includes)?|-[a-z]*f[a-z]*|--mirror)${FLAG_END}|\s\+\S)`, 'i') },
    { kind: 'force-updating or deleting a branch through the GitHub API',
      re: /\bgh(?:\.exe)?\s+api\b[^;&|\n]*git\/refs\b/i,
      test: () => /(?:-X|--method)[= ]?\s*(?:PATCH|DELETE)\b|force=true/i.test(cmd) },
    { kind: DELETE_PROTECTED,
      re: new RegExp(String.raw`${GIT_PUSH}[^;&|\n]*(?:\s(?:--delete|-d)\b[^;&|\n]*\s|\s:)(?:refs\/heads\/)?(?:${PROTECTED})${FLAG_END}`, 'i') },
    { kind: 'merging through the GitHub API (skips the test gate)',
      re: /\bgh(?:\.exe)?\s+api\b[^;&|\n]*(?:\/pulls\/\d+\/merge\b|\/merges\b|\bgraphql\b[^\n]*\b(?:mergePullRequest|enablePullRequestAutoMerge)\b)/i },
    { kind: 'promoting a preview to production (skips the test gate)',
      re: /\bvercel\s+promote\b|\bvercel\s+api\b[^;&|\n]*\/promote\b/i },
    { kind: 'pointing a domain at a deployment (skips the test gate)',
      re: /\bvercel\s+alias\s+(?!ls\b|list\b)\S/i },
    { kind: 'deleting a repository',
      re: /\bgh(?:\.exe)?\s+repo\s+delete\b|\bgh(?:\.exe)?\s+api\b(?=[^;&|\n]*(?:-X|--method)[= ]?\s*DELETE)[^;&|\n]*\brepos\/[^/\s"']+\/[^/\s"']+(?=["'\s]|$)/i },
    { kind: 'deleting a Supabase or Vercel project',
      re: /\bsupabase\s+projects\s+delete\b|\bvercel\s+(?:projects?\s+)?(?:rm|remove)\b/i },
    { kind: 'production database DROP', sql: true,
      re: /\bdrop\s+(database|schema)\b/i },
    { kind: 'SQL DROP TABLE (destroys a table and its data)', sql: true,
      re: /\bdrop\s+table\b/i },
    // `truncate on` is the trigger event (`before truncate on t`) or a privilege
    // (`revoke truncate on table t`), never a wipe: ON is reserved, so no table can be named it.
    { kind: 'SQL TRUNCATE (table data wipe)', sql: true,
      re: /\btruncate\s+(table\s+)?(?!on\b)["'`\w]/i },
    // Without a WHERE, a DELETE or UPDATE changes the whole table. Payloads with several statements
    // are matched loosely on purpose: a wrong deny is easier to recover from than a wrong allow.
    { kind: 'unscoped DELETE (no real WHERE clause, removes every row)', sql: true,
      re: /\bdelete\s+from\s+["'`\w.]+/i,
      test: NO_REAL_WHERE },
    { kind: 'unscoped UPDATE (no real WHERE clause, rewrites every row)', sql: true,
      re: /\bupdate\s+["'`\w.]+\s+set\b/i,
      test: NO_REAL_WHERE },
    { kind: 'supabase db reset (wipes the database)',
      re: /supabase\s+db\s+reset\b/i },
    { kind: 'mass-delete of a project directory',
      re: new RegExp(String.raw`\brm\s+-[a-z]*r[a-z]*f?[a-z]*\b[^|&;\n]*${PROJECT_TARGET}`, 'i') },
    { kind: 'recursive force-delete of a project directory (PowerShell)',
      re: new RegExp(String.raw`remove-item[^\n|;&]*-recurse[^\n|;&]*-force[^\n|;&]*${PROJECT_TARGET}`, 'i') },
    // Each of these hides how many files it removes, so no count can clear it
    { kind: 'bulk delete through find',
      re: /\bfind\b[^;&|\n]*\s-(?:delete(?=[\s;&|)]|$)|exec(?:dir)?\s+(?:rm|del|shred)\b)/i },
    { kind: 'bulk delete through a pipe',
      re: /(?<!\|)\|(?!\|)\s*(?:xargs\b[^;&|\n]*\b(?:rm|del)\b|(?:remove-item|ri|rm|del|erase)(?=\s|$))/i },
    { kind: 'delete of everything in a folder named by a variable',
      re: /\b(?:rm|del|erase|ri|remove-item)\s[^;&|\n]*[$%][^\s;&|]*[\\/]\*+["']?(?=[\s;&|]|$)/i },
    { kind: 'git clean (deletes every untracked file)',
      re: /\bgit\b[^;&|\n]*\sclean\b(?=[^;&|\n]*(?:\s-[a-z]*f|\s--force))(?![^;&|\n]*(?:\s-[a-z]*n|\s--dry-run))/i },
    { kind: 'forced worktree removal (deletes uncommitted work)',
      re: /\bgit\b[^;&|\n]*\sworktree\s+remove\b[^;&|\n]*\s(?:-f\b|--force\b)/i },
    { kind: 'recursive delete from an inline script',
      re: /\bshutil\.rmtree\b|\brm(?:dir)?Sync\s*\([^)\n]*recursive/i },
    { kind: 'disk format / fork-bomb / dd-to-device',
      re: /\b(mkfs\b|dd\s+if=[^ ]+\s+of=\/dev\/|:\s*\(\)\s*\{|format\s+[a-z]:)/i },
    { kind: 'committing a likely secret (.env / service-role key)',
      re: /git\s+add\b[^|&;]*(\.env\b|service[_-]?role)/i },
  ];

  const flat = cmd.replace(/[\\`]\r?\n/g, '  '); // a line continuation splits no command
  for (const ck of CATASTROPHIC) {
    if (ck.sql && !sqlContext) continue;
    if (!ck.re.test(flat)) continue;
    if (ck.test && !ck.test()) continue;
    deny(ck.kind, cmd);
  }

  let push = null; // the two push rules again, word by word: quotes, escapes, shortened options and -c aliases hide nothing
  try { push = require('./push-read').pushIn(shellPayload, tool, (b) => PROTECTED_REF.test(b)); } catch (_e) { /* a parser bug never skips the checks below */ }
  if (push) deny(push === 'force' ? FORCE_PUSH : DELETE_PROTECTED, cmd);

  if (!shellPayload.trim() && !liveTool) allow(); // SQL has no files to count and no commit to prove

  const L = require('./coord-lib');
  const M = require('./coord-land');

  if (toolRow) {
    deployGate(cwd, toolRow.lock === 'edge-deploy' ? 'An edge deploy' : 'A production deploy', toolRow.watchPaths, L, M);
    allow();
  }
  if (liveTool) {
    if (/__(?:request_promote|assign_alias|start_rolling_release|approve_rolling_release_stage|complete_rolling_release)$/.test(tool)) {
      gate('moving production traffic to a deployment skips the merge gate. Merge the PR instead.');
    }
    const body = ti.requestBody || {};
    const ref = String((body.gitSource && body.gitSource.ref) || '');
    if (/__create_deployment$/.test(tool) && (body.target === 'production' || /^(?:refs\/heads\/)?(?:main|master)$/.test(ref))) {
      gate('the Vercel tool would make a production deployment that skips the merge gate. Merge the PR instead.');
    }
    allow();
  }

  let hit = null;
  try { hit = require('./coord-shell').peerWrite(shellPayload, cwd, [], recordsFind(L), () => null); } catch (_e) { /* a parser bug never skips the checks below */ }
  if (hit) recordsDeny(`this command ${hit.why}: ${hit.target} is in, or could carry in, a reviewer records folder`);

  massDelete(shellPayload, cwd, L);

  const sessionId = String(input.session_id || '');
  for (const start of M.mergeStarts(shellPayload)) judgeMerge(shellPayload, start, cwd, L, M, sessionId);

  const dir = L.targetDir(shellPayload, cwd);
  if (/\bgit\b[^;&|\n]*\spush\b/i.test(shellPayload)) {
    const repo = L.findRepo(dir);
    if (repo && M.hasGitHubRemote(repo.top) && M.pushesDefault(shellPayload, repo.top)) {
      const slug = M.githubSlug(repo.top);
      const def = (L.baseRef(repo.top) || 'origin/main').replace(/^origin\//, '');
      if (requiredChecks(slug, def, repo.top).length) gate(`a direct push to the default branch of ${slug} skips its tests and goes straight to live. Open a PR and let CI pass.`);
      askUser(`a direct push to the default branch of ${slug}: no tests on GitHub prove it safe, and it skips the review gate (no fresh review of its head, which /land runs before a merge).`);
    }
  }
  const run = L.runnable(shellPayload); // grep "vercel --prod" deploys nothing
  for (const row of P.lockRows()) {
    if (row.deployGate && row.shell && row.shell.test(run)) deployGate(dir, row.lock === 'edge-deploy' ? 'An edge deploy' : 'A production deploy', row.watchPaths, L, M);
  }

  allow();
} catch (_e) {
  process.exit(0); // FAIL OPEN
}
