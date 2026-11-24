// HQ's side of the inbox (bridge/hq-inbox.js): which chats a waiter listens for, and the one message HQ hands a waiter.
// A waiter, started by Claude Code when a live chat ends a reply, writes inbox/<session>.wait; HQ writes
// inbox/<session>.msg only for a chat a live waiter listens for, and the waiter acts on it only once the running HQ says
// it wrote exactly that message. Only the server's token-gated /api/send route hands a message over.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WAIT = /^(.+)\.wait$/;
const MSG = /\.msg(\.tmp)?$/;
const TEXT_MAX = 2000; // the pop-up's box (public/prompt.js PROMPT_MAX)

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
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
function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

// The owner's message as HQ sends it: line breaks as \n, every other control character gone, no blank space around it,
// 1 to 2000 characters (code points); null for anything else, a lone surrogate included.
function plainText(t) {
  if (typeof t !== "string" || !t.isWellFormed()) return null;
  const s = t.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").trim();
  const n = [...s].length;
  return n >= 1 && n <= TEXT_MAX ? s : null;
}
// What the waiter sends HQ to ask whether HQ wrote a message, and what HQ compares: the text by its hash, so the
// question stays small.
const textHash = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

function createInbox({ stateDir, alive = pidAlive }) {
  const dir = path.join(stateDir, "inbox");
  const msgFp = (sid) => path.join(dir, sid + ".msg");
  // The chats a live waiter listens for: a wait file named for the chat whose waiter and chat processes both run. One
  // whose processes are gone is removed (its waiter went with its chat); a file that does not parse is left alone.
  function listening() {
    const out = new Set();
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return out;
    }
    for (const n of names) {
      const m = WAIT.exec(n);
      if (!m || !UUID.test(m[1])) continue;
      const w = readJson(path.join(dir, n));
      if (!w) continue;
      if (w.sessionId === m[1] && alive(w.pid) && alive(w.claudePid)) out.add(m[1]);
      else rm(path.join(dir, n));
    }
    return out;
  }
  // Hands the waiter for the chat sid the message, written whole so a waiter never reads half of it; via "assistant"
  // marks one the assistant sent, so the waiter wakes the chat saying so
  function put(sid, { id, text, at, via }) {
    fs.mkdirSync(dir, { recursive: true });
    const fp = msgFp(sid);
    fs.writeFileSync(fp + ".tmp", JSON.stringify({ v: 1, id, sessionId: sid, text, at, ...(via ? { via } : {}) }));
    fs.renameSync(fp + ".tmp", fp);
  }
  const waiting = (sid) => fs.existsSync(msgFp(sid)); // the message is still there for a waiter to take
  const take = (sid) => rm(msgFp(sid)); // HQ takes a message back: cancelled, expired
  // At start: every message a past run of HQ left is removed, since no waiter could have it confirmed now
  function clear() {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {}
    for (const n of names) if (MSG.test(n)) rm(path.join(dir, n));
  }
  return { dir, listening, put, waiting, take, clear };
}

module.exports = { createInbox, plainText, textHash, TEXT_MAX, UUID };
