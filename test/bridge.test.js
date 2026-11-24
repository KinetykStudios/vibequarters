// The bridge: what it prints for each hook input, when it stays silent, how it waits, and how it stands down when the
// owner answers in VS Code first. Inputs are shaped like the hooks' real stdin.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const B = require("../bridge/hq-bridge");
const { riskOf } = require("../lib/describe");
const D = require("../lib/decisions");
const { askKey } = require("../lib/askmark");
const { at, asst, user, tool, text, jsonl } = require("./helpers");

const BRIDGE = path.join(__dirname, "..", "bridge", "hq-bridge.js");
const SID = "0a1b2c3d-0000-4000-8000-0000000000b1";
const DEAD = 2147483646; // no such process: process.kill(DEAD, 0) throws ESRCH
const fast = { tick: 50 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CALL = { command: "npm test", description: "Run the tests" };
const COLOR = { questions: [{ question: "Which color do you pick?", header: "Color", options: [{ label: "Red", description: "Pick red." }, { label: "Blue", description: "Pick blue." }], multiSelect: false }] };

// Every folder world() makes, removed once this file's tests end, and nothing else.
const roots = [];
test.after(async () => {
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
// HQ's side of the check, as server.js /api/verify answers it: the answers this file wrote as HQ, by id, and a
// server on a free local port that says whether it wrote exactly the answer the bridge asks about. `checks` keeps what
// every check sent. With verifyFails set, it answers every check with an error, as a server that cannot answer would.
const wrote = new Map();
const checks = [];
let HQ_PORT = 0;
let verifyFails = false;
const hqServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let a = null;
    try {
      a = JSON.parse(body);
    } catch {}
    checks.push({ method: req.method, url: req.url, origin: req.headers.origin, body: a });
    if (verifyFails) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end("{}");
    }
    const yes = req.method === "POST" && req.url === "/api/verify" && !!a && wrote.has(a.id) && wrote.get(a.id) === B.answerKey(a);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ wrote: yes }));
  });
});
test.before(() => new Promise((r) => hqServer.listen(0, "127.0.0.1", () => r((HQ_PORT = hqServer.address().port)))));
test.after(() => hqServer.close());
// The lookup of the process on HQ's port, as test/fake-lookup.cjs answers it here. On HQ_PORT it finds the pid the
// lookup names running node with the server.js beside the bridge and the settings file of the newest world(), whose
// state folder is that world's: the real HQ as the bridge must find it. On any other port, that pid running another
// script. The tests in this file run one at a time, and each acts on one world at a time.
const L = require("./fake-lookup.cjs");
const FAKE = path.join(__dirname, "fake-lookup.cjs");
const SERVER = path.join(__dirname, "..", "server.js");
let hqSettings = null; // the newest world's settings file
const asHq = (pid, script = SERVER, settings = hqSettings) => JSON.stringify({ owners: [pid], exe: L.winNode, cmd: `"${L.winNode}" ${L.winPath(script)} --settings "${L.winPath(settings)}"` });
const lookup = (script) => {
  const port = Number((/-LocalPort (\d+) /.exec(script) || [])[1]);
  const pid = Number((/ProcessId=(\d+)'/.exec(script) || [])[1]);
  return asHq(pid, port === HQ_PORT ? SERVER : path.join(os.tmpdir(), "fake-hq.js"));
};
L.setLookup(lookup);
L.setPorts(() => [[HQ_PORT, process.pid]]);

// HQ's state folder (its port file and the page's presence file) and the asking chat's transcript.
function world({ control = true, pid = process.pid, focused = true, presenceAge = 0, rows = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hq-bridge-"));
  roots.push(root);
  const dir = path.join(root, "state");
  fs.mkdirSync(dir);
  // the settings file HQ runs with in the lookup, its state folder this one
  hqSettings = path.join(root, "hq.settings.json");
  fs.writeFileSync(hqSettings, JSON.stringify({ stateDir: "state" }));
  if (pid !== null) fs.writeFileSync(path.join(dir, ".runtime.json"), JSON.stringify({ pid, port: HQ_PORT, startedAt: new Date().toISOString(), control }));
  if (focused !== null) fs.writeFileSync(path.join(dir, ".hq-presence.json"), JSON.stringify({ focused, at: Date.now() - presenceAge }));
  const transcript = path.join(root, "projects", "p1", SID + ".jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, jsonl(rows));
  return { dir, transcript, folder: path.join(dir, "decisions"), settings: hqSettings };
}
const permission = (w, extra = {}) => ({ session_id: SID, transcript_path: w.transcript, cwd: "C:/work/quarry", permission_mode: "default", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: CALL, permission_suggestions: [], ...extra });
const question = (w, extra = {}) => ({ session_id: SID, transcript_path: w.transcript, cwd: "C:/work/quarry", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: COLOR, tool_use_id: "toolu_q1", ...extra });
const call = (sec, input = CALL, id = "tu_call") => asst({ sec, content: [{ ...tool("Bash", input), id }] });
const result = (sec, id) => ({ type: "user", timestamp: at(sec), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const append = (fp, rows) => fs.appendFileSync(fp, jsonl(rows));
const leftovers = (w) => (fs.existsSync(w.folder) ? fs.readdirSync(w.folder) : []);
// as on Windows, whatever system the tests run on: elsewhere the bridge stands aside, which has its own tests
const ask = (w, input, opts = {}) => B.run(JSON.stringify(input), { dir: w.dir, platform: "win32", ...fast, ...opts });
test("off Windows, where HQ's process cannot be looked up, the bridge prints nothing at once and writes no request, so Claude Code asks", async () => {
  for (const platform of ["linux", "darwin", "freebsd"]) {
    const w = world();
    assert.equal(B.canConfirm(platform), false);
    for (const input of [permission(w), question(w)]) assert.equal(await soon(ask(w, input, { platform }), 1000), "", platform);
    assert.deepEqual(leftovers(w), [], platform);
  }
  assert.equal(B.canConfirm("win32"), true);
});
test("off Windows the program exits 0 with nothing on stdout, whatever is asked, so Claude Code asks", async () => {
  const w = world();
  const pre = path.join(path.dirname(w.dir), "off-windows.cjs");
  fs.writeFileSync(pre, 'if (process.platform === "win32") Object.defineProperty(process, "platform", { value: "linux" });\n');
  for (const input of [permission(w), question(w)]) {
    const r = spawnSync(process.execPath, ["--require", pre, BRIDGE, "--state", w.dir], { input: JSON.stringify(input), encoding: "utf8", timeout: 20000 });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
  }
  assert.deepEqual(leftovers(w), []);
});
const stillOpen = (w, req) => fs.existsSync(path.join(w.folder, req.id + ".json"));

// The result, which must come within ms of the write that should end the wait. world()'s presence file goes stale after
// 90 s, and that alone ends any wait with nothing printed, so a wait with no limit would pass with the stand-down broken.
async function soon(p, ms = 3000) {
  let timer;
  const late = new Promise((_, fail) => (timer = setTimeout(() => fail(new Error(`no result within ${ms} ms`)), ms)));
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}
// The bridge as Claude Code runs it: a program, the hook input on its stdin. `pre` holds node flags put before the
// script. Its lookup is test/fake-lookup.cjs, finding this process (world()'s HQ pid) running HQ's server.js for w.
function program(w, pre = []) {
  const env = { ...process.env, HQ_FAKE_LOOKUP: asHq(process.pid, SERVER, w.settings) };
  const child = spawn(process.execPath, ["--require", FAKE, ...pre, BRIDGE, "--state", w.dir], { stdio: ["pipe", "pipe", "pipe"], env });
  child.stdin.on("error", () => {});
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => (out += c));
  const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
  return { child, done };
}

// The request file the bridge wrote, once it is there.
async function requestOf(w, ms = 3000) {
  for (const end = Date.now() + ms; ; ) {
    const f = leftovers(w).find((n) => /^[0-9a-f]{32}\.json$/.test(n));
    if (f) return JSON.parse(fs.readFileSync(path.join(w.folder, f), "utf8"));
    if (Date.now() > end) throw new Error("no request file");
    await sleep(20);
  }
}
// The server's side of an answer: temp plus rename, as lib/decisions.js writes it, with the hash of the request it
// showed, kept as HQ keeps the answers it wrote. forge() writes the same file and keeps nothing: an answer HQ did not
// write.
function forge(w, req, choice, over = {}) {
  const fp = path.join(w.folder, req.id + ".answer.json");
  fs.writeFileSync(fp + ".tmp", JSON.stringify({ id: req.id, sessionId: req.sessionId, toolName: req.toolName, choice, hash: req.hash, at: Date.now(), ...over }));
  fs.renameSync(fp + ".tmp", fp);
  return fp;
}
const keep = (req, choice, over = {}) => wrote.set(req.id, B.answerKey({ id: req.id, hash: req.hash, choice, ...over }));
function answer(w, req, choice, over = {}) {
  keep(req, choice, over);
  return forge(w, req, choice, over);
}
async function gone(fp, ms = 2000) {
  for (const end = Date.now() + ms; fs.existsSync(fp); ) {
    if (Date.now() > end) throw new Error("still there: " + path.basename(fp));
    await sleep(20);
  }
}

test("the bridge is silent, quick and writes nothing when HQ cannot answer or the input is not one it handles", () => {
  const Q0 = COLOR.questions[0];
  const qs = (list) => ({ questions: list });
  const cases = [
    ["no port file", { pid: null }, (w) => permission(w)],
    ["control off", { control: false }, (w) => permission(w)],
    ["HQ's pid is gone", { pid: DEAD }, (w) => permission(w)],
    ["stdin is not JSON", {}, () => "{not json"],
    ["PostToolUse", {}, (w) => permission(w, { hook_event_name: "PostToolUse" })],
    ["PreToolUse for another tool", {}, (w) => permission(w, { hook_event_name: "PreToolUse", tool_use_id: "toolu_x" })],
    ["one option", {}, (w) => question(w, { tool_input: qs([{ ...Q0, options: [{ label: "Red" }] }]) })],
    ["two options with one label", {}, (w) => question(w, { tool_input: qs([{ ...Q0, options: [{ label: "Red" }, { label: "Red" }] }]) })],
    ["a blank label", {}, (w) => question(w, { tool_input: qs([{ ...Q0, options: [{ label: "Red" }, { label: " " }] }]) })],
    ["an option with no label", {}, (w) => question(w, { tool_input: qs([{ ...Q0, options: [{ label: "Red" }, { description: "x" }] }]) })],
    ["no questions", {}, (w) => question(w, { tool_input: qs([]) })],
    ["five questions", {}, (w) => question(w, { tool_input: qs(Array.from({ length: 5 }, (_, i) => ({ ...Q0, question: "Q" + i }))) })],
    ["two questions with one text", {}, (w) => question(w, { tool_input: qs([Q0, Q0]) })],
    ["a blank question", {}, (w) => question(w, { tool_input: qs([{ ...Q0, question: "  " }]) })],
    ["multiSelect that is not true or false", {}, (w) => question(w, { tool_input: qs([{ ...Q0, multiSelect: "yes" }]) })],
    ["a question with no tool_use_id", {}, (w) => question(w, { tool_use_id: undefined })],
    ["AskUserQuestion through PermissionRequest", {}, (w) => question(w, { hook_event_name: "PermissionRequest" })],
    ["a session id that is a path", {}, (w) => permission(w, { session_id: "../../x" })],
    ["tool_input as a string", {}, (w) => permission(w, { tool_input: "npm test" })],
  ];
  for (const [what, opts, input] of cases) {
    const w = world(opts);
    const body = input(w);
    const t = Date.now();
    const r = spawnSync(process.execPath, [BRIDGE, "--state", w.dir], { input: typeof body === "string" ? body : JSON.stringify(body), encoding: "utf8", timeout: 5000 });
    const ms = Date.now() - t;
    assert.equal(r.status, 0, what);
    assert.equal(r.stdout, "", what);
    assert.ok(ms < 3000, `${what}: ${ms} ms`);
    assert.ok(!fs.existsSync(w.folder), `${what}: no decisions folder`);
  }
});

test("with no HQ page open it returns at once and writes nothing, so VS Code asks: no presence file, the last report over 90 s old, a closed tab's report past the grace, a report from the future, a file that is not JSON", async () => {
  const presence = (w, text) => fs.writeFileSync(path.join(w.dir, ".hq-presence.json"), text);
  const cases = [
    ["no presence file", (w) => fs.rmSync(path.join(w.dir, ".hq-presence.json"))],
    ["the last report 91 s old", (w) => presence(w, JSON.stringify({ focused: true, open: true, at: Date.now() - 91e3 }))],
    ["a closed tab's report 6 s old", (w) => presence(w, JSON.stringify({ focused: false, open: false, at: Date.now() - 6e3 }))],
    ["a report 60 s from now", (w) => presence(w, JSON.stringify({ focused: true, open: true, at: Date.now() + 60e3 }))],
    ["not JSON", (w) => presence(w, "{nope")],
  ];
  for (const [what, set] of cases) {
    const w = world({ rows: [call(1)] });
    set(w);
    const t = Date.now();
    assert.equal(await soon(ask(w, permission(w)), 1000), "", what);
    assert.ok(Date.now() - t < (process.env.CI ? 2000 : 500), `${what}: at once (${Date.now() - t} ms)`);
    assert.ok(!fs.existsSync(w.folder), `${what}: no decisions folder`);
  }
});

test("while an HQ page is open it holds the prompt, focused or not: a blur, the last report 80 s old (a hidden tab beats about once a minute), a closed tab's report inside the grace (a reload); the owner's answer from HQ prints", async () => {
  for (const [what, opts, presence] of [
    ["the page reported blur", { focused: false }],
    ["the last report 80 s old", { presenceAge: 80e3 }],
    ["a closed tab's report 1 s old", {}, { focused: false, open: false }],
  ]) {
    const w = world({ rows: [call(1)], ...opts });
    if (presence) fs.writeFileSync(path.join(w.dir, ".hq-presence.json"), JSON.stringify({ ...presence, at: Date.now() - 1e3 }));
    const p = ask(w, permission(w));
    const req = await requestOf(w);
    assert.deepEqual([req.pid, "notice" in req], [process.pid, false], what + ": a request, not a notice");
    await sleep(300);
    assert.ok(stillOpen(w, req), what + ": still held");
    answer(w, req, "deny");
    assert.equal(await soon(p), JSON.stringify(B.DENY), what);
    assert.deepEqual(leftovers(w), [], what);
  }
});

test("present and on, it writes one request with the call, prints the owner's allow exactly, and removes its files", async () => {
  const w = world({ rows: [user({ sec: 0, text: "go" }), call(1)] });
  const p = ask(w, permission(w));
  const req = await requestOf(w);
  assert.match(req.id, /^[0-9a-f]{32}$/);
  assert.ok(Math.abs(req.askedAt - Date.now()) < 5000);
  assert.deepEqual({ ...req, id: 0, askedAt: 0 }, { v: 1, id: 0, pid: process.pid, askedAt: 0, event: "PermissionRequest", sessionId: SID, transcriptPath: w.transcript, agentId: null, agentType: null, toolName: "Bash", toolInput: CALL, trimmed: false, toolUseId: null, cwd: "C:/work/quarry", hash: B.hashOf({ toolName: "Bash", toolInput: CALL, trimmed: false, cwd: "C:/work/quarry", agentId: null, agentType: null }) });
  answer(w, req, "allow");
  assert.equal(await p, '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
  assert.deepEqual(leftovers(w), []);
});

test("run as a program, it prints the owner's allow as one line on stdout and exits 0", async (t) => {
  const w = world({ rows: [call(1)] });
  const { child, done } = program(w);
  t.after(() => child.kill());
  child.stdin.end(JSON.stringify(permission(w)));
  const req = await requestOf(w);
  assert.equal(req.pid, child.pid, "the program wrote the request");
  answer(w, req, "allow");
  assert.deepEqual(await soon(done), { code: 0, out: '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n' });
  assert.deepEqual(leftovers(w), []);
});

test("an error on the input stream prints nothing and exits 0, so the normal prompt shows", async (t) => {
  const w = world({ rows: [call(1)] });
  // the stream fails 100 ms in, while the bridge still waits for the rest of its input
  const fail = "setTimeout(() => process.stdin.destroy(Object.assign(new Error('read EIO'), { code: 'EIO' })), 100)";
  const { child, done } = program(w, ["--import", "data:text/javascript," + encodeURIComponent(fail)]);
  t.after(() => child.kill());
  child.stdin.write(JSON.stringify(permission(w)).slice(0, 20));
  assert.deepEqual(await soon(done), { code: 0, out: "" });
  assert.ok(!fs.existsSync(w.folder), "no decisions folder");
});

test("a deny prints the deny with its message, exactly", async () => {
  const w = world({ rows: [call(1)] });
  const p = ask(w, permission(w));
  answer(w, await requestOf(w), "deny");
  assert.equal(await p, '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"The user denied this from VibeQuarters."}}}');
  assert.deepEqual(leftovers(w), []);
});

test("a question answered from HQ allows the call with the original questions plus the chosen label", async () => {
  const w = world();
  const p = ask(w, question(w));
  const req = await requestOf(w);
  assert.equal(req.event, "PreToolUse");
  assert.equal(req.toolUseId, "toolu_q1");
  answer(w, req, "opt:1");
  assert.deepEqual(JSON.parse(await p), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...COLOR, answers: { "Which color do you pick?": "Blue" } } } });
  assert.deepEqual(leftovers(w), []);
});

test("an answer for another request, session, tool or call, or a choice not offered, is removed and never acted on", async () => {
  const w = world({ rows: [call(1)] });
  const p = ask(w, permission(w));
  const req = await requestOf(w);
  const fp = path.join(w.folder, req.id + ".answer.json");
  // vscode is no choice any more: nothing HQ can answer hands it back to VS Code
  for (const over of [{ id: "f".repeat(32) }, { sessionId: "another-session" }, { toolName: "Write" }, { choice: "always" }, { choice: "opt:0" }, { choice: "vscode" }, { choice: "picks", picks: [[0]] }, { hash: "0".repeat(64) }, { hash: undefined }]) {
    answer(w, req, "allow", over);
    await gone(fp);
    assert.ok(stillOpen(w, req), JSON.stringify(over));
  }
  fs.writeFileSync(fp, "{not json");
  await gone(fp);
  answer(w, req, "deny");
  assert.equal(await p, JSON.stringify(B.DENY));
});

test("an answer file that cannot be read for a moment is kept and read again on the next check, never removed", async () => {
  const w = world({ rows: [call(1)] });
  const p = ask(w, permission(w));
  const req = await requestOf(w);
  const fp = path.join(w.folder, req.id + ".answer.json");
  const readFile = fs.readFileSync;
  let threw = false;
  // the first read of the written answer fails the way a file held open by another process does on Windows
  fs.readFileSync = function (f, ...a) {
    if (f === fp && !threw && fs.existsSync(fp)) {
      threw = true;
      throw Object.assign(new Error("EBUSY: resource busy or locked, open"), { code: "EBUSY" });
    }
    return readFile.call(this, f, ...a);
  };
  try {
    answer(w, req, "allow");
    assert.equal(await soon(p), JSON.stringify(B.ALLOW));
  } finally {
    fs.readFileSync = readFile;
  }
  assert.ok(threw, "the read failed once");
  assert.deepEqual(leftovers(w), []);
});

test("Ask for changes prints the deny with the owner's note as its message, exactly; a note that is missing, empty, too long or not one plain line is removed", async () => {
  const w = world({ rows: [call(1)] });
  const p = ask(w, permission(w));
  const req = await requestOf(w);
  assert.equal(B.NOTE_MAX, 500);
  const inner = (k) => "a" + String.fromCharCode(k) + "b"; // C1 next line, line separator, paragraph separator
  for (const note of [undefined, "", "   ", "x".repeat(501), "two\nlines", " padded ", 7, inner(0x85), inner(0x2028), inner(0x2029)]) {
    await gone(answer(w, req, "revise", { note }));
    assert.ok(stillOpen(w, req), JSON.stringify(note));
  }
  answer(w, req, "revise", { note: "Clean dist only, no push" });
  assert.equal(await p, '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"The user asks for a change, from VibeQuarters: Clean dist only, no push"}}}');
  assert.deepEqual(leftovers(w), []);
  assert.ok(B.plainNote("😀".repeat(500)) && !B.plainNote("😀".repeat(501)), "500 characters, counted by code points");
});

test("labels named allow and vscode are answered only by option keys, and a question takes no revise", async () => {
  const w = world();
  const odd = { questions: [{ question: "Pick one", header: "Odd", options: [{ label: "allow" }, { label: "vscode" }], multiSelect: false }] };
  const p = ask(w, question(w, { tool_input: odd }));
  const req = await requestOf(w);
  await gone(answer(w, req, "allow"));
  await gone(answer(w, req, "revise", { note: "Pick another" }));
  answer(w, req, "opt:1");
  assert.deepEqual(JSON.parse(await p).hookSpecificOutput.updatedInput.answers, { "Pick one": "vscode" });
});

test("the wait ends with nothing printed, its files removed, when HQ stops, control goes off or the request is swept; the owner leaving ends nothing", async () => {
  const endings = [
    ["control off", (w) => fs.writeFileSync(path.join(w.dir, ".runtime.json"), JSON.stringify({ pid: process.pid, port: 1, control: false })), {}],
    ["HQ's pid is gone", (w) => fs.writeFileSync(path.join(w.dir, ".runtime.json"), JSON.stringify({ pid: DEAD, port: 1, control: true })), {}],
    ["the request swept", (w, req) => fs.unlinkSync(path.join(w.folder, req.id + ".json")), {}],
  ];
  for (const [what, act, opts] of endings) {
    const w = world({ rows: [call(1)] });
    const t = Date.now();
    const p = ask(w, permission(w), opts);
    act(w, await requestOf(w));
    assert.equal(await soon(p), "", what);
    assert.ok(Date.now() - t < 3000, `${what} ends within 3 s`);
    assert.deepEqual(leftovers(w), [], what);
  }
  // a blur, and a report 60 s old, end nothing while the page is open: the owner's answer after them still prints
  const w = world({ rows: [call(1)] });
  const p = ask(w, permission(w));
  const req = await requestOf(w);
  fs.writeFileSync(path.join(w.dir, ".hq-presence.json"), JSON.stringify({ focused: false, open: true, at: Date.now() - 60e3 }));
  await sleep(400);
  assert.ok(stillOpen(w, req), "the owner left HQ: still held");
  answer(w, req, "allow");
  assert.equal(await soon(p), JSON.stringify(B.ALLOW));
});

test("a held prompt whose HQ page closes moves to VS Code as the cap moves it: a closed tab's report once the grace passes, or the beat stopping past the window, rewrites the request as a notice and prints nothing; a reload inside the grace ends nothing", async () => {
  const presence = (w, o) => fs.writeFileSync(path.join(w.dir, ".hq-presence.json"), JSON.stringify({ at: Date.now(), ...o }));
  const notice = (w, req, what) => {
    assert.deepEqual(leftovers(w), [req.id + ".json"], what + ": the request file alone");
    const n = JSON.parse(fs.readFileSync(path.join(w.folder, req.id + ".json"), "utf8"));
    assert.deepEqual([n.notice, n.pid, n.hash], [true, process.ppid, B.hashOf(n)], what + ": a notice");
    assert.ok(n.movedAt >= req.askedAt && n.movedAt <= Date.now(), what + ": when it moved");
  };
  {
    const w = world({ rows: [call(1)] });
    const p = ask(w, permission(w), { graceMs: 300 });
    const req = await requestOf(w);
    presence(w, { focused: false, open: false }); // the tab closed: its pagehide report
    const t = Date.now();
    assert.equal(await soon(p), "", "a closed tab");
    assert.ok(Date.now() - t >= 250, `a closed tab: not before the grace (${Date.now() - t} ms)`);
    notice(w, req, "a closed tab");
  }
  {
    const w = world({ rows: [call(1)] });
    const p = ask(w, permission(w), { openMs: 500 });
    const req = await requestOf(w);
    assert.equal(await soon(p), "", "the beat stopped");
    notice(w, req, "the beat stopped");
  }
  {
    const w = world({ rows: [call(1)] });
    const p = ask(w, permission(w), { graceMs: 600 });
    const req = await requestOf(w);
    presence(w, { focused: false, open: false }); // a reload: the old page's pagehide, then the new page's first report
    await sleep(150);
    presence(w, { focused: true, open: true });
    await sleep(900);
    assert.ok(stillOpen(w, req) && !JSON.parse(fs.readFileSync(path.join(w.folder, req.id + ".json"), "utf8")).notice, "a reload: still held");
    answer(w, req, "allow");
    assert.equal(await soon(p), JSON.stringify(B.ALLOW), "a reload");
  }
});

test("at the cap the request is rewritten in place as a notice: the same id, notice true, the Claude process's pid, when it moved, sealed under its new hash; nothing printed, no other file left", async () => {
  for (const [what, input] of [["a permission", (w) => permission(w)], ["a question", (w) => question(w)], ["a plan approval", (w) => permission(w, { tool_name: "ExitPlanMode", tool_input: { plan: "Ship it" } })]]) {
    const w = world({ rows: [call(1)] });
    const t = Date.now();
    const p = ask(w, input(w), { cap: 300 });
    const req = await requestOf(w);
    assert.equal(await soon(p), "", what);
    assert.ok(Date.now() - t < 3000, `${what}: ends within 3 s`);
    assert.deepEqual(leftovers(w), [req.id + ".json"], what + ": the request file alone");
    const n = JSON.parse(fs.readFileSync(path.join(w.folder, req.id + ".json"), "utf8"));
    const { hash, pid, movedAt, notice, ...rest } = n;
    assert.deepEqual(rest, (({ hash: _h, pid: _p, ...r }) => r)(req), what + ": the same request");
    assert.deepEqual([notice, pid, hash], [true, process.ppid, B.hashOf(n)], what);
    assert.notEqual(hash, req.hash, what + ": its mark is sealed in its hash");
    assert.ok(movedAt >= req.askedAt + 300 && movedAt <= Date.now(), what + ": when it moved");
    assert.ok(D.requestOf(n.id, JSON.stringify(n)), what + ": HQ reads it as a notice");
  }
});

test("an answer that lands as the cap passes still counts: the answer first, and no notice is left", async () => {
  const w = world({ rows: [call(1)] });
  const p = ask(w, permission(w), { cap: 60e3 });
  const req = await requestOf(w);
  const real = Date.now;
  try {
    Date.now = () => real() + 120e3; // the cap passes in the same moment the owner's answer lands
    answer(w, req, "allow");
    assert.equal(await soon(p), JSON.stringify(B.ALLOW));
  } finally {
    Date.now = real;
  }
  assert.deepEqual(leftovers(w), []);
});

test("the cap passing while a check is in flight waits for the check: HQ's yes still prints the owner's answer and leaves no notice; a no removes the answer, and the next check writes the notice", async () => {
  const slow = (found) => (script) => new Promise((r) => setTimeout(() => r(found(script)), 600));
  try {
    {
      const w = world({ rows: [call(1)] });
      L.setLookup(slow(lookup));
      const p = ask(w, permission(w), { cap: 300 });
      const req = await requestOf(w);
      answer(w, req, "allow"); // before the cap; its lookup ends after it
      assert.equal(await soon(p), JSON.stringify(B.ALLOW), "a yes");
      assert.ok(Date.now() - req.askedAt >= 600, `the check ran past the cap (${Date.now() - req.askedAt} ms)`);
      assert.deepEqual(leftovers(w), [], "a yes: no notice");
    }
    {
      const w = world({ rows: [call(1)] });
      L.setLookup(slow(() => asHq(process.pid, path.join(os.tmpdir(), "fake-hq.js"))));
      const p = ask(w, permission(w), { cap: 300 });
      const req = await requestOf(w);
      const fp = answer(w, req, "allow");
      assert.equal(await soon(p), "", "a no");
      assert.ok(Date.now() - req.askedAt >= 600, `the check ran past the cap (${Date.now() - req.askedAt} ms)`);
      assert.ok(!fs.existsSync(fp), "a no: the answer removed");
      assert.deepEqual(leftovers(w), [req.id + ".json"], "a no: the request file alone");
      assert.equal(JSON.parse(fs.readFileSync(path.join(w.folder, req.id + ".json"), "utf8")).notice, true, "a no: the notice");
    }
  } finally {
    L.setLookup(lookup);
  }
});

test("a notice that cannot be written at the cap ends the wait with nothing printed and removes the request, so HQ shows nothing VS Code now asks", async () => {
  const w = world({ rows: [call(1)] });
  const p = ask(w, permission(w), { cap: 400 });
  const req = await requestOf(w);
  fs.mkdirSync(path.join(w.folder, req.id + ".json.tmp")); // the notice's temp file cannot be written
  assert.equal(await soon(p), "");
  assert.ok(!stillOpen(w, req), "the request removed");
  assert.deepEqual(leftovers(w), [req.id + ".json.tmp"], "only the folder that blocked it");
});

test("stand-down: unrelated lines never end the wait, and the owner's allow still lands", async () => {
  const w = world({ rows: [user({ sec: 0, text: "go" }), call(1)] });
  const p = ask(w, permission(w));
  const req = await requestOf(w);
  append(w.transcript, [
    { type: "user", isMeta: true, timestamp: at(2), message: { role: "user", content: "<system-reminder>\nnote\n</system-reminder>" } },
    user({ sec: 3, text: "<task-notification>\n<task-id>x1</task-id>\n<status>completed</status>\n</task-notification>" }),
    result(4, "tu_other"),
    call(5, { command: "npm run lint", description: "Lint" }, "tu_lint"),
    result(6, "tu_lint"),
  ]);
  await sleep(400);
  assert.ok(stillOpen(w, req), "the request is still open");
  answer(w, req, "allow");
  assert.equal(await p, JSON.stringify(B.ALLOW));
});

test("stand-down: this call's result in the transcript means VS Code answered; nothing is printed", async () => {
  const w = world({ rows: [user({ sec: 0, text: "go" }), call(1)] });
  const p = ask(w, permission(w));
  await requestOf(w);
  append(w.transcript, [result(2, "tu_call")]);
  assert.equal(await soon(p), "");
  assert.deepEqual(leftovers(w), []);
});

test("stand-down: a call written after the request, then its result, ends it too", async () => {
  const w = world({ rows: [user({ sec: 0, text: "go" })] });
  const p = ask(w, permission(w));
  await requestOf(w);
  append(w.transcript, [call(1)]);
  await sleep(200);
  append(w.transcript, [result(2, "tu_call")]);
  assert.equal(await soon(p), "");
});

test("stand-down: a prompt the owner typed in the chat ends it", async () => {
  const w = world({ rows: [call(1)] });
  const p = ask(w, permission(w));
  await requestOf(w);
  append(w.transcript, [user({ sec: 2, text: "never mind, stop" })]);
  assert.equal(await soon(p), "");
});

test("stand-down: a question's own tool_use_id result ends it", async () => {
  const w = world();
  const p = ask(w, question(w));
  await requestOf(w);
  append(w.transcript, [result(2, "toolu_q1")]);
  assert.equal(await soon(p), "");
});

test("a subagent's request watches its own file: its call's result ends it; the main chat never does", async () => {
  const AG = "a0123456789abcdef";
  const w = world({ rows: [user({ sec: 0, text: "go" })] });
  const sub = path.join(path.dirname(w.transcript), SID, "subagents", `agent-${AG}.jsonl`);
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(sub, jsonl([user({ sec: 0, text: "brief", sidechain: true }), asst({ sec: 1, sidechain: true, content: [{ ...tool("Bash", CALL), id: "tu_sub" }] })]));
  const p = ask(w, permission(w, { agent_id: AG, agent_type: "docs-checker" }));
  const req = await requestOf(w);
  assert.deepEqual([req.agentId, req.agentType], [AG, "docs-checker"]);
  append(w.transcript, [user({ sec: 2, text: "how is it going?" }), result(3, "tu_sub")]);
  await sleep(400);
  assert.ok(stillOpen(w, req), "a prompt and a result in the main chat say nothing about the subagent's call");
  append(sub, [{ ...result(4, "tu_sub"), isSidechain: true }]);
  assert.equal(await soon(p), "");
});

test("a hostile agent_id is dropped: the request names no agent and watches the main transcript", async () => {
  for (const bad of ["../../../etc/x", "a0123", "A0123456789ABCDEF", 7]) {
    const w = world({ rows: [call(1)] });
    const p = ask(w, permission(w, { agent_id: bad, agent_type: "docs-checker" }));
    const req = await requestOf(w);
    assert.deepEqual([req.agentId, req.agentType], [null, null], String(bad));
    append(w.transcript, [result(2, "tu_call")]);
    assert.equal(await soon(p), "", "the main transcript's result stands it down");
  }
});

test("with no agent_id, the session's subagent files are read too: a subagent's result for the call ends the wait; its own prompt rows and a call answered before the ask never do", async () => {
  const w = world({ rows: [user({ sec: 0, text: "go" })] });
  const dir = path.join(path.dirname(w.transcript), SID, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  const sub = path.join(dir, "agent-a0123456789abcdef.jsonl");
  fs.writeFileSync(sub, jsonl([user({ sec: 0, text: "brief", sidechain: true }), asst({ sec: 1, sidechain: true, content: [{ ...tool("Bash", CALL), id: "tu_sub" }] })]));
  const old = path.join(dir, "agent-a1111111111111111.jsonl"); // another subagent ran the same call and got its result before the ask
  fs.writeFileSync(old, jsonl([asst({ sec: 0, sidechain: true, content: [{ ...tool("Bash", CALL), id: "tu_old" }] }), { ...result(0, "tu_old"), isSidechain: true }]));
  const p = ask(w, permission(w));
  const req = await requestOf(w);
  assert.equal(req.agentId, null);
  append(sub, [user({ sec: 2, text: "keep going", sidechain: true })]);
  append(old, [user({ sec: 2, text: "done", sidechain: true })]);
  await sleep(400);
  assert.ok(stillOpen(w, req), "a subagent's prompt rows and a call answered before the ask say nothing");
  append(sub, [{ ...result(3, "tu_sub"), isSidechain: true }]);
  assert.equal(await soon(p), "");
  assert.deepEqual(leftovers(w), []);
});

test("with no agent_id, a subagent file that appears after the ask is read too", async () => {
  const w = world({ rows: [user({ sec: 0, text: "go" })] });
  const p = ask(w, permission(w));
  const req = await requestOf(w);
  const sub = path.join(path.dirname(w.transcript), SID, "subagents", "agent-a2222222222222222.jsonl");
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(sub, jsonl([asst({ sec: 1, sidechain: true, content: [{ ...tool("Bash", CALL), id: "tu_new" }] })]));
  await sleep(300);
  assert.ok(stillOpen(w, req), "the call alone is not an answer");
  append(sub, [{ ...result(2, "tu_new"), isSidechain: true }]);
  assert.equal(await soon(p), "");
});

test("hashOf is the call as the request keeps it: key order and the request's other fields do not count; the tool, the input, the cut, the folder and the agent do", () => {
  const K = { toolName: "Bash", toolInput: CALL, trimmed: false, cwd: "C:/work/quarry", agentId: null, agentType: null };
  const h = B.hashOf(K);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(B.hashOf({ ...K, toolInput: { description: "Run the tests", command: "npm test" } }), h);
  assert.equal(B.hashOf({ ...K, id: "x", askedAt: 5, pid: 9, hash: "0".repeat(64) }), h, "the request's other fields do not count");
  for (const change of [{ toolName: "PowerShell" }, { toolInput: { ...CALL, command: "npm test -- --watch" } }, { trimmed: true }, { cwd: "C:/Users/me" }, { agentId: "a0123456789abcdef" }, { agentType: "docs-checker" }])
    assert.notEqual(B.hashOf({ ...K, ...change }), h, JSON.stringify(change));
});

test("a rewritten request file never allows: only an answer with the hash of the call the bridge was given counts", async () => {
  const w = world({ rows: [call(1)] });
  const p = ask(w, permission(w));
  const req = await requestOf(w);
  assert.equal(req.hash, B.hashOf({ toolName: "Bash", toolInput: CALL, trimmed: false, cwd: "C:/work/quarry", agentId: null, agentType: null }));
  // another process rewrites the request so HQ would show a harmless call, with that call's own hash; the answer the
  // server writes carries the hash of what it showed
  const shown = { ...req, toolInput: { command: "echo hi", description: "Say hi" } };
  shown.hash = B.hashOf(shown);
  fs.writeFileSync(path.join(w.folder, req.id + ".json"), JSON.stringify(shown));
  await gone(answer(w, shown, "allow"));
  assert.ok(stillOpen(w, req), "the answer for what was shown is removed, never acted on");
  answer(w, req, "allow");
  assert.equal(await p, JSON.stringify(B.ALLOW), "only the bridge's own hash allows");
  assert.deepEqual(leftovers(w), []);
});

test("a 3 MB transcript is read from its last megabyte; a half-written line counts only once it ends", async () => {
  const pad = "x".repeat(2000);
  const w = world({ rows: [...Array.from({ length: 1500 }, () => asst({ sec: 0, content: [text(pad)], stop: "end_turn" })), call(1)] });
  assert.ok(fs.statSync(w.transcript).size > 3e6);
  const read = fs.readSync;
  let bytes = 0;
  fs.readSync = function (...a) {
    const n = read.apply(this, a);
    bytes += n;
    return n;
  };
  let p;
  try {
    p = ask(w, permission(w));
    await requestOf(w);
  } finally {
    fs.readSync = read;
  }
  assert.ok(bytes < 1.2e6, `${bytes} bytes read to start`);
  const req = await requestOf(w);
  const line = JSON.stringify(result(2, "tu_call"));
  fs.appendFileSync(w.transcript, line.slice(0, 40));
  await sleep(400);
  assert.ok(stillOpen(w, req), "half a line is not a result");
  fs.appendFileSync(w.transcript, line.slice(40) + "\n");
  assert.equal(await soon(p), "");
});

test("a 5,000-character call is matched on its untrimmed input, though the request keeps a trimmed copy", async () => {
  const LONG = { command: "echo " + "y".repeat(5000), description: "Print a long line" };
  const w = world({ rows: [call(1, LONG)] });
  const p = ask(w, permission(w, { tool_input: LONG }));
  const req = await requestOf(w);
  assert.equal(req.trimmed, true);
  assert.ok(JSON.stringify(req.toolInput).length <= 4000);
  assert.ok(req.toolInput.command.endsWith("…"));
  append(w.transcript, [result(2, "tu_call")]);
  assert.equal(await soon(p), "");
});

test("a Risky permission is held for the owner's answer like any other, marked risky when the full call reads Risky (the mark sealed in its hash); a call Risky only in its kept copy, or not at all, carries no mark", async () => {
  const PUSH = { command: "git push origin main", description: "Push the branch" };
  // Risky only past the 4,000 characters the request keeps: the rating reads the full input
  const LATE = { command: "echo " + "y".repeat(5000) + " && git push origin main", description: "Print, then push" };
  const kept = B.trimInput(LATE);
  assert.equal(riskOf("Bash", LATE, false, "C:/work/quarry").level, "high");
  assert.notEqual(riskOf("Bash", kept.input, kept.trimmed, "C:/work/quarry").level, "high", "the kept copy alone would not say Risky");
  // "deployment" cut to "deploy" plus the ellipsis at the 4,000 characters the request keeps: only the kept copy reads
  // Risky
  const shape = (k) => ({ command: "echo " + "a".repeat(k) + " deployment notes " + "b".repeat(2000), description: "Print notes" });
  const rate = (input) => [riskOf("Bash", input, false, "C:/work/quarry").level, (({ input: i, trimmed }) => riskOf("Bash", i, trimmed, "C:/work/quarry").level)(B.trimInput(input))];
  let CUT = null;
  for (let k = 3900; k < 4050 && !CUT; k++) if (rate(shape(k))[0] !== "high" && rate(shape(k))[1] === "high") CUT = shape(k);
  assert.ok(CUT, "a place where only the kept copy reads Risky");
  for (const [what, input, risky] of [["Risky", PUSH, true], ["Risky past the cut", LATE, true], ["Risky only in the kept copy", CUT, false], ["Check first", CALL, false]]) {
    const w = world({ rows: [call(1, input)], focused: false });
    const p = ask(w, permission(w, { tool_input: input }));
    const req = await requestOf(w);
    const k = B.trimInput(input);
    assert.deepEqual([req.pid, "notice" in req, req.risky, req.toolInput, req.trimmed], [process.pid, false, risky || undefined, k.input, k.trimmed], what);
    assert.equal(req.hash, B.hashOf({ toolName: "Bash", toolInput: k.input, trimmed: k.trimmed, cwd: "C:/work/quarry", agentId: null, agentType: null, ...(risky ? { risky } : {}) }), what + ": its hash");
    assert.ok(D.requestOf(req.id, JSON.stringify(req)), what + ": HQ reads it");
    answer(w, req, "allow");
    assert.equal(await soon(p), JSON.stringify(B.ALLOW), what);
  }
  // the mark counts in the hash: a request stripped of it is another call
  const base = { toolName: "Bash", toolInput: PUSH, trimmed: false, cwd: null, agentId: null, agentType: null };
  assert.notEqual(B.hashOf({ ...base, risky: true }), B.hashOf(base));
});

test("a permission a safety hook asked about carries the hook's ask, read once from its mark and sealed in the hash; the same call with no mark carries none", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hq-bridge-home-"));
  roots.push(home);
  const marks = path.join(home, ".claude", "hq-feed", "hook-asks");
  fs.mkdirSync(marks, { recursive: true });
  const mark = path.join(marks, askKey(SID, "Bash", CALL) + ".json");
  fs.writeFileSync(mark, JSON.stringify({ v: 1, hook: "guard-bash.js", reason: "local-guardrails: why", at: Date.now() }));
  // the bridge finds the mark under os.homedir(), read when run starts, before its first wait
  const inHome = (fn) => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      return fn();
    } finally {
      for (const k of Object.keys(saved)) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    }
  };
  const w = world({ rows: [call(1)], focused: false });
  const p = inHome(() => ask(w, permission(w)));
  const req = await requestOf(w);
  assert.deepEqual(req.hookAsk, { hook: "guard-bash.js", reason: "local-guardrails: why" });
  assert.equal(fs.existsSync(mark), false, "the mark is read once");
  assert.equal(req.hash, B.hashOf({ toolName: "Bash", toolInput: CALL, trimmed: false, cwd: "C:/work/quarry", agentId: null, agentType: null, hookAsk: req.hookAsk }));
  assert.ok(D.requestOf(req.id, JSON.stringify(req)), "HQ reads it");
  answer(w, req, "allow");
  assert.equal(await soon(p), JSON.stringify(B.ALLOW));
  const w2 = world({ rows: [call(1)], focused: false });
  const p2 = inHome(() => ask(w2, permission(w2)));
  const req2 = await requestOf(w2);
  assert.equal("hookAsk" in req2, false, "no mark, no hook's ask");
  answer(w2, req2, "allow");
  assert.equal(await soon(p2), JSON.stringify(B.ALLOW));
});

test("a plan approval is held: Approve prints the allow, Keep planning the deny with the owner's note; Deny and a note that is not one plain line are removed, never acted on", async () => {
  const PLAN = { plan: "1. Add the route\n2. Ship it" };
  const w = world({ rows: [call(1)] });
  const plan = () => permission(w, { tool_name: "ExitPlanMode", tool_input: PLAN });
  let p = ask(w, plan());
  let req = await requestOf(w);
  assert.deepEqual([req.event, req.toolName, req.toolInput, "risky" in req, req.toolUseId], ["PermissionRequest", "ExitPlanMode", PLAN, false, null]);
  assert.ok(D.requestOf(req.id, JSON.stringify(req)), "HQ reads it");
  for (const [choice, over] of [["deny", {}], ["revise", { note: "" }], ["revise", { note: "two\nlines" }], ["opt:0", {}]]) {
    await gone(answer(w, req, choice, over));
    assert.ok(stillOpen(w, req), choice + " " + JSON.stringify(over));
  }
  answer(w, req, "revise", { note: "Add tests first" });
  assert.equal(await soon(p), '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"The user asks you to keep planning, from VibeQuarters: Add tests first"}}}');
  p = ask(w, plan());
  req = await requestOf(w);
  answer(w, req, "allow");
  assert.equal(await soon(p), JSON.stringify(B.ALLOW));
  assert.deepEqual(leftovers(w), []);
});

test("every question shape is held: one question with one pick by its option, any other shape by its picks, the answers keyed by each question with several labels joined by a comma and a space, in the options' order", async () => {
  const SIZES = { question: "Which sizes?", header: "Sizes", options: [{ label: "S" }, { label: "M" }, { label: "L" }], multiSelect: true };
  const TWO = { questions: [COLOR.questions[0], SIZES] };
  const w = world();
  let p = ask(w, question(w, { tool_input: TWO }));
  let req = await requestOf(w);
  assert.deepEqual([req.event, req.toolUseId, req.toolInput], ["PreToolUse", "toolu_q1", TWO]);
  assert.ok(D.requestOf(req.id, JSON.stringify(req)), "HQ reads it");
  // picks that do not fit: a question left out, two on a one-pick question, none, out of order, out of range, twice, not
  // a whole number, not a list; and an option key, which only a one-pick single question takes
  for (const picks of [[[1]], [[0, 1], [0]], [[1], []], [[1], [2, 0]], [[1], [3]], [[1], [0, 0]], [[1.5], [0]], [[-1], [0]], "x", [1, [0]], undefined]) {
    await gone(answer(w, req, "picks", { picks }));
    assert.ok(stillOpen(w, req), JSON.stringify(picks));
  }
  await gone(answer(w, req, "opt:0"));
  answer(w, req, "picks", { picks: [[1], [0, 2]] });
  assert.deepEqual(JSON.parse(await soon(p)), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...TWO, answers: { "Which color do you pick?": "Blue", "Which sizes?": "S, L" } } } });
  // one question with several picks: by its picks too; four questions and nine options are a shape too
  p = ask(w, question(w, { tool_input: { questions: [SIZES] } }));
  req = await requestOf(w);
  await gone(answer(w, req, "opt:1"));
  answer(w, req, "picks", { picks: [[0, 1, 2]] });
  assert.deepEqual(JSON.parse(await soon(p)).hookSpecificOutput.updatedInput.answers, { "Which sizes?": "S, M, L" });
  const FOUR = { questions: Array.from({ length: 4 }, (_, i) => ({ question: "Q" + i, header: "H", options: Array.from({ length: 9 }, (_, k) => ({ label: "L" + k })), multiSelect: i % 2 === 1 })) };
  p = ask(w, question(w, { tool_input: FOUR }));
  req = await requestOf(w);
  answer(w, req, "picks", { picks: [[8], [0, 8], [3], [4]] });
  assert.deepEqual(JSON.parse(await soon(p)).hookSpecificOutput.updatedInput.answers, { Q0: "L8", Q1: "L0, L8", Q2: "L3", Q3: "L4" });
  assert.deepEqual(leftovers(w), []);
});

