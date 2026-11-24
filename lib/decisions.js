// HQ's side of the decisions folder the bridge writes (bridge/hq-bridge.js): the open requests, the owner's answers and
// their audit log, and the page's presence file. Only the server's token-gated POST routes call answer() and presence().
const fs = require("fs");
const path = require("path");
const { hashOf } = require("../bridge/hq-bridge");

const REQ = /^[0-9a-f]{32}\.json$/;
const ANS = /^([0-9a-f]{32})\.answer\.json$/;
const ID = /^[0-9a-f]{32}$/;
const MAX_FILE = 64 * 1024;
const LEFTOVER_MS = 60e3; // a file that is not an open request (or its answer) is removed once it is this old
const MAX_AGE = 15 * 60e3; // a request older than 15 minutes is not shown, and is removed
const FUTURE_MS = 5e3; // a request asked further ahead than this is a broken clock or a forged file
const SESSION = /^[\w-]{1,64}$/;
const AGENT = /^a[0-9a-f]{16}$/;
const HASH = /^[0-9a-f]{64}$/;
// The prompt the bridge never answers through PermissionRequest (bridge/hq-bridge.js NOT_HERE)
const NOT_HERE = new Set(["AskUserQuestion"]);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
const rm = (fp) => {
  try {
    fs.unlinkSync(fp);
  } catch {}
};
// A file's text when it holds at most 64 KB, else null (it grew past the cap after its stat); a read that fails throws.
// At most 64 KB and one byte is ever read, as lib/hq.js readBeat does.
function readCapped(fp) {
  const buf = Buffer.alloc(MAX_FILE + 1);
  const fd = fs.openSync(fp, "r");
  let n = 0;
  try {
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, n);
      if (!got) break;
      n += got;
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
  return n > MAX_FILE ? null : buf.toString("utf8", 0, n);
}

const strOrNull = (v, max = Infinity) => v === null || (typeof v === "string" && v.length <= max);
// The file's hash is its own call's; a call nested too deep to hash (the bridge's canon recurses) is not a request.
const sealed = (r) => {
  try {
    return r.hash === hashOf(r);
  } catch {
    return false;
  }
};
// A request file's contents when it has the bridge's shape, else null: a permission for any tool the bridge answers
// there (a plan approval too), or 1 to 4 questions, each one or several picks of 2 or more labels, every question and
// label not blank (the bridge's own rules, bar its distinct texts and labels: its cut can make two real ones equal);
// every field of the right type (an agent type only with an agent id, as the bridge writes it; a risky mark on a
// permission only; a notice's mark with when it moved, and neither alone); and a hash that is its own call's. A file
// that fails here is never shown, so no field of the wrong type reaches the payload, and a file rewritten under another
// call's hash is not a request. It never throws.
function requestOf(id, text) {
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || r.v !== 1 || r.id !== id || !Number.isInteger(r.pid) || r.pid <= 0 || !Number.isFinite(r.askedAt)) return null;
  if (typeof r.sessionId !== "string" || !SESSION.test(r.sessionId) || typeof r.transcriptPath !== "string") return null;
  if (!(r.agentId === null || (typeof r.agentId === "string" && AGENT.test(r.agentId))) || !strOrNull(r.agentType, 64) || !strOrNull(r.cwd)) return null;
  if (r.agentId === null && r.agentType !== null) return null;
  if (typeof r.toolName !== "string" || !r.toolName || r.toolName.length > 128 || typeof r.trimmed !== "boolean" || !strOrNull(r.toolUseId)) return null;
  if (!r.toolInput || typeof r.toolInput !== "object" || Array.isArray(r.toolInput)) return null;
  if (typeof r.hash !== "string" || !HASH.test(r.hash) || !sealed(r)) return null;
  // a notice (a prompt HQ held to the cap, now asked in VS Code: HQ shows it and cannot answer it) is marked
  // notice: true with when it moved; a risky mark (the full call rated Risky) is a permission's alone
  if (r.notice !== undefined ? r.notice !== true || !Number.isFinite(r.movedAt) : r.movedAt !== undefined) return null;
  if (r.risky !== undefined && (r.risky !== true || r.event !== "PermissionRequest")) return null;
  // a hook's ask (a safety hook asked for this call, lib/askmark.js) is a permission's alone: a hook of at most 64 and a
  // reason of at most 300 characters
  const h = r.hookAsk;
  if (h !== undefined && !(r.event === "PermissionRequest" && h && typeof h === "object" && typeof h.hook === "string" && h.hook.length <= 64 && typeof h.reason === "string" && h.reason.length <= 300)) return null;
  if (r.event === "PermissionRequest") return NOT_HERE.has(r.toolName) ? null : r;
  if (r.event !== "PreToolUse" || r.toolName !== "AskUserQuestion" || typeof r.toolUseId !== "string") return null;
  const qs = r.toolInput.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) return null;
  const fine = (q) =>
    !!q && typeof q === "object" && typeof q.question === "string" && !!q.question.trim() && (q.multiSelect === undefined || typeof q.multiSelect === "boolean") &&
    Array.isArray(q.options) && q.options.length >= 2 && q.options.every((o) => o && typeof o.label === "string" && o.label.trim());
  return qs.every(fine) ? r : null;
}

