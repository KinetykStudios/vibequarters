// lib/askmark.js: HQ reads the mark a safety hook leaves when it asks (the system pack), so HQ knows the prompt came
// from a hook and never answers it for the owner in bulk or in a window.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { askKey, takeMark } = require("../lib/askmark");

const NOW = Date.parse("2025-02-07T12:00:00.000Z");
const homes = [];
test.after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });
function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "hq-askmark-"));
  homes.push(h);
  return h;
}
const dirOf = (h) => path.join(h, ".claude", "hq-feed", "hook-asks");
function put(h, key, mark, mtime) {
  fs.mkdirSync(dirOf(h), { recursive: true });
  const fp = path.join(dirOf(h), key + ".json");
  fs.writeFileSync(fp, typeof mark === "string" ? mark : JSON.stringify(mark));
  if (mtime) fs.utimesSync(fp, mtime / 1000, mtime / 1000);
  return fp;
}
const INPUT = { file_path: "a.txt", content: "x" };

test("askKey equals the hook's: the shared vector, and key order at every depth does not count", () => {
  assert.equal(askKey("s1", "Write", INPUT), "63645b6dd5c280ad5045daf7be2ac7ad9125d5c0952531dded6af6cb9cdf0385");
  assert.equal(askKey("s1", "Bash", { o: { x: 1, y: [{ p: 1, q: 2 }] } }), askKey("s1", "Bash", { o: { y: [{ q: 2, p: 1 }], x: 1 } }));
});

test("takeMark returns a fresh mark once and deletes it", () => {
  const h = home();
  const fp = put(h, askKey("s1", "Write", INPUT), { v: 1, hook: "guard-config.js", reason: "a quality-gate config", at: NOW - 60e3 });
  assert.deepEqual(takeMark(h, "s1", "Write", INPUT, NOW), { hook: "guard-config.js", reason: "a quality-gate config" });
  assert.equal(fs.existsSync(fp), false);
  assert.equal(takeMark(h, "s1", "Write", INPUT, NOW), null);
});

test("takeMark ignores and deletes an 11-minute-old mark", () => {
  const h = home();
  const fp = put(h, askKey("s1", "Write", INPUT), { v: 1, hook: "guard-config.js", reason: "r", at: NOW - 11 * 60e3 });
  assert.equal(takeMark(h, "s1", "Write", INPUT, NOW), null);
  assert.equal(fs.existsSync(fp), false);
});

test("takeMark finds nothing for another session, tool or input, and nothing with no folder", () => {
  const h = home();
  assert.equal(takeMark(h, "s1", "Write", INPUT, NOW), null);
  put(h, askKey("s1", "Write", INPUT), { v: 1, hook: "guard-config.js", reason: "r", at: NOW });
  assert.equal(takeMark(h, "s2", "Write", INPUT, NOW), null);
  assert.equal(takeMark(h, "s1", "Edit", INPUT, NOW), null);
  assert.equal(takeMark(h, "s1", "Write", { ...INPUT, content: "y" }, NOW), null);
});

test("a mark of the wrong shape still says a hook asked, cut to the request's limits; one that is not JSON is dropped", () => {
  const h = home();
  put(h, askKey("s1", "Write", INPUT), { v: 1, hook: "h".repeat(100), reason: 7, at: NOW });
  assert.deepEqual(takeMark(h, "s1", "Write", INPUT, NOW), { hook: "h".repeat(64), reason: "" });
  put(h, askKey("s1", "Write", INPUT), { v: 1, hook: "guard-bash.js", reason: "r".repeat(400), at: NOW });
  assert.equal(takeMark(h, "s1", "Write", INPUT, NOW).reason, "r".repeat(300));
  const fp = put(h, askKey("s1", "Write", INPUT), "not json");
  assert.equal(takeMark(h, "s1", "Write", INPUT, NOW), null);
  assert.equal(fs.existsSync(fp), false);
});

test("takeMark sweeps other marks left over 10 minutes, and keeps fresh ones", () => {
  const h = home();
  const old = put(h, "a".repeat(64), { v: 1, hook: "guard-bash.js", reason: "r", at: NOW - 20 * 60e3 }, NOW - 20 * 60e3);
  const fresh = put(h, "b".repeat(64), { v: 1, hook: "guard-bash.js", reason: "r", at: NOW }, NOW);
  takeMark(h, "s1", "Write", INPUT, NOW);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});
