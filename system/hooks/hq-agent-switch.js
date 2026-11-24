#!/usr/bin/env node
// vibequarters :: PreToolUse (Agent|Task)
// VibeQuarters' agent switches: when the user switches an agent off in the app, the app writes
// ~/.claude/hq-feed/agents-off.json as { v: 1, at, off: [{ id, name, agentTypes }] }. This hook DENIES
// an Agent or Task call whose subagent type (blank counts as general-purpose) an off agent's agentTypes lists, exactly or
// by a trailing-* prefix. Only v and off are read; every other key is ignored.
// FAILS OPEN: a missing, unreadable, oversized, non-JSON or foreign file, a bad entry, or a bug of its own lets the call through.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX = 65536;
// The same matcher the VibeQuarters app uses for agentTypes; keep the two the same.
const matches = (type, pats) => (pats || []).some((p) => (p.endsWith("*") ? type.startsWith(p.slice(0, -1)) : type === p));

function allow() { process.exit(0); }

function deny(name, type) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `VibeQuarters: the user switched ${name} off (VibeQuarters, agent switches), so a ${type} subagent cannot start now. ` +
        `Do not start the same work as a different subagent type; anything else may go on. ` +
        `Tell the user, or ask them to switch ${name} back on.`,
    },
  }));
  process.exit(0);
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') allow();
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') allow();
  const file = path.join(os.homedir(), '.claude', 'hq-feed', 'agents-off.json');
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > MAX) allow();
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!f || f.v !== 1 || !Array.isArray(f.off)) allow();
  const sub = (input.tool_input || {}).subagent_type;
  const type = (typeof sub === 'string' && sub.trim()) || 'general-purpose';
  for (const e of f.off) {
    // A bad entry is skipped: no string name, or agentTypes not a list of strings (a non-string would throw in matches).
    if (!e || typeof e.name !== 'string' || !Array.isArray(e.agentTypes) || !e.agentTypes.every((p) => typeof p === 'string')) continue;
    if (matches(type, e.agentTypes)) deny(e.name, type);
  }
  allow();
} catch (_e) {
  allow();
}
