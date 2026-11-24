// HQ's side of the decisions folder: the open requests, the sweep, the answer and its log line, the presence file.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createDecisions, requestOf } = require("../lib/decisions");
const { hashOf, canon } = require("../bridge/hq-bridge");

const NOW = Date.parse("2025-01-18T12:00:00.000Z");
const S = "5e550000-0000-4000-8000-000000000001";
const id = (n) => String(n).padStart(32, "0");
// A request as the bridge writes it, its hash sealed over the call it carries; an `extra` with its own hash keeps that
// one
const seal = (r) => ("hash" in r ? r : { ...r, hash: hashOf(r) });
const reqOf = (n, extra = {}) => seal({ v: 1, id: id(n), pid: 4242, askedAt: NOW - 1000 * n, event: "PermissionRequest", sessionId: S, transcriptPath: "t", agentId: null, agentType: null, toolName: "Bash", toolInput: { command: "npm test", description: "Run the tests" }, trimmed: false, toolUseId: null, cwd: null, ...extra });
// A notice as the bridge writes one when HQ held a prompt until the cap passed: marked, with when it moved to VS Code
const NT = (n, extra = {}) => reqOf(n, { notice: true, movedAt: NOW - 500 * n, ...extra });
// Every folder world() makes, removed once this file's tests end, and nothing else.
const roots = [];
test.after(async () => {
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
// `read` stands in for the file read (undefined: the real one)
function world(alive = () => true, read) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-dec-"));
  roots.push(stateDir);
  const d = createDecisions({ stateDir, alive, read });
  d.ensure();
  const put = (name, body, ageMs = 0) => {
    const fp = path.join(d.dir, name);
    fs.writeFileSync(fp, typeof body === "string" ? body : JSON.stringify(body));
    const t = new Date(NOW - ageMs);
    fs.utimesSync(fp, t, t);
    return fp;
  };
  return { stateDir, d, put, files: () => fs.readdirSync(d.dir).sort() };
}

test("scan lists the open requests oldest first and skips answered ones, removing nothing", () => {
  const w = world();
  w.put(id(1) + ".json", reqOf(1));
  w.put(id(3) + ".json", reqOf(3));
  w.put(id(2) + ".json", reqOf(2));
  w.put(id(2) + ".answer.json", { id: id(2), choice: "allow" });
  assert.deepEqual(w.d.scan(NOW).map((r) => r.id), [id(3), id(1)]);
  assert.deepEqual(w.files(), [id(1) + ".json", id(2) + ".answer.json", id(2) + ".json", id(3) + ".json"]);
});

test("a request whose bridge is gone or that is over 15 minutes old goes with its answer; other files go after a minute", () => {
  const w = world((pid) => pid !== 999);
  w.put(id(1) + ".json", reqOf(1, { pid: 999 }));
  w.put(id(1) + ".answer.json", { id: id(1) });
  w.put(id(2) + ".json", reqOf(2, { askedAt: NOW - 15 * 60e3 - 1 }));
  w.put(id(3) + ".json", "{not json", 61e3);
  w.put(id(4) + ".json", "{not json", 30e3); // young: a write in progress keeps its place
  w.put(id(5) + ".answer.json", { id: id(5) }, 61e3); // an answer with no request
  w.put(id(6) + ".json.tmp", "x", 61e3);
  w.put("notes.txt", "x", 61e3);
  w.put(id(7) + ".json", reqOf(7, { v: 2 }), 61e3);
  w.put(id(8) + ".json", reqOf(8));
  w.put(id(9) + ".json", { ...reqOf(9), id: id(10) }, 61e3); // names another id
  assert.deepEqual(w.d.scan(NOW).map((r) => r.id), [id(8)]);
  assert.deepEqual(w.files(), [id(4) + ".json", id(8) + ".json"]);
});

test("an answer is written once, with one log line that never holds the command", () => {
  const w = world();
  w.put(id(1) + ".json", reqOf(1));
  const item = { sessionId: S, sessionName: "ada", toolName: "Bash", hash: reqOf(1).hash };
  assert.equal(w.d.answer(id(1), item, "allow", NOW), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.d.dir, id(1) + ".answer.json"), "utf8")), { id: id(1), sessionId: S, toolName: "Bash", choice: "allow", hash: reqOf(1).hash, at: NOW });
  const log = fs.readFileSync(path.join(w.stateDir, "answers.log.jsonl"), "utf8");
  assert.deepEqual(log.trim().split("\n").map((l) => JSON.parse(l)), [{ at: "2025-01-18T12:00:00.000Z", id: id(1), session: "ada", tool: "Bash", choice: "allow" }]);
  assert.ok(!log.includes("npm test"));
  assert.equal(w.d.answer(id(1), item, "deny", NOW), false, "a second answer is refused");
  assert.equal(w.d.answer(id(2), item, "allow", NOW), false, "no such request");
  assert.equal(fs.readFileSync(path.join(w.stateDir, "answers.log.jsonl"), "utf8"), log, "still one line");
  assert.deepEqual(w.d.scan(NOW), [], "an answered request is no longer open");
});

