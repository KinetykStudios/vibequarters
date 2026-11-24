// public/voice.js on the open mic, turn-taking. Phrases join into one message that goes once the speaker has been quiet
// for a moment, longer after a word that leaves the sentence hanging; the mic stays open while it speaks, and a voice
// over it stops it at once, while its own words coming back through the speakers do not. The clock is the test's (mock
// timers); the browser parts are stood in for.
import test, { mock } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.document = { querySelector: () => ({ content: "ab".repeat(32) }) };
Object.defineProperty(globalThis, "navigator", { value: { userActivation: { hasBeenActive: true } }, configurable: true });
const recs = [];
globalThis.SpeechRecognition = class { constructor() { recs.push(this); } start() {} stop() { this.ended = "stop"; this.onend(); } abort() { this.ended = "abort"; this.onend(); } };
globalThis.BroadcastChannel = class { addEventListener() {} postMessage() {} };
globalThis.Audio = class { pause() {} play() { return new Promise(() => {}); } };
const calls = [];
globalThis.fetch = (url, opts) => new Promise((ok, fail) => {
  calls.push({ url, opts, ok });
  opts.signal.addEventListener("abort", () => fail(new Error("aborted")));
});
const res = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });
const flush = () => new Promise((r) => setImmediate(r));
mock.timers.enable({ apis: ["setTimeout"] });

const voice = await import("../public/voice.js");
const got = [];
voice.setVoiceHooks({ final: (t, at, how) => got.push([t, !!(how && how.cut)]) });

test("open mic: phrases with a short pause between them go as one message, once the owner has been quiet for 1.6 s", () => {
  got.length = 0;
  voice.toggleMic();
  const r = recs.at(-1);
  r.onresult({ results: [res("please open the docs page", true)] });
  mock.timers.tick(1000);
  r.onresult({ results: [res("please open the docs page", true), res("and then read", false)] });
  r.onresult({ results: [res("please open the docs page", true), res("and then read me the first part", true)] });
  mock.timers.tick(1500);
  assert.deepEqual(got, [], "still inside the owner's pause: nothing goes yet");
  mock.timers.tick(100);
  assert.deepEqual(got, [["please open the docs page and then read me the first part", false]], "one message, in the owner's order");
  voice.toggleMic();
});

test("open mic: a phrase that ends on a hanging word waits longer before it goes", () => {
  got.length = 0;
  voice.toggleMic();
  recs.at(-1).onresult({ results: [res("show me the", true)] });
  mock.timers.tick(1700);
  assert.deepEqual(got, [], "a sentence left hanging is not done");
  mock.timers.tick(800);
  assert.deepEqual(got, [["show me the", false]]);
  voice.toggleMic();
});

// Local hearing's words come back seconds after the speaker stopped (hear.js says when: to). The quiet counts from then,
// not from when the words came back, or the read's time is added to the wait
const heard = (text, msAgo) => Object.assign(res(text, true), { from: Date.now() - msAgo - 1000, to: Date.now() - msAgo });

test("open mic: words that come back after the owner has been quiet long enough go at once", () => {
  got.length = 0;
  voice.toggleMic();
  recs.at(-1).onresult({ results: [heard("what is ada doing", 3000)] });
  mock.timers.tick(1);
  assert.deepEqual(got, [["what is ada doing", false]]);
  voice.toggleMic();
});

test("open mic: words that come back sooner wait only for the rest of the owner's quiet", () => {
  got.length = 0;
  voice.toggleMic();
  recs.at(-1).onresult({ results: [heard("what is ada doing", 1000)] });
  mock.timers.tick(500);
  assert.deepEqual(got, [], "the owner has been quiet for about 1.5 s");
  mock.timers.tick(100);
  assert.deepEqual(got, [["what is ada doing", false]]);
  voice.toggleMic();
});

test("open mic: a sentence left hanging still gets its longer quiet, counted from when the owner stopped", () => {
  got.length = 0;
  voice.toggleMic();
  recs.at(-1).onresult({ results: [heard("show me the", 1000)] });
  mock.timers.tick(1400);
  assert.deepEqual(got, [], "1.6 s is not enough after a hanging word");
  mock.timers.tick(100);
  assert.deepEqual(got, [["show me the", false]]);
  voice.toggleMic();
});

