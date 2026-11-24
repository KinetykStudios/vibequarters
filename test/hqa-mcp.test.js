// bin/hqa-mcp.js: the assistant's only hands, an MCP server on stdio (one JSON-RPC message a line). Each tool is one
// command on HQ's assistant channel, sent with the assistant token from its env and no Origin; what HQ replies is the
// tool's text, and anything but a 200 is an error result.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const MCP = path.join(__dirname, "..", "bin", "hqa-mcp.js");
const TOKEN = "ab".repeat(32);

// A stand-in HQ that records each request and answers with the status and text `reply` gives for its body
function fakeHq(reply) {
  const got = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      got.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(b) });
      const [status, text] = reply(JSON.parse(b));
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(text);
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ got, port: server.address().port, close: () => server.close() })));
}
// The MCP server as Claude Code runs it; rpc(method, params) is the reply to one request, by its id, and fails at once
// when the server exits first
function client(env) {
  const child = spawn(process.execPath, [MCP], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  const waiting = new Map();
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  child.on("exit", (code) => {
    for (const r of waiting.values()) r({ exited: code, err });
    waiting.clear();
  });
  let buf = "", next = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (waiting.has(m.id)) waiting.get(m.id)(m), waiting.delete(m.id);
    }
  });
  const rpc = (method, params) => new Promise((r) => {
    const id = next++;
    waiting.set(id, r);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  return { child, rpc, notify, close: () => child.kill() };
}

// A 15 s wait would give up on drafts the drafter is still allowed 120 s to write
test("a draft waits 130 s and an open 40 s, past the drafter's 120 s and the opener's 30 s; the rest 15 s", () => {
  const { timeoutFor } = require(MCP);
  assert.deepEqual(["draft", "open", "status", "send", "ask"].map(timeoutFor), [130e3, 40e3, 15e3, 15e3, 15e3]);
});

test("initialize, then tools/list names one tool a command, each with an input schema", async () => {
  const c = client({ HQ_PORT: "1", HQ_ASSISTANT_TOKEN: TOKEN });
  try {
    const init = await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.name, "hq");
    c.notify("notifications/initialized");
    const list = await c.rpc("tools/list", {});
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ["hq_ask", "hq_context", "hq_draft", "hq_open", "hq_read", "hq_send", "hq_status", "hq_watch", "hq_window", "hq_window_off"]);
    for (const t of list.result.tools) {
      assert.equal(t.inputSchema.type, "object", t.name);
      assert.equal(typeof t.description, "string", t.name);
    }
    assert.equal((await c.rpc("nope", {})).error.code, -32601, "an unknown method");
  } finally {
    c.close();
  }
});

test("a tool call is one command to HQ with the assistant token and no Origin; HQ's text is the result, and a refusal is an error result", async () => {
  const hq = await fakeHq((b) => (b.cmd === "ask" ? [400, "Risky: the owner approves this one in Needs you"] : [200, "ok: " + b.cmd]));
  const c = client({ HQ_PORT: String(hq.port), HQ_ASSISTANT_TOKEN: TOKEN });
  try {
    await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const calls = [
      ["hq_status", {}, { cmd: "status", args: [] }],
      ["hq_read", { session: "ada" }, { cmd: "read", args: ["ada"] }],
      ["hq_send", { session: "ada", text: "open the PR" }, { cmd: "send", args: ["ada", "open the PR"] }],
      ["hq_window", { minutes: 10, sessions: ["ada", "bo"] }, { cmd: "window", args: ["10", "ada", "bo"] }],
      ["hq_window", { minutes: 5 }, { cmd: "window", args: ["5"] }],
      ["hq_window_off", {}, { cmd: "window", args: ["off"] }],
      ["hq_watch", { session: "ada" }, { cmd: "watch", args: ["ada"] }],
      ["hq_draft", { target: "new", idea: "a pricing page" }, { cmd: "draft", args: ["new", "a pricing page"] }],
      ["hq_open", { prompt: "build it" }, { cmd: "open", args: ["build it"] }],
      ["hq_context", { session: "Docs search", action: "handoff" }, { cmd: "context", args: ["Docs search", "handoff"] }],
    ];
    for (const [name, args, want] of calls) {
      const r = await c.rpc("tools/call", { name, arguments: args });
      assert.deepEqual(r.result, { content: [{ type: "text", text: "ok: " + want.cmd }], isError: false }, name);
      const sent = hq.got.at(-1);
      assert.deepEqual([sent.method, sent.url, sent.body], ["POST", "/api/assistant", want], name);
      assert.equal(sent.headers["x-hq-assistant-token"], TOKEN);
      assert.equal(sent.headers.origin, undefined);
      assert.match(sent.headers["content-type"], /^application\/json/);
    }
    const ask = await c.rpc("tools/call", { name: "hq_ask", arguments: { decision: "a1b2c3d4", choice: "allow" } });
    assert.deepEqual(ask.result, { content: [{ type: "text", text: "Risky: the owner approves this one in Needs you" }], isError: true });
    assert.deepEqual(hq.got.at(-1).body, { cmd: "ask", args: ["a1b2c3d4", "allow"] });
    await c.rpc("tools/call", { name: "hq_ask", arguments: { decision: "a1b2c3d4", choice: "revise", note: "use staging" } });
    assert.deepEqual(hq.got.at(-1).body, { cmd: "ask", args: ["a1b2c3d4", "revise", "use staging"] });
    const n = hq.got.length;
    const bad = await c.rpc("tools/call", { name: "hq_send", arguments: { session: "ada" } });
    assert.equal(bad.result.isError, true, "a missing argument");
    const unknown = await c.rpc("tools/call", { name: "hq_delete", arguments: {} });
    assert.equal(unknown.result.isError, true, "an unknown tool");
    assert.equal(hq.got.length, n, "neither reached HQ");
  } finally {
    c.close();
    hq.close();
  }
});

test("with HQ down, a tool call is an error result, never a crash", async () => {
  const hq = await fakeHq(() => [200, ""]);
  const port = hq.port;
  hq.close();
  const c = client({ HQ_PORT: String(port), HQ_ASSISTANT_TOKEN: TOKEN });
  try {
    await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const r = await c.rpc("tools/call", { name: "hq_status", arguments: {} });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /HQ/);
    assert.equal(c.child.exitCode, null, "still running");
  } finally {
    c.close();
  }
});
