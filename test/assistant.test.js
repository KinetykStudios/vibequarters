// lib/assistant.js: the assistant's Claude process. One conversation a local day, one turn at a time with up to three
// waiting, the owner's tools and hooks with every ask sent to HQ, no API key in its env, a new token each start, and a
// process that stops when idle or crashes and starts again on the owner's next words.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { argsFor, createAssistant, claudePath, TOOLS } = require("../lib/assistant");

const roots = [];
test.after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hq-assistant-"));
  roots.push(d);
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  for (const end = Date.now() + ms; ; ) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

// A fake spawn: each call makes a child whose stdin lines are kept, and which the test drives with out() and crash()
function fakeSpawn() {
  const runs = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 1000 + runs.length;
    const run = { cmd, args, opts, child, lines: [], killed: false };
    let buf = "";
    child.stdin.on("data", (c) => {
      buf += c;
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) run.lines.push(JSON.parse(buf.slice(0, i)));
    });
    child.kill = () => {
      run.killed = true;
      setImmediate(() => child.emit("exit", null, "SIGTERM"));
    };
    run.out = (o) => child.stdout.write(JSON.stringify(o) + "\n");
    run.crash = (line) => {
      child.stderr.write("starting\n" + line + "\n");
      setImmediate(() => child.emit("exit", 1, null));
    };
    runs.push(run);
    return child;
  };
  return { spawn, runs };
}
const text = (t) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } });
const result = (t, total) => ({ type: "result", subtype: "success", result: t, total_cost_usd: total, session_id: "x" });
const DAY1 = Date.parse("2025-02-07T15:00:00.000Z");

function make(over = {}) {
  const stateDir = tmp();
  const home = tmp();
  const f = fakeSpawn();
  let t = DAY1;
  const tokens = [];
  const a = createAssistant({
    spawn: f.spawn, claude: "claude.exe", cwd: path.join(home, ".claude", "hq-assistant"), stateDir, port: 4747,
    hqaPath: "C:/hq/bin/hqa-mcp.js", promptFile: "C:/hq/assistant/prompt.md", node: "node.exe",
    env: { PATH: "x", ANTHROPIC_API_KEY: "sk-" + "ant-secret", CLAUDE_CODE_ENTRYPOINT: "vscode", ClaudeLower: "x", anthropic_api_key: "sk-low", KEEP_ME: "kept" },
    onToken: (tok) => tokens.push(tok), now: () => t, ...over,
  });
  return { a, f, stateDir, home, tokens, setNow: (v) => (t = v) };
}

// The first words after a quiet spell take longer on a process just started than on one already up
test("warm: the owner's mic opening starts the process and sends nothing, and the owner's words then go to that same one", async () => {
  const { a, f, tokens } = make();
  a.warm();
  assert.equal(f.runs.length, 1);
  assert.equal(tokens.length, 1, "HQ has its token before the owner's words");
  assert.equal(a.state().status, "idle", "the panel says Listening");
  a.warm();
  assert.equal(f.runs.length, 1, "already up");
  await sleep(10);
  assert.deepEqual(f.runs[0].lines, [], "nothing is sent, so it costs nothing");
  a.say("hello");
  await until(() => f.runs[0].lines.length === 1);
  assert.equal(f.runs.length, 1, "the same process");
  assert.equal(a.state().status, "working");
});

test("warm: a process nobody talked to stops after the quiet half hour", async () => {
  const { a, f } = make({ idleMs: 20 });
  a.warm();
  await until(() => f.runs[0].killed);
  await until(() => a.state().status === "off");
});

test("warm: a talk after the process started keeps the process from stopping as idle", async () => {
  const { a, f } = make({ idleMs: 30 });
  a.warm();
  a.say("hello");
  await sleep(60);
  assert.equal(f.runs[0].killed, false, "a turn is running");
  assert.equal(a.state().status, "working");
});

