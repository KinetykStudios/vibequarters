// The assistant panel's words and the voice's rules with no DOM (public/assistant-rules.js): the window's countdown, the
// status line, the "Sent to" label, the usage line, the talk key, a spoken yes or cancel, and one page per spoken line.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { countdown, statusWord, sentLabel, windowChip, usageLine, talkKey, yesOrNo, spokenAnswer, settled, claimSpeech, watchSpeech, STREAMER_CARD, hiddenCard, mayConfirm, RB_TITLE, expiresIn, waitingLine, since, recentLines, recentFeed, FILLERS, pickFiller } from "../public/assistant-rules.js";

test("the countdown is minutes and seconds left, rounded up, never below 0:00", () => {
  const now = 1_800_000_000_000;
  assert.equal(countdown(now + 125e3, now), "2:05");
  assert.equal(countdown(now + 600e3, now), "10:00");
  assert.equal(countdown(now + 59_001, now), "1:00");
  assert.equal(countdown(now - 5e3, now), "0:00");
  assert.equal(windowChip(now + 125e3, now), "Approving everything: 2:05 left");
  assert.equal(windowChip(now + 3600e3, now), "Approving everything: 60:00 left");
  assert.equal(windowChip(now + 3661e3, now), "Approving everything: 1 h 1 min left");
  assert.equal(windowChip(now + 300 * 60e3 - 1e3, now), "Approving everything: 4 h 59 min left");
  assert.equal(windowChip(now + 300 * 60e3, now), "Approving everything: 5 h left");
});

test("the status line: Listening when idle, Thinking while it works, Offline with the reason, Offline when the payload has none", () => {
  assert.equal(statusWord({ status: "error", error: "signed out" }), "Offline: signed out");
  assert.equal(statusWord({ status: "error" }), "Offline");
  assert.equal(statusWord({ status: "idle" }), "Listening");
  assert.equal(statusWord({ status: "working" }), "Thinking");
  assert.equal(statusWord({ status: "starting" }), "Starting");
  assert.equal(statusWord({ status: "off" }), "Offline");
  assert.equal(statusWord(null), "Offline");
  assert.equal(statusWord(undefined), "Offline");
  assert.equal(statusWord({ status: "junk" }), "Offline");
});

test("a prompt the assistant sent is labeled with the chat it went to", () => {
  assert.equal(sentLabel("lantern-34"), "Sent to lantern-34");
});

test("the usage line: this week's assistant spend of the week's total, its share, and the split by model", () => {
  assert.equal(usageLine({ assistantUsd: 1.5, totalUsd: 120, byModel: { sonnet: 1.2, opus: 0.3 }, share: 0.0125 }), "This week: $1.50 of $120.00 (1%), Sonnet $1.20, Opus $0.30");
  assert.equal(usageLine({ assistantUsd: 0, totalUsd: 0, byModel: { sonnet: 0, opus: 0 }, share: 0 }), "This week: $0.00 of $0.00 (0%), Sonnet $0.00, Opus $0.00");
  assert.equal(usageLine({ assistantUsd: 12.346, totalUsd: 1234.5, byModel: { sonnet: 10, opus: 2.346 }, share: 0.01 }), "This week: $12.35 of $1,234.50 (1%), Sonnet $10.00, Opus $2.35");
  assert.equal(usageLine({ assistantUsd: 3, totalUsd: 10, byModel: { sonnet: 3, opus: 0 }, share: 0.3 }), "This week: $3.00 of $10.00 (30%), Sonnet $3.00, Opus $0.00");
  assert.equal(usageLine(null), null);
  assert.equal(usageLine(undefined), null);
});

