// The room panels' rows with no DOM (public/floor/panel-data.js): the Live list as the Dashboard keeps it, Top tools'
// bars, the Sessions and Agents tabs, the switches' rows against the example config, a raised hand, and a panel's
// start state at a width.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WIDE, WIDE_WARN, PANELS, liveList, inLive, toolBars, sessionList, agentList, switchRows, handUp, startMin } from "../public/floor/panel-data.js";
import { WANT } from "../public/format.js";
import { MASK, setStreaming } from "../public/streamer.js";

const S = (id, status, extra = {}) => ({ id, name: id, title: null, status, action: null, task: null, waitsOn: null, waitingFor: [], ...extra });
const plain = (text) => [{ text, masked: false }];
const streamed = (fn) => { setStreaming(true); try { return fn(); } finally { setStreaming(false); } };

test("the Live list is the Dashboard's: chats not idle or with an open item, its want word first, else what it waits on, else its action", () => {
  const sessions = [
    S("asks", "needs-you", { title: "Fix the footer", action: "Using Edit" }),
    S("ended", "idle", { action: "Using Bash" }),
    S("quiet", "idle", { action: "Using Read" }),
    S("hands", "working", { waitsOn: "subagent", waitingFor: ["Review the diff", "Run the tests"], action: "Using Agent" }),
    S("job", "working", { waitsOn: "background", waitingFor: ["npm test", "npm run build"], action: "Using Bash" }),
    S("busy", "working", { action: "Using Grep", task: "Ship the panels" }),
    S("plans", "thinking", { task: "Ship the panels" }),
    S("blank", "working"),
  ];
  const open = { asks: 2, ended: 1 };
  const want = { asks: "approval", ended: "reply" };
  const rows = liveList(sessions, { needs: (id) => open[id] || 0, want: (id) => want[id] || null, names: ["Fix the footer"] });
  assert.deepEqual(rows.map((r) => r.id), ["asks", "ended", "hands", "job", "busy", "plans", "blank"]); // the caller's order, the idle chat with nothing open gone
  assert.deepEqual(rows[0], { id: "asks", st: "needs-you", name: "Fix the footer", nameMasked: false, doing: plain("Needs your approval") }); // its title, as the Dashboard row shows it
  assert.deepEqual([rows[1].st, rows[1].name, rows[1].doing], ["needs-you", "ended", plain("Needs your reply")]); // idle, but its reply is open
  assert.deepEqual(rows.slice(2).map((r) => [r.st, r.doing]), [
    ["working", plain("Waiting on 2 agents")],
    ["working", plain("Waiting on: npm test +1 more")],
    ["working", plain("Using Grep")],
    ["thinking", plain("Ship the panels")],
    ["working", []],
  ]);
  // an open item makes the row needs-you whatever its status, and the want word wins over what it waits on
  const [w] = liveList([S("x", "working", { waitsOn: "timer", wakeAt: 0 })], { needs: () => 1, want: () => "answer", names: [] });
  assert.deepEqual([w.st, w.doing], ["needs-you", plain(WANT.answer)]);
  assert.deepEqual(WANT, { approval: "Needs your approval", answer: "Needs your answer", reply: "Needs your reply" });
});

// The assistant's chat has its own panel, so it never shows in Live
test("the HQ assistant's own chat is never in Live, working or with something open, on the Dashboard or in the room", () => {
  const sessions = [S("helper", "working", { assistant: true }), S("asked", "idle", { assistant: true }), S("ada", "working")];
  const needs = (id) => (id === "asked" ? 1 : 0);
  assert.deepEqual(liveList(sessions, { needs, want: () => null, names: [] }).map((r) => r.id), ["ada"]);
  assert.deepEqual(sessions.filter((s) => inLive(s, needs)).map((s) => s.id), ["ada"]);
  assert.equal(inLive(S("ended", "idle"), () => 1), true, "an idle chat with something open stays");
  assert.equal(inLive(S("done", "idle"), () => 0), false, "an idle chat with nothing open goes");
});