test("Ask for changes: the note goes in the answer file, and the log line gets only its length", () => {
  const w = world();
  w.put(id(1) + ".json", reqOf(1));
  const item = { sessionId: S, sessionName: "ada", toolName: "Bash", hash: reqOf(1).hash };
  const note = "use the staging folder, canary-note-7";
  assert.equal(w.d.answer(id(1), item, "revise", NOW, note), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.d.dir, id(1) + ".answer.json"), "utf8")), { id: id(1), sessionId: S, toolName: "Bash", choice: "revise", hash: reqOf(1).hash, note, at: NOW });
  const log = fs.readFileSync(path.join(w.stateDir, "answers.log.jsonl"), "utf8");
  assert.deepEqual(JSON.parse(log), { at: "2025-01-18T12:00:00.000Z", id: id(1), session: "ada", tool: "Bash", choice: "revise", noteLength: 37 });
  assert.ok(!log.includes("canary-note-7"), "the log never holds the note");
});

test("an answer HQ gave through a window or a read-back says so in its log line, with the window's id, and still has no source", () => {
  const w = world();
  for (const n of [1, 2, 3]) w.put(id(n) + ".json", reqOf(n));
  const item = (n) => ({ sessionId: S, sessionName: "ada", toolName: "Bash", hash: reqOf(n).hash });
  assert.equal(w.d.answer(id(1), item(1), "allow", NOW, undefined, undefined, "window", "0123456789abcdef"), true);
  assert.equal(w.d.answer(id(2), item(2), "allow", NOW, undefined, undefined, "readback"), true);
  assert.equal(w.d.answer(id(3), item(3), "allow", NOW), true);
  const lines = fs.readFileSync(path.join(w.stateDir, "answers.log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const base = { at: "2025-01-18T12:00:00.000Z", session: "ada", tool: "Bash", choice: "allow" };
  assert.deepEqual(lines, [{ ...base, id: id(1), via: "window", window: "0123456789abcdef" }, { ...base, id: id(2), via: "readback" }, { ...base, id: id(3) }]);
  assert.ok(lines.every((l) => !("source" in l)), "HQ's own lines: the server counts them as clicked, never as the bridge's");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.d.dir, id(1) + ".answer.json"), "utf8")), { id: id(1), sessionId: S, toolName: "Bash", choice: "allow", hash: reqOf(1).hash, at: NOW }, "the answer file is the same");
});

test("presence is written whole: focused or not, the page open or closed, and its time", () => {
  const w = world();
  const fp = path.join(w.stateDir, ".hq-presence.json");
  w.d.presence(true, true, NOW);
  assert.deepEqual(JSON.parse(fs.readFileSync(fp, "utf8")), { focused: true, open: true, at: NOW });
  w.d.presence(false, true, NOW + 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(fp, "utf8")), { focused: false, open: true, at: NOW + 1 });
  w.d.presence(false, false, NOW + 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(fp, "utf8")), { focused: false, open: false, at: NOW + 2 });
  assert.ok(!fs.existsSync(fp + ".tmp"));
});

