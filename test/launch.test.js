// launch.js, the SessionStart launcher: a machine with no browser opener never fails the session start.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// A server that writes its port file, answers, and ends by itself
const SERVER = `const http = require("http"), fs = require("fs"), path = require("path");
const s = http.createServer((q, r) => r.end("{}")).listen(0, "127.0.0.1", () => fs.writeFileSync(path.join(__dirname, ".runtime.json"), JSON.stringify({ port: s.address().port })));
setTimeout(() => process.exit(0), 6000);`;

for (const platform of ["linux", "darwin", "win32"])
  test(`with no program to open the page (${platform}), the server still starts and the launcher ends clean`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-launch-"));
    try {
      fs.copyFileSync(path.join(__dirname, "..", "launch.js"), path.join(dir, "launch.js"));
      fs.writeFileSync(path.join(dir, "server.js"), SERVER);
      fs.writeFileSync(path.join(dir, "pre.js"), `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });\n`);
      fs.mkdirSync(path.join(dir, "empty"));
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
      const r = spawnSync(process.execPath, ["--require", path.join(dir, "pre.js"), path.join(dir, "launch.js")], { env: { ...env, PATH: path.join(dir, "empty") }, encoding: "utf8", timeout: 30000 });
      assert.deepEqual([r.status, r.stderr], [0, ""]);
      assert.ok(fs.existsSync(path.join(dir, ".runtime.json")), "the server started");
      assert.equal(fs.existsSync(path.join(dir, ".launch.lock")), false, "the lock is released");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 200 });
    }
  });
