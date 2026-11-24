// lib/assistant-cmds.js: the assistant sees what the owner sees. It names each chat by its Live title, lists Live as Live
// shows it, and reads each chat's steps, context, cost and warnings, the dashboard's counts and the Office's desks.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveSession, statusText, readText, runCommand, contextLevel } = require("../lib/assistant-cmds");

const NOW = Date.parse("2025-02-07T15:00:00.000Z");
const sid = (n) => "5e550000-0000-4000-8000-" + String(n).padStart(12, "0");
const session = (n, name, extra = {}) => ({ id: sid(n), name, status: "idle", task: null, action: null, ...extra });
const CLOSED = { open: false, endsAt: null, sessions: null, approved: 0 };
const WAIT = "Read-back shown to the owner; waiting for the owner's yes.";
const payload = (o = {}) => ({ sessions: [], decisions: [], window: CLOSED, deploys: null, board: { conflicts: [], locks: [], feed: [] }, ...o });
function ctxOf(p, over = {}) {
  const calls = [];
  return {
    calls, now: () => NOW, payload: () => p, chat: () => null, canSend: () => null,
    propose: (x) => (calls.push(["propose", x]), { ok: true, id: "0123456789abcdef", text: "the read-back" }),
    windowOff: () => calls.push(["windowOff"]), watch: (id) => (calls.push(["watch", id]), true), ...over,
  };
}
const ctx = (pct) => ({ tokens: pct * 5000, of: 500000, pct });

test("a chat is named by its Live title, and found by that title, its session name or its id", () => {
  const list = [session(1, "desk-31", { title: "Docs search" }), session(2, "desk-32", { title: "Fix the cart page" }), session(3, "ada")];
  assert.equal(resolveSession(list, "Docs search").session.id, sid(1), "the exact Live title, any case");
  assert.equal(resolveSession(list, "docs se").session.id, sid(1), "a prefix only one title starts with");
  assert.equal(resolveSession(list, "desk-32").session.id, sid(2), "the session name still works");
  assert.equal(resolveSession(list, "ada").session.id, sid(3), "no title: the name is the Live title");
  assert.equal(resolveSession(list, "Docs search", { exact: true }).session.id, sid(1), "a send takes the exact title");
  assert.equal(resolveSession(list, "docs se", { exact: true }).ok, false, "never a prefix for a send");
  const r = resolveSession(list, "desk");
  assert.equal(r.ok, false);
  assert.deepEqual(r.candidates.sort(), ["Docs search", "Fix the cart page"], "the candidates by the titles the owner sees");
  const twins = resolveSession([session(1, "a", { title: "Same" }), session(2, "b", { title: "same" })], "same");
  assert.equal(twins.ok, false, "two chats with one title are refused");
  assert.deepEqual(twins.candidates, [sid(1), sid(2)]);
});

test("statusText lists Live as Live does, by title: the chats in use and the idle ones that need the owner, then the other chats", () => {
  const PERM = { id: "a1b2c3d4" + "e".repeat(24), kind: "permission", sessionId: sid(3), sessionName: "desk-33", what: "wants to run npm run db:migrate", risk: { level: "high", label: "Risky", reason: "changes the live site or database" }, choices: [] };
  const p = payload({
    sessions: [
      session(1, "desk-31", { title: "Docs search", status: "working", task: "index the pages" }),
      session(2, "desk-32", { title: "Old chat" }),
      session(3, "desk-33", { title: "Add the orders table" }),
      session(9, "hq-assistant", { assistant: true, status: "working" }),
    ],
    decisions: [PERM],
  });
  const t = statusText(p, NOW);
  const lines = t.split("\n");
  const live = lines.indexOf("Live (what the owner sees in HQ's Live list, by the same titles):");
  const other = lines.indexOf("Other chats (idle, not in Live):");
  assert.ok(live >= 0 && other > live, t);
  assert.deepEqual(lines.slice(live + 1, other), ["Docs search: working, index the pages", "Add the orders table: idle"], "in use, and idle but asking");
  assert.equal(lines[other + 1], "Old chat: idle");
  assert.ok(!/desk-31|desk-32|desk-33|hq-assistant/.test(t), "never the session names, never its own chat");
  assert.match(t, /^a1b2c3d4 Add the orders table: wants to run npm run db:migrate \[Risky: changes the live site or database\]$/m, "a decision by its chat's title, with why it is Risky");
});

