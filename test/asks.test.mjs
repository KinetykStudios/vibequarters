// The Needs you rules the page follows, with no DOM: the queue's order, Approve all safe (with shell, connector, other
// tool, Risky, Check first, plan and notice negative controls), each item's buttons with and without Streamer and
// control, the number-key guard, the Ask for changes note as the page sends it, a Risky Approve's second click and a
// notice's one link (held to the server's rules), a picks form's state, the popup's Later on every item, and the alert
// lines with their time apart.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { ordered, safeBatch, BATCH_TOOLS, buttonsOf, keyChoice, noteOf, GUARD_MS, NOTE_MAX, NOTE_HINT, TITLE, STREAM_NOTE, HIDDEN, OPEN_VS, itemNote, needsConfirm, emptyPicks, pickOption, picksReady, alertText, alertParts, chipWords } from "../public/asks.js";
import { MASK } from "../public/streamer.js";

const { READ_ONLY, FILE_TOOLS } = createRequire(import.meta.url)("../lib/describe.js"); // the tools the risk rules can rate Safe

const LABEL = { low: "Safe", medium: "Check first", high: "Risky" };
const P = (id, askedAt, level = "low", toolName = "Edit") => ({ id, kind: "permission", askedAt, toolName, risk: { level, label: LABEL[level], reason: level === "low" ? null : "deletes files" }, choices: [{ key: "allow", label: "Approve" }, { key: "deny", label: "Deny" }, { key: "revise", label: "Ask for changes" }], ...(level === "high" ? { confirm: "Yes, run: rm -rf dist" } : {}) });
const Q = (id, askedAt) => ({ id, kind: "question", askedAt, risk: null, choices: [{ key: "opt:0", label: "Red" }, { key: "opt:1", label: "Blue" }] });
const PLAN = (id, askedAt) => ({ id, kind: "permission", askedAt, toolName: "ExitPlanMode", risk: null, choices: [{ key: "allow", label: "Approve" }, { key: "revise", label: "Keep planning" }] });
const SIZES = { question: "Which sizes?", multiSelect: true, options: [{ label: "S", description: "" }, { label: "M", description: "" }, { label: "L", description: "" }] };
const COLOR = { question: "Which color?", multiSelect: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] };
const MULTI = (id, askedAt) => ({ id, kind: "question", askedAt, risk: null, choices: [{ key: "picks", label: "Send" }], questions: [COLOR, SIZES] });
const SID = "0a1b2c3d-0000-4000-8000-00000000000a";
const LINK = "vscode://anthropic.claude-code/open?session=" + SID;
const N = (id, askedAt, link = LINK) => ({ ...P(id, askedAt, "high", "Bash"), sessionId: SID, notice: true, choices: [], moved: "Moved to VS Code after 10 min", link, confirm: undefined });
const R = (sid, askedAt, link = "vscode://anthropic.claude-code/open?session=" + sid) => ({ id: "reply:" + sid, kind: "reply", askedAt, risk: null, choices: [], link });
const ids = (list) => list.map((d) => d.id);
const labels = (bs) => bs.map((b) => (b.n ? b.n : "") + b.label + (b.disabled ? " (off)" : "")).join(",");

test("the page reads whether HQ can act on an answer here from the served page, apart from the token", async () => {
  const before = globalThis.document;
  const page = async (metas, n) => {
    globalThis.document = { querySelector: (q) => Object.entries(metas).filter(([name]) => q.includes(name)).map(([, content]) => ({ content }))[0] || null };
    return import(`../public/control.js?answers=${n}`);
  };
  try {
    const token = "ab".repeat(32);
    const on = await page({ "hq-token": token }, 1), off = await page({ "hq-token": token, "hq-answers": "off" }, 2), none = await page({}, 3);
    assert.deepEqual([on.canAnswer(), on.canReply(), on.answersNote()], [true, true, ""]);
    assert.deepEqual([off.canAnswer(), off.canReply()], [true, false]);
    assert.match(off.answersNote(), /Windows.*VS Code|Windows.*Claude Code/);
    assert.deepEqual([none.canAnswer(), none.canReply(), none.answersNote()], [false, false, ""]);
  } finally {
    globalThis.document = before;
  }
});