test("requestOf accepts the bridge's two shapes only, every field checked and the hash sealed over the call", () => {
  const ok = reqOf(1);
  assert.ok(requestOf(id(1), JSON.stringify(ok)));
  assert.ok(requestOf(id(1), JSON.stringify(reqOf(1, { agentId: "a0123456789abcdef", agentType: "docs-checker", cwd: "C:/work" }))));
  assert.ok(requestOf(id(1), JSON.stringify(reqOf(1, { agentId: "a0123456789abcdef", agentType: "x".repeat(64) }))), "an agent type of 64 characters");
  const Q = { questions: [{ question: "Which?", header: "H", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] };
  const q = reqOf(1, { event: "PreToolUse", toolName: "AskUserQuestion", toolInput: Q, toolUseId: "t" });
  assert.ok(requestOf(id(1), JSON.stringify(q)));
  // each bad case is resealed, so only the bad field itself can refuse it
  const bad = [
    { ...ok, v: 2 }, { ...ok, id: id(2) }, { ...ok, pid: "1" }, { ...ok, pid: 0 }, { ...ok, askedAt: "now" }, { ...ok, sessionId: "../x" },
    { ...ok, transcriptPath: 5 }, { ...ok, agentId: "../x" }, { ...ok, agentId: "a0123456789abcdef", agentType: 7 }, { ...ok, agentId: "a0123456789abcdef", agentType: "x".repeat(65) },
    { ...ok, agentType: "docs-checker" }, // the bridge writes an agent type only with an agent id
    { ...ok, toolName: "" }, { ...ok, toolName: "x".repeat(129) }, { ...ok, toolInput: "npm test" }, { ...ok, toolInput: [] },
    { ...ok, trimmed: "no" }, { ...ok, toolUseId: 5 }, { ...ok, cwd: 5 }, { ...ok, event: "PostToolUse" },
    { ...ok, event: "PreToolUse", toolName: "Bash" },
    { ...q, toolUseId: null },
    { ...ok, event: "PreToolUse", toolName: "AskUserQuestion", toolInput: { questions: [] } },
    { ...ok, event: "PreToolUse", toolName: "AskUserQuestion", toolInput: { questions: [{ question: "Q", options: [{ label: "A" }] }] } },
  ].map((b) => ({ ...b, hash: hashOf(b) }));
  for (const b of bad) assert.equal(requestOf(id(1), JSON.stringify(b)), null, JSON.stringify(b).slice(0, 90));
  // an askedAt that is not a finite number (JSON reads 1e400 as Infinity)
  assert.equal(requestOf(id(1), JSON.stringify(ok).replace(/"askedAt":\d+/, '"askedAt":1e400')), null, "an infinite askedAt");
  // the hash: missing, another one, or the call rewritten under the old one
  for (const [what, b] of [
    ["no hash", { ...ok, hash: undefined }], ["another hash", { ...ok, hash: "0".repeat(64) }], ["a hash in capitals", { ...ok, hash: ok.hash.toUpperCase() }],
    ["the command rewritten", { ...ok, toolInput: { command: "rm -rf /", description: "Run the tests" } }], ["the cut flipped", { ...ok, trimmed: true }], ["the tool renamed", { ...ok, toolName: "PowerShell" }],
    ["only the folder rewritten", { ...ok, cwd: "C:/Users/me" }], ["only the agent rewritten", { ...ok, agentId: "a0123456789abcdef" }],
  ]) assert.equal(requestOf(id(1), JSON.stringify(b)), null, what);
  assert.equal(requestOf(id(1), "{not json"), null);
});

// The read, the cap, answer's own checks and order, and the bridge's own question rules.
const ITEM = { sessionId: S, sessionName: "ada", toolName: "Bash", hash: reqOf(1).hash };
// A question request as the bridge writes it, its one question changed by `q` and sealed over the input as the file
// holds it (a key set to undefined is left out, as in JSON)
const ask = (q = {}) => reqOf(1, { event: "PreToolUse", toolName: "AskUserQuestion", toolUseId: "t", toolInput: JSON.parse(JSON.stringify({ questions: [{ question: "Which?", header: "H", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false, ...q }] })) });
const accepted = (r) => requestOf(id(1), JSON.stringify(r)) !== null;

test("a read that fails never removes a request: it is not shown that scan, and the next scan lists it", () => {
  let fails = 1, reads = 0;
  const w = world(() => true, (fp) => {
    reads++;
    if (fails-- > 0) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); // a scanner holding the file
    return fs.readFileSync(fp, "utf8");
  });
  const fp = w.put(id(1) + ".json", reqOf(1, { askedAt: NOW - 120e3 }), 120e3); // two minutes old: past the leftover minute
  assert.deepEqual(w.d.scan(NOW), [], "not shown while it cannot be read");
  assert.ok(fs.existsSync(fp), "and never removed for it");
  assert.deepEqual(w.d.scan(NOW).map((r) => r.id), [id(1)], "the next scan reads it again");
  assert.equal(reads, 2);
});

