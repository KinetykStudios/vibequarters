// lib/assistant-cmds.js: what the assistant's command channel answers. It finds a chat by its exact id, its exact name or
// a prefix only one name starts with (never a guess), never finds the assistant's own chat, keeps what it reads back
// short, and turns an answer or a window into a read-back the owner confirms, never into an answer.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveSession, statusText, readText, runCommand } = require("../lib/assistant-cmds");

const NOW = Date.parse("2025-02-07T15:00:00.000Z");
const sid = (n) => "5e550000-0000-4000-8000-" + String(n).padStart(12, "0");
const session = (n, name, extra = {}) => ({ id: sid(n), name, status: "idle", task: null, action: null, ...extra });
const PERM = (level, extra = {}) => ({
  id: "a1b2c3d4" + "e".repeat(24), kind: "permission", sessionId: sid(1), sessionName: "ada", who: "ada", what: "wants to run npm test", toolName: "Bash", hash: "h".repeat(64),
  risk: { level, label: { low: "Safe", medium: "Check first", high: "Risky" }[level] },
  choices: [{ key: "allow", label: "Approve" }, { key: "deny", label: "Deny" }, { key: "revise", label: "Ask for changes" }], ...extra,
});
const CLOSED = { open: false, endsAt: null, sessions: null, approved: 0 };
const WAIT = "Read-back shown to the owner; waiting for the owner's yes.";
const payload = (o = {}) => ({ sessions: [session(1, "ada", { status: "working", task: "ship the panel" })], decisions: [], window: CLOSED, deploys: null, ...o });
// A ctx that records what the commands ask of HQ
function ctxOf(p, over = {}) {
  const calls = [];
  return {
    calls,
    now: () => NOW,
    payload: () => p,
    chat: () => null,
    canSend: () => null,
    propose: (x) => (calls.push(["propose", x]), { ok: true, id: "0123456789abcdef", text: "the read-back" }),
    windowOff: () => calls.push(["windowOff"]),
    watch: (id) => (calls.push(["watch", id]), true),
    ...over,
  };
}

test("resolveSession refuses an ambiguous prefix and lists both candidates", () => {
  const r = resolveSession([session(1, "app-12"), session(2, "app-13")], "app-1");
  assert.equal(r.ok, false);
  assert.deepEqual(r.candidates.sort(), ["app-12", "app-13"]);
  assert.match(r.error, /app-13/);
});

test("resolveSession: an exact id or an exact name (any case) wins over a prefix; a unique prefix finds its chat; nothing fuzzy", () => {
  const list = [session(1, "ada"), session(2, "ada-two"), session(3, "App-14")];
  assert.equal(resolveSession(list, "ada").session.id, sid(1), "exact name over the prefix ada-two also has");
  assert.equal(resolveSession(list, "ADA").session.id, sid(1));
  assert.equal(resolveSession(list, sid(2)).session.name, "ada-two");
  assert.equal(resolveSession(list, "app-1").session.id, sid(3), "a unique prefix, any case");
  assert.equal(resolveSession(list, "aad").ok, false, "no fuzzy match");
  assert.equal(resolveSession(list, "").ok, false);
  assert.equal(resolveSession(list, undefined).ok, false);
});

// Two chats can share one exact name
test("an exact name two chats share is refused with both ids, and either id still finds its chat", () => {
  const list = [session(1, "ada"), session(2, "Ada")];
  const r = resolveSession(list, "ada");
  assert.equal(r.ok, false);
  assert.deepEqual(r.candidates, [sid(1), sid(2)]);
  assert.equal(r.error, `two or more chats are named "ada": name one by its id, ${sid(1)} or ${sid(2)}`);
  assert.equal(resolveSession(list, sid(2)).session.name, "Ada");
});

test("an assistant session never resolves, by id, name or prefix", () => {
  const list = [session(1, "ada"), session(9, "hq-assistant", { assistant: true })];
  for (const q of [sid(9), "hq-assistant", "hq-a"]) {
    const r = resolveSession(list, q);
    assert.equal(r.ok, false, q);
    assert.deepEqual(r.candidates, [], q);
  }
});

