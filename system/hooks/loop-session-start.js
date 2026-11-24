#!/usr/bin/env node
// vibequarters learning-loop :: SessionStart
// Auto-injects the learning-loop master (LEARNING-LOG.md) into the session context
// so the lessons load in every session, whether or not the agent remembers to read
// them. Also surfaces a PENDING-EVOLVE nag if the last session ended
// without distilling. FAILS OPEN: any error -> empty output, session proceeds normally.
// Kill switch: VIBEQUARTERS_GUARD=off.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function emit(context) {
  // SessionStart contract: stdout JSON with hookSpecificOutput.additionalContext
  // gets injected into the model's context at session start.
  if (context && context.trim()) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    }));
  }
  process.exit(0);
}

// Resolve THIS project's loop dir from the session cwd, matching Claude Code's project-key
// convention (full path, non-alphanumerics -> dashes). Project-agnostic: the same hook in any
// project's settings finds that project's lessons. Returns null if no loop dir exists there yet.
function resolveLoopDir(cwd) {
  if (!cwd) return null;
  const key = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', key, 'memory', 'loop');
  try { if (fs.existsSync(path.join(dir, 'LEARNING-LOG.md'))) return dir; } catch (_e) {}
  return null;
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') process.exit(0);

  const input = (() => { try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_e) { return {}; } })();
  const cwd = input.cwd || process.cwd();

  // The session's own project loop, else the configured default project's (loop.defaultProject), else nothing.
  const fallback = require('./vibequarters-config').expand(require('./vibequarters-config').load().loop.defaultProject);
  const LOOP = resolveLoopDir(cwd) || (fallback ? resolveLoopDir(fallback) : null);
  if (!LOOP) process.exit(0);
  const masterPath = path.join(LOOP, 'LEARNING-LOG.md');
  const inboxPath = path.join(LOOP, 'INBOX.md');
  const pendingPath = path.join(LOOP, '.pending-evolve');
  // The command this hook tells the agent to run. If it is missing, capture keeps running and
  // nothing consumes the backlog, silently, because a nag with no target makes no noise. Never
  // assume a referenced command exists; check the file and say so loudly when it is gone. It may
  // be the installer's copy in ~/.claude/commands or a project's own .claude/commands.
  const evolveCmdPaths = [path.join(os.homedir(), '.claude', 'commands', 'evolve.md'), path.join(cwd, '.claude', 'commands', 'evolve.md')];
  const evolveCmdPath = evolveCmdPaths[0];

  let master = '';
  try { master = fs.readFileSync(masterPath, 'utf8'); } catch (_e) { /* no master yet */ }
  if (!master) process.exit(0); // nothing to load, stay silent

  let parts = [];
  parts.push('## Project ledgers (loaded by loop-session-start.js)');
  parts.push('');
  parts.push('Lessons recorded in earlier sessions of this project, from `memory/loop/LEARNING-LOG.md`.');
  parts.push('Details are in the ledgers next to it. The Stop hook notes which sessions had activity,');
  parts.push('and `/evolve` turns those notes into entries.');
  parts.push('');
  // Everything from "Recent sessions" on stays in the file for /evolve but is not injected.
  const historyAt = master.indexOf('\n## Recent sessions');
  parts.push((historyAt > 0 ? master.slice(0, historyAt) : master).trim());

  // Waiting signals or a pending-evolve flag are mentioned.
  let pending = false;
  try { pending = fs.existsSync(pendingPath); } catch (_e) {}
  let inboxLines = 0;
  try {
    const inbox = fs.readFileSync(inboxPath, 'utf8');
    inboxLines = inbox.split('\n').filter((l) => l.trim().startsWith('- ')).length;
  } catch (_e) {}

  // The flag says AUTORUN when loop.autoEvolve is on; then the session runs /evolve by itself.
  let autorun = false;
  try { autorun = /AUTORUN/.test(fs.readFileSync(pendingPath, 'utf8')); } catch (_e) {}

  // Make sure the command exists before telling anyone to run it.
  let evolveExists = false;
  try { evolveExists = evolveCmdPaths.some((p) => fs.existsSync(p)); } catch (_e) {}

  if (pending || inboxLines > 0) {
    parts.push('');
    if (!evolveExists) {
      parts.push('## `/evolve` is MISSING');
      parts.push(`${inboxLines} captured signal(s) are waiting, but \`${evolveCmdPath}\` does not exist, so nothing`);
      parts.push('can process them. Tell the user before other work and offer to reinstall the command');
      parts.push('(node install/install.js).');
    } else if (autorun) {
      parts.push('## `/evolve` is due (loop.autoEvolve is on)');
      parts.push(`${inboxLines} captured signal(s) are waiting from earlier sessions. Run \`/evolve\` at the next`);
      parts.push('break between tasks, without asking first. Do not interrupt work in progress for it.');
    } else {
      parts.push('## Signals are waiting');
      parts.push(`${inboxLines} captured signal(s) in INBOX.md` + (pending ? ' and a pending-evolve flag.' : '.') +
        ' Suggest `/evolve` when the current task is done.');
    }
  }

  emit(parts.join('\n'));
} catch (_e) {
  process.exit(0); // FAIL OPEN
}