test("the queue: permissions, then questions, then replies, oldest first within each", () => {
  assert.deepEqual(ids(ordered([R("s1", 1), Q("q2", 50), P("p3", 300), Q("q1", 10), P("p1", 100), P("p2", 200)])), ["p1", "p2", "p3", "q1", "q2", "reply:s1"]);
  assert.deepEqual(ordered(undefined), []);
  assert.deepEqual(TITLE, { permission: "Needs your OK", question: "Question for you", reply: "Waiting for your reply" });
  assert.deepEqual([STREAM_NOTE, HIDDEN, OPEN_VS], ["Turn Streamer off to approve", "Hidden while streaming", "Open in VS Code"]);
});

test("Approve all safe takes 2 or more Safe reads or file changes only; never a shell call, a connector or another tool, a Risky or Check first item, a plan, a question, a notice, or anything under Streamer", () => {
  const two = [P("a", 1), P("b", 2)];
  assert.deepEqual(ids(safeBatch([...two, P("r", 3, "high"), P("m", 4, "medium"), Q("q", 5)], false)), ["a", "b"]);
  // the negative controls: one Safe item beside a Risky one makes no batch, and the Risky one is never in a batch
  assert.deepEqual(safeBatch([P("a", 1), P("r", 3, "high")], false), []);
  assert.ok(!ids(safeBatch([...two, P("r", 3, "high")], false)).includes("r"));
  // a Read the bridge marked risky reads Risky (describe paints the mark high), so it stays out
  assert.ok(!ids(safeBatch([...two, P("rr", 3, "high", "Read")], false)).includes("rr"), "a Read marked risky");
  assert.deepEqual(safeBatch([P("m1", 1, "medium"), P("m2", 2, "medium")], false), [], "Check first is never approved in bulk");
  assert.deepEqual(safeBatch([Q("q1", 1), Q("q2", 2)], false), [], "a question is never approved in bulk");
  assert.deepEqual(safeBatch([PLAN("p1", 1), PLAN("p2", 2)], false), [], "a plan is never approved in bulk");
  // a shell call never reads Safe; were one ever to, it still stays out of the batch
  assert.deepEqual(ids(safeBatch([...two, P("sh", 3, "low", "Bash"), P("ps", 4, "low", "PowerShell")], false)), ["a", "b"]);
  assert.deepEqual(safeBatch([P("sh", 1, "low", "Bash"), P("ps", 2, "low", "PowerShell")], false), [], "shell calls make no batch");
  // only a read or a file change: a connector, Agent, Skill or SendMessage stays out whatever its chip says, by the same
  // list the risk rules rate (READ_ONLY and FILE_TOOLS)
  const others = ["mcp__claude_ai_Example_Files__share_file", "mcp__example_media__generate_video", "Agent", "Skill", "SendMessage"].map((t, k) => P("o" + k, 10 + k, "low", t));
  assert.deepEqual(ids(safeBatch([...two, ...others], false)), ["a", "b"]);
  assert.deepEqual(safeBatch(others, false), [], "other tools make no batch");
  assert.deepEqual(ids(safeBatch([P("r1", 1, "low", "Read"), P("w1", 2, "low", "Write")], false)), ["r1", "w1"], "a read and a write make one");
  // a safety hook's ask is the owner's alone, even at Safe
  const hooked = { ...P("h", 3, "low", "Write"), hookAsk: { hook: "guard-config.js", reason: "a quality-gate config" } };
  assert.deepEqual(ids(safeBatch([...two, hooked], false)), ["a", "b"]);
  assert.deepEqual(safeBatch([P("a", 1), hooked], false), [], "a hook's ask makes no batch");
  assert.deepEqual([...BATCH_TOOLS].sort(), [...READ_ONLY, ...FILE_TOOLS].sort());
  assert.deepEqual(safeBatch(two, true), [], "hidden under Streamer");
  // a notice is asked in VS Code now: never in a batch, even were its chip to read Safe
  const notices = [{ ...P("n1", 1), notice: true, choices: [] }, { ...P("n2", 2), notice: true, choices: [] }];
  assert.deepEqual(safeBatch(notices, false), [], "notices make no batch");
  assert.deepEqual(ids(safeBatch([...two, ...notices], false)), ["a", "b"]);
});

