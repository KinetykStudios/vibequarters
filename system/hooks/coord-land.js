// vibequarters :: landing helpers: `ship` (the /land steps, and a fixer session's one /land tab per PR) and the reading of
// gh pr merge / git push commands that guard-deny-catastrophic.js uses.
// Used by coord-guard.js (PreToolUse) and guard-deny-catastrophic.js. FAILS OPEN via its callers.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./coord-lib');
const P = require('./vibequarters-config');

// Fixer sessions (coordination.fixerPrefix, '' = none) do not merge. `ship` opens a /land tab for each of their PRs.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fixerRe = () => {
  const p = String(P.load().coordination.fixerPrefix || '');
  return p ? new RegExp(`^${escapeRe(p)}(-|$)`) : null;
};
const isFixer = (name) => { const re = fixerRe(); return !!re && re.test(String(name || '')); };
// True when a repo's PRs land only inside a tested batch (mergeGate.batchRepos).
const batchRepo = (slug) => (P.load().mergeGate.batchRepos || []).some((r) => String(r).toLowerCase() === String(slug || '').toLowerCase());

// Opens a Claude tab in VS Code at a /land prompt URL. The shell string is fixed: the URL reaches `code` only through an
// environment variable, so nothing in it is ever read as shell syntax. Never awaited; a throw is the caller's to swallow.
function openLandTab(url) {
  const fake = process.env.VIBEQUARTERS_COORD_FAKE_SPAWN;
  if (fake) {
    fs.appendFileSync(fake, `${url}\n`);
    return;
  }
  if (P.load().coordination.landTabOpener !== 'vscode') return; // 'none': the PR waits on GitHub for a /land run
  const cmd = process.platform === 'win32' ? 'code --open-url "%VIBEQUARTERS_LAND_URL%"' : 'code --open-url "$VIBEQUARTERS_LAND_URL"';
  const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, VIBEQUARTERS_LAND_URL: url } });
  child.on('error', () => { /* fail open: the fixer's PR stays open on GitHub for the next look */ });
  child.unref();
}

const LAND_TAB_MS = 24 * 3600e3;
// Runs inside L.update. Opens the /land tab of every PR a fixer session ships, at most once in 24 hours for the same
// repo#PR (r.landTabs). All input is validated before the prompt is put together.
function fixerShip(r, name, opts, now) {
  const prs = (opts.prs || []).map(String);
  const why = !isFixer(name) || !/^[\w-]+$/.test(name) ? `the session name "${name}" is not a plain fixer name`
    : !/^[\w.-]+\/[\w.-]+$/.test(String(opts.repoName || '')) ? `"${opts.repoName}" is not a GitHub owner/repo (origin must be on GitHub)`
      : !prs.length || prs.some((p) => !/^\d+$/.test(p)) ? `PR numbers must be digits only (got ${prs.join(' ') || 'none'})` : '';
  if (why) return { decision: 'deny', text: `no /land tab opened: ${why}.` };
  r.landTabs = r.landTabs || {};
  const open = [];
  const said = [];
  for (const pr of prs) {
    const key = `${opts.repoName}#${pr}`;
    // A stamp lasts LAND_TAB_MS, so a tab that never came cannot strand the PR for good.
    if (r.landTabs[key] && now - r.landTabs[key] < LAND_TAB_MS) {
      said.push(`#${pr} in ${opts.repoName} already has a /land tab, opened at ${new Date(r.landTabs[key]).toISOString()}; nothing new opened. If no tab came, run /land ${pr} for ${opts.repoName} in any tab.`);
      continue;
    }
    r.landTabs[key] = now;
    const prompt = `/land ${pr} for ${opts.repoName} (shipped by the fixer session ${name}). Work in your own new worktree of the PR's branch.`;
    open.push(`vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`);
    said.push(`#${pr} in ${opts.repoName} went to a fresh /land tab, which reviews it, fixes it, merges it through the review gate and closes.`);
  }
  return { decision: 'allow', open, text: `${said.join(' ')} Your shift can end: tell the user your tab can close.` };
}

// For any session that is not a fixer, `ship` only answers with the steps for landing the PRs in that session. The
// registry stays as it is. opts = { repoName, prs, ... }.
function shipJob(r, me, opts, now = Date.now()) {
  const name = String((r.sessions[me] || {}).name || '');
  if (isFixer(name)) return fixerShip(r, name, opts, now);
  const prs = (opts.prs || []).join(',') || '<n>';
  // merges in a batch repo go through merge-batch.js; other repos merge directly
  const how = batchRepo(opts.repoName)
    ? `node "${L.norm(path.join(__dirname, 'merge-batch.js'))}" build --repo ${opts.repoName} --prs ${prs} --dir <your worktree> (a batch may hold a single PR), then issue every printed command as a separate call.`
    : `gh pr merge ${(opts.prs || [])[0] || '<n>'} --squash --body-file <summary file> --match-head-commit <reviewed head>, one call for each PR.`;
  return { decision: 'deny', text: `ship does not merge. Run /land in this session: it reviews the PR, you fix the findings, and you merge with: ${how}` };
}

const hasGitHubRemote = (top) => process.env.VIBEQUARTERS_COORD_FAKE_GITHUB === '1' ||
  /github\.com[:/]/.test(L.git(top, ['remote', 'get-url', 'origin']).out || '');

