// Test only: stands in for the bridge's PowerShell lookup of the process listening on HQ's port. Required by
// bridge.test.js, and loaded with --require into a bridge run as a program, it answers an execFile of powershell.exe
// (any folder) with the JSON the lookup prints: HQ_FAKE_LOOKUP's text in a program, else setLookup's answer, a text or a
// function of the lookup's script (which may return a promise, for a slow lookup); null fails the lookup. Every other
// execFile runs as it would.
// Off Windows it also stands in for what only Windows has: a program loaded with it takes itself to run there, netstat
// answers with setPorts' [port, pid] rows, and a path the lookup prints (winPath, winNode) has a drive in front, which is
// taken off again where the bridge reads the file.
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const POSIX = path.sep === "/";
const DRIVE = "C:";
const winPath = (p) => (POSIX ? DRIVE + p : p);
const winNode = POSIX ? DRIVE + process.execPath + ".exe" : process.execPath;
let ports = () => [];
if (process.env.HQ_FAKE_LOOKUP) require("./as-windows.cjs");
if (POSIX) {
  // a relative path that path.resolve put behind a folder still holds the drive
  const own = (p) => (typeof p === "string" && p.includes(DRIVE + "/") ? p.slice(p.indexOf(DRIVE + "/") + DRIVE.length).replace(/\/node\.exe$/, "/node") : p);
  const { native } = fs.realpathSync, readFile = fs.readFileSync;
  fs.realpathSync.native = (p, ...rest) => native(own(p), ...rest);
  fs.readFileSync = (p, ...rest) => readFile(own(p), ...rest);
}

const real = cp.execFile;
let answer = process.env.HQ_FAKE_LOOKUP || null;
const lookups = []; // each lookup's script
cp.execFile = function (file, args, opts, cb) {
  const name = typeof file === "string" ? path.win32.basename(file).toLowerCase() : "";
  if (POSIX && name === "netstat.exe") {
    const rows = ports().map(([port, pid]) => `  TCP    127.0.0.1:${port}    0.0.0.0:0    LISTENING    ${pid}`);
    setImmediate(() => cb(null, rows.join("\r\n"), ""));
    return { kill() {} };
  }
  if (name !== "powershell.exe") return real.apply(this, arguments);
  const script = args[args.length - 1];
  lookups.push(script);
  Promise.resolve(typeof answer === "function" ? answer(script) : answer).then((out) => setImmediate(() => (out === null ? cb(new Error("lookup failed"), "", "") : cb(null, out + "\r\n", ""))));
  return { kill() {} };
};
module.exports = { setLookup: (a) => (answer = a), setPorts: (f) => (ports = f), winPath, winNode, lookups };