test("a request that grew past 64 KB after its stat is not listed; one of exactly 64 KB is", () => {
  const w = world();
  // a valid request of exactly `bytes` bytes: the description pads it
  const sized = (n, bytes) => {
    const pad = (k) => reqOf(n, { toolInput: { command: "npm test", description: "x".repeat(k) } });
    const r = pad(bytes - JSON.stringify(pad(0)).length);
    assert.equal(Buffer.byteLength(JSON.stringify(r)), bytes);
    return r;
  };
  const fp = w.put(id(1) + ".json", reqOf(1));
  const small = fs.statSync(fp);
  w.put(id(1) + ".json", sized(1, 64 * 1024 + 1)); // 64 KB and one byte now; the stat still says small
  w.put(id(2) + ".json", sized(2, 64 * 1024));
  const orig = fs.statSync;
  fs.statSync = function (p, ...a) {
    return String(p) === fp ? small : orig.call(this, p, ...a);
  };
  try {
    assert.deepEqual(w.d.scan(NOW).map((r) => r.id), [id(2)]);
  } finally {
    fs.statSync = orig;
  }
});

test("answer refuses an id that is not 32 hex characters and a choice that is not text, writing nothing", () => {
  const w = world();
  fs.writeFileSync(path.join(w.stateDir, "victim.json"), "{}"); // one level above the decisions folder
  w.put(id(1) + ".json", reqOf(1));
  assert.equal(w.d.answer("../victim", ITEM, "allow", NOW), false);
  assert.deepEqual(fs.readdirSync(w.stateDir).sort(), ["decisions", "victim.json"], "nothing written outside the folder, and no log line");
  assert.equal(fs.readFileSync(path.join(w.stateDir, "victim.json"), "utf8"), "{}");
  assert.equal(w.d.answer(id(1), ITEM, 7, NOW), false, "a choice that is not text");
  assert.deepEqual(w.files(), [id(1) + ".json"]);
});

test("the audit line is written before the answer: a log that cannot be written leaves no answer", () => {
  const w = world();
  w.put(id(1) + ".json", reqOf(1));
  const log = path.join(w.stateDir, "answers.log.jsonl");
  fs.mkdirSync(log); // a log path that cannot be appended to
  assert.throws(() => w.d.answer(id(1), ITEM, "allow", NOW));
  assert.deepEqual(w.files(), [id(1) + ".json"], "no answer without its log line");
  assert.deepEqual(w.d.scan(NOW).map((r) => r.id), [id(1)], "the request stays open");
  fs.rmdirSync(log);
  assert.equal(w.d.answer(id(1), ITEM, "allow", NOW), true);
  assert.ok(fs.existsSync(path.join(w.d.dir, id(1) + ".answer.json")));
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1, "the answer has its one log line");
});

test("a question through PermissionRequest is not a request (its PreToolUse is the one HQ answers); a plan approval (ExitPlanMode) is", () => {
  assert.ok(accepted(reqOf(1, { toolName: "Write", toolInput: { file_path: "a.md", content: "x" } })), "any other tool is");
  assert.ok(accepted(reqOf(1, { toolName: "ExitPlanMode", toolInput: { plan: "Ship it" } })), "a plan approval");
  assert.equal(accepted(reqOf(1, { toolName: "AskUserQuestion" })), false);
});

test("every question shape Claude Code asks is a request: one pick or several, 1 to 4 questions, 2 or more options; five questions, a pick flag that is not true or false, or a question that is not an object is not", () => {
  assert.ok(accepted(ask()) && accepted(ask({ multiSelect: undefined })) && accepted(ask({ multiSelect: true })), "one pick, said or left out, or several");
  const Q = (k) => ({ question: "Q" + k, header: "H", options: Array.from({ length: 9 }, (_, i) => ({ label: "L" + i })), multiSelect: k % 2 === 1 });
  const many = (n) => reqOf(1, { event: "PreToolUse", toolName: "AskUserQuestion", toolUseId: "t", toolInput: { questions: Array.from({ length: n }, (_, k) => Q(k)) } });
  assert.ok(accepted(many(2)) && accepted(many(4)), "two and four questions of nine options");
  assert.equal(accepted(many(5)), false, "five questions");
  assert.equal(accepted(ask({ multiSelect: "yes" })), false, "a pick flag that is not true or false");
  const notObject = reqOf(1, { event: "PreToolUse", toolName: "AskUserQuestion", toolUseId: "t", toolInput: { questions: [ask().toolInput.questions[0], "Q"] } });
  assert.equal(accepted(notObject), false, "a question that is not an object");
});