const PULL_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/i;
const LITERAL_REPO = /^\w[\w.:/-]*$/; // written out, with no variable or substitution in it
const LITERAL_PR = /^[\w./#-]*$/; // a PR number, a branch, or '' when the merge names none
const LITERAL_DIR = /^[\w.:/\\~ -]+$/;

// The GH_REPO reaching the gh at offset i: set right in front of it, or by export or $env: earlier. '' none or empty;
// null: mentioned some other way (GH_REPO=x; alone is not exported, unset takes it away).
function ghRepoEnv(cmd, i) {
  const at = [...L.runnable(cmd).slice(0, i).matchAll(/\bGH_REPO\b/g)].map((m) => m.index).pop();
  if (at === undefined) return '';
  const said = cmd.slice(at, i);
  const m = /^GH_REPO=(["']?)([^\s"';&|]*)\1\s*$/.exec(said) ||
    (/(?:\bexport\s+|\$env:)$/i.test(cmd.slice(0, at)) ? /^GH_REPO\s*=\s*(["']?)([^\s"';&|]+)\1\s*(?:[;&\n]|$)/.exec(said) : null);
  return m ? m[2] : null;
}

// What moves a shell's folder, read in the runnable text, so a string that only mentions one stays text. git -C is not
// here: it moves that one git, and a gh after it still runs where it was.
const FOLDER_MOVE = /(?<![\w/\\:$-])(?:cd|chdir|pushd|popd|sl|set-location|push-location|pop-location|env\s+(?:-C|--chdir))(?=[\s;&|)("'=]|$)/gi;

// The folder the gh at offset i runs in, or null when what comes before hides it: a second move, a move with no written
// path, or one inside a subshell or string that closed before the gh.
function mergeFolder(cmd, i, cwd) {
  const before = L.runnable(cmd).slice(0, i);
  const moves = [...before.matchAll(FOLDER_MOVE)];
  if (!moves.length) return cwd;
  if (moves.length > 1) return null;
  const end = moves[0].index + moves[0][0].length;
  if (/[)"']/.test(before.slice(end).replace(/"[^"]*"|'[^']*'/g, ''))) return null;
  const w = L.tokens(cmd.slice(end, i));
  const dir = /^-(?:path|literalpath)$/i.test(w[0] || '') ? w[1] : w[0];
  return dir && LITERAL_DIR.test(dir) && !dir.startsWith('-') ? L.fromShellPath(dir, cwd) : null;
}

// Where the gh pr merge at offset i of cmd lands: { slug } when it names a repo, { dir } when its folder decides, null when
// that cannot be read. A PR URL beats -R, -R beats GH_REPO, GH_REPO beats the folder, as in gh. Only the PR selector can be
// a URL: a --body or --subject that links a PR is text.
function mergeTarget(cmd, i, cwd) {
  const t = L.tokens(L.unquoteWords(cmd).slice(i)).map((a) => a.replace(/[)`]+$/, '')); // "`gh pr merge 5`" ends in its closing backtick
  const { pr, repo: flag } = L.mergeArgs(t);
  const url = PULL_URL.exec(pr);
  if (!url && !LITERAL_PR.test(pr)) return null;
  const named = url ? url[1] : flag !== null ? flag : ghRepoEnv(cmd, i);
  if (named === null) return null;
  if (named || flag !== null) return LITERAL_REPO.test(named) ? { slug: named } : null; // an empty -R reads as nothing
  const dir = mergeFolder(cmd, i, cwd);
  return dir && { dir };
}

const PUSH_AT = new RegExp(String.raw`\bgit(?:\.exe)?${L.GIT_OPTS}\s+push\b`, 'gi');
const MERGE_AT = new RegExp(L.MERGE_SRC, 'gi');
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

// Where a command really runs it, whatever sits in front: then, do, timeout 300, { ... }, bash -c "...". A commit message, a PR
// body or a grep that merely mentions one stays text.
const runsAt = (re, cmd) => [...L.runnable(cmd).matchAll(re)].map((m) => m.index);
const mergeStarts = (cmd) => runsAt(MERGE_AT, L.unquoteWords(cmd));

// One git push's remote and refspecs, from its words; all: --all or --mirror.
function pushArgs(t) {
  const args = [];
  let all = false, tags = false;
  for (let k = t.findIndex((x) => /^push$/i.test(x)) + 1; k < t.length; k++) {
    if (t[k] === '--all' || t[k] === '--mirror') all = true;
    else if (t[k] === '--tags' || t[k] === '--no-tags') tags = t[k] === '--tags';
    else if (PUSH_VALUE_FLAGS.has(t[k])) k++;
    else if (!t[k].startsWith('-')) args.push(t[k].replace(/\)+$/, '')); // a subshell's closing paren is not the refspec's
  }
  return { remote: args[0] || '', specs: args.slice(1), all, tags };
}

// The branch named by a refspec, whichever form it has (plain, forced, source:destination, full ref name, or a deletion).
function pushDest(s) {
  const spec = s.replace(/^\+/, '');
  return (spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec).replace(/^refs\/heads\//, '');
}

// True when this push writes the default branch of the repo at top: a refspec whose destination is it, --all or --mirror,
// or no refspec (or HEAD) while the checkout is on it. With no refspec, --tags pushes tags alone.
function pushWritesDefault({ specs, all, tags }, top) {
  const base = L.baseRef(top);
  if (!base) return false;
  if (all) return true;
  const def = base.replace(/^origin\//, '');
  let current;
  const branch = () => (current === undefined ? (current = L.git(top, ['rev-parse', '--abbrev-ref', 'HEAD']).out) : current);
  if (!specs.length && !tags && branch() === def) return true;
  return specs.some((s) => { const dst = pushDest(s); return (dst === 'HEAD' ? branch() : dst) === def; });
}

// True when any git push in cmd writes the repo's default branch.
const pushesDefault = (cmd, top) => runsAt(PUSH_AT, cmd).some((i) => pushWritesDefault(pushArgs(L.denyWords(cmd.slice(i))), top));

module.exports = {
  isFixer, batchRepo, openLandTab, githubSlug: L.githubSlug, shipJob, hasGitHubRemote, mergeStarts, mergeTarget, pushesDefault,
};