test("the talk key is Ctrl+Space alone: never with Meta or Alt, never without Ctrl", () => {
  const key = (o) => ({ ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, code: "Space", ...o });
  assert.equal(talkKey(key({ ctrlKey: true })), true);
  assert.equal(talkKey(key({ ctrlKey: true, metaKey: true })), false);
  assert.equal(talkKey(key({ ctrlKey: true, altKey: true })), false);
  assert.equal(talkKey(key({})), false);
  assert.equal(talkKey(key({ metaKey: true })), false);
  assert.equal(talkKey(key({ ctrlKey: true, code: "KeyK" })), false);
});

test("a spoken yes or cancel answers the read-back; anything else goes to the assistant", () => {
  assert.equal(yesOrNo("Yes do it"), "yes");
  assert.equal(yesOrNo("yeah"), "yes");
  assert.equal(yesOrNo("Yep."), "yes");
  assert.equal(yesOrNo("confirm"), "yes");
  assert.equal(yesOrNo("do it"), "yes");
  assert.equal(yesOrNo("  yes"), "yes");
  assert.equal(yesOrNo("cancel that"), "cancel");
  assert.equal(yesOrNo("No."), "cancel");
  assert.equal(yesOrNo("stop"), "cancel");
  assert.equal(yesOrNo("don't"), "cancel");
  assert.equal(yesOrNo("yesterday's build"), null);
  assert.equal(yesOrNo("notice the build"), null);
  assert.equal(yesOrNo("what's going on"), null);
  assert.equal(yesOrNo(""), null);
});

// A yes or cancel counts only when it is the whole answer; a sentence that starts with one is words
test("a sentence that only starts with a yes or a no is words for the assistant, never an answer", () => {
  for (const t of ["Yes, send it", "Yes, but only for b7", "Yeah, no", "Do it later", "No, wait, read it again", "stop the build"]) assert.equal(yesOrNo(t), null, t);
  for (const t of ["Yes!", "yes please", "Yes, confirm.", "Confirmed"]) assert.equal(yesOrNo(t), "yes", t);
  for (const t of ["Cancel it", "nope", "No thanks"]) assert.equal(yesOrNo(t), "cancel", t);
});

// With A and B waiting, a spoken yes must not go to B, the newest, when the owner has heard only A
test("a spoken yes answers the one read-back waiting if it is under a minute old; with two waiting it answers none", () => {
  const now = 1_800_000_000_000;
  const A = { id: "rb-a", at: now - 10e3 }, B = { id: "rb-b", at: now - 2e3 };
  assert.deepEqual(spokenAnswer("yes", [A], now), { kind: "answer", id: "rb-a", yes: true });
  assert.deepEqual(spokenAnswer("cancel", [A], now), { kind: "answer", id: "rb-a", yes: false });
  assert.deepEqual(spokenAnswer("yes", [A, B], now), { kind: "refuse", note: "2 read-backs are waiting. Use Confirm or Cancel on the one you mean" });
  assert.deepEqual(spokenAnswer("yes", [{ id: "rb-old", at: now - 61e3 }], now), { kind: "say" }, "an old read-back: the yes is words for the assistant");
  assert.deepEqual(spokenAnswer("yes", [{ id: "rb-x" }], now), { kind: "say" }, "a read-back with no time is never fresh");
  assert.deepEqual(spokenAnswer("Yes, send it", [A], now), { kind: "say" });
  assert.deepEqual(spokenAnswer("yes", [], now), { kind: "say" });
});

// Under Streamer every card's text is masked and the voice quiet, so neither Confirm nor a spoken yes may go through: the
// owner would confirm what was never seen or heard
test("under Streamer every card is masked, so every kind shows a fixed line and takes no yes, by click or voice; a cancel still goes", () => {
  const now = 1_800_000_000_000;
  const cards = ["send", "open", "answer", "window"].map((kind) => ({ id: "rb-" + kind, kind, at: now - 5e3 }));
  assert.equal(STREAMER_CARD, "Turn Streamer off to read this before you confirm it");
  for (const rb of cards) {
    assert.equal(hiddenCard(rb, true), true, rb.kind + ": no Confirm under Streamer");
    assert.equal(hiddenCard(rb, false), false, rb.kind + ": Confirm with Streamer off");
    assert.deepEqual(spokenAnswer("yes", [rb], now, { streamer: true }), { kind: "refuse", note: STREAMER_CARD }, rb.kind);
    assert.deepEqual(spokenAnswer("cancel", [rb], now, { streamer: true }), { kind: "answer", id: rb.id, yes: false }, rb.kind);
    assert.deepEqual(spokenAnswer("yes", [rb], now, { streamer: false }), { kind: "answer", id: rb.id, yes: true }, rb.kind);
  }
});