test("the buttons: Approve (1), Deny (2), Ask for changes (3), a plan's Approve and Keep planning, the options numbered, or Send with no number; no Answer in VS Code anywhere; Streamer disables Approve only; no control, none", () => {
  assert.equal(labels(buttonsOf(P("a", 1), { control: true, streaming: false })), "1Approve,2Deny,3Ask for changes");
  assert.equal(labels(buttonsOf(P("r", 1, "high", "Bash"), { control: true, streaming: false })), "1Approve,2Deny,3Ask for changes", "a Risky item: the same three, its Approve asks for the second click (needs.js)");
  assert.equal(labels(buttonsOf(Q("q", 1), { control: true, streaming: false })), "1Red,2Blue");
  assert.equal(labels(buttonsOf(PLAN("p", 1), { control: true, streaming: false })), "1Approve,2Keep planning");
  assert.equal(labels(buttonsOf(MULTI("m", 1), { control: true, streaming: false })), "Send");
  assert.equal(labels(buttonsOf(P("a", 1), { control: true, streaming: true })), "1Approve (off),2Deny,3Ask for changes");
  assert.equal(labels(buttonsOf(PLAN("p", 1), { control: true, streaming: true })), "1Approve (off),2Keep planning");
  assert.equal(labels(buttonsOf(Q("q", 1), { control: true, streaming: true })), "1Red,2Blue");
  assert.equal(buttonsOf(P("a", 1), { control: true, streaming: false })[0].primary, true);
  assert.equal(buttonsOf(MULTI("m", 1), { control: true, streaming: false })[0].primary, true);
  for (const d of [P("a", 1), P("r", 1, "high"), Q("q", 1), PLAN("p", 1), MULTI("m", 1)])
    for (const streaming of [false, true])
      for (const popup of [false, true]) {
        const bs = buttonsOf(d, { control: true, streaming, popup });
        assert.ok(bs.every((b) => b.key !== "vscode" && !b.href && !/VS Code/.test(b.label)), d.id + ": nothing HQ can answer hands it to VS Code");
      }
  assert.deepEqual(buttonsOf(P("a", 1), { control: false, streaming: false }), [], "control off: nothing to answer with");
  const reply = buttonsOf(R("s1", 1), { control: false, streaming: true, popup: true });
  assert.deepEqual(reply.map((b) => [b.label, b.href, b.n]), [["Open this chat", "vscode://anthropic.claude-code/open?session=s1", null], ["Later", null, null]]);
  assert.deepEqual(buttonsOf(R("s1", 1, null), { control: true, streaming: false }), [], "no link: no Open this chat; the rail has no Later");
  // in the popup every item ends with Later (no number, no link), so with control off it can still step through a
  // chat's items; the rail has none
  assert.equal(labels(buttonsOf(P("a", 1), { control: true, streaming: false, popup: true })), "1Approve,2Deny,3Ask for changes,Later");
  assert.equal(labels(buttonsOf(P("a", 1), { control: true, streaming: true, popup: true })), "1Approve (off),2Deny,3Ask for changes,Later");
  assert.equal(labels(buttonsOf(Q("q", 1), { control: true, streaming: false, popup: true })), "1Red,2Blue,Later");
  for (const d of [P("a", 1), P("m", 1, "medium"), Q("q", 1), PLAN("p", 1), MULTI("m", 1)]) {
    const bs = buttonsOf(d, { control: false, streaming: false, popup: true });
    assert.deepEqual(bs, [{ key: "later", label: "Later", n: null, primary: false, disabled: false, href: null }], d.id + ": control off, the popup offers Later alone");
    assert.equal(itemNote(d, bs, false), "", d.id);
  }
});

