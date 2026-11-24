// The server with control on, in a child process: the token, the two POST routes and their refusal suite (403 for who
// asks, 400 for what they send, nothing written), the answer and its log line, the event stream (at once, then on
// change only), and the whole loop with the real bridge. Control off has no write route at all.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");
const { T0, asst, user, tool, jsonl, tapStub, asWindows } = require("./helpers");
const { hashOf, trimInput } = require("../bridge/hq-bridge");
const { riskOf } = require("../lib/describe");
const { spokenOf } = require("../lib/spoken");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server.js");
const BRIDGE = path.join(ROOT, "bridge", "hq-bridge.js");
const EXAMPLE = path.join(ROOT, "hq.config.example.json");
const FAKE = path.join(__dirname, "fake-lookup.cjs");
const { winNode, winPath } = require(FAKE);
const REAL_LOOKUP = { skip: process.platform !== "win32" && "the real lookup is Windows only" };
const S = "5e550000-0000-4000-8000-000000000001";
const RID = "ab".repeat(16);
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
// Every folder world() makes, removed once this file's tests end, and nothing else.
const roots = [];
test.after(async () => {
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const tmp = (p) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  roots.push(d);
  return d;
};
const nowSec = () => Math.round((Date.now() - T0) / 1000);
const readJson = (fp) => { try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A data folder with one live session named ada (its last row a Bash call still running), and a copy of the example
// config with `control` as given (left out when undefined) and any other config keys in `extra`.
function world(control, extra = {}) {
  const root = tmp("hq-control-");
  const proj = path.join(root, "data", "projects", "p1");
  fs.mkdirSync(proj, { recursive: true });
  const transcript = path.join(proj, S + ".jsonl");
  fs.writeFileSync(transcript, jsonl([{ type: "custom-title", customTitle: "ada", sessionId: S }, user({ sec: nowSec(), text: "go" }), asst({ sec: nowSec(), content: [{ ...tool("Bash", { command: "npm test", description: "Run the tests" }), id: "tu_call" }] })]));
  const config = JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));
  if (control !== undefined) config.control = control;
  Object.assign(config, extra);
  const configPath = path.join(root, "hq.config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const state = path.join(root, "state");
  const settings = path.join(root, "test.settings.json");
  fs.writeFileSync(settings, JSON.stringify({ dataDir: path.join(root, "data"), stateDir: state, configPath, port: 0, homeDir: root }));
  return { state, settings, transcript, configPath, data: path.join(root, "data"), folder: path.join(state, "decisions"), log: path.join(state, "answers.log.jsonl"), presence: path.join(state, ".hq-presence.json") };
}
async function until(fn, ms, what, proc) {
  const end = Date.now() + ms;
  for (;;) {
    if (proc.child.exitCode !== null) throw new Error(`the server exited (${proc.child.exitCode}) while waiting for ${what}: ${proc.err.text}`);
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(100);
  }
}
// One HTTP request: its status, body and headers once the response ends. A server that answers before the body is sent
// and closes the connection still gives its response; a connection that fails first reads as status 0.
function request(port, { method = "GET", path: p = "/", headers = {}, body, chunked = false } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on("error", (e) => resolve({ status: 0, body: e.code }));
    if (body === undefined) return r.end();
    if (chunked) {
      r.write(body.slice(0, 100)); // headers go out without a length: the body is chunked
      r.end(body.slice(100));
    } else r.end(body);
  });
}
async function start(w, { stub, env: more, windows = false } = {}) {
  const rtFile = path.join(w.state, ".runtime.json");
  try { fs.unlinkSync(rtFile); } catch {}
  const pre = [...(windows ? asWindows : []), ...(stub ? ["--require", stub.file] : [])];
  const env = { ...process.env, ...(stub ? { HQ_STUB_LOG: w.log, HQ_STUB_SWITCH: stub.switch, ...stub.env } : {}), ...more };
  const child = spawn(process.execPath, [...pre, SERVER, "--settings", w.settings], { stdio: ["ignore", "ignore", "pipe"], env });
  const proc = { child, err: { text: "" } };
  child.stderr.on("data", (c) => (proc.err.text += c));
  const rt = await until(() => { const r = readJson(rtFile); return r && r.pid === child.pid && r; }, 15000, "the port file", proc);
  await until(async () => { const b = await request(rt.port, { path: "/api/hq" }); return b.status === 200 && !JSON.parse(b.body).building; }, 30000, "the first index", proc);
  return { ...proc, rt, port: rt.port, token: null };
}
async function stop(s) {
  if (s.child.exitCode !== null) return;
  const gone = new Promise((r) => s.child.once("exit", r));
  s.child.kill();
  await gone;
}
const tokenOf = async (s) => (/<meta name="hq-token" content="([0-9a-f]{64})">/.exec((await request(s.port, { path: "/" })).body) || [])[1] || null;
const headers = (s, over = {}) => ({ Origin: `http://127.0.0.1:${s.port}`, "Content-Type": "application/json", "X-HQ-Token": s.token, ...over });
const post = (s, p, body, over = {}) => request(s.port, { method: "POST", path: p, headers: headers(s, over), body: typeof body === "string" ? body : JSON.stringify(body) });
const openIds = async (s) => JSON.parse((await request(s.port, { path: "/api/hq" })).body).decisions.map((d) => d.id);
// A request as the bridge writes it, from a live process (this test's), for the session ada, its hash sealed over its
// call (an `extra` with its own hash keeps that one); `raw` edits the file's text last, for a value JSON cannot carry.
function plant(w, extra = {}, raw = (t) => t) {
  fs.mkdirSync(w.folder, { recursive: true });
  const r = { v: 1, id: RID, pid: process.pid, askedAt: Date.now(), event: "PermissionRequest", sessionId: S, transcriptPath: w.transcript, agentId: null, agentType: null, toolName: "Bash", toolInput: { command: "npm test", description: "Run the tests" }, trimmed: false, toolUseId: null, cwd: "C:/work/quarry", ...extra };
  if (r.notice === true && !("movedAt" in extra)) r.movedAt = r.askedAt; // a notice as the bridge writes it says when it moved
  if (!("hash" in extra)) r.hash = hashOf(r);
  fs.writeFileSync(path.join(w.folder, r.id + ".json"), raw(JSON.stringify(r)));
  return r;
}
const openItems = async (s) => JSON.parse((await request(s.port, { path: "/api/hq" })).body).decisions;
const alertsOf = async (s) => JSON.parse((await request(s.port, { path: "/api/hq" })).body).alerts;
// The answers log, one object per line ([] while there is none)
const logLines = (w) => (fs.existsSync(w.log) ? fs.readFileSync(w.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const logLine = (o) => JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n";
// Until the server has run a refresh after this call (the payload's generatedAt moves), so every scan it owes has run
async function refreshed(s) {
  const generated = async () => JSON.parse((await request(s.port, { path: "/api/hq" })).body).generatedAt;
  const g = await generated();
  await until(async () => (await generated()) !== g, 6000, "a refresh", s);
}
// The bridge program: the real one with its real lookup on Windows; elsewhere, where it has none, as on Windows with a
// lookup that finds HQ as launch.js starts it (test/fake-lookup.cjs)
function spawnBridge(w) {
  const off = process.platform !== "win32";
  const fake = off ? { HQ_FAKE_LOOKUP: JSON.stringify({ owners: [readJson(path.join(w.state, ".runtime.json")).pid], exe: winNode, cmd: `"${winNode}" "${winPath(SERVER)}" --settings "${winPath(w.settings)}"` }) } : {};
  return spawn(process.execPath, [...(off ? ["--require", FAKE] : []), BRIDGE, "--state", w.state], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...fake } });
}
// The bridge program asking to run npm test in ada's chat (an HQ page must already have reported): its exit code and
// what it printed, once it has closed.
function asking(w) {
  const input = { session_id: S, transcript_path: w.transcript, cwd: "C:/work/quarry", permission_mode: "default", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test", description: "Run the tests" }, permission_suggestions: [] };
  const child = spawnBridge(w);
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => (out += c));
  const done = new Promise((r) => child.on("close", (code) => r({ code, out })));
  child.stdin.end(JSON.stringify(input));
  return { child, done };
}
// The event stream's messages as they arrive.
function events(s) {
  const got = [];
  const r = http.get({ host: "127.0.0.1", port: s.port, path: "/api/events" }, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (c) => {
      buf += c;
      for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block), data = /^data: (.+)$/m.exec(block);
        if (ev) got.push({ event: ev[1], data: JSON.parse(data[1]) });
      }
    });
  });
  r.on("error", () => {});
  return { got, close: () => r.destroy() };
}

test("with control on, each start serves a new 64-hex token in the page only, and its port file says control", async () => {
  const w = world(true);
  const seen = [];
  for (let i = 0; i < 2; i++) {
    const s = await start(w);
    try {
      assert.equal(s.rt.control, true);
      const page = (await request(s.port, { path: "/" })).body;
      const m = /<meta name="hq-token" content="([0-9a-f]{64})">/.exec(page);
      assert.ok(m, "the page carries the token");
      assert.equal(page.split("hq-token").length - 1, 1);
      assert.ok(!(await request(s.port, { path: "/api/hq" })).body.includes(m[1]), "and nothing else does");
      seen.push(m[1]);
    } finally {
      await stop(s);
    }
  }
  assert.notEqual(seen[0], seen[1]);
});

test("where the bridge cannot confirm an answer (not Windows), the page says so and a message to a chat is refused at once", async () => {
  const w = world(true);
  const pre = path.join(path.dirname(w.state), "linux.cjs");
  fs.writeFileSync(pre, 'Object.defineProperty(process, "platform", { value: "linux" });\n');
  for (const [stub, off] of [[{ file: pre, env: {} }, true], [undefined, process.platform !== "win32"]]) {
    const s = await start(w, { stub });
    try {
      s.token = await tokenOf(s);
      assert.ok(s.token, "control is still on");
      assert.equal((await request(s.port, { path: "/" })).body.includes('<meta name="hq-answers" content="off">'), off);
      const r = await post(s, "/api/send", { sessionId: S, text: "run the tests" });
      assert.equal(r.body.includes("Windows"), off, r.status + " " + r.body);
      if (off) assert.equal(r.status, 409);
    } finally {
      await stop(s);
    }
  }
});

test("both write routes refuse anyone but the page, and anything but small JSON, writing nothing", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    const H = plant(w).hash;
    await until(async () => (await openIds(s)).includes(RID), 10000, "the planted request", s);
    const bodies = { "/api/answer": { id: RID, choice: "allow", hash: H }, "/api/presence": { focused: true } };
    for (const route of Object.keys(bodies)) {
      const good = JSON.stringify(bodies[route]);
      const big = JSON.stringify({ ...bodies[route], pad: "x".repeat(5000) });
      const cases = [
        ["no token", { "X-HQ-Token": "" }, good, 403],
        ["a wrong token", { "X-HQ-Token": "0".repeat(64) }, good, 403],
        ["a short token", { "X-HQ-Token": "ab" }, good, 403],
        ["a wrong Origin", { Origin: "http://evil.example" }, good, 403],
        ["no Origin", { Origin: "" }, good, 403],
        ["the localhost Origin on 127.0.0.1", { Origin: `http://localhost:${s.port}` }, good, 403],
        ["a wrong Host", { Host: "evil.example" }, good, 403],
        ["a form", { "Content-Type": "application/x-www-form-urlencoded" }, "id=" + RID, 400],
        ["text/plain", { "Content-Type": "text/plain" }, good, 400],
        ["a declared 5,000-byte body", {}, big, 400],
        ["not JSON", {}, "{not json", 400],
      ];
      for (const [what, over, body, status] of cases) assert.equal((await post(s, route, body, over)).status, status, `${route}: ${what}`);
      const streamed = await request(s.port, { method: "POST", path: route, headers: headers(s), body: big, chunked: true });
      assert.equal(streamed.status, 400, `${route}: a streamed 5,000-byte body`);
      // a declared length over the cap is refused at once, before a byte of the body is sent (the streamed cap would
      // wait)
      const early = await new Promise((resolve) => {
        const r = http.request({ host: "127.0.0.1", port: s.port, method: "POST", path: route, headers: { Host: `127.0.0.1:${s.port}`, ...headers(s), "Content-Length": 5000 } }, (res) => {
          clearTimeout(timer);
          resolve(res.statusCode);
          r.destroy();
        });
        r.on("error", () => resolve(0));
        r.flushHeaders();
        const timer = setTimeout(() => {
          resolve("no answer in 2 s");
          r.destroy();
        }, 2000);
      });
      assert.equal(early, 400, `${route}: a declared 5,000-byte body with none sent`);
    }
    for (const [what, body, text] of [
      ["an unknown id", { id: "cd".repeat(16), choice: "allow" }, "not open"],
      ["an id that is a path", { id: "../../x", choice: "allow" }, "not open"],
      ["a reply id", { id: "reply:" + S, choice: "allow" }, "not open"],
      ["a choice that is not text", { id: RID, choice: 1 }, "not open"],
      ["always", { id: RID, choice: "always", hash: H }, "not offered"],
      ["opt:0 on a permission", { id: RID, choice: "opt:0", hash: H }, "not offered"],
      ["no hash", { id: RID, choice: "allow" }, "not what was shown"],
      ["another call's hash", { id: RID, choice: "allow", hash: "0".repeat(64) }, "not what was shown"],
      ["a revise with no note", { id: RID, choice: "revise", hash: H }, "note must be one line of 1 to 500 characters"],
      ["a revise with an empty note", { id: RID, choice: "revise", hash: H, note: "" }, "note must be one line of 1 to 500 characters"],
      ["a revise with a 501-character note", { id: RID, choice: "revise", hash: H, note: "x".repeat(501) }, "note must be one line of 1 to 500 characters"],
      ["a revise with two lines", { id: RID, choice: "revise", hash: H, note: "one\ntwo" }, "note must be one line of 1 to 500 characters"],
    ]) {
      const r = await post(s, "/api/answer", body);
      assert.deepEqual([r.status, r.body], [400, text], what);
    }
    assert.equal((await post(s, "/api/presence", { focused: "yes" })).status, 400);
    assert.equal((await post(s, "/api/presence", { focused: false, open: "no" })).status, 400);
    assert.equal((await post(s, "/api/other", { a: 1 })).status, 404);
    assert.deepEqual(fs.readdirSync(w.folder), [RID + ".json"], "no answer written");
    assert.ok(!fs.existsSync(w.log), "no log line");
    assert.ok(!fs.existsSync(w.presence), "no presence written");
    assert.deepEqual(await openIds(s), [RID], "the request is still open");
  } finally {
    await stop(s);
  }
});

