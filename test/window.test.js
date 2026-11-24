// lib/window.js: the approve window the owner opens for a number of minutes. HQ itself answers allow for each open
// permission it covers while it runs: every one, Risky ones, plans and safety hooks' asks too, never a question or a
// notice, and only the sessions the owner named.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createWindow, windowEndLine } = require("../lib/window");

const T0 = Date.parse("2025-02-07T12:00:00.000Z");
const MIN = 60e3;
const P = (level, extra = {}) => ({ id: "p".repeat(32), kind: "permission", sessionId: "s1", risk: level ? { level } : null, ...extra });

test("a 10-minute window is open at +9 min and ends by time at +10 min, once", () => {
  const w = createWindow();
  const r = w.open({ minutes: 10 }, T0);
  assert.equal(r.ok, true);
  assert.deepEqual([r.window.openedAt, r.window.endsAt, r.window.sessions, r.window.approved], [T0, T0 + 10 * MIN, null, 0]);
  const at9 = w.current(T0 + 9 * MIN);
  assert.equal(at9.id, r.window.id);
  assert.equal(w.current(T0 + 10 * MIN), null);
  const ended = w.takeEnded();
  assert.equal(ended.length, 1);
  assert.deepEqual([ended[0].id, ended[0].reason, ended[0].approved, ended[0].endedAt], [r.window.id, "time", 0, T0 + 10 * MIN]);
  assert.deepEqual(w.takeEnded(), [], "taken once");
  assert.equal(w.current(T0 + 11 * MIN), null);
});

test("minutes outside 1 to 300, or not whole, are refused; sessions are null or a list of ids", () => {
  const w = createWindow();
  for (const minutes of [0, 301, -5, 1.5, "10", null, undefined]) assert.equal(w.open({ minutes }, T0).ok, false, String(minutes));
  assert.equal(w.current(T0), null);
  for (const sessions of ["s1", [1], [""], {}]) assert.equal(w.open({ minutes: 5, sessions }, T0).ok, false, JSON.stringify(sessions));
  assert.equal(w.open({ minutes: 1 }, T0).ok, true);
  assert.equal(w.open({ minutes: 300, sessions: ["s1", "s2"] }, T0).ok, true);
  assert.equal(createWindow({ maxMs: 30 * MIN }).open({ minutes: 31 }, T0).ok, false, "past maxMs");
});

test("a second open replaces the first, which ends as replaced with its count; off ends it as off", () => {
  const w = createWindow();
  const a = w.open({ minutes: 10 }, T0).window;
  w.note();
  w.note();
  const b = w.open({ minutes: 5 }, T0 + MIN).window;
  assert.notEqual(a.id, b.id);
  assert.deepEqual(w.takeEnded().map((e) => [e.id, e.reason, e.approved]), [[a.id, "replaced", 2]]);
  assert.equal(w.current(T0 + MIN).approved, 0);
  w.note();
  assert.equal(w.current(T0 + MIN).approved, 1);
  assert.deepEqual(w.close("off", T0 + 2 * MIN), { id: b.id, reason: "off", approved: 1, endedAt: T0 + 2 * MIN, tally: {} });
  assert.equal(w.current(T0 + 2 * MIN), null);
  assert.equal(w.close("off", T0 + 2 * MIN), null, "nothing open to close");
});

// Risky ones, plans and safety prompts are covered too: the levels and the judge (server.js) decide each one
test("covers every permission, Risky ones, plans and safety prompts too, never a notice, a question, or a session outside the list", () => {
  const w = createWindow();
  assert.equal(w.covers(P("medium"), T0), false, "no window open");
  w.open({ minutes: 10, sessions: ["s1"] }, T0);
  assert.equal(w.covers(P("medium"), T0), true);
  assert.equal(w.covers(P("low"), T0), true);
  assert.equal(w.covers(P("high"), T0), true, "Risky");
  assert.equal(w.covers(P(null, { toolName: "ExitPlanMode" }), T0), true, "a plan");
  assert.equal(w.covers(P("low", { notice: true }), T0), false, "a notice");
  assert.equal(w.covers(P("low", { hookAsk: { hook: "guard-config.js", reason: "r" } }), T0), true, "a hook's ask");
  assert.equal(w.covers(P("high", { hookAsk: { hook: "guard-bash.js", reason: "r" } }), T0), true, "a Risky hook's ask");
  assert.equal(w.covers({ ...P(null), kind: "question" }, T0), false, "a question");
  assert.equal(w.covers({ ...P("low"), kind: "reply" }, T0), false, "a finished turn");
  assert.equal(w.covers(P("low", { sessionId: "s2" }), T0), false, "outside the sessions");
  assert.equal(w.covers(P("low"), T0 + 10 * MIN), false, "after the end");
  const all = createWindow();
  all.open({ minutes: 10 }, T0);
  assert.equal(all.covers(P("low", { sessionId: "s2" }), T0), true, "no list covers every session");
});

// When a window ends, HQ names the deletes and the live changes it approved
test("the end line counts what it approved, names the deletes and live changes, and what still waits", () => {
  assert.equal(windowEndLine(14, 2, { "deletes files": 2, "changes the live site or database": 1 }), "Approve window ended. I approved 14. That includes 2 deletes and 1 live site or database change. 2 are waiting for you.");
  assert.equal(windowEndLine(1, 1, { "deletes files": 1 }), "Approve window ended. I approved 1. That includes 1 delete. 1 is waiting for you.");
  assert.equal(windowEndLine(3, 0, { "merges code": 2, "publishes or pushes code": 1 }), "Approve window ended. I approved 3. That includes 2 merges.", "pushes are routine enough to leave out");
  assert.equal(windowEndLine(0, 0), "Approve window ended. I approved 0.");
});

test("note tallies each approval's risk reason for the end line", () => {
  const w = createWindow();
  w.open({ minutes: 10 }, T0);
  w.note("deletes files");
  w.note("deletes files");
  w.note(null);
  assert.equal(w.current(T0).approved, 3);
  const e = w.close("off", T0 + MIN);
  assert.deepEqual([e.reason, e.approved, e.tally], ["off", 3, { "deletes files": 2 }]);
  assert.deepEqual(w.takeEnded().map((x) => x.tally), [{ "deletes files": 2 }]);
});
