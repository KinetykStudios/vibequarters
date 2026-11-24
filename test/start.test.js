// npm start, as the README says to start HQ: a copy of the app in a temporary folder, with its own home folder, started
// with npm. The bridge acts on the page's answers only when it finds HQ's process by its full path, so what npm start
// runs must be what the bridge looks for.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const WIN = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (fp) => { try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return null; } };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });

test("npm start runs HQ as the bridge's lookup finds it, and ends when HQ ends", { timeout: 240000 }, async () => {
  assert.match(fs.readFileSync(path.join(ROOT, "README.md"), "utf8"), /^npm start$/m, "the README's start command");
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "hq-start-")));
  const app = path.join(root, "app"), home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  for (const n of ["bin", "bridge", "lib", "package.json", "server.js", "collect.js", "config.js", "pricing.js"]) fs.cpSync(path.join(ROOT, n), path.join(app, n), { recursive: true });
  fs.writeFileSync(path.join(app, "hq.config.json"), JSON.stringify({ ...readJson(path.join(ROOT, "hq.config.example.json")), control: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, VIBEQUARTERS_PORT: String(await freePort()) };
  // one command line, so Windows finds npm.cmd
  const child = spawn("npm start", { cwd: app, env, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let said = "";
  child.stdout.on("data", (c) => (said += c));
  child.stderr.on("data", (c) => (said += c));
  const closed = new Promise((r) => child.on("exit", r));
  let rt = null;
  try {
    for (const end = Date.now() + 60000; !(rt = readJson(path.join(app, ".runtime.json"))); ) {
      assert.ok(Date.now() < end && child.exitCode === null, "HQ did not start (" + child.exitCode + "): " + said);
      await sleep(300);
    }
    assert.equal(rt.control, true);
    if (WIN) {
      // null is a lookup that ran out of time on a busy machine, so it is asked again; a no fails at once
      let r;
      for (let i = 0; i < 4 && (!r || r.stdout.trim() === "null"); i++) r = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(app, "bridge", "hq-bridge.js"))}).isHq(${JSON.stringify(rt)}, ${JSON.stringify(app)}).then((x) => console.log(x))`], { env, encoding: "utf8", windowsHide: true });
      assert.equal(r.stdout.trim(), "true", r.stderr);
    }
    process.kill(rt.pid);
    assert.equal(await Promise.race([closed.then(() => "ended"), sleep(20000).then(() => "still running")]), "ended", "npm start ends with HQ");
  } finally {
    if (rt) try { process.kill(rt.pid); } catch {}
    if (child.exitCode === null) child.kill();
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