test("an answer from the page is written with one log line; a second answer is refused", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    const H = plant(w).hash;
    await until(async () => (await openIds(s)).includes(RID), 10000, "the planted request", s);
    const r = await post(s, "/api/answer", { id: RID, choice: "deny", hash: H });
    assert.deepEqual([r.status, r.body], [200, '{"ok":true}']);
    const a = readJson(path.join(w.folder, RID + ".answer.json"));
    assert.deepEqual({ ...a, at: 0 }, { id: RID, sessionId: S, toolName: "Bash", choice: "deny", hash: H, at: 0 });
    const log = fs.readFileSync(w.log, "utf8");
    assert.deepEqual(log.trim().split("\n").map((l) => { const { at, ...rest } = JSON.parse(l); return rest; }), [{ id: RID, session: "ada", tool: "Bash", choice: "deny" }]);
    assert.ok(!log.includes("npm test"), "the log never holds the command");
    assert.deepEqual(await openIds(s), [], "answered, it leaves the payload at once");
    const again = await post(s, "/api/answer", { id: RID, choice: "allow", hash: H });
    assert.deepEqual([again.status, again.body], [400, "not open"]);
    assert.equal(fs.readFileSync(w.log, "utf8"), log, "still one line");
  } finally {
    await stop(s);
  }
});

test("an answer for a request whose bridge has just died is refused as not open, with no answer and no log line", async () => {
  const w = world(true);
  const s = await start(w);
  const bridge = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    s.token = await tokenOf(s);
    const H = plant(w, { pid: bridge.pid }).hash;
    await until(async () => (await openIds(s)).includes(RID), 10000, "the planted request", s);
    const gone = new Promise((r) => bridge.once("exit", r));
    bridge.kill(); // its file stays, so the folder watch has nothing to report; only the answer's own rescan sees it
    await gone;
    const r = await post(s, "/api/answer", { id: RID, choice: "allow", hash: H });
    assert.deepEqual([r.status, r.body], [400, "not open"]);
    assert.ok(!fs.existsSync(path.join(w.folder, RID + ".answer.json")), "no answer written");
    assert.ok(!fs.existsSync(w.log), "no log line");
  } finally {
    bridge.kill();
    await stop(s);
  }
});

test("Ask for changes from the page: the note reaches the answer file, and the log line gets only its length", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    const H = plant(w).hash;
    await until(async () => (await openIds(s)).includes(RID), 10000, "the planted request", s);
    const note = "use the staging folder, canary-note-7";
    const r = await post(s, "/api/answer", { id: RID, choice: "revise", hash: H, note });
    assert.deepEqual([r.status, r.body], [200, '{"ok":true}']);
    const a = readJson(path.join(w.folder, RID + ".answer.json"));
    assert.deepEqual({ ...a, at: 0 }, { id: RID, sessionId: S, toolName: "Bash", choice: "revise", hash: H, note, at: 0 });
    const log = fs.readFileSync(w.log, "utf8");
    const { at, ...line } = JSON.parse(log);
    assert.deepEqual(line, { id: RID, session: "ada", tool: "Bash", choice: "revise", noteLength: 37 });
    assert.ok(!log.includes("canary-note-7"), "the log never holds the note");
  } finally {
    await stop(s);
  }
});

test("a malformed request file never stops the server: it is never shown, and the good one beside it is", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    const good = plant(w);
    plant(w, { id: "e1".repeat(16), agentId: "a0123456789abcdef", agentType: 7 }); // a type the agent matcher cannot read
    plant(w, { id: "e2".repeat(16) }, (t) => t.replace(/"askedAt":\d+/, '"askedAt":1e400')); // JSON reads it as Infinity
    plant(w, { id: "e3".repeat(16), toolInput: { command: "rm -rf /", description: "Run the tests" }, hash: good.hash }); // rewritten under another call's hash
    await until(async () => (await openIds(s)).includes(RID), 10000, "the good request", s);
    await sleep(500); // more than one folder-watch pass
    assert.deepEqual(await openIds(s), [RID]);
    assert.equal(s.child.exitCode, null, "the server still runs");
    assert.equal((await request(s.port, { path: "/api/hq" })).status, 200);
  } finally {
    await stop(s);
  }
});

test("the folder is watched: a request shows within 2 s of landing, before the next 4 s refresh could show it", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    // a refresh has just run when the payload's generatedAt moves, so the next one is about 4 s away
    const generated = async () => JSON.parse((await request(s.port, { path: "/api/hq" })).body).generatedAt;
    const g = await generated();
    await until(async () => (await generated()) !== g, 6000, "a refresh", s);
    plant(w);
    await until(async () => (await openIds(s)).includes(RID), 2000, "the request, ahead of the next refresh", s);
  } finally {
    await stop(s);
  }
});

test("presence from the page is written with its time: open unless the page says it closed", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    const r = await post(s, "/api/presence", { focused: true });
    assert.deepEqual([r.status, r.body], [200, '{"ok":true}']);
    const p = readJson(w.presence);
    assert.ok(p.focused === true && p.open === true && Math.abs(p.at - Date.now()) < 5000, JSON.stringify(p));
    assert.equal((await post(s, "/api/presence", { focused: false, open: false })).status, 200);
    const q = readJson(w.presence);
    assert.ok(q.focused === false && q.open === false && Math.abs(q.at - Date.now()) < 5000, JSON.stringify(q));
  } finally {
    await stop(s);
  }
});

// The payload from its first comma on (generatedAt left out), as the stream compares it
const bodyOf = async (s) => { const t = (await request(s.port, { path: "/api/hq" })).body; return t.slice(t.indexOf(",")); };
// A quiet point: the same payload on two polls 150 ms apart with no stream message between them, so every message for an
// earlier change has arrived (a loopback write lands well inside 150 ms) and counting starts clean
async function settled(s, ev) {
  for (;;) {
    const a = await bodyOf(s), n = ev.got.length;
    await sleep(150);
    const b = await bodyOf(s);
    if (a === b && ev.got.length === n) return { body: b, n };
  }
}

test("the event stream sends the open ids at once, then decisions and hq only when they change", async () => {
  const w = world(true);
  const s = await start(w);
  const ev = events(s);
  try {
    await until(() => ev.got.length >= 1, 5000, "the first message", s);
    assert.deepEqual(ev.got[0], { event: "decisions", data: { count: 0, ids: [] } });
    // the oracle: between two quiet points, the payload polled every 250 ms for 6 s (at least one 4 s refresh); a change
    // a poll sees waits for its own hq message before the next poll, so no count depends on which socket is read first,
    // and the closing quiet point counts a change the last poll missed
    const hqSince = (from) => ev.got.slice(from).filter((e) => e.event === "hq").length;
    let q = await settled(s, ev);
    const first = q.n;
    let last = q.body, changes = 0;
    for (const end = Date.now() + 6000; Date.now() < end; await sleep(250)) {
      const b = await bodyOf(s);
      if (b === last) continue;
      last = b;
      changes++;
      const want = changes;
      await until(() => hqSince(first) >= want, 2000, "the hq message for a payload change", s);
    }
    q = await settled(s, ev);
    if (q.body !== last) changes++;
    assert.equal(ev.got.slice(first, q.n).filter((e) => e.event === "hq").length, changes, `one hq message per payload change (${changes} seen), none for a refresh that changed nothing`);
    assert.equal(ev.got.filter((e) => e.event === "decisions").length, 1, "no change in the set, no decisions message");
    const before = ev.got.length;
    plant(w);
    await until(() => ev.got.slice(before).some((e) => e.event === "decisions"), 6000, "a decisions message for the new request", s);
    assert.deepEqual(ev.got.slice(before).find((e) => e.event === "decisions").data, { count: 1, ids: [RID] });
    await until(() => hqSince(before) >= 1, 2000, "an hq message for the new request", s);
  } finally {
    ev.close();
    await stop(s);
  }
});

test("the whole loop: the bridge asks, the page answers, the bridge prints the allow and leaves nothing", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    assert.equal((await post(s, "/api/presence", { focused: true })).status, 200);
    const input = { session_id: S, transcript_path: w.transcript, cwd: "C:/work/quarry", permission_mode: "default", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test", description: "Run the tests" }, permission_suggestions: [] };
    const bridge = spawnBridge(w);
    let out = "";
    bridge.stdout.on("data", (c) => (out += c));
    const exit = new Promise((r) => bridge.on("exit", r));
    bridge.stdin.end(JSON.stringify(input));
    const item = await until(async () => (await openItems(s)).find((d) => /^[0-9a-f]{32}$/.test(d.id)), 10000, "the bridge's request in the payload", s);
    const answer = () => post(s, "/api/answer", { id: item.id, choice: "allow", hash: item.hash });
    assert.equal((await answer()).status, 200);
    // on a slow machine the bridge's check can run out of time: it drops that answer, says so in the log, and the owner
    // answers again
    const log = path.join(w.state, "answers.log.jsonl");
    const dropped = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l.includes('"unchecked"')).length : 0);
    const ansFp = path.join(w.folder, item.id + ".answer.json");
    for (let again = 0, done = false; !done && again < 3; ) {
      done = await Promise.race([exit.then(() => true), sleep(200).then(() => false)]);
      if (!done && dropped() > again && !fs.existsSync(ansFp)) {
        again++;
        await answer();
      }
    }
    assert.equal(await exit, 0);
    assert.equal(out, ALLOW + "\n");
    assert.deepEqual(fs.readdirSync(w.folder), []);
  } finally {
    await stop(s);
  }
});

test("the event stream answers the page's own origin only: another Origin, or a cross-site or same-site fetch, is refused", async () => {
  const w = world(true);
  const s = await start(w);
  // the status of one GET with these headers, then the connection is dropped (a stream never ends by itself)
  const statusOf = (headers) => new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port: s.port, path: "/api/events", headers }, (res) => { resolve(res.statusCode); r.destroy(); });
    r.on("error", () => resolve(0));
  });
  try {
    assert.equal(await statusOf({ Origin: "http://evil.example" }), 403, "another site's Origin");
    assert.equal(await statusOf({ Origin: "null" }), 403, "an opaque Origin");
    assert.equal(await statusOf({ "Sec-Fetch-Site": "cross-site" }), 403, "a cross-site fetch with no Origin");
    assert.equal(await statusOf({ "Sec-Fetch-Site": "same-site" }), 403, "a same-site fetch (another port on this host)");
    assert.equal(await statusOf({ Origin: "http://127.0.0.1:" + s.port, "Sec-Fetch-Site": "same-origin" }), 200, "the page's own origin");
    assert.equal(await statusOf({ "Sec-Fetch-Site": "same-origin" }), 200, "a same-origin EventSource, which sends no Origin");
    assert.equal(await statusOf({}), 200, "a program with neither header");
  } finally {
    await stop(s);
  }
});

test("at most 8 event streams are open at once: a ninth is refused with 503 until one closes", async () => {
  const w = world(true);
  const s = await start(w);
  const open = [];
  // the status of one GET, then the connection is dropped (a stream never ends by itself)
  const statusOf = (p) => new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port: s.port, path: p }, (res) => { resolve(res.statusCode); r.destroy(); });
    r.on("error", () => resolve(0));
  });
  try {
    for (let i = 0; i < 8; i++) {
      const ev = events(s);
      open.push(ev);
      await until(() => ev.got.length >= 1, 5000, "stream " + (i + 1), s);
    }
    assert.equal(await statusOf("/api/events"), 503);
    open.pop().close();
    await until(async () => (await statusOf("/api/events")) === 200, 5000, "a free stream after one closed", s);
  } finally {
    for (const ev of open) ev.close();
    await stop(s);
  }
});

test("with control off or absent there is no write route, no token and no decisions folder; the stream still answers", async () => {
  for (const control of [false, undefined]) {
    const w = world(control);
    const s = await start(w);
    try {
      assert.equal(s.rt.control, false, String(control));
      assert.ok(!(await request(s.port, { path: "/" })).body.includes("hq-token"));
      s.token = "ab".repeat(32);
      assert.equal((await post(s, "/api/answer", { id: RID, choice: "allow" })).status, 405);
      assert.equal((await post(s, "/api/presence", { focused: true })).status, 405);
      const refused = await post(s, "/api/answer", { id: RID, choice: "allow" });
      assert.deepEqual([refused.headers.allow, refused.headers.connection], ["GET, HEAD", "close"], "its 405 lists GET and HEAD as today, and closes the connection");
      assert.ok(!fs.existsSync(w.folder) && !fs.existsSync(w.presence));
      assert.deepEqual(await alertsOf(s), [], "no alerts with control off");
      const ev = events(s);
      await until(() => ev.got.length >= 1, 5000, "the stream's first message", s);
      assert.deepEqual(ev.got[0], { event: "decisions", data: { count: 0, ids: [] } });
      ev.close();
    } finally {
      await stop(s);
    }
  }
});

test("nothing HQ answers can be framed: the page, the payload, a refusal and the event stream all forbid it", async () => {
  const w = world(true);
  const s = await start(w);
  // the headers of one GET on the event stream, then the connection is dropped (a stream never ends by itself)
  const streamHeaders = () => new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port: s.port, path: "/api/events" }, (res) => { resolve(res.headers); r.destroy(); });
    r.on("error", () => resolve({}));
  });
  try {
    const refused = await request(s.port, { path: "/", headers: { Host: "evil.example" } });
    assert.equal(refused.status, 403);
    const answers = { "the page": (await request(s.port, { path: "/" })).headers, "the payload": (await request(s.port, { path: "/api/hq" })).headers, "a 403": refused.headers, "the event stream": await streamHeaders() };
    for (const [what, h] of Object.entries(answers)) {
      assert.equal(h["x-frame-options"], "DENY", what);
      assert.equal(h["content-security-policy"], "frame-ancestors 'none'", what);
    }
  } finally {
    await stop(s);
  }
});

test("a refused POST closes its connection wherever it is refused, an accepted one does not, and a 405 lists POST", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    const put = await request(s.port, { method: "PUT", path: "/" });
    assert.deepEqual([put.status, put.headers.allow], [405, "GET, HEAD, POST"]);
    for (const [what, over] of [["a wrong token", { "X-HQ-Token": "0".repeat(64) }], ["text/plain", { "Content-Type": "text/plain" }], ["a wrong Host", { Host: "evil.example" }]]) {
      const r = await post(s, "/api/presence", { focused: true }, over);
      assert.ok(r.status >= 400 && r.status < 500, what);
      assert.equal(r.headers.connection, "close", what);
    }
    const ok = await post(s, "/api/presence", { focused: true });
    assert.equal(ok.status, 200);
    assert.notEqual(ok.headers.connection, "close", "an accepted POST keeps its connection");
  } finally {
    await stop(s);
  }
});