test("warm: words still waiting after a crash go with the owner's next words, not when the mic opens", async () => {
  const { a, f } = make();
  a.say("one");
  a.say("two");
  await until(() => f.runs[0].lines.length === 1);
  f.runs[0].crash("boom");
  await until(() => a.state().status === "error");
  a.warm();
  assert.equal(f.runs.length, 1, "nothing starts on the mic alone");
  a.say("three");
  await until(() => f.runs[1] && f.runs[1].lines.length === 1);
  assert.equal(f.runs[1].lines[0].message.content[0].text, "two");
});

// A step that needs permission in Claude Code's default mode comes to the host as a can_use_tool control_request
test("argsFor: the owner's tools, settings and hooks, the default permission mode, and every ask sent to HQ; then --session-id for a first start or --resume", () => {
  const base = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "sonnet", "--effort", "low",
    "--permission-mode", "default", "--permission-prompts", "host", "--permission-prompt-tool", "stdio", "--mcp-config", "C:/s/mcp.json",
    "--allowedTools", TOOLS.map((n) => "mcp__hq__" + n).join(","), "--setting-sources", "user,local",
    "--append-system-prompt-file", "C:/p.md", "--name", "HQ assistant"];
  const args = argsFor({ sessionId: "s", resume: false, promptFile: "C:/p.md", mcpConfig: "C:/s/mcp.json" });
  assert.ok(!args.includes("--tools") && !args.includes("--strict-mcp-config") && !args.includes("dontAsk"), "no tool is taken away");
  const sid = "11111111-2222-4333-8444-555555555555";
  assert.deepEqual(argsFor({ sessionId: sid, resume: false, promptFile: "C:/p.md", mcpConfig: "C:/s/mcp.json" }), [...base, "--session-id", sid]);
  assert.deepEqual(argsFor({ sessionId: sid, resume: true, promptFile: "C:/p.md", mcpConfig: "C:/s/mcp.json" }), [...base, "--resume", sid]);
  assert.deepEqual(TOOLS, ["hq_status", "hq_read", "hq_send", "hq_ask", "hq_window", "hq_window_off", "hq_watch", "hq_draft", "hq_open", "hq_context"], "the MCP server's tools, in its order");
});

const canUse = (id, input, extra = {}) => ({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Bash", input, description: "Delete the junk folder", ...extra } });
test("a step the owner's rules ask about goes to onAsk; the owner's yes lets it run as asked, the owner's no or a drop refuses it, each answered once", async () => {
  const { a, f } = make();
  const asks = [], gone = [];
  a.onAsk((x) => asks.push(x));
  a.onAskGone((id) => gone.push(id));
  a.say("clean up");
  const [run] = f.runs;
  run.out(canUse("r1", { command: "rm -rf junk" }, { decision_reason: "local-guardrails: a recursive delete" }));
  await until(() => asks.length === 1);
  assert.deepEqual(asks[0], { requestId: "r1", tool: "Bash", input: { command: "rm -rf junk" }, description: "Delete the junk folder", reason: "local-guardrails: a recursive delete" });
  assert.equal(a.answer("r1", true), true);
  assert.equal(a.answer("r1", true), false, "answered once");
  await until(() => run.lines.length === 2);
  assert.deepEqual(run.lines[1], { type: "control_response", response: { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { command: "rm -rf junk" } } } });
  run.out(canUse("r2", { command: "rm -rf more" }));
  await until(() => asks.length === 2);
  assert.equal(a.answer("r2", false), true);
  await until(() => run.lines.length === 3);
  assert.deepEqual(run.lines[2], { type: "control_response", response: { subtype: "success", request_id: "r2", response: { behavior: "deny", message: "The owner said no in HQ." } } });
  assert.equal(a.answer("nope", true), false, "an id it never asked is never answered");
  run.out(canUse("r3", { command: "rm -rf last" }));
  await until(() => asks.length === 3);
  run.crash("boom");
  await until(() => gone.length === 1);
  assert.deepEqual(gone, ["r3"], "an ask still open when the process ends is gone, so its card goes");
  assert.equal(a.answer("r3", true), false);
});

// Each message of a turn comes to onStream as it is written
test("onStream gets each message's start, its words as they are written, and its end; a turn's result ends any message left open", async () => {
  const { a, f } = make();
  const got = [];
  a.onStream((x) => got.push(x));
  a.say("hi");
  const [run] = f.runs;
  const ev = (event) => run.out({ type: "stream_event", event });
  ev({ type: "message_start", message: {} });
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "All " } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{" } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "quiet." } });
  run.out({ type: "stream_event", parent_tool_use_id: "toolu_1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a subagent's words" } } });
  ev({ type: "message_stop" });
  ev({ type: "message_start", message: {} });
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } });
  run.out(result("Done.", 0.01));
  await until(() => got.length === 7);
  assert.deepEqual(got, [{ kind: "start" }, { kind: "text", text: "All " }, { kind: "text", text: "quiet." }, { kind: "end" }, { kind: "start" }, { kind: "text", text: "Done." }, { kind: "end" }]);
});

