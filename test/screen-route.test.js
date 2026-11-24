// GET /api/screen/<id> serves a screenshot a desk screen shows, by the opaque id HQ issued for it, read-only,
// 127.0.0.1 only like every route, with no-store and its type from the checked header. An id never issued is a 404, and
// a request carrying a path, in its query or its body, serves nothing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { handler } = require("../server");
const { T0, asst, tool, jsonl } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const roots = [];
test.after(async () => {
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
// a refused POST closes its connection (server.js closing), so a reset after the answer arrived is the answer
function req(port, p, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let got = null;
    const done = () => resolve({ ...got, body: Buffer.concat(parts) });
    // a GET's body goes with its length, or Node sends the bytes bare and the server reads them as the next request
    if (body !== undefined) headers = { ...headers, "content-length": Buffer.byteLength(body) };
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      got = { status: res.statusCode, headers: res.headers };
      res.on("data", (c) => parts.push(c));
      res.on("end", done);
      res.on("error", done);
    });
    r.on("error", (e) => (got ? done() : reject(e)));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

test("in this server: an id never issued, a malformed id, a path, a query or a body all serve nothing", async () => {
  const server = http.createServer(handler).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port, png = path.join(ROOT, "assets", "x.png");
  try {
    for (const p of ["/api/screen/" + "0".repeat(32), "/api/screen/zzz", "/api/screen/", "/api/screen", "/api/screen/C:/Windows/win.ini", "/api/screen/..%2f..%2fhq.config.json",
      "/api/screen/" + "0".repeat(32) + "?path=" + encodeURIComponent(png), "/api/screen?path=" + encodeURIComponent(png)]) {
      const r = await req(port, p);
      assert.equal(r.status, 404, p);
      assert.equal(r.headers["cache-control"], "no-store", p);
      assert.equal(r.headers["cross-origin-resource-policy"], "same-origin", p);
    }
    assert.equal((await req(port, "/api/screen/" + "0".repeat(32), { headers: { "content-type": "application/json" }, body: JSON.stringify({ path: png }) })).status, 404, "a GET with a body");
    assert.equal((await req(port, "/api/screen/" + "0".repeat(32), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: png }) })).status, 405, "read-only");
    assert.equal((await req(port, "/api/screen/" + "0".repeat(32), { headers: { host: "evil.example:80" } })).status, 403, "127.0.0.1 only");
  } finally {
    server.close();
  }
});

// The real server in a child process over a fake home: a chat that took a screenshot. The payload names an id, never
// the file; the id serves the file's bytes as image/png with no-store, and the same id with a query serves nothing.
test("a running copy serves the screenshot a screen shows by its id, and only that way", async () => {
  const home = tmp("hq-route-home-"), data = tmp("hq-route-data-"), state = path.join(tmp("hq-route-state-"), "state"), user = tmp("hq-route-user-");
  roots.push(home, data, path.dirname(state), user);
  const S = "dddddddd-0000-0000-0000-00000000000d";
  const sec = Math.round((Date.now() - 5000 - T0) / 1000);
  const nav = tool("mcp__playwright__browser_navigate", { url: "http://localhost:5173/" }), shot = tool("mcp__playwright__browser_take_screenshot", {});
  const res = (s, id, text) => ({ type: "user", timestamp: new Date(T0 + s * 1000).toISOString(), cwd: home, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
  fs.mkdirSync(path.join(data, "projects", "p"), { recursive: true });
  fs.writeFileSync(path.join(data, "projects", "p", S + ".jsonl"), jsonl([
    { ...asst({ sec, content: [nav] }), cwd: home }, res(sec + 1, nav.id, "### Page\n- Page URL: http://localhost:5173/\n- Page Title: Shop"),
    { ...asst({ sec: sec + 2, content: [shot] }), cwd: home }, res(sec + 3, shot.id, `### Result\n- [Screenshot of viewport](${path.join("AppData", "Local", "Temp", "claude", "p", "page.png")})`),
  ]));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("route fixture")]);
  fs.mkdirSync(path.join(home, "AppData", "Local", "Temp", "claude", "p"), { recursive: true });
  fs.writeFileSync(path.join(home, "AppData", "Local", "Temp", "claude", "p", "page.png"), png);
  const settings = path.join(tmp("hq-route-settings-"), "t.settings.json");
  roots.push(path.dirname(settings));
  fs.writeFileSync(settings, JSON.stringify({ sealed: true, dataDir: data, stateDir: state, configPath: path.join(ROOT, "hq.config.example.json"), port: 0, homeDir: home }));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js"), "--settings", settings], { env: { ...process.env, USERPROFILE: user, HOME: user }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  try {
    const until = async (fn, what) => {
      for (const end = Date.now() + 30000; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) {
        if (child.exitCode !== null) throw new Error("the server exited: " + err);
        const v = await fn().catch(() => null);
        if (v) return v;
      }
      throw new Error("timed out waiting for " + what);
    };
    const port = await until(async () => JSON.parse(fs.readFileSync(path.join(state, ".runtime.json"), "utf8")).port, "the port file");
    const id = await until(async () => {
      const b = JSON.parse((await req(port, "/api/hq")).body.toString("utf8"));
      const s = b.floor && b.floor.sessions.find((x) => x.id === S);
      return s && s.screen && s.screen.shot;
    }, "the screen's id");
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.ok(!(await req(port, "/api/hq")).body.toString("utf8").includes("page.png"), "the payload never names the file");
    const r = await req(port, "/api/screen/" + id);
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/png");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["cross-origin-resource-policy"], "same-origin", "no other site may embed it");
    assert.ok(r.body.equals(png), "the file's own bytes");
    assert.equal((await req(port, "/api/screen/" + id + "?path=C:/Windows/win.ini")).status, 404, "the issued id with a query serves nothing");
    assert.equal((await req(port, "/api/screen/" + id, { headers: { "content-type": "text/plain" }, body: "C:/Windows/win.ini" })).status, 404, "nor with a body");
    assert.equal((await req(port, "/api/screen/" + "0".repeat(32))).status, 404, "an id never issued");
  } finally {
    child.kill();
  }
});
