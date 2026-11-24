// The 30-second reminder (lib/remind.js): one short line for an approval that has waited 30 seconds and that HQ will not
// approve itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createReminder } = require("../lib/remind");

const T0 = Date.UTC(2025, 0, 6, 12, 0, 0);
const S = 1000;
const P = (id, askedAt, extra = {}) => ({ id, kind: "permission", askedAt, ...extra });
const never = () => false;

test("says once when an approval has waited 30 seconds, never before", () => {
  const r = createReminder();
  const items = [P("a", T0)];
  assert.equal(r.next(items, never, T0 + 29 * S), null);
  assert.equal(r.next(items, never, T0 + 30 * S), "You have something to approve.");
  assert.equal(r.next(items, never, T0 + 34 * S), null, "once per item");
  assert.equal(r.next(items, never, T0 + 300 * S), null);
});

test("several due at once are said as one line with their count", () => {
  const r = createReminder();
  assert.equal(r.next([P("a", T0), P("b", T0 + S), P("c", T0 + 20 * S)], never, T0 + 31 * S), "You have 2 things to approve.");
  assert.equal(r.next([P("a", T0), P("b", T0 + S), P("c", T0 + 20 * S)], never, T0 + 50 * S), "You have something to approve.", "the third when its turn comes");
});

test("an item HQ will approve itself, a question, a notice and a finished turn are never said", () => {
  const r = createReminder();
  const items = [P("auto", T0), { id: "q", kind: "question", askedAt: T0 }, P("n", T0, { notice: true }), { id: "r", kind: "reply", askedAt: T0 }];
  assert.equal(r.next(items, (d) => d.id === "auto", T0 + 60 * S), null);
});

test("an item a window stops covering is said once it is the owner's", () => {
  const r = createReminder();
  let covered = true;
  const items = [P("a", T0)];
  assert.equal(r.next(items, () => covered, T0 + 40 * S), null);
  covered = false;
  assert.equal(r.next(items, () => covered, T0 + 44 * S), "You have something to approve.");
});

test("an answered item is forgotten, and a new one is said again", () => {
  const r = createReminder();
  assert.equal(r.next([P("a", T0)], never, T0 + 30 * S), "You have something to approve.");
  assert.equal(r.next([], never, T0 + 35 * S), null);
  assert.equal(r.next([P("b", T0 + 40 * S)], never, T0 + 70 * S), "You have something to approve.");
});

test("a plan approval counts; an item with no time is skipped", () => {
  const r = createReminder();
  assert.equal(r.next([P("plan", T0, { toolName: "ExitPlanMode" }), { id: "x", kind: "permission" }], never, T0 + 30 * S), "You have something to approve.");
});