// A Confirm click for a card no longer in the list must not go through: a card that is not found is not hidden
test("a Confirm goes only to a card in the list, never to one Streamer hides", () => {
  const rb = { id: "rb-1", kind: "send", at: 1 };
  assert.equal(mayConfirm([rb], "rb-1", false), true);
  assert.equal(mayConfirm([rb], "rb-1", true), false, "Streamer hides it");
  assert.equal(mayConfirm([rb], "rb-2", false), false, "not in the list");
  assert.equal(mayConfirm([rb], "rb-2", true), false, "not in the list, Streamer on");
  assert.equal(mayConfirm([], "rb-1", false), false, "no cards");
});

// A yes the owner said before the card came (the mic holds the card's spoken line while it listens) must not answer it
test("a spoken yes answers a card only if it was there before the owner started talking", () => {
  const now = 1_800_000_000_000;
  const rb = { id: "rb-a", kind: "answer", at: now - 2e3 };
  assert.deepEqual(spokenAnswer("yes", [rb], now, { heardFrom: now - 1e3 }), { kind: "answer", id: "rb-a", yes: true }, "the card came, then the owner talked");
  assert.deepEqual(spokenAnswer("yes", [rb], now, { heardFrom: now - 3e3 }), { kind: "refuse", note: "That read-back came while you were talking. Say yes again, or use Confirm" });
  assert.deepEqual(spokenAnswer("cancel", [rb], now, { heardFrom: now - 3e3 }), { kind: "answer", id: "rb-a", yes: false }, "a cancel is always safe");
});

// In the room the cards scroll together, so a new card can slide under a click meant for the one before
test("a Confirm or Cancel click within 700 ms of the cards changing is ignored", () => {
  const t = 1_800_000_000_000;
  assert.equal(settled(t, t + 699), false);
  assert.equal(settled(t, t + 700), true);
  assert.equal(settled(0, t), true, "cards that never changed are settled");
});

// A send is answered as every other kind is: a lone yes confirms the one fresh card, as the payload carries it
test("a lone spoken yes confirms a send read-back, as it does an open, an answer and a window; a cancel cancels it", () => {
  const now = 1_800_000_000_000;
  const send = { id: "rb-send", kind: "send", text: "Send ada this prompt:\nrun the tests", at: now - 8e3, expiresAt: now - 8e3 + 300e3 };
  for (const t of ["yes", "Yes.", "yeah", "confirm", "do it", "yes please"]) assert.deepEqual(spokenAnswer(t, [send], now), { kind: "answer", id: "rb-send", yes: true }, t);
  assert.deepEqual(spokenAnswer("cancel", [send], now), { kind: "answer", id: "rb-send", yes: false });
  assert.deepEqual(spokenAnswer("yes", [send], now, { heardFrom: now - 2e3 }), { kind: "answer", id: "rb-send", yes: true }, "the owner started talking after it came");
  assert.equal(mayConfirm([send], "rb-send", false), true, "and its Confirm goes through");
  for (const kind of ["open", "answer", "window"]) assert.deepEqual(spokenAnswer("yes", [{ ...send, id: "rb-" + kind, kind }], now), { kind: "answer", id: "rb-" + kind, yes: true }, kind);
});

