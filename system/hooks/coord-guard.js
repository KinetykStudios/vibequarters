#!/usr/bin/env node
// vibequarters :: PreToolUse(all tools) session coordination.
// Many Claude sessions share this machine's repos. This hook makes them behave like one team:
// registration before work, one session per worktree, per-file ownership with handoff, serialized
// migrations / deploys / merges, and no stale merges or deploys. Which commands take which lock is the `locks` table
// in vibequarters.config.json. FAILS OPEN. Escape hatch: VIBEQUARTERS_GUARD=off.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./coord-lib');
const M = require('./coord-land');
const R = require('./coord-requests');
const S = require('./coord-shell');
const P = require('./vibequarters-config');

// Notices for this session (requests, answers), shown once on this call and marked in the registry.
let pending = { text: '', marks: [] };
// Claims this call's marks under the registry lock and returns the text of only the ones it won. Idle calls
// (no marks) never take the lock.
function finish() {
  if (!pending.marks.length) return '';
  let won = pending.marks;
  try {
    won = L.update((r) => R.markShown(r, pending.marks, Date.now()));
  } catch (_e) { /* fail open toward delivery: show them all */ }
  return won.map((m) => m.text).filter(Boolean).join('\n\n');
}

let input = {};
function decide(decision, reason) {
  // an ask's reason goes to the user's prompt, not reliably to the model, so its notices wait for the next call
  const text = decision === 'deny' ? finish() : '';
  const notice = text ? `\n\n${text}` : '';
  if (decision === 'ask') try { require('./hq-ask-mark.js').markAsk(input, 'coord-guard.js', `SESSION COORDINATION: ${reason}`); } catch (_e) { /* the ask still prints */ }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: `SESSION COORDINATION: ${reason}${notice}`,
    },
  }));
  process.exit(0);
}
function allow(extra) {
  const text = [extra, finish()].filter(Boolean).join('\n\n');
  // additionalContext with NO permissionDecision: the normal permission flow is untouched
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }));
  process.exit(0);
}
const deny = (r) => decide('deny', r);
const ask = (r) => decide('ask', r);

const REGISTER = `this session is not registered, so other sessions cannot see or message it. ` +
  `1) Run ListAgents: its first line names this session ("This session is <name>"); if ListAgents is not available, ` +
  `pick a short name no live session uses (the task in two or three words). ` +
  `2) Run: ${L.CLI} register --name <that name> --task "<one-line task>". Then retry.`;

