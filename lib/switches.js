// The agents switched off on the page. VibeQuarters writes <dataDir>/hq-feed/agents-off.json as one JSON line:
// { v: 1, at, off: [{ id, name, agentTypes }] }, the off agents in config order with their names and subagent types from
// the config; the system pack's hq-agent-switch.js hook (registered by its installer as a PreToolUse hook on Agent|Task)
// reads it and denies a subagent of an off agent's types. A file that is missing, unreadable, over 64 KB, not JSON,
// another version or with no list reads as every agent on, and an id the config does not have is dropped.
const fs = require("fs");
const path = require("path");

const FILE_MAX = 64 * 1024;
const SETTINGS_MAX = 4 * 1024 * 1024;
const HOOK = "hq-agent-switch"; // the system pack's hook file, hq-agent-switch.js

function createSwitches({ file, agents }) {
  const known = new Set(agents.map((a) => a.id));
  // The file as written, or null for one that is missing, unreadable, too big, not JSON, another version or has no list
  function read() {
    try {
      if (fs.statSync(file).size > FILE_MAX) return null;
      const f = JSON.parse(fs.readFileSync(file, "utf8"));
      return f && f.v === 1 && Array.isArray(f.off) ? f : null;
    } catch {
      return null;
    }
  }
  const f = read();
  let off = new Set(f ? f.off.filter((e) => e && known.has(e.id)).map((e) => e.id) : []);

  const listOf = (ids) => agents.filter((a) => ids.has(a.id)).map((a) => ({ id: a.id, name: a.name, agentTypes: a.agentTypes || [] }));
  // Written with temp plus rename, so the hook never reads half a file; false when any step fails, the temp file removed.
  function write(ids, now) {
    const tmp = file + ".tmp" + process.pid;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: now, off: listOf(ids) }) + "\n");
      fs.renameSync(tmp, file);
      return true;
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      return false;
    }
  }

  // { id, on } for one agent or { all: true, on } for every one; the switches change only once the file is written
  function set(body, now) {
    const all = !!body && body.all === true;
    if (!body || typeof body.on !== "boolean" || (!all && typeof body.id !== "string")) return { ok: false, error: "id or all, and on true or false" };
    if (!all && !known.has(body.id)) return { ok: false, error: "no such agent" };
    const next = new Set(off);
    for (const id of all ? known : [body.id]) {
      if (body.on) next.delete(id);
      else next.add(id);
    }
    if (!write(next, now)) return { ok: false, error: "could not save the switches" };
    off = next;
    return { ok: true };
  }

  // The file rewritten when its list is not what the switches would write now (an id gone from the config, a name or
  // types changed since); true when it was. A missing file stays missing.
  function resync(now) {
    if (!fs.existsSync(file)) return false;
    const was = read();
    if (was && JSON.stringify(was.off) === JSON.stringify(listOf(off))) return false;
    return write(off, now);
  }

  return { offIds: () => new Set(off), set, resync };
}

// Whether Claude Code's settings (<dataDir>/settings.json) register the switch hook, so an off switch is enforced: a
// hook entry under PreToolUse whose command or args name hq-agent-switch. Read again only when the file changes. Only
// the user's own settings are read; a missing or unreadable file reads as not registered.
function createEnforcement(settingsFile) {
  let seen = { mtimeMs: null, size: null, on: false };
  return function enforced() {
    let st;
    try {
      st = fs.statSync(settingsFile);
    } catch {
      return false;
    }
    if (st.mtimeMs === seen.mtimeMs && st.size === seen.size) return seen.on;
    let on = false;
    try {
      if (st.size <= SETTINGS_MAX) on = registers(JSON.parse(fs.readFileSync(settingsFile, "utf8")));
    } catch {}
    seen = { mtimeMs: st.mtimeMs, size: st.size, on };
    return on;
  };
}
function registers(settings) {
  const groups = settings && settings.hooks && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  return groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h && [h.command, ...(Array.isArray(h.args) ? h.args : [])].some((x) => typeof x === "string" && x.includes(HOOK))));
}

module.exports = { createSwitches, createEnforcement };