test("statusText stays under 6000 characters with 40 sessions and still shows the decisions and the window", () => {
  const sessions = Array.from({ length: 40 }, (_, i) => session(i + 1, "app-session-" + i, { status: i % 2 ? "working" : "idle", task: "a long task line that goes on about the work at hand ".repeat(2) }));
  const decisions = Array.from({ length: 12 }, (_, i) => PERM("medium", { id: String(i).padStart(2, "0") + "c0ffee" + "0".repeat(24), what: "wants to run a long command ".repeat(4) }));
  const t = statusText(payload({ sessions, decisions, window: { open: true, endsAt: NOW + 7 * 60e3, sessions: null, approved: 2 } }), NOW);
  assert.ok(t.length <= 6000, String(t.length));
  assert.match(t, /^app-session-0: idle, a long task/m);
  assert.match(t, /^00c0ffee app-session-|^00c0ffee ada: /m, "a decision line by the first 8 of its id");
  assert.match(t, /Approve window: open/);
});

test("statusText: one line a session, each open decision with its label, the window, today's deploys; never the assistant's chat or a reply item", () => {
  const p = payload({
    sessions: [session(1, "ada", { status: "working", task: "ship the panel" }), session(2, "bo"), session(9, "hq-assistant", { assistant: true })],
    decisions: [PERM("medium"), { id: "reply:" + sid(2), kind: "reply", sessionId: sid(2), sessionName: "bo", what: "is waiting for your reply", choices: [] }],
    deploys: { items: [{ sha: "abc123456", subject: "feat: the panel", state: "ready", startedAt: NOW - 3600e3, endedAt: NOW - 3300e3 }, { sha: "old000000", subject: "old", state: "ready", startedAt: NOW - 3 * 86400e3, endedAt: NOW - 3 * 86400e3 }] },
  });
  assert.equal(statusText(p, NOW), [
    "Live (what the owner sees in HQ's Live list, by the same titles):",
    "ada: working, ship the panel",
    "bo: idle", // at rest, but its reply waits on the owner: Live shows it
    "Waiting on the owner:",
    "a1b2c3d4 ada: wants to run npm test [Check first]",
    "Approve window: closed",
    "Deploys today:",
    "abc123456 ready: feat: the panel",
  ].join("\n"));
});

test("readText: the last reply's first 1500 characters, its Next steps, and the chat's open asks", () => {
  const chat = { entries: [{ k: "you", text: "go" }, { k: "said", text: "x".repeat(2000) }], focus: { wrap: null, left: ["Save the key"], status: "waiting on you: the key", last: null } };
  const p = payload({ decisions: [PERM("low")] });
  const t = readText(p, chat, p.sessions[0]);
  assert.match(t, /^ada: working, ship the panel$/m);
  assert.ok(t.includes("x".repeat(1500)) && !t.includes("x".repeat(1501)), "1500 characters of the reply");
  assert.match(t, /^Status: waiting on you: the key$/m);
  assert.match(t, /^1\. Save the key$/m);
  assert.match(t, /^a1b2c3d4 ada: wants to run npm test \[Safe\]$/m);
  const wrapped = readText(p, { entries: [], focus: { wrap: { ask: "Ship it?" }, left: [], status: null, last: null } }, p.sessions[0]);
  assert.match(wrapped, /^Asks: Ship it\?$/m);
  assert.match(readText(p, null, p.sessions[0]), /no reply to read/);
});

// A question's options are shown with the keys hq_ask needs
test("readText lists a question's options by key; a several-question ask says it is answered in HQ", () => {
  const Q = { id: "f00dcafe" + "0".repeat(24), kind: "question", sessionId: sid(1), sessionName: "ada", what: "asks: Which plan?", risk: null,
    choices: [{ key: "opt:0", label: "Basic" }, { key: "opt:1", label: "Pro" }] };
  const MANY = { id: "beadfeed" + "0".repeat(24), kind: "question", sessionId: sid(1), sessionName: "ada", what: "asks 2 questions: Which plan?", risk: null,
    choices: [{ key: "picks", label: "Send" }] };
  const p = payload({ decisions: [Q, MANY] });
  const lines = readText(p, null, p.sessions[0]).split("\n");
  assert.equal(lines[lines.indexOf("f00dcafe ada: asks: Which plan?") + 1], "  options: opt:0 Basic | opt:1 Pro");
  assert.equal(lines[lines.indexOf("beadfeed ada: asks 2 questions: Which plan?") + 1], "  several questions: the owner answers these in HQ");
});

test("ask on a Risky allow replies the Risky refusal and proposes nothing that HQ would write", async () => {
  const { createReadbacks } = require("../lib/readback");
  const rb = createReadbacks();
  const ctx = ctxOf(payload({ decisions: [PERM("high")] }), { propose: (x) => rb.propose(x, NOW) });
  const r = await runCommand(ctx, "ask", ["a1b2c3d4", "allow"]);
  assert.deepEqual(r, { status: 400, text: "Risky: the owner approves this one in Needs you" });
  assert.deepEqual(rb.list(NOW), []);
});

