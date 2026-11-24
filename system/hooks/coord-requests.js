// vibequarters :: session coordination, owner-decides requests.
// request / done / withdraw / handoff / force-handoff, the notices each side sees next to its tool results, and
// the patch that carries an owner's unfinished change to the requester. Used by coord-guard.js (PreToolUse) and
// coord.js (CLI).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./coord-lib');

const COMMANDS = ['request', 'done', 'withdraw', 'handoff', 'force-handoff'];
const DEADLINE_MS = L.HANDOFF_MIN * 60e3; // no answer this long: the requester may force-handoff (the user approves)
const HELD_MS = 30 * 60e3; // a handed file stays the requester's this long, even before it applies the patch
const SHOW_EVERY_MS = 5 * 60e3; // an open request is shown to its owner at most SHOW_MAX times, this far apart
const SHOW_MAX = 3;
const MAX_NOTICE = 600;
const RESOLVE_EVERY_MS = 5 * 60e3; // how often a requester's open request is checked for the owner having shipped

const verdict = (decision, text) => ({ decision, text });
const find = (reg, id) => reg.requests.find((q) => q.id === id);
const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};

function request(t, ctx, now) {
  const { reg, me, cwd } = ctx;
  const change = t.slice(2).join(' ').trim();
  if (!t[1] || !change) return verdict('deny', `usage: ${L.CLI} request "<path>" "<the exact change and why>"`);
  const abs = L.fromShellPath(t[1], cwd);
  const repo = L.findRepo(abs);
  if (!repo) return verdict('deny', `${abs} is not inside a git repo, so no session owns it: edit it yourself.`);
  const p = L.rel(repo.top, abs);
  const hit = L.conflictingClaim(reg, repo.common, p, me);
  if (!hit) return verdict('deny', `no other session holds ${p}: edit it yourself.`);
  const dup = reg.requests.find((q) => q.state === 'open' && q.from === me && q.repo === repo.common && L.same(q.path, p));
  if (dup) return verdict('deny', `you already asked for ${p} (${dup.id}, ${L.ago(dup.at)}). Wait for the answer, or ${L.CLI} withdraw ${dup.id}.`);
  const q = {
    // crypto is required here, not at the top: loading it on every tool call would cost startup time
    id: `req-${require('crypto').randomBytes(3).toString('hex')}`, repo: repo.common, path: p, from: me,
    to: hit.claim.session, change, at: now, shown: 0, state: 'open',
  };
  L.update((r) => { r.requests.push(q); });
  const owner = L.label(reg, q.to);
  if (!L.isLive(reg.sessions[q.to], now)) {
    return verdict('allow', `Request ${q.id} recorded for "${owner}". "${owner}" has closed or gone quiet, so it cannot answer: ` +
      `${L.CLI} force-handoff ${q.id} can be run now (the user approves it).`);
  }
  return verdict('allow', `Request ${q.id} recorded for "${owner}". Now SendMessage "${owner}" the same change: it wakes an idle session. ` +
    `Carry on with other work; the answer shows up next to a tool result. No answer in ${L.HANDOFF_MIN} minutes: ${L.CLI} force-handoff ${q.id}.`);
}

// The open request with this id where this session is `side` ('to' = owner, 'from' = requester), else null.
function answer(reg, me, id, side) {
  const q = find(reg, id || '');
  return q && q[side] === me && q.state === 'open' ? q : null;
}

function setState(id, fields) {
  L.update((r) => { const q = find(r, id); if (q && q.state === 'open') Object.assign(q, fields); });
}

// Where the owner's branch forked from the shipped branch. HEAD when there is no shipped branch (claimActive then
// counts only uncommitted edits, so those are the whole change); null when there is one but git finds no fork point.
function forkOf(top) {
  const base = L.baseRef(top);
  if (!base) return 'HEAD';
  const mb = L.git(top, ['merge-base', 'HEAD', base]);
  return mb.code === 0 && mb.out ? mb.out : null;
}

// The command that takes the handed file out of the owner's branch: the fork's copy back, or gone if the branch added it.
// -f: the patch already holds any staged or later edits, and checkout (the other branch) overwrites them the same way.
const dropCmd = (top, fork, p, added) => (added ? `git -C "${top}" rm -f -- "${p}"` : `git -C "${top}" checkout ${fork} -- "${p}"`);

