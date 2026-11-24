// The payload's floor carries each figure's screen, from that figure's own transcript: a live session's, a
// helper's (a running subagent no roster figure shows) and a roster figure's at work (its matched session's, else its
// job's). A roster figure with no running job has none and keeps its heartbeat task.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHq } = require("../lib/hq");
const { at, asst, tool, jsonl } = require("./helpers");
const { SCREEN } = require("../lib/session");
const { barLine } = require("../lib/describe");

const A = "aaaaaaaa-0000-0000-0000-00000000000a", B = "bbbbbbbb-0000-0000-0000-00000000000b";
const NOW = Date.parse(at(120));
const roots = [];
test.after(async () => {
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const result = (sec, id, content, sidechain = false) => ({ type: "user", timestamp: at(sec), isSidechain: sidechain, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });
const call = (sec, name, input, sidechain = false) => { const b = tool(name, input); return { b, row: asst({ sec, sidechain, content: [b] }) }; };

// alpha runs a shell command that names a key; its helper searches the web; its general-purpose subagent (the Builder's
// job) reads a file; beta, matched by name to the Planner, edits a file.
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hq-screen-"));
  roots.push(root);
  const proj = path.join(root, "projects", "p1");
  fs.mkdirSync(path.join(proj, A, "subagents"), { recursive: true });
  const sh = call(100, "Bash", { command: "export TOKEN=sk-live-123 && npm test", description: "Run the tests" });
  fs.writeFileSync(path.join(proj, A + ".jsonl"), jsonl([{ type: "ai-title", aiTitle: "alpha", sessionId: A }, asst({ sec: 0, content: [tool("Read", { file_path: "C:/work/a.js" })] }), sh.row, result(101, sh.b.id, "PASS cart\nTOKEN=sk-live-123\nTests: 4 passed")]));
  const web = call(110, "WebSearch", { query: "vitest timers" }, true);
  fs.writeFileSync(path.join(proj, A, "subagents", "agent-h1.jsonl"), jsonl([web.row]));
  fs.writeFileSync(path.join(proj, A, "subagents", "agent-h1.meta.json"), JSON.stringify({ agentType: "fixture-helper", description: "Look up timers" }));
  const rd = call(111, "Read", { file_path: "C:/work/shop/src/cart.ts" }, true);
  fs.writeFileSync(path.join(proj, A, "subagents", "agent-g1.jsonl"), jsonl([rd.row]));
  fs.writeFileSync(path.join(proj, A, "subagents", "agent-g1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Read the cart" }));
  fs.writeFileSync(path.join(proj, B + ".jsonl"), jsonl([{ type: "ai-title", aiTitle: "smoke-docs-beta", sessionId: B }, call(112, "Edit", { file_path: "C:/work/site/header.tsx", old_string: "Hi", new_string: "Hello" }).row]));
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "hq.config.example.json"), "utf8"));
  config.agents.find((a) => a.id === "planner").sessions = ["smoke-docs-*"];
  const sub = (id) => ({ fp: path.join(proj, A, "subagents", `agent-${id}.jsonl`), sessionId: A, mtimeMs: NOW - 5e3 });
  const index = {
    mains: [A, B].map((id) => ({ fp: path.join(proj, id + ".jsonl"), sessionId: id, mtimeMs: NOW - 5e3, project: "p1" })),
    subMtime: { [A]: NOW - 5e3 },
    subs: [sub("h1"), sub("g1")],
  };
  return { hq: createHq({ config }), index };
}

test("each live session, helper and roster figure at work carries its own screen; an idle roster figure none", async () => {
  const { hq, index } = world();
  await hq.update(index, null, NOW);
  const f = hq.payload().floor;
  const alpha = f.sessions.find((x) => x.name === "alpha");
  assert.equal(alpha.screen.kind, "shell");
  // a line naming a token is hidden whole, a bar its length; and a command that names one hides its whole
  // output
  assert.equal(alpha.screen.head, barLine(0, "export TOKEN=sk-live-123 && npm test".length));
  assert.deepEqual(alpha.screen.lines, ["PASS cart", "TOKEN=sk-live-123", "Tests: 4 passed"].map((l) => barLine(0, l.length)));
  assert.deepEqual(alpha.screen.steps.map((s) => s.label), ["Run the tests", "Reading a.js"], "the left screen's steps, newest first");
  assert.deepEqual(alpha.screen.files, [{ name: "a.js", edit: false }]);
  assert.equal(f.helpers.length, 1);
  assert.equal(f.helpers[0].screen.kind, "web", "a helper's screen is from its own file");
  assert.equal(f.helpers[0].screen.head, "vitest timers");
  const builder = f.agents.find((a) => a.id === "builder"), planner = f.agents.find((a) => a.id === "planner");
  assert.equal(builder.working, true);
  assert.deepEqual([builder.screen.kind, builder.screen.head], ["read", "cart.ts"], "a roster figure on a job shows the job's screen");
  assert.equal(planner.source, "session");
  assert.deepEqual([planner.screen.kind, planner.screen.head, planner.screen.lines], ["edit", "header.tsx", ["-Hi", "+Hello"]], "a roster figure on its matched session shows that session's");
  assert.ok(!f.sessions.some((x) => x.name === "smoke-docs-beta"), "the matched session takes no live seat");
  for (const a of f.agents.filter((a) => !a.working)) assert.equal(a.screen, undefined, a.id);
  // the decisions pass keeps every screen
  assert.ok(hq.json().includes('"kind":"shell"') && hq.json().includes('"kind":"web"'));
});

test("the payload never carries the key a command or its output names, and every screen is at most 4 KB", async () => {
  const { hq, index } = world();
  await hq.update(index, null, NOW);
  assert.ok(!hq.json().includes("sk-live-123"));
  const f = hq.payload().floor;
  for (const x of [...f.sessions, ...f.helpers, ...f.agents]) if (x.screen) assert.ok(Buffer.byteLength(JSON.stringify(x.screen)) <= SCREEN.bytes, x.id || x.name);
});

test("a session HQ has read no step of yet has a null screen", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hq-screen-"));
  roots.push(root);
  const fp = path.join(root, A + ".jsonl");
  fs.writeFileSync(fp, jsonl([{ type: "user", timestamp: at(100), message: { role: "user", content: "go" } }]));
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "hq.config.example.json"), "utf8"));
  const hq = createHq({ config });
  await hq.update({ mains: [{ fp, sessionId: A, mtimeMs: NOW, project: "p1" }], subMtime: {}, subs: [] }, null, NOW);
  assert.equal(hq.payload().floor.sessions[0].screen, null);
});