test("a chat's line carries what its Live row shows: its step and its context with what to do", () => {
  const s = session(1, "desk-31", {
    title: "Docs search", status: "working", task: "index the pages", toolCount: 140, cost: 4.2,
    progress: { step: 3, of: 8, pct: 37, done: false, finishAt: null }, context: ctx(78),
  });
  assert.equal(statusText(payload({ sessions: [s] }), NOW).split("\n")[1], "Docs search: working, index the pages; step 3 of 8; context 78%, time to compact");
  const full = { ...s, context: ctx(91) };
  assert.match(statusText(payload({ sessions: [full] }), NOW), /context 91%, time to hand off to a fresh session$/m);
});

test("contextLevel: 75% is time to compact, 90% time to hand off", () => {
  assert.deepEqual([null, 0, 74, 75, 89, 90, 100].map((pct) => contextLevel(pct == null ? {} : { context: ctx(pct) })), [0, 0, 0, 1, 1, 2, 2]);
});

test("readText: everything its Live row and details show, by its title", () => {
  const s = session(1, "desk-31", {
    title: "Docs search", status: "working", task: "index the pages", action: "Running the tests", project: "hq-assistant", branch: "hq-assistant",
    startedAt: NOW - 42 * 60e3, toolCount: 140, cost: 4.25, context: ctx(78), progress: { step: 3, of: 8, pct: 37, done: false, finishAt: null },
    subagents: [{ description: "Decisions history", running: true }, { description: "Old search", running: false }], subagentsTotal: 2,
    locks: ["merge"], cache: { state: "warm", expiresAt: NOW + 4 * 60e3 }, waitsOn: null,
    events: [{ at: NOW - 30e3, label: "Ran the tests" }, { at: NOW - 90e3, label: "Edited voice.js" }],
  });
  const t = readText(payload({ sessions: [s] }), null, s, NOW);
  assert.match(t, /^Docs search: working, index the pages; step 3 of 8; context 78%, time to compact$/m);
  assert.match(t, /^Folder: hq-assistant, branch hq-assistant$/m);
  assert.match(t, /^Now: Running the tests$/m);
  assert.match(t, /^42 min elapsed, 140 actions, \$4\.25 API-equivalent$/m);
  assert.match(t, /^Context: 390k of 500k tokens \(78%\), time to compact$/m);
  assert.match(t, /^Subagents: 1 of 2 running: Decisions history$/m);
  assert.match(t, /^Holds the merge lock$/m);
  assert.match(t, /^Prompt cache: warm, 4 min left$/m);
  assert.match(t, /^Latest steps: Ran the tests \(30 s ago\); Edited voice\.js \(1 min ago\)$/m);
  assert.ok(!t.includes("desk-31"), "never the session name");
});

test("statusText shows the dashboard's counts and the Office's desks when the payload has them", () => {
  const p = payload({
    sessions: [session(1, "desk-31", { title: "Docs search", status: "working" })],
    pill: { working: 1, needsYou: 2, conflicts: 0 },
    vitals: { liveSessions: 5, subagentsRunning: 3, toolCallsToday: 1234, spendToday: 123.456, plan: { pct: 62, resetsAt: NOW + 86400e3 }, filesClaimed: 14, conflicts: 0 },
    floor: { agents: [{ name: "Scout", working: true, doing: "Search the repo", forSession: "desk-31" }, { name: "Idle one", working: false }], helpers: [{ name: "Run the smoke", forSession: "desk-31" }] },
  });
  const t = statusText(p, NOW);
  assert.match(t, /^Dashboard: 1 working, 2 need you, 0 conflicts; 5 live chats, 3 subagents running; today 1,234 actions, \$123\.46 API-equivalent; weekly plan 62% used; 14 files claimed$/m);
  // with no coordination board and no usage readings, those parts are left out, never shown as zero
  const bare = statusText({ ...p, board: null, vitals: { ...p.vitals, plan: null, filesClaimed: null } }, NOW);
  assert.match(bare, /^Dashboard: 1 working, 2 need you; 5 live chats, 3 subagents running; today 1,234 actions, \$123\.46 API-equivalent$/m);
  assert.match(t, /^Office: Scout is working on Search the repo for Docs search; helpers: Run the smoke \(for Docs search\)$/m, "the desks by the chats' titles");
});

