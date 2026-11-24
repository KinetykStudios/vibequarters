// lib/readback.js: nothing the assistant asks HQ to answer is written until HQ shows and speaks a fixed read-back of the
// exact item and the exact answer, worded here, never by the model, and the owner confirms it.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createReadbacks, readbackText, refusal, confirmFailLine } = require("../lib/readback");

const T0 = Date.parse("2025-02-07T12:00:00.000Z");
const MIN = 60e3;
const PERM = (level, extra = {}) => ({
  id: "a".repeat(32), kind: "permission", sessionId: "s1", sessionName: "ada", who: "Ada", what: "wants to run npm test", toolName: "Bash", hash: "h".repeat(64),
  risk: { level, label: { low: "Safe", medium: "Check first", high: "Risky" }[level] },
  choices: [{ key: "allow", label: "Approve" }, { key: "deny", label: "Deny" }, { key: "revise", label: "Ask for changes" }], ...extra,
});
const QUESTION = { id: "b".repeat(32), kind: "question", sessionId: "s1", sessionName: "ada", who: "Ada", what: "asks: Which color?", toolName: "AskUserQuestion", hash: "q".repeat(64), risk: null, choices: [{ key: "opt:0", label: "Red" }, { key: "opt:1", label: "Blue" }] };
const PLAN = { id: "c".repeat(32), kind: "permission", sessionId: "s1", sessionName: "ada", who: "Ada", what: "wants to start on its plan", toolName: "ExitPlanMode", hash: "p".repeat(64), risk: null, choices: [{ key: "allow", label: "Approve" }, { key: "revise", label: "Keep planning" }] };
const answer = (item, choice, extra = {}) => ({ kind: "answer", decisionId: item.id, choice, item, ...extra });

test("each read-back is a fixed line built from the item and the answer", () => {
  assert.equal(readbackText(answer(PERM("medium"), "allow")), "Approve for ada: wants to run npm test (Check first).");
  assert.equal(readbackText(answer(PERM("low"), "allow")), "Approve for ada: wants to run npm test (Safe).");
  assert.equal(readbackText(answer(PERM("high"), "deny")), "Deny for ada: wants to run npm test.");
  assert.equal(readbackText(answer(PERM("medium"), "revise", { note: "use the staging folder" })), 'Ask ada for changes to: wants to run npm test. Note: "use the staging folder".');
  assert.equal(readbackText(answer(QUESTION, "opt:1")), 'Answer ada\'s question "Which color?" with "Blue".');
  assert.equal(readbackText(answer(PLAN, "allow")), "Approve ada's plan.");
  assert.equal(readbackText(answer(PLAN, "revise", { note: "split it in two" })), 'Keep planning for ada: "split it in two".');
  assert.equal(readbackText({ kind: "window", minutes: 10, sessions: null, names: null }), "Approve what looks safe for 10 minutes in every chat.");
  assert.equal(readbackText({ kind: "window", minutes: 1, sessions: ["s1", "s2"], names: ["ada", "app-12"] }), "Approve what looks safe for 1 minute in ada, app-12.");
});

