// The drafter (lib/drafter.js): one claude -p run per draft, driven here only through a fake spawn, never the real CLI.
// Covers the exact argv, a child env with no CLAUDE* or ANTHROPIC* variable, what goes on stdin, a recorded answer
// cleaned of its dash, the usage line, and each failure's short error with none of the child's output in it.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { Writable } = require("stream");
const { draftPrompt } = require("../lib/drafter");

// Built from char codes so no file ever holds the dash itself
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const AT = Date.UTC(2025, 0, 6, 12, 0, 0);
const RULES = path.join(__dirname, "..", "assistant", "draft.md");
// an answer as the CLI prints it
const ANSWER = JSON.stringify({ result: `Done ${EM} the list is sorted.`, total_cost_usd: 0.02 });
const ARGV = ["-p", "--safe-mode", "--tools", "", "--model", "opus", "--output-format", "json", "--no-session-persistence", "--append-system-prompt-file", RULES];

// A temp state folder for one test, removed when that test ends.
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-drafter-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

// A fake spawn. Its child answers once its stdin ends: `out` on stdout in two chunks cut inside a character (inside the
// first em dash when there is one, so a chunk-by-chunk decode would garble it), `err` on stderr, then close with `code`.
// `hang` never answers until killed; `fail` emits a spawn error instead.
function fakeSpawn({ out = "", err = "", code = 0, hang = false, fail = false } = {}) {
  const f = { calls: [] };
  f.spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    const written = [];
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        written.push(Buffer.from(chunk));
        cb();
      },
    });
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("close", null, "SIGTERM"));
      return true;
    };
    f.calls.push({ cmd, args, opts, child, stdin: () => Buffer.concat(written).toString("utf8") });
    if (fail) {
      setImmediate(() => child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })));
      return child;
    }
    child.stdin.on("finish", () =>
      setImmediate(() => {
        if (hang) return;
        const bytes = Buffer.from(out, "utf8");
        const dash = bytes.indexOf(Buffer.from(EM, "utf8"));
        const cut = dash >= 0 ? dash + 1 : bytes.length >> 1;
        child.stdout.emit("data", bytes.subarray(0, cut));
        child.stdout.emit("data", bytes.subarray(cut));
        if (err) child.stderr.emit("data", Buffer.from(err, "utf8"));
        child.emit("close", code, null);
      }));
    return child;
  };
  return f;
}

const optsFor = (t, f, more = {}) => ({ spawn: f.spawn, rulesFile: RULES, stateDir: tempDir(t), env: {}, now: () => AT, ...more });
const usageFile = (dir) => path.join(dir, "assistant", "usage.jsonl");

// Each hq_draft starts its own Opus process, and several at once can overload a computer
test("one draft at a time; a second while one runs is refused with no process, and one after it ends runs", async (t) => {
  const hang = fakeSpawn({ hang: true });
  const first = draftPrompt({ idea: "a", target: "new" }, optsFor(t, hang, { timeoutMs: 50 }));
  const ok = fakeSpawn({ out: ANSWER });
  assert.deepEqual(await draftPrompt({ idea: "b", target: "new" }, optsFor(t, ok)), { ok: false, error: "another prompt is being written; draft this one when it is done" });
  assert.equal(ok.calls.length, 0, "no second process");
  assert.deepEqual(await first, { ok: false, error: "the drafter took too long" });
  assert.equal((await draftPrompt({ idea: "c", target: "new" }, optsFor(t, ok))).ok, true);
});

test("runs claude with the exact flags, hidden, no shell, and an env with no CLAUDE or ANTHROPIC variable", async (t) => {
  const f = fakeSpawn({ out: ANSWER });
  const env = { PATH: "/usr/bin", KEEP_ME: "yes", ANTHROPIC_API_KEY: "test-key", CLAUDE_CODE_X: "1", anthropic_base_url: "x", ClaudeThing: "y" };
  const r = await draftPrompt({ idea: "fix the footer", target: "new", context: null }, optsFor(t, f, { env }));
  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 1);
  const { cmd, args, opts } = f.calls[0];
  assert.equal(cmd, "claude");
  assert.deepEqual(args, ARGV);
  assert.equal(opts.windowsHide, true);
  assert.ok(!opts.shell, "no shell");
  assert.deepEqual(opts.env, { PATH: "/usr/bin", KEEP_ME: "yes" });
  assert.equal(env.ANTHROPIC_API_KEY, "test-key", "the caller's env is left as it was");
});

test("a custom claude path is the command spawned", async (t) => {
  const f = fakeSpawn({ out: ANSWER });
  await draftPrompt({ idea: "x", target: "new", context: null }, optsFor(t, f, { claude: "claude.exe" }));
  assert.equal(f.calls[0].cmd, "claude.exe");
});

test("stdin carries the idea and a new session as the target, then ends", async (t) => {
  const f = fakeSpawn({ out: ANSWER });
  await draftPrompt({ idea: "add a dark mode switch", target: "new", context: null }, optsFor(t, f));
  const { stdin, child } = f.calls[0];
  assert.match(stdin(), /add a dark mode switch/);
  assert.match(stdin(), /new session/);
  assert.equal(child.stdin.writableFinished, true);
});