test("under Streamer a Live row's name is the mask and a known name inside its action is masked in place", () => {
  const sessions = [S("webapp-21", "working", { action: "Push webapp-21 to origin" }), S("b", "needs-you", { title: "webapp-22" })];
  const opts = { needs: (id) => (id === "b" ? 1 : 0), want: (id) => (id === "b" ? "approval" : null), names: ["webapp-21", "webapp-22"] };
  const rows = streamed(() => liveList(sessions, opts));
  assert.deepEqual(rows[0], { id: "webapp-21", st: "working", name: MASK, nameMasked: true,
    doing: [{ text: "Push ", masked: false }, { text: "webapp-21", masked: true }, { text: " to origin", masked: false }] });
  assert.deepEqual([rows[1].name, rows[1].nameMasked, rows[1].doing], [MASK, true, plain("Needs your approval")]); // a want word names no one
  // the control: with Streamer off the same rows show the names
  const off = liveList(sessions, opts);
  assert.deepEqual([off[0].name, off[0].nameMasked, off[0].doing], ["webapp-21", false, plain("Push webapp-21 to origin")]);
  assert.equal(off[1].name, "webapp-22");
});

test("top tools: at most 5 rows, each with its share of the top count, and today's total", () => {
  const byToolToday = [["Bash", 300], ["Read", 150], ["Edit", 75], ["Grep", 30], ["Write", 3], ["Glob", 1]].map(([name, count]) => ({ name, count }));
  assert.deepEqual(toolBars({ toolCallsToday: 812, byToolToday }), {
    total: 812,
    rows: [{ name: "Bash", count: 300, pct: 100 }, { name: "Read", count: 150, pct: 50 }, { name: "Edit", count: 75, pct: 25 }, { name: "Grep", count: 30, pct: 10 }, { name: "Write", count: 3, pct: 1 }],
  });
  assert.deepEqual(toolBars({ toolCallsToday: 0, byToolToday: [] }), { total: 0, rows: [] });
  assert.deepEqual(toolBars({ toolCallsToday: null, byToolToday: null }), { total: null, rows: [] }); // stats not read yet
  assert.deepEqual(toolBars(null), { total: null, rows: [] });
});

test("sessions: warm with time left, cold, context amber from 75 and red from 90 percent, a cache amber in its last 10 minutes and red in its last 2, spend in dollars", () => {
  const now = 1_800_000_000_000;
  const sessions = [
    S("none", "idle", { lastAt: now - 3000, cache: null, context: null, cost: 0 }),
    S("warm", "working", { title: "Fix the footer", lastAt: now - 1000, cache: { state: "warm", expiresAt: now + 4 * 60e3 }, context: { pct: 90 }, cost: 1.5 }),
    S("cold", "needs-you", { lastAt: now - 2000, cache: { state: "cold", expiresAt: now - 1 }, context: { pct: 80 }, cost: 12.3 }),
    S("roomy", "working", { lastAt: now - 4000, cache: { state: "warm", expiresAt: now + 30e3 }, context: { pct: 75 }, cost: 0.2 }),
    S("calm", "working", { lastAt: now - 5000, cache: { state: "warm", expiresAt: now + 11 * 60e3 }, context: { pct: 74 }, cost: 0.1 }),
  ];
  assert.deepEqual(sessionList(sessions, now), [
    { id: "warm", name: "Fix the footer", cache: "Warm, 4m left", cold: false, cacheLevel: "warn", ctx: 90, ctxLevel: "bad", spend: "$1.50" },
    { id: "cold", name: "cold", cache: "Cold", cold: true, cacheLevel: null, ctx: 80, ctxLevel: "warn", spend: "$12.30" },
    { id: "none", name: "none", cache: "-", cold: false, cacheLevel: null, ctx: null, ctxLevel: null, spend: "$0.00" },
    { id: "roomy", name: "roomy", cache: "Warm, 30s left", cold: false, cacheLevel: "bad", ctx: 75, ctxLevel: "warn", spend: "$0.20" },
    { id: "calm", name: "calm", cache: "Warm, 11m left", cold: false, cacheLevel: null, ctx: 74, ctxLevel: null, spend: "$0.10" },
  ]);
  const many = Array.from({ length: 14 }, (_, i) => S("s" + i, "working", { lastAt: now - i, cache: null, context: null, cost: 0 }));
  assert.deepEqual(sessionList(many.slice().reverse(), now).map((r) => r.id), many.slice(0, 12).map((s) => s.id)); // newest first, 12 at most
  // under Streamer the name is the mask, the numbers stay
  const [masked] = streamed(() => sessionList(sessions, now));
  assert.deepEqual(masked, { id: "warm", name: MASK, cache: "Warm, 4m left", cold: false, cacheLevel: "warn", ctx: 90, ctxLevel: "bad", spend: "$1.50" });
});

