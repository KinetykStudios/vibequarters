// public/voice.js in Node with the browser parts stood in for: a line that arrives while the mic listens waits until
// the owner lets go, starting to talk tells every other HQ page to stop speaking, and Streamer mode keeps the voice
// quiet, since the voice says the names the screen masks.
import test from "node:test";
import assert from "node:assert/strict";

// The page: a token meta, user activation, no Web Locks, one recognition at a time, and a BroadcastChannel bus where a
// message reaches every other channel with the same name
globalThis.window = globalThis;
globalThis.document = { querySelector: () => ({ content: "ab".repeat(32) }) };
Object.defineProperty(globalThis, "navigator", { value: { userActivation: { hasBeenActive: true } }, configurable: true });
const recs = [];
globalThis.SpeechRecognition = class { constructor() { recs.push(this); } start() {} stop() { this.ended = "stop"; this.onend(); } abort() { this.ended = "abort"; this.onend(); } };
// one recognition result, as the browser gives it: its words, and whether the phrase is finished
const res = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });
const chans = [];
globalThis.BroadcastChannel = class {
  constructor(name) { this.name = name; this.fns = []; this.posted = []; chans.push(this); }
  addEventListener(type, fn) { if (type === "message") this.fns.push(fn); }
  postMessage(data) { this.posted.push(data); for (const c of chans) if (c !== this && c.name === this.name) for (const fn of c.fns) fn({ data }); }
};
globalThis.Audio = class { pause() {} play() { return new Promise(() => {}); } };
// /api/tts: each call is kept with its signal and answers only when the test says so (a line "playing" until then)
const calls = [];
globalThis.fetch = (url, opts) => new Promise((ok, fail) => {
  calls.push({ url, opts, ok });
  opts.signal.addEventListener("abort", () => fail(new Error("aborted")));
});
const tick = () => new Promise((r) => setTimeout(r, 0));

const voice = await import("../public/voice.js");
const { setStreaming } = await import("../public/streamer.js");
const page = chans[0]; // voice.js's own channel
const other = new BroadcastChannel("hq-say"); // another HQ page

test("a line that comes while the mic listens waits until the owner lets go, then plays", async () => {
  voice.toggleMic();
  recs.at(-1).onresult({ results: [res("what is ada", false)] }); // the owner is talking
  await voice.speak({ id: "w1", text: "ada finished its reply." });
  await tick();
  assert.equal(calls.length, 0, "nothing plays over the owner");
  voice.toggleMic(); // let go
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].opts.body).text, "ada finished its reply.");
  voice.stopSpeaking();
});

test("starting to talk tells the other pages to stop, and a stop from another page ends this page's line", async () => {
  voice.toggleMic();
  assert.deepEqual(page.posted.at(-1), { stop: true });
  voice.toggleMic();
  await voice.speak({ id: "w2", text: "bo is idle." });
  await tick();
  const line = calls.at(-1);
  assert.equal(line.opts.signal.aborted, false);
  other.postMessage({ stop: true });
  assert.equal(line.opts.signal.aborted, true, "the other page's talking stopped this line");
});

test("open mic: one press opens it, the owner's phrases join into one message, a pause the browser ends on opens it again, and a press closes it", async () => {
  const got = [], mics = [];
  voice.setVoiceHooks({ final: (t, at) => got.push([t, typeof at]), mic: (on, via) => mics.push([on, via]) });
  voice.toggleMic();
  assert.deepEqual(mics.at(-1), [true, "open"]);
  let r = recs.at(-1);
  r.onresult({ results: [res("what is", false)] });
  r.onresult({ results: [res("what is ada doing", true)] });
  r.onresult({ results: [res("what is ada doing", true), res("and bo", false)] });
  r.onresult({ results: [res("what is ada doing", true), res("and bo", true)] });
  assert.deepEqual(got, [], "a finished phrase waits for the rest of the owner's turn");
  const before = recs.length;
  r.onend(); // the browser ends a recognition on a long pause
  assert.equal(recs.length, before + 1, "a new recognition: the mic is still open");
  assert.deepEqual(mics.at(-1), [true, "open"], "never shown closed in between");
  r = recs.at(-1);
  r.onresult({ results: [res("thanks", false)] });
  voice.toggleMic();
  assert.equal(r.ended, "stop");
  assert.deepEqual(got, [["what is ada doing and bo thanks", "number"]], "closing sends the owner's whole turn, once, in order");
  assert.deepEqual(mics.at(-1), [false, "open"]);
  assert.equal(recs.length, before + 1, "closed: nothing starts again");
  voice.setVoiceHooks({ final() {}, mic() {} });
});

test("open mic: a reply waits while a phrase is being said or its words are not sent yet, then plays with the mic still listening", async () => {
  const got = [];
  voice.setVoiceHooks({ final: (t) => got.push(t) });
  voice.toggleMic();
  let r = recs.at(-1);
  r.onresult({ results: [res("tell me", false)] });
  const n = calls.length;
  await voice.speak({ id: "o1", text: "Ada is running its tests." });
  await tick();
  assert.equal(calls.length, n, "the owner is mid-phrase: the reply waits");
  r.onresult({ results: [res("tell me about ada", true)] });
  await tick();
  assert.equal(calls.length, n, "the owner's words are not sent yet: the reply still waits");
  voice.toggleMic(); // closing sends them
  await tick();
  assert.deepEqual(got, ["tell me about ada"]);
  assert.equal(calls.length, n + 1, "and the reply plays");
  voice.toggleMic();
  r = recs.at(-1);
  await voice.speak({ id: "o2", text: "Ed is idle." });
  await tick();
  assert.equal(calls.length, n + 2, "a reply while the owner is quiet plays at once");
  assert.equal(r.ended, undefined, "with the mic still listening, so the owner can talk over it");
  voice.toggleMic();
  voice.stopSpeaking();
  voice.setVoiceHooks({ final() {} });
});

// The panel's Stop quieted only its own page, so another HQ tab kept speaking
test("hush stops this page's line and tells every other page to stop", async () => {
  await voice.speak({ id: "h1", text: "ada finished its reply." });
  await tick();
  const line = calls.at(-1);
  voice.hush();
  assert.equal(line.opts.signal.aborted, true);
  assert.deepEqual(page.posted.at(-1), { stop: true });
});

test("with Streamer on nothing is spoken, and turning it on stops the line playing", async () => {
  await voice.speak({ id: "w3", text: "Approve for ada: run the tests." });
  await tick();
  const line = calls.at(-1);
  setStreaming(true);
  assert.equal(line.opts.signal.aborted, true);
  const before = calls.length;
  await voice.speak({ id: "w4", text: "ada finished its reply." });
  await tick();
  assert.equal(calls.length, before, "nothing fetched while Streamer is on");
  setStreaming(false);
});
