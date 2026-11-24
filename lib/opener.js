// Opening a new attended session: the Claude Code extension's link vscode://anthropic.claude-code/open?prompt= opens a
// new tab in the last focused VS Code window, in that window's folder, and sends the prompt by itself. The link takes
// no folder, so the drafted prompt names where to work. `code --open-url` hands the link over; on Windows `code` is
// code.cmd, which Node will not run without a shell, so this runs what code.cmd runs (Code.exe on VS Code's cli.js, as
// Node) with an argv. Both paths are read from code.cmd itself, so an update that renames the build folder still works.
// Nothing is opened on macOS or Linux yet: the answer says so.
"use strict";
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const LINK = "vscode://anthropic.claude-code/open?prompt=";

// code.cmd in the first PATH folder that has one. A Windows env key can be any case ("Path"), and a copied env loses
// the case-blind lookup process.env has.
function findCodeCmd(env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  for (const dir of String((key && env[key]) || "").split(";")) {
    const p = dir.trim() && path.join(dir.trim().replace(/"/g, ""), "code.cmd");
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// code.cmd's launch line: "%~dp0..\Code.exe" "%~dp0..\<build>\resources\app\out\cli.js" %*
function launchOf(cmdPath) {
  const m = /"%~dp0([^"]+\.exe)"\s+"%~dp0([^"]+\\cli\.js)"/i.exec(fs.readFileSync(cmdPath, "utf8"));
  if (!m) return null;
  const bin = path.dirname(cmdPath);
  return { exe: path.join(bin, ...m[1].split("\\")), cli: path.join(bin, ...m[2].split("\\")) };
}

function openSession({ prompt } = {}, { execFile = childProcess.execFile, env = process.env, platform = process.platform } = {}) {
  if (typeof prompt !== "string" || !prompt.trim() || [...prompt].length > 2000) { // characters (code points), as the read-back counts them
    return Promise.resolve({ ok: false, error: "The prompt must be 1 to 2000 characters." });
  }
  if (platform !== "win32") return Promise.resolve({ ok: false, error: "Opening a new session from the page works only on Windows so far. Open one yourself and give it the prompt." });
  const cmd = findCodeCmd(env);
  if (!cmd) return Promise.resolve({ ok: false, error: "VS Code's code.cmd is not on PATH, so no session can be opened." });
  const launch = launchOf(cmd);
  if (!launch) return Promise.resolve({ ok: false, error: "VS Code's code.cmd has a launch line the opener does not know." });
  // The same env code.cmd sets: VSCODE_DEV cleared, ELECTRON_RUN_AS_NODE on.
  const childEnv = {};
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() !== "VSCODE_DEV") childEnv[k] = v;
  childEnv.ELECTRON_RUN_AS_NODE = "1";
  return new Promise((resolve) => {
    execFile(launch.exe, [launch.cli, "--open-url", LINK + encodeURIComponent(prompt)], { env: childEnv, windowsHide: true, timeout: 30e3 },
      (e) => resolve(e ? { ok: false, error: `VS Code did not open the session: ${e.message}` } : { ok: true }));
  });
}

module.exports = { openSession };
