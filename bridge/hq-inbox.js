// HQ's inbox waiter. Claude Code runs it as a Stop hook with asyncRewake each time a chat ends a reply: it waits in the
// background, and when the owner sends that chat a message from HQ's pop-up it prints the message on stderr and exits
// 2, which wakes the chat with it as a new turn (the chat is told it is a background-task event, so it follows an
// instruction sent this way but does not take it as the owner's yes). It waits only in a chat someone is at
// (CLAUDE_CODE_SESSION_ATTENDED is 1; a `claude -p` run has 0, and would wait for this hook before it exits), and only
// while that chat is idle: a user or assistant row dated after the wait began (the owner typed in VS Code, or a
// background task woke the chat) ends it, because a message that lands mid-turn reaches the chat inside a tool result
// and is ignored as an injection. It ends too when a newer waiter for the chat takes over, when a waiter for another
// session starts in the same chat process (/clear), when the chat's process (CLAUDE_PID) is gone, or after 24 hours. It
// acts on a message only once the lookup finds the real HQ on its port and HQ says it wrote exactly that message, as
// the approvals bridge does, asking HQ only if the chat is still idle once the slow lookup is done. The lookup begins
// as the wait does, ahead of any message, and again every 9 minutes, so a send acts at once with only netstat's check
// that HQ is still alone on its port (lookupFor in the bridge); a message it cannot confirm is left for a later try,
// one HQ did not write is removed, and a port that is not HQ's ends the wait.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { canConfirm, primeHq, lookupFor, fitRt, sameHq, alive, readJson, PRIME_TTL } = require("./hq-bridge");
const { plainText, textHash, UUID } = require("../lib/inbox");

const ID = /^[0-9a-f]{32}$/;
const TICK = 1000;
const MAX_LIFE = 24 * 3600e3;
const RETRY_MS = 10e3; // a check that could not tell is tried again this much later, doubling to RETRY_MAX, so a slow lookup is no flood
const RETRY_MAX = 60e3;
const NOT_HQ = "not hq"; // the check's answer when the port file names a server that is not HQ's
const VERIFY_MS = 2000;
const READ_MAX = 1024 * 1024; // the transcript is read from where the wait began, at most this much a tick
const PRIME_MS = 0; // the lookup begins as the wait does, so a send right after a reply acts at once too
const PREFIX = "Message from the user, typed in the VibeQuarters dashboard: ";
// A message the HQ assistant sent (lib/inbox.js put, via "assistant"), so the chat knows the words came through it
const ASSISTANT_PREFIX = PREFIX.replace("typed in the VibeQuarters dashboard", "written by the VibeQuarters assistant from their words");
// The text that wakes the chat: the message behind its prefix
const wakeText = (m) => (m.via === "assistant" ? ASSISTANT_PREFIX : PREFIX) + m.text;

const rm = (fp) => {
  try {
    fs.unlinkSync(fp);
  } catch {}
};

