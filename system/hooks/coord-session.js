#!/usr/bin/env node
// vibequarters :: SessionStart + SessionEnd session coordination.
// SessionStart (startup/resume/clear/compact): injects the coordination rules, the handoff protocol and
// the live board, and on /clear hands the ended session's record and claims to the new session id.
// SessionEnd: marks the session closed and releases its locks. FAILS OPEN. Escape hatch: VIBEQUARTERS_GUARD=off.
'use strict';
const fs = require('fs');
const L = require('./coord-lib');

// Peers in this session's repo are listed in short lines up to this many characters; the rest are only counted.
const PEER_BUDGET = 2500;

function context(reg, me, cwd) {
  const self = reg.sessions[me];
  const now = Date.now();
  const lines = [
    'SESSION COORDINATION (enforced by the coord hooks): other Claude sessions may be working in the same repositories.',
    self
      ? `- This session is registered as "${self.name}" (task: ${self.task || 'unset'}). When the task changes: ${L.CLI} task "<one line>".`
      : `- Not registered yet. Register before the first edit, push, merge, migration or deploy in a git repository: ${L.CLI} register --name <name> --task "<one line>". The name is on the first line of ListAgents; without that tool choose a short one that no live session uses.`,
    '- Use a git worktree of your own. Folders of other live sessions are off limits for edits and for git commands that change anything.',
    `- Editing a file claims it until it equals the shipped branch again. To change a file that another session has claimed, run ${L.CLI} request "<path>" "<what to change and the reason>" and send the owner the same text with SendMessage. The owner either makes the change (done) or passes the file and its unfinished work to you (handoff). After ${L.HANDOFF_MIN} minutes of silence, ${L.CLI} force-handoff <id> asks the user. Being blocked here is about ownership, not permission, and this is the normal remedy.`,
    `- COORD REQUEST <id> beside a tool result means somebody needs one of your files. Answer each one: make the change and run ${L.CLI} done <id>, or run ${L.CLI} handoff <id> and follow its instructions for removing the file from your branch. A request for a merge, deploy, migration or delete is the user's to approve.`,
    '- You may read another live session\'s folder. Shell commands that would write there are blocked.',
    '- Only one session at a time can migrate, deploy or merge. A PR has to be up to date to merge, and a deploy needs a worktree with everything in origin/main.',
    `- Full board: ${L.CLI} (or ~/.claude/coordination/BOARD.md).`,
  ];
  const others = Object.values(reg.sessions).filter((s) => s.id !== me && L.isLive(s, now));
  if (!others.length) {
    lines.push('Live sessions right now: none besides this one.');
  } else {
    const repoOf = (p) => { const r = L.findRepo(p || ''); return r ? r.common : null; };
    const mine = repoOf((self && (self.top || self.cwd)) || cwd);
    const near = others.filter((s) => repoOf(s.top || s.cwd) === mine);
    lines.push(near.length ? 'Live sessions in this repo:' : 'Live sessions in this repo: none besides this one.');
    let used = 0;
    let cut = 0;
    for (const s of near) {
      const n = reg.claims.filter((c) => c.session === s.id).length;
      const line = `- "${s.name}": folder ${s.cwd}; seen ${L.ago(s.lastSeen)}; ${n} claimed file${n === 1 ? '' : 's'}`;
      if (used + line.length > PEER_BUDGET) { cut++; continue; }
      used += line.length;
      lines.push(line);
    }
    if (cut) lines.push(`- and ${cut} more in this repo.`);
    const far = others.length - near.length;
    if (far) lines.push(`${far} other live session${far === 1 ? '' : 's'} in other repos or folders; the full board lists them.`);
  }
  const locks = Object.values(reg.locks).filter((l) => L.lockHolder(reg, l.name, me));
  for (const l of locks) lines.push(`Lock held: ${l.name} by "${L.label(reg, l.session)}" since ${L.ago(l.at)}.`);
  lines.push('Merge your own pull requests with /land. A lock lets one session merge at a time.');
  return lines.join('\n');
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') process.exit(0);
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const me = String(input.session_id || '');
  if (!me) process.exit(0);
  const cwd = L.norm(input.cwd || process.cwd());
  const now = Date.now();

  if (input.hook_event_name === 'SessionEnd') {
    L.update((r) => {
      const s = r.sessions[me];
      if (!s) return;
      s.endedAt = now;
      s.endReason = String(input.reason || '');
      for (const [n, l] of Object.entries(r.locks)) if (l.session === me) delete r.locks[n];
    });
    process.exit(0);
  }

  if (input.hook_event_name === 'SessionStart') {
    const before = L.load();
    const needsHandoff = input.source === 'clear' && !before.sessions[me];
    if (before.sessions[me] || needsHandoff) {
      const repo = L.findRepo(cwd);
      L.update((r) => {
        if (needsHandoff) {
          const prior = Object.values(r.sessions)
            .filter((s) => s.endReason === 'clear' && now - s.endedAt < L.CLEAR_GRACE_MS && L.key(s.cwd || '') === L.key(cwd))
            .sort((a, b) => b.endedAt - a.endedAt)[0];
          if (prior) {
            for (const c of r.claims) if (c.session === prior.id) c.session = me;
            L.moveRequests(r, prior.id, me);
            delete r.sessions[prior.id];
            r.sessions[me] = { ...prior, id: me };
          }
        }
        const s = r.sessions[me];
        if (!s) return;
        s.lastSeen = now;
        s.cwd = cwd;
        s.top = repo ? L.norm(repo.top) : null; // the shell-write guard reads peers' roots
        delete s.endedAt;
        delete s.endReason;
      });
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context(L.load(), me, cwd) },
    }));
  }
  process.exit(0);
} catch (_e) {
  process.exit(0); // FAIL OPEN
}