test("a body that trickles past 5 s gets 408 too slow, the server closes the socket, and nothing is written", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    const H = plant(w).hash;
    await until(async () => (await openIds(s)).includes(RID), 10000, "the planted request", s);
    const body = JSON.stringify({ id: RID, choice: "deny", hash: H }); // whole, it is a good answer
    const t0 = Date.now();
    const got = await new Promise((resolve) => {
      const sock = net.connect(s.port, "127.0.0.1");
      let text = "", sent = 0;
      const done = (how) => {
        clearInterval(tick);
        clearTimeout(cap);
        resolve({ text, how });
      };
      const tick = setInterval(() => (sent < body.length ? sock.write(body[sent++]) : clearInterval(tick)), 50); // one byte every 50 ms: over 6 s in all
      const cap = setTimeout(() => {
        done("still open after 9 s");
        sock.destroy();
      }, 9000);
      sock.on("data", (c) => (text += c));
      sock.on("close", () => done("closed by the server"));
      sock.on("error", () => {});
      sock.write(`POST /api/answer HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nOrigin: http://127.0.0.1:${s.port}\r\nX-HQ-Token: ${s.token}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`);
    });
    assert.equal(got.how, "closed by the server");
    assert.match(got.text, /^HTTP\/1\.1 408 /);
    assert.match(got.text, /\r\nconnection: close\r\n/i);
    assert.match(got.text, /\r\n\r\n(?:8\r\n)?too slow(?:\r\n0\r\n\r\n)?$/, "the body says too slow, with or without chunked framing");
    await sleep(Math.max(0, t0 + body.length * 50 + 500 - Date.now())); // past the time the whole body would have landed
    assert.ok(!fs.existsSync(path.join(w.folder, RID + ".answer.json")), "no answer written");
    assert.ok(!fs.existsSync(w.log), "no log line");
    assert.deepEqual(await openIds(s), [RID], "the request is still open");
  } finally {
    await stop(s);
  }
});

test("a body that is not valid UTF-8, or starts with a byte order mark, is refused as bad JSON, writing nothing", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    const H = plant(w).hash;
    await until(async () => (await openIds(s)).includes(RID), 10000, "the planted request", s);
    const head = Buffer.from(`{"id":"${RID}","choice":"revise","hash":"${H}","note":"use `), tail = Buffer.from(' here"}');
    for (const [what, body] of [
      ["a note holding byte 0xFF", Buffer.concat([head, Buffer.from([0xff]), tail])],
      ["a byte order mark before good JSON", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), head, Buffer.from("this"), tail])],
    ]) {
      const r = await request(s.port, { method: "POST", path: "/api/answer", headers: headers(s), body });
      assert.deepEqual([r.status, r.body], [400, "bad JSON"], what);
    }
    assert.deepEqual(fs.readdirSync(w.folder), [RID + ".json"], "no answer written");
    assert.ok(!fs.existsSync(w.log), "no log line");
  } finally {
    await stop(s);
  }
});

test("a watch that fails is reported in one line naming no path, and the next refresh watches the folder again", async () => {
  const w = world(true);
  const s = await start(w);
  const generated = async () => JSON.parse((await request(s.port, { path: "/api/hq" })).body).generatedAt;
  try {
    await until(() => fs.existsSync(w.folder), 5000, "the decisions folder", s);
    fs.rmSync(w.folder, { recursive: true }); // on Windows a deleted folder floods its watch with events and never raises an error
    await until(() => s.err.text.includes("\n"), 5000, "the watch's log line", s);
    // a refresh has just run when the payload's generatedAt moves: it watches the folder again, made anew
    const g = await generated();
    await until(async () => (await generated()) !== g, 6000, "a refresh", s);
    assert.ok(fs.existsSync(w.folder), "the refresh made the folder again");
    plant(w);
    await until(async () => (await openIds(s)).includes(RID), 2000, "the request, through the new watch", s);
    const lines = s.err.text.trim().split("\n");
    assert.equal(lines.length, 1, "one line: " + s.err.text);
    assert.match(lines[0], /watch/);
    assert.ok(!/[\\/]/.test(lines[0]), "the line names no path: " + lines[0]);
  } finally {
    await stop(s);
  }
});

test("a Risky item is answered from HQ: an allow needs the second click's confirm: true, on a call Risky on its own or marked risky by the bridge; without it the allow is refused, writing nothing; Deny and Ask for changes take one", async () => {
  const PUSH = { command: "git push origin main", description: "Push the branch" };
  assert.equal(riskOf("Bash", PUSH, false, "C:/work/quarry").level, "high");
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    const [R1, R2, R3, R4] = ["a1", "a2", "a3", "a4"].map((x) => x.repeat(16));
    const own = plant(w, { id: R1, toolInput: PUSH });
    const marked = plant(w, { id: R2, risky: true }); // npm test, Check first in its kept copy, Risky on the full call
    const deny = plant(w, { id: R3, toolInput: PUSH });
    const revise = plant(w, { id: R4, toolInput: PUSH });
    await until(async () => (await openIds(s)).length === 4, 10000, "the four planted requests", s);
    const byId = Object.fromEntries((await openItems(s)).map((d) => [d.id, d]));
    assert.deepEqual([byId[R1].risk.level, byId[R2].risk.level, byId[R2].risk.reason], ["high", "high", "rated Risky on the full call"]);
    for (const r of [own, marked])
      for (const confirm of [undefined, false, "yes", 1]) {
        const res = await post(s, "/api/answer", { id: r.id, hash: r.hash, choice: "allow", ...(confirm === undefined ? {} : { confirm }) });
        assert.deepEqual([res.status, res.body], [400, "confirm first"], r.id.slice(0, 2) + " " + JSON.stringify(confirm));
      }
    assert.deepEqual(fs.readdirSync(w.folder).sort(), [R1, R2, R3, R4].map((x) => x + ".json").sort(), "no answer written");
    assert.ok(!fs.existsSync(w.log), "no log line");
    for (const [r, body] of [[own, { choice: "allow", confirm: true }], [marked, { choice: "allow", confirm: true }], [deny, { choice: "deny" }], [revise, { choice: "revise", note: "push to a branch instead" }]]) {
      const res = await post(s, "/api/answer", { id: r.id, hash: r.hash, ...body });
      assert.deepEqual([res.status, res.body], [200, '{"ok":true}'], r.id.slice(0, 2) + " " + body.choice);
      assert.equal(readJson(path.join(w.folder, r.id + ".answer.json")).choice, body.choice);
    }
  } finally {
    await stop(s);
  }
});

test("a plan approval and a question of any shape are answered from HQ: Keep planning with a plain note, Approve in one click; picks that fit every question, carried in the answer file, and none that do not", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    const SIZES = { question: "Which sizes?", header: "Sizes", options: [{ label: "S" }, { label: "M" }, { label: "L" }], multiSelect: true };
    const COLOR = { question: "Which color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false };
    const [P1, P2, Q1] = ["b1", "b2", "c1"].map((x) => x.repeat(16));
    const plan = plant(w, { id: P1, toolName: "ExitPlanMode", toolInput: { plan: "1. Add the route" } });
    const plan2 = plant(w, { id: P2, toolName: "ExitPlanMode", toolInput: { plan: "2. Ship it" } });
    const q = plant(w, { id: Q1, event: "PreToolUse", toolName: "AskUserQuestion", toolUseId: "toolu_q1", toolInput: { questions: [COLOR, SIZES] } });
    await until(async () => (await openIds(s)).length === 3, 10000, "the three planted requests", s);
    for (const [r, body, why] of [
      [plan, { choice: "deny" }, "not offered"], [plan, { choice: "revise", note: "" }, "note must be one line of 1 to 500 characters"], [plan, { choice: "revise", note: "two" + String.fromCharCode(10) + "lines" },"note must be one line of 1 to 500 characters"],
      [q, { choice: "opt:0" }, "not offered"], [q, { choice: "picks" }, "picks do not fit"], [q, { choice: "picks", picks: [[1]] }, "picks do not fit"], [q, { choice: "picks", picks: [[0, 1], [0]] }, "picks do not fit"],
      [q, { choice: "picks", picks: [[1], [2, 0]] }, "picks do not fit"], [q, { choice: "picks", picks: [[1], [3]] }, "picks do not fit"], [q, { choice: "picks", picks: [[1], []] }, "picks do not fit"],
    ]) {
      const res = await post(s, "/api/answer", { id: r.id, hash: r.hash, ...body });
      assert.deepEqual([res.status, res.body], [400, why], r.id.slice(0, 2) + " " + JSON.stringify(body));
    }
    assert.deepEqual(fs.readdirSync(w.folder).sort(), [P1, P2, Q1].map((x) => x + ".json").sort(), "no answer written");
    for (const [r, body] of [[plan, { choice: "revise", note: "Add tests first" }], [plan2, { choice: "allow" }], [q, { choice: "picks", picks: [[1], [0, 2]] }]]) {
      const res = await post(s, "/api/answer", { id: r.id, hash: r.hash, ...body });
      assert.deepEqual([res.status, res.body], [200, '{"ok":true}'], r.id.slice(0, 2) + " " + body.choice);
    }
    const a = readJson(path.join(w.folder, Q1 + ".answer.json"));
    assert.deepEqual([a.choice, a.picks, a.hash], ["picks", [[1], [0, 2]], q.hash]);
    assert.deepEqual([readJson(path.join(w.folder, P1 + ".answer.json")).note, readJson(path.join(w.folder, P2 + ".answer.json")).choice], ["Add tests first", "allow"]);
    assert.ok(!fs.readFileSync(w.log, "utf8").includes("Add tests first"), "the log line never holds the note");
  } finally {
    await stop(s);
  }
});

test("a forged answer file approves nothing: the real bridge asks HQ, HQ says no and raises one alert, logged as outside VibeQuarters once; the request shows again, and the owner's answer from the page then counts", async () => {
  const w = world(true);
  const s = await start(w);
  let b = null;
  try {
    s.token = await tokenOf(s);
    assert.equal((await post(s, "/api/presence", { focused: true })).status, 200); // an HQ page is open
    b = asking(w);
    const item = await until(async () => (await openItems(s)).find((d) => /^[0-9a-f]{32}$/.test(d.id)), 10000, "the bridge's request in the payload", s);
    // another program reads the request file and writes the answer the server would, straight into the folder
    const req = readJson(path.join(w.folder, item.id + ".json"));
    const fp = path.join(w.folder, item.id + ".answer.json");
    fs.writeFileSync(fp + ".tmp", JSON.stringify({ id: req.id, sessionId: req.sessionId, toolName: req.toolName, choice: "allow", hash: req.hash, at: Date.now() }));
    fs.renameSync(fp + ".tmp", fp);
    const alerts = await until(async () => { const a = await alertsOf(s); return a && a.length ? a : null; }, 6000, "the alert", s);
    assert.ok(Math.abs(alerts[0].at - Date.now()) < 10e3, String(alerts[0].at));
    assert.deepEqual(alerts.map((a) => ({ ...a, at: 0 })), [{ at: 0, id: item.id, sessionName: "ada", toolName: "Bash" }]);
    await until(async () => !fs.existsSync(fp) && (await openIds(s)).includes(item.id), 6000, "the forged file gone and the request shown again", s);
    assert.equal(b.child.exitCode, null, "the bridge acted on nothing and waits on");
    const lines = logLines(w);
    assert.deepEqual(lines.map(({ at, ...rest }) => rest), [{ id: item.id, session: "ada", tool: "Bash", source: "outside VibeQuarters" }]);
    assert.ok(/Z$/.test(lines[0].at), lines[0].at);
    const err = s.err.text.trim().split("\n");
    assert.equal(err.length, 1, "one line: " + s.err.text);
    assert.match(err[0], /outside VibeQuarters/);
    assert.ok(!/[\\/]/.test(err[0]), "the line names no path: " + err[0]);
    // the owner's own answer: HQ wrote it, the check says yes, the bridge acts
    assert.equal((await post(s, "/api/answer", { id: item.id, choice: "allow", hash: item.hash })).status, 200);
    assert.deepEqual(await b.done, { code: 0, out: ALLOW + "\n" });
    await refreshed(s);
    assert.equal((await alertsOf(s)).length, 1, "no second alert");
    assert.deepEqual(logLines(w).map((l) => l.source || "HQ"), ["outside VibeQuarters", "HQ", "bridge"]);
  } finally {
    if (b) b.child.kill();
    await stop(s);
  }
});

test("the check says yes only for the exact answer HQ wrote in this run, needs no token, refuses a browser's request (an Origin or a fetch site), and changes no file", async () => {
  const w = world(true);
  let s = await start(w);
  const verify = (body, over = {}) => request(s.port, { method: "POST", path: "/api/verify", headers: { "Content-Type": "application/json", ...over }, body: JSON.stringify(body) });
  try {
    s.token = await tokenOf(s);
    const r = plant(w);
    await until(async () => (await openIds(s)).includes(RID), 10000, "the planted request", s);
    const mine = { id: RID, hash: r.hash, choice: "revise", note: "use staging" };
    assert.deepEqual((await verify(mine)).body, '{"wrote":false}', "nothing written yet");
    assert.equal((await post(s, "/api/answer", { ...mine })).status, 200);
    const files = fs.readdirSync(w.folder).sort();
    assert.deepEqual([(await verify(mine)).status, (await verify(mine)).body], [200, '{"wrote":true}']);
    assert.deepEqual((await verify({ ...mine, sessionId: S, toolName: "Bash" })).body, '{"wrote":true}', "whose request it is does not count");
    for (const other of [{ choice: "allow", note: undefined }, { note: "push to main" }, { hash: "0".repeat(64) }, { id: "cd".repeat(16) }])
      assert.deepEqual((await verify({ ...mine, ...other })).body, '{"wrote":false}', JSON.stringify(other));
    for (const over of [{ Origin: "http://127.0.0.1:" + s.port }, { Origin: "https://evil.example" }, { "Sec-Fetch-Site": "same-origin" }])
      assert.equal((await verify(mine, over)).status, 403, JSON.stringify(over));
    assert.deepEqual(fs.readdirSync(w.folder).sort(), files, "the check changes no file");
    // a restart forgets every answer: the same check is a no
    await stop(s);
    s = await start(w);
    assert.deepEqual((await verify(mine)).body, '{"wrote":false}', "after a restart");
  } finally {
    await stop(s);
  }
});

