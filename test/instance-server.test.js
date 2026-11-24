// The real server in a child process, with a fake user folder whose ~/.claude holds a canary session. A copy started
// with a settings file must show only its own data, keep its port file and cache in its own state folder, and leave the
// app folder's port file alone.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { T0, asst, jsonl } = require("./helpers");
const { CACHE_NAME } = require("../lib/instance");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server.js");
const EXAMPLE = path.join(ROOT, "hq.config.example.json");
// a home folder that is nowhere on this machine, and the name Claude Code gives its projects
const [STUDIO, STUDIO_KEY] = path.sep === "\\" ? ["D:/work", "D--work"] : ["/work", "-work"];
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const nowSec = () => Math.round((Date.now() - T0) / 1000); // rows stamped now, so every window counts them
const readJson = (fp) => { try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return null; } };
// The child's exit code, or "still running" after 10 s.
const exitOf = (proc) => Promise.race([new Promise((r) => proc.child.on("exit", r)), new Promise((r) => setTimeout(() => r("still running"), 10000).unref())]);

function fakeHome() {
  const home = tmp("hq-home-");
  const C = "cccccccc-0000-0000-0000-000000000003";
  const proj = path.join(home, ".claude", "projects", "canary-project");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, C + ".jsonl"), jsonl([{ type: "custom-title", customTitle: "canary-peer", sessionId: C }, asst({ sec: nowSec(), usage: { output_tokens: 1e6 } })]));
  return home;
}
function start(settings, home) {
  const child = spawn(process.execPath, [SERVER, "--settings", settings], { env: { ...process.env, USERPROFILE: home, HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
  const err = { text: "" };
  child.stderr.on("data", (c) => (err.text += c));
  return { child, err };
}
async function until(fn, ms, what, proc) {
  const end = Date.now() + ms;
  for (;;) {
    if (proc.child.exitCode !== null) throw new Error(`the server exited (${proc.child.exitCode}) while waiting for ${what}: ${proc.err.text}`);
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const getJson = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: p }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => resolve(JSON.parse(b)));
  }).on("error", reject);
});

test("a copy with a settings file shows only its own data and keeps its port file and cache in its own folder", async () => {
  const home = fakeHome(), data = tmp("hq-data-"), state = path.join(tmp("hq-state-"), "state");
  const D = "dddddddd-0000-0000-0000-000000000004";
  fs.mkdirSync(path.join(data, "projects", STUDIO_KEY + "-webapp"), { recursive: true });
  fs.writeFileSync(path.join(data, "projects", STUDIO_KEY + "-webapp", D + ".jsonl"), jsonl([{ type: "custom-title", customTitle: "work-17", sessionId: D }, asst({ sec: nowSec(), usage: { output_tokens: 1e6 } })]));
  const settings = path.join(tmp("hq-settings-"), "demo.settings.json");
  fs.writeFileSync(settings, JSON.stringify({ sealed: true, dataDir: data, stateDir: state, configPath: EXAMPLE, port: 0, homeDir: STUDIO }));
  const proc = start(settings, home);
  try {
    const rt = await until(() => readJson(path.join(state, ".runtime.json")), 15000, "the copy's port file", proc);
    assert.ok(rt.port > 0, "the port file records the port actually bound, not 0");
    const hq = await until(async () => { const b = await getJson(rt.port, "/api/hq"); return !b.building && b; }, 30000, "the first index", proc);
    const stats = await getJson(rt.port, "/api/stats");
    assert.ok(JSON.stringify(hq).includes("work-17"), "the copy's own sessions are read");
    assert.deepEqual(stats.byProject.map((p) => p.project), ["webapp"], "projects are labeled under the copy's home folder");
    assert.ok(!(JSON.stringify(hq) + JSON.stringify(stats)).includes("canary"), "nothing from the user folder's ~/.claude");
    assert.equal(hq.homeName, "work", "the page's home folder name comes from the settings, not the real user folder");
    const me = path.basename(os.homedir()); // the real user folder's name; every fake folder sits under its temp folder
    assert.ok(!(JSON.stringify(hq) + JSON.stringify(stats)).includes(me), "no absolute path from this machine leaks into the payloads");
    assert.ok(fs.existsSync(path.join(state, CACHE_NAME)), "the parse cache is in the copy's state folder");
    const appRt = readJson(path.join(ROOT, ".runtime.json")); // absent, or an earlier server's: never this copy's
    assert.ok(!appRt || appRt.pid !== proc.child.pid, "the app folder's port file is not this copy's");
  } finally {
    proc.child.kill();
  }
});