// The owner's unfinished change to q.path (committed and uncommitted, against its fork point) as a patch file.
function writePatch(q, claim) {
  const top = claim.worktree;
  if (L.git(top, ['ls-files', '--error-unmatch', '--', q.path]).code !== 0 && fs.existsSync(path.join(top, q.path))) {
    return { error: `${q.path} is not tracked yet in ${top}: commit it on your branch, then run handoff again.` };
  }
  const fork = forkOf(top);
  if (!fork) {
    return { error: `cannot find where your branch in ${top} forked from the shipped branch (git merge-base failed), so the ` +
      `patch would leave out your commits to ${q.path}. Rebase the branch onto the shipped branch, then run handoff again.` };
  }
  const cannotRead = { error: `could not read the change to ${q.path} in ${top}; try again.` };
  // The owner's copy already matches the shipped branch: its change is out, so there is nothing to hand over and
  // nothing to drop. Checking the fork's copy back out would undo the shipped change in the owner's branch.
  const base = L.baseRef(top);
  if (base && L.git(top, ['diff', '--quiet', '--no-textconv', '--no-ext-diff', base, '--', q.path]).code === 0) return { fork, added: false, patch: null, shipped: base };
  const atFork = L.git(top, ['cat-file', '-e', `${fork}:${q.path}`]);
  if (atFork.code < 0) return cannotRead; // timeout or spawn failure: unknown, never read as "added"
  const added = atFork.code !== 0;
  let diff;
  try {
    // a Buffer, never decoded: decoding corrupts bytes that are not UTF-8. execFileSync, not L.git: L.git trims the
    // trailing newline, which corrupts a patch. No textconv or external diff driver: the patch must hold the real bytes
    diff = execFileSync('git', ['diff', '--binary', '--no-textconv', '--no-ext-diff', fork, '--', q.path], {
      cwd: top, timeout: 8000, maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (_e) {
    return cannotRead;
  }
  if (!diff.length) return { fork, added, patch: null };
  fs.mkdirSync(L.HANDOFFS, { recursive: true });
  const patch = L.norm(path.join(L.HANDOFFS, `${q.id}.patch`));
  fs.writeFileSync(patch, diff);
  return { fork, added, patch };
}

// The requester's worktree root in the request's repo, or null.
function requesterTop(reg, q) {
  const s = reg.sessions[q.from];
  const top = s && (s.top || (s.cwd && (L.findRepo(s.cwd) || {}).top));
  const repo = top && L.findRepo(top);
  return repo && repo.common === q.repo ? L.norm(repo.top) : null;
}

// Inside L.update: the claim moves to the requester (held), the request is handed, other waiting requests follow.
// Returns false, changing nothing, when the locked record is no longer open.
function applyHandoff(r, id, res, now, forced) {
  const q = find(r, id);
  if (!q || q.state !== 'open') return false;
  r.claims = r.claims.filter((c) => !(c.repo === q.repo && L.same(c.path, q.path) && (c.session === q.to || c.session === q.from)));
  r.claims.push({ repo: q.repo, path: q.path, session: q.from, worktree: res.dest, at: now, heldUntil: now + HELD_MS });
  Object.assign(q, {
    state: 'handed', answeredAt: now, patch: res.patch, fork: res.fork, added: Boolean(res.added), ownerTop: res.ownerTop,
    dest: res.dest, forced: Boolean(forced), told: false, ownerTold: !(forced && res.ownerTop), shipped: res.shipped || null,
  });
  for (const o of r.requests) {
    if (o.id !== q.id && o.state === 'open' && o.repo === q.repo && L.same(o.path, q.path)) {
      Object.assign(o, { to: q.from, at: now, shown: 0, lastShown: 0 });
    }
  }
  return true;
}

function handOver(reg, q, now, forced) {
  const dest = requesterTop(reg, q);
  if (!dest) {
    return verdict('deny', `cannot find "${L.label(reg, q.from)}"'s worktree in this repo; it must run any command in its worktree first, then try again.`);
  }
  const claim = reg.claims.find((c) => c.session === q.to && c.repo === q.repo && L.same(c.path, q.path));
  const res = claim ? writePatch(q, claim) : { fork: 'HEAD', patch: null };
  if (res.error) return verdict('deny', res.error);
  const ownerTop = claim && !res.shipped ? claim.worktree : null; // a shipped change leaves nothing to drop
  let late = 'gone'; // the locked record's state when it was no longer open
  const applied = L.update((r) => {
    if (applyHandoff(r, q.id, { ...res, dest, ownerTop }, now, forced)) return true;
    late = (find(r, q.id) || { state: late }).state;
    // remove the patch just written (inside handoffs, as GC checks) unless a record points to it: a handoff of this
    // request that won the race wrote the same file
    const p = res.patch;
    const kept = p && r.requests.some((x) => typeof x.patch === 'string' && L.key(x.patch) === L.key(p));
    if (p && !kept && L.key(path.dirname(p)) === L.key(L.HANDOFFS)) {
      try { fs.unlinkSync(p); } catch (_e) { /* already gone */ }
    }
    return false;
  });
  if (!applied) return verdict('deny', `${q.id} is no longer open (state ${late}); nothing was handed over${forced ? '' : ', keep your file'}.`);
  const from = L.label(reg, q.from);
  return verdict('allow', `${q.path} is now "${from}"'s${res.patch ? `; your unfinished change is saved in ${res.patch}` : ''}. ` +
    (res.shipped ? `Your change to it is already on ${res.shipped}, so there is nothing to drop from your branch. ` : '') +
    (ownerTop ? `Check your other work does not depend on it, then drop it from your branch: ${dropCmd(ownerTop, res.fork, q.path, res.added)}, and commit. ` : '') +
    `Pushing ${q.path} is blocked while "${from}" holds it.`);
}

function command(cmd, t, ctx) {
  const { reg, me } = ctx;
  const now = Date.now();
  if (cmd === 'request') return request(t, ctx, now);
  if (cmd === 'done') {
    const q = answer(reg, me, t[1], 'to');
    if (!q) return verdict('deny', `${t[1] || '<id>'} is not an open request addressed to this session. Open requests: ${L.CLI}`);
    setState(q.id, { state: 'done', answeredAt: now, told: false });
    return verdict('allow', `${q.id} marked done; "${L.label(reg, q.from)}" is told on its next action. Keep the change in your branch: it ships with your PR.`);
  }
  if (cmd === 'withdraw') {
    const q = answer(reg, me, t[1], 'from');
    if (!q) return verdict('deny', `${t[1] || '<id>'} is not an open request this session made. Open requests: ${L.CLI}`);
    setState(q.id, { state: 'withdrawn', answeredAt: now, told: true });
    return verdict('allow', `${q.id} withdrawn.`);
  }
  if (cmd === 'handoff') {
    const q = answer(reg, me, t[1], 'to');
    if (!q) return verdict('deny', `${t[1] || '<id>'} is not an open request addressed to this session. Open requests: ${L.CLI}`);
    return handOver(reg, q, now, false);
  }
  if (cmd === 'force-handoff') {
    const q = answer(reg, me, t[1], 'from');
    if (!q) return verdict('deny', `${t[1] || '<id>'} is not an open request this session made. Open requests: ${L.CLI}`);
    const live = L.isLive(reg.sessions[q.to], now);
    const waited = now - q.at;
    if (live && waited < DEADLINE_MS) {
      return verdict('deny', `"${L.label(reg, q.to)}" is live and has had ${Math.floor(waited / 60e3)} of ${L.HANDOFF_MIN} minutes. ` +
        `Carry on with other work and retry after ${new Date(q.at + DEADLINE_MS).toLocaleTimeString()}.`);
    }
    return verdict('ask', `force-handoff ${q.id}: "${L.label(reg, q.to)}" ${live ? `has not answered in ${L.HANDOFF_MIN} minutes` : 'has closed or gone quiet'}. ` +
      `Approving hands ${q.path} and its unfinished change to "${L.label(reg, me)}". Only the user can approve it.`);
  }
  return verdict('deny', `unknown request command "${cmd}". Run ${L.CLI} help.`);
}

// Facts, never a score: when the session last acted, how many files its worktree has in progress, its locks.
function workload(reg, id) {
  const s = reg.sessions[id];
  if (!s) return 'unknown';
  const bits = [`seen ${L.ago(s.lastSeen)}`];
  const top = s.top || (s.cwd && (L.findRepo(s.cwd) || {}).top);
  if (top) {
    const files = new Set();
    const base = L.baseRef(top);
    // from the fork point, not base's tip: files merged upstream since the fork are other sessions' work
    const fork = base ? L.git(top, ['merge-base', 'HEAD', base]) : null;
    if (fork && fork.code === 0) {
      const d = L.git(top, ['diff', '--name-only', fork.out.trim()]);
      if (d.code === 0) d.out.split('\n').filter(Boolean).forEach((f) => files.add(f));
    }
    const st = L.git(top, ['status', '--porcelain']);
    if (st.code === 0) L.statusPaths(st.out).forEach((f) => files.add(f));
    bits.push(`${files.size} ${files.size === 1 ? 'file' : 'files'} open`);
  }
  const locks = Object.values(reg.locks).filter((l) => l.session === id).map((l) => l.name);
  if (locks.length) bits.push(`holds ${locks.join(', ')}`);
  return bits.join(', ');
}

// Commands first and the change text last, so clipping at MAX_NOTICE never cuts a command.
function ownerNotice(reg, q) {
  const from = L.label(reg, q.from);
  return clip(`COORD REQUEST ${q.id} from "${from}" for ${q.path}. Answer with one command: ${L.CLI} done ${q.id} once you made ` +
    `the change, or ${L.CLI} handoff ${q.id} to pass the file on together with your unfinished edits. ` +
    `Workload: you ${workload(reg, q.to)}; "${from}" ${workload(reg, q.from)}. After ${L.HANDOFF_MIN} minutes "${from}" may ask the user ` +
    `to force it. Change: ${q.change}`, MAX_NOTICE);
}

function requesterNotice(reg, q) {
  const owner = L.label(reg, q.to);
  if (q.state === 'done') {
    return `COORD ${q.id}: "${owner}" made your change to ${q.path} in its own branch; it ships with its PR. Do not edit ${q.path} yourself.`;
  }
  if (q.state === 'resolved') {
    return `COORD ${q.id}: ${q.path} is free now ("${owner}" no longer holds unshipped changes to it). ` +
      `Update your branch from origin/main first, then make your change.`;
  }
  if (q.state === 'handed') {
    return `COORD ${q.id}: "${owner}" handed ${q.path} to you${q.forced ? ' (approved by the user)' : ''}. ` +
      (q.patch ? `Apply its unfinished change first, in your worktree: git -C "${q.dest}" apply --3way "${q.patch}". Then make your change.`
        : q.shipped ? `Its change to it is already on ${q.shipped}: update your branch from ${q.shipped} first, then make your change.` : 'Make your change.') +
      ' The file is held for you for 30 minutes.';
  }
  return '';
}

function forcedNotice(reg, q) {
  const from = L.label(reg, q.from);
  return `COORD ${q.id}: the user approved handing ${q.path} to "${from}". Drop it from your branch: ` +
    `${dropCmd(q.ownerTop, q.fork, q.path, q.added)}, then commit. Pushing ${q.path} is blocked while "${from}" holds it.`;
}

// Whether a request still owes this kind of notice: checked on the startup snapshot and again on the locked record.
const owes = {
  shown: (q, now) => q.state === 'open' && (q.shown || 0) < SHOW_MAX && now - (q.lastShown || 0) >= SHOW_EVERY_MS,
  told: (q) => q.told === false,
  ownerTold: (q) => Boolean(q.forced) && q.ownerTold === false,
};

// What this session should be told on this tool call: one mark per notice, each with its own text.
function notices(reg, me, now) {
  const marks = [];
  for (const q of reg.requests) {
    if (q.to === me && owes.shown(q, now)) {
      marks.push({ id: q.id, field: 'shown', text: ownerNotice(reg, q) });
    } else if (q.from === me && q.state !== 'open' && owes.told(q)) {
      marks.push({ id: q.id, field: 'told', text: requesterNotice(reg, q) });
    } else if (q.to === me && owes.ownerTold(q)) {
      marks.push({ id: q.id, field: 'ownerTold', text: forcedNotice(reg, q) });
    }
  }
  return { text: marks.map((m) => m.text).filter(Boolean).join('\n\n'), marks };
}

// Claims the marks on the fresh, locked record and returns only those this call advanced, so parallel tool
// calls (one hook process each, same startup snapshot) show a notice once instead of once per call.
function markShown(r, marks, now) {
  const won = [];
  for (const m of marks) {
    const q = find(r, m.id);
    if (!q || !owes[m.field](q, now)) continue;
    if (m.field === 'shown') {
      q.shown = (q.shown || 0) + 1;
      q.lastShown = now;
    } else {
      q[m.field] = true;
    }
    won.push(m);
  }
  return won;
}

// The requester's open requests whose owner no longer holds an active claim become resolved. git runs outside
// the registry lock; the result is written under it and mirrored into the in-memory reg for this call's notices.
function autoResolve(reg, me, now) {
  const due = reg.requests.filter((q) => q.from === me && q.state === 'open' && now - (q.checkedAt || q.at) >= RESOLVE_EVERY_MS);
  if (!due.length) return;
  const ids = new Set(due.map((q) => q.id));
  const freed = new Set(due.filter((q) => {
    const c = reg.claims.find((x) => x.session === q.to && x.repo === q.repo && L.same(x.path, q.path));
    return !c || !L.claimActive(c);
  }).map((q) => q.id));
  const apply = (r) => {
    for (const q of r.requests) {
      if (!ids.has(q.id)) continue;
      q.checkedAt = now;
      if (freed.has(q.id) && q.state === 'open') Object.assign(q, { state: 'resolved', answeredAt: now, told: false });
    }
  };
  L.update(apply);
  apply(reg);
}

module.exports = {
  COMMANDS, DEADLINE_MS, HELD_MS, RESOLVE_EVERY_MS, command, notices, markShown, workload, handOver, applyHandoff, autoResolve,
};