test("the real bridge asks only the real HQ: with .runtime.json rewritten to name another server, the lookup finds that it is not HQ's server.js, nothing asks it, the answer is removed and HQ raises the alert once; with the file restored the owner's answer counts", REAL_LOOKUP, async () => {
  const w = world(true);
  const s = await start(w);
  let b = null;
  const asked = [];
  const forger = http.createServer((req, res) => {
    asked.push(req.url);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"wrote":true}');
  });
  await new Promise((r) => forger.listen(0, "127.0.0.1", r));
  const rtFp = path.join(w.state, ".runtime.json");
  try {
    s.token = await tokenOf(s);
    assert.equal((await post(s, "/api/presence", { focused: true })).status, 200); // an HQ page is open
    b = asking(w);
    const item = await until(async () => (await openItems(s)).find((d) => /^[0-9a-f]{32}$/.test(d.id)), 10000, "the bridge's request in the payload", s);
    const real = fs.readFileSync(rtFp, "utf8");
    // another program points the port file at its own server, which says yes to every check, and writes the answer
    fs.writeFileSync(rtFp, JSON.stringify({ pid: process.pid, port: forger.address().port, startedAt: new Date().toISOString(), control: true }));
    const req = readJson(path.join(w.folder, item.id + ".json"));
    const fp = path.join(w.folder, item.id + ".answer.json");
    fs.writeFileSync(fp + ".tmp", JSON.stringify({ id: req.id, sessionId: req.sessionId, toolName: req.toolName, choice: "allow", hash: req.hash, at: Date.now() }));
    fs.renameSync(fp + ".tmp", fp);
    const t = Date.now();
    await until(async () => !fs.existsSync(fp), 30000, "the answer removed", s);
    const took = Date.now() - t;
    const alerts = await until(async () => { const a = await alertsOf(s); return a && a.length ? a : null; }, 6000, "the alert", s);
    assert.deepEqual(alerts.map((a) => ({ ...a, at: 0 })), [{ at: 0, id: item.id, sessionName: "ada", toolName: "Bash" }]);
    await until(async () => (await openIds(s)).includes(item.id), 6000, "the request shown again", s);
    assert.equal(b.child.exitCode, null, "the bridge acted on nothing and waits on");
    assert.deepEqual(asked, [], "the other server is never asked");
    assert.deepEqual(logLines(w).map((l) => l.source), ["unconfirmed", "outside VibeQuarters"]);
    const err = s.err.text.trim().split("\n");
    assert.equal(err.length, 1, "one line: " + s.err.text);
    assert.match(err[0], /nothing acted on it/);
    // the port file names HQ again: the lookup finds HQ's server.js, HQ says it wrote the owner's answer, the bridge acts
    fs.writeFileSync(rtFp, real);
    assert.equal((await post(s, "/api/answer", { id: item.id, choice: "allow", hash: item.hash })).status, 200);
    const t2 = Date.now();
    assert.deepEqual(await b.done, { code: 0, out: ALLOW + "\n" });
    console.log(`lookup: a forged port refused in ${took} ms, HQ's answer acted on in ${Date.now() - t2} ms`);
    await refreshed(s);
    assert.equal((await alertsOf(s)).length, 1, "no second alert");
  } finally {
    if (b) b.child.kill();
    forger.close();
    await stop(s);
  }
});

test("a second, genuine HQ run with its own settings file is not this bridge's HQ: its answer, written by it and copied in, approves nothing, though it would say it wrote it", REAL_LOOKUP, async () => {
  const w = world(true), w2 = world(true);
  const s = await start(w);
  let s2 = null, b = null;
  const rtFp = path.join(w.state, ".runtime.json");
  try {
    s2 = await start(w2);
    s.token = await tokenOf(s);
    s2.token = await tokenOf(s2);
    assert.equal((await post(s, "/api/presence", { focused: true })).status, 200); // an HQ page is open
    b = asking(w);
    const item = await until(async () => (await openItems(s)).find((d) => /^[0-9a-f]{32}$/.test(d.id)), 10000, "the bridge's request in the payload", s);
    // the request copied into the second HQ's folder, answered there through its own page's route
    fs.mkdirSync(w2.folder, { recursive: true });
    fs.copyFileSync(path.join(w.folder, item.id + ".json"), path.join(w2.folder, item.id + ".json"));
    await until(async () => (await openIds(s2)).includes(item.id), 10000, "the copy in the second HQ", s2);
    assert.equal((await post(s2, "/api/answer", { id: item.id, choice: "allow", hash: item.hash })).status, 200);
    const answer = fs.readFileSync(path.join(w2.folder, item.id + ".answer.json"), "utf8");
    const verify = await request(s2.port, { method: "POST", path: "/api/verify", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id, hash: item.hash, choice: "allow" }) });
    assert.equal(verify.body, '{"wrote":true}', "the second HQ would say yes");
    // the port file names the second HQ, and its answer lands in this folder
    const real = fs.readFileSync(rtFp, "utf8");
    fs.writeFileSync(rtFp, JSON.stringify({ ...JSON.parse(real), pid: s2.rt.pid, port: s2.port }));
    const fp = path.join(w.folder, item.id + ".answer.json");
    fs.writeFileSync(fp + ".tmp", answer);
    fs.renameSync(fp + ".tmp", fp);
    await until(async () => !fs.existsSync(fp), 30000, "the answer removed", s);
    await until(async () => { const a = await alertsOf(s); return a && a.length ? a : null; }, 6000, "the alert", s);
    assert.equal(b.child.exitCode, null, "the bridge acted on nothing and waits on");
    assert.deepEqual(logLines(w).map((l) => l.source), ["unconfirmed", "outside VibeQuarters"]);
    fs.writeFileSync(rtFp, real);
    await until(async () => (await openIds(s)).includes(item.id), 6000, "the request shown again", s);
    assert.equal((await post(s, "/api/answer", { id: item.id, choice: "deny", hash: item.hash })).status, 200);
    assert.equal((await b.done).code, 0);
  } finally {
    if (b) b.child.kill();
    if (s2) await stop(s2);
    await stop(s);
  }
});

test("HQ alerts once for each request the bridge logs as unconfirmed, also after a forged answer's alert for it, never for such a line from before the start", async () => {
  const w = world(true);
  const [OLD, NEW, BOTH] = ["d1", "d2", "d3"].map((h) => h.repeat(16));
  fs.mkdirSync(w.state, { recursive: true });
  fs.writeFileSync(w.log, logLine({ id: OLD, sessionId: S, tool: "Bash", choice: "allow", source: "unconfirmed" }));
  const s = await start(w);
  try {
    fs.appendFileSync(w.log, logLine({ id: NEW, sessionId: S, tool: "Bash", choice: "allow", source: "unconfirmed" }) + logLine({ id: NEW, sessionId: S, tool: "Bash", choice: "deny", source: "unconfirmed" }));
    await until(async () => { const a = await alertsOf(s); return a && a.length ? a : null; }, 6000, "the alert for the new line", s);
    await refreshed(s);
    assert.deepEqual((await alertsOf(s)).map((a) => a.id), [NEW]);
    // a forged answer's check for BOTH alerts first; the bridge's unconfirmed line for it then raises no second alert
    const verify = (body) => request(s.port, { method: "POST", path: "/api/verify", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const r = plant(w, { id: BOTH });
    await until(async () => (await openIds(s)).includes(BOTH), 10000, "the planted request", s);
    assert.equal((await verify({ id: BOTH, hash: r.hash, choice: "allow" })).body, '{"wrote":false}');
    fs.appendFileSync(w.log, logLine({ id: BOTH, sessionId: S, tool: "Bash", choice: "allow", source: "unconfirmed" }));
    await refreshed(s);
    await refreshed(s);
    assert.deepEqual((await alertsOf(s)).map((a) => a.id), [BOTH, NEW]);
    assert.deepEqual(logLines(w).filter((l) => l.source === "outside VibeQuarters").map((l) => l.id), [NEW, BOTH]);
  } finally {
    await stop(s);
  }
});

test("an unchecked line (the bridge could not confirm an answer in time) raises an alert that says so and to answer again, one per line, never the outside-HQ alert or log line, and none for such a line from before the start; it lasts only while its request is open", async () => {
  const w = world(true);
  const [OLD, NEW, GONE] = ["e1", "e2", "e3"].map((h) => h.repeat(16));
  fs.mkdirSync(w.state, { recursive: true });
  fs.writeFileSync(w.log, logLine({ id: OLD, sessionId: S, tool: "Bash", choice: "allow", source: "unchecked" }));
  const s = await start(w);
  try {
    await refreshed(s);
    plant(w, { id: NEW }); // the bridge leaves the request open after a check that could not tell, so the owner can answer again
    await until(async () => (await openIds(s)).includes(NEW), 10000, "the planted request", s);
    fs.appendFileSync(w.log, logLine({ id: NEW, sessionId: S, tool: "Bash", choice: "allow", source: "unchecked" }));
    const got = await until(async () => { const a = await alertsOf(s); return a && a.length ? a : null; }, 6000, "the alert for the new line", s);
    assert.deepEqual(got.map(({ at, ...rest }) => rest), [{ id: NEW, sessionName: "ada", toolName: "Bash", unchecked: true }]);
    fs.appendFileSync(w.log, logLine({ id: NEW, sessionId: S, tool: "Bash", choice: "deny", source: "unchecked" }));
    await refreshed(s);
    await refreshed(s);
    assert.deepEqual((await alertsOf(s)).map((a) => [a.id, a.unchecked]), [[NEW, true], [NEW, true]], "the owner's second try that also failed: a second alert");
    assert.deepEqual(logLines(w).filter((l) => l.source === "outside VibeQuarters"), []);
    assert.ok(!s.err.text.includes("outside VibeQuarters"), s.err.text);
    // a line for a request no longer open asks the owner for nothing, so no alert stays for it
    fs.appendFileSync(w.log, logLine({ id: GONE, sessionId: S, tool: "Bash", choice: "allow", source: "unchecked" }));
    await refreshed(s);
    await refreshed(s);
    assert.deepEqual((await alertsOf(s)).map((a) => a.id), [NEW, NEW], "no alert for a request that is gone");
    // its request answered or gone (the bridge removes its file), the alerts for it go: nothing is left to answer again
    fs.unlinkSync(path.join(w.folder, NEW + ".json"));
    await until(async () => ((await alertsOf(s)).length === 0 ? true : null), 10000, "the alerts gone with their request", s);
  } finally {
    await stop(s);
  }
});

test("an answer the owner gives from the page raises no alert, with the real bridge acting on it and logging that it did", async () => {
  const w = world(true);
  const s = await start(w);
  let b = null;
  try {
    s.token = await tokenOf(s);
    assert.equal((await post(s, "/api/presence", { focused: true })).status, 200);
    b = asking(w);
    const item = await until(async () => (await openItems(s)).find((d) => /^[0-9a-f]{32}$/.test(d.id)), 10000, "the bridge's request in the payload", s);
    assert.equal((await post(s, "/api/answer", { id: item.id, choice: "allow", hash: item.hash })).status, 200);
    assert.deepEqual(await b.done, { code: 0, out: ALLOW + "\n" });
    await refreshed(s);
    assert.deepEqual(logLines(w).map(({ at, ...rest }) => rest), [
      { id: item.id, session: "ada", tool: "Bash", choice: "allow" },
      { id: item.id, sessionId: S, tool: "Bash", choice: "allow", source: "bridge" },
    ]);
    assert.deepEqual(await alertsOf(s), []);
    assert.equal(s.err.text, "");
  } finally {
    if (b) b.child.kill();
    await stop(s);
  }
});

test("lines already in the answers log at the start raise no alert, and a bridge line after the start whose HQ line came before it raises none either", async () => {
  const w = world(true);
  const [OLD, MINE, NEW] = ["c1", "c2", "c3"].map((h) => h.repeat(16));
  fs.mkdirSync(w.state, { recursive: true });
  // from before this start: a bridge line with no HQ line behind it, and HQ's own answer whose bridge had not acted yet
  fs.writeFileSync(w.log, logLine({ id: OLD, sessionId: S, tool: "Bash", choice: "allow", source: "bridge" }) + logLine({ id: MINE, session: "ada", tool: "Bash", choice: "allow" }));
  const s = await start(w);
  try {
    fs.appendFileSync(w.log, logLine({ id: MINE, sessionId: S, tool: "Bash", choice: "allow", source: "bridge" }) + logLine({ id: NEW, sessionId: S, tool: "Bash", choice: "deny", source: "bridge" }));
    const alerts = await until(async () => { const a = await alertsOf(s); return a && a.length ? a : null; }, 6000, "the alert for the new line", s);
    await refreshed(s);
    assert.deepEqual((await alertsOf(s)).map((a) => a.id), [NEW], "only the line with no HQ line behind it, written after the start");
    assert.deepEqual(alerts.map((a) => a.id), [NEW]);
    assert.deepEqual(logLines(w).filter((l) => l.source === "outside VibeQuarters").map((l) => l.id), [NEW]);
  } finally {
    await stop(s);
  }
});

test("the alert list keeps the newest 5, newest first, while every foreign line is logged; a session HQ never showed and a tool that is not text read as null", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    const ids = Array.from({ length: 7 }, (_, k) => "d" + k + "e".repeat(30));
    for (const [k, id] of ids.entries()) fs.appendFileSync(w.log, logLine(k < 6 ? { id, sessionId: S, tool: "Bash", choice: "allow", source: "bridge" } : { id, sessionId: "nobody-here", tool: 7, choice: "allow", source: "bridge" }));
    await until(() => logLines(w).filter((l) => l.source === "outside VibeQuarters").length === 7, 6000, "seven outside VibeQuarters lines", s);
    await refreshed(s);
    const alerts = await alertsOf(s);
    assert.deepEqual(alerts.map((a) => a.id), ids.slice(2).reverse());
    assert.deepEqual([alerts[0].sessionName, alerts[0].toolName, alerts[1].sessionName, alerts[1].toolName], [null, null, "ada", "Bash"]);
    assert.equal(logLines(w).filter((l) => l.source === "outside VibeQuarters").length, 7, "a later scan logs none twice");
  } finally {
    await stop(s);
  }
});

test("a notice is shown with no choices, and every answer for it is refused with answer in VS Code, writing nothing, even one whose kept copy is not Risky", async () => {
  const PUSH = { command: "git push origin main", description: "Push the branch" };
  const LATE = { command: "echo " + "y".repeat(5000) + " && git push origin main", description: "Print, then push" };
  const kept = trimInput(LATE);
  assert.equal(riskOf("Bash", LATE, false, "C:/work/quarry").level, "high");
  assert.notEqual(riskOf("Bash", kept.input, kept.trimmed, "C:/work/quarry").level, "high", "its kept copy alone is not Risky");
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    const NID = "cd".repeat(16);
    const n1 = plant(w, { notice: true, toolInput: PUSH });
    const n2 = plant(w, { id: NID, notice: true, toolInput: kept.input, trimmed: kept.trimmed });
    await until(async () => (await openIds(s)).length === 2, 10000, "the two notices", s);
    for (const d of await openItems(s)) assert.deepEqual([d.notice, d.choices], [true, []], d.id);
    for (const n of [n1, n2])
      for (const body of [{ choice: "allow" }, { choice: "deny" }, { choice: "revise", note: "push to a branch instead" }, { choice: "vscode" }]) {
        const r = await post(s, "/api/answer", { id: n.id, hash: n.hash, ...body });
        assert.deepEqual([r.status, r.body], [400, "answer in VS Code"], n.id.slice(0, 4) + " " + body.choice);
      }
    assert.deepEqual(fs.readdirSync(w.folder).sort(), [RID + ".json", NID + ".json"].sort(), "no answer written");
    assert.ok(!fs.existsSync(w.log), "no log line");
  } finally {
    await stop(s);
  }
});