test("acting on an HQ answer, the bridge first logs one line (time, id, session id, tool, choice, source bridge), never the command, the note or the labels; a line it cannot write is swallowed", async () => {
  const w = world({ rows: [call(1)] });
  const logFp = path.join(w.dir, "answers.log.jsonl");
  const acted = [];
  const MULTI = { questions: [{ ...COLOR.questions[0], multiSelect: true }] };
  for (const [kind, choice, over] of [["permission", "allow"], ["permission", "deny"], ["permission", "revise", { note: "canary-note-3 use staging" }], ["question", "opt:1"], ["multi", "picks", { picks: [[0, 1]] }]]) {
    const p = ask(w, kind === "question" ? question(w) : kind === "multi" ? question(w, { tool_input: MULTI }) : permission(w));
    const req = await requestOf(w);
    answer(w, req, choice, over);
    assert.notEqual(await soon(p), "", choice);
    acted.push({ id: req.id, sessionId: SID, tool: req.toolName, choice, source: "bridge" });
  }
  const log = fs.readFileSync(logFp, "utf8");
  const lines = log.trim().split("\n").map((l) => JSON.parse(l));
  for (const l of lines) assert.ok(/Z$/.test(l.at) && Math.abs(Date.parse(l.at) - Date.now()) < 30e3, l.at);
  assert.deepEqual(lines.map(({ at, ...rest }) => rest), acted);
  assert.ok(!log.includes("npm test") && !log.includes("canary-note-3") && !log.includes("Red"), "never the command, the note or the labels");
  // a folder where the log should be: every append fails, and the owner's decision still prints
  fs.unlinkSync(logFp);
  fs.mkdirSync(logFp);
  const p = ask(w, permission(w));
  answer(w, await requestOf(w), "allow");
  assert.equal(await soon(p), JSON.stringify(B.ALLOW));
});