test("send, window and watch name the chat by its Live title", async () => {
  const p = payload({ sessions: [session(1, "desk-31", { title: "Docs search", status: "working" })] });
  const c = ctxOf(p);
  assert.deepEqual(await runCommand(c, "send", ["Docs search", "run the tests"]), { status: 200, text: WAIT });
  assert.deepEqual(c.calls.pop(), ["propose", { kind: "send", sessionId: sid(1), name: "Docs search", text: "run the tests" }]);
  await runCommand(c, "window", ["5", "docs se"]);
  assert.deepEqual(c.calls.pop(), ["propose", { kind: "window", minutes: 5, sessions: [sid(1)], names: ["Docs search"] }]);
  assert.deepEqual(await runCommand(c, "watch", ["desk-31"]), { status: 200, text: "Watching Docs search; HQ says when its reply ends." });
});

test("context: proposes HQ's own compact or hand-off message to a chat, as a send the owner confirms", async () => {
  const p = payload({ sessions: [session(1, "desk-31", { title: "Docs search", status: "idle", context: ctx(91) })] });
  const c = ctxOf(p);
  assert.deepEqual(await runCommand(c, "context", ["Docs search", "handoff"]), { status: 200, text: WAIT });
  const [, handoff] = c.calls.pop();
  assert.equal(handoff.kind, "send");
  assert.equal(handoff.name, "Docs search");
  assert.match(handoff.text, /^VibeQuarters: your context is 91% full, so this chat should hand off to a fresh session\./);
  assert.match(handoff.text, /handoff prompt for a fresh session/);
  await runCommand(c, "context", ["Docs search", "compact"]);
  const [, compact] = c.calls.pop();
  assert.match(compact.text, /^VibeQuarters: your context is 91% full\./);
  assert.match(compact.text, /\/compact/, "it says the owner types /compact: a sent message cannot run a command");
  assert.match((await runCommand(c, "context", ["Docs search", "shrink"])).text, /compact or handoff/);
  const busy = ctxOf(p, { canSend: () => ({ status: 409, text: "one message at a time" }) });
  assert.deepEqual(await runCommand(busy, "context", ["Docs search", "compact"]), { status: 409, text: "one message at a time" });
  assert.deepEqual(busy.calls, [], "a chat that cannot take it gets no read-back");
});

test("status: the read-backs waiting for the owner's yes, and what happened to the latest messages and decisions", () => {
  const p = payload({
    readbacks: [{ id: "r1", kind: "send", text: "Send Fix the footer this prompt:\nship it", at: NOW - 60e3, expiresAt: NOW + 4 * 60e3 }],
    settled: [
      { id: "a", at: NOW - 2 * 60e3, kind: "readback", what: "Send Fix the footer this prompt", outcome: "sent", via: "you" },
      { id: "b", at: NOW - 9 * 60e3, kind: "readback", what: "Send Docs this prompt", outcome: "expired", via: "VibeQuarters" },
      { id: "c", at: NOW - 20 * 60e3, kind: "decision", what: "Fix the footer run the type check", outcome: "approved", via: "approve window" },
    ],
  });
  const t = statusText(p, NOW);
  assert.ok(t.includes("Waiting for the owner's yes in HQ:\n  Send Fix the footer this prompt (expires in 4 min)"), t);
  assert.ok(t.includes("What happened lately (newest first):\n  2 min ago: Send Fix the footer this prompt: sent, by you\n  9 min ago: Send Docs this prompt: expired, by VibeQuarters\n  20 min ago: Fix the footer run the type check: approved, by approve window"), t);
  const quiet = statusText(payload(), NOW);
  assert.ok(!quiet.includes("Waiting for the owner's yes") && !quiet.includes("What happened lately"), quiet);
});
