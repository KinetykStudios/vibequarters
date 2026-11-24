// The window's judge (lib/judge.js): one claude -p Sonnet run with no tools decides, for a batch of permissions inside an
// approve window, which look fine to approve. Driven only through a fake spawn here. Every failure leaves the items for
// the owner, and a verdict counts only for an id and hash it was given.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { Writable } = require("stream");
const { judgeItems, itemOf } = require("../lib/judge");

const RULES = path.join(__dirname, "..", "assistant", "judge.md");
const ARGV = ["-p", "--safe-mode", "--tools", "", "--model", "sonnet", "--output-format", "json", "--no-session-persistence", "--append-system-prompt-file", RULES];
const A = { id: "a".repeat(32), hash: "h1", session: "ada", task: "ship the levels", folder: "hq", tool: "Bash", call: "rm -rf C:/tmp/scratch", hookReason: "", hqRisk: "Risky: deletes files" };
const B = { ...A, id: "b".repeat(32), hash: "h2", call: "mcp send" };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-judge-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}
function fakeSpawn({ out = "", code = 0, hang = false, fail = false } = {}) {
  const f = { calls: [] };
  f.spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    const written = [];
    child.stdin = new Writable({ write(chunk, _e, cb) { written.push(Buffer.from(chunk)); cb(); } });
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { setImmediate(() => child.emit("close", null, "SIGTERM")); return true; };
    f.calls.push({ cmd, args, opts, stdin: () => Buffer.concat(written).toString("utf8") });
    if (fail) { setImmediate(() => child.emit("error", new Error("ENOENT"))); return child; }
    child.stdin.on("finish", () => setImmediate(() => {
      if (hang) return;
      child.stdout.emit("data", Buffer.from(out, "utf8"));
      child.emit("close", code, null);
    }));
    return child;
  };
  return f;
}
const reply = (result, extra = {}) => JSON.stringify({ result: typeof result === "string" ? result : JSON.stringify(result), total_cost_usd: 0.004, ...extra });
const opts = (t, f, more = {}) => ({ spawn: f.spawn, claude: "claude", rulesFile: RULES, stateDir: tempDir(t), env: { PATH: "x", CLAUDECODE: "1", ANTHROPIC_API_KEY: "k", anthropic_api_key: "k" }, now: () => 0, ...more });

test("the argv, an env with no CLAUDE or ANTHROPIC name, and the items on stdin", async (t) => {
  const f = fakeSpawn({ out: reply([]) });
  await judgeItems([A], opts(t, f));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, ARGV);
  assert.deepEqual(Object.keys(f.calls[0].opts.env), ["PATH"]);
  const sent = JSON.parse(f.calls[0].stdin());
  assert.deepEqual(sent.items.map((x) => x.id), [A.id]);
  assert.equal(sent.items[0].hash, undefined, "the hash stays in HQ");
});

test("verdicts: only given ids, approve must be exactly true, why cut and cleaned", async (t) => {
  const EM = String.fromCharCode(0x2014);
  const out = reply("Here you go:\n" + JSON.stringify([
    { id: A.id, approve: true, why: `a scratch folder ${EM} fine` },
    { id: B.id, approve: "true", why: "string true is not true" },
    { id: "c".repeat(32), approve: true, why: "an id it was not given" },
  ]));
  const r = await judgeItems([A, B], opts(t, fakeSpawn({ out })));
  assert.equal(r.ok, true);
  assert.deepEqual(r.verdicts, [
    { id: A.id, hash: "h1", approve: true, why: "a scratch folder, fine" },
    { id: B.id, hash: "h2", approve: false, why: "string true is not true" },
  ]);
});

test("an item with no verdict is left for the owner", async (t) => {
  const r = await judgeItems([A, B], opts(t, fakeSpawn({ out: reply([{ id: A.id, approve: true, why: "ok" }]) })));
  assert.deepEqual(r.verdicts.map((v) => [v.id, v.approve]), [[A.id, true], [B.id, false]]);
  assert.match(r.verdicts[1].why, /no answer/);
});

test("every failure fails closed with a short error and no verdicts", async (t) => {
  const cases = [
    [fakeSpawn({ out: "not json" }), "the check failed"],
    [fakeSpawn({ out: reply("no list here") }), "the check failed"],
    [fakeSpawn({ out: reply([], { is_error: true }) }), "the check failed"],
    [fakeSpawn({ out: reply([]), code: 1 }), "the check failed"],
    [fakeSpawn({ fail: true }), "the check could not start"],
  ];
  for (const [f, error] of cases) assert.deepEqual(await judgeItems([A], opts(t, f)), { ok: false, error });
  assert.deepEqual(await judgeItems([A], opts(t, fakeSpawn({ hang: true }), { timeoutMs: 30 })), { ok: false, error: "the check took too long" });
  assert.deepEqual(await judgeItems([], opts(t, fakeSpawn({ out: reply([]) }))), { ok: true, verdicts: [] }, "nothing to judge runs nothing");
});

test("one judge at a time", async (t) => {
  const hang = fakeSpawn({ hang: true });
  const first = judgeItems([A], opts(t, hang, { timeoutMs: 50 }));
  const second = fakeSpawn({ out: reply([]) });
  assert.deepEqual(await judgeItems([A], opts(t, second)), { ok: false, error: "busy" });
  assert.equal(second.calls.length, 0);
  await first;
  assert.equal((await judgeItems([A], opts(t, second))).ok, true, "free again after the first ends");
});

test("a usage line per run", async (t) => {
  const o = opts(t, fakeSpawn({ out: reply([]) }));
  await judgeItems([A], o);
  const line = JSON.parse(fs.readFileSync(path.join(o.stateDir, "assistant", "usage.jsonl"), "utf8").trim());
  assert.deepEqual([line.kind, line.model, line.costUsd, line.items], ["judge", "sonnet", 0.004, 1]);
});

test("itemOf: what the judge reads of one request and its card, the call cut to 1500 characters", () => {
  const req = { id: A.id, hash: "h9", toolName: "Bash", toolInput: { command: "x".repeat(3000), description: "d" }, hookAsk: { hook: "guard-bash.js", reason: "a git discard" } };
  const card = { sessionName: "ada", folder: "quarry", risk: { label: "Risky", reason: "deletes files" } };
  const it = itemOf(req, card, "fix the tests");
  assert.deepEqual(Object.keys(it).sort(), ["call", "folder", "hash", "hookReason", "hqRisk", "id", "session", "task", "tool"]);
  assert.equal(it.call.length, 1500);
  assert.deepEqual([it.session, it.task, it.folder, it.tool, it.hookReason, it.hqRisk], ["ada", "fix the tests", "quarry", "Bash", "a git discard", "Risky: deletes files"]);
});