test("a notice ends when its chat moves on: a new message in the asking transcript over 2 s after it was asked removes it at the next refresh, a call's result alone does not; a request stays", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    const askedAt = Date.now();
    const n = plant(w, { notice: true, askedAt, toolInput: { command: "git push origin main", description: "Push the branch" } });
    plant(w, { id: "ef".repeat(16), askedAt });
    await until(async () => (await openIds(s)).length === 2, 10000, "the notice and the request", s);
    await refreshed(s);
    assert.equal((await openIds(s)).length, 2, "nothing newer in the transcript yet: the notice stays");
    // a call's result 5 s after the ask: it may be a sibling call's, so the notice stays
    fs.appendFileSync(w.transcript, jsonl([{ type: "user", timestamp: new Date(askedAt + 5000).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_call", content: "ok" }] } }]));
    await refreshed(s);
    await refreshed(s);
    assert.equal((await openIds(s)).length, 2, "a call's result alone: the notice stays");
    // VS Code answered and the chat went on: its next message lands 6 s after the ask
    fs.appendFileSync(w.transcript, jsonl([asst({ sec: (askedAt + 6000 - T0) / 1000, content: [{ type: "text", text: "Pushed." }], stop: "end_turn" })]));
    await until(async () => !(await openIds(s)).includes(n.id), 10000, "the notice to end", s);
    assert.deepEqual(await openIds(s), ["ef".repeat(16)], "the request stays");
    assert.ok(!fs.existsSync(path.join(w.folder, n.id + ".json")), "its file is removed");
  } finally {
    await stop(s);
  }
});

test("a subagent's notice ends on its own file's new message, never on the main chat's (the server passes its agent id) or a call's result in its own file; a notice whose file HQ does not follow stays", async () => {
  const w = world(true);
  const AG = "a0123456789abcdef";
  const subFp = path.join(path.dirname(w.transcript), S, "subagents", "agent-" + AG + ".jsonl");
  fs.mkdirSync(path.dirname(subFp), { recursive: true });
  fs.writeFileSync(subFp, jsonl([user({ sec: nowSec(), text: "audit it", sidechain: true }), asst({ sec: nowSec(), sidechain: true, content: [{ ...tool("Bash", { command: "git push origin main", description: "Push" }), id: "tu_sub" }] })]));
  const s = await start(w);
  try {
    const askedAt = Date.now();
    const n = plant(w, { notice: true, askedAt, agentId: AG, agentType: "general-purpose", toolInput: { command: "git push origin main", description: "Push" } });
    // a subagent HQ has no file for: its chat says nothing, so its notice stays (null is not moved)
    const unseen = plant(w, { id: "fe".repeat(16), notice: true, askedAt, agentId: "a" + "fe".repeat(8), agentType: "general-purpose", toolInput: { command: "git push origin main", description: "Push" } });
    await until(async () => (await openIds(s)).includes(n.id), 10000, "the notice", s);
    const later = (ms) => (askedAt + ms - T0) / 1000;
    // the main chat moves on (not this notice's chat), and a call's result lands in the subagent's own file
    fs.appendFileSync(w.transcript, jsonl([asst({ sec: later(5000), content: [{ type: "text", text: "Meanwhile." }], stop: "end_turn" })]));
    fs.appendFileSync(subFp, jsonl([{ type: "user", isSidechain: true, timestamp: new Date(askedAt + 5000).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_other", content: "ok" }] } }]));
    await refreshed(s);
    await refreshed(s);
    assert.deepEqual(await openIds(s), [n.id, unseen.id], "the main chat's new message and a result in its own file: the notice stays");
    // the subagent's own chat moves on
    fs.appendFileSync(subFp, jsonl([asst({ sec: later(6000), sidechain: true, content: [{ type: "text", text: "Pushed." }], stop: "end_turn" })]));
    await until(async () => !(await openIds(s)).includes(n.id), 10000, "the notice to end", s);
    assert.ok(!fs.existsSync(path.join(w.folder, n.id + ".json")), "its file is removed");
    assert.deepEqual(await openIds(s), [unseen.id], "the notice HQ cannot follow stays");
  } finally {
    await stop(s);
  }
});

const bridgeLine = (id, choice = "allow") => logLine({ id, sessionId: S, tool: "Bash", choice, source: "bridge" });
const outside = (w) => logLines(w).filter((l) => l.source === "outside VibeQuarters").map((l) => l.id);

test("a 300 KB log from before the start raises nothing; truncated and appended to, a forged bridge line in its new part raises one alert; a partial last line counts once, whole, when it ends", async () => {
  const w = world(true);
  fs.mkdirSync(w.state, { recursive: true });
  // every line a bridge line with no HQ line behind it, so each one read after the start would alert
  let old = "";
  for (let k = 0; old.length < 300 * 1024; k++) old += bridgeLine(k.toString(16).padStart(32, "0"));
  fs.writeFileSync(w.log, old);
  const s = await start(w);
  try {
    await refreshed(s);
    assert.deepEqual(await alertsOf(s), [], "the old lines raise nothing");
    assert.deepEqual(outside(w), []);
    const [FORGED, LATE] = ["f1", "f2"].map((h) => h.repeat(16));
    fs.truncateSync(w.log, 0);
    fs.appendFileSync(w.log, bridgeLine(FORGED));
    await until(async () => (await alertsOf(s)).length > 0, 6000, "the alert for the forged line", s);
    assert.deepEqual((await alertsOf(s)).map((a) => a.id), [FORGED]);
    // a line still being written: nothing until it ends, then one alert, read whole
    const late = bridgeLine(LATE, "deny");
    fs.appendFileSync(w.log, late.slice(0, 40));
    await refreshed(s);
    assert.deepEqual((await alertsOf(s)).map((a) => a.id), [FORGED], "half a line raises nothing");
    fs.appendFileSync(w.log, late.slice(40));
    await until(async () => (await alertsOf(s)).length > 1, 6000, "the alert for the finished line", s);
    await refreshed(s);
    assert.deepEqual((await alertsOf(s)).map((a) => [a.id, a.sessionName, a.toolName]), [[LATE, "ada", "Bash"], [FORGED, "ada", "Bash"]]);
    assert.deepEqual(outside(w), [FORGED, LATE], "each logged once");
    assert.equal(s.err.text.trim().split("\n").length, 2, s.err.text);
  } finally {
    await stop(s);
  }
});

test("a log rewritten in place, never shorter, is read again from its start once it grows: a forged bridge line in the rewritten part raises one alert", async () => {
  const w = world(true);
  const [MINE, FORGED] = ["a1", "a2"].map((h) => h.repeat(16));
  fs.mkdirSync(w.state, { recursive: true });
  fs.writeFileSync(w.log, logLine({ id: MINE, session: "ada", tool: "Bash", choice: "allow", pad: "y".repeat(300) }));
  const s = await start(w);
  try {
    await refreshed(s);
    // the same file written over from its first byte and past its old end: only its bytes tell it changed
    const fd = fs.openSync(w.log, "r+");
    fs.writeSync(fd, bridgeLine(FORGED) + Array.from({ length: 8 }, (_, k) => logLine({ id: "b" + k + "c".repeat(30), session: "ada", tool: "Bash", choice: "allow" })).join(""), 0);
    fs.closeSync(fd);
    await until(async () => (await alertsOf(s)).length > 0, 6000, "the alert for the forged line", s);
    await refreshed(s);
    assert.deepEqual((await alertsOf(s)).map((a) => a.id), [FORGED]);
    assert.deepEqual(outside(w), [FORGED]);
  } finally {
    await stop(s);
  }
});

// Loaded into the server with --require: fails the answers log's stat or its read while the switch file says so. The
// switch holds the mode ("stat" or "read") and how many failures are left (-1: no limit); each failure adds one byte to
// the switch's .count file.
function logStub() {
  const fs = require("fs");
  const path = require("path");
  const LOG = path.resolve(process.env.HQ_STUB_LOG).toLowerCase();
  const SWITCH = process.env.HQ_STUB_SWITCH;
  const { statSync, openSync, closeSync, readSync } = fs;
  const fds = new Set();
  const isLog = (p) => typeof p === "string" && path.resolve(p).toLowerCase() === LOG;
  const fail = (mode) => {
    let t;
    try {
      t = fs.readFileSync(SWITCH, "utf8").trim().split(" ");
    } catch {
      return;
    }
    if (t[0] !== mode || t[1] === "0") return;
    if (t[1] !== "-1") fs.writeFileSync(SWITCH, mode + " " + (Number(t[1]) - 1));
    fs.appendFileSync(SWITCH + ".count", "x");
    throw Object.assign(new Error("EPERM: operation not permitted (stub)"), { code: "EPERM" });
  };
  fs.statSync = function (p, ...a) {
    if (isLog(p)) fail("stat");
    return statSync.call(this, p, ...a);
  };
  fs.openSync = function (p, flags, ...a) {
    const fd = openSync.call(this, p, flags, ...a);
    if (isLog(p) && flags === "r") fds.add(fd);
    return fd;
  };
  fs.closeSync = function (fd, ...a) {
    fds.delete(fd);
    return closeSync.call(this, fd, ...a);
  };
  fs.readSync = function (fd, ...a) {
    if (fds.has(fd)) fail("read");
    return readSync.call(this, fd, ...a);
  };
}
// The stub and its switch in the world's folder, set to `mode` ("read 2", "stat -1"...); count() is the failures so far.
function stubbed(w, mode) {
  const root = path.dirname(w.state);
  const stub = { file: path.join(root, "log-stub.js"), switch: path.join(root, "log-stub.switch") };
  fs.writeFileSync(stub.file, "(" + logStub.toString() + ")();\n");
  fs.writeFileSync(stub.switch, mode);
  stub.count = () => { try { return fs.statSync(stub.switch + ".count").size; } catch { return 0; } };
  return stub;
}

test("a start read that fails is retried from where it began: a forged line added before a read works alerts once, as does one whose time does not parse, and an old forged line from before the start never does", async () => {
  const w = world(true);
  fs.mkdirSync(w.state, { recursive: true });
  const [OLD, FORGED, UNTIMED] = ["0a", "0b", "0e"].map((h) => h.repeat(16));
  fs.writeFileSync(w.log, bridgeLine(OLD));
  const stub = stubbed(w, "read 2"); // the start's read and the first refresh's fail
  const s = await start(w, { stub });
  try {
    fs.appendFileSync(w.log, bridgeLine(FORGED) + JSON.stringify({ at: "soon", id: UNTIMED, sessionId: S, tool: "Bash", choice: "allow", source: "bridge" }) + "\n");
    await until(async () => (await alertsOf(s)).length > 0, 10000, "the alerts for the forged lines", s);
    await refreshed(s);
    assert.equal(stub.count(), 2, "two reads failed first");
    assert.deepEqual((await alertsOf(s)).map((a) => a.id), [UNTIMED, FORGED]);
    assert.deepEqual(outside(w), [FORGED, UNTIMED], "the old line is history");
  } finally {
    await stop(s);
  }
});

test("a log HQ can first see only after it started is read then, and a forged line stamped after the start alerts", async () => {
  const w = world(true);
  fs.mkdirSync(w.state, { recursive: true });
  const [OLD, FORGED] = ["0c", "0d"].map((h) => h.repeat(16));
  fs.writeFileSync(w.log, bridgeLine(OLD));
  const stub = stubbed(w, "stat 2"); // the start's stat and the first refresh's fail
  const s = await start(w, { stub });
  try {
    fs.appendFileSync(w.log, bridgeLine(FORGED));
    await until(async () => (await alertsOf(s)).length > 0, 10000, "the alert for the forged line", s);
    await refreshed(s);
    assert.equal(stub.count(), 2, "two stats failed first");
    assert.deepEqual((await alertsOf(s)).map((a) => a.id), [FORGED]);
    assert.deepEqual(outside(w), [FORGED], "the old line is history");
  } finally {
    await stop(s);
  }
});

test("a log that is there but cannot be read raises one unreadable alert on the third failed scan in a row, once a run; a missing log never does", async () => {
  const w = world(true);
  const stub = stubbed(w, "read -1");
  const s = await start(w, { stub });
  try {
    for (let k = 0; k < 3; k++) await refreshed(s);
    assert.deepEqual(await alertsOf(s), [], "a missing log is no failure");
    fs.writeFileSync(w.log, logLine({ id: "e0".repeat(16), session: "ada", tool: "Bash", choice: "allow" }));
    await until(() => stub.count() >= 2, 15000, "two failed scans", s);
    const two = await alertsOf(s);
    assert.equal(stub.count(), 2, "still two failed scans once the alerts were read");
    assert.deepEqual(two, [], "the second failed scan raises nothing");
    await until(() => stub.count() >= 3, 15000, "a third failed scan", s);
    const three = await alertsOf(s);
    assert.deepEqual(three.map((a) => ({ ...a, at: 0 })), [{ at: 0, id: null, sessionName: null, toolName: null, unreadable: true }]);
    assert.ok(Math.abs(three[0].at - Date.now()) < 10e3, String(three[0].at));
    await until(() => stub.count() >= 4, 15000, "a fourth failed scan", s);
    assert.equal((await alertsOf(s)).length, 1, "once a run");
    const err = s.err.text.trim().split("\n");
    assert.equal(err.length, 1, "one line: " + s.err.text);
    assert.match(err[0], /cannot be read/);
    assert.ok(!/[\\/]/.test(err[0]), "the line names no path: " + err[0]);
  } finally {
    await stop(s);
  }
});

test("a stat that fails counts as well: a log that is there but cannot be looked at from the start raises the unreadable alert on the third scan", async () => {
  const w = world(true);
  fs.mkdirSync(w.state, { recursive: true });
  fs.writeFileSync(w.log, logLine({ id: "e1".repeat(16), session: "ada", tool: "Bash", choice: "allow" }));
  const stub = stubbed(w, "stat -1"); // one stat a scan while HQ has not seen the log
  const s = await start(w, { stub });
  try {
    await until(() => stub.count() >= 3, 15000, "three failed stats", s);
    assert.deepEqual((await alertsOf(s)).map((a) => [a.id, a.unreadable]), [[null, true]]);
  } finally {
    await stop(s);
  }
});

test("a read that works starts the count again: two failed scans, a good one, then two more raise no unreadable alert", async () => {
  const w = world(true);
  fs.mkdirSync(w.state, { recursive: true });
  fs.writeFileSync(w.log, logLine({ id: "e2".repeat(16), session: "ada", tool: "Bash", choice: "allow" }));
  const stub = stubbed(w, "read 2"); // the start's read and the first refresh's fail
  const s = await start(w, { stub });
  try {
    await until(() => stub.count() >= 2, 15000, "two failed scans", s);
    await refreshed(s); // its read works
    fs.writeFileSync(stub.switch, "read 2");
    fs.appendFileSync(w.log, logLine({ id: "e3".repeat(16), session: "ada", tool: "Bash", choice: "allow" })); // a log that grew is read again
    await until(() => stub.count() >= 4, 15000, "two more failed scans", s);
    await refreshed(s);
    assert.equal(stub.count(), 4, "four failed scans in all");
    assert.deepEqual(await alertsOf(s), [], "never three failed scans in a row");
  } finally {
    await stop(s);
  }
});

test("only the first read that worked can learn history: a forged bridge line stamped before the start but appended after that read alerts once, as it does in a log that was not there at the start; an old line read in that first read stays history", async () => {
  const backdated = (id) => JSON.stringify({ at: new Date(Date.now() - 3600e3).toISOString(), id, sessionId: S, tool: "Bash", choice: "allow", source: "bridge" }) + "\n";
  const run = async (hadLog) => {
    const w = world(true);
    fs.mkdirSync(w.state, { recursive: true });
    const [OLD, FORGED] = (hadLog ? ["3a", "3b"] : ["3c", "3d"]).map((h) => h.repeat(16));
    if (hadLog) fs.writeFileSync(w.log, bridgeLine(OLD)); // read in the first read: history (the control)
    const s = await start(w);
    try {
      await refreshed(s); // the first read has worked (or found no log)
      fs.appendFileSync(w.log, backdated(FORGED));
      await until(async () => (await alertsOf(s)).length > 0, 10000, "the alert for the backdated line", s);
      await refreshed(s);
      assert.deepEqual((await alertsOf(s)).map((a) => a.id), [FORGED], hadLog ? "the log was there" : "the log was not there");
      assert.deepEqual(outside(w), [FORGED], "logged once, and the old line is history");
      assert.equal(s.err.text.trim().split("\n").length, 1, s.err.text);
    } finally {
      await stop(s);
    }
  };
  await Promise.all([run(true), run(false)]);
});

test("the approve window: closed at start, its off route takes the page token and only { off: true }, and no route opens one", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    plant(w);
    await until(async () => (await openIds(s)).includes(RID), 10000, "the planted request", s);
    const windowOf = async () => JSON.parse((await request(s.port, { path: "/api/hq" })).body).window;
    const CLOSED = { open: false, endsAt: null, sessions: null, approved: 0 };
    assert.deepEqual(await windowOf(), CLOSED);
    const off = await post(s, "/api/window", { off: true });
    assert.deepEqual([off.status, off.body], [200, '{"ok":true}'], "off with nothing open");
    assert.equal((await post(s, "/api/window", { off: true }, { "X-HQ-Token": "0".repeat(64) })).status, 403, "a wrong token");
    assert.equal((await post(s, "/api/window", { off: true }, { Origin: "http://evil.example" })).status, 403, "a wrong Origin");
    for (const body of [{ minutes: 10 }, { open: true, minutes: 10 }, { off: true, minutes: 10 }, { off: "yes" }, {}, [], null]) {
      const r = await post(s, "/api/window", body);
      assert.deepEqual([r.status, r.body], [400, "off only"], JSON.stringify(body));
    }
    assert.deepEqual(await windowOf(), CLOSED, "still closed");
    assert.deepEqual(fs.readdirSync(w.folder), [RID + ".json"], "nothing answered the Check first request");
    assert.ok(!fs.existsSync(w.log), "no log line");
  } finally {
    await stop(s);
  }
});

test("read-backs: none at start; the confirm route takes the page token and only { id, confirm }, and an id it never proposed is not open", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    plant(w);
    await until(async () => (await openIds(s)).includes(RID), 10000, "the planted request", s);
    assert.deepEqual(JSON.parse((await request(s.port, { path: "/api/hq" })).body).readbacks, []);
    for (const confirm of [true, false]) {
      const r = await post(s, "/api/readback", { id: "0123456789abcdef", confirm });
      assert.deepEqual([r.status, r.body], [400, "not open"], "never proposed, confirm " + confirm);
    }
    assert.equal((await post(s, "/api/readback", { id: "0123456789abcdef", confirm: true }, { "X-HQ-Token": "0".repeat(64) })).status, 403, "a wrong token");
    for (const body of [{ id: "0123456789abcdef" }, { id: 7, confirm: true }, { id: "0123456789abcdef", confirm: "yes" }, { id: "0123456789abcdef", confirm: true, choice: "allow" }, {}, null]) {
      const r = await post(s, "/api/readback", body);
      assert.deepEqual([r.status, r.body], [400, "id and confirm, true or false"], JSON.stringify(body));
    }
    assert.deepEqual(fs.readdirSync(w.folder), [RID + ".json"], "nothing answered");
  } finally {
    await stop(s);
  }
});

// ---------- the assistant's command channel (POST /api/assistant) ----------

// The server started with the tap, its page token, and its assistant token (the one 32-byte value that is not the page's)
async function startTapped(w, tap = tapStub(path.dirname(w.state)), opts = {}) {
  const s = await start(w, { stub: tap, ...opts });
  s.token = await tokenOf(s);
  const other = tap.tokens().filter((t) => t !== s.token);
  assert.equal(other.length, 1, "one assistant token: " + other.length);
  s.assistant = other[0];
  return s;
}
const command = (s, body, over = {}) => request(s.port, { method: "POST", path: "/api/assistant", headers: { "Content-Type": "application/json", "X-HQ-Assistant-Token": s.assistant, ...over }, body: typeof body === "string" ? body : JSON.stringify(body) });
const hqNow = async (s) => JSON.parse((await request(s.port, { path: "/api/hq" })).body);
const WAIT = "Read-back shown to the owner; waiting for the owner's yes.";

test("the assistant channel: refused from a web page, with the page token, or with no or a wrong assistant token; the assistant token works there and nowhere else", async () => {
  const w = world(true);
  const s = await startTapped(w);
  try {
    const good = { cmd: "status", args: [] };
    const cases = [
      ["an Origin, even HQ's own", good, { Origin: `http://127.0.0.1:${s.port}` }, 403],
      ["a fetch site", good, { "Sec-Fetch-Site": "same-origin" }, 403],
      ["no assistant token", good, { "X-HQ-Assistant-Token": "" }, 403],
      ["a wrong assistant token", good, { "X-HQ-Assistant-Token": "0".repeat(64) }, 403],
      ["the page token as the assistant token", good, { "X-HQ-Assistant-Token": s.token }, 403],
      ["only the page token", good, { "X-HQ-Assistant-Token": "", "X-HQ-Token": s.token }, 403],
      ["text/plain", good, { "Content-Type": "text/plain" }, 400],
      ["bad JSON", "{", {}, 400],
      ["no args", { cmd: "status" }, {}, 400],
      ["args not a list", { cmd: "status", args: "x" }, {}, 400],
      ["an arg not text", { cmd: "status", args: [1] }, {}, 400],
      ["another field", { ...good, as: "owner" }, {}, 400],
    ];
    for (const [what, body, over, status] of cases) assert.equal((await command(s, body, over)).status, status, what);
    const r = await command(s, good);
    assert.equal(r.status, 200, r.body);
    assert.match(r.headers["content-type"], /^text\/plain/);
    assert.match(r.body, /^ada: /m);
    assert.equal((await post(s, "/api/window", { off: true }, { "X-HQ-Token": s.assistant })).status, 403, "the assistant token on a page route");
  } finally {
    await stop(s);
  }
});

test("a read-back from the assistant: ask shows it in the payload and speaks it; the owner's yes answers once, logged via readback; a second yes and one after the item closed are not open", async () => {
  const w = world(true);
  const s = await startTapped(w);
  const ev = events(s);
  try {
    const R2 = "cd".repeat(16);
    plant(w);
    plant(w, { id: R2, toolInput: { command: "npm run build", description: "Build" } });
    await until(async () => (await openIds(s)).includes(R2), 10000, "the planted requests", s);
    const ask = await command(s, { cmd: "ask", args: [RID.slice(0, 8), "allow"] });
    assert.deepEqual([ask.status, ask.body], [200, WAIT]);
    const [rb] = (await hqNow(s)).readbacks;
    assert.deepEqual(Object.keys(rb).sort(), ["at", "expiresAt", "id", "kind", "text"]);
    assert.equal(rb.expiresAt, rb.at + 5 * 60e3, "its 5 minutes, for the card's time left");
    assert.equal(rb.text, "Approve for ada: wants to run the tests (Check first).", "the call's own description, in plain words");
    await until(() => ev.got.some((e) => e.event === "say" && e.data.text === rb.text + " Say yes to confirm, or cancel."), 5000, "the spoken read-back", s);
    assert.deepEqual(fs.readdirSync(w.folder).sort(), [RID + ".json", R2 + ".json"].sort(), "nothing answered before the yes");
    const yes = await post(s, "/api/readback", { id: rb.id, confirm: true });
    assert.deepEqual([yes.status, yes.body], [200, '{"ok":true}']);
    assert.deepEqual(logLines(w).map((l) => [l.id, l.choice, l.via]), [[RID, "allow", "readback"]]);
    const again = await post(s, "/api/readback", { id: rb.id, confirm: true });
    assert.deepEqual([again.status, again.body], [400, "not open"], "a second yes");
    assert.equal(logLines(w).length, 1, "answered once");

    assert.equal((await command(s, { cmd: "ask", args: [R2.slice(0, 8), "deny"] })).body, WAIT);
    const [rb2] = (await hqNow(s)).readbacks;
    fs.unlinkSync(path.join(w.folder, R2 + ".json")); // the bridge gave up on it
    await until(async () => !(await openIds(s)).includes(R2), 10000, "the request gone", s);
    const late = await post(s, "/api/readback", { id: rb2.id, confirm: true });
    assert.deepEqual([late.status, late.body], [400, "not open"], "after the item closed");
    assert.equal(logLines(w).length, 1, "nothing more answered");
  } finally {
    ev.close();
    await stop(s);
  }
});

// The payload's settled history, newest first, says what became of each decision and read-back.
test("the payload's settled history: each read-back confirmed, not sent, canceled or dropped, and each decision that left, with its outcome and who settled it", async () => {
  const w = world(true);
  const s = await startTapped(w, undefined, { windows: true });
  const row = (e) => [e.kind, e.what, e.outcome, e.via];
  try {
    assert.deepEqual((await hqNow(s)).settled, [], "none at start");
    const R2 = "cd".repeat(16), R3 = "ef".repeat(16);
    plant(w);
    plant(w, { id: R2, toolInput: { command: "npm run build", description: "Build" } });
    plant(w, { id: R3, toolInput: { command: "npm run lint", description: "Lint" } });
    await until(async () => (await openIds(s)).length === 3, 10000, "the planted requests", s);
    const line = Object.fromEntries((await openItems(s)).map((d) => [d.id, "ada " + d.what])); // each decision's line
    // the owner's yes to an answer: the read-back approved by the owner, then the decision approved by the read-back
    assert.equal((await command(s, { cmd: "ask", args: [RID.slice(0, 8), "allow"] })).body, WAIT);
    const [rb] = (await hqNow(s)).readbacks;
    assert.equal((await post(s, "/api/readback", { id: rb.id, confirm: true })).status, 200);
    const one = (await hqNow(s)).settled;
    assert.deepEqual(one.map(row), [["decision", "ada wants to run the tests", "approved", "assistant read-back"], ["readback", "Approve for ada: wants to run the tests (Check first).", "approved", "you"]]);
    assert.deepEqual([one[0].id, one[1].id, typeof one[0].at], [RID, rb.id, "number"]);
    assert.deepEqual(Object.keys(one[0]).sort(), ["at", "id", "kind", "outcome", "via", "what"]);
    // the owner's own click
    const item2 = (await openItems(s)).find((d) => d.id === R2);
    assert.equal((await post(s, "/api/answer", { id: R2, choice: "deny", hash: item2.hash })).status, 200);
    assert.deepEqual(row((await hqNow(s)).settled[0]), ["decision", line[R2], "denied", "you"]);
    // an answer read-back whose request went away first (the bridge gave up): dropped, and the decision gone
    assert.equal((await command(s, { cmd: "ask", args: [R3.slice(0, 8), "deny"] })).body, WAIT);
    const [deny] = (await hqNow(s)).readbacks;
    fs.unlinkSync(path.join(w.folder, R3 + ".json"));
    await until(async () => (await hqNow(s)).settled.length === 5, 10000, "the drop", s);
    assert.deepEqual((await hqNow(s)).settled.slice(0, 2).map(row), [["readback", deny.text, "dropped: answered elsewhere", "VibeQuarters"], ["decision", line[R3], "answered in VS Code or gone", "outside VibeQuarters"]]);
    assert.deepEqual((await hqNow(s)).readbacks, []);
    // the owner's Cancel
    assert.equal((await command(s, { cmd: "window", args: ["10"] })).body, WAIT);
    const [win] = (await hqNow(s)).readbacks;
    assert.equal((await post(s, "/api/readback", { id: win.id, confirm: false })).status, 200);
    assert.deepEqual(row((await hqNow(s)).settled[0]), ["readback", "Approve what looks safe for 10 minutes in every chat.", "canceled", "you"]);
    // two sends to ada: the first is sent, the second not, with HQ's reason
    assert.equal((await command(s, { cmd: "send", args: ["ada", "run the tests"] })).body, WAIT);
    assert.equal((await command(s, { cmd: "send", args: ["ada", "then push"] })).body, WAIT);
    const [a, b] = (await hqNow(s)).readbacks;
    assert.equal((await post(s, "/api/readback", { id: a.id, confirm: true })).status, 200);
    const no = await post(s, "/api/readback", { id: b.id, confirm: true });
    assert.deepEqual([no.status, no.body], [400, "one message at a time"]);
    const last = (await hqNow(s)).settled;
    assert.deepEqual(last.slice(0, 2).map(row), [["readback", "Send ada this prompt", "not sent: one message at a time", "you"], ["readback", "Send ada this prompt", "sent", "you"]]);
    assert.equal(last.length, 8, "every one kept, newest first");
  } finally {
    await stop(s);
  }
});

// Runs as "fake-judge" (the claude lib/judge.js starts): logs the ids it was given, then leaves each item whose call
// holds LEAVE and approves the rest; when any call holds SLOW it answers after 3 s
function fakeJudgeMain() {
  const fs = require("fs");
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => {
    const { items } = JSON.parse(buf);
    fs.appendFileSync(process.env.HQ_JUDGE_LOG, JSON.stringify(items.map((x) => x.id)) + "\n");
    const result = JSON.stringify(items.map((x) => ({ id: x.id, approve: !x.call.includes("LEAVE"), why: "fake" })));
    setTimeout(() => process.stdout.write(JSON.stringify({ result, total_cost_usd: 0 })), items.some((x) => x.call.includes("SLOW")) ? 3000 : 0);
  });
}
// The tap stub plus spawn("fake-judge", args) running fakeJudgeMain with Node; judged() lists each run's ids
function judgeStub(dir) {
  const tap = tapStub(dir);
  const fake = path.join(dir, "fake-judge.js"), file = path.join(dir, "judge-stub.js"), log = path.join(dir, "judge.log");
  fs.writeFileSync(fake, "(" + fakeJudgeMain.toString() + ")();\n");
  fs.writeFileSync(file, [
    `require(${JSON.stringify(tap.file)});`,
    'const cp = require("child_process");',
    "const real = cp.spawn;",
    `cp.spawn = function (cmd, args, opts) { return cmd === "fake-judge" ? real.call(this, process.execPath, [${JSON.stringify(fake)}, ...args], opts) : real.apply(this, arguments); };`,
  ].join("\n") + "\n");
  fs.rmSync(log, { force: true });
  const judged = () => { try { return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { ...tap, file, env: { ...tap.env, HQ_JUDGE_LOG: log }, judged };
}

// A window approves what the judge finds safe, never the owner's own kinds (approval-levels.json: here a recursive delete
// and money), and says the deletes it approved when it ends
test("the approve window from the assistant: routine approved at once, the judge's yes approved, the owner's own kinds never judged; window off names the deletes; a restart keeps it for its remaining time", async () => {
  const w = world(true, { judge: true, assistant: { claude: "fake-judge" } });
  const stub = judgeStub(path.dirname(w.state));
  let s = await startTapped(w, stub);
  let ev = events(s);
  try {
    const R2 = "ef".repeat(16), R3 = "cd".repeat(16), R4 = "12".repeat(16);
    plant(w, { toolInput: { command: "git status", description: "Status" } });
    plant(w, { id: R2, risky: true, toolInput: { command: "rm build/old.log", description: "Remove an old log" } });
    plant(w, { id: R3, hookAsk: { hook: "guard-bash.js", reason: "a destructive command" }, toolInput: { command: "rm -rf build LEAVE", description: "Clean" } });
    plant(w, { id: R4, toolName: "mcp__payments__send_money", toolInput: { amount: 5 } });
    await until(async () => (await openIds(s)).length === 4, 10000, "the planted requests", s);
    assert.equal((await command(s, { cmd: "window", args: ["10", "ada"] })).body, WAIT);
    const [rb] = (await hqNow(s)).readbacks;
    assert.equal(rb.text, "Approve what looks safe for 10 minutes in ada.");
    assert.equal((await hqNow(s)).window.open, false, "not open before the yes");
    assert.equal((await post(s, "/api/readback", { id: rb.id, confirm: true })).status, 200);
    await until(() => logLines(w).length === 2, 15000, "the routine and the judged approvals", s);
    const lines = logLines(w);
    assert.deepEqual(lines.map((l) => [l.id, l.choice, l.via, typeof l.window]).sort(), [[R2, "allow", "window", "string"], [RID, "allow", "window", "string"]].sort());
    await until(async () => (await openIds(s)).length === 2, 10000, "the approved ones gone", s);
    assert.deepEqual((await openIds(s)).sort(), [R3, R4].sort(), "the owner's own kinds wait for the owner");
    assert.deepEqual(stub.judged().flat().sort(), [R2], "the judge saw only the items the levels sent it");
    assert.deepEqual([(await hqNow(s)).window.open, (await hqNow(s)).window.approved], [true, 2]);
    const kept = (await hqNow(s)).settled.map((e) => [e.kind, e.id, e.outcome, e.via]);
    assert.deepEqual(kept.filter((e) => e[0] === "decision").sort(), [["decision", R2, "approved", "approve window"], ["decision", RID, "approved", "approve window"]].sort(), "the settled history says the window approved them");
    assert.deepEqual(kept.filter((e) => e[0] === "readback"), [["readback", rb.id, "window opened", "you"]]);
    const off = await command(s, { cmd: "window", args: ["off"] });
    assert.deepEqual([off.status, off.body], [200, "Approve window off."]);
    assert.equal((await hqNow(s)).window.open, false);
    await until(() => ev.got.some((e) => e.event === "say" && e.data.text === "Approve window ended. I approved 2. That includes 1 delete. 2 are waiting for you."), 5000, "the end line", s);

    assert.equal((await command(s, { cmd: "window", args: ["5"] })).body, WAIT);
    const [rb2] = (await hqNow(s)).readbacks;
    assert.equal((await post(s, "/api/readback", { id: rb2.id, confirm: true })).status, 200);
    const beforeRestart = (await hqNow(s)).window;
    assert.equal(beforeRestart.open, true);
    ev.close();
    await stop(s);
    s = await startTapped(w, judgeStub(path.dirname(w.state)));
    ev = events(s);
    const afterRestart = (await hqNow(s)).window;
    assert.deepEqual([afterRestart.open, afterRestart.endsAt], [true, beforeRestart.endsAt], "a restart keeps it, with the same end");
    assert.deepEqual((await hqNow(s)).readbacks, []);
  } finally {
    ev.close();
    await stop(s);
  }
});

test("watch: HQ says when the watched chat's reply ends, once", async () => {
  const w = world(true);
  const s = await startTapped(w);
  const ev = events(s);
  try {
    const st = (await hqNow(s)).sessions.find((x) => x.id === S);
    assert.ok(st.status === "working" || st.status === "thinking", "ada is working: " + st.status);
    const r = await command(s, { cmd: "watch", args: ["ada"] });
    assert.deepEqual([r.status, r.body], [200, "Watching ada; HQ says when its reply ends."]);
    fs.appendFileSync(w.transcript, jsonl([
      { type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_call", content: "ok" }] } },
      asst({ sec: nowSec(), stop: "end_turn", content: [{ type: "text", text: "All green." }] }),
    ]));
    await until(() => ev.got.some((e) => e.event === "say" && e.data.text === "ada finished its reply."), 15000, "the finished line", s);
    await refreshed(s);
    await refreshed(s);
    assert.equal(ev.got.filter((e) => e.event === "say").length, 1, "once");
  } finally {
    ev.close();
    await stop(s);
  }
});

// A verdict that comes back after its window ended approves nothing
test("the approve window: a judge verdict that comes back after the window is off approves nothing", async () => {
  const w = world(true, { judge: true, assistant: { claude: "fake-judge" } });
  const stub = judgeStub(path.dirname(w.state));
  const s = await startTapped(w, stub);
  try {
    plant(w, { toolInput: { command: "npm run build SLOW", description: "Build" } });
    await until(async () => (await openIds(s)).includes(RID), 10000, "the planted request", s);
    assert.equal((await command(s, { cmd: "window", args: ["10"] })).body, WAIT);
    const [rb] = (await hqNow(s)).readbacks;
    assert.equal((await post(s, "/api/readback", { id: rb.id, confirm: true })).status, 200);
    await until(() => stub.judged().length === 1, 10000, "the judge started", s);
    assert.equal((await command(s, { cmd: "window", args: ["off"] })).status, 200);
    await sleep(3500); // the slow verdict lands
    await refreshed(s);
    await refreshed(s);
    assert.deepEqual(logLines(w), [], "nothing approved");
    assert.deepEqual(await openIds(s), [RID]);
  } finally {
    await stop(s);
  }
});

// An approval nobody answered for 30 seconds, and that HQ will not approve itself, gets one short spoken line.
test("the 30-second reminder: an approval left 30 seconds is said once; one a window approves at once never is", async () => {
  const w = world(true, { judge: true, assistant: { claude: "fake-judge" } });
  // the chat's rows a minute old, so a request asked 31 s ago is still open, not one the chat moved past
  fs.writeFileSync(w.transcript, jsonl([user({ sec: nowSec() - 60, text: "go" }), asst({ sec: nowSec() - 60, content: [{ ...tool("Bash", { command: "npm test", description: "Run the tests" }), id: "tu_call" }] })]));
  const s = await startTapped(w, judgeStub(path.dirname(w.state)));
  const ev = events(s);
  const said = () => ev.got.filter((e) => e.event === "say" && /to approve\.$/.test(e.data.text)).map((e) => e.data.text);
  try {
    plant(w, { askedAt: Date.now() - 31e3 });
    await until(() => said().length === 1, 15000, "the reminder", s);
    assert.deepEqual(said(), ["You have something to approve."]);
    await refreshed(s);
    await refreshed(s);
    assert.equal(said().length, 1, "once");
    assert.equal((await command(s, { cmd: "window", args: ["10"] })).body, WAIT);
    const [rb] = (await hqNow(s)).readbacks;
    assert.equal((await post(s, "/api/readback", { id: rb.id, confirm: true })).status, 200);
    const R2 = "ef".repeat(16);
    plant(w, { id: R2, askedAt: Date.now() - 31e3, toolInput: { command: "git status", description: "Status" } });
    await until(() => logLines(w).some((l) => l.id === R2), 10000, "the routine one approved", s);
    await refreshed(s);
    assert.equal(said().length, 1, "a routine item the window approved is never said");
  } finally {
    ev.close();
    await stop(s);
  }
});

// ---------- the assistant's process (lib/assistant.js) and the owner's words (POST /api/say) ----------

// Runs as "fake-claude": for each user line, asks HQ for status on the assistant channel with the token in its env, then
// ends the turn with what it heard and what HQ answered, its total cost one cent more each turn
function fakeMain() {
  const http = require("http");
  let buf = "", total = 0;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    buf += c;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const heard = JSON.parse(buf.slice(0, i)).message.content[0].text;
      buf = buf.slice(i + 1);
      const said = /^cmd (\w+) (.+)$/s.exec(heard); // "cmd open <prompt>" runs that command; anything else asks for status
      const body = JSON.stringify(said ? { cmd: said[1], args: [said[2]] } : { cmd: "status", args: [] });
      const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-HQ-Assistant-Token": process.env.HQ_ASSISTANT_TOKEN };
      http.request({ host: "127.0.0.1", port: Number(process.env.HQ_PORT), method: "POST", path: "/api/assistant", headers }, (res) => {
        let t = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (t += d));
        res.on("end", () => {
          total += 0.01;
          process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: `Heard: ${heard}\n${res.statusCode} ${t}`, total_cost_usd: total, session_id: process.env.HQ_ASSISTANT_SESSION }) + "\n");
        });
      }).end(body);
    }
  });
}
// A preload that makes spawn("fake-claude", args) run fakeMain with Node, and every other spawn as it was
function fakeClaude(dir) {
  const fake = path.join(dir, "fake-claude.js"), file = path.join(dir, "spawn-stub.js");
  fs.writeFileSync(fake, "(" + fakeMain.toString() + ")();\n");
  const lines = [
    'const cp = require("child_process");',
    "const real = cp.spawn;",
    `cp.spawn = function (cmd, args, opts) { return cmd === "fake-claude" ? real.call(this, process.execPath, [${JSON.stringify(fake)}, ...args], opts) : real.apply(this, arguments); };`,
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { file, env: {} };
}

test("the owner's words reach the assistant: /api/say starts it, its reply (made with its own new token) is in the payload and spoken, and its chat is the assistant's, also after a restart", async () => {
  const w = world(true, { assistant: { claude: "fake-claude", stripOpeners: ["Heard"] } });
  const fake = fakeClaude(path.dirname(w.state));
  let s = await start(w, { stub: fake });
  s.token = await tokenOf(s);
  const ev = events(s);
  try {
    let p = await hqNow(s);
    assert.deepEqual([p.assistant.state.status, p.assistant.messages], ["off", []]);
    assert.deepEqual([p.assistant.usage.assistantUsd, typeof p.assistant.usage.totalUsd], [0, "number"], "the week's usage line, nothing spent yet");
    const refusals = [
      ["no page token", { text: "hi" }, { "X-HQ-Token": "" }, 403],
      ["empty", { text: "  " }, {}, 400],
      ["too long", { text: "x".repeat(2001) }, {}, 400],
      ["another field", { text: "hi", as: "owner" }, {}, 400],
      ["reconsider not true", { text: "hi", reconsider: "yes" }, {}, 400],
    ];
    for (const [what, body, over, status] of refusals) assert.equal((await post(s, "/api/say", body, over)).status, status, what);
    // the owner's mic opened: the process starts, nothing is said, and the owner's words go to that same process with
    // its token
    assert.equal((await post(s, "/api/say", { warm: true }, { "X-HQ-Token": "" })).status, 403);
    assert.equal((await post(s, "/api/say", { warm: "yes" })).status, 400);
    assert.equal((await post(s, "/api/say", { warm: true, text: "hi" })).status, 400);
    const warm = await post(s, "/api/say", { warm: true });
    assert.deepEqual([warm.status, warm.body], [200, '{"ok":true}']);
    p = await hqNow(s);
    assert.deepEqual([p.assistant.state.status, p.assistant.messages], ["idle", []]);
    const r = await post(s, "/api/say", { text: "What sessions are running?" });
    assert.equal(r.status, 200, r.body);
    const reply = await until(async () => (await hqNow(s)).assistant.messages.find((m) => m.role === "assistant"), 20000, "the reply", s);
    assert.match(reply.text, /^Heard: What sessions are running\?\n200 Live \(what the owner sees in HQ's Live list, by the same titles\):\nada: /, "its token opened the channel");
    const spoken = spokenOf(reply.text, { openers: ["Heard"] });
    assert.ok(spoken && !spoken.startsWith("Heard"), "the configured opener is not spoken: " + spoken);
    await until(() => ev.got.some((e) => e.event === "say" && e.data.text === spoken), 5000, "the spoken reply", s);
    p = await hqNow(s);
    assert.deepEqual(p.assistant.messages.map((m) => m.role), ["owner", "assistant"]);
    assert.equal(p.assistant.state.status, "idle");
    // The panel's Stop, from the page only; with no turn running it stops nothing
    assert.equal((await post(s, "/api/say", { stop: true }, { "X-HQ-Token": "" })).status, 403);
    const halt = await post(s, "/api/say", { stop: true });
    assert.deepEqual([halt.status, halt.body], [200, '{"ok":true,"stopped":false}']);
    assert.equal((await post(s, "/api/say", { stop: "yes" })).status, 400);
    // the open mic's words carry reconsider: true (a turn on the owner's last words that still runs ends, one turn
    // answers both)
    assert.equal((await post(s, "/api/say", { text: "And bo?", reconsider: true })).status, 200);
    await until(async () => (await hqNow(s)).assistant.state.status === "idle", 20000, "the reconsidered turn", s);
    // Stop also drops what it proposed, so nothing it asked for waits for a yes
    assert.equal((await post(s, "/api/say", { text: "cmd open add a dark mode" })).status, 200);
    await until(async () => (await hqNow(s)).readbacks.length === 1, 20000, "the open read-back", s);
    assert.deepEqual((await post(s, "/api/say", { stop: true })).status, 200);
    assert.deepEqual((await hqNow(s)).readbacks, [], "Stop dropped it");
    assert.deepEqual((await hqNow(s)).settled.map((e) => [e.kind, e.what, e.outcome, e.via]), [["readback", "Open a new session with this prompt", "canceled", "Stop"]], "and the settled history says so");
    const sid = p.assistant.state.sessionId;
    // its transcript, once Claude Code writes one, is the assistant's chat: never a reply item
    const proj = path.join(w.data, "projects", "p-assistant");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, sid + ".jsonl"), jsonl([user({ sec: nowSec(), text: "hi" }), asst({ sec: nowSec(), stop: "end_turn", content: [{ type: "text", text: "Heard." }] })]));
    const mine = await until(async () => (await hqNow(s)).sessions.find((x) => x.id === sid), 15000, "its chat", s);
    assert.equal(mine.assistant, true);
    assert.ok(!(await hqNow(s)).decisions.some((d) => d.sessionId === sid), "no reply item");
    await stop(s);
    s = await start(w, { stub: fake });
    const again = await until(async () => (await hqNow(s)).sessions.find((x) => x.id === sid), 15000, "its chat after a restart", s);
    assert.equal(again.assistant, true, "known from sessions.json before any say");
  } finally {
    ev.close();
    await stop(s);
  }
});

test("with no assistant key the assistant is off: /api/say is 503, the voice too, and the payload's assistant is null", async () => {
  const w = world(true);
  const s = await start(w);
  s.token = await tokenOf(s);
  try {
    assert.equal((await hqNow(s)).assistant, null);
    const r = await post(s, "/api/say", { text: "hi" });
    assert.deepEqual([r.status, r.body], [503, "the assistant is off"]);
    const v = await post(s, "/api/tts", { text: "hi" });
    assert.deepEqual([v.status, v.body], [503, "voice off: the assistant is off"]);
  } finally {
    await stop(s);
  }
});

// A preload that answers the server's fetch as ElevenLabs would, with fake audio, and keeps each request in a file
function fakeVoice(dir) {
  const file = path.join(dir, "fetch-stub.js"), log = path.join(dir, "fetch.jsonl");
  const lines = [
    'const fs = require("fs");',
    "globalThis.fetch = async (url, init) => {",
    `  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url, key: init.headers["xi-api-key"], body: JSON.parse(init.body) }) + "\\n");`,
    '  return new Response("ID3-fake-audio", { status: 200, headers: { "content-type": "audio/mpeg" } });',
    "};",
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { file, env: {}, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

test("the voice: /api/tts streams ElevenLabs' audio for the configured voice and model with the key from ELEVENLABS_API_KEY, never the key itself; no key is 503", async () => {
  const w = world(true, { assistant: { voiceId: "voice-123", ttsModel: "model-9" } });
  const home = path.dirname(w.state);
  const voice = fakeVoice(home);
  let s = await start(w, { stub: voice, env: { ELEVENLABS_API_KEY: "" } });
  s.token = await tokenOf(s);
  let none;
  try {
    none = await post(s, "/api/tts", { text: "Hello." });
    assert.deepEqual([none.status, none.body], [503, "voice off: no ElevenLabs key"]);
  } finally {
    await stop(s);
  }
  s = await start(w, { stub: voice, env: { ELEVENLABS_API_KEY: "test-key-abc" } });
  s.token = await tokenOf(s);
  try {
    const refusals = [
      ["no page token", { text: "hi" }, { "X-HQ-Token": "" }, 403],
      ["empty", { text: "" }, {}, 400],
      ["too long", { text: "x".repeat(601) }, {}, 400],
      ["another field", { text: "hi", voice: "x" }, {}, 400],
    ];
    for (const [what, body, over, status] of refusals) assert.equal((await post(s, "/api/tts", body, over)).status, status, what);
    assert.equal(voice.calls().length, 0, "nothing sent for a refusal");
    const r = await post(s, "/api/tts", { text: "Hello." });
    assert.deepEqual([r.status, r.headers["content-type"], r.body], [200, "audio/mpeg", "ID3-fake-audio"]);
    const [call] = voice.calls();
    assert.match(call.url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/voice-123\/stream\?/);
    assert.deepEqual([call.key, call.body], ["test-key-abc", { text: "Hello.", model_id: "model-9" }]);
    assert.ok(!none.body.includes("test-key") && !r.body.includes("test-key"), "the key never comes back");
  } finally {
    await stop(s);
  }
});

test("hearing: /api/hear takes a WAV from HQ's own page only, and says so when no whisper.cpp folder is set", async () => {
  const w = world(true);
  const s = await start(w, { env: { VIBEQUARTERS_WHISPER_DIR: "" } });
  s.token = await tokenOf(s);
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(40)]);
  const hear = (body, over = {}) => request(s.port, { method: "POST", path: "/api/hear", headers: headers(s, { "Content-Type": "audio/wav", ...over }), body });
  try {
    const refusals = [
      ["no page token", wav, { "X-HQ-Token": "" }, 403],
      ["another site", wav, { Origin: "http://example.com" }, 403],
      ["not sent as a WAV", "{}", { "Content-Type": "application/json" }, 400],
      ["not a WAV inside", Buffer.alloc(60), {}, 400],
      ["too big", wav, { "Content-Length": 1024 * 1024 + 1 }, 400], // only the length says so: a body still being sent can meet the closed connection before the answer
    ];
    for (const [what, body, over, status] of refusals) assert.equal((await hear(body, over)).status, status, what);
    const off = await hear(wav);
    assert.deepEqual([off.status, off.body], [503, "hearing off: no whisper.cpp folder set"]);
  } finally {
    await stop(s);
  }
});

// A read is tied to its connection: when the page takes one back its run stops, or the read that matters waits behind it
test("hearing: a page that takes its read back stops the run at once", { skip: process.platform !== "win32" }, async () => {
  const w = world(true);
  const dir = path.join(path.dirname(w.state), "whisper");
  fs.mkdirSync(dir, { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(w.configPath, "utf8"));
  fs.writeFileSync(w.configPath, JSON.stringify({ ...cfg, assistant: { whisperDir: dir } }));
  // a whisper that never ends: cmd.exe takes these arguments and then waits on its open input
  fs.copyFileSync(path.join(process.env.SystemRoot, "System32", "cmd.exe"), path.join(dir, "whisper-cli.exe"));
  fs.writeFileSync(path.join(dir, "ggml-base.en.bin"), "");
  const folders = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("hq-hear-"));
  const before = new Set(folders());
  const s = await start(w);
  s.token = await tokenOf(s);
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(40)]);
  try {
    const r = http.request({ host: "127.0.0.1", port: s.port, method: "POST", path: "/api/hear", headers: { Host: `127.0.0.1:${s.port}`, ...headers(s, { "Content-Type": "audio/wav" }) } });
    r.on("error", () => {});
    r.end(wav);
    const mine = await until(() => folders().find((n) => !before.has(n)), 10000, "the run to start", s);
    r.destroy();
    await until(() => !fs.existsSync(path.join(os.tmpdir(), mine)), 10000, "the run to stop", s);
  } finally {
    await stop(s);
  }
});