test("a read-back card's title and time left: whole minutes rounded up, seconds in its last minute, then expiring now", () => {
  const now = 1_800_000_000_000;
  assert.equal(RB_TITLE, "Waiting for your yes");
  assert.equal(expiresIn(now + 300e3, now), "expires in 5 min");
  assert.equal(expiresIn(now + 4 * 60e3 + 1, now), "expires in 5 min");
  assert.equal(expiresIn(now + 4 * 60e3, now), "expires in 4 min");
  assert.equal(expiresIn(now + 60e3, now), "expires in 1 min");
  assert.equal(expiresIn(now + 59_001, now), "expires in 60 s");
  assert.equal(expiresIn(now + 40e3, now), "expires in 40 s");
  assert.equal(expiresIn(now, now), "expiring now");
  assert.equal(expiresIn(now - 3e3, now), "expiring now");
});

test("Live's header says the assistant waits for the owner's yes, and on how many when more than one", () => {
  assert.equal(waitingLine(1), "The assistant is waiting for your yes");
  assert.equal(waitingLine(2), "The assistant is waiting for your yes on 2");
});

test("Recent: the newest 5 of the settled history, each its outcome first in plain words, what it was and how long ago", () => {
  const now = 1_800_000_000_000;
  const list = [
    { id: "r1", at: now - 2 * 60e3, kind: "readback", what: "Send ada this prompt", outcome: "sent", via: "you" },
    { id: "r2", at: now - 6 * 60e3, kind: "readback", what: "Approve what looks safe for 10 minutes in every chat.", outcome: "expired", via: "VibeQuarters" },
    { id: "r3", at: now - 30e3, kind: "readback", what: "Send bo this prompt", outcome: "not sent: one message at a time", via: "you" },
    { id: "d1", at: now - 90 * 60e3, kind: "decision", what: "ada wants to run the tests", outcome: "approved", via: "approve window" },
    { id: "d2", at: now - 60e3, kind: "decision", what: "ada asks: Which color?", outcome: "answered in VS Code or gone", via: "outside VibeQuarters" },
    { id: "r4", at: now - 60e3, kind: "readback", what: "Open a new session with this prompt", outcome: "canceled", via: "Stop" },
  ];
  const lines = recentLines(list, now);
  assert.equal(lines.length, 5, "the newest 5");
  assert.deepEqual(lines.map((x) => [x.outcome, x.reason, x.what, x.ago, x.tone]), [
    ["Sent", "", "Send ada this prompt", "2 min ago", "good"],
    ["Expired", "", "Approve what looks safe for 10 minutes in every chat.", "6 min ago", "warn"],
    ["Not sent", "one message at a time", "Send bo this prompt", "just now", "bad"],
    ["Approved by the approve window", "", "ada wants to run the tests", "1 h ago", "good"],
    ["Answered in VS Code or gone", "", "ada asks: Which color?", "1 min ago", "quiet"],
  ]);
  const one = (e) => recentLines([e], now)[0];
  assert.equal(one({ ...list[0], kind: "decision", outcome: "approved", via: "you" }).outcome, "Approved by you");
  assert.equal(one({ ...list[0], kind: "decision", outcome: "denied", via: "assistant read-back" }).outcome, "Denied by your yes to the assistant");
  assert.equal(one(list[5]).outcome, "Canceled with Stop");
  assert.deepEqual([one({ ...list[0], outcome: "dropped: answered elsewhere", via: "VibeQuarters" }).outcome, one({ ...list[0], outcome: "dropped: answered elsewhere", via: "HQ" }).reason], ["Dropped", "answered elsewhere"]);
  assert.equal(one({ ...list[0], outcome: "canceled" }).tone, "quiet");
  assert.equal(new Set(lines.map((x) => x.key)).size, 5, "each line has its own key");
  assert.deepEqual(recentLines(null, now), []);
  assert.deepEqual(recentLines(undefined, now), []);
  assert.equal(since(now - 59e3, now), "just now");
  assert.equal(since(now - 125 * 60e3, now), "2 h ago");
});