test("open mic: words that come back while the owner is talking again wait for the rest", () => {
  got.length = 0;
  voice.toggleMic();
  const r = recs.at(-1);
  const first = heard("what is ada doing", 3000);
  const dots = Object.assign(res(" …", false), { from: Date.now(), to: Date.now() });
  r.onresult({ results: [first, dots] });
  for (let i = 0; i < 20; i++) mock.timers.tick(500);
  assert.deepEqual(got, [], "the owner is still talking");
  r.onresult({ results: [first, heard("and bo", 1000)] });
  mock.timers.tick(500);
  assert.deepEqual(got, [], "the quiet counts from the owner's last words now");
  mock.timers.tick(100);
  assert.deepEqual(got, [["what is ada doing and bo", false]], "one message");
  voice.toggleMic();
});

test("open mic: closing the mic sends what the owner said so far at once", () => {
  got.length = 0;
  voice.toggleMic();
  const r = recs.at(-1);
  r.onresult({ results: [res("what is ada doing", true)] });
  r.onresult({ results: [res("what is ada doing", true), res("and bo", false)] });
  voice.toggleMic();
  assert.equal(r.ended, "stop");
  assert.deepEqual(got, [["what is ada doing and bo", false]]);
});

test("open mic: the mic stays open while it speaks; its own words coming back do not stop it, and the owner's voice over it does at once", async () => {
  got.length = 0;
  voice.toggleMic();
  const r = recs.at(-1);
  const n = calls.length;
  await voice.speak({ id: "t1", text: "Good news: the docs build wants to run its checks." });
  await flush();
  assert.equal(calls.length, n + 1, "the reply plays");
  assert.equal(r.ended, undefined, "with the mic still listening");
  const line = calls.at(-1);
  r.onresult({ results: [res("good news the docs build", false)] });
  assert.equal(line.opts.signal.aborted, false, "its own voice through the speakers is not the owner");
  r.onresult({ results: [res("good news the docs build", true), res("wait hold on", false)] });
  assert.equal(line.opts.signal.aborted, true, "the owner talked over it: it stopped at once");
  r.onresult({ results: [res("good news the docs build", true), res("wait hold on", true)] });
  mock.timers.tick(1600);
  assert.deepEqual(got, [["wait hold on", true]], "the owner's words go, marked as cutting it off, and its echo never does");
  voice.toggleMic();
});

test("open mic: a line waiting behind the owner's words stays when a word reads as echo, and goes when a final comes to nothing", async () => {
  voice.toggleMic();
  const r = recs.at(-1);
  await voice.speak({ id: "turns-flicker-1", text: "What is next" });
  await flush();
  calls.at(-1).ok({ ok: false, status: 500, text: async () => "" }); // over at once, and recent
  await flush();
  r.onresult({ results: [res("hang", false)] }); // the owner's first word, not in the line
  await voice.speak({ id: "turns-flicker-2", text: "Ada is done" });
  await flush();
  const before = calls.length;
  r.onresult({ results: [res("what is", false)] }); // the recognizer revises it to words that read as echo
  await flush();
  assert.equal(calls.length, before, "the owner is mid-sentence, so it waits");
  r.onresult({ results: [res("what is", true)] }); // and that was all: nothing of the owner's to wait for
  await flush();
  assert.equal(calls.length, before + 1, "the line goes");
  voice.hush();
  voice.toggleMic();
  await flush();
});

test("open mic: a lone yes is the owner once the line asking for it has been over a moment; its echo still is not", async () => {
  got.length = 0;
  voice.toggleMic();
  const r = recs.at(-1);
  await voice.speak({ id: "t2", text: "It waits for your yes in HQ." });
  await flush();
  let t = Date.now();
  const clock = mock.method(Date, "now", () => t);
  const heard = [];
  const hear = (...said) => { heard.push(...said); r.onresult({ results: heard.map((s) => res(s, true)) }); };
  hear("yes");
  assert.equal(calls.at(-1).opts.signal.aborted, false, "while the line plays, its own yes is not the owner");
  voice.hush();
  t += 300;
  hear("yes");
  t += 700;
  hear("your yes in hq", "yes");
  mock.timers.tick(1600);
  assert.deepEqual(got, [["yes", false]], "only the yes said a second after the line ended goes");
  clock.mock.restore();
  voice.toggleMic();
});
