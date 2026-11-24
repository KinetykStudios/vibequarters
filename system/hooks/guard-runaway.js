#!/usr/bin/env node
// vibequarters :: PreToolUse (acting tools)
// Runaway check. Reads RUNSTATE.json (kept by loop-action-ledger.js) and asks for confirmation after a very large
// number of actions in one session, or when one action is repeated over and over. It asks instead of denying, so a
// long run that is meant to be long continues with a click. Deleting RUNSTATE.json or starting a new session resets
// the counter. FAILS OPEN. Kill switch: VIBEQUARTERS_GUARD=off.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function allow() { process.exit(0); }

let input = {};
function ask(reason) {
  try { require('./hq-ask-mark.js').markAsk(input, 'guard-runaway.js', reason); } catch (_e) { /* the ask still prints */ }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
  }));
  process.exit(0);
}

// Thresholds. Generous enough for real long runs, tight enough to catch true runaways.
const MAX_ACTIONS = 400;     // acting-tool calls in one session before the first question
const MAX_REPEAT = 6;        // same tool+target signature repeated this many times = thrash

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') allow();

  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const tool = String(input.tool_name || '');
  const READONLY = new Set(['Read', 'Glob', 'Grep', 'TodoWrite', 'NotebookRead', 'BashOutput',
    'WebFetch', 'WebSearch', 'ToolSearch', 'TaskOutput']);
  if (READONLY.has(tool)) allow();
  // A question to the user is never a runaway: the chat already stops for them. And an ask here
  // would outrank the app's answer to it, which the app gives in its own PreToolUse, so a click in
  // the app would go nowhere.
  if (tool === 'AskUserQuestion') allow();

  const key = String(input.cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
  const rsPath = path.join(os.homedir(), '.claude', 'projects', key, 'memory', 'loop', 'RUNSTATE.json');

  let rs = null;
  try { rs = JSON.parse(fs.readFileSync(rsPath, 'utf8')); } catch (_e) { allow(); } // no state yet
  if (!rs) allow();

  // Asks only when the total crosses a multiple of MAX_ACTIONS.
  const actions = rs.actions || 0;
  if (actions > 0 && actions % MAX_ACTIONS === 0) {
    ask(`vibequarters: this session has executed ${actions} acting tool calls. Confirm that it should ` +
      `go on (runaway check). The counter resets when a new session starts.`);
  }

  // The same signature several times in a row. Only the trailing run counts: switching back and
  // forth between two files is ordinary work.
  const recent = Array.isArray(rs.recent) ? rs.recent : [];
  if (recent.length >= MAX_REPEAT) {
    const last = recent[recent.length - 1];
    let repeats = 0;
    for (let i = recent.length - 1; i >= 0 && recent[i] === last; i--) repeats++;
    if (repeats >= MAX_REPEAT) {
      ask(`vibequarters: the same action ("${String(last).slice(0, 80)}") has repeated ${repeats}x in a row - ` +
        `that looks like a stuck loop. If a hook, a classifier or the user refused it, repeating it will not help: use another ` +
        `approach. If it failed for a temporary reason such as a timeout or a rate limit, approving lets it try again. ` +
        `(runaway check)`);
    }
  }

  allow();
} catch (_e) {
  process.exit(0); // FAIL OPEN
}
