// lib/settled.js: what became of each read-back and each decision, newest first, at most 20, memory only. Without it a
// decision could vanish between turns with no word of why.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSettled, confirmedOutcome } = require("../lib/settled");
const { createReadbacks } = require("../lib/readback");

const T0 = Date.parse("2025-02-07T12:00:00.000Z");
const MIN = 60e3;
const ID = (n) => String(n).repeat(32).slice(0, 32);
// a Needs you item as the payload carries it (lib/describe.js)
const item = (n, extra = {}) => ({ id: ID(n), kind: "permission", sessionName: "ada", who: "Ada", what: "wants to run the tests", ...extra });

test("a read-back's entry is its text's first line, without the colon that leads into its prompt, with its outcome and who settled it", () => {
  const s = createSettled();
  s.readback("r1", "Send ada this prompt:\nrun the tests\nthen push", "sent", "you", T0);
  s.readback("r2", "Approve what looks safe for 10 minutes in every chat.", "expired", "VibeQuarters", T0 + MIN);
  assert.deepEqual(s.list(), [
    { id: "r2", at: T0 + MIN, kind: "readback", what: "Approve what looks safe for 10 minutes in every chat.", outcome: "expired", via: "VibeQuarters" },
    { id: "r1", at: T0, kind: "readback", what: "Send ada this prompt", outcome: "sent", via: "you" },
  ], "newest first");
});

test("a confirmed read-back's outcome matches its kind; one that did not go through says what did not happen, with HQ's reason", () => {
  const send = { kind: "send", sessionId: "s1", name: "ada", text: "x" };
  assert.equal(confirmedOutcome(send, true), "sent");
  assert.equal(confirmedOutcome(send, "one message at a time"), "not sent: one message at a time");
  assert.equal(confirmedOutcome(send, "this chat cannot hear VibeQuarters until it ends a reply"), "not sent: this chat cannot hear VibeQuarters until it ends a reply");
  assert.equal(confirmedOutcome({ kind: "window", minutes: 10 }, true), "window opened");
  assert.equal(confirmedOutcome({ kind: "open", prompt: "x" }, true), "session opened");
  assert.equal(confirmedOutcome({ kind: "open", prompt: "x" }, "VS Code's code.cmd is not on PATH, so no session can be opened."), "session not opened: VS Code's code.cmd is not on PATH, so no session can be opened.");
  assert.equal(confirmedOutcome({ kind: "answer", choice: "allow" }, true), "approved");
  assert.equal(confirmedOutcome({ kind: "answer", choice: "deny" }, true), "denied");
  assert.equal(confirmedOutcome({ kind: "answer", choice: "revise" }, true), "changes asked");
  assert.equal(confirmedOutcome({ kind: "answer", choice: "opt:1" }, true), "answered");
  assert.equal(confirmedOutcome({ kind: "answer", choice: "allow" }, "not open"), "not answered: not open");
  assert.equal(confirmedOutcome(send, "failed"), "not sent: failed", "a confirm that threw");
  assert.equal([...confirmedOutcome(send, "y".repeat(5000))].length, "not sent: ".length + 200, "a long reason is cut to 200 characters");
});

test("wired to the read-backs: one expired is recorded instead of dropped silently, and the owner's cancel, Stop and a drop say so", () => {
  const s = createSettled();
  const r = createReadbacks({ onSettle: s.readback });
  const a = r.propose({ kind: "send", sessionId: "s1", name: "ada", text: "run the tests" }, T0);
  r.list(T0 + 5 * MIN + 1);
  assert.deepEqual(s.list(), [{ id: a.id, at: T0 + 5 * MIN + 1, kind: "readback", what: "Send ada this prompt", outcome: "expired", via: "VibeQuarters" }]);
  const b = r.propose({ kind: "open", prompt: "add a dark mode" }, T0 + 6 * MIN);
  const c = r.propose({ kind: "window", minutes: 5, sessions: null, names: null }, T0 + 6 * MIN);
  r.cancel(b.id, undefined, undefined, T0 + 7 * MIN);
  r.cancelAll(T0 + 8 * MIN);
  assert.deepEqual(s.list().map((e) => [e.id, e.outcome, e.via]), [[c.id, "canceled", "Stop"], [b.id, "canceled", "you"], [a.id, "expired", "VibeQuarters"]]);
});

test("a decision that leaves the open list is settled with the answer HQ wrote: approved, denied, changes asked or answered, by you, the approve window or an assistant read-back", () => {
  const s = createSettled();
  const items = [item(1), item(2), item(3, { kind: "question", what: "asks: Which color?" }), item(4), item(5), item(6, { kind: "question", what: "asks: Ship it?" })];
  s.sync(items, T0);
  assert.deepEqual(s.list(), [], "nothing has left yet");
  s.answered(ID(1), "allow", undefined); // the owner's click
  s.answered(ID(2), "allow", "window");
  s.answered(ID(3), "opt:1", "readback");
  s.answered(ID(4), "deny", undefined);
  s.answered(ID(5), "revise", "readback");
  s.answered(ID(6), "picks", undefined);
  s.sync([], T0 + MIN);
  assert.deepEqual(s.list().reverse(), [
    { id: ID(1), at: T0 + MIN, kind: "decision", what: "ada wants to run the tests", outcome: "approved", via: "you" },
    { id: ID(2), at: T0 + MIN, kind: "decision", what: "ada wants to run the tests", outcome: "approved", via: "approve window" },
    { id: ID(3), at: T0 + MIN, kind: "decision", what: "ada asks: Which color?", outcome: "answered", via: "assistant read-back" },
    { id: ID(4), at: T0 + MIN, kind: "decision", what: "ada wants to run the tests", outcome: "denied", via: "you" },
    { id: ID(5), at: T0 + MIN, kind: "decision", what: "ada wants to run the tests", outcome: "changes asked", via: "assistant read-back" },
    { id: ID(6), at: T0 + MIN, kind: "decision", what: "ada asks: Ship it?", outcome: "answered", via: "you" },
  ]);
  s.sync([], T0 + 2 * MIN);
  assert.equal(s.list().length, 6, "settled once");
});

test("a decision that leaves with no answer HQ wrote was answered in VS Code or is gone; one still open, or a reply item, is never settled", () => {
  const s = createSettled();
  const reply = { id: "s-1", kind: "reply", sessionName: "bo", who: "bo", what: "finished its turn" };
  s.sync([item(1), item(2), reply, item(3, { notice: true })], T0);
  s.sync([item(2)], T0 + MIN);
  assert.deepEqual(s.list().map((e) => [e.id, e.outcome, e.via]), [[ID(3), "answered in VS Code or gone", "outside VibeQuarters"], [ID(1), "answered in VS Code or gone", "outside VibeQuarters"]], "a notice too; the reply is not a decision");
  s.answered(ID(2), "allow", undefined);
  s.sync([item(2)], T0 + 2 * MIN);
  assert.equal(s.list().length, 2, "answered but still listed: not settled until it leaves");
  s.sync([], T0 + 3 * MIN);
  assert.deepEqual(s.list()[0], { id: ID(2), at: T0 + 3 * MIN, kind: "decision", what: "ada wants to run the tests", outcome: "approved", via: "you" });
});

test("the history keeps the newest 20 only", () => {
  const s = createSettled();
  for (let i = 0; i < 25; i++) s.readback("r" + i, "Open a new session with this prompt:\nx", "canceled", "you", T0 + i);
  assert.equal(s.list().length, 20);
  assert.deepEqual([s.list()[0].id, s.list()[19].id], ["r24", "r5"]);
});