test("stdin carries the chat's name, its task and its last reply, the idea and the reply capped", async (t) => {
  const f = fakeSpawn({ out: ANSWER });
  const idea = "i".repeat(2500);
  const lastReply = "r".repeat(1600);
  await draftPrompt({ idea, target: "cart-fix", context: { task: "fix the cart total", lastReply } }, optsFor(t, f));
  const s = f.calls[0].stdin();
  assert.match(s, /cart-fix/);
  assert.doesNotMatch(s, /new session/);
  assert.match(s, /fix the cart total/);
  assert.ok(s.includes("i".repeat(2000)) && !s.includes("i".repeat(2001)), "idea capped at 2000");
  assert.ok(s.includes("r".repeat(1500)) && !s.includes("r".repeat(1501)), "last reply capped at 1500");
});

test("a recorded answer gives clean text and its cost, and one usage line is written", async (t) => {
  const f = fakeSpawn({ out: ANSWER });
  const o = optsFor(t, f);
  const r = await draftPrompt({ idea: "x", target: "new", context: null }, o);
  assert.deepEqual(r, { ok: true, text: "Done, the list is sorted.", costUsd: 0.02 });
  assert.equal(fs.readFileSync(usageFile(o.stateDir), "utf8"), '{"at":"2025-01-06T12:00:00.000Z","costUsd":0.02,"model":"opus"}\n');
});

test("each draft appends its own usage line", async (t) => {
  const o = optsFor(t, fakeSpawn({ out: ANSWER }));
  await draftPrompt({ idea: "x", target: "new", context: null }, o);
  await draftPrompt({ idea: "y", target: "new", context: null }, { ...o, spawn: fakeSpawn({ out: ANSWER }).spawn });
  assert.equal(fs.readFileSync(usageFile(o.stateDir), "utf8").split("\n").filter(Boolean).length, 2);
});

test("every em and en dash is replaced, the text trimmed and capped at 1800 characters", async (t) => {
  const result = `  Years 2010${EN}2020, a ${EM} b${EM}c and d ${EN} e  `;
  const r = await draftPrompt({ idea: "x", target: "new", context: null }, optsFor(t, fakeSpawn({ out: JSON.stringify({ result, total_cost_usd: 0.01 }) })));
  assert.equal(r.text, "Years 2010-2020, a, b-c and d, e");
  const long = await draftPrompt({ idea: "x", target: "new", context: null }, optsFor(t, fakeSpawn({ out: JSON.stringify({ result: "y".repeat(2000), total_cost_usd: 0.01 }) })));
  assert.equal(long.text, "y".repeat(1800));
});

test("a usage line that cannot be written never fails the draft", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "not-a-folder");
  fs.writeFileSync(file, "a file where the state folder should be\n");
  const r = await draftPrompt({ idea: "x", target: "new", context: null }, optsFor(t, fakeSpawn({ out: ANSWER }), { stateDir: file }));
  assert.equal(r.ok, true);
  assert.equal(r.text, "Done, the list is sorted.");
});

test("a non-zero exit fails with a plain error and none of the child's output", async (t) => {
  const f = fakeSpawn({ out: '{"result":"SECRET-STDOUT","total_cost_usd":0.01}', err: "SECRET-STDERR", code: 1 });
  const o = optsFor(t, f);
  const r = await draftPrompt({ idea: "x", target: "new", context: null }, o);
  assert.deepEqual(r, { ok: false, error: "the drafter failed" });
  assert.equal(fs.existsSync(usageFile(o.stateDir)), false, "no usage line for a failed run");
});

test("bad JSON, no string result, an error result or an empty one each fail plainly", async (t) => {
  const outs = ["SECRET not json {", '{"total_cost_usd":0.01}', '{"result":42}', '{"result":"SECRET","is_error":true,"total_cost_usd":0}', '{"result":"   "}'];
  for (const out of outs) {
    const r = await draftPrompt({ idea: "x", target: "new", context: null }, optsFor(t, fakeSpawn({ out })));
    assert.deepEqual(r, { ok: false, error: "the drafter failed" }, out);
  }
});

test("past timeoutMs the child is killed and the draft fails", async (t) => {
  const f = fakeSpawn({ hang: true });
  const r = await draftPrompt({ idea: "x", target: "new", context: null }, optsFor(t, f, { timeoutMs: 30 }));
  assert.deepEqual(r, { ok: false, error: "the drafter took too long" });
  assert.equal(f.calls[0].child.killed, true);
});

test("a drafter that cannot start fails plainly, whether spawn throws or the child emits an error", async (t) => {
  const emits = await draftPrompt({ idea: "x", target: "new", context: null }, optsFor(t, fakeSpawn({ fail: true })));
  assert.deepEqual(emits, { ok: false, error: "could not start the drafter" });
  const throws = await draftPrompt({ idea: "x", target: "new", context: null }, optsFor(t, { spawn: () => { throw new Error("spawn EINVAL"); } }));
  assert.deepEqual(throws, { ok: false, error: "could not start the drafter" });
});
