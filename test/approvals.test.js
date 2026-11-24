// The approvals chooser's data (lib/approvals.js): four presets, the saved choice, the lists an approve window uses
// for each, the fallback to the app's own approval-levels.json without the system pack, and the never-auto floor.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApprovals, PRESETS } = require("../lib/approvals");
const { levelOf } = require("../lib/levels");

const APP_LEVELS = path.join(__dirname, "..", "approval-levels.json"); // the shipped list, read only
const SYSTEM = path.join(__dirname, "fixtures", "system"); // a system pack with three of the four preset files
const roots = [];
test.after(async () => {
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
function state() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hq-approvals-"));
  roots.push(d);
  return d;
}
const bash = (command) => ({ toolName: "Bash", toolInput: { command } });
const edit = { toolName: "Edit", toolInput: { file_path: "src/a.ts", old_string: "a", new_string: "b" } };

test("four presets in order, friendly words, routine coding work recommended", () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ["ask-all", "safe-reads", "routine", "routine-judge"]);
  assert.deepEqual(PRESETS.map((p) => p.title), ["Ask me everything", "Approve safe reads", "Approve routine coding work", "Routine plus an AI judge for the rest"]);
  assert.deepEqual(PRESETS.filter((p) => p.recommended).map((p) => p.id), ["routine"]);
  for (const p of PRESETS) assert.ok(p.line.length > 20 && p.line.length < 200 && ![8211, 8212].some((c) => p.line.includes(String.fromCharCode(c))), p.id);
});

test("first run: no choice saved, the page is told so, and the window uses the app's own list", () => {
  const a = createApprovals({ stateDir: state(), systemDir: SYSTEM, levelsFile: APP_LEVELS });
  assert.equal(a.chosen(), null);
  const v = a.view();
  assert.equal(v.chosen, null);
  assert.deepEqual(v.presets.map((p) => [p.id, p.installed, p.recommended]), [["ask-all", true, false], ["safe-reads", false, false], ["routine", true, true], ["routine-judge", true, false]]);
  assert.match(v.neverAuto, /Deletes, force pushes, hard resets/);
  const c = a.current();
  assert.deepEqual([c.preset, c.fromSystem, c.judge], [null, false, false]);
  assert.equal(levelOf(c.levels, bash("git status")), "routine");
  assert.equal(levelOf(c.levels, edit), "judge");
});

test("a choice is saved in the state folder by id only, survives a restart, and an unknown id is refused, writing nothing", () => {
  const dir = state();
  const a = createApprovals({ stateDir: dir, systemDir: SYSTEM, levelsFile: APP_LEVELS });
  for (const bad of [null, {}, { preset: "everything" }, { preset: 3 }, { preset: "__proto__" }, { routine: { tools: ["Bash"] } }]) {
    assert.equal(a.choose(bad).ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(a.choose({ preset: "routine" }, 1700000000000), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "approvals-choice.json"), "utf8")), { v: 1, preset: "routine", at: 1700000000000 });
  assert.equal(createApprovals({ stateDir: dir, systemDir: SYSTEM, levelsFile: APP_LEVELS }).chosen(), "routine");
  assert.deepEqual(fs.readdirSync(dir), ["approvals-choice.json"], "no temp file is left");
  fs.writeFileSync(path.join(dir, "approvals-choice.json"), JSON.stringify({ v: 1, preset: "yolo" }));
  assert.equal(a.chosen(), null, "a file VibeQuarters did not write reads as no choice");
});

test("routine coding work approves edits and tests in a window; the never-auto list still leaves deletes and force pushes for the user", () => {
  const a = createApprovals({ stateDir: state(), systemDir: SYSTEM, levelsFile: APP_LEVELS });
  a.choose({ preset: "routine" });
  const c = a.current();
  assert.deepEqual([c.preset, c.fromSystem, c.judge], ["routine", true, false]);
  assert.equal(levelOf(c.levels, edit), "routine");
  assert.equal(levelOf(c.levels, bash("npm test")), "routine");
  // the fixture's own never-auto words, and the app's, both hold
  assert.equal(levelOf(c.levels, bash("npm publish")), "yours");
  assert.equal(levelOf(c.levels, bash("git push --force")), "yours");
  assert.equal(levelOf(c.levels, bash("git reset --hard HEAD~1")), "yours");
  assert.equal(levelOf(c.levels, bash("vercel deploy --prod")), "yours");
});

test("a preset whose never-auto list is empty cannot lower the floor: the app's own list is joined in", () => {
  const a = createApprovals({ stateDir: state(), systemDir: SYSTEM, levelsFile: APP_LEVELS });
  a.choose({ preset: "ask-all" });
  const c = a.current();
  const app = JSON.parse(fs.readFileSync(APP_LEVELS, "utf8"));
  for (const w of app.yours.words) assert.ok(c.levels.yours.words.includes(w), w);
  assert.deepEqual(c.levels.routine, { tools: [], commands: [], hooks: [] });
  assert.equal(levelOf(c.levels, bash("git status")), "judge", "ask everything: even a read waits");
  assert.equal(levelOf(c.levels, bash("rm -rf build")), "yours");
});

test("routine plus the judge turns the judge on, only when its preset file is there", () => {
  const a = createApprovals({ stateDir: state(), systemDir: SYSTEM, levelsFile: APP_LEVELS });
  a.choose({ preset: "routine-judge" });
  assert.equal(a.current().judge, true);
  const none = createApprovals({ stateDir: state(), systemDir: path.join(state(), "no-system"), levelsFile: APP_LEVELS });
  none.choose({ preset: "routine-judge" });
  assert.deepEqual([none.current().judge, none.current().fromSystem], [false, false]);
});

test("without the system pack (or with a preset file it cannot read) every choice falls back to the app's own list", () => {
  const sys = state();
  const presets = path.join(sys, "presets", "approvals");
  fs.mkdirSync(presets, { recursive: true });
  fs.writeFileSync(path.join(presets, "routine.json"), JSON.stringify({ routine: { tools: "Edit" } })); // not a list
  for (const systemDir of [path.join(sys, "missing"), sys, null]) {
    const a = createApprovals({ stateDir: state(), systemDir, levelsFile: APP_LEVELS });
    a.choose({ preset: "routine" });
    const c = a.current();
    assert.deepEqual([c.preset, c.fromSystem], ["routine", false], String(systemDir));
    assert.equal(levelOf(c.levels, edit), "judge", "an edit is not approved by the fallback");
    assert.equal(levelOf(c.levels, bash("git status")), "routine");
    assert.ok(a.view().presets.every((p) => !p.installed));
    a.choose({ preset: "ask-all" }); // asked for nothing: the built-in list is not used either
    assert.notEqual(levelOf(a.current().levels, bash("git status")), "routine");
    assert.equal(levelOf(a.current().levels, bash("rm -rf build")), "yours");
  }
  // the app's own list unreadable: no levels at all, so everything is the user's
  const a = createApprovals({ stateDir: state(), systemDir: SYSTEM, levelsFile: path.join(sys, "nope.json") });
  a.choose({ preset: "routine" });
  assert.equal(a.current().levels, null);
  assert.equal(levelOf(a.current().levels, edit), "yours");
});