test("propose refuses a Risky allow and a safety hook's ask allow, and anything not offered", () => {
  const r = createReadbacks();
  const RISKY = "Risky: the owner approves this one in Needs you";
  assert.deepEqual(r.propose(answer(PERM("high"), "allow"), T0), { ok: false, error: RISKY });
  assert.deepEqual(r.propose(answer(PERM("low", { hookAsk: { hook: "guard-config.js", reason: "r" } }), "allow"), T0), { ok: false, error: RISKY });
  assert.equal(r.propose(answer(PERM("high"), "deny"), T0).ok, true, "a Risky deny is the owner's to confirm too");
  assert.equal(r.propose(answer(PERM("low"), "opt:0"), T0).ok, false, "not offered");
  assert.equal(r.propose(answer(PLAN, "deny"), T0).ok, false, "a plan offers no deny");
  assert.equal(r.propose(answer(PERM("low", { notice: true, choices: [] }), "allow"), T0).ok, false, "a notice");
  assert.equal(r.propose(answer(PERM("low"), "revise"), T0).ok, false, "a revise needs its note");
  assert.equal(r.propose(answer(QUESTION, "picks"), T0).ok, false, "picks are the owner's, in Needs you");
  assert.equal(r.propose({ kind: "window", minutes: 301, sessions: null, names: null }, T0).ok, false);
  assert.equal(refusal({ kind: "window", minutes: 300, sessions: null, names: null }), null, "5 hours is the limit");
  assert.equal(r.propose({ kind: "window", minutes: 10, sessions: ["s1"], names: null }, T0).ok, false, "a name for each session");
  assert.equal(r.propose({ kind: "other" }, T0).ok, false);
  assert.deepEqual(r.list(T0).map((x) => x.text), ["Deny for ada: wants to run npm test."], "only the Risky deny is listed, nothing refused");
});

// A send and a new session never go out on the model's word alone
test("a send and a new session are read-backs too, shown with the whole prompt and spoken as one short line", () => {
  const r = createReadbacks();
  const s = r.propose({ kind: "send", sessionId: "s1", name: "ada", text: "run the tests\nthen push" }, T0);
  assert.deepEqual([s.ok, s.text, s.spoken], [true, "Send ada this prompt:\nrun the tests\nthen push", "Send ada the prompt on screen?"]);
  const o = r.propose({ kind: "open", prompt: "add a dark mode" }, T0);
  assert.deepEqual([o.ok, o.text, o.spoken], [true, "Open a new session with this prompt:\nadd a dark mode", "Open a new session with the prompt on screen?"]);
  assert.deepEqual(r.list(T0).map((x) => [x.kind, x.decisionId]), [["send", null], ["open", null]]);
  assert.deepEqual(r.take(s.id, T0), { kind: "send", sessionId: "s1", name: "ada", text: "run the tests\nthen push" });
  const bad = [
    { kind: "send", sessionId: "s1", name: "ada", text: "" },
    { kind: "send", sessionId: "", name: "ada", text: "x" },
    { kind: "send", sessionId: "s1", text: "x" },
    { kind: "open", prompt: " " },
    { kind: "open", prompt: "x".repeat(2001) },
  ];
  for (const p of bad) assert.equal(r.propose(p, T0).ok, false, JSON.stringify(p).slice(0, 60));
  const a = r.propose(answer(PERM("medium"), "allow"), T0);
  assert.equal(a.spoken, a.text, "an answer is spoken as it is shown");
});

// A prompt can carry characters the card never shows (a direction override, a zero width mark, Unicode tag letters), so
// what the owner reads would not be all that goes in. Variation selectors, Hangul fillers, the blank braille cell and
// C0/C1 controls (an open prompt kept them) are unseen too
test("a send or open prompt with a hidden or control character is refused, so the card shows all that goes in", () => {
  const r = createReadbacks();
  const HIDDEN = "the prompt has hidden or control characters, so VibeQuarters will not read it back";
  for (const cp of [0x202e, 0x2066, 0x200b, 0x200d, 0xfeff, 0xe0041, 0xe007f, 0x00ad, 0xfe0f, 0xe0100, 0xe01ef, 0x115f, 0x1160, 0x3164, 0x2800, 0x07, 0x1b, 0x7f, 0x85, 0x9b]) {
    const ch = String.fromCodePoint(cp);
    assert.deepEqual(r.propose({ kind: "send", sessionId: "s1", name: "ada", text: "push" + ch + " it" }, T0), { ok: false, error: HIDDEN }, cp.toString(16));
    assert.deepEqual(r.propose({ kind: "open", prompt: "add" + ch + " a dark mode" }, T0), { ok: false, error: HIDDEN }, cp.toString(16));
  }
  assert.equal(r.propose({ kind: "open", prompt: "caf" + String.fromCodePoint(0xe9) + " and a line\nbreak\tand a tab" }, T0).ok, true, "accents, line breaks and tabs are seen");
  assert.deepEqual(r.list(T0).length, 1);
});

