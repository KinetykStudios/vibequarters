// lib/opener.js: the assistant opens a new attended session through `code --open-url` on the extension's prompt link.
// On Windows `code` is code.cmd, which Node will not run without a shell, so the opener runs what code.cmd runs
// (Code.exe on VS Code's cli.js, as Node) with an argv, never a shell string.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const opener = require("../lib/opener");
// the opener's own logic, whatever system the tests run on; what it does elsewhere has its own test
const openSession = (what, opts) => opener.openSession(what, { platform: "win32", ...opts });

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A VS Code install with only its bin\code.cmd, worded as the real one is (the folder name is the build's).
function install() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hq-opener-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin", "code.cmd"), [
    "@echo off", "setlocal", "set VSCODE_DEV=", "set ELECTRON_RUN_AS_NODE=1",
    '"%~dp0..\\Code.exe" "%~dp0..\\abc123def0\\resources\\app\\out\\cli.js" %*',
    "IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%", "endlocal", "",
  ].join("\r\n"));
  return root;
}

function fakeExec(err = null) {
  const calls = [];
  const execFile = (file, args, opts, cb) => { calls.push({ file, args, opts }); setImmediate(() => cb(err, "", "")); };
  return { calls, execFile };
}

const OPEN_FLAG = "--open-url";
test("opens the prompt link with Code.exe on VS Code's cli, as code --open-url does", async () => {
  const root = install();
  const { calls, execFile } = fakeExec();
  const env = { Path: `${path.join(root, "nowhere")};${path.join(root, "bin")}`, VSCODE_DEV: "1", KEEP: "x" };
  const prompt = 'Say ready now. & %PATH% "quoted"';
  assert.deepEqual(await openSession({ prompt }, { execFile, env }), { ok: true });
  assert.equal(calls.length, 1);
  const { file, args, opts } = calls[0];
  assert.equal(file, path.join(root, "Code.exe"));
  assert.deepEqual(args, [
    path.join(root, "abc123def0", "resources", "app", "out", "cli.js"),
    OPEN_FLAG,
    "vscode://anthropic.claude-code/open?prompt=Say%20ready%20now.%20%26%20%25PATH%25%20%22quoted%22",
  ]);
  assert.equal(opts.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal("VSCODE_DEV" in opts.env, false);
  assert.equal(opts.env.KEEP, "x");
  assert.ok(!opts.shell, "never a shell");
});

test("a prompt must be 1 to 2000 characters", async () => {
  const root = install();
  const env = { PATH: path.join(root, "bin") };
  for (const prompt of ["", "   ", "x".repeat(2001), undefined, 42]) {
    const { calls, execFile } = fakeExec();
    const r = await openSession({ prompt }, { execFile, env });
    assert.equal(r.ok, false, String(prompt).slice(0, 20));
    assert.match(r.error, /1 to 2000 characters/);
    assert.equal(calls.length, 0);
  }
  const { execFile } = fakeExec();
  assert.deepEqual(await openSession({ prompt: "x".repeat(2000) }, { execFile, env }), { ok: true });
  // Counted as the read-back counts them, in characters (code points), not UTF-16 units
  const face = String.fromCodePoint(0x1f600);
  assert.deepEqual(await openSession({ prompt: face.repeat(2000) }, { execFile, env }), { ok: true }, "2000 emoji is 2000 characters");
  assert.equal((await openSession({ prompt: face.repeat(2001) }, { execFile, env })).ok, false);
});

test("no code.cmd on PATH is an error, not a guess", async () => {
  const root = install();
  const { calls, execFile } = fakeExec();
  const r = await openSession({ prompt: "hi" }, { execFile, env: { PATH: path.join(root, "nowhere") } });
  assert.equal(r.ok, false);
  assert.match(r.error, /code\.cmd/);
  assert.equal(calls.length, 0);
});

test("off Windows nothing is opened, and the answer says so plainly", async () => {
  const root = install();
  for (const platform of ["linux", "darwin"]) {
    const { calls, execFile } = fakeExec();
    const r = await opener.openSession({ prompt: "hi" }, { execFile, env: { PATH: path.join(root, "bin") }, platform });
    assert.equal(r.ok, false);
    assert.match(r.error, /only on Windows/);
    assert.ok(!/code\.cmd/.test(r.error), r.error);
    assert.equal(calls.length, 0);
  }
});

test("a launch that fails reports why", async () => {
  const root = install();
  const { execFile } = fakeExec(new Error("spawn ENOENT"));
  const r = await openSession({ prompt: "hi" }, { execFile, env: { PATH: path.join(root, "bin") } });
  assert.equal(r.ok, false);
  assert.match(r.error, /spawn ENOENT/);
});
