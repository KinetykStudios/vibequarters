// The approve window: opened only by the owner, through a confirmed read-back, for 1 to 300 minutes and optionally
// named sessions. While it runs the HQ server answers allow for each open permission it covers that the approval levels
// (lib/levels.js) call routine, or that the judge (lib/judge.js) finds fine; anything they leave stays for the owner.
// Given a file, it survives an HQ restart for the time it has left, never longer.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MIN = 60e3;

// Covered: every permission, Risky ones, plans and safety prompts too, in the named sessions (or any session when
// none are named). A notice, a question and a finished turn never are. Which covered ones are approved is the levels'
// and the judge's call, in server.js.
const coversItem = (w, item) =>
  !!item && item.kind === "permission" && !item.notice &&
  (w.sessions === null || w.sessions.includes(item.sessionId));

const validSaved = (s, maxMs, now) =>
  !!s && typeof s.id === "string" && Number.isFinite(s.openedAt) && Number.isFinite(s.endsAt) &&
  s.endsAt > s.openedAt && s.endsAt - s.openedAt <= maxMs && s.endsAt > now && s.endsAt <= now + maxMs &&
  (s.sessions === null || (Array.isArray(s.sessions) && s.sessions.length > 0 && s.sessions.every((x) => typeof x === "string" && x))) &&
  Number.isInteger(s.approved) && !!s.tally && typeof s.tally === "object";

function createWindow({ maxMs = 300 * 60e3, file = null, now: bootNow = Date.now(), rm = fs.rmSync } = {}) {
  // A window the owner turned off must not reopen, so: empty the file, remove it, and if a lock stops both, name the
  // window in a second file that restore refuses.
  const offFile = file && file + ".off";
  const clear = (id) => {
    if (!file) return;
    let done = false;
    try { fs.writeFileSync(file, ""); done = true; } catch (_e) { /* try removing it */ }
    try { rm(file, { force: true }); done = true; } catch (_e) { /* left empty, which restores nothing */ }
    if (done) try { rm(offFile, { force: true }); } catch (_e) { /* names an old window, which harms nothing */ }
    else if (id) try { fs.writeFileSync(offFile, id); } catch (_e) { /* nothing left to try */ }
  };
  const turnedOff = (id) => {
    try { return fs.readFileSync(offFile, "utf8") === id; } catch (_e) { return false; }
  };
  const save = () => {
    if (file) try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(w));
    } catch (_e) { /* the window still runs in memory */ }
  };
  function restore() {
    if (!file) return null;
    let s;
    try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_e) { return null; }
    if (validSaved(s, maxMs, bootNow) && !turnedOff(s.id)) return s;
    clear();
    return null;
  }
  let w = restore(); // { id, openedAt, endsAt, sessions, approved, tally }
  let ended = [];

  function close(reason, now) {
    if (!w) return null;
    const e = { id: w.id, reason, approved: w.approved, endedAt: now, tally: { ...w.tally } };
    ended.push(e);
    w = null;
    clear(e.id);
    return e;
  }

  function current(now) {
    if (w && now >= w.endsAt) close("time", w.endsAt);
    return w ? { id: w.id, openedAt: w.openedAt, endsAt: w.endsAt, sessions: w.sessions && [...w.sessions], approved: w.approved } : null;
  }

  function open({ minutes, sessions = null } = {}, now) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 300 || minutes * MIN > maxMs) return { ok: false, error: "minutes must be a whole number from 1 to " + Math.min(300, Math.floor(maxMs / MIN)) };
    if (sessions !== null && !(Array.isArray(sessions) && sessions.length && sessions.every((s) => typeof s === "string" && s))) return { ok: false, error: "sessions must be a list of session ids" };
    current(now);
    close("replaced", now);
    w = { id: crypto.randomBytes(8).toString("hex"), openedAt: now, endsAt: now + minutes * MIN, sessions: sessions && [...sessions], approved: 0, tally: {} };
    save();
    return { ok: true, window: current(now) };
  }

  return {
    open,
    close,
    current,
    covers: (item, now) => !!current(now) && coversItem(w, item),
    // one approval, with its HQ risk reason ("deletes files", ...) for the end line
    note: (reason) => {
      if (!w) return;
      w.approved++;
      if (typeof reason === "string" && reason) w.tally[reason] = (w.tally[reason] || 0) + 1;
      save();
    },
    takeEnded: () => {
      const out = ended;
      ended = [];
      return out;
    },
  };
}

// The approvals the end line names, by HQ's risk reason, in this order
const NAMED = [
  ["deletes files", "delete", "deletes"],
  ["changes the live site or database", "live site or database change", "live site or database changes"],
  ["merges code", "merge", "merges"],
];
const and = (parts) => (parts.length < 2 ? parts.join("") : parts.slice(0, -1).join(", ") + " and " + parts.at(-1));

// What HQ says when a window ends: what it approved, the deletes and live changes among them, and what still waits for
// the owner
function windowEndLine(approved, waiting, tally = {}) {
  const named = NAMED.filter(([r]) => tally[r] > 0).map(([r, one, many]) => `${tally[r]} ${tally[r] === 1 ? one : many}`);
  const includes = named.length ? ` That includes ${and(named)}.` : "";
  const left = waiting > 0 ? ` ${waiting} ${waiting === 1 ? "is" : "are"} waiting for you.` : "";
  return `Approve window ended. I approved ${approved}.${includes}${left}`;
}

module.exports = { createWindow, windowEndLine };
