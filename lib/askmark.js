// The mark a safety hook leaves when it asks (the system pack's hq-ask-mark.js): one file per ask, keyed by the call.
// Claude Code's PermissionRequest input carries no reason and no tool_use_id, so the bridge finds the
// mark for the prompt it handles by the same key the hook computed. askKey is a copy of the hook's; both test files
// carry the same vector. A mark only ever adds caution: it keeps a call out of Approve all safe and out of a window.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_AGE = 10 * 60e3; // a mark older than this belongs to an ask long answered; it is deleted, not used
const HOOK_MAX = 64;
const REASON_MAX = 300;

// JSON with object keys sorted at every depth, as the hook's canon
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}

const askKey = (sessionId, toolName, toolInput) => crypto.createHash("sha256").update(sessionId + "\n" + toolName + "\n" + canon(toolInput)).digest("hex");

const rm = (fp) => {
  try {
    fs.unlinkSync(fp);
  } catch {}
};

// The mark for this call as { hook, reason }, read once and deleted, or null. A mark over 10 minutes old is deleted
// unused, and so is any other mark file left that long. A mark of the wrong shape still says a hook asked, its fields
// made text and cut to what a request carries; a file that is not JSON is dropped. It never throws.
function takeMark(homeDir, sessionId, toolName, toolInput, now) {
  const dir = path.join(homeDir, ".claude", "hq-feed", "hook-asks");
  let found = null;
  try {
    const fp = path.join(dir, askKey(String(sessionId), String(toolName), toolInput) + ".json");
    let text = null;
    try {
      text = fs.readFileSync(fp, "utf8");
    } catch {}
    if (text !== null) {
      rm(fp);
      let m = null;
      try {
        m = JSON.parse(text);
      } catch {}
      if (m && typeof m === "object" && Number.isFinite(m.at) && now - m.at <= MAX_AGE)
        found = { hook: (typeof m.hook === "string" ? m.hook : "").slice(0, HOOK_MAX), reason: (typeof m.reason === "string" ? m.reason : "").slice(0, REASON_MAX) };
    }
    for (const name of fs.readdirSync(dir)) {
      const other = path.join(dir, name);
      try {
        if (now - fs.statSync(other).mtimeMs > MAX_AGE) rm(other);
      } catch {}
    }
  } catch {}
  return found;
}

module.exports = { askKey, takeMark };
