// The agents-off list (lib/switches.js): what VibeQuarters writes when an agent is switched off, how it reads the file
// back, the resync that keeps the file's names and types those of the config, and whether the switch hook is registered.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createSwitches, createEnforcement } = require("../lib/switches");

const EXAMPLE = path.join(__dirname, "..", "hq.config.example.json");
const agents = () => JSON.parse(fs.readFileSync(EXAMPLE, "utf8")).agents; // never the user's edited copy
const NOW = Date.parse("2025-02-04T12:00:00.000Z");
const SCOUT = { id: "scout", name: "Scout", agentTypes: ["Explore"] };
const GUIDE = { id: "guide", name: "Guide", agentTypes: ["claude-code-guide", "statusline-setup"] };
const OFF = { id: "scout", on: false };
// Every folder a test makes, removed once this file's tests end, and nothing else.
const roots = [];
test.after(async () => {
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
function place() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-switches-"));
  roots.push(dir);
  return { dir, file: path.join(dir, "hq-feed", "agents-off.json") };
}
const plant = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === "string" ? text : JSON.stringify(text));
};
const onDisk = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("a missing file reads as every agent on, and nothing is written until a switch flips", () => {
  const { file } = place();
  const sw = createSwitches({ file, agents: agents() });
  assert.deepEqual([...sw.offIds()], []);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(sw.set(OFF, NOW), { ok: true });
  assert.equal(fs.existsSync(file), true);
});

test("switching one agent off writes version 1, the time, and its id, name and agent types from the config; on again empties the list", () => {
  const { file } = place();
  const sw = createSwitches({ file, agents: agents() });
  assert.deepEqual(sw.set(OFF, NOW), { ok: true });
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.endsWith("}\n") && text.indexOf("\n") === text.length - 1, "one JSON line and a newline");
  const f = JSON.parse(text);
  assert.equal(f.v, 1);
  assert.equal(f.at, NOW);
  assert.deepEqual(f.off, [SCOUT]);
  assert.ok(sw.offIds().has("scout"));
  assert.deepEqual(sw.set({ id: "scout", on: true }, NOW + 1), { ok: true });
  assert.deepEqual([onDisk(file).at, onDisk(file).off], [NOW + 1, []]);
  assert.deepEqual([...sw.offIds()], []);
  const bare = place(); // an agent the config gives no types writes an empty list
  createSwitches({ file: bare.file, agents: [{ id: "x", name: "X" }] }).set({ id: "x", on: false }, NOW);
  assert.deepEqual(onDisk(bare.file).off, [{ id: "x", name: "X", agentTypes: [] }]);
});

test("all off lists every agent in config order; all on lists none", () => {
  const { file } = place();
  const sw = createSwitches({ file, agents: agents() });
  const ids = agents().map((a) => a.id);
  assert.equal(ids.length, 4);
  sw.set({ id: "guide", on: false }, NOW); // switched first, still listed in its config place
  assert.deepEqual(sw.set({ all: true, on: false }, NOW), { ok: true });
  assert.deepEqual(onDisk(file).off.map((a) => a.id), ids);
  assert.deepEqual([...sw.offIds()].sort(), [...ids].sort());
  assert.deepEqual(sw.set({ all: true, on: true }, NOW), { ok: true });
  assert.deepEqual(onDisk(file).off, []);
  assert.equal(sw.offIds().size, 0);
});

test("an unknown id, a missing on, or neither id nor all is refused and writes nothing", () => {
  const { file } = place();
  const sw = createSwitches({ file, agents: agents() });
  const SHAPE = "id or all, and on true or false";
  const refused = [
    [{ id: "nobody", on: false }, "no such agent"],
    [{ id: "scout" }, SHAPE],
    [{ id: "scout", on: "false" }, SHAPE],
    [{ all: true }, SHAPE],
    [{ on: false }, SHAPE],
    [{ all: "true", on: false }, SHAPE],
    [{ id: 7, on: false }, SHAPE],
    [null, SHAPE],
    ["scout", SHAPE],
  ];
  for (const [body, error] of refused) assert.deepEqual(sw.set(body, NOW), { ok: false, error }, JSON.stringify(body));
  assert.equal(fs.existsSync(file), false);
  assert.equal(sw.offIds().size, 0);
});

test("a file that is not JSON, another version, too big, or with no list reads as every agent on", () => {
  const pad = (n) => {
    const s = JSON.stringify({ v: 1, at: 1, off: [SCOUT], pad: "" });
    return JSON.stringify({ v: 1, at: 1, off: [SCOUT], pad: "x".repeat(n - s.length) });
  };
  assert.equal(Buffer.byteLength(pad(65537)), 65537);
  const bad = {
    "not JSON": '{ "v": 1, "off": [{ "id": "sco', "JSON null": "null", "an array": "[]", "another version": { v: 2, at: 1, off: [SCOUT] },
    "no version": { at: 1, off: [SCOUT] }, "no list": { v: 1, at: 1 }, "a list that is not one": { v: 1, at: 1, off: "scout" }, "too big": pad(65537),
  };
  for (const [what, text] of Object.entries(bad)) {
    const { file } = place();
    plant(file, text);
    const before = fs.readFileSync(file, "utf8");
    assert.equal(createSwitches({ file, agents: agents() }).offIds().size, 0, what);
    assert.equal(fs.readFileSync(file, "utf8"), before, what + ": read, never rewritten");
  }
  const folder = place(); // a folder where the file should be cannot be read
  fs.mkdirSync(folder.file, { recursive: true });
  assert.equal(createSwitches({ file: folder.file, agents: agents() }).offIds().size, 0, "a folder");
  const edge = place(); // exactly 64 KB is still read
  plant(edge.file, pad(65536));
  assert.deepEqual([...createSwitches({ file: edge.file, agents: agents() }).offIds()], ["scout"]);
});

