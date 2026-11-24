#!/usr/bin/env node
// Session coordination CLI. With no command (or `board`) it prints the live board; after a command, one line pointing at it.
// Most commands are applied by the coord-guard.js PreToolUse hook, because only the hook knows the real id of the calling
// session; for those this script prints a confirmation.
// force-release / end-session override another session: the hook makes them ask the user, then this script applies them;
// they skip the ask, and release-closed runs, only when every session overridden is closed with nothing unpushed.
'use strict';
const L = require('./coord-lib');
const R = require('./coord-requests');

const [cmd = 'board', ...rest] = process.argv.slice(2);
const HELP = `usage: ${L.CLI} [board]
  register --name <ListAgents name> --task "<one line>"   sign this session in (required before repo work; without ListAgents, any unused short name)
  task "<one line>"                                        update this session's task
  release <path>                                           give up this session's claim on a file
  unlock <db-migration|edge-deploy|prod-deploy|merge>      release a lock this session holds
  note "<text>"                                            leave a note on the board
  request "<path>" "<change>"                              ask the session that owns a file for a change
  done <id>                                                (owner) the requested change is made in your branch
  withdraw <id>                                            (requester) cancel your request
  handoff <id>                                             (owner) hand the file and your unfinished change to the requester
  force-handoff <id>                                       (requester) after ${L.HANDOFF_MIN} minutes without an answer (the user approves)
  force-release <path>                                     drop every claim on a file (the user approves, unless every holder is closed with nothing unpushed)
  end-session <name>                                       mark a vanished session closed (the user approves, unless it is closed with nothing unpushed)
  release-closed <name>                                    drop the claims of a closed session with nothing unpushed (no approval)
  ship <PR#> [<PR#>...]                                    print the steps to land finished PRs yourself (/land)
  landed <PR#> --gate "<record>"                           append this landing's gate record to GATE-RECORDS.md, run from your worktree`;

try {
  if (cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    process.exit(0);
  }
  if (cmd === 'force-release' && rest[0]) {
    const abs = L.fromShellPath(rest[0], process.cwd());
    const repo = L.findRepo(abs);
    if (!repo) throw new Error(`${abs} is not inside a git repo`);
    const p = L.rel(repo.top, abs);
    const wasLive = new Set(Object.values(L.load().sessions).filter((s) => L.isLive(s)).map((s) => s.id));
    const n = L.update((r) => {
      const before = r.claims.length;
      // a holder that came back live since it was judged keeps its claim
      const kept = (c) => L.isLive(r.sessions[c.session]) && !wasLive.has(c.session);
      r.claims = r.claims.filter((c) => !(c.repo === repo.common && L.same(c.path, p)) || kept(c));
      return before - r.claims.length;
    });
    console.log(`Released ${n} claim(s) on ${p}.`);
  } else if (cmd === 'end-session' && rest[0]) {
    const name = rest.join(' '); // a name can hold a space, quoted or not
    const n = L.update((r) => {
      let count = 0;
      for (const s of Object.values(r.sessions)) {
        if (s.name !== name || s.endedAt) continue;
        s.endedAt = Date.now();
        s.endReason = 'ended via end-session';
        for (const [k, l] of Object.entries(r.locks)) if (l.session === s.id) delete r.locks[k];
        count++;
      }
      return count;
    });
    console.log(`Marked ${n} session(s) named "${name}" closed.`);
  } else if (cmd === 'release-closed' && rest[0]) {
    const name = rest.join(' ');
    const reg = L.load();
    const ids = Object.values(reg.sessions).filter((s) => s.name === name).map((s) => s.id);
    if (!ids.length) throw new Error(`no session is named "${name}"`);
    for (const id of ids) { // judged again here, outside the registry lock, so it holds with hooks off too
      const why = L.closedUnsafe(reg, id);
      if (why) throw new Error(`nothing released: ${why}`);
    }
    const now = Date.now();
    const n = L.update((r) => {
      if (ids.some((id) => L.isLive(r.sessions[id], now))) return null; // came back live since it was judged
      const mine = (x) => ids.includes(x.session);
      const before = r.claims.length;
      r.claims = r.claims.filter((x) => !mine(x));
      for (const q of r.requests) {
        if (q.state !== 'open') continue; // a record still owed a notice is never touched
        if (ids.includes(q.to)) Object.assign(q, { state: 'resolved', answeredAt: now, told: false });
        else if (ids.includes(q.from)) Object.assign(q, { state: 'withdrawn', answeredAt: now, told: true, autoWithdrawn: true });
      }
      return { released: before - r.claims.length };
    });
    if (!n) throw new Error(`nothing released: "${name}" is live again`);
    console.log(`Released ${n.released} claim(s) of "${name}".`);
  } else if (cmd === 'force-handoff' && rest[0]) {
    const reg = L.load();
    const q = reg.requests.find((x) => x.id === rest[0]);
    if (!q || q.state !== 'open') throw new Error(`${rest[0]} is not an open request`);
    const v = R.handOver(reg, q, Date.now(), true);
    if (v.decision !== 'allow') throw new Error(v.text);
    console.log(`Handed ${q.path} to "${L.label(reg, q.from)}"; "${L.label(reg, q.to)}" is told on its next action.`);
  } else if (['done', 'handoff', 'landed', 'note', 'register', 'release', 'request', 'ship', 'task', 'unlock', 'withdraw'].includes(cmd)) {
    console.log(`"${cmd}" was applied by the coord-guard hook for this session (if hooks are off, nothing changed; check the board).` +
      (cmd === 'register' ? ' A register that takes over a closed session lands right after this command, so the board may not show it yet.' : ''));
  } else if (cmd !== 'board') {
    console.log(HELP);
    process.exit(1);
  }
  if (cmd === 'board') process.stdout.write(`\n${L.render(L.load())}`);
  else console.log(`Full board: ${L.CLI} (or ~/.claude/coordination/BOARD.md).`);
} catch (e) {
  console.error(`coord: ${e.message}`);
  process.exit(1);
}