test("a risky mark (the bridge rated the full call Risky) is true on a permission only, and sealed in the hash", () => {
  const r = reqOf(1, { risky: true });
  assert.ok(accepted(r), "a marked permission");
  for (const [what, b] of [["yes", { ...r, risky: "yes" }], ["false", { ...r, risky: false }], ["on a question", { ...ask(), risky: true }]])
    assert.equal(accepted({ ...b, hash: hashOf(b) }), false, what);
  const { risky, ...plain } = r;
  assert.equal(accepted(plain), false, "the mark stripped under the old hash");
});

test("a hook's ask (a safety hook asked for this call) is a hook of at most 64 and a reason of at most 300, on a permission only, and sealed in the hash", () => {
  const hookAsk = { hook: "guard-config.js", reason: "a quality-gate config" };
  const r = reqOf(1, { hookAsk });
  assert.deepEqual(requestOf(id(1), JSON.stringify(r)).hookAsk, hookAsk);
  assert.ok(accepted(reqOf(1, { hookAsk: { hook: "h".repeat(64), reason: "r".repeat(300) } })), "at the limits");
  for (const [what, b] of [
    ["a reason that is not text", { ...r, hookAsk: { hook: "guard-bash.js", reason: 7 } }],
    ["a hook that is not text", { ...r, hookAsk: { hook: null, reason: "r" } }],
    ["a hook over 64", { ...r, hookAsk: { hook: "h".repeat(65), reason: "r" } }],
    ["a reason over 300", { ...r, hookAsk: { hook: "guard-bash.js", reason: "r".repeat(301) } }],
    ["not an object", { ...r, hookAsk: "guard-bash.js" }],
    ["on a question", { ...ask(), hookAsk }],
  ])
    assert.equal(accepted({ ...b, hash: hashOf(b) }), false, what);
  const { hookAsk: _gone, ...plain } = r;
  assert.equal(accepted(plain), false, "the hook's ask stripped under the old hash");
  assert.equal(reqOf(1).hash, hashOf(plain), "a request with no hook's ask hashes as it always did");
});

test("a question that is blank after trim is not a request", () => {
  for (const question of ["", "   ", "\t\n"]) assert.equal(accepted(ask({ question })), false, JSON.stringify(question));
});

test("a label that is blank after trim is not a request; spaces around a label and two equal labels are", () => {
  for (const label of ["", "  "]) assert.equal(accepted(ask({ options: [{ label: "Red" }, { label }] })), false, JSON.stringify(label));
  assert.ok(accepted(ask({ options: [{ label: "Red" }, { label: " Blue " }] })), "spaces around a label");
  assert.ok(accepted(ask({ options: [{ label: "Red, then…" }, { label: "Red, then…" }] })), "the bridge's cut can make two real labels equal");
});

test("a request asked more than 5 s in the future is swept with its answer; one 2 s ahead stays open", () => {
  const w = world();
  w.put(id(1) + ".json", reqOf(1, { askedAt: NOW + 60e3 }));
  w.put(id(1) + ".answer.json", { id: id(1) });
  w.put(id(2) + ".json", reqOf(2, { askedAt: NOW + 2e3 }));
  assert.deepEqual(w.d.scan(NOW).map((r) => r.id), [id(2)]);
  assert.deepEqual(w.files(), [id(2) + ".json"]);
});

test("a notice is a request marked notice: true, sealed with its mark, with when it moved to VS Code; notice: \"yes\", false or null, no time it moved, or a time with no mark, is not a request", () => {
  const n = NT(1);
  assert.ok(accepted(n), "a notice");
  assert.ok(accepted({ ...ask(), notice: true, movedAt: NOW, hash: hashOf({ ...ask(), notice: true }) }), "a question's notice");
  assert.ok(accepted(NT(1, { toolName: "ExitPlanMode", toolInput: { plan: "Ship it" } })), "a plan approval's notice");
  for (const [what, b] of [["yes", { ...n, notice: "yes" }], ["false", { ...n, notice: false }], ["null", { ...n, notice: null }], ["no time it moved", { ...n, movedAt: undefined }], ["a time that is not a number", { ...n, movedAt: "now" }], ["a time with no mark", { ...reqOf(1), movedAt: NOW }]])
    assert.equal(accepted({ ...b, hash: hashOf(b) }), false, what);
  // a flipped mark breaks the hash: a notice rewritten as a request, or a request marked as a notice, under the old hash
  const { notice, ...plain } = n;
  assert.equal(accepted(plain), false, "a notice rewritten as a request");
  assert.equal(accepted({ ...reqOf(1), notice: true }), false, "a request marked as a notice");
  // a request with no mark hashes exactly as before: the call's six fields and nothing else
  const r = reqOf(1);
  const before = crypto.createHash("sha256").update(canon({ tool_name: r.toolName, tool_input: r.toolInput, trimmed: r.trimmed, cwd: r.cwd, agent_id: r.agentId, agent_type: r.agentType })).digest("hex");
  assert.equal(hashOf(r), before);
});

