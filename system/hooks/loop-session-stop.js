#!/usr/bin/env node
// vibequarters learning-loop :: Stop
// Decides whether the session had real activity. If so, it notes the session in INBOX.md and leaves a
// `.pending-evolve` flag that the next SessionStart hook reports. FAILS OPEN, writes at most 2 small files.
// Kill switch: VIBEQUARTERS_GUARD=off.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Mirror of the truncation limit in loop-action-ledger.js. A ledger sitting at this
// length has had older rows dropped, so a count equal to it is a lower bound.
const LEDGER_CAP = 500;

// Run git with an argument array (no shell) so nothing can be injected. Args here are
// all hardcoded literals anyway, but execFile is the safe-by-default choice.
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 4000 });
}

// Resolve THIS project's loop dir from the session cwd (Claude Code project-key convention).
function resolveLoopDir(cwd) {
  if (!cwd) return null;
  const key = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', key, 'memory', 'loop');
  try { if (fs.existsSync(path.join(dir, 'LEARNING-LOG.md'))) return dir; } catch (_e) {}
  return null;
}

function done() { process.exit(0); }

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') done();

  const input = (() => { try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_e) { return {}; } })();
  const PROJECT = input.cwd || process.cwd();
  // Only a plain id is used: it lands in a markdown file /evolve reads, and a newline in it
  // would forge a signal line.
  const SID = /^[A-Za-z0-9-]{1,64}$/.test(String(input.session_id || '')) ? String(input.session_id) : '';

  // The session's own project loop, else the configured default project's (loop.defaultProject). With neither, only
  // the action-ledger fallback below can find a learning log to file the signal in.
  const fallback = require('./vibequarters-config').expand(require('./vibequarters-config').load().loop.defaultProject);
  const LOOP = resolveLoopDir(PROJECT) || (fallback ? resolveLoopDir(fallback) : null);

  // "Substantive" = there is uncommitted work OR commits landed recently. Cheap git checks.
  // If git isn't available or this isn't a repo, we simply don't flag (fail safe, no nag).
  let substantive = false;
  let signal = '';
  try {
    const dirty = git(['status', '--porcelain'], PROJECT);
    const changedFiles = dirty.split('\n').filter((l) => l.trim()).length;
    if (changedFiles >= 1) { substantive = true; signal = `${changedFiles} changed file(s)`; }

    // Also count commits in the last ~6 hours as a substantive signal.
    const recent = git(['log', '--since=6 hours ago', '--oneline'], PROJECT);
    const recentCommits = recent.split('\n').filter((l) => l.trim()).length;
    if (recentCommits >= 1) { substantive = true; signal = signal ? `${signal}, ${recentCommits} recent commit(s)` : `${recentCommits} recent commit(s)`; }
  } catch (_e) { /* no git / not a repo -> fall through to the ledger signal below */ }

  // A session outside a repository has no git signal, so the action ledger decides. That ledger is
  // kept by the folder of each tool call, not of the session, so the project with the most recent
  // rows from this session is the one that gets the signal.
  let LEDGER_LOOP = LOOP;
  if (!substantive) {
    try {
      const since = Date.now() - 6 * 60 * 60 * 1000;
      const projects = path.join(os.homedir(), '.claude', 'projects');
      let best = 0;
      let bestCapped = false;
      for (const key of fs.readdirSync(projects)) {
        const dir = path.join(projects, key, 'memory', 'loop');
        // loop-action-ledger.js writes a ledger for any folder; skip those without LEARNING-LOG.md,
        // since no /evolve would read a signal there.
        if (!fs.existsSync(path.join(dir, 'LEARNING-LOG.md'))) continue;
        let acts = 0;
        let capped = false;
        try {
          const rows = fs.readFileSync(path.join(dir, 'ACTION-LEDGER.jsonl'), 'utf8')
            .split('\n').filter((l) => l.trim());
          // Count only this session's rows. Without an id: every row.
          const mine = (l) => {
            try { const r = JSON.parse(l); return new Date(r.ts).getTime() >= since && (!SID || r.sid === SID); } catch (_p) { return false; }
          };
          acts = rows.filter(mine).length;
          // At the cap with an oldest row of ours, older rows may be gone, so the count is a minimum.
          capped = rows.length >= LEDGER_CAP && mine(rows[0]);
        } catch (_p) { continue; }
        if (acts > best) { best = acts; bestCapped = capped; LEDGER_LOOP = dir; }
      }
      if (best >= 10) { substantive = true; signal = `${bestCapped ? '>=' : ''}${best} acting-tool call(s)`; }
    } catch (_e) { /* no ledgers -> genuinely nothing to go on, stay quiet */ }
  }

  if (!substantive || !LEDGER_LOOP) done(); // trivial session, or no project to file it in

  // When the ledger fallback picked a different project, write the signal there.
  // Same dir when the git signal fired, so the normal path is unchanged.
  const pendingPath = path.join(LEDGER_LOOP, '.pending-evolve');

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // 1) Record the signal in INBOX.md.
  try {
    const inboxPath = path.join(LEDGER_LOOP, 'INBOX.md');
    let body = '';
    try { body = fs.readFileSync(inboxPath, 'utf8'); } catch (_e) {}
    if (!body) {
      body = '# INBOX\n\n' +
        '> Written by loop-session-stop.js: one line for each session with activity. `/evolve` reads\n' +
        '> the lines and removes them.\n\n';
    }
    // Try to name what changed (files touched) for a more useful raw signal. Cheap, bounded.
    let detail = signal;
    try {
      const names = git(['status', '--porcelain'], PROJECT)
        .split('\n').map((l) => l.slice(3).trim()).filter(Boolean).slice(0, 8).join(', ');
      if (names) detail = `${signal} [${names}]`;
    } catch (_e) {}
    // The session id lets /evolve open its transcript.
    if (SID) detail = `${detail} (session ${SID})`;
    const line = `- [${stamp}] session signal: ${detail}`;
    // Stop fires every turn, so one session reaches here many times. When the newest line already says the
    // same thing, only its time is refreshed. A different signal is appended.
    let rows = body.split('\n');
    // One line per session: remove this session's older line, since other sessions may have written after it.
    if (SID) {
      rows = rows.filter((r) => !(r.startsWith('- [') && r.replace(/\r$/, '').endsWith(` (session ${SID})`)));
      body = rows.join('\n');
    }
    let lastIdx = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].startsWith('- [')) { lastIdx = i; break; }
    }
    const prevDetail = lastIdx >= 0
      ? rows[lastIdx].replace(/\r$/, '').replace(/^- \[[^\]]*\] session signal: /, '')
      : null;
    if (prevDetail === detail) {
      rows[lastIdx] = line;
      body = rows.join('\n');
    } else {
      body = body.replace(/\n*$/, '\n') + line + '\n';
    }
    // Bound INBOX to last 120 signal lines so it can never bloat.
    const all = body.split('\n');
    const idx = all.map((l, i) => (l.startsWith('- [') ? i : -1)).filter((i) => i >= 0);
    if (idx.length > 120) {
      const header = all.slice(0, idx[0]).join('\n');
      const kept = all.slice(idx[idx.length - 120]).join('\n');
      body = header + '\n' + kept;
    }
    fs.writeFileSync(inboxPath, body);
  } catch (_e) {}

  // 2) Leave the flag for the next SessionStart. It says AUTORUN when loop.autoEvolve is on.
  //    At most once a day: /evolve touches .last-evolve when it finishes, and within 20 hours of
  //    that the signal waits in INBOX for the next run instead of raising a flag.
  try {
    const last = fs.statSync(path.join(LEDGER_LOOP, '.last-evolve')).mtimeMs;
    if (Date.now() - last < 20 * 3600e3) done();
  } catch (_e) {}
  try {
    const auto = require('./vibequarters-config').load().loop.autoEvolve === true;
    fs.writeFileSync(pendingPath, `pending since ${stamp}\nsignal: ${signal}\n` +
      (auto ? 'AUTORUN: loop.autoEvolve is on.\n' : ''));
  } catch (_e) {}

  done();
} catch (_e) {
  process.exit(0); // FAIL OPEN
}
