#!/usr/bin/env node
// The HQ assistant's hands in HQ: an MCP server on stdio (JSON-RPC 2.0, one message a line) that Claude Code starts for
// the assistant's process (`--mcp-config`). Each tool is one command on HQ's assistant channel
// (server.js POST /api/assistant), sent to 127.0.0.1:HQ_PORT with the token in HQ_ASSISTANT_TOKEN and no Origin. HQ
// decides everything: an answer or a window is only ever a read-back the owner confirms. Zero dependencies.
"use strict";
const http = require("http");

const PORT = Number(process.env.HQ_PORT);
const TOKEN = process.env.HQ_ASSISTANT_TOKEN || "";
// How long a command may take: a draft runs Opus (lib/drafter.js stops it at 120 s), an open runs VS Code's launcher
// (lib/opener.js, 30 s); the rest answer at once
const TIMEOUTS = { draft: 130e3, open: 40e3 };
const timeoutFor = (cmd) => (Object.hasOwn(TIMEOUTS, cmd) ? TIMEOUTS[cmd] : 15e3);
const VERSION = "2025-06-18";

const text = (description) => ({ type: "string", description });
const schema = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
// name -> { description, inputSchema, args(input) -> the command's args, or null when the input does not fit }
const TOOLS = {
  hq_status: { cmd: "status", description: "HQ as the owner sees it: Live by the same titles (status, plan step, context past 75%), the other chats, the decisions waiting on the owner with why each is rated, the approve window, the dashboard's counts and the Office's desks.", inputSchema: schema({}), args: () => [] },
  hq_read: { cmd: "read", description: "One chat in full: folder, what it does now, plan, time, actions, cost, context, subagents, prompt cache, latest steps, its last reply, its Status and Next steps, and its open decisions.", inputSchema: schema({ session: text("the chat's Live title, its session name or id, or a prefix only it starts with") }), args: (i) => [i.session] },
  hq_send: { cmd: "send", description: "Propose a message to a chat in the owner's name. HQ shows the owner the whole text and sends it only on their yes in HQ.", inputSchema: schema({ session: text("the chat's exact Live title, session name or id"), text: text("the message, 1 to 2000 characters") }), args: (i) => [i.session, i.text] },
  hq_ask: {
    cmd: "ask",
    description: "Propose an answer to one open decision. HQ shows and speaks a read-back; nothing is answered until the owner says yes. A Risky approve is always refused: the owner does those.",
    inputSchema: schema({ decision: text("the first characters of the decision's id, as hq_status shows them"), choice: text("allow, deny, revise, or a question's option key"), note: text("for revise: what to change") }, ["decision", "choice"]),
    args: (i) => [i.decision, i.choice, ...(i.note === undefined ? [] : [i.note])],
  },
  hq_window: {
    cmd: "window",
    description: "Propose an approve window: for some minutes, in every chat or the ones named, HQ approves the routine list at once and, only with the AI judge turned on, what the judge finds safe; never a question and never the items on the never-approve list. A read-back the owner confirms.",
    inputSchema: schema({ minutes: { type: "integer", minimum: 1, maximum: 300, description: "1 to 300 (5 hours)" }, sessions: { type: "array", items: { type: "string" }, description: "the chats; leave out for every chat" } }, ["minutes"]),
    args: (i) => (Number.isInteger(i.minutes) && (i.sessions === undefined || (Array.isArray(i.sessions) && i.sessions.every((s) => typeof s === "string"))) ? [String(i.minutes), ...(i.sessions || [])] : null),
  },
  hq_window_off: { cmd: "window", description: "Close the approve window now.", inputSchema: schema({}), args: () => ["off"] },
  hq_watch: { cmd: "watch", description: "Ask HQ to say when a chat's reply ends.", inputSchema: schema({ session: text("the chat") }), args: (i) => [i.session] },
  hq_draft: { cmd: "draft", description: "Draft a better prompt from the owner's idea, for a chat or a new session.", inputSchema: schema({ target: text("the chat, or new"), idea: text("the owner's idea in their words") }), args: (i) => [i.target, i.idea] },
  hq_open: { cmd: "open", description: "Propose a new session with a prompt. HQ shows the owner the prompt and opens the session only on their yes in HQ.", inputSchema: schema({ prompt: text("the prompt") }), args: (i) => [i.prompt] },
  hq_context: {
    cmd: "context",
    description: "Propose HQ's own message to a chat whose context is filling: compact (from 75%: it reaches a clean stop, then the owner types /compact) or handoff (from 90%: it writes a handoff prompt for a fresh session). A read-back the owner confirms, as a send is.",
    inputSchema: schema({ session: text("the chat's exact Live title, session name or id"), action: { type: "string", enum: ["compact", "handoff"], description: "compact or handoff" } }),
    args: (i) => [i.session, i.action],
  },
};

// One command to HQ: { status, text }; status 0 when HQ could not be reached
function command(cmd, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ cmd, args });
    const headers = { Host: "127.0.0.1:" + PORT, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-HQ-Assistant-Token": TOKEN };
    const r = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: "/api/assistant", headers, timeout: timeoutFor(cmd) }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode, text: t }));
      res.on("error", () => resolve({ status: 0, text: "" }));
    });
    r.on("timeout", () => r.destroy());
    r.on("error", () => resolve({ status: 0, text: "" }));
    r.end(body);
  });
}

const result = (t, isError) => ({ content: [{ type: "text", text: t }], isError });
async function call(name, input) {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) return result(`no tool named ${String(name).slice(0, 40)}`, true);
  const i = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const args = tool.args(i);
  const need = tool.inputSchema.required;
  if (!args || need.some((k) => i[k] === undefined) || args.some((a) => typeof a !== "string")) return result(`${name} needs ${need.join(", ") || "no input"}`, true);
  const r = await command(tool.cmd, args);
  if (r.status === 0) return result("HQ did not answer (is it running?)", true);
  return result(r.text, r.status !== 200);
}

async function handle(m) {
  const ok = (res) => ({ jsonrpc: "2.0", id: m.id, result: res });
  if (m.method === "initialize") return ok({ protocolVersion: typeof (m.params && m.params.protocolVersion) === "string" ? m.params.protocolVersion : VERSION, capabilities: { tools: {} }, serverInfo: { name: "hq", version: "1.0.0" } });
  if (m.method === "ping") return ok({});
  if (m.method === "tools/list") return ok({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
  if (m.method === "tools/call") return ok(await call(m.params && m.params.name, m.params && m.params.arguments));
  return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } };
}

if (require.main === module) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    buf += c;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
        continue;
      }
      if (!m || typeof m !== "object" || m.id === undefined || m.id === null) continue; // a notification gets no reply
      handle(m).then((out) => process.stdout.write(JSON.stringify(out) + "\n"), () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "internal error" } }) + "\n"));
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// The tool names, in order, for the assistant's --allowedTools (lib/assistant.js)
module.exports = { TOOL_NAMES: Object.keys(TOOLS), timeoutFor };
