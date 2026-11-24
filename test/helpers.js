// Builders for transcript rows, shaped like Claude Code's JSONL.
let n = 0;
const T0 = Date.parse("2025-01-15T12:00:00.000Z");
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
function asst({ sec = 0, id = "msg_" + ++n, model = "claude-opus-5-5", usage = {}, content = [], stop = "tool_use", sidechain = false } = {}) {
  return { type: "assistant", timestamp: at(sec), isSidechain: sidechain, message: { id, model, role: "assistant", stop_reason: stop, usage: { input_tokens: 0, output_tokens: 0, ...usage }, content } };
}
function user({ sec = 0, text = "ok", sidechain = false } = {}) {
  return { type: "user", timestamp: at(sec), isSidechain: sidechain, message: { role: "user", content: text } };
}
const tool = (name, input = {}) => ({ type: "tool_use", id: "tu_" + ++n, name, input });
const text = (t) => ({ type: "text", text: t });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

// A preload for the server (node --require) that copies the hex of each 32-byte crypto.randomBytes it makes into the file
// HQ_STUB_TAP names, one a line: so a test learns the assistant token, which no route ever serves.
function tap() {
  const crypto = require("crypto");
  const fs = require("fs");
  const { randomBytes } = crypto;
  crypto.randomBytes = function (size, ...rest) {
    const b = randomBytes.call(this, size, ...rest);
    if (size === 32 && !rest.length) fs.appendFileSync(process.env.HQ_STUB_TAP, b.toString("hex") + "\n");
    return b;
  };
}
// The tap in `dir`, for start(w, { stub }); tokens() is every 32-byte value the server made so far, oldest first.
function tapStub(dir) {
  const fs = require("fs");
  const path = require("path");
  const file = path.join(dir, "tap-stub.js"), out = path.join(dir, "tap.txt");
  fs.writeFileSync(file, "(" + tap.toString() + ")();\n");
  fs.rmSync(out, { force: true }); // a server started again in the same folder taps afresh
  const tokens = () => { try { return fs.readFileSync(out, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  return { file, env: { HQ_STUB_TAP: out }, tokens };
}
// A timing test's figure: the fastest of 3 runs of f, in ms. At or over the limit, f alone is run up to 10 more times and
// the first run under it counts, by the clock or by the processor time the run used (plus TICK, its coarsest step, so it
// never reads low), so a busy machine does not fail the test: a slow pattern uses the processor in every run. Once a run
// has taken 10 times the limit and the re-runs have used 20 times it, no more are tried.
const TICK = 16;
function bestMs(f, limit) {
  let m = Infinity;
  const once = (cpu) => {
    const c = process.cpuUsage(), t = performance.now();
    f();
    const wall = performance.now() - t, u = process.cpuUsage(c), used = (u.user + u.system) / 1e3;
    m = Math.min(m, wall, cpu ? used + TICK : Infinity);
    return cpu ? used + TICK : wall;
  };
  for (let i = 0; i < 3 && once(false) < 10 * limit; i++);
  for (let i = 0, spent = 0; i < 10 && m >= limit && spent < 20 * limit; i++) spent += once(true);
  return m;
}
// The node flags for a server that must take itself to run on Windows, where alone messages and answers work; none there
const asWindows = process.platform === "win32" ? [] : ["--require", require("path").join(__dirname, "as-windows.cjs")];
module.exports = { asWindows, T0, at, asst, user, tool, text, jsonl, tapStub, bestMs };