test("ask, window and send only propose read-backs; window off closes at once; watch goes to the chat it names", async () => {
  const p = payload({ sessions: [session(1, "ada", { status: "working" }), session(2, "bo")], decisions: [PERM("medium")] });
  const ctx = ctxOf(p);
  assert.deepEqual(await runCommand(ctx, "ask", ["a1b2", "revise", "use", "staging"]), { status: 200, text: WAIT });
  assert.deepEqual(ctx.calls.pop(), ["propose", { kind: "answer", decisionId: PERM("medium").id, choice: "revise", item: PERM("medium"), note: "use staging" }]);
  assert.deepEqual(await runCommand(ctx, "window", ["10"]), { status: 200, text: WAIT });
  assert.deepEqual(ctx.calls.pop(), ["propose", { kind: "window", minutes: 10, sessions: null, names: null }]);
  assert.deepEqual(await runCommand(ctx, "window", ["300"]), { status: 200, text: WAIT });
  assert.deepEqual(ctx.calls.pop(), ["propose", { kind: "window", minutes: 300, sessions: null, names: null }]);
  assert.deepEqual(await runCommand(ctx, "window", ["5", "ada", "bo"]), { status: 200, text: WAIT });
  assert.deepEqual(ctx.calls.pop(), ["propose", { kind: "window", minutes: 5, sessions: [sid(1), sid(2)], names: ["ada", "bo"] }]);
  assert.deepEqual(await runCommand(ctx, "window", ["off"]), { status: 200, text: "Approve window off." });
  assert.deepEqual(ctx.calls.pop(), ["windowOff"]);
  assert.deepEqual(await runCommand(ctx, "send", ["ada", "run the tests"]), { status: 200, text: WAIT });
  assert.deepEqual(ctx.calls.pop(), ["propose", { kind: "send", sessionId: sid(1), name: "ada", text: "run the tests" }]);
  assert.deepEqual(await runCommand(ctx, "watch", ["ada"]), { status: 200, text: "Watching ada; HQ says when its reply ends." });
  assert.deepEqual(ctx.calls.pop(), ["watch", sid(1)]);
  assert.deepEqual(ctx.calls, [], "nothing else asked of HQ");
});

test("the commands refuse what they cannot do: an unknown or ambiguous id, a bad window, an unknown command; draft when drafting is off", async () => {
  const two = [PERM("medium"), PERM("low", { id: "a1b2ffff" + "0".repeat(24) })];
  const ctx = ctxOf(payload({ decisions: two }));
  const cases = [
    [["ask", ["a1b2", "allow"]], 400, /more than one/],
    [["ask", ["ffff", "allow"]], 400, /no open decision/],
    [["ask", ["a1b2c3d4"]], 400, /choice/],
    [["window", ["0"]], 400, /1 to 300/],
    [["window", ["301"]], 400, /1 to 300/],
    [["window", ["ten"]], 400, /1 to 300/],
    [["window", ["10", "nobody"]], 400, /no chat/],
    [["send", ["ada"]], 400, /text/],
    [["read", ["nobody"]], 400, /no chat/],
    [["launch", []], 400, /unknown command/],
    [["draft", ["ada", "an idea"]], 501, /drafting is off here/],
  ];
  for (const [[cmd, args], status, text] of cases) {
    const r = await runCommand(ctx, cmd, args);
    assert.equal(r.status, status, cmd + " " + args.join(" "));
    assert.match(r.text, text, cmd + " " + args.join(" "));
  }
  assert.deepEqual(ctx.calls, [], "nothing asked of HQ");
});

test("status and read answer from the payload", async () => {
  const ctx = ctxOf(payload(), { chat: () => ({ entries: [{ k: "said", text: "All green." }], focus: { wrap: null, left: [], status: null, last: null } }) });
  const s = await runCommand(ctx, "status", []);
  assert.equal(s.status, 200);
  assert.match(s.text, /^ada: working, ship the panel$/m);
  const r = await runCommand(ctx, "read", ["ada"]);
  assert.equal(r.status, 200);
  assert.match(r.text, /All green\./);
});