// Whether HQ wrote this message, asked over its port with no Origin (server.js /api/verify): true, false, or null
// when HQ could not say (a refused or slow request, or any other reply).
function wroteSend(port, m) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ kind: "send", id: m.id, sessionId: m.sessionId, hash: textHash(m.text), via: m.via });
    const headers = { Host: "127.0.0.1:" + port, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    const r = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/verify", headers, timeout: VERIFY_MS }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (text.length < 64) text += c;
      });
      res.on("end", () => resolve(res.statusCode !== 200 ? null : text === '{"wrote":true}' ? true : text === '{"wrote":false}' ? false : null));
      res.on("error", () => resolve(null));
    });
    r.on("timeout", () => r.destroy());
    r.on("error", () => resolve(null));
    r.end(body);
  });
}
// A message counts only through the real HQ (the port lookup, then HQ's own yes), and HQ is asked only while ctx.idle()
// still says the chat is idle and the wait this waiter's, as HQ's yes spends the message. A lookup that finds the port
// is not HQ's logs one line HQ alerts on and returns NOT_HQ; a check that could not tell logs one line per message
// (ctx.said holds the ids logged) and returns null; both lines carry no text. HQ's own no logs nothing, as HQ alerts on
// it itself.
async function checkSend(dir, m, ctx = {}) {
  const rt = readJson(path.join(dir, ".runtime.json"));
  const hq = fitRt(rt) && (await lookupFor(rt, dir, ctx.primed)); // the one begun ahead (ctx.primed) when it still holds
  if (hq === true) {
    if (ctx.idle && !ctx.idle()) return null;
    const wrote = await wroteSend(rt.port, m);
    if (wrote !== null) return wrote;
  }
  if (hq !== false && ctx.said) {
    if (ctx.said.has(m.id)) return null;
    ctx.said.add(m.id);
  }
  try {
    fs.appendFileSync(path.join(dir, "answers.log.jsonl"), JSON.stringify({ at: new Date().toISOString(), id: m.id, sessionId: m.sessionId, tool: "VibeQuarters message", choice: "send", source: hq === false ? "unconfirmed" : "unchecked" }) + "\n");
  } catch {}
  return hq === false ? NOT_HQ : null;
}

// The message HQ left for this chat, or undefined: none there, or one that is not whole and HQ's shape (removed); its via
// is none (the owner's pop-up) or "assistant"
function messageOf(fp, sid) {
  let raw;
  try {
    raw = fs.readFileSync(fp, "utf8");
  } catch {
    return undefined;
  }
  let m = null;
  try {
    m = JSON.parse(raw);
  } catch {}
  if (m && m.v === 1 && typeof m.id === "string" && ID.test(m.id) && m.sessionId === sid && plainText(m.text) === m.text && (m.via === undefined || m.via === "assistant")) return m;
  rm(fp);
  return undefined;
}