test("an id the config no longer has is dropped, and an off agent's types follow the config, on resync", () => {
  const { file } = place();
  plant(file, { v: 1, at: 1, off: [{ id: "gone", name: "Gone", agentTypes: ["gone-*"] }, { id: "guide", name: "Guide", agentTypes: ["old-*"] }, "guide", null] });
  const sw = createSwitches({ file, agents: agents() });
  assert.deepEqual([...sw.offIds()], ["guide"]);
  assert.equal(sw.resync(NOW), true);
  assert.deepEqual(onDisk(file).off, [GUIDE]);
  assert.equal(onDisk(file).at, NOW);
  const text = fs.readFileSync(file, "utf8");
  assert.equal(sw.resync(NOW + 1), false);
  assert.equal(fs.readFileSync(file, "utf8"), text, "a file that matches is left as it is");
  const missing = place();
  assert.equal(createSwitches({ file: missing.file, agents: agents() }).resync(NOW), false);
  assert.equal(fs.existsSync(missing.file), false, "a missing file is never made by a resync");
});

test("a file that is there but cannot be read is rewritten on resync, every agent on", () => {
  const { file } = place();
  plant(file, "not JSON");
  const sw = createSwitches({ file, agents: agents() });
  assert.equal(sw.resync(NOW), true);
  assert.deepEqual(onDisk(file), { v: 1, at: NOW, off: [] });
});

test("a write that fails keeps the switches as they were and says so", () => {
  const { dir } = place();
  fs.writeFileSync(path.join(dir, "plain"), "a file, not a folder");
  const file = path.join(dir, "plain", "hq-feed", "agents-off.json"); // its folder cannot be made
  const sw = createSwitches({ file, agents: agents() });
  assert.deepEqual(sw.set(OFF, NOW), { ok: false, error: "could not save the switches" });
  assert.equal(sw.offIds().size, 0);
  const second = place(); // the folder is there, but a folder where the file should be cannot be replaced
  const sw2 = createSwitches({ file: second.file, agents: agents() });
  assert.deepEqual(sw2.set(OFF, NOW), { ok: true });
  fs.unlinkSync(second.file);
  fs.mkdirSync(second.file);
  assert.deepEqual(sw2.set({ id: "guide", on: false }, NOW), { ok: false, error: "could not save the switches" });
  assert.deepEqual([...sw2.offIds()], ["scout"]);
  assert.deepEqual(fs.readdirSync(path.dirname(second.file)), ["agents-off.json"], "its temp file is removed");
});

test("the file is replaced whole: no temp file is left beside it", () => {
  const { file } = place();
  const sw = createSwitches({ file, agents: agents() });
  sw.set(OFF, NOW);
  sw.set({ id: "guide", on: false }, NOW + 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["agents-off.json"]);
  assert.deepEqual(onDisk(file).off, [SCOUT, GUIDE]);
});

test("the switch hook counts as registered only when a PreToolUse entry in settings.json names hq-agent-switch", () => {
  const { dir } = place();
  const file = path.join(dir, "settings.json");
  const enforced = createEnforcement(file);
  assert.equal(enforced(), false, "no settings file");
  let n = 0;
  const write = (obj) => {
    fs.writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj));
    n += 10;
    fs.utimesSync(file, 1700000000 + n, 1700000000 + n); // a distinct mtime per write
  };
  write({ hooks: { PreToolUse: [{ matcher: "Agent|Task", hooks: [{ type: "command", command: "node", args: ["/home/user/.claude/vibequarters/hooks/hq-agent-switch.js"] }] }] } });
  assert.equal(enforced(), true, "node plus args, the installer's shape");
  write({ hooks: { PreToolUse: [{ matcher: "Agent", hooks: [{ type: "command", command: "node /opt/vibequarters/hooks/hq-agent-switch.js" }] }] } });
  assert.equal(enforced(), true, "a one-line command");
  write({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "node hq-agent-switch.js" }] }], PreToolUse: [{ hooks: [{ command: "node other.js" }] }] } });
  assert.equal(enforced(), false, "another event, or another hook, does not enforce it");
  write("{ not json");
  assert.equal(enforced(), false, "unreadable settings");
  write({ hooks: { PreToolUse: "x" } });
  assert.equal(enforced(), false, "a malformed hooks list");
});
