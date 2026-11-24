#!/usr/bin/env node
// vibequarters learning-loop :: PostToolUse (acting tools)
// After every acting tool call, appends a short line to ACTION-LEDGER.jsonl (what was done, when, to what)
// and updates the RUNSTATE.json counters that guard-runaway.js reads. Read-only tools are skipped.
// Both files are bounded. FAILS OPEN, never blocks. Kill switch: VIBEQUARTERS_GUARD=off.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function done() { process.exit(0); }

function loopDir(cwd) {
  const key = String(cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', key, 'memory', 'loop');
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') done();

  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const tool = String(input.tool_name || '');

  // Only log acting/mutating tools. Reading is not an "action" worth a forensic line.
  const READONLY = new Set(['Read', 'Glob', 'Grep', 'TodoWrite', 'NotebookRead', 'BashOutput',
    'WebFetch', 'WebSearch', 'ToolSearch', 'TaskOutput', 'BashOutput']);
  if (READONLY.has(tool)) done();

  const dir = loopDir(input.cwd);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) {}

  // A path or a short command head, with what looks like a secret masked (best effort: hygiene.tokenPatterns, and the
  // value of a name that says key, token, secret or password).
  const ti = input.tool_input || {};
  let target = ti.file_path || ti.path || ti.command || ti.url || ti.pattern || '';
  target = String(target).slice(0, 4000);
  try {
    for (const s of require('./vibequarters-config').load().hygiene.tokenPatterns) target = target.replace(new RegExp(s, 'g'), '***');
  } catch (_e) {}
  target = target.replace(/((?:key|token|secret|passw(?:or)?d|pwd)["']?(?:\s*[=:]\s*|\s+))["']?[^\s"']{6,}/gi, '$1***');
  target = target.replace(/\s+/g, ' ').slice(0, 160);
  const ts = new Date().toISOString();

  // MCP tools carry none of those fields. A short digest of the input keeps different calls apart.
  // A hash, never the payload: MCP inputs can carry query text.
  let sig = `${tool}:${target}`;
  if (!target) {
    let digest = '';
    try {
      digest = require('crypto').createHash('sha1')
        .update(JSON.stringify(ti) || '').digest('hex').slice(0, 10);
    } catch (_e) {}
    sig = `${tool}#${digest}`;
  }

  // File edits: the path alone would make different edits of one file look like a repeat, so a digest
  // of the change is added. The same edit retried still repeats. A hash, never the text.
  if (target && ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) {
    try {
      const change = JSON.stringify([ti.old_string, ti.new_string, ti.content, ti.edits, ti.new_source, ti.cell_id]);
      sig += '#' + require('crypto').createHash('sha1').update(change || '').digest('hex').slice(0, 10);
    } catch (_e) {}
  }
  // Shell commands: commands with the same first 160 characters may still differ, so a digest of the
  // whole command is added.
  if (target && tool === 'Bash') {
    try {
      sig += '#' + require('crypto').createHash('sha1').update(String(ti.command)).digest('hex').slice(0, 10);
    } catch (_e) {}
  }

  // 1) Append to the forensic ledger (JSONL), bounded to last 500 lines.
  try {
    const ledger = path.join(dir, 'ACTION-LEDGER.jsonl');
    // The session id lets loop-session-stop.js count one session's work, not every session's.
    const row = { ts, tool, target };
    if (input.session_id) row.sid = String(input.session_id).slice(0, 64);
    fs.appendFileSync(ledger, JSON.stringify(row) + '\n');
    const lines = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 500) fs.writeFileSync(ledger, lines.slice(-500).join('\n') + '\n');
  } catch (_e) {}

  // 2) Bump RUNSTATE counters so the runaway-halt PreToolUse hook can read them.
  try {
    const rsPath = path.join(dir, 'RUNSTATE.json');
    let rs = { actions: 0, byTool: {}, recent: [] };
    try { rs = JSON.parse(fs.readFileSync(rsPath, 'utf8')); } catch (_e) {}

    // The counters cover one session, so they start again when the session changes.
    const session = String(input.session_id || '');
    if (session && rs.session !== session) {
      rs = { actions: 0, byTool: {}, recent: [], session };
    }
    rs.session = session || rs.session;

    rs.actions = (rs.actions || 0) + 1;
    rs.byTool = rs.byTool || {};
    rs.byTool[tool] = (rs.byTool[tool] || 0) + 1;
    // Track recent action signatures to detect repetition (same tool+target hammering).
    rs.recent = (rs.recent || []).concat(sig).slice(-20);
    rs.updated = ts;
    fs.writeFileSync(rsPath, JSON.stringify(rs));
  } catch (_e) {}

  done();
} catch (_e) {
  process.exit(0); // FAIL OPEN
}