test("a control request HQ does not handle gets an error back at once, so the process never waits on it", async () => {
  const { a, f } = make();
  a.say("hi");
  const [run] = f.runs;
  run.out({ type: "control_request", request_id: "q1", request: { subtype: "something_new" } });
  await until(() => run.lines.length === 2);
  assert.deepEqual(run.lines[1], { type: "control_response", response: { subtype: "error", request_id: "q1", error: "HQ does not handle something_new" } });
});

test("say starts the process with one stream-json user line; a result ends the turn and onReply gets its text and the turn's cost", async () => {
  const { a, f, stateDir, home } = make();
  const replies = [];
  a.onReply((r) => replies.push(r));
  assert.equal(a.state().status, "off");
  assert.deepEqual(a.say("What sessions are running?"), { ok: true, queued: 0 });
  const [run] = f.runs;
  assert.equal(run.cmd, "claude.exe");
  assert.equal(run.opts.cwd, path.join(home, ".claude", "hq-assistant"));
  assert.ok(fs.existsSync(run.opts.cwd), "its folder is made");
  assert.equal(run.opts.windowsHide, true);
  assert.equal(run.opts.shell, undefined, "never a shell");
  assert.deepEqual(run.lines, [{ type: "user", message: { role: "user", content: [{ type: "text", text: "What sessions are running?" }] } }]);
  assert.equal(a.state().status, "working");
  const mcp = JSON.parse(fs.readFileSync(path.join(stateDir, "assistant", "mcp.json"), "utf8"));
  assert.deepEqual(mcp, { mcpServers: { hq: { type: "stdio", command: "node.exe", args: ["C:/hq/bin/hqa-mcp.js"] } } });
  run.out({ type: "system", subtype: "init" });
  run.out(text("Three are working."));
  run.out(result("Three are working.", 0.0053));
  await until(() => replies.length === 1);
  assert.equal(replies[0].text, "Three are working.");
  assert.equal(replies[0].costUsd, 0.0053);
  assert.equal(a.state().status, "idle");
  a.say("And bo?");
  run.out(result("bo is idle.", 0.0123));
  await until(() => replies.length === 2);
  assert.equal(Math.round(replies[1].costUsd * 1e4) / 1e4, 0.007, "the turn's cost is the difference of the process total");
  assert.deepEqual(a.messages().map((m) => [m.role, m.text]), [["owner", "What sessions are running?"], ["assistant", "Three are working."], ["owner", "And bo?"], ["assistant", "bo is idle."]]);
  assert.equal(f.runs.length, 1, "one process for both turns");
  a.stop();
});