test("a notice offers only Open in VS Code, a link to its chat that posts nothing, with control and Streamer on or off, and says how long HQ held it; with no link it offers nothing and says the same", () => {
  const notice = N("n", 2);
  // a notice whose kept copy reads lower is still never answered, by its mark
  const lowNotice = { ...notice, id: "n0", risk: { level: "low", label: "Safe", reason: null } };
  for (const d of [notice, lowNotice])
    for (const control of [true, false])
      for (const streaming of [true, false])
        for (const popup of [true, false]) {
          const at = `${d.id} control ${control} streaming ${streaming} popup ${popup}`;
          const bs = buttonsOf(d, { control, streaming, popup });
          assert.equal(labels(bs), popup ? "Open in VS Code,Later" : "Open in VS Code", at);
          assert.deepEqual([bs[0].key, bs[0].href, bs[0].n, bs[0].disabled], ["vscode", LINK, null, false], at);
          assert.equal(itemNote(d, bs, streaming), "Moved to VS Code after 10 min", at);
          for (const k of "123456789") assert.equal(keyChoice(bs, k, 0, 5000), null, at + " key " + k);
        }
  // no link (the server builds one only for a lowercase UUID session): no button, and still where it went
  const lost = N("l", 3, null);
  assert.deepEqual(buttonsOf(lost, { control: true, streaming: false }), []);
  assert.equal(labels(buttonsOf(lost, { control: true, streaming: false, popup: true })), "Later");
  assert.equal(itemNote(lost, [], false), "Moved to VS Code after 10 min");
});

test("the page follows the server's rules (server.js /api/answer): it answers everything but a notice, and a Risky Approve sends only from the second click", () => {
  // the server's rules, word for word; if one changes, this test fails here first, and the page's rule follows it
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.ok(server.includes('if (item.notice) return refuse(400, "answer in VS Code");'), "server.js refuses a notice");
  assert.ok(server.includes('if (b.choice === "allow" && item.risk && item.risk.level === "high" && b.confirm !== true) return refuse(400, "confirm first");'), "server.js refuses a Risky allow without the confirm");
  const refuses = (item) => !!item.notice;
  const confirms = (item) => !!(item.risk && item.risk.level === "high");
  const risks = [null, ...["low", "medium", "high"].map((level) => ({ level, label: LABEL[level], reason: null }))];
  let both = 0;
  for (const base of [P("p", 1), Q("q", 1), PLAN("l", 1)])
    for (const notice of [undefined, false, 0, "", true, 1, "yes"])
      for (const risk of risks) {
        const d = { ...base, sessionId: SID, risk, link: LINK, ...(notice === undefined ? {} : { notice }) };
        const at = `${d.kind} ${d.toolName || ""} notice ${JSON.stringify(notice)} risk ${risk && risk.level}`;
        const bs = buttonsOf(d, { control: true, streaming: false });
        const linkOnly = bs.length === 1 && bs[0].key === "vscode" && !!bs[0].href;
        assert.equal(linkOnly, refuses(d), at);
        if (refuses(d)) both++;
        else assert.deepEqual(bs.map((b) => b.key), d.choices.map((c) => c.key), at + ": every choice it offers");
        assert.equal(needsConfirm(d), confirms(d), at + ": the second click");
        assert.equal(safeBatch([d, { ...d, id: d.id + "2" }], false).length > 0, !refuses(d) && d.kind === "permission" && d.toolName === "Edit" && !!risk && risk.level === "low", at + ": Approve all safe");
      }
  assert.ok(both > 0, "the matrix has items the server refuses");
});

test("a picks form: one list of option places per question; a one-pick question takes the option clicked in place of another, a several-pick one adds or takes it off, kept in order; Send is ready once each question has one", () => {
  const d = MULTI("m", 1);
  let p = emptyPicks(d);
  assert.deepEqual(p, [[], []]);
  assert.equal(picksReady(d, p), false);
  p = pickOption(d, p, 0, 1);
  assert.deepEqual(p, [[1], []]);
  assert.equal(picksReady(d, p), false, "the second question has none yet");
  p = pickOption(d, p, 0, 0);
  assert.deepEqual(p, [[0], []], "a one-pick question takes the new one in place");
  p = pickOption(d, pickOption(d, p, 1, 2), 1, 0);
  assert.deepEqual(p, [[0], [0, 2]], "in the options' order");
  assert.equal(picksReady(d, p), true);
  p = pickOption(d, p, 1, 2);
  assert.deepEqual(p, [[0], [0]], "a several-pick option clicked again comes off");
  p = pickOption(d, p, 1, 0);
  assert.deepEqual([p, picksReady(d, p)], [[[0], []], false], "and with none left it is not ready");
  const before = emptyPicks(d);
  pickOption(d, before, 0, 1);
  assert.deepEqual(before, [[], []], "a pick never changes the state it was given");
});