test("a sealed copy whose data folder is inside the user folder refuses to start", async () => {
  const home = fakeHome();
  const settings = path.join(tmp("hq-settings-"), "bad.settings.json");
  fs.writeFileSync(settings, JSON.stringify({ sealed: true, dataDir: path.join(home, ".claude"), stateDir: path.join(tmp("hq-state-"), "s"), configPath: EXAMPLE, port: 0 }));
  const proc = start(settings, home);
  try {
    const code = await exitOf(proc);
    assert.notEqual(code, "still running", "the copy started instead of refusing");
    assert.notEqual(code, 0);
    assert.match(proc.err.text, /^settings bad\.settings\.json: sealed, but dataDir is inside the user folder\s*$/, "one line: the file and the problem, no stack");
    assert.ok(!proc.err.text.includes(home), "the message never prints the user folder's path");
  } finally {
    proc.child.kill();
  }
});

test("a sealed copy whose config reads a heartbeat inside the user folder refuses to start, naming the agent, never the path", async () => {
  const home = fakeHome(), data = tmp("hq-data-");
  fs.mkdirSync(path.join(data, "projects"));
  const config = JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));
  const beat = path.join(home, "my-project", "heartbeat", "scout.json");
  config.agents[0].heartbeat = beat;
  const cfgFile = path.join(data, "demo.config.json");
  fs.writeFileSync(cfgFile, JSON.stringify(config));
  const settings = path.join(tmp("hq-settings-"), "beat.settings.json");
  fs.writeFileSync(settings, JSON.stringify({ sealed: true, dataDir: data, stateDir: path.join(tmp("hq-state-"), "s"), configPath: cfgFile, port: 0 }));
  const proc = start(settings, home);
  try {
    const code = await exitOf(proc);
    assert.notEqual(code, "still running", "the copy started instead of refusing");
    assert.notEqual(code, 0);
    assert.match(proc.err.text, new RegExp(`^settings beat\\.settings\\.json: sealed, but agent "${config.agents[0].id}" reads a heartbeat inside the user folder\\s*$`), "one line: the file, the agent and the problem, no stack");
    assert.ok(!proc.err.text.includes(home) && !proc.err.text.includes(beat), "the message never prints the heartbeat's path");
  } finally {
    proc.child.kill();
  }
});

test("a copy whose config file cannot be read refuses to start and names the setting and the error code, never the file's path", async () => {
  const home = fakeHome(), data = tmp("hq-data-");
  fs.mkdirSync(path.join(data, "projects"));
  const settings = path.join(tmp("hq-settings-"), "noconfig.settings.json");
  fs.writeFileSync(settings, JSON.stringify({ sealed: true, dataDir: data, stateDir: path.join(tmp("hq-state-"), "s"), configPath: path.join(data, "missing.config.json"), port: 0 }));
  const proc = start(settings, home);
  try {
    const code = await exitOf(proc);
    assert.notEqual(code, "still running", "the copy started instead of refusing");
    assert.notEqual(code, 0);
    assert.match(proc.err.text, /^settings noconfig\.settings\.json: configPath cannot be read \(ENOENT\)\s*$/, "one line: the file, the setting and the error code");
    assert.ok(!proc.err.text.includes(data), "the message never prints the config file's path");
  } finally {
    proc.child.kill();
  }
});