// `read` stands in for the file read in tests: a file's text, null when it is over 64 KB, a throw when the read fails.
function createDecisions({ stateDir, alive = pidAlive, maxAge = MAX_AGE, read = readCapped }) {
  const dir = path.join(stateDir, "decisions");
  const log = path.join(stateDir, "answers.log.jsonl");
  const write = (fp, data) => {
    fs.writeFileSync(fp + ".tmp", data);
    fs.renameSync(fp + ".tmp", fp);
  };

  // The open requests, oldest first, with no answer written yet. Sweeps as it goes: a request whose bridge is gone,
  // that is older than maxAge or asked more than 5 s ahead, a notice by when it moved (with its answer); once a minute
  // old, a request file that is not a file, is over 64 KB or was read whole and refused, an answer with no request, and
  // anything else. A read that fails (a scanner holding the file, too many open files) removes nothing: the next scan
  // reads it again. A notice for which `stale(r)` is true (its prompt was answered in VS Code) is removed with any
  // answer file; a request never is. A notice is never answered here, so an answer file beside one is removed and the
  // notice stays listed: a forged answer can never hide a hand.
  function scan(now = Date.now(), { stale } = {}) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const have = new Set(names);
    const open = [];
    for (const name of names) {
      const fp = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      const old = now - st.mtimeMs > LEFTOVER_MS;
      if (!REQ.test(name)) {
        const a = ANS.exec(name);
        if (old && !(a && have.has(a[1] + ".json"))) rm(fp);
        continue;
      }
      const id = name.slice(0, 32);
      let text = null; // null: not a file, or over 64 KB by its stat or by what was read
      if (st.isFile() && st.size <= MAX_FILE) {
        try {
          text = read(fp);
        } catch {
          continue;
        }
      }
      const r = text === null ? null : requestOf(id, text);
      if (!r) {
        if (old) rm(fp);
        continue;
      }
      const since = r.notice === true ? r.movedAt : r.askedAt;
      if (!alive(r.pid) || now - since > maxAge || since - now > FUTURE_MS || (r.notice === true && stale && stale(r))) {
        rm(fp);
        rm(path.join(dir, id + ".answer.json"));
        continue;
      }
      if (r.notice === true) {
        if (have.has(id + ".answer.json")) rm(path.join(dir, id + ".answer.json"));
        open.push(r);
        continue;
      }
      if (!have.has(id + ".answer.json")) open.push(r);
    }
    return open.sort((a, b) => a.askedAt - b.askedAt);
  }

  // The owner's answer for an open request, with the hash of the item the owner saw (the bridge allows only on its own
  // call's hash), and one audit line: time, id, session name, tool, choice, and for Ask for changes the note's length;
  // never the command, a file's contents or the note's text. The line is written first, so no answer the bridge can act
  // on is ever missing from the log (a failed append throws, and no answer is written). False for an id that is not 32
  // hex characters, a choice that is not text, or a request that is gone or already answered. The line has no `source`:
  // that marks it as HQ's own, where the bridge's line for the answer it acts on says "bridge" (the server's alerts).
  // An answer by picks carries them (the server has checked they fit); the log line gets the choice alone. One HQ gave
  // through an approve window or a confirmed read-back says so (`via`: "window" with the window's id, or "readback"),
  // still with no `source`, so the server counts it as HQ's own.
  function answer(id, item, choice, now = Date.now(), note, picks, via, windowId) {
    if (typeof id !== "string" || !ID.test(id) || typeof choice !== "string") return false;
    const ans = path.join(dir, id + ".answer.json");
    if (!fs.existsSync(path.join(dir, id + ".json")) || fs.existsSync(ans)) return false;
    const revise = choice === "revise" && typeof note === "string";
    const how = typeof via === "string" ? { via, ...(via === "window" && typeof windowId === "string" ? { window: windowId } : {}) } : {};
    fs.appendFileSync(log, JSON.stringify({ at: new Date(now).toISOString(), id, session: item.sessionName, tool: item.toolName, choice, ...(revise ? { noteLength: [...note].length } : {}), ...how }) + "\n");
    write(ans, JSON.stringify({ id, sessionId: item.sessionId, toolName: item.toolName, choice, hash: item.hash, ...(revise ? { note } : {}), ...(choice === "picks" ? { picks } : {}), at: now }));
    return true;
  }

  // What the page last reported: focused or not, open or closed (its tab's pagehide), and when. The bridge holds a
  // prompt for HQ only while a page is open; focus decides nothing there.
  function presence(focused, open, now = Date.now()) {
    write(path.join(stateDir, ".hq-presence.json"), JSON.stringify({ focused, open, at: now }));
  }

  return { dir, log, ensure: () => fs.mkdirSync(dir, { recursive: true }), scan, answer, presence };
}

module.exports = { createDecisions, requestOf, pidAlive };
