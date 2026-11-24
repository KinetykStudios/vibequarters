// The HQ assistant's Claude process: Claude Code in stream-json mode on the owner's own Claude login, and an env with
// no API key. It has the owner's tools, MCP servers plus HQ's (bin/hqa-mcp.js), settings, CLAUDE.md and hooks, in
// Claude Code's default permission mode: every step that mode or a hook would ask about comes to HQ as a can_use_tool
// control request (onAsk), and only the owner's yes in HQ (answer) lets it run. One conversation a local day (resumed
// after a restart), one turn at a time with up to three waiting. It stops after a quiet half hour or a crash, and the
// owner's next words start it again. Each start makes a new assistant token, which HQ is told through onToken.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");
const { TOOL_NAMES: TOOLS } = require("../bin/hqa-mcp");

const WAITING_MAX = 3;
const KEEP = 30; // messages kept for the panel
// a parent session's state and any API key stay out of the child, in any case: Windows reads env names without case
const NO_KEY = /^(CLAUDE|ANTHROPIC)/i;

// The flags (default permission mode with the owner's settings, asks over stdio), then the day's conversation:
// --session-id for its first start, --resume after. HQ's own tools never ask.
function argsFor({ sessionId, resume, promptFile, mcpConfig }) {
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "sonnet", "--effort", "low",
    "--permission-mode", "default", "--permission-prompts", "host", "--permission-prompt-tool", "stdio", "--mcp-config", mcpConfig,
    "--allowedTools", TOOLS.map((n) => "mcp__hq__" + n).join(","), "--setting-sources", "user,local",
    "--append-system-prompt-file", promptFile, "--name", "HQ assistant",
    resume ? "--resume" : "--session-id", sessionId,
  ];
}