test("an answer file HQ did not write approves nothing: the bridge asks HQ over its port, gets a no, removes the file and waits on; HQ's own answer then counts", async () => {
  const PUSH = { command: "git push origin main", description: "Push the branch" };
  const w = world({ rows: [call(1, PUSH)] });
  const p = ask(w, permission(w, { tool_input: PUSH }));
  const req = await requestOf(w);
  const n = checks.length;
  await gone(forge(w, req, "allow"));
  await sleep(300);
  assert.ok(stillOpen(w, req), "still held");
  const asked = checks.slice(n);
  assert.deepEqual(asked.map((c) => [c.method, c.url, c.origin]), [["POST", "/api/verify", undefined]], "one check, with no Origin");
  assert.deepEqual(asked[0].body, { id: req.id, hash: req.hash, choice: "allow", sessionId: SID, toolName: "Bash" }, "the answer it found, and whose request it is");
  answer(w, req, "allow");
  assert.equal(await soon(p), JSON.stringify(B.ALLOW));
  assert.deepEqual(leftovers(w), []);
});

test("the check is for the exact answer: HQ's answer for the same request with another choice, note or picks makes a forged one no answer", async () => {
  const w = world({ rows: [call(1)] });
  let p = ask(w, permission(w));
  let req = await requestOf(w);
  for (const [mine, theirs] of [[["deny"], ["allow"]], [["revise", { note: "use staging" }], ["revise", { note: "push to main" }]]]) {
    keep(req, ...mine); // HQ wrote its own answer for this request; a forged one lands in its place
    await gone(forge(w, req, ...theirs));
    assert.ok(stillOpen(w, req), JSON.stringify(theirs));
  }
  answer(w, req, "deny");
  assert.equal(await soon(p), JSON.stringify(B.DENY));
  const TWO = { questions: [COLOR.questions[0], { question: "Which sizes?", header: "Sizes", options: [{ label: "S" }, { label: "M" }], multiSelect: true }] };
  p = ask(w, question(w, { tool_input: TWO }));
  req = await requestOf(w);
  keep(req, "picks", { picks: [[0], [0]] });
  await gone(forge(w, req, "picks", { picks: [[1], [0, 1]] }));
  assert.ok(stillOpen(w, req), "other picks");
  answer(w, req, "picks", { picks: [[1], [0, 1]] });
  assert.deepEqual(JSON.parse(await soon(p)).hookSpecificOutput.updatedInput.answers, { "Which color do you pick?": "Blue", "Which sizes?": "S, M" });
});