// Returns the message text that wakes the chat (the whole message with `full`), or null when the wait ends without one.
async function run(raw, { dir, env = process.env, tick = TICK, maxLife = MAX_LIFE, check = checkSend, now = Date.now, primeMs = PRIME_MS, full = false, platform = process.platform } = {}) {
  if (!canConfirm(platform)) return null;
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!d || d.hook_event_name !== "Stop" || typeof d.session_id !== "string" || !UUID.test(d.session_id) || typeof d.transcript_path !== "string") return null;
  if (!dir || env.CLAUDE_CODE_SESSION_ATTENDED !== "1") return null;
  const claudePid = Number(env.CLAUDE_PID);
  if (!Number.isInteger(claudePid) || !alive(claudePid)) return null;
  const rt = readJson(path.join(dir, ".runtime.json"));
  if (!rt || rt.control !== true) return null; // an HQ that cannot send is not waited for
  const sid = d.session_id, fp = d.transcript_path;
  const folder = path.join(dir, "inbox"), waitFp = path.join(folder, sid + ".wait"), msgFp = path.join(folder, sid + ".msg");
  const start = now();
  let pos;
  try {
    pos = fs.statSync(fp).size;
  } catch {
    return null;
  }
  let carry = ""; // a row the last read cut in two
  // a user or assistant row of the chat itself (not a subagent's) dated after the wait began
  const busy = () => {
    let size;
    try {
      size = fs.statSync(fp).size;
    } catch {
      return true; // the transcript is gone: so is the chat as HQ knows it
    }
    if (size < pos) return true; // rewritten in place
    if (size === pos) return false;
    const len = Math.min(size - pos, READ_MAX);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(fp, "r");
    try {
      fs.readSync(fd, buf, 0, len, pos);
    } finally {
      fs.closeSync(fd);
    }
    pos += len;
    const lines = (carry + buf.toString("utf8")).split("\n");
    carry = lines.pop();
    for (const l of lines) {
      let r;
      try {
        r = JSON.parse(l);
      } catch {
        continue;
      }
      if (r && (r.type === "user" || r.type === "assistant") && !r.isSidechain && Date.parse(r.timestamp) > start) return true;
    }
    return false;
  };
  const mine = () => {
    const w = readJson(waitFp);
    return !!w && w.pid === process.pid;
  };
  const leave = () => {
    if (mine()) rm(waitFp);
  };
  try {
    fs.mkdirSync(folder, { recursive: true });
    const tmp = waitFp + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, sessionId: sid, pid: process.pid, claudePid, at: start }));
    fs.renameSync(tmp, waitFp);
  } catch {
    return null;
  }
  // a wait of another session in this same chat process is stale: the process moved on to this session (/clear or a
  // resume keep the process), so that session's waiter ends at its next tick
  try {
    for (const f of fs.readdirSync(folder)) {
      if (!f.endsWith(".wait") || f === sid + ".wait") continue;
      const w = readJson(path.join(folder, f));
      if (w && w.claudePid === claudePid && w.sessionId !== sid) rm(path.join(folder, f));
    }
  } catch {}
  let timer = null, asking = false, retryAt = 0, tries = 0, stood = false;
  let primed = null; // the lookup begun ahead of a send, again whenever the port file names another HQ
  const said = new Set();
  // still idle and still this waiter's, asked again by the check once its lookup is done; once no, the wait ends
  const idle = () => {
    if (!stood && (!mine() || busy())) stood = true;
    return !stood;
  };
  const later = () => (retryAt = now() + Math.min(RETRY_MAX, RETRY_MS * 2 ** tries++));
  try {
    return await new Promise((resolve) => {
      const step = () => {
        if (asking) return;
        try {
          if (!mine()) return resolve(null); // a newer waiter took over: the wait file is its own now
          if (!alive(claudePid) || now() - start >= maxLife || busy()) {
            leave();
            return resolve(null);
          }
          // begun ahead once the chat has sat primeMs, and again a minute before it would expire or when HQ restarts
          if (now() - start >= primeMs && (!primed || Date.now() - primed.at > PRIME_TTL - 60e3 || !sameHq(primed.rt, readJson(path.join(dir, ".runtime.json"))))) primed = primeHq(dir);
          if (now() < retryAt) return;
          const m = messageOf(msgFp, sid);
          if (m === undefined) return;
          asking = true;
          check(dir, m, { idle, said, primed }).then(
            (yes) => {
              asking = false;
              if (stood) {
                leave(); // the chat moved on while the lookup ran: HQ was not asked, the message waits for the next waiter
                return resolve(null);
              }
              if (yes === true) {
                rm(msgFp);
                leave();
                return resolve(full ? m : m.text);
              }
              if (yes === NOT_HQ) {
                rm(msgFp);
                leave();
                return resolve(null);
              }
              if (yes === false) rm(msgFp); // HQ did not write it
              else later();
            },
            () => {
              asking = false;
              later();
            }
          );
        } catch {
          leave();
          resolve(null); // a step that throws ends the wait silently, never the chat
        }
      };
      timer = setInterval(step, tick);
      step();
    });
  } finally {
    clearInterval(timer);
  }
}

if (require.main === module) {
  let dir = null;
  try {
    const i = process.argv.indexOf("--state");
    dir = i > 0 ? path.resolve(process.argv[i + 1]) : require("../lib/instance").loadInstance(null, { appDir: path.join(__dirname, ".."), home: os.homedir() }).stateDir;
  } catch {}
  let raw = "";
  process.stdin.on("error", () => process.exit(0));
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", async () => {
    let m = null;
    try {
      m = await run(raw, { dir, full: true });
    } catch {}
    if (m) process.stderr.write(wakeText(m), () => process.exit(2));
    else process.exit(0);
  });
}

module.exports = { run, checkSend, wroteSend, messageOf, wakeText, PREFIX, ASSISTANT_PREFIX, NOT_HQ };