// ---------- the restored panels' routes: agent switches, keep-warm, approvals, the queue and the plan line
const offFile = (w) => path.join(w.data, "hq-feed", "agents-off.json");
const hqOf = async (s) => JSON.parse((await request(s.port, { path: "/api/hq" })).body);
const agentOf = async (s, id) => (await hqOf(s)).floor.agents.find((a) => a.id === id);
const SCOUT = { id: "scout", name: "Scout", agentTypes: ["Explore"] };

test("switching an agent off needs the token, refuses an unknown id, and writes agents-off.json with the agent's types", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    for (const [what, over] of [["a wrong token", { "X-HQ-Token": "0".repeat(64) }], ["a wrong Origin", { Origin: "http://evil.example" }]]) {
      assert.equal((await post(s, "/api/agents", { id: "scout", on: false }, over)).status, 403, what);
      assert.ok(!fs.existsSync(offFile(w)), what + ": no file");
    }
    const nobody = await post(s, "/api/agents", { id: "nobody", on: false });
    assert.deepEqual([nobody.status, nobody.body], [400, "no such agent"]);
    assert.ok(!fs.existsSync(offFile(w)), "an unknown id: no file");
    const ok = await post(s, "/api/agents", { id: "scout", on: false });
    assert.deepEqual([ok.status, ok.body], [200, '{"ok":true}']);
    const f = JSON.parse(fs.readFileSync(offFile(w), "utf8"));
    assert.equal(f.v, 1);
    assert.deepEqual(f.off, [SCOUT]);
    assert.equal("cloudPausedByHq" in f, false, "no cloud side");
    await refreshed(s);
    const scout = await agentOf(s, "scout");
    assert.deepEqual([scout.off, scout.working, "cloud" in scout], [true, false, false]);
    assert.equal((await hqOf(s)).floor.switchesEnforced, false, "no switch hook registered in this data folder's settings.json");
  } finally {
    await stop(s);
  }
});