test("say while working queues; with three waiting the next is refused; each waits its turn", async () => {
  const { a, f } = make();
  a.say("one");
  assert.deepEqual([a.say("two"), a.say("three"), a.say("four")].map((r) => r.queued), [1, 2, 3]);
  assert.deepEqual(a.say("five"), { ok: false, error: "three messages are already waiting" });
  const [run] = f.runs;
  assert.equal(run.lines.length, 1, "one turn at a time");
  run.out(result("first", 0.01));
  await until(() => run.lines.length === 2);
  assert.equal(run.lines[1].message.content[0].text, "two");
  a.stop();
});

// Words added while a turn runs must not become a second prompt with its own reply
test("voice: words the owner adds while a turn on the last words runs end that turn, and one turn answers both, the first words first", async () => {
  const { a, f } = make();
  a.say("open the docs page");
  assert.deepEqual(a.say("and read me the first part", { reconsider: true }), { ok: true, queued: 0 });
  assert.equal(f.runs[0].killed, true, "the turn on the half sentence ends");
  await until(() => f.runs.length === 2);
  assert.equal(f.runs[1].args.at(-2), "--resume", "the day's conversation goes on");
  assert.deepEqual(f.runs[1].lines.map((l) => l.message.content[0].text), ["open the docs page\n\nand read me the first part"]);
  assert.deepEqual(a.messages().map((m) => [m.role, m.text]), [["owner", "open the docs page"], ["owner", "and read me the first part"]], "the words as they were said, and no stop note");
  assert.equal(a.state().status, "working");
  f.runs[1].out(result("Opened a 10 minute window.", 0.01));
  await until(() => a.state().status === "idle");
  a.say("and the tests?", { reconsider: true });
  assert.equal(f.runs[1].killed, false, "with no turn running it is a new turn");
  assert.equal(f.runs[1].lines.at(-1).message.content[0].text, "and the tests?");
  a.stop();
});

test("a crash reports error with the last stderr line, keeps the waiting messages, and the next say starts it again with --resume", async () => {
  const { a, f } = make();
  a.say("one");
  a.say("two");
  f.runs[0].crash("Error: signed out");
  await until(() => a.state().status === "error");
  assert.equal(a.state().error, "Error: signed out");
  assert.equal(f.runs.length, 1, "no restart by itself");
  a.say("three");
  assert.equal(f.runs.length, 2);
  assert.equal(f.runs[1].args.at(-2), "--resume");
  assert.equal(f.runs[1].args.at(-1), f.runs[0].args.at(-1), "the same conversation");
  assert.equal(f.runs[1].lines[0].message.content[0].text, "two", "the waiting message goes first");
  assert.equal(a.state().status, "working");
  a.stop();
});

// Three waiting when it crashes must not refuse every later say, nor the turn in flight vanish
test("after a crash with three waiting, the next say restarts it and is taken; the dropped turn gets a note", async () => {
  const { a, f } = make();
  for (const t of ["one", "two", "three", "four"]) a.say(t);
  f.runs[0].crash("boom");
  await until(() => a.state().status === "error");
  const note = a.messages().at(-1);
  assert.deepEqual([note.role, note.text], ["system", "Claude stopped before it answered \"one\": boom"]);
  assert.deepEqual(a.say("five"), { ok: true, queued: 3 });
  assert.equal(f.runs.length, 2, "started again");
  assert.equal(f.runs[1].lines[0].message.content[0].text, "two", "the waiting ones go first");
  a.stop();
});