// Stop drops the assistant's waiting proposals. The assistant has the owner's tools, and a step the owner's
// rules would ask the owner about waits for the owner's yes in HQ
test("a step the assistant needs the owner's yes for is a read-back: the exact command or file, the owner's hook's reason, and one short spoken line", () => {
  const rbs = createReadbacks();
  const p = { kind: "tool", requestId: "r1", tool: "Bash", input: { command: "rm -rf junk", description: "x" }, description: "Delete the junk folder", reason: "local-guardrails: a recursive delete" };
  const r = rbs.propose(p, 1000);
  assert.equal(r.ok, true);
  assert.equal(r.text, "Let the assistant run this command:\nrm -rf junk\nWhy it asks: local-guardrails: a recursive delete");
  assert.equal(r.spoken, "The assistant needs your yes to: Delete the junk folder. It's on screen.");
  assert.equal(readbackText({ kind: "tool", requestId: "r", tool: "Write", input: { file_path: "C:/a/b.txt", content: "hi" } }), "Let the assistant use Write on:\nC:/a/b.txt");
  assert.equal(readbackText({ kind: "tool", requestId: "r", tool: "mcp__x__y", input: { a: 1 } }), 'Let the assistant use mcp__x__y with:\n{"a":1}');
  const long = readbackText({ kind: "tool", requestId: "r", tool: "Bash", input: { command: "x".repeat(3000) } });
  assert.ok([...long].length < 2100 && long.endsWith("..."), "a very long step is cut, and says so");
  assert.equal(rbs.list(1000)[0].kind, "tool");
  assert.equal(rbs.propose({ ...p, requestId: "" }, 1000).ok, false, "it names the ask it answers");
  assert.equal(rbs.propose({ ...p, tool: "" }, 1000).ok, false);
  const hidden = rbs.propose({ ...p, input: { command: "echo hi" + String.fromCharCode(0x202e) + "rm -rf /" } }, 1000);
  assert.deepEqual([hidden.ok, /hidden/.test(hidden.error)], [false, true], "a step with a hidden character is never read back");
});

test("cancelAll drops every waiting read-back and says how many", () => {
  const r = createReadbacks();
  r.propose({ kind: "send", sessionId: "s1", name: "ada", text: "x" }, T0);
  r.propose({ kind: "window", minutes: 10, sessions: null, names: null }, T0);
  assert.equal(r.cancelAll(), 2);
  assert.deepEqual(r.list(T0), []);
  assert.equal(r.cancelAll(), 0);
});

test("a proposal is listed with when its 5 minutes are up, taken once, and gone after them; cancel removes it", () => {
  const r = createReadbacks();
  const a = r.propose(answer(PERM("medium"), "allow"), T0);
  assert.equal(a.ok, true);
  assert.equal(a.text, "Approve for ada: wants to run npm test (Check first).");
  assert.match(a.id, /^[0-9a-f]{16}$/);
  const w = r.propose({ kind: "window", minutes: 10, sessions: null, names: null }, T0 + MIN);
  assert.deepEqual(r.list(T0 + MIN), [
    { id: a.id, kind: "answer", decisionId: "a".repeat(32), text: a.text, at: T0, expiresAt: T0 + 5 * MIN },
    { id: w.id, kind: "window", decisionId: null, text: w.text, at: T0 + MIN, expiresAt: T0 + 6 * MIN },
  ]);
  assert.equal(r.take(a.id, T0 + 2 * MIN).choice, "allow");
  assert.equal(r.take(a.id, T0 + 2 * MIN), null, "taken once");
  assert.equal(r.take(w.id, T0 + 6 * MIN + 1), null, "expired after 5 minutes");
  assert.deepEqual(r.list(T0 + 6 * MIN + 1), []);
  const c = r.propose(answer(PERM("low"), "deny"), T0);
  assert.equal(r.cancel(c.id), true);
  assert.equal(r.cancel(c.id), false);
  assert.equal(r.take(c.id, T0), null);
});