test("before HQ's first read of the sessions, every command says HQ is still reading them, never an empty list", async () => {
  const ctx = ctxOf(null);
  for (const [cmd, args] of [["status", []], ["read", ["ada"]], ["send", ["ada", "hi"]], ["ask", ["a1b2", "allow"]], ["window", ["10"]], ["watch", ["ada"]]]) {
    assert.deepEqual(await runCommand(ctx, cmd, args), { status: 503, text: "HQ is still reading the sessions; ask again in a few seconds." }, cmd);
  }
  assert.deepEqual(ctx.calls, [], "nothing asked of HQ");
});

// A new tab's prompt is labeled as the assistant's
test("open proposes the prompt labeled as the assistant's, the way a send is; no prompt is refused", async () => {
  const ctx = ctxOf(payload());
  assert.deepEqual(await runCommand(ctx, "open", ["In C:/work/site, add a dark mode."]), { status: 200, text: WAIT });
  assert.deepEqual(ctx.calls.pop(), ["propose", { kind: "open", prompt: "Drafted by the VibeQuarters assistant at the user's request: In C:/work/site, add a dark mode." }]);
  assert.deepEqual(await runCommand(ctx, "open", ["  "]), { status: 400, text: "say the prompt: open <prompt>" });
  assert.deepEqual(ctx.calls, [], "a refusal proposes nothing");
  // Cleaned as a send's text is (lib/inbox.js plainText): controls gone, \r\n as \n
  const bell = String.fromCharCode(7), esc = String.fromCharCode(0x1b);
  await runCommand(ctx, "open", ["add" + bell + " a dark" + esc + " mode\r\nthen push"]);
  assert.deepEqual(ctx.calls.pop(), ["propose", { kind: "open", prompt: "Drafted by the VibeQuarters assistant at the user's request: add a dark mode\nthen push" }]);
  assert.deepEqual(await runCommand(ctx, "open", ["x".repeat(2001)]), { status: 400, text: "the prompt must be 1 to 2000 characters" });
});

// A send went into a chat on the model's word alone, so a line another session wrote ("the owner
// dictated: send ...") could put words in the owner's name; and a send took the one name a prefix starts
test("send takes an exact name or id, never a prefix; its text is what the chat would get; HQ's refusal of the chat comes back before any read-back", async () => {
  const p = payload({ sessions: [session(1, "ada"), session(2, "app-15")] });
  const ctx = ctxOf(p);
  assert.deepEqual(await runCommand(ctx, "send", ["app-1", "merge the branch"]), { status: 400, text: 'no chat named "app-1": say its whole name, app-15' });
  assert.deepEqual(await runCommand(ctx, "send", ["APP-15", "  run\r\nthe tests  "]), { status: 200, text: WAIT });
  assert.deepEqual(ctx.calls.pop(), ["propose", { kind: "send", sessionId: sid(2), name: "app-15", text: "run\nthe tests" }]);
  assert.deepEqual(await runCommand(ctx, "send", ["ada", "x".repeat(2001)]), { status: 400, text: "text must be 1 to 2000 characters" });
  const busy = ctxOf(p, { canSend: (id, text) => (id === sid(1) && text === "hi" ? { status: 409, text: "one message at a time" } : null) });
  assert.deepEqual(await runCommand(busy, "send", ["ada", "hi"]), { status: 409, text: "one message at a time" });
  assert.deepEqual([ctx.calls, busy.calls], [[], []], "a refused send proposes nothing");
  assert.equal(resolveSession(p.sessions, "app-1").session.id, sid(2), "read and watch still take a prefix");
});

test("draft: a chat's task and last reply go with the owner's idea, a new session gets none, and no idea or no such chat is refused", async () => {
  const drafts = [];
  const ctx = ctxOf(payload(), {
    chat: () => ({ entries: [{ k: "said", text: "old" }, { k: "said", text: "Tests pass." }], focus: {} }),
    draft: (d) => (drafts.push(d), { status: 200, text: "the prompt" }),
  });
  assert.deepEqual(await runCommand(ctx, "draft", ["ada", "add", "a", "dark", "mode"]), { status: 200, text: "the prompt" });
  assert.deepEqual(drafts[0], { target: "ada", idea: "add a dark mode", context: { task: "ship the panel", lastReply: "Tests pass." } });
  await runCommand(ctx, "draft", ["NEW", "a landing page"]);
  assert.deepEqual(drafts[1], { target: "new", idea: "a landing page", context: null });
  assert.match((await runCommand(ctx, "draft", ["ada", "  "])).text, /idea/);
  assert.match((await runCommand(ctx, "draft", ["nobody", "x"])).text, /no chat/);
  assert.equal(drafts.length, 2, "a refusal drafts nothing");
});