test("all off lists the example agents; all on empties the list", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    const ids = JSON.parse(fs.readFileSync(EXAMPLE, "utf8")).agents.map((a) => a.id);
    assert.equal(ids.length, 4);
    assert.equal((await post(s, "/api/agents", { all: true, on: false })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(offFile(w), "utf8")).off.map((a) => a.id), ids);
    assert.equal((await post(s, "/api/agents", { all: true, on: true })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(offFile(w), "utf8")).off, []);
  } finally {
    await stop(s);
  }
});

test("the switches survive a restart, resynced from the config; a registered switch hook shows as enforced", async () => {
  const w = world(true);
  let s = await start(w);
  try {
    s.token = await tokenOf(s);
    assert.equal((await post(s, "/api/agents", { id: "guide", on: false })).status, 200);
  } finally {
    await stop(s);
  }
  const f = JSON.parse(fs.readFileSync(offFile(w), "utf8"));
  fs.writeFileSync(offFile(w), JSON.stringify({ ...f, off: [{ id: "gone", name: "Gone", agentTypes: ["gone-*"] }, { ...f.off[0], agentTypes: ["old-*"] }] }));
  // the installer's entry for the system pack's switch hook, in the data folder's own settings.json
  fs.writeFileSync(path.join(w.data, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Agent|Task", hooks: [{ type: "command", command: "node", args: [path.join(w.data, "vibequarters", "hooks", "hq-agent-switch.js").split(path.sep).join("/")] }] }] } }));
  s = await start(w);
  try {
    assert.equal((await agentOf(s, "guide")).off, true);
    assert.equal((await agentOf(s, "scout")).off, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(offFile(w), "utf8")).off, [{ id: "guide", name: "Guide", agentTypes: ["claude-code-guide", "statusline-setup"] }], "resynced from the config at start");
    assert.equal((await hqOf(s)).floor.switchesEnforced, true);
  } finally {
    await stop(s);
  }
});

test("keep-warm: only a chat whose hq-feed mod reports in can be switched, and the switch lands in hq-feed/control", async () => {
  const w = world(true);
  const s = await start(w);
  try {
    s.token = await tokenOf(s);
    assert.equal((await post(s, "/api/warm", { sessionId: "nope", on: true })).status, 400);
    const none = await post(s, "/api/warm", { sessionId: S, on: true });
    assert.deepEqual([none.status, none.body], [400, "that chat has no hq-feed mod"]);
    fs.mkdirSync(path.join(w.data, "hq-feed"), { recursive: true });
    fs.writeFileSync(path.join(w.data, "hq-feed", S + ".json"), JSON.stringify({ v: 1, sessionId: S, updatedAt: Date.now(), warm: { on: false, pings: 0, lastPingAt: null, stopped: null }, brake: { asks: 0 } }));
    await until(async () => { const x = (await hqOf(s)).sessions.find((y) => y.id === S); return x && x.warm && x.warm.canWarm; }, 15000, "the mod's report in the payload", s);
    const ok = await post(s, "/api/warm", { sessionId: S, on: true });
    assert.deepEqual([ok.status, ok.body], [200, '{"ok":true}']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.data, "hq-feed", "control", S + ".json"), "utf8")).keepWarm, true);
    await until(async () => (await hqOf(s)).sessions.find((y) => y.id === S).warm.on === true, 15000, "keep-warm on in the payload", s);
  } finally {
    await stop(s);
  }
});