const Q = L.Q;
const GIT_OPTS = L.GIT_OPTS;
const GIT_MUTATE = new RegExp(String.raw`\bgit${GIT_OPTS}\s+(checkout|switch|rebase|reset|stash|merge|pull|commit|restore|clean|cherry-pick|revert|am|add|rm|mv)\b`, 'i');
const GIT_PUSH = new RegExp(String.raw`\bgit(?:\.exe)?${GIT_OPTS}\s+push\b`, 'i');
const PR_CREATE = /\bgh\s+pr\s+create\b/i;
const PR_MERGE = new RegExp(L.MERGE_SRC, 'i');
const prMergeAt = (cmd) => L.unquoteWords(cmd).search(PR_MERGE);
const mergeWords = (cmd) => L.tokens(L.unquoteWords(cmd).slice(prMergeAt(cmd)));
// The lock table (vibequarters.config.json `locks`): which shell commands and MCP tools take which lock.
const LOCK_ROWS = P.lockRows();
// node and the path of a coord.js: a quoted path whole, so a home folder may have a space or an apostrophe in it.
const COORD = String.raw`node\s+(?:"[^"\n]*coord\.js"|'[^'\n]*coord\.js'|["']?[^"'\s]*coord\.js["']?)`;
const COORD_CMD = new RegExp(`\\b${COORD}([^\\n]*)`, 'i');
const COORD_AT = new RegExp(`^\\s*${COORD}`, 'i');
const FORCE = /coord\.js["']?\s+["']?(force-release|end-session|force-handoff)\b/i;
const commandStarts = L.commandStarts;
const CHAINED = `A coord.js command must be the only command in its call, because the hook checks nothing else on that line. ` +
  `Run ${L.CLI} <command> alone and the rest in another call.`;

const tokens = L.tokens;
const flag = (t, name) => { const i = t.indexOf(name); return i >= 0 ? t[i + 1] : undefined; };

const targetDir = L.targetDir;

function handoff(hit, path_, top) {
  const s = hit.session;
  const name = s ? s.name : String(hit.claim.session).slice(0, 8);
  const gone = !L.isLive(s);
  const file = L.norm(path.join(top, path_));
  return `${path_} is owned by session "${name}" (task: ${(s && s.task) || 'unknown'}; its worktree ${hit.claim.worktree} ` +
    `has unmerged changes to it). This is the coordination ownership rule, not a safety or permission denial: the owner knows ` +
    `the file best, so handing it the change is the approved path. Do not edit it and do not work around this. ` +
    `1) ${L.CLI} request "${file}" "<the exact change and why>". ` +
    (gone
      ? `2) "${name}" has closed or gone quiet, so it cannot answer: tell the user, then ${L.CLI} force-handoff <id> asks them ` +
        `to approve handing you the file with its unfinished change.`
      : `2) SendMessage "${name}" the same change; it makes it (done), hands you the file (handoff) or releases it. ` +
        `3) Carry on with other work; the answer shows up next to a tool result. No answer in ${L.HANDOFF_MIN} minutes: ` +
        `${L.CLI} force-handoff <id> asks the user.`);
}

function occupied(occ, top) {
  const base = L.baseRef(top) || 'HEAD';
  return `${top} is in use by session "${occ.session.name}" (${occ.why}). Two sessions must never share one working ` +
    `folder. Make your own: git -C "${top}" worktree add ../wt-<task> -b <branch> ${base} and work there. ` +
    `If "${occ.session.name}" is missing from ListAgents, tell the user; ${L.CLI} end-session "${occ.session.name}" asks them to approve.`;
}

function lockBlocked(reg, name, me) {
  const h = L.lockHolder(reg, name, me);
  return h ? `${name} is in progress by session "${h.session.name}" (started ${L.ago(h.lock.at)}). Only one session ` +
    `at a time. SendMessage "${h.session.name}" to coordinate and retry once it is done (the lock also expires ` +
    `${Math.round(L.LOCK_TTL_MS / 60e3)} minutes after it was taken).` : null;
}

function staleDeploy(dir) {
  const repo = L.findRepo(dir);
  if (!repo) return null;
  const base = L.baseRef(repo.top);
  if (!base) return null;
  return L.git(repo.top, ['merge-base', '--is-ancestor', base, 'HEAD']).code === 1
    ? `${repo.top} is behind ${base}: deploying it would overwrite newer shipped code with older code. ` +
      `Update first (git -C "${repo.top}" fetch, then rebase or merge ${base}) or deploy from an up-to-date worktree.`
    : null;
}

function behindBy(cmd, dir) {
  if (process.env.VIBEQUARTERS_COORD_FAKE_BEHIND !== undefined) return Number(process.env.VIBEQUARTERS_COORD_FAKE_BEHIND);
  const { pr, repo: repoFlag } = L.mergeArgs(mergeWords(cmd));
  const num = /^\d+$/.test(pr) ? pr : undefined;
  const opts = { cwd: fs.existsSync(dir) ? dir : process.cwd(), encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    const view = execFileSync('gh', ['pr', 'view', ...(num ? [num] : []), ...(repoFlag ? ['-R', repoFlag] : []),
      '--json', 'headRefOid,baseRefName', '--jq', '.headRefOid + " " + .baseRefName'], opts).trim().split(' ');
    const slug = repoFlag || '{owner}/{repo}';
    return Number(execFileSync('gh', ['api', `repos/${slug}/compare/${view[1]}...${view[0]}`, '--jq', '.behind_by'], opts).trim()) || 0;
  } catch (_e) {
    return 0; // gh unavailable or offline: fail open
  }
}

// Batch members (merge-batch.js) are expected to be behind base, since each squash merge before them moves main.
// Only the next member in order may: main must have gained exactly the members before it since the batch base, and
// its body must be the one plan-land wrote. true when it may land, a reason when it is next but its body is wrong,
// false when it is no batch's next member.
function batchTurn(cmd, dir) {
  const t = mergeWords(cmd);
  const { pr, repo: slug } = L.mergeArgs(t);
  const num = /^\d+$/.test(pr) ? Number(pr) : 0;
  if (!num || !slug) return false;
  const opts = { cwd: fs.existsSync(dir) ? dir : process.cwd(), encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    const MB = require('./merge-batch.js');
    const head = process.env.VIBEQUARTERS_COORD_FAKE_PR_HEAD !== undefined ? process.env.VIBEQUARTERS_COORD_FAKE_PR_HEAD
      : execFileSync('gh', ['pr', 'view', String(num), '-R', slug, '--json', 'headRefOid', '--jq', '.headRefOid'], opts).trim();
    const rec = MB.findBatchFor(slug, num, head);
    if (!rec) return false;
    const subjects = JSON.parse(process.env.VIBEQUARTERS_COORD_FAKE_MAIN_SUBJECTS !== undefined ? process.env.VIBEQUARTERS_COORD_FAKE_MAIN_SUBJECTS
      : execFileSync('gh', ['api', `repos/${slug}/compare/${rec.base}...main`, '--jq', '[.commits[].commit.message | split("\\n")[0]]'], opts));
    const next = rec.members[subjects.length];
    if (!(MB.isBatchPrefix(rec, subjects) && !!next && next.pr === num)) return false;
    const problem = MB.landingBodyProblem(rec, num, t, opts.cwd);
    return problem ? `PR #${num} is next in batch ${rec.id}, but ${problem}.` : true;
  } catch (_e) {
    return false; // unreadable: the behind-base deny applies
  }
}

// A name stays reserved while its session is open and was seen in the last 10 minutes.
const nameLive = (s, now) => !s.endedAt && now - s.lastSeen < 10 * 60e3;

// What a takeover of session id would move: its file claims, and its requests that are open or were withdrawn
// only because it closed.
function heldBy(reg, id) {
  return {
    claims: reg.claims.filter((c) => c.session === id).length,
    requests: reg.requests.filter((q) => (q.from === id || q.to === id) && (q.state === 'open' || q.autoWithdrawn)).length,
  };
}

// Registers this session under name; a closed session that held the name hands over its claims and requests.
function applyRegister(name, task, me, cwd) {
  const repo = L.findRepo(cwd);
  const now = Date.now();
  L.update((r) => {
    const prior = Object.values(r.sessions).find((s) => s.id !== me && s.name === name);
    if (prior && nameLive(prior, now)) return; // taken again since the check: never steal a live name
    if (prior) {
      for (const c of r.claims) if (c.session === prior.id) c.session = me;
      L.moveRequests(r, prior.id, me);
      delete r.sessions[prior.id];
    }
    r.sessions[me] = { ...(r.sessions[me] || {}), id: me, name, task, cwd, top: repo ? L.norm(repo.top) : null, registeredAt: now, lastSeen: now };
    delete r.sessions[me].endedAt;
  });
}

// PostToolUse: Claude Code calls it only once a tool has really run. A whole-command coord register that ran is
// applied here, which is what makes an approved takeover land (re-applying a plain register changes nothing).
function onRan(cmd, me, cwd) {
  const line = cmd.trimEnd();
  if (!COORD_AT.test(line) || commandStarts(line).length > 1) return;
  const t = tokens(COORD_CMD.exec(line)[1], true);
  const name = t[0] === 'register' && flag(t, '--name');
  if (name) applyRegister(name, flag(t, '--task') || '', me, cwd);
}

// force-release <path> / end-session <name> need no approval when everyone they override is closed with nothing
// unpushed (L.closedUnsafe). Nothing to override, a live holder, unpushed work or a git failure keeps the ask.
function onlyClosed(cmd, arg, ctx) {
  const { reg, me, cwd } = ctx;
  if (!arg) return false;
  let ids;
  if (cmd === 'force-release') {
    const abs = L.fromShellPath(arg, cwd);
    const repo = L.findRepo(abs);
    if (!repo) return false;
    const p = L.rel(repo.top, abs);
    const held = reg.claims.filter((c) => c.session !== me && c.repo === repo.common && L.same(c.path, p));
    ids = held.map((c) => c.session);
  } else {
    ids = Object.values(reg.sessions).filter((s) => s.name === arg && !s.endedAt).map((s) => s.id);
  }
  return ids.length > 0 && [...new Set(ids)].every((id) => !L.closedUnsafe(reg, id));
}
const CLOSED_OK = 'Everyone this overrides is closed with nothing unpushed, so it needs no approval.';

function coordCommand(args, ctx) {
  const { reg, me, self, cwd } = ctx;
  const t = tokens(args, true);
  const cmd = t[0] || 'board';
  const rest = t.slice(1).join(' ');
  const now = Date.now();
  if (cmd === 'force-release' || cmd === 'end-session') {
    if (onlyClosed(cmd, cmd === 'force-release' ? t[1] : rest, ctx)) allow(CLOSED_OK);
    ask(`"${cmd} ${rest}" overrides another session's ownership. Only the user can approve it.`);
  }
  if (cmd === 'release-closed') {
    const ids = Object.values(reg.sessions).filter((s) => s.name === rest).map((s) => s.id);
    if (!ids.length) deny(`release-closed needs the name of a registered session; none is named "${rest}".`);
    for (const id of ids) {
      const why = L.closedUnsafe(reg, id, now);
      if (why) {
        deny(`release-closed ${rest} releases nothing: ${why}. A live owner gets ${L.CLI} request "<path>" "<change>" and a ` +
          `SendMessage; a closed one with unpushed work goes to the user, and ${L.CLI} force-release <path> asks them.`);
      }
    }
    allow(); // coord.js judges it again and applies it
  }
  if (cmd === 'register') {
    const name = flag(t, '--name');
    if (!name) deny(`register needs --name <this session's ListAgents name>.`);
    const task = flag(t, '--task') || '';
    const taken = Object.values(reg.sessions).find((s) => s.id !== me && s.name === name);
    if (taken && nameLive(taken, now)) {
      deny(`the name "${name}" is already registered to a live session. Run ListAgents: the first line is YOUR name.`);
    }
    // Taking over a closed session's files overrides their owner, so the user approves it, and the PostToolUse call
    // applies it once the command has really run: a denied ask or a command auto mode blocks changes nothing.
    const held = taken ? heldBy(reg, taken.id) : { claims: 0, requests: 0 };
    if (held.claims || held.requests) {
      ask(`register --name ${name} takes over the closed session "${name}": its ${held.claims} file claim(s) and ` +
        `${held.requests} request(s) move to this session. That overrides their owner, so only the user can approve it. ` +
        `It applies once the command runs; register again under your own ListAgents name afterwards so peers can message you.`);
    }
    applyRegister(name, task, me, cwd);
    allow();
  }
  if (cmd === 'ship') {
    if (!self) deny(REGISTER);
    const pos = t.slice(1);
    if (!pos.length || pos.some((x) => !/^#?\d+$/.test(x))) deny(`usage: ${L.CLI} ship <PR#> [<PR#>...], run from your worktree.`);
    const repo = L.findRepo(cwd);
    if (!repo) deny(`run ship from your own worktree of the repo the PRs belong to; ${cwd} is not inside a git repo (a lone cd <worktree> first is fine).`);
    const repoName = M.githubSlug(repo.top) || L.repoName(repo.common);
    const prs = pos.map((x) => Number(x.replace(/^#/, '')));
    if (!M.isFixer(self.name)) deny(M.shipJob(reg, me, { repo, repoName, prs }, Date.now()).text); // only prints the /land steps
    // a fixer session: one /land tab per PR, stamped under the registry lock so a re-ship opens none
    const v = L.update((r) => M.shipJob(r, me, { repo, repoName, prs }, Date.now()));
    if (v.decision === 'deny') deny(v.text);
    for (const url of v.open) {
      try { M.openLandTab(url); } catch (_e) { /* fail open: the PR stays open on GitHub */ }
    }
    allow(v.text);
  }
  if (cmd === 'landed') {
    if (!self) deny(REGISTER);
    const pr = String(t[1] || '');
    const gate = String(flag(t, '--gate') || '').replace(/\s+/g, ' ').trim();
    if (/^#?\d+$/.test(String(t[2] || ''))) deny(`one PR per landed: run landed once for each PR, ${L.CLI} landed <PR#> --gate "<its record>".`);
    if (!/^#?\d+$/.test(pr) || !gate) {
      deny(`usage: ${L.CLI} landed <PR#> --gate "<the gate record: merge sha, live check and its negative control>", run from your worktree once the PR is live.`);
    }
    const repo = L.findRepo(cwd);
    if (!repo) deny(`run landed from your own worktree of the repo the PR belongs to; ${cwd} is not inside a git repo (a lone cd <worktree> first is fine).`);
    const repoName = M.githubSlug(repo.top) || L.repoName(repo.common);
    const line = `- ${new Date().toISOString()} ${self.name} ${repoName} #${pr.replace(/^#/, '')} landed: ${gate}\n`;
    fs.mkdirSync(L.DIR, { recursive: true });
    fs.appendFileSync(L.GATES, line);
    allow(`Recorded in ${L.norm(L.GATES)}: ${line.trim()}`);
  }
  if (R.COMMANDS.includes(cmd)) {
    if (!self) deny(REGISTER);
    // the call that answers a request must not also show that request's notice
    if (['done', 'handoff', 'withdraw'].includes(cmd)) pending.marks = pending.marks.filter((m) => m.id !== t[1]);
    const v = R.command(cmd, t, ctx);
    if (v.decision === 'deny') deny(v.text);
    if (v.decision === 'ask') ask(v.text);
    allow(v.text);
  }
  if (!self) {
    if (['task', 'release', 'unlock', 'note'].includes(cmd)) deny(REGISTER);
    allow();
  }
  if (cmd === 'task') L.update((r) => { r.sessions[me].task = rest; });
  if (cmd === 'note') L.update((r) => { r.notes.push({ at: now, by: self.name, text: rest }); });
  if (cmd === 'unlock') L.update((r) => { if (r.locks[t[1]] && r.locks[t[1]].session === me) delete r.locks[t[1]]; });
  if (cmd === 'release' && t[1]) {
    const abs = L.fromShellPath(t[1], cwd);
    const repo = L.findRepo(abs);
    if (repo) {
      const p = L.rel(repo.top, abs);
      L.update((r) => { r.claims = r.claims.filter((c) => !(c.session === me && c.repo === repo.common && L.same(c.path, p))); });
    }
  }
  allow();
}

function onEdit(file, ctx) {
  const { reg, me, self, cwd } = ctx;
  const abs = L.fromShellPath(file, cwd);
  const repo = L.findRepo(abs);
  if (!repo) allow();
  const p = L.rel(repo.top, abs);
  if (p === '.git' || p.startsWith('.git/')) allow();
  if (!self) deny(REGISTER);
  const occ = L.occupier(reg, repo.top, me);
  if (occ) deny(occupied(occ, repo.top));
  const stale = []; // judged here, outside the registry lock
  const hit = L.conflictingClaim(reg, repo.common, p, me, stale);
  if (hit) deny(handoff(hit, p, repo.top));
  L.update((r) => L.addClaim(r, repo, p, me, stale));
  allow();
}

// Live sessions other than this one, with the worktree root their heartbeat recorded.
function livePeers(reg, me) {
  const now = Date.now();
  return Object.values(reg.sessions)
    .filter((s) => s.id !== me && s.top && L.isLive(s, now))
    .map((s) => ({ name: s.name, top: s.top, k: L.key(s.top), spell: S.spellings(s.top) }));
}

const shellWrite = (hit) => `this command ${hit.why}: ${hit.target} is inside the worktree of live session "${hit.peer}". ` +
  `Writing into another session's folder is blocked (the coordination rule): make the change in your own worktree. If "${hit.peer}" ` +
  `owns the file, ${L.CLI} request "<path>" "<the exact change and why>" and SendMessage it.`;

// A chain whose coord call comes first and whose rest only reads (echo, cat, ls, or a bare coord.js, which prints the
// board) skips no check: the hook applies that first call, and a read needs none. No redirect, no $( ), backtick or $'
// quoting, and no ( ) or { } in the rest, since PowerShell runs what sits inside them.
const READ_ONLY = /^(echo|cat|ls)(\s|$)/i;
const BARE_COORD = new RegExp(`^${COORD}$`, 'i');
function readOnlyTail(line, starts) {
  if (!COORD_AT.test(line) || /\$\(|`|\$'/.test(line)) return false;
  const cuts = [...starts].sort((a, b) => a - b);
  const segs = cuts.map((s, i) => line.slice(s, cuts[i + 1] === undefined ? line.length : cuts[i + 1]).replace(/[;&|\s]+$/, '').trim())
    .filter(Boolean);
  const unquoted = (s) => s.replace(/"(?:[^"\\]|\\[\s\S])*"|'[^']*'/g, '').replace(/\d?>&\d/g, '');
  return segs.every((s) => !/[<>]/.test(unquoted(s))) &&
    segs.slice(1).every((s) => !/[(){}]/.test(unquoted(s)) && (READ_ONLY.test(s) || BARE_COORD.test(s)));
}

function onShell(cmd, ctx) {
  const { reg, me, self, cwd } = ctx;
  if (/coord\.js/i.test(cmd)) {
    // only a coord call that is the whole command is applied; one that is merely mentioned is judged below as itself
    const line = cmd.trimEnd();
    const starts = commandStarts(line);
    const force = FORCE.exec(line);
    if (starts.length > 1 && (force || starts.some((i) => COORD_AT.test(line.slice(i)))) && (force || !readOnlyTail(line, starts))) deny(CHAINED);
    if (COORD_AT.test(line)) coordCommand(COORD_CMD.exec(line)[1], ctx);
    // any other launcher (node with flags, node.exe, bun) never reaches coordCommand, so its gate lives here
    if (force) {
      const ft = tokens(line.slice(force.index + force[0].length).replace(/^["']/, ''), true);
      const name = force[1];
      if (!((name === 'force-release' || name === 'end-session') && onlyClosed(name, name === 'force-release' ? ft[0] : ft.join(' '), ctx))) {
        ask(`this command runs coord.js ${force[1]}, which overrides another session. Only the user can approve it.`);
      }
    }
  }
  let hit = null;
  try {
    const peers = livePeers(reg, me);
    if (peers.length && S.mentionsPeer(cmd, peers)) {
      // own root only now, so an idle command pays the one scan: a session sharing this worktree is not guarded
      const mine = L.findRepo(cwd);
      const others = mine ? peers.filter((p) => p.k !== L.key(mine.top)) : peers;
      if (others.length) hit = S.peerWrite(cmd, cwd, others);
    }
  } catch (_e) { /* a shell-guard bug must never block a command or skip the checks below */ }
  if (hit) deny(shellWrite(hit));

  const dir = targetDir(cmd, cwd);
  const repo = L.findRepo(dir);
  const effects = [];

  if (repo && GIT_MUTATE.test(cmd)) {
    const occ = L.occupier(reg, repo.top, me);
    if (occ) deny(occupied(occ, repo.top));
  }

  const ships = GIT_PUSH.test(cmd) || PR_CREATE.test(cmd);
  const locked = [];
  const deploys = new Set(); // locks a deploy-gated row took: their worktree must contain the shipped branch
  if (prMergeAt(cmd) >= 0) locked.push('merge');
  for (const row of LOCK_ROWS) {
    if (!row.shell || !row.shell.test(cmd)) continue;
    if (!locked.includes(row.lock)) locked.push(row.lock);
    if (row.deployGate) deploys.add(row.lock);
  }
  if (!ships && !locked.length) allow();
  if (!self) deny(REGISTER);

  if (ships && repo) {
    const base = L.baseRef(repo.top);
    const files = new Set();
    if (base) {
      const d = L.git(repo.top, ['diff', '--name-only', `${base}...HEAD`]);
      if (d.code === 0) d.out.split('\n').filter(Boolean).forEach((f) => files.add(f));
    }
    const st = L.git(repo.top, ['status', '--porcelain', '--untracked-files=all']);
    if (st.code === 0) L.statusPaths(st.out).forEach((f) => files.add(f));
    const stale = []; // judged here, outside the registry lock
    for (const f of files) {
      const hit = L.conflictingClaim(reg, repo.common, f, me, stale, repo.top);
      if (hit) deny(`this branch changes ${f}, which another session owns. ${handoff(hit, f, repo.top)}`);
    }
    effects.push((r) => { for (const f of files) L.addClaim(r, repo, f, me, stale); });
  }

  for (const name of locked) {
    const blocked = lockBlocked(reg, name, me);
    if (blocked) deny(blocked);
    if (deploys.has(name)) {
      const stale = staleDeploy(dir);
      if (stale) deny(stale);
    }
    if (name === 'merge') {
      const behind = behindBy(cmd, dir);
      const turn = behind > 0 ? batchTurn(cmd, dir) : true;
      if (typeof turn === 'string') deny(turn);
      if (!turn) {
        deny(`the PR is ${behind} commit(s) behind its base branch. Update it first (gh pr update-branch <number>), ` +
          `let CI pass on the updated branch, then merge. Merging stale branches is how sessions break each other's work.`);
      }
    }
    effects.push((r) => { r.locks[name] = { name, session: me, at: Date.now() }; });
  }

  if (effects.length) L.update((r) => effects.forEach((fn) => fn(r)));
  allow();
}

function onLockedTool(name, ctx, deployDir) {
  const { reg, me, self } = ctx;
  if (!self) deny(REGISTER);
  const blocked = lockBlocked(reg, name, me);
  if (blocked) deny(blocked);
  if (deployDir) {
    const stale = staleDeploy(deployDir);
    if (stale) deny(stale);
  }
  L.update((r) => { r.locks[name] = { name, session: me, at: Date.now() }; });
  allow();
}

try {
  L.mark('required');
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') allow();
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  L.mark('stdin');
  const me = String(input.session_id || '');
  if (!me) allow();
  const cwd = L.norm(input.cwd || process.cwd());
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  if (input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure') {
    const cmd = String(ti.command || '');
    if (/^(Bash|PowerShell)$/.test(tool) && input.hook_event_name === 'PostToolUse') onRan(cmd, me, cwd);
    // A gh pr merge that has returned, merged or failed, is no longer merging: free its lock (otherwise peers wait
    // on a merge that already ended). A background launch is still running.
    if (/^(Bash|PowerShell)$/.test(tool) && prMergeAt(cmd) >= 0 && ti.run_in_background !== true) {
      L.update((r) => { const l = r.locks.merge; if (l && l.session === me) delete r.locks.merge; });
    }
    process.exit(0);
  }
  // A merge another PreToolUse hook (the review gate) or auto mode denied never ran, so no PostToolUse comes,
  // yet this guard took the lock in parallel. PostToolBatch lists every resolved call; PermissionDenied names one.
  // Same rule as the heavy-job gate: free it unless the call left a background job running.
  if (input.hook_event_name === 'PostToolBatch' || input.hook_event_name === 'PermissionDenied') {
    const calls = input.hook_event_name === 'PermissionDenied' ? [input] : Array.isArray(input.tool_calls) ? input.tool_calls : [];
    const bg = (r) => (r && typeof r === 'object' ? !!r.backgroundTaskId : /running in background with ID/.test(String(r || '')));
    if (calls.some((c) => c && /^(Bash|PowerShell)$/.test(c.tool_name) && prMergeAt(String((c.tool_input || {}).command || '')) >= 0 && !bg(c.tool_response))) {
      L.update((r) => { const l = r.locks.merge; if (l && l.session === me) delete r.locks.merge; });
    }
    process.exit(0);
  }
  const reg = L.load();
  const self = reg.sessions[me];

  if (self && (Date.now() - self.lastSeen > 60e3 || self.endedAt || self.top === undefined || L.key(self.cwd || '') !== L.key(cwd))) {
    const repo = L.findRepo(cwd);
    L.update((r) => {
      const s = r.sessions[me];
      if (!s) return;
      s.lastSeen = Date.now();
      s.cwd = cwd;
      s.top = repo ? L.norm(repo.top) : null; // the shell-write guard reads peers' roots
      delete s.endedAt;
    });
  }

  const ctx = { reg, me, self, cwd };
  if (self) {
    try {
      R.autoResolve(reg, me, Date.now());
      pending = R.notices(reg, me, Date.now());
    } catch (_e) {
      pending = { text: '', marks: [] }; // a notice bug must never switch the guard off
    }
  }
  L.mark('notices');
  if (/^(Bash|PowerShell|Monitor)$/.test(tool)) onShell(String(ti.command || ''), ctx);
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) && (ti.file_path || ti.notebook_path)) {
    onEdit(ti.file_path || ti.notebook_path, ctx);
  }
  const row = LOCK_ROWS.find((r) => r.tool && r.tool.test(tool));
  if (row) onLockedTool(row.lock, ctx);
  allow();
} catch (_e) {
  process.exit(0); // FAIL OPEN: a coordination bug must never block real work
}
