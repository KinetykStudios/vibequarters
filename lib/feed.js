// What each chat's hq-feed mod (part of the system pack) reports, and the keep-warm switch the page sets for it. The
// mod writes <dir>/<session id>.json: { v, sessionId, updatedAt, warm: { on, pings, lastPingAt, stopped }, brake }. The
// app writes <dir>/control/<session id>.json: { keepWarm, at }, which the mod reads. A file that is missing, too big or
// not JSON counts as no report; nothing here ever stops the rest of the payload.
const fs = require("fs");
const path = require("path");

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FEED_MAX = 16 * 1024;
const STALE_MS = 24 * 60 * 60e3; // a report not written for a day is from a chat that is gone

const num = (x) => (Number.isFinite(x) ? x : null);
function clean(v) {
  if (!v || typeof v !== "object") return null;
  const w = v.warm && typeof v.warm === "object" ? v.warm : {};
  const b = v.brake && typeof v.brake === "object" ? v.brake : {};
  return {
    updatedAt: num(v.updatedAt),
    warm: { on: w.on === true, pings: num(w.pings) || 0, lastPingAt: num(w.lastPingAt), stopped: typeof w.stopped === "string" ? w.stopped.slice(0, 120) : null },
    brake: { asks: num(b.asks) || 0, lastAt: num(b.lastAt), opusThisTurn: num(b.opusThisTurn) || 0 },
  };
}

function createFeed(dir) {
  const files = new Map(); // session id -> { mtimeMs, size, v }

  function read(now = Date.now()) {
    if (!dir) return;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      files.clear();
      return;
    }
    const seen = new Set();
    for (const n of names) {
      const id = n.endsWith(".json") ? n.slice(0, -5) : null;
      if (!id || !SESSION.test(id)) continue;
      let st;
      try {
        st = fs.statSync(path.join(dir, n));
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > FEED_MAX || now - st.mtimeMs > STALE_MS) continue;
      seen.add(id);
      const was = files.get(id);
      if (was && was.mtimeMs === st.mtimeMs && was.size === st.size) continue;
      let v = null;
      try {
        v = clean(JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")));
      } catch {
        v = was ? was.v : null; // half written: keep the last good read, try again next refresh
      }
      files.set(id, { mtimeMs: st.mtimeMs, size: st.size, v });
    }
    for (const id of [...files.keys()]) if (!seen.has(id)) files.delete(id);
  }

  const get = (id) => (files.has(id) ? files.get(id).v : null);

  function controlOf(id) {
    if (!dir || !SESSION.test(id)) return null;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, "control", id + ".json"), "utf8"));
      return { keepWarm: c && c.keepWarm === true };
    } catch {
      return null;
    }
  }

  // Written with temp plus rename, so the mod never reads half a file.
  function setWarm(id, on, now = Date.now()) {
    if (!dir || !SESSION.test(id) || typeof on !== "boolean") return false;
    const ctl = path.join(dir, "control");
    fs.mkdirSync(ctl, { recursive: true });
    const fp = path.join(ctl, id + ".json");
    const tmp = fp + ".tmp" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ keepWarm: on, at: now }));
    fs.renameSync(tmp, fp);
    return true;
  }

  return { read, get, controlOf, setWarm };
}

module.exports = { createFeed, SESSION };