test("agents: off wins over working; under Streamer a row says only Working, Idle or Off", () => {
  const agents = [
    { id: "planner", name: "Planner", off: true, working: true, doing: "Plan the release" }, // a seated session can still work at an off desk
    { id: "builder", name: "Builder", off: false, working: true, doing: "Review PR 12 for webapp-21" },
    { id: "scout", name: "Scout", off: false, working: false, doing: null },
    { id: "guide", name: "Guide", off: false, working: true, doing: null },
  ];
  assert.deepEqual(agentList(agents), [
    { id: "planner", name: "Planner", st: "off", doing: "Off" },
    { id: "builder", name: "Builder", st: "working", doing: "Review PR 12 for webapp-21" },
    { id: "scout", name: "Scout", st: "idle", doing: "Idle" },
    { id: "guide", name: "Guide", st: "working", doing: "Working" },
  ]);
  assert.deepEqual(streamed(() => agentList(agents)).map((r) => [r.name, r.st, r.doing]), [
    [MASK, "off", "Off"], [MASK, "working", "Working"], [MASK, "idle", "Idle"], [MASK, "working", "Working"]]);
});

test("switch rows: what each blocks, a warning on the built-in types, and the no-types line", () => {
  const config = JSON.parse(readFileSync(new URL("../hq.config.example.json", import.meta.url), "utf8"));
  const agents = [...config.agents.map((a) => ({ id: a.id, name: a.name, off: a.id === "guide", agentTypes: a.agentTypes })), { id: "new", name: "New Hire", off: false, agentTypes: [] }];
  const rows = Object.fromEntries(switchRows(agents).map((r) => [r.id, r]));
  assert.deepEqual(rows.builder, { id: "builder", name: "Builder", on: true, blocks: ["general-purpose"], wide: true, line: "Blocks general-purpose in every chat" });
  assert.deepEqual(rows.guide, { id: "guide", name: "Guide", on: false, blocks: ["claude-code-guide", "statusline-setup"], wide: false, line: "Blocks claude-code-guide, statusline-setup in every chat" });
  assert.equal(rows.planner.wide, true); // Plan
  assert.deepEqual(rows.new, { id: "new", name: "New Hire", on: true, blocks: [], wide: false, line: "Nothing to block yet: its desk only goes dark" });
  assert.deepEqual([...WIDE], ["general-purpose", "claude", "Plan", "Explore"]);
  assert.equal(WIDE_WARN, "Every chat uses this type: while it is off, no chat can start one.");
});

test("a hand is up for a waiting true or a non-empty waiting list, never for an empty list or false", () => {
  assert.equal(handUp({ waiting: true }), true);
  assert.equal(handUp({ waiting: ["0a1b2c3d"] }), true);
  assert.equal(handUp({ waiting: [] }), false);
  assert.equal(handUp({ waiting: false }), false);
  assert.equal(handUp({}), false);
  assert.equal(handUp({ waiting: "yes" }), false);
});

test("a panel starts as a pill at 720 px and under unless the owner opened it; a stored choice wins at any width", () => {
  assert.equal(startMin(720, null), true);
  assert.equal(startMin(390, null), true);
  assert.equal(startMin(721, null), false);
  assert.equal(startMin(1440, undefined), false);
  assert.equal(startMin(390, "open"), false);
  assert.equal(startMin(1440, "min"), true);
  assert.equal(startMin(390, "junk"), true);
  assert.deepEqual(PANELS, [{ key: "live", title: "Live" }, { key: "deploys", title: "Deploys" }, { key: "tools", title: "Top tools" }, { key: "team", title: "Sessions and agents" }, { key: "assistant", title: "Assistant" }]);
});

// panels.js builds its panels at import, which needs a page, so its SPEC is read as text: every panel in PANELS has its
// rows, count and fill there (a missing key throws on the first draw)
test("every panel in PANELS, the Assistant among them, has its entry in panels.js SPEC", () => {
  const src = readFileSync(new URL("../public/floor/panels.js", import.meta.url), "utf8");
  const spec = src.slice(src.indexOf("const SPEC = {"), src.indexOf("\n};\n", src.indexOf("const SPEC = {")));
  const keys = [...spec.matchAll(/^ {2}([a-z]+): \{$/gm)].map((m) => m[1]);
  assert.deepEqual(keys, PANELS.map((p) => p.key));
});