// A turn that never ends must not keep it busy until a restart
test("a turn past turnMs is stopped as an error with a note, and the next say starts it again with the waiting ones first; a turn that ends in time is left alone", async () => {
  const { a, f } = make({ turnMs: 150 });
  a.say("one");
  a.say("two");
  await until(() => f.runs[0].killed, 1000);
  await until(() => a.state().status === "error");
  assert.equal(a.state().error, "the turn ran too long, so VibeQuarters stopped it");
  assert.equal(a.messages().at(-1).text, 'Claude stopped before it answered "one": the turn ran too long, so VibeQuarters stopped it');
  a.say("three");
  assert.equal(f.runs.length, 2);
  assert.equal(f.runs[1].lines[0].message.content[0].text, "two", "the waiting one goes first");
  f.runs[1].out(result("done", 0.01));
  await until(() => f.runs[1].lines.length === 2);
  f.runs[1].out(result("done too", 0.02));
  await until(() => a.state().status === "idle");
  await sleep(300);
  assert.equal(f.runs[1].killed, false, "a finished turn's limit is cleared");
  a.stop();
});

// A turn that is going wrong can be stopped
test("halt drops the waiting words and stops a running turn (off, with a note); with no turn running it only drops the waiting ones", async () => {
  const { a, f } = make();
  a.say("one");
  a.say("two");
  assert.deepEqual(a.halt(), { ok: true, stopped: true });
  await until(() => a.state().status === "off");
  assert.equal(f.runs[0].killed, true);
  assert.deepEqual(a.messages().map((m) => [m.role, m.text]).slice(-1), [["system", 'You stopped it before it answered "one".']]);
  a.say("three");
  assert.equal(f.runs[1].lines[0].message.content[0].text, "three", "the dropped one never runs");
  f.runs[1].out(result("ok", 0.01));
  await until(() => a.state().status === "idle");
  assert.deepEqual(a.halt(), { ok: true, stopped: false });
  assert.equal(f.runs[1].killed, false, "an idle process stays");
  a.stop();
});

// A Stop that landed after the turn timer fired left its flag set, so a later crash was called "ran too long"
test("a Stop right after the turn limit fired leaves no mark, so a later crash is told by its own reason", async () => {
  const { a, f } = make({ turnMs: 100 });
  a.say("one");
  const run = f.runs[0];
  run.child.kill = () => { run.killed = true; }; // exits only when the test says so
  await until(() => run.killed, 1000);
  assert.deepEqual(a.halt(), { ok: true, stopped: true });
  run.child.emit("exit", null, "SIGTERM");
  await until(() => a.state().status === "off");
  a.say("two");
  f.runs[1].crash("boom");
  await until(() => a.state().status === "error");
  assert.equal(a.state().error, "boom");
  a.stop();
});

test("idle for idleMs: the process is stopped (off, not an error), and the next say resumes the day's conversation", async () => {
  const { a, f } = make({ idleMs: 40 });
  a.say("one");
  f.runs[0].out(result("ok", 0.01));
  await until(() => f.runs[0].killed, 1000);
  await until(() => a.state().status === "off");
  assert.equal(a.state().error, undefined);
  a.say("two");
  assert.equal(f.runs.length, 2);
  assert.deepEqual(f.runs[1].args.slice(-2), ["--resume", f.runs[0].args.at(-1)]);
  a.stop();
});

test("one conversation a local day: a new date gets a new session id, kept in sessions.json", async () => {
  const { a, f, stateDir, setNow } = make();
  a.say("one");
  const first = f.runs[0].args.at(-1);
  assert.equal(f.runs[0].args.at(-2), "--session-id");
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  a.stop();
  await until(() => a.state().status === "off");
  setNow(DAY1 + 86400e3);
  a.say("next day");
  assert.equal(f.runs[1].args.at(-2), "--session-id");
  assert.notEqual(f.runs[1].args.at(-1), first);
  const days = JSON.parse(fs.readFileSync(path.join(stateDir, "assistant", "sessions.json"), "utf8"));
  assert.equal(Object.keys(days).length, 2);
  assert.ok(Object.values(days).includes(first));
  a.stop();
});

