// The accounts strip's words (public/accounts.js): soonest reset first, the user's labels, signed-in and next marked;
// and the plan meter's words.
import test from "node:test";
import assert from "node:assert/strict";
import { accountsLine, planText } from "../public/accounts.js";

const TZ = "UTC";
const view = {
  rows: [
    { label: "Personal", resetsAt: Date.parse("2025-01-23T10:00:00.000Z"), lastSeenPct: null, seenAt: null, current: false, next: false },
    { label: "Account 1", resetsAt: Date.parse("2025-01-17T10:00:00.000Z"), lastSeenPct: 12, seenAt: "2025-01-13T12:00:00.000Z", current: false, next: true },
    { label: "Work", resetsAt: Date.parse("2025-01-20T10:30:00.000Z"), lastSeenPct: 82, seenAt: "2025-01-15T12:00:00.000Z", current: true, next: false },
  ],
};

test("soonest reset first, weekday and hour, minutes only when not on the hour", () => {
  const parts = accountsLine(view, TZ);
  assert.deepEqual(parts.map((p) => p.text), ["next Account 1 Fri 10am", "Work Mon 10:30am", "Personal Thu 10am"]);
  assert.deepEqual(parts.map((p) => [p.current, p.next]), [[false, true], [true, false], [false, false]]);
});

test("the tooltip carries the label, the last % seen and the exact reset", () => {
  const [first, work, personal] = accountsLine(view, TZ);
  assert.equal(first.tip, "Account 1, the next to reset. Last seen 12% used on Jan 13. Weekly limit resets Fri, Jan 17, 10:00 AM.");
  assert.match(work.tip, /^Work, signed in now\. Last seen 82% used/);
  assert.match(personal.tip, /Last % not seen yet: use it once and it records itself\./);
});

test("no view, or no rows, gives nothing to show; an unknown reset reads ?", () => {
  assert.deepEqual(accountsLine(null, TZ), []);
  assert.deepEqual(accountsLine({ rows: [] }, TZ), []);
  assert.equal(accountsLine({ rows: [{ label: "Work", resetsAt: null, current: false, next: false }] }, TZ)[0].text, "Work ?");
});

test("the plan meter reads the weekly figure, with the 5-hour window when the mod reports it", () => {
  assert.equal(planText(null), null);
  assert.equal(planText({ pct: null }), null);
  assert.deepEqual(planText({ pct: 62, fiveHour: null }), { short: "Plan 62%", long: " this week" });
  assert.deepEqual(planText({ pct: 62, fiveHour: 18 }), { short: "Plan 62%", long: " this week · 5h 18%" });
});