test("a copy whose state folder cannot be created refuses to start and names the setting, never the folder", async () => {
  const home = fakeHome(), data = tmp("hq-data-"), blocker = path.join(tmp("hq-state-"), "a-file");
  fs.mkdirSync(path.join(data, "projects"));
  fs.writeFileSync(blocker, "not a folder"); // a folder under a regular file cannot be made on any platform
  const state = path.join(blocker, "state");
  const settings = path.join(tmp("hq-settings-"), "blocked.settings.json");
  fs.writeFileSync(settings, JSON.stringify({ sealed: true, dataDir: data, stateDir: state, configPath: EXAMPLE, port: 0 }));
  const proc = start(settings, home);
  try {
    const code = await exitOf(proc);
    assert.notEqual(code, "still running", "the copy started instead of refusing");
    assert.notEqual(code, 0);
    assert.match(proc.err.text, /^settings blocked\.settings\.json: stateDir cannot be created \([A-Z]+\)\s*$/, "one line: the file, the setting and the error code");
    assert.ok(!proc.err.text.includes(state), "the message never prints the folder's path");
    assert.ok(!fs.existsSync(path.join(state, ".runtime.json")), "no port file was written");
  } finally {
    proc.child.kill();
  }
});

test("a sealed copy with control in its config runs read-only: no token, no write route, its decisions folder never read", async () => {
  const mine = []; // this test's temp folders, removed at its end
  const own = (p) => {
    const d = tmp(p);
    mine.push(d);
    return d;
  };
  const home = fakeHome(), data = own("hq-data-"), state = path.join(own("hq-state-"), "state");
  mine.push(home);
  fs.mkdirSync(path.join(data, "projects"), { recursive: true });
  const config = JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));
  config.control = true;
  const configPath = path.join(own("hq-config-"), "hq.config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const folder = path.join(state, "decisions");
  fs.mkdirSync(folder, { recursive: true });
  const id = "c".repeat(32);
  const planted = path.join(folder, id + ".json");
  fs.writeFileSync(planted, JSON.stringify({ v: 1, id, pid: process.pid, askedAt: Date.now(), event: "PermissionRequest", sessionId: "s1", transcriptPath: "t", toolName: "Bash", toolInput: { command: "canary-decision-cmd" }, cwd: null }));
  const old = new Date(Date.now() - 3600e3); // old enough that a sweep would remove it
  fs.utimesSync(planted, old, old);
  const mtime = fs.statSync(planted).mtimeMs;
  const settings = path.join(own("hq-settings-"), "sealed.settings.json");
  fs.writeFileSync(settings, JSON.stringify({ sealed: true, dataDir: data, stateDir: state, configPath, port: 0, homeDir: STUDIO }));
  const proc = start(settings, home);
  try {
    const rt = await until(() => readJson(path.join(state, ".runtime.json")), 15000, "the copy's port file", proc);
    assert.equal(rt.control, false);
    const hq = await until(async () => { const b = await getJson(rt.port, "/api/hq"); return !b.building && b; }, 30000, "the first index", proc);
    assert.deepEqual(hq.decisions, []);
    assert.ok(!JSON.stringify(hq).includes("canary-decision-cmd"));
    const call = (method, body) => new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: rt.port, path: method === "GET" ? "/" : "/api/answer", method, headers: { Origin: `http://127.0.0.1:${rt.port}`, "Content-Type": "application/json" } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      });
      r.on("error", reject);
      r.end(body);
    });
    assert.ok(!(await call("GET")).body.includes("hq-token"));
    assert.equal((await call("POST", JSON.stringify({ id, choice: "allow" }))).status, 405);
    assert.deepEqual(fs.readdirSync(folder), [id + ".json"]);
    assert.equal(fs.statSync(planted).mtimeMs, mtime);
    assert.ok(!fs.existsSync(path.join(state, "answers.log.jsonl")) && !fs.existsSync(path.join(state, ".hq-presence.json")));
  } finally {
    if (proc.child.exitCode === null && proc.child.signalCode === null) {
      const gone = new Promise((r) => proc.child.once("exit", r));
      proc.child.kill();
      await gone;
    }
    for (const d of mine) await fs.promises.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