// claude --resume finds a conversation only in the folder it started in, so a day's conversation is kept per folder
test("a day's conversation started in another folder is not resumed here: this folder starts its own", async () => {
  const { a, f, stateDir } = make();
  fs.mkdirSync(path.join(stateDir, "assistant"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "assistant", "sessions.json"), JSON.stringify({ "2025-02-07": "11111111-2222-4333-8444-555555555555" }));
  a.say("one");
  assert.equal(f.runs[0].args.at(-2), "--session-id", "a new conversation, not a resume that would fail");
  const mine = f.runs[0].args.at(-1);
  assert.notEqual(mine, "11111111-2222-4333-8444-555555555555");
  assert.deepEqual(a.sessionIds().sort(), ["11111111-2222-4333-8444-555555555555", mine].sort(), "both are still known as its chats");
  a.stop();
  await until(() => a.state().status === "off");
  a.say("two");
  assert.deepEqual(f.runs[1].args.slice(-2), ["--resume", mine], "this folder's own conversation goes on");
  a.stop();
});

test("sessionIds: every day's conversation in sessions.json, so HQ knows the assistant's chats before it starts again", async () => {
  const { a, f, stateDir, setNow } = make();
  assert.deepEqual(a.sessionIds(), []);
  a.say("one");
  const first = f.runs[0].args.at(-1);
  a.stop();
  await until(() => a.state().status === "off");
  setNow(DAY1 + 86400e3);
  a.say("two");
  assert.deepEqual(a.sessionIds().sort(), [first, f.runs[1].args.at(-1)].sort());
  a.stop();
  const again = createAssistant({ spawn: f.spawn, cwd: path.join(stateDir, "cwd"), stateDir, port: 1, hqaPath: "x", promptFile: "y" });
  assert.equal(again.sessionIds().length, 2, "read from the file, before any start");
});

test("its env has no API key and no CLAUDE variable, and carries HQ's port, its session and a new token each start", async () => {
  const { a, f, tokens } = make();
  a.say("one");
  const env = f.runs[0].opts.env;
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.ClaudeLower, undefined, "matched in any case: Windows reads env names without case");
  assert.equal(env.anthropic_api_key, undefined);
  assert.equal(env.KEEP_ME, "kept");
  assert.equal(env.PATH, "x");
  assert.equal(env.HQ_PORT, "4747");
  assert.equal(env.HQ_ASSISTANT_SESSION, f.runs[0].args.at(-1));
  assert.match(env.HQ_ASSISTANT_TOKEN, /^[0-9a-f]{64}$/);
  assert.deepEqual(tokens, [env.HQ_ASSISTANT_TOKEN], "HQ is told the token");
  f.runs[0].crash("boom");
  await until(() => a.state().status === "error");
  a.say("two");
  assert.notEqual(f.runs[1].opts.env.HQ_ASSISTANT_TOKEN, env.HQ_ASSISTANT_TOKEN, "a new token each start");
  assert.equal(tokens.length, 2);
  a.stop();
});

test("note adds a sent prompt or a system line to the conversation; the last 30 messages are kept", () => {
  const { a } = make();
  a.note({ role: "sent", name: "ada", text: "Run the tests" });
  assert.deepEqual(a.messages().map((m) => [m.role, m.name, m.text]), [["sent", "ada", "Run the tests"]]);
  for (let i = 0; i < 40; i++) a.note({ role: "system", text: "line " + i });
  assert.equal(a.messages().length, 30);
  assert.equal(a.messages().at(-1).text, "line 39");
  assert.ok(a.messages().every((m) => typeof m.id === "string" && typeof m.at === "number"));
});

test("claudePath: the npm install's claude.exe when it is there (a .cmd shim needs a shell), else claude", () => {
  const exe = path.join("C:/npm", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  assert.equal(claudePath({ APPDATA: "C:/npm" }, (p) => p === exe, "win32"), exe);
  assert.equal(claudePath({ APPDATA: "C:/npm" }, () => false, "win32"), "claude");
  assert.equal(claudePath({}, () => true, "darwin"), "claude");
});