test("Recent under Streamer: what each was and any reason are masked; the outcome's fixed words and the time stay", () => {
  const now = 1_800_000_000_000;
  const list = [
    { id: "r1", at: now - 2 * 60e3, kind: "readback", what: "Send ada this prompt", outcome: "not sent: this chat cannot hear VibeQuarters until it ends a reply", via: "you" },
    { id: "d1", at: now - 3 * 60e3, kind: "decision", what: "ada wants to run the tests", outcome: "approved", via: "you" },
  ];
  assert.deepEqual(recentLines(list, now, { streamer: true }).map((x) => [x.outcome, x.reason, x.what, x.ago]), [
    ["Not sent", null, null, "2 min ago"],
    ["Approved by you", "", null, "3 min ago"],
  ]);
  assert.ok(!JSON.stringify(recentLines(list, now, { streamer: true })).includes("ada"), "no session name anywhere in what is drawn");
});

test("Recent is the one place for what the assistant said or did on its own: its HQ lines join the settled history, newest 5 by time", () => {
  const now = 1_800_000_000_000;
  const settledList = [
    { id: "r1", at: now - 2 * 60e3, kind: "readback", what: "Send ada this prompt", outcome: "sent", via: "you" },
    { id: "d1", at: now - 9 * 60e3, kind: "decision", what: "ada wants to run the tests", outcome: "approved", via: "you" },
  ];
  const msgs = [
    { id: "o1", at: now - 8 * 60e3, role: "owner", text: "what's going on" },
    { id: "a1", at: now - 7 * 60e3, role: "assistant", text: "All quiet." },
    { id: "s1", at: now - 5 * 60e3, role: "system", text: "You have something to approve." },
    { id: "p1", at: now - 4 * 60e3, role: "sent", name: "ada", text: "run the tests" },
    { id: "s2", at: now - 30e3, role: "system", text: "Docs build is done. You can close its tab." },
  ];
  const lines = recentFeed(settledList, msgs, now);
  assert.deepEqual(lines.map((x) => [x.outcome, x.what, x.ago, x.tone]), [
    ["Said", "Docs build is done. You can close its tab.", "just now", "quiet"],
    ["Sent", "Send ada this prompt", "2 min ago", "good"],
    ["Said", "You have something to approve.", "5 min ago", "quiet"],
    ["Approved by you", "ada wants to run the tests", "9 min ago", "good"],
  ], "the owner's words, its replies and the prompts it sent stay in the conversation, never here");
  const many = Array.from({ length: 8 }, (_, i) => ({ id: "s" + i, at: now - i * 1000, role: "system", text: "line " + i }));
  assert.deepEqual(recentFeed(settledList, many, now).map((x) => x.what), ["line 0", "line 1", "line 2", "line 3", "line 4"], "the newest 5");
  assert.equal(new Set(recentFeed(settledList, msgs, now).map((x) => x.key)).size, 4, "each line has its own key");
  assert.deepEqual(recentFeed(null, null, now), []);
  assert.deepEqual(recentFeed([], msgs, now, { streamer: true }).map((x) => [x.outcome, x.what]), [["Said", null], ["Said", null]], "masked under Streamer");
});

test("the Dashboard conversation leaves out the HQ lines, which Recent shows; the glass panel, with no Recent, keeps them", () => {
  const src = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
  assert.match(src, /recentFeed\(history, msgs\(\), Date\.now\(\), \{ streamer: on \}\)/, "Recent reads both");
  assert.match(src, /m\.compact \? all : all\.filter\(\(x\) => x\.role !== "system"\)/, "the Dashboard log drops system lines");
});

test("every bubble shows its whole message, never three lines that open on a hover", () => {
  const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
  const bubble = /\.as:not\(\.as-c\) :is\(\.as-owner, \.as-assistant\) \{[^}]*\}/.exec(css);
  assert.ok(bubble, "the bubble rule");
  assert.doesNotMatch(bubble[0], /max-height|overflow: clip|transition/, "no cap and no opening");
  assert.doesNotMatch(css, /:is\(\.as-owner, \.as-assistant\):is\(:hover/, "nothing changes on a hover");
});