// A proposal that leaves without a yes says why: it expired, the owner canceled it, Stop dropped it, or its decision
// closed first
test("each proposal that leaves without a yes is heard once with why: expired after 5 minutes, the owner's cancel, Stop, or a drop; a taken one is not", () => {
  const heard = [];
  const r = createReadbacks({ onSettle: (...a) => heard.push(a) });
  const send = r.propose({ kind: "send", sessionId: "s1", name: "ada", text: "run the tests\nthen push" }, T0);
  const win = r.propose({ kind: "window", minutes: 10, sessions: null, names: null }, T0 + 4 * MIN);
  assert.deepEqual(r.list(T0 + 5 * MIN).length, 2, "at 5 minutes it still waits");
  assert.deepEqual(heard, []);
  assert.deepEqual(r.list(T0 + 5 * MIN + 1).map((x) => x.id), [win.id]);
  assert.deepEqual(heard, [[send.id, send.text, "expired", "VibeQuarters", T0 + 5 * MIN + 1]], "expired, recorded instead of dropped silently");
  assert.equal(r.take(send.id, T0 + 5 * MIN + 2), null, "an expired one is not open");
  assert.equal(heard.length, 1, "heard once");

  heard.length = 0;
  const ans = r.propose(answer(PERM("medium"), "allow"), T0);
  const open = r.propose({ kind: "open", prompt: "add a dark mode" }, T0);
  const no = r.propose(answer(PERM("low"), "deny"), T0);
  assert.equal(r.cancel(no.id, undefined, undefined, T0 + 1), true);
  assert.equal(r.cancel(ans.id, "dropped: answered elsewhere", "VibeQuarters", T0 + 2), true);
  assert.equal(r.cancel(ans.id, "dropped: answered elsewhere", "VibeQuarters", T0 + 3), false, "a second drop is nothing");
  assert.deepEqual(r.take(open.id, T0 + 4), { kind: "open", prompt: "add a dark mode" });
  assert.deepEqual(heard, [[no.id, no.text, "canceled", "you", T0 + 1], [ans.id, ans.text, "dropped: answered elsewhere", "VibeQuarters", T0 + 2]], "a taken one is the caller's to settle");

  heard.length = 0;
  const a = r.propose({ kind: "send", sessionId: "s1", name: "ada", text: "x" }, T0 + 5 * MIN);
  assert.equal(r.cancelAll(T0 + 5 * MIN), 2);
  assert.deepEqual(heard.map(([id, , outcome, via, at]) => [id, outcome, via, at]), [[win.id, "canceled", "Stop", T0 + 5 * MIN], [a.id, "canceled", "Stop", T0 + 5 * MIN]]);
});

// A thrown value whose stack is not a string must not throw again inside the catch, or the request gets no answer
test("the confirm-failed log line never throws, and never carries the error's text", () => {
  const real = new TypeError("the owner's words");
  real.code = "E_X";
  const line = confirmFailLine(real);
  assert.match(line, /^a read-back's confirm failed: TypeError E_X\s+at /);
  assert.ok(!line.includes("the owner's words"), "never the error's text");
  for (const odd of [{ stack: 42 }, { stack: {} }, { stack: null }, { stack: ["a", "b"] }, null, undefined, "boom", 7]) assert.doesNotThrow(() => confirmFailLine(odd), JSON.stringify(odd));
  assert.equal(confirmFailLine({ stack: 42 }), "a read-back's confirm failed: error");
  assert.equal(confirmFailLine("boom"), "a read-back's confirm failed: error");
});
