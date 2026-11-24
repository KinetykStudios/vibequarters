// The Queue panel's words (public/queue.js): plain sentences for the gate and the locks.
import test from "node:test";
import assert from "node:assert/strict";
import { age, gateLines, lockLine, staleNote, requestFlag, batchWords, LIVE_NOTE } from "../public/queue.js";

const now = 1_800_000_000_000;
const min = 60e3;

test("ages read as minutes, hours and days", () => {
  assert.equal(age(20e3), "under a minute");
  assert.equal(age(3 * min), "3 min");
  assert.equal(age(65 * min), "1 h 5 min");
  assert.equal(age(120 * min), "2 h");
  assert.equal(age(72 * 3600e3), "3 days");
});

test("the gate in plain words", () => {
  const base = { cpu: 80, startMax: 75, others: 0, waiting: [] };
  assert.equal(gateLines({ ...base, state: "cpu", waiting: [{ session: "a", at: now }] }, now).head, "Waiting for the PC (CPU 80%)");
  assert.equal(gateLines({ ...base, state: "cpu" }, now).head, "PC is busy (CPU 80%): a new heavy job would wait");
  const busy = gateLines({ ...base, state: "busy", holder: { job: "Running tests", session: "webapp-23", since: now - 3 * min, background: true, starting: false }, waiting: [{ session: "webapp-24", at: now - 2 * min }] }, now);
  assert.equal(busy.head, "Busy: Running tests for webapp-23, 3 min (in the background)");
  assert.equal(busy.sub, "PC load 80%.");
  assert.equal(busy.wait, "Waiting: webapp-24 (2 min)");
  assert.equal(gateLines({ ...base, cpu: 12, state: "free" }, now).wait, "Nobody is waiting.");
  assert.equal(gateLines({ ...base, cpu: null, state: "measuring" }, now).head, "Checking the PC load");
});

test("the gate says plainly when it cannot check which heavy jobs still run: no system pack, or not on this OS", () => {
  const base = { cpu: 12, startMax: 75, others: 0, waiting: [], state: "free" };
  assert.equal(gateLines({ ...base, liveCheck: "on" }, now).note, null);
  assert.equal(gateLines({ ...base, liveCheck: "unavailable" }, now).note, LIVE_NOTE.unavailable);
  assert.match(LIVE_NOTE.unavailable, /not available on this OS/);
  assert.match(LIVE_NOTE["no-hooks"], /system pack is not installed/);
});

test("requests: flagged after 15 min, or at once when the owner has closed", () => {
  assert.equal(requestFlag({ overdue: false, ownerClosed: false }), "");
  assert.match(requestFlag({ overdue: true, ownerClosed: false }), /Over 15 min/);
  assert.match(requestFlag({ overdue: false, ownerClosed: true }), /owner has closed/);
});

test("locks in plain words", () => {
  assert.equal(lockLine({ name: "merge", words: "Merging", holder: "webapp-24", since: now - 3 * min, stale: false }, now), "Merging: webapp-24, 3 min");
  assert.equal(lockLine({ name: "merge", words: "Merging", holder: null }, now), "No merge running");
  assert.match(lockLine({ name: "prod-deploy", words: "Deploying the live site", holder: "x", since: now - 25 * min, stale: true }, now), /no longer blocks/);
});

test("a batch's headline: landing progress, then a rebuild, then its checks", () => {
  assert.equal(batchWords({ landing: { merged: 2, total: 3, partial: false }, rebuild: null, ci: "passed" }), "landing, 2 of 3 merged or closed");
  assert.equal(batchWords({ landing: { merged: 1, total: 3, partial: true }, ci: "passed" }), "stopped partway, 1 of 3 merged or closed; check what the merge tool said before anything else lands");
  assert.match(batchWords({ landing: { merged: 1, total: 3, partial: false, moved: true }, ci: "passed" }), /cannot land as planned/);
  assert.equal(batchWords({ landing: null, rebuild: "nothing", ci: "passed" }), "needs a rebuild before it can land (it stopped before any PR landed)");
  assert.equal(batchWords({ landing: null, rebuild: "main", ci: "passed" }), "needs a rebuild before it can land (the main branch has moved on)");
  assert.equal(batchWords({ landing: null, rebuild: null, ci: "passed" }), "checks passed");
});

test("a failed refresh says how old the view on screen is", () => {
  assert.equal(staleNote(now - 3 * min, now), "Could not refresh; showing the queue from 3 min ago");
});

test("no em or en dashes in what the panel says", async () => {
  const fs = await import("node:fs");
  for (const f of ["public/queue.js", "lib/queue.js"]) assert.ok(![8211, 8212].some((c) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8").includes(String.fromCharCode(c))), f);
});