test("the item's own note: the Streamer note only where Approve is offered and disabled", () => {
  const on = buttonsOf(P("a", 1), { control: true, streaming: true });
  assert.equal(itemNote(P("a", 1), on, true), STREAM_NOTE);
  assert.equal(itemNote(PLAN("p", 1), buttonsOf(PLAN("p", 1), { control: true, streaming: true }), true), STREAM_NOTE);
  assert.equal(itemNote(P("a", 1), buttonsOf(P("a", 1), { control: true, streaming: false }), false), "");
  assert.equal(itemNote(P("a", 1), buttonsOf(P("a", 1), { control: false, streaming: true }), true), "", "control off: no Approve, no note");
  assert.equal(itemNote(Q("q", 1), buttonsOf(Q("q", 1), { control: true, streaming: true }), true), "");
  assert.equal(itemNote(MULTI("m", 1), buttonsOf(MULTI("m", 1), { control: true, streaming: true }), true), "");
  assert.equal(itemNote(R("s1", 1), buttonsOf(R("s1", 1), { control: true, streaming: true }), true), "");
});

test("a number key answers only once the guard is over, and only through an enabled numbered button", () => {
  const bs = buttonsOf(P("a", 1), { control: true, streaming: false });
  assert.equal(GUARD_MS, 350);
  assert.equal(keyChoice(bs, "1", 1000, 1000 + GUARD_MS - 1), null, "inside the guard");
  assert.equal(keyChoice(bs, "1", 1000, 1000 + GUARD_MS).key, "allow");
  assert.equal(keyChoice(bs, "2", 0, 5000).key, "deny");
  assert.equal(keyChoice(bs, "3", 0, 5000).key, "revise", "3 opens the Ask for changes box (needs.js); it sends nothing by itself");
  assert.equal(keyChoice(bs, "4", 0, 5000), null, "no fourth button");
  assert.equal(keyChoice(bs, "a", 0, 5000), null);
  assert.equal(keyChoice(buttonsOf(P("a", 1), { control: true, streaming: true }), "1", 0, 5000), null, "a disabled Approve");
  assert.equal(keyChoice(buttonsOf(P("a", 1), { control: true, streaming: true }), "3", 0, 5000).key, "revise", "Ask for changes stays under Streamer: it is a deny");
  assert.equal(keyChoice(buttonsOf(MULTI("m", 1), { control: true, streaming: false }), "1", 0, 5000), null, "Send has no number: it sends only on a click");
  assert.equal(keyChoice(buttonsOf(R("s1", 1), { control: true, streaming: false, popup: true }), "1", 0, 5000), null, "a reply has no number keys");
});

test("the Ask for changes note is sent as one plain line of 1 to 500 characters, or not at all", () => {
  assert.equal(NOTE_MAX, 500);
  assert.equal(NOTE_HINT, "Write what to change, up to 500 characters");
  assert.equal(noteOf("  use   the\tstaging\nfolder  "), "use the staging folder");
  assert.equal(noteOf("a\x01b\x7fc"), "a b c", "control characters become spaces");
  for (const bad of ["", "   ", "\n\t", "x".repeat(501), undefined, null, 5]) assert.equal(noteOf(bad), null, JSON.stringify(bad));
  assert.equal(noteOf("x".repeat(500)), "x".repeat(500));
  assert.equal(noteOf("😀".repeat(500)), "😀".repeat(500), "counted in characters, not UTF-16 units");
});

