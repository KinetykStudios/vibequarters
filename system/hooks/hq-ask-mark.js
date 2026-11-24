// hq-ask-mark :: shared helper, not a hook
// A safety hook that answers "ask" calls markAsk right before it prints, leaving one file HQ reads, so HQ knows the
// prompt it shows came from a hook and never answers it for the user. Claude Code's PermissionRequest input carries
// no reason and no tool_use_id, so the file is keyed by what both sides see: session, tool name and tool input.
// NEVER THROWS: a mark that cannot be written leaves the hook's own answer exactly as it was.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// JSON with object keys sorted at every depth, so HQ and the hook agree on one key.
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

function askKey(sessionId, toolName, toolInput) {
  return crypto.createHash('sha256').update(sessionId + '\n' + toolName + '\n' + canon(toolInput)).digest('hex');
}

function markAsk(input, hook, reason) {
  try {
    const key = askKey(String(input.session_id || ''), String(input.tool_name || ''), input.tool_input || {});
    const dir = path.join(os.homedir(), '.claude', 'hq-feed', 'hook-asks');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, key + '.json');
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, hook, reason: String(reason || '').slice(0, 300), at: Date.now() }));
    fs.renameSync(tmp, file);
  } catch (_e) { /* never throws */ }
}

module.exports = { askKey, markAsk };