test("with no HQ to ask (its port refuses), even a well-formed answer counts for nothing: it is removed and the wait goes on", async () => {
  const w = world({ rows: [call(1)] });
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  fs.writeFileSync(path.join(w.dir, ".runtime.json"), JSON.stringify({ pid: process.pid, port, control: true }));
  const p = ask(w, permission(w));
  const req = await requestOf(w);
  await gone(answer(w, req, "allow"));
  assert.ok(stillOpen(w, req), "still held");
  fs.writeFileSync(path.join(w.dir, ".runtime.json"), JSON.stringify({ pid: process.pid, port, control: false }));
  assert.equal(await soon(p), "", "control off ends it with nothing printed");
});

test("a check HQ's server cannot answer confirms nothing: the answer is removed, logged as unchecked (not the tamper line), and the wait goes on; HQ's own no logs nothing here (HQ alerts on it itself); HQ's answer then counts", async () => {
  const w = world({ rows: [call(1)] });
  const log = () => (fs.existsSync(path.join(w.dir, "answers.log.jsonl")) ? fs.readFileSync(path.join(w.dir, "answers.log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  try {
    const p = ask(w, permission(w));
    const req = await requestOf(w);
    verifyFails = true;
    await gone(answer(w, req, "allow"));
    await sleep(100);
    assert.ok(stillOpen(w, req), "still held");
    assert.deepEqual(log().map(({ at, ...rest }) => rest), [{ id: req.id, sessionId: SID, tool: "Bash", choice: "allow", source: "unchecked" }]);
    verifyFails = false;
    await gone(forge(w, req, "deny")); // HQ wrote allow, not this
    await sleep(100);
    assert.ok(stillOpen(w, req), "a forged answer: still held");
    assert.equal(log().length, 1, "HQ's no: no line from the bridge");
    answer(w, req, "deny");
    assert.equal(await soon(p), JSON.stringify(B.DENY));
  } finally {
    verifyFails = false;
  }
});

test("an answer counts only through the real HQ: with .runtime.json rewritten to name another server, that server is never asked, the answer is removed, the bridge logs one line HQ alerts on and waits on; with the file restored HQ's answer counts", async () => {
  const w = world({ rows: [call(1)] });
  const asked = [];
  const forger = http.createServer((req, res) => {
    asked.push(req.url);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"wrote":true}');
  });
  await new Promise((r) => forger.listen(0, "127.0.0.1", r));
  try {
    const rtFp = path.join(w.dir, ".runtime.json");
    const real = fs.readFileSync(rtFp, "utf8");
    const n = L.lookups.length;
    const p = ask(w, permission(w));
    const req = await requestOf(w);
    await sleep(300);
    assert.equal(L.lookups.length, n + 1, "one lookup as the request is written, ahead of the answer");
    assert.ok(L.lookups[n].includes(`-LocalPort ${HQ_PORT} `), L.lookups[n]);
    const port = forger.address().port;
    fs.writeFileSync(rtFp, JSON.stringify({ pid: process.pid, port, control: true }));
    const c = checks.length;
    await gone(answer(w, req, "allow")); // even an answer HQ wrote: the port does not lead to HQ
    await sleep(300);
    assert.ok(stillOpen(w, req), "still held");
    assert.deepEqual(asked, [], "the other server is never asked");
    assert.equal(checks.length, c, "nor is any other port");
    assert.equal(L.lookups.length, n + 2, "the port file names another server: a lookup of its own when the answer appeared, the one ahead not reused");
    assert.ok(L.lookups[n + 1].includes(`-LocalPort ${port} `) && L.lookups[n + 1].includes(`ProcessId=${process.pid}'`), L.lookups[n + 1]);
    const lines = fs.readFileSync(path.join(w.dir, "answers.log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(/Z$/.test(lines[0].at), lines[0].at);
    assert.deepEqual(lines.map(({ at, ...rest }) => rest), [{ id: req.id, sessionId: SID, tool: "Bash", choice: "allow", source: "unconfirmed" }]);
    fs.writeFileSync(rtFp, real);
    answer(w, req, "allow");
    assert.equal(await soon(p), JSON.stringify(B.ALLOW));
  } finally {
    forger.close();
  }
});

test("a lookup that finds on HQ's own port a process that is not HQ's server.js for this state folder is a no, logged as unconfirmed; a lookup that fails or runs out of time confirms nothing, logged as unchecked; either way the answer is removed and the wait goes on", async () => {
  const other = world(); // another copy of HQ, with its own state folder
  try {
    // each found from the start, so the lookup begun as the request is written finds it too; a no or a lookup that
    // could not tell is never reused, so once the lookup finds HQ the next answer counts
    for (const [what, found, source] of [["the lookup fails", null, "unchecked"], ["another script", asHq(process.pid, path.join(os.tmpdir(), "server.js")), "unconfirmed"], ["another pid listens too", JSON.stringify({ ...JSON.parse(asHq(process.pid)), owners: [process.pid, process.pid + 1] }), "unconfirmed"], ["HQ for another state folder", asHq(process.pid, SERVER, other.settings), "unconfirmed"]]) {
      const w = world({ rows: [call(1)] });
      L.setLookup(found);
      const p = ask(w, permission(w));
      const req = await requestOf(w);
      const c = checks.length;
      await gone(answer(w, req, "allow"));
      await sleep(100);
      assert.ok(stillOpen(w, req), what);
      assert.equal(checks.length, c, what + ": HQ's port is not asked");
      const lines = fs.readFileSync(path.join(w.dir, "answers.log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).source);
      assert.deepEqual(lines, [source], what);
      L.setLookup(lookup);
      answer(w, req, "deny");
      assert.equal(await soon(p), JSON.stringify(B.DENY), what + ": then HQ's answer counts");
    }
  } finally {
    L.setLookup(lookup);
  }
});

test("the lookup ahead: lookupFor reuses only a recent yes, for the same HQ still running and alone on its port (netstat); a no, a lookup that could not tell, an old yes, another HQ, or another process on the port is looked up again", async () => {
  const w = world(); // its HQ is this process, which listens on HQ_PORT (hqServer)
  const rt = JSON.parse(fs.readFileSync(path.join(w.dir, ".runtime.json"), "utf8"));
  const yes = (r = rt, at = Date.now()) => ({ rt: r, at, hq: Promise.resolve(true) });
  assert.deepEqual(await B.listeners(HQ_PORT), [process.pid], "netstat finds this process alone on HQ's port");
  const n = L.lookups.length;
  assert.equal(await B.lookupFor(rt, w.dir, yes()), true);
  assert.equal(L.lookups.length, n, "a recent yes for the same HQ, alone on its port: no lookup");
  // a port another process listens on: the port file names this process there, as after a takeover of the port
  const squat = spawn(process.execPath, ["-e", "require('net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port) })"], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const port = Number(await new Promise((r) => squat.stdout.once("data", (c) => r(String(c).trim()))));
    const taken = { ...rt, port };
    const dead = { ...rt, pid: DEAD };
    L.setPorts(() => [[HQ_PORT, process.pid], [port, squat.pid]]);
    for (const [what, now, primed] of [["a no", rt, { ...yes(), hq: Promise.resolve(false) }], ["could not tell", rt, { ...yes(), hq: Promise.resolve(null) }], ["an old yes", rt, yes(rt, Date.now() - B.PRIME_TTL - 1)], ["another start", rt, yes({ ...rt, startedAt: "x" })], ["its pid gone", dead, yes(dead)], ["another process on the port", taken, yes(taken)], ["none", rt, null]]) {
      const before = L.lookups.length;
      await B.lookupFor(now, w.dir, primed);
      assert.equal(L.lookups.length, before + 1, what + ": looked up again");
      assert.ok(L.lookups[before].includes(`ProcessId=${now.pid}'`) && L.lookups[before].includes(`-LocalPort ${now.port} `), what + ": for the port file as it is now");
    }
  } finally {
    squat.kill();
    L.setPorts(() => [[HQ_PORT, process.pid]]);
  }
});

test("the lookup ahead: it runs as the request is written, so the owner's answer acts with no lookup of its own; an HQ restarted since (a new start in its port file) is looked up again", async () => {
  const slow = (script) => new Promise((r) => setTimeout(() => r(lookup(script)), 600));
  try {
    {
      const w = world({ rows: [call(1)] });
      L.setLookup(slow);
      const p = ask(w, permission(w));
      const req = await requestOf(w);
      await sleep(800); // the lookup begun with the request is done
      const n = L.lookups.length;
      const t = Date.now();
      answer(w, req, "allow");
      assert.equal(await soon(p), JSON.stringify(B.ALLOW));
      assert.ok(Date.now() - t < (process.env.CI ? 1600 : 400), `the answer acted at once (${Date.now() - t} ms)`);
      assert.equal(L.lookups.length, n, "no lookup at the answer");
    }
    {
      const w = world({ rows: [call(1)] });
      L.setLookup(lookup);
      const p = ask(w, permission(w));
      const req = await requestOf(w);
      await sleep(200);
      const rtFp = path.join(w.dir, ".runtime.json");
      fs.writeFileSync(rtFp, JSON.stringify({ ...JSON.parse(fs.readFileSync(rtFp, "utf8")), startedAt: new Date(Date.now() + 1000).toISOString() }));
      const n = L.lookups.length;
      answer(w, req, "allow");
      assert.equal(await soon(p), JSON.stringify(B.ALLOW), "the restarted HQ, found by its own lookup");
      assert.equal(L.lookups.length, n + 1, "a lookup at the answer, the one ahead not reused");
    }
  } finally {
    L.setLookup(lookup);
  }
});

test("argvOf splits a Windows command line as the C runtime does", () => {
  const cases = [
    ['"C:\\Program Files\\nodejs\\node.exe" C:\\hq\\server.js', ["C:\\Program Files\\nodejs\\node.exe", "C:\\hq\\server.js"]],
    ['  node   "C:\\my dir\\server.js"\t--settings x  ', ["node", "C:\\my dir\\server.js", "--settings", "x"]],
    ['a\\\\\\"b "c\\\\" d', ['a\\"b', "c\\", "d"]],
    ["a\\b c\\\\d", ["a\\b", "c\\\\d"]],
    ['node "" x', ["node", "", "x"]],
    ['node C:\\a" "b\\server.js', ["node", "C:\\a b\\server.js"]],
    ["", []],
  ];
  for (const [cmd, argv] of cases) assert.deepEqual(B.argvOf(cmd), argv, cmd);
});

test("a process that is not a Windows node.exe by its full path is never HQ", () => {
  for (const [exe, cmd] of [["/usr/bin/node", "/usr/bin/node /hq/server.js"], [process.execPath, `node ${SERVER}`], ["/usr/bin/node.exe", `/usr/bin/node.exe ${SERVER}`]])
    assert.equal(B.hqProcess({ owners: [77], exe, cmd }, 77, path.join(__dirname, "..")), false, cmd);
});

// Windows paths in a Windows command line, compared without case: only Windows has them
test("hqProcess says yes only when every listener on the port is the pid .runtime.json names, running exactly what launch.js spawns (node, then the server.js beside the bridge) or that with one --settings file, its state folder the bridge's own", { skip: process.platform !== "win32" }, () => {
  const NODE = process.execPath;
  const APP = path.join(__dirname, ".."); // HQ's state folder when it runs with no settings file
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hq-bridge-"));
  roots.push(root);
  const mine = path.join(root, "state"), theirs = path.join(root, "other");
  fs.mkdirSync(mine);
  fs.mkdirSync(theirs);
  const settings = (name, s) => (fs.writeFileSync(path.join(root, name), JSON.stringify(s)), path.join(root, name));
  const MINE = settings("mine.json", { stateDir: "state" });
  const THEIRS = settings("theirs.json", { stateDir: "other" });
  const BAD = settings("bad.json", { stateDir: "state", nope: 1 });
  const yes = (cmd, dir = APP, over = {}) => B.hqProcess({ owners: [77], exe: NODE, cmd, ...over }, 77, dir);
  const up = (p) => p.replace(/\\/g, "/").toUpperCase();
  assert.equal(yes(`"${NODE}" ${SERVER}`), true, "what launch.js spawns");
  assert.equal(yes(`"${NODE}" "${SERVER}"`), true, "its path in quotes");
  assert.equal(yes(`"${up(NODE)}" ${up(SERVER)}`), true, "another case, forward slashes");
  assert.equal(yes(`"${NODE}" ${path.join(__dirname, "..", "lib", "..", "server.js")}`), true, "resolved");
  assert.equal(yes(`"${NODE}" ${SERVER}`, APP, { exe: NODE.toUpperCase() }), true, "the executable in another case");
  assert.equal(yes(`"${NODE}" ${SERVER}`, APP, { owners: [77, 77] }), true, "one pid on two addresses");
  assert.equal(yes(`"${NODE}" ${SERVER} --settings ${MINE}`, mine), true, "a settings file whose state folder is the bridge's");
  const no = [
    ["another owner", `"${NODE}" ${SERVER}`, APP, { owners: [78] }],
    ["two owners", `"${NODE}" ${SERVER}`, APP, { owners: [77, 78] }],
    ["no owner", `"${NODE}" ${SERVER}`, APP, { owners: [] }],
    ["owners not a list", `"${NODE}" ${SERVER}`, APP, { owners: 77 }],
    ["an owner as text", `"${NODE}" ${SERVER}`, APP, { owners: ["77"] }],
    ["not node", `"${NODE}" ${SERVER}`, APP, { exe: "C:\\tools\\evil.exe" }],
    ["no executable", `"${NODE}" ${SERVER}`, APP, { exe: null }],
    ["node.exe.bak", `"${NODE}" ${SERVER}`, APP, { exe: "C:\\tools\\node.exe.bak" }],
    ["the command line names another node", `"${NODE}" ${SERVER}`, APP, { exe: path.join(root, "node.exe") }],
    ["node by name, not by path", `node ${SERVER}`],
    ["another script", `"${NODE}" ${path.join(os.tmpdir(), "fake-hq.js")}`],
    ["a server.js elsewhere", `"${NODE}" ${path.join(os.tmpdir(), "server.js")}`],
    ["a relative path", `"${NODE}" server.js`],
    ["a dot path", `"${NODE}" .\\server.js`],
    ["a flag that loads code first", `"${NODE}" --require C:\\x\\evil.js ${SERVER}`],
    ["eval", `"${NODE}" -e "require('${up(SERVER)}')"`],
    ["no script", `"${NODE}"`],
    ["no command line", null],
    ["an argument after the script", `"${NODE}" ${SERVER} --inspect`],
    ["--settings with no file", `"${NODE}" ${SERVER} --settings`],
    ["an argument after the settings file", `"${NODE}" ${SERVER} --settings ${MINE} --x`],
    ["a settings file by a relative path", `"${NODE}" ${SERVER} --settings mine.json`, mine],
    ["a settings file that is not there", `"${NODE}" ${SERVER} --settings ${path.join(root, "none.json")}`, mine],
    ["a settings file HQ refuses", `"${NODE}" ${SERVER} --settings ${BAD}`, mine],
    ["another copy's state folder", `"${NODE}" ${SERVER} --settings ${THEIRS}`, mine],
    ["no settings file, the bridge's folder another", `"${NODE}" ${SERVER}`, mine],
    ["the bridge's folder not there", `"${NODE}" ${SERVER} --settings ${MINE}`, path.join(root, "gone")],
  ];
  for (const [what, cmd, dir, over] of no) assert.equal(yes(cmd, dir, over), false, what);
  assert.equal(B.hqProcess(null, 77, APP), false, "no lookup");
  assert.equal(B.hqProcess({ owners: [77], exe: NODE, cmd: `"${NODE}" ${SERVER}` }, 78, APP), false, "another pid in .runtime.json");
});

test("trimInput keeps a small input whole and cuts the longest string by code points", () => {
  assert.deepEqual(B.trimInput({ a: "b" }), { input: { a: "b" }, trimmed: false });
  const big = B.trimInput({ command: "😀".repeat(3000), description: "Run it" });
  assert.ok(big.trimmed && JSON.stringify(big.input).length <= 4000, String(JSON.stringify(big.input).length));
  assert.ok(big.input.command.isWellFormed() && big.input.command.endsWith("…") && big.input.description === "Run it");
  assert.deepEqual(B.trimInput(Object.fromEntries(Array.from({ length: 900 }, (_, i) => ["k" + i, i]))), { input: {}, trimmed: true }, "no string to cut");
});
