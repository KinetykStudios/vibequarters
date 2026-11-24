// lib/heads-up.js: what HQ says out loud, and notes in the Assistant panel, after each refresh. A watched chat's reply
// ends; a chat's context reaches 75% (time to compact) or 90% (time to hand off), once each way up.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHeadsUp } = require("../lib/heads-up");

const sid = (n) => "5e550000-0000-4000-8000-" + String(n).padStart(12, "0");
const chat = (n, extra = {}) => ({ id: sid(n), name: "desk-" + n, title: "Chat " + n, status: "idle", task: null, context: null, ...extra });
const ctx = (pct) => ({ tokens: pct * 5000, of: 500000, pct });

test("context: a chat reaching 75% gets one compact line, reaching 90% one hand-off line, and a compact lets it warn again", () => {
  const h = createHeadsUp();
  assert.deepEqual(h.next([chat(1, { context: ctx(60) })]), []);
  assert.deepEqual(h.next([chat(1, { context: ctx(76) })]), ["Chat 1 is at 76 percent context. Time to compact."]);
  assert.deepEqual(h.next([chat(1, { context: ctx(80) })]), [], "once, not every refresh");
  assert.deepEqual(h.next([chat(1, { context: ctx(91) })]), ["Chat 1 is at 91 percent context. Time to hand it off to a fresh session."]);
  assert.deepEqual(h.next([chat(1, { context: ctx(95) })]), []);
  assert.deepEqual(h.next([chat(1, { context: ctx(20) })]), [], "it compacted");
  assert.deepEqual(h.next([chat(1, { context: ctx(77) })]), ["Chat 1 is at 77 percent context. Time to compact."], "and warns again");
});

test("context: several chats crossing together share one line a level; the assistant's own chat is never named", () => {
  const h = createHeadsUp();
  assert.deepEqual(h.next([chat(1, { context: ctx(78) }), chat(2, { context: ctx(81) }), chat(3, { context: ctx(92) }), chat(9, { assistant: true, context: ctx(95) })]), [
    "Chat 3 is at 92 percent context. Time to hand it off to a fresh session.",
    "Chat 1 and Chat 2 are past 75 percent context. Time to compact them.",
  ]);
});

test("watch: a watched chat seen working that stops says its reply ended, once", () => {
  const h = createHeadsUp();
  h.next([chat(1), chat(2)]);
  h.watch(sid(1), false);
  h.watch(sid(2), false);
  assert.deepEqual(h.next([chat(1, { status: "working" }), chat(2, { status: "working" })]), []);
  assert.deepEqual(h.next([chat(1, { status: "needs-you" }), chat(2, { status: "needs-you" })]), [
    "Chat 1 finished its reply.",
    "Chat 2 finished its reply.",
  ]);
  assert.deepEqual(h.next([chat(1), chat(2)]), [], "each watch ends with its line");
  h.watch(sid(3), true);
  assert.deepEqual(h.next([chat(1)]), [], "a watched chat HQ no longer shows is dropped");
});