// The Claude CLI to run: on Windows the npm install's claude.exe, since its claude.cmd shim needs a shell; else claude
function claudePath(env = process.env, exists = fs.existsSync, platform = process.platform) {
  if (platform === "win32" && env.APPDATA) {
    const exe = path.join(env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (exists(exe)) return exe;
  }
  return "claude";
}

const dayOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const lastLine = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || "";

// A turn still running after turnMs is stopped as a crash: a hung process would otherwise hold every later word
const OVERRAN = "the turn ran too long, so VibeQuarters stopped it";

// turnMs: real work (a build, a test run) takes longer than a question, so a turn has 30 minutes before HQ stops it
function createAssistant({ spawn = childProcess.spawn, claude = "claude", cwd, env = process.env, hqaPath, promptFile, stateDir, port, node = process.execPath, idleMs = 1800e3, turnMs = 1800e3, now = Date.now, onToken = () => {} }) {
  const dir = path.join(stateDir, "assistant");
  const daysFile = path.join(dir, "sessions.json");
  let child = null;
  let status = "off";
  let error;
  let sessionId = null;
  let lastAt = null;
  let busy = false; // a turn is running
  let inFlight = null; // the owner's words that turn answers
  let stopping = false; // the exit that follows is ours (idle or stop), not a crash
  let reconsidering = false; // that exit ends a turn the owner added words to: the next turn, both together, starts after it
  let lastTotal = 0; // the process's total_cost_usd so far: a turn's cost is the difference
  let idleTimer = null;
  let turnTimer = null;
  let overran = false; // the exit that follows is the turn limit's
  const queue = []; // the owner's words waiting for their turn
  const msgs = [];
  const replyFns = [];
  const askFns = [], goneFns = [], streamFns = [];
  let open = false; // a message is being written (onStream has had its start and not its end)
  // A streamed event (--include-partial-messages): a message starts, its text comes in pieces, it stops
  function stream(e) {
    if (e.type === "message_start") {
      open = true;
      call(streamFns, { kind: "start" });
    } else if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta" && open) call(streamFns, { kind: "text", text: e.delta.text });
    else if (e.type === "message_stop" && open) {
      open = false;
      call(streamFns, { kind: "end" });
    }
  }
  const asks = new Map(); // request id -> { ch, input }: the steps waiting for the owner's yes in HQ
  const call = (fns, v) => { for (const fn of fns) try { fn(v); } catch {} };
  const reply = (ch, response) => { try { ch.stdin.write(JSON.stringify({ type: "control_response", response }) + "\n"); } catch {} };
  // A control request from the process: a step that needs the owner's yes goes to HQ (onAsk); any other kind gets an
  // error back at once, so the process never waits on HQ for it
  function control(ch, o) {
    const r = o.request || {};
    if (r.subtype !== "can_use_tool") return reply(ch, { subtype: "error", request_id: o.request_id, error: `HQ does not handle ${r.subtype}` });
    asks.set(o.request_id, { ch, input: r.input });
    call(askFns, { requestId: o.request_id, tool: r.tool_name, input: r.input, description: r.description, reason: r.decision_reason });
  }
  // The asks still open when their process ends are gone: HQ drops their cards
  function dropAsks(ch) {
    for (const [id, x] of asks) if (x.ch === ch) {
      asks.delete(id);
      call(goneFns, id);
    }
  }

  function add(m) {
    msgs.push({ id: crypto.randomBytes(8).toString("hex"), at: now(), ...m });
    if (msgs.length > KEEP) msgs.splice(0, msgs.length - KEEP);
  }
  function readDays() {
    try {
      const d = JSON.parse(fs.readFileSync(daysFile, "utf8"));
      return d && typeof d === "object" && !Array.isArray(d) ? d : {};
    } catch {
      return {};
    }
  }
  // The day's conversation in this folder: its id, and whether it has started before (then it is resumed). Kept per
  // folder, as claude --resume finds a conversation only in the folder it started in
  function conversation(t) {
    const days = readDays();
    const day = `${dayOf(t)} ${cwd}`;
    if (typeof days[day] === "string") return { id: days[day], resume: true };
    const id = crypto.randomUUID();
    days[day] = id;
    fs.writeFileSync(daysFile, JSON.stringify(days));
    return { id, resume: false };
  }
  function start() {
    let errText = "";
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      const mcpConfig = path.join(dir, "mcp.json");
      fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { hq: { type: "stdio", command: node, args: [hqaPath] } } }));
      const c = conversation(now());
      const token = crypto.randomBytes(32).toString("hex");
      const childEnv = {};
      for (const [k, v] of Object.entries(env)) if (!NO_KEY.test(k)) childEnv[k] = v;
      Object.assign(childEnv, { HQ_PORT: String(port), HQ_ASSISTANT_SESSION: c.id, HQ_ASSISTANT_TOKEN: token });
      onToken(token, c.id);
      const ch = spawn(claude, argsFor({ sessionId: c.id, resume: c.resume, promptFile, mcpConfig }), { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      child = ch;
      sessionId = c.id;
      lastTotal = 0;
      error = undefined;
      status = "starting";
      let buf = "";
      ch.stdout.setEncoding("utf8");
      ch.stdout.on("data", (s) => {
        buf += s;
        for (let i; (i = buf.indexOf("\n")) >= 0; ) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let o;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          if (o && o.type === "stream_event" && o.event && child === ch) { if (!o.parent_tool_use_id) stream(o.event); } // a subagent's words are not its reply
          else if (o && o.type === "result" && child === ch) finish(o);
          else if (o && o.type === "control_request" && child === ch) control(ch, o);
        }
      });
      ch.stderr.setEncoding("utf8");
      ch.stderr.on("data", (s) => {
        errText = (errText + s).slice(-4000);
      });
      ch.on("error", () => ended(ch, "could not start Claude"));
      ch.on("exit", (code) => ended(ch, lastLine(errText) || `Claude stopped (exit ${code})`));
      ch.stdin.on("error", () => {}); // a process that died mid-write is reported by its exit
    } catch {
      child = null;
      status = "error";
      error = "could not start Claude";
    }
  }
  // The process ended: by our stop (off) or on its own (error, the turn in flight dropped, the waiting ones kept)
  function ended(ch, why) {
    dropAsks(ch);
    if (child !== ch) return;
    open = false; // a message cut off by the exit is not said
    child = null;
    busy = false;
    clearTimeout(idleTimer);
    clearTimeout(turnTimer);
    const ranOver = overran;
    overran = false; // this turn's mark only: a Stop that lands after the limit fired must not label a later crash
    if (stopping) {
      stopping = false;
      inFlight = null;
      status = "off";
      error = undefined;
      if (reconsidering) {
        reconsidering = false;
        pump();
      }
      return;
    }
    status = "error";
    error = (ranOver ? OVERRAN : why).slice(0, 200);
    if (inFlight !== null) add({ role: "system", text: `Claude stopped before it answered "${inFlight.length > 80 ? inFlight.slice(0, 80) + "..." : inFlight}": ${error}` });
    inFlight = null;
  }
  function finish(o) {
    if (open) {
      open = false;
      call(streamFns, { kind: "end" });
    }
    const text = typeof o.result === "string" ? o.result.trim() : "";
    const total = Number(o.total_cost_usd);
    const costUsd = Number.isFinite(total) ? Math.max(0, total - lastTotal) : 0;
    if (Number.isFinite(total)) lastTotal = total;
    busy = false;
    inFlight = null;
    clearTimeout(turnTimer);
    status = "idle";
    lastAt = now();
    if (text) add({ role: "assistant", text });
    const id = msgs.length ? msgs[msgs.length - 1].id : null;
    for (const fn of replyFns) {
      try {
        fn({ id, text, costUsd });
      } catch {}
    }
    armIdle();
    pump();
  }
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (child && !busy) {
        stopping = true;
        child.kill();
      }
    }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }
  function pump() {
    if (busy || !queue.length) return;
    if (!child) start();
    if (!child) return;
    const text = queue.shift();
    inFlight = text;
    busy = true;
    status = "working";
    clearTimeout(idleTimer);
    const ch = child;
    turnTimer = setTimeout(() => {
      if (child === ch && busy) {
        overran = true;
        ch.kill();
      }
    }, turnMs);
    if (turnTimer.unref) turnTimer.unref();
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
  }

  return {
    // reconsider (the open mic's words): while the turn on the owner's last words still runs, it ends, and one turn
    // answers both, the first words first, in the same conversation
    say(text, { reconsider = false } = {}) {
      if (!child) pump(); // after a crash the waiting ones go first, so a full queue is not a lockout
      if (queue.length >= WAITING_MAX) return { ok: false, error: "three messages are already waiting" };
      add({ role: "owner", text });
      if (reconsider && busy && inFlight !== null && child) {
        queue.unshift(inFlight + "\n\n" + text);
        inFlight = null; // words that come before it has ended wait for the next turn, never merge twice
        clearTimeout(turnTimer);
        reconsidering = stopping = true;
        child.kill();
        return { ok: true, queued: 0 };
      }
      queue.push(text);
      pump();
      return { ok: true, queued: queue.length };
    },
    // the mic opened, so words are coming: the process is up before they are, so the first reply comes sooner. Nothing is
    // sent, so it costs nothing, and the quiet half hour stops it as usual
    warm() {
      if (child || queue.length) return;
      start();
      if (!child) return;
      status = "idle";
      armIdle();
    },
    // a prompt the assistant sent into a chat (role "sent", with the chat's name) or a line from HQ (role "system")
    note: (m) => add(m),
    onReply: (fn) => replyFns.push(fn),
    onStream: (fn) => streamFns.push(fn),
    onAsk: (fn) => askFns.push(fn),
    onAskGone: (fn) => goneFns.push(fn),
    // the owner's answer to a step waiting in HQ: yes runs it as asked, no refuses it; false when nothing waits under
    // that id
    answer(requestId, allow) {
      const x = asks.get(requestId);
      if (!x) return false;
      asks.delete(requestId);
      reply(x.ch, { subtype: "success", request_id: requestId, response: allow ? { behavior: "allow", updatedInput: x.input } : { behavior: "deny", message: "The owner said no in HQ." } });
      return true;
    },
    state: () => ({ status, ...(error ? { error } : {}), sessionId, lastAt }),
    messages: () => msgs.slice(),
    // every day's conversation id, so HQ marks the assistant's own chats even before this start
    sessionIds: () => Object.values(readDays()).filter((v) => typeof v === "string"),
    stop() {
      clearTimeout(idleTimer);
      if (child) {
        stopping = true;
        child.kill();
      }
    },
    // the panel's Stop: the waiting words are dropped and a running turn is ended (off, so the next words start it again)
    halt() {
      queue.length = 0;
      if (!child || !busy) return { ok: true, stopped: false };
      const was = inFlight;
      add({ role: "system", text: `You stopped it before it answered "${was.length > 80 ? was.slice(0, 80) + "..." : was}".` });
      clearTimeout(turnTimer);
      stopping = true;
      child.kill();
      return { ok: true, stopped: true };
    },
  };
}

module.exports = { argsFor, createAssistant, claudePath, TOOLS };