test("scan with a stale that says yes removes a notice with its answer file and leaves a normal request alone; a notice it says no to stays", () => {
  const w = world();
  w.put(id(1) + ".json", NT(1));
  w.put(id(1) + ".answer.json", { id: id(1) });
  w.put(id(2) + ".json", NT(2));
  w.put(id(3) + ".json", reqOf(3));
  const asked = [];
  const stale = (r) => (asked.push(r.id), r.id !== id(2)); // yes for the first notice and for the normal request
  assert.deepEqual(w.d.scan(NOW, { stale }).map((r) => r.id), [id(3), id(2)]);
  assert.deepEqual(w.files(), [id(2) + ".json", id(3) + ".json"]);
  assert.ok(asked.includes(id(1)) && asked.includes(id(2)), "asked about each notice");
  assert.deepEqual(w.d.scan(NOW).map((r) => r.id), [id(3), id(2)], "no stale given: notices stay");
});

test("a notice is aged from when it moved to VS Code: 15 minutes after that it goes, whenever it was asked", () => {
  const w = world();
  w.put(id(1) + ".json", NT(1, { askedAt: NOW - 20 * 60e3, movedAt: NOW - 10 * 60e3 }));
  w.put(id(2) + ".json", NT(2, { askedAt: NOW - 30 * 60e3, movedAt: NOW - 15 * 60e3 - 1 }));
  assert.deepEqual(w.d.scan(NOW).map((r) => r.id), [id(1)]);
  assert.deepEqual(w.files(), [id(1) + ".json"]);
});

test("an answer by picks carries its picks in the answer file; the log line gets the choice alone", () => {
  const w = world();
  w.put(id(1) + ".json", ask());
  const item = { sessionId: S, sessionName: "ada", toolName: "AskUserQuestion", hash: ask().hash };
  assert.equal(w.d.answer(id(1), item, "picks", NOW, undefined, [[1]]), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.d.dir, id(1) + ".answer.json"), "utf8")), { id: id(1), sessionId: S, toolName: "AskUserQuestion", choice: "picks", hash: ask().hash, picks: [[1]], at: NOW });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.stateDir, "answers.log.jsonl"), "utf8")), { at: "2025-01-18T12:00:00.000Z", id: id(1), session: "ada", tool: "AskUserQuestion", choice: "picks" });
});

test("nothing answers a notice: a notice with an answer file scans as open and the answer file is removed; a request with one is held back as before", () => {
  const w = world();
  w.put(id(1) + ".json", NT(1));
  w.put(id(1) + ".answer.json", { id: id(1), choice: "allow" });
  w.put(id(2) + ".json", reqOf(2));
  w.put(id(2) + ".answer.json", { id: id(2), choice: "allow" });
  assert.deepEqual(w.d.scan(NOW, { stale: () => false }).map((r) => r.id), [id(1)], "the notice is open; the answered request is not");
  assert.deepEqual(w.files(), [id(1) + ".json", id(2) + ".answer.json", id(2) + ".json"], "the notice's answer is gone; the request's stays");
});

test("a call nested too deep to hash gives null, never a throw", () => {
  const deep = '{"a":' + "[".repeat(20000) + "]".repeat(20000) + "}"; // about 39 KB, under the file cap
  const text = JSON.stringify(reqOf(1)).replace(/"toolInput":\{[^}]*\}/, '"toolInput":' + deep);
  assert.ok(text.includes("[[[") && text.length < 64 * 1024);
  let r;
  assert.doesNotThrow(() => (r = requestOf(id(1), text)));
  assert.equal(r, null);
});
