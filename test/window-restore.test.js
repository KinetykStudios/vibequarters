// lib/window.js: an approve window survives an HQ restart, for no longer than it was opened for.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createWindow } = require("../lib/window");

const T0 = Date.parse("2025-02-12T12:00:00.000Z");
const MIN = 60e3;
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "win-")), "window.json");

test("a restart restores the window with the same end and count", () => {
  const file = tmp();
  const a = createWindow({ file, now: T0 });
  a.open({ minutes: 30, sessions: ["s1"] }, T0);
  a.note("deletes files");
  const b = createWindow({ file, now: T0 + 5 * MIN });
  const cur = b.current(T0 + 5 * MIN);
  assert.equal(cur.endsAt, T0 + 30 * MIN);
  assert.deepEqual(cur.sessions, ["s1"]);
  assert.equal(cur.approved, 1);
});

test("a 5 hour window survives a restart 4 hours in", () => {
  const file = tmp();
  createWindow({ file, now: T0 }).open({ minutes: 300 }, T0);
  const b = createWindow({ file, now: T0 + 240 * MIN });
  assert.equal(b.current(T0 + 240 * MIN).endsAt, T0 + 300 * MIN);
});

test("an expired saved window opens nothing and is cleared", () => {
  const file = tmp();
  createWindow({ file, now: T0 }).open({ minutes: 10 }, T0);
  const b = createWindow({ file, now: T0 + 11 * MIN });
  assert.equal(b.current(T0 + 11 * MIN), null);
  assert.equal(fs.existsSync(file), false);
});

test("a saved file that is not JSON opens no window and raises no error", () => {
  const file = tmp();
  fs.writeFileSync(file, "{not json");
  assert.equal(createWindow({ file, now: T0 }).current(T0), null);
});

test("a saved window that runs past the limit is refused", () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ id: "x", openedAt: T0, endsAt: T0 + 301 * MIN, sessions: null, approved: 0, tally: {} }));
  assert.equal(createWindow({ file, now: T0 }).current(T0), null);
});

test("a saved window with the wrong shape is refused", () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ id: "x", openedAt: T0, endsAt: T0 + MIN, sessions: "everyone", approved: 0, tally: {} }));
  assert.equal(createWindow({ file, now: T0 }).current(T0), null);
});

test("closing the window clears the file", () => {
  const file = tmp();
  const a = createWindow({ file, now: T0 });
  a.open({ minutes: 10 }, T0);
  assert.equal(fs.existsSync(file), true);
  a.close("off", T0 + MIN);
  assert.equal(fs.existsSync(file), false);
});

test("a window turned off stays off even when the file cannot be removed", () => {
  const file = tmp();
  const a = createWindow({ file, now: T0, rm: () => { throw new Error("locked"); } });
  a.open({ minutes: 30 }, T0);
  a.close("off", T0 + MIN);
  assert.equal(createWindow({ file, now: T0 + 2 * MIN }).current(T0 + 2 * MIN), null);
});

test("a window turned off stays off even when the file can be neither emptied nor removed", () => {
  const file = tmp();
  const a = createWindow({ file, now: T0, rm: () => { throw new Error("locked"); } });
  a.open({ minutes: 30 }, T0);
  fs.chmodSync(file, 0o444);
  a.close("off", T0 + MIN);
  fs.chmodSync(file, 0o666);
  assert.ok(fs.readFileSync(file, "utf8").length > 0, "the file really was left full");
  assert.equal(createWindow({ file, now: T0 + 2 * MIN }).current(T0 + 2 * MIN), null);
});

test("a window opened after a stuck one still survives a restart", () => {
  const file = tmp();
  const a = createWindow({ file, now: T0, rm: () => { throw new Error("locked"); } });
  a.open({ minutes: 30 }, T0);
  fs.chmodSync(file, 0o444);
  a.close("off", T0 + MIN);
  fs.chmodSync(file, 0o666);
  a.open({ minutes: 30 }, T0 + 2 * MIN);
  assert.equal(createWindow({ file, now: T0 + 3 * MIN }).current(T0 + 3 * MIN).endsAt, T0 + 32 * MIN);
});

test("the 300 minute limit still holds with a file", () => {
  const a = createWindow({ file: tmp(), now: T0 });
  assert.equal(a.open({ minutes: 301 }, T0).ok, false);
});

test("a missing folder for the file is created", () => {
  const file = path.join(path.dirname(tmp()), "not-yet", "window.json");
  createWindow({ file, now: T0 }).open({ minutes: 10 }, T0);
  assert.equal(fs.existsSync(file), true);
});

test("without a file nothing is written", () => {
  const a = createWindow();
  assert.equal(a.open({ minutes: 5 }, T0).ok, true);
});