test("an alert line: whose answer and which tool, how long ago, and where to look; Streamer masks the name and keeps the tool; the unreadable log and an answer HQ could not confirm in time have their own lines", () => {
  const now = 10_000_000;
  const a = { at: now - 120e3, id: "ab".repeat(16), sessionName: "alpha", toolName: "Bash" };
  assert.equal(alertText(a, now, false), "An answer for alpha (Bash) was written outside VibeQuarters, 2m ago. See answers.log.");
  assert.equal(alertText(a, now, true), `An answer for ${MASK} (Bash) was written outside VibeQuarters, 2m ago. See answers.log.`);
  assert.ok(!alertText(a, now, true).includes("alpha"));
  // the server sends null for a session it never showed and for a tool name it would not keep
  assert.equal(alertText({ ...a, sessionName: null, toolName: null }, now, false), "An answer for an unknown chat was written outside VibeQuarters, 2m ago. See answers.log.");
  const u = { at: now - 5e3, id: null, sessionName: null, toolName: null, unreadable: true };
  for (const streaming of [false, true]) assert.equal(alertText(u, now, streaming), "VibeQuarters cannot read answers.log, so it cannot tell who answered, 5s ago.");
  // an answer HQ could not confirm in time (the lookup or the check failed or ran out of time): no tamper words, and
  // what to do
  const c = { ...a, unchecked: true };
  assert.equal(alertText(c, now, false), "VibeQuarters could not confirm your answer for alpha (Bash) in time, 2m ago. Answer it again.");
  assert.equal(alertText(c, now, true), `VibeQuarters could not confirm your answer for ${MASK} (Bash) in time, 2m ago. Answer it again.`);
  assert.equal(alertText({ ...c, sessionName: null, toolName: null }, now, false), "VibeQuarters could not confirm your answer for an unknown chat in time, 2m ago. Answer it again.");
  // the line in three parts, the words around its time: only the time moves with the clock (needs.js keeps it out of
  // what the alert region announces)
  assert.deepEqual(alertParts(a, now, false), ["An answer for alpha (Bash) was written outside VibeQuarters, ", "2m ago", ". See answers.log."]);
  assert.deepEqual(alertParts(u, now, false), ["VibeQuarters cannot read answers.log, so it cannot tell who answered, ", "5s ago", "."]);
  assert.deepEqual(alertParts(c, now, false), ["VibeQuarters could not confirm your answer for alpha (Bash) in time, ", "2m ago", ". Answer it again."]);
  for (const x of [a, u, c, { ...a, sessionName: null, toolName: null }])
    for (const streaming of [false, true]) {
      const p = alertParts(x, now, streaming), later = alertParts(x, now + 61e3, streaming);
      assert.equal(p.join(""), alertText(x, now, streaming));
      assert.deepEqual([later[0], later[2]], [p[0], p[2]], "the words stay");
      assert.notEqual(later[1], p[1], "the time moves");
    }
});

// A chip carries its reason in its title, and the text says it after the label: every reason on a card, a Risky one
// only on a Live row's one line
test("a risk chip's words: the reason in its title and after a colon in the text; a row shows a Risky reason only; Safe is its label alone", () => {
  const { riskOf } = createRequire(import.meta.url)("../lib/describe.js");
  const db = riskOf("Bash", { command: "supabase db push" });
  assert.deepEqual(db, { level: "high", label: "Risky", reason: "changes the live site or database" }, "describe's own chip for a supabase command");
  assert.deepEqual(chipWords(db), { label: "Risky:", why: "changes the live site or database", title: "Risky: changes the live site or database" });
  assert.deepEqual(chipWords(db, { riskyOnly: true }), chipWords(db), "a row shows a Risky reason");
  const check = { level: "medium", label: "Check first", reason: "runs a program on your computer" };
  assert.deepEqual(chipWords(check), { label: "Check first:", why: "runs a program on your computer", title: "Check first: runs a program on your computer" });
  assert.deepEqual(chipWords(check, { riskyOnly: true }), { label: "Check first", why: "", title: "Check first: runs a program on your computer" }, "a row keeps Check first's reason to its title");
  for (const o of [{}, { riskyOnly: true }]) assert.deepEqual(chipWords({ level: "low", label: "Safe", reason: null }, o), { label: "Safe", why: "", title: null });
});