test("the conversation goes to its newest line whenever a line comes or changes, and when the owner sends", () => {
  const src = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
  assert.match(src, /if \(drawLog\(m, on\)\) m\.toEnd = true;/, "a changed conversation sends the scroll to its end");
  assert.match(src, /boxes\(""\);\r?\n\s*for \(const m of live\(\)\) m\.toEnd = true;/, "the owner's send does too");
});

test("a short line plays the moment the owner's words go, never the same one twice in a row", () => {
  assert.ok(FILLERS.length >= 4 && FILLERS.every((f) => f.length <= 40 && /^[\x20-\x7e]+$/.test(f)), "short plain lines, no dashes");
  let last = null;
  for (const r of [0, 0, 0.5, 0.99, 0.2, 0.2]) {
    const f = pickFiller(last, () => r);
    assert.ok(FILLERS.includes(f));
    assert.notEqual(f, last, "never twice in a row");
    last = f;
  }
});

// assistant.js builds DOM at mount, which needs a page, so where its parts sit is read as text: in the Dashboard the
// read-backs and Recent come before the conversation and never inside it, and Minimize hides the conversation alone
test("in the Dashboard module the read-backs and Recent sit above the conversation, outside its scroll, and stay when it is minimized", () => {
  const src = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
  const dash = /\[el\("div", \{ class: "nh" \}[^\n]*\]/.exec(src);
  assert.ok(dash, "the Dashboard's parts");
  const order = ["m.chip", "m.rbs", "m.recent", "m.log"].map((k) => dash[0].indexOf(k));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), "chip, read-backs, Recent, then the conversation: " + order);
  assert.match(src, /m\.scroll = compact \? el\("div", \{ class: "as-top" \}, m\.log, m\.chip, m\.rbs\) : m\.log;/, "the Dashboard's scroll is the conversation alone");
  const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
  assert.deepEqual(css.match(/\.as\.as-min [^{]*\{[^}]*\}/g), [".as.as-min .as-log { display: none; }"], "minimized hides the conversation only");
});

// panels.js mounts DOM too, so read as text: the Office Assistant panel's head word is the card title while a
// read-back waits, ahead of an open approve window, so a minimized panel still says a yes is waiting
test("the Office Assistant panel's head says Waiting for your yes while a read-back waits, before Approving", () => {
  const src = readFileSync(new URL("../public/floor/panels.js", import.meta.url), "utf8");
  assert.match(src, /word: P\.readbacks && P\.readbacks\.length \? RB_TITLE : P\.window && P\.window\.open \? 'Approving' : statusWord\(/);
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /readbacks: lastHq\.readbacks \|\| \[\]/, "the floor panels get the read-backs");
});

// Two pages' channels on one bus, as BroadcastChannel("hq-say") joins them: a message posted on one reaches every other
// channel on the bus, never the one that posted it.
function bus() {
  const all = [];
  const make = () => {
    const ch = { heard: [], posted: [], addEventListener: (type, fn) => { if (type === "message") ch.heard.push(fn); }, postMessage: (data) => { ch.posted.push(data); for (const o of all) if (o !== ch) for (const fn of o.heard) fn({ data }); } };
    all.push(ch);
    return ch;
  };
  return make;
}

test("claimSpeech plays an id once across pages: the first claim wins, the second page returns false", () => {
  const make = bus(), one = watchSpeech(make()), two = watchSpeech(make());
  assert.equal(claimSpeech("say-1", one), true);
  assert.equal(claimSpeech("say-1", two), false);
  assert.equal(claimSpeech("say-1", one), false); // and the same page never plays it twice
  assert.equal(claimSpeech("say-2", two), true); // a new id is free again
  assert.equal(claimSpeech("say-2", one), false);
  assert.deepEqual(one.posted, [{ claim: "say-1" }]); // a claim that lost posts nothing
});
