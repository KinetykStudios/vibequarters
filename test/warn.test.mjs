// The warning colors' rule (public/warn.js): amber from each first line, red from each second, and nothing below.
import test from "node:test";
import assert from "node:assert/strict";
import { ctxWarn, cacheWarn, stuckWarn, warningsOf, planWarn } from "../public/warn.js";

const now = 1_800_000_000_000;
const lvl = (w) => (w ? w.level : null);

test("context: nothing under 75 percent, amber from 75 (compact), red from 90 (hand off), nothing when unknown", () => {
  const at = (pct) => lvl(ctxWarn({ context: { pct } }));
  assert.deepEqual([at(0), at(74), at(75), at(89), at(90), at(100)], [null, null, "warn", "warn", "bad", "bad"]);
  assert.equal(ctxWarn({ context: null }), null);
  assert.equal(ctxWarn(null), null);
  assert.equal(ctxWarn({ context: { pct: 78 } }).short, "context 78%, compact");
  assert.match(ctxWarn({ context: { pct: 78 } }).tip, /^Amber: context is 78% full\. Time to compact/);
  assert.equal(ctxWarn({ context: { pct: 91 } }).short, "context 91%, hand off");
  assert.match(ctxWarn({ context: { pct: 91 } }).tip, /^Red: context is 91% full\. Time to hand off to a fresh chat/);
});

test("cache: a warm cache is amber in its last 10 minutes and red in its last 2; a cold one is never warned (it already shows its wake cost)", () => {
  const left = (ms, state = "warm") => lvl(cacheWarn({ cache: { state, expiresAt: now + ms, wakeCost: 1.25 } }, now));
  assert.deepEqual([left(30 * 60e3), left(10 * 60e3 + 1000), left(10 * 60e3), left(2 * 60e3 + 1000), left(2 * 60e3), left(0)], [null, null, "warn", "warn", "bad", "bad"]);
  assert.equal(left(60e3, "cold"), null);
  const w = cacheWarn({ cache: { state: "warm", expiresAt: now + 5 * 60e3, wakeCost: 1.25 } }, now);
  assert.equal(w.short, "cache 5m left");
  assert.match(w.tip, /\$1\.25 to rebuild it/);
});

test("stuck: working with no new step for 10 minutes is amber, 20 is red; waiting on a helper, thinking or needing you is never stuck", () => {
  const quiet = (ms, extra = {}) => lvl(stuckWarn({ status: "working", waitsOn: null, lastAt: now - ms, ...extra }, now));
  assert.deepEqual([quiet(9 * 60e3), quiet(10 * 60e3), quiet(19 * 60e3), quiet(20 * 60e3)], [null, "warn", "warn", "bad"]);
  assert.equal(quiet(25 * 60e3, { waitsOn: "subagent" }), null);
  assert.equal(quiet(25 * 60e3, { status: "needs-you" }), null);
  assert.equal(quiet(25 * 60e3, { lastAt: null }), null);
  assert.equal(stuckWarn({ status: "working", waitsOn: null, lastAt: now - 12 * 60e3 }, now).short, "no new step in 12m");
});

test("a session's warnings come worst first", () => {
  const s = { status: "working", waitsOn: null, lastAt: now - 25 * 60e3, context: { pct: 75 }, cache: { state: "warm", expiresAt: now + 60e3 } };
  assert.deepEqual(warningsOf(s, now).map((w) => [w.short.split(" ")[0], w.level]), [["cache", "bad"], ["no", "bad"], ["context", "warn"]]);
  assert.deepEqual(warningsOf({ status: "idle", context: { pct: 10 }, cache: null }, now), []);
});

test("plan: gray under 75 percent, amber from 75, red from 90; unknown or past its reset shows nothing", () => {
  const at = (pct) => planWarn({ pct, resetsAt: now + 1 }, now);
  assert.deepEqual([at(4), at(74), at(75), at(89), at(90)].map((p) => p.level), [null, null, "warn", "warn", "bad"]);
  assert.equal(at(4).pct, 4);
  assert.equal(planWarn({ pct: 50, resetsAt: now }, now), null);
  assert.equal(planWarn({ pct: null, resetsAt: now + 1 }, now), null);
  assert.equal(planWarn(null, now), null);
});
