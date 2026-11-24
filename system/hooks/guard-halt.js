#!/usr/bin/env node
// vibequarters :: PreToolUse (ALL tools)
// THE KILL SWITCH. If an out-of-band halt flag exists, DENY every mutating/acting tool so the
// user can stop a runaway autonomous loop from outside the agent. The flag is a file the user
// (or a watchdog) can drop even while the agent is mid-run. Read-only tools stay allowed so the
// agent can still explain itself, but it can no longer act. Checked on every tool call; cheap. FAILS OPEN on its own bugs only.
//
// Activate:   create  ~/.claude/HALT   (or set env VIBEQUARTERS_HALT=on)
// Deactivate: delete that file          (or unset VIBEQUARTERS_HALT)
// Kill switch for the kill switch: VIBEQUARTERS_GUARD=off disables ALL VibeQuarters guards (use with care).
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function allow() { process.exit(0); }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') allow();

  // Read-only tools are always allowed even under halt, so the agent can still report.
  const READONLY = new Set([
    'Read', 'Glob', 'Grep', 'TodoWrite', 'NotebookRead', 'BashOutput',
    'WebFetch', 'WebSearch', 'ToolSearch', 'TaskOutput',
  ]);

  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const tool = String(input.tool_name || '');
  if (READONLY.has(tool)) allow();

  // Halt active if the flag file exists OR the env var is set.
  const haltFile = path.join(os.homedir(), '.claude', 'HALT');
  let halted = String(process.env.VIBEQUARTERS_HALT || '').toLowerCase() === 'on';
  try { if (!halted) halted = fs.existsSync(haltFile); } catch (_e) {}

  if (halted) {
    deny(
      'vibequarters: HALT is active. An out-of-band kill switch is engaged, so all acting/mutating ' +
      'tools are blocked. The agent can still read and report, but cannot act. To resume, delete ' +
      `${haltFile} (or unset VIBEQUARTERS_HALT). This brake exists to stop a runaway autonomous loop.`
    );
  }

  allow();
} catch (_e) {
  process.exit(0); // FAIL OPEN on the hook's own bug, never wedge real work
}