test("approvals: first run has no choice; a preset is saved by id with the token, an unknown one is refused, and the lists are never written", async () => {
  const w = world(true, { systemDir: path.join(ROOT, "test", "fixtures", "system") });
  const s = await start(w);
  try {
    const first = JSON.parse((await request(s.port, { path: "/api/approvals" })).body);
    assert.equal(first.chosen, null);
    assert.equal(first.canChoose, true);
    assert.deepEqual(first.presets.map((p) => [p.id, p.recommended, p.installed]), [["ask-all", false, true], ["safe-reads", false, false], ["routine", true, true], ["routine-judge", false, true]]);
    s.token = await tokenOf(s);
    assert.equal((await post(s, "/api/approvals", { preset: "routine" }, { "X-HQ-Token": "0".repeat(64) })).status, 403);
    for (const bad of [{ preset: "everything" }, { routine: { tools: ["Bash"] } }, {}]) assert.equal((await post(s, "/api/approvals", bad)).status, 400, JSON.stringify(bad));
    assert.ok(!fs.existsSync(path.join(w.state, "approvals-choice.json")), "nothing saved yet");
    const levels = fs.readFileSync(path.join(ROOT, "approval-levels.json"), "utf8");
    assert.equal((await post(s, "/api/approvals", { preset: "routine" })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, "approvals-choice.json"), "utf8")).preset, "routine");
    assert.equal(JSON.parse((await request(s.port, { path: "/api/approvals" })).body).chosen, "routine");
    assert.equal(fs.readFileSync(path.join(ROOT, "approval-levels.json"), "utf8"), levels, "the app's own list is untouched");
  } finally {
    await stop(s);
  }
});

test("the queue answers from the data folder's coordination registry, and the plan line from vibequarters-usage, with the config's label", async () => {
  const KEY = "k1aaaaaaaaaaaaaa";
  const w = world(true, { accountLabels: { [KEY]: "Work" } });
  fs.mkdirSync(path.join(w.data, "coordination"), { recursive: true });
  fs.writeFileSync(path.join(w.data, "coordination", "registry.json"), JSON.stringify({ sessions: { [S]: { id: S, name: "ada", lastSeen: Date.now() } }, claims: [{ repo: "r", path: "a.js", session: S, at: 1 }], locks: { merge: { session: S, at: Date.now() } }, notes: [] }));
  fs.mkdirSync(path.join(w.data, "vibequarters-usage"), { recursive: true });
  fs.writeFileSync(path.join(w.data, "vibequarters-usage", "plan-usage.json"), JSON.stringify({ v: 1, accountKey: KEY, seven_day: 41, five_hour: 7, resetsAt: new Date(Date.now() + 3 * 864e5).toISOString(), at: Date.now() }));
  const s = await start(w);
  try {
    const q = JSON.parse((await request(s.port, { path: "/api/queue" })).body);
    assert.deepEqual([q.locks[0].name, q.locks[0].holder, q.sessions[0].name, q.sessions[0].files], ["merge", "ada", "ada", 1]);
    assert.equal(q.github, "off", "no queue.repos in the config: GitHub is never asked");
    assert.equal(q.gate.liveCheck, process.platform === "win32" ? "no-hooks" : "unavailable", "no system pack in this data folder");
    await refreshed(s);
    const p = await hqOf(s);
    assert.deepEqual([p.vitals.plan.pct, p.vitals.plan.fiveHour], [41, 7]);
    assert.deepEqual(p.vitals.accounts.rows.map((r) => [r.label, r.current]), [["Work", true]]);
    assert.ok(!JSON.stringify(p).includes(KEY), "the account key never reaches the page");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.data, "vibequarters-usage", "accounts.json"), "utf8")).accounts.map((r) => r.accountKey), [KEY]);
    assert.deepEqual([p.board.locks[0].name, p.vitals.filesClaimed], ["merge", 1]);
  } finally {
    await stop(s);
  }
});

test("read-only: the switch, keep-warm and approvals writes are refused, nothing is written, and the chooser says it cannot choose", async () => {
  const w = world(false);
  const s = await start(w);
  try {
    s.token = "ab".repeat(32);
    for (const [p, body] of [["/api/agents", { id: "scout", on: false }], ["/api/warm", { sessionId: S, on: true }], ["/api/approvals", { preset: "routine" }]]) assert.equal((await post(s, p, body)).status, 405, p);
    assert.ok(!fs.existsSync(offFile(w)), "no switch is written");
    assert.ok(!fs.existsSync(path.join(w.state, "approvals-choice.json")), "no choice is written");
    assert.equal(JSON.parse((await request(s.port, { path: "/api/approvals" })).body).canChoose, false);
  } finally {
    await stop(s);
  }
});
