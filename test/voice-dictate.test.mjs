// public/voice.js dictate: the chat window's Talk. Words go into the box as they are said; nothing is sent; a pause the
// browser ends on starts it again with the words kept; a second press stops it. The browser parts are stood in for.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.document = { querySelector: () => ({ content: "ab".repeat(32) }) };
Object.defineProperty(globalThis, "navigator", { value: { userActivation: { hasBeenActive: true } }, configurable: true });
const recs = [];
globalThis.SpeechRecognition = class { constructor() { recs.push(this); } start() {} stop() { this.ended = "stop"; this.onend(); } abort() { this.ended = "abort"; this.onend(); } };
globalThis.BroadcastChannel = class { addEventListener() {} postMessage() {} };
globalThis.Audio = class { pause() {} play() { return new Promise(() => {}); } };
globalThis.fetch = () => new Promise(() => {});
const res = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });

const voice = await import("../public/voice.js");
const sent = [];
voice.setVoiceHooks({ final: (t) => sent.push(t) });

test("dictate: words go into the box as they are said, a pause keeps them, a second press stops it, and nothing is sent", () => {
  const box = [], ends = [];
  assert.equal(voice.dictate((t) => box.push(t), (why) => ends.push(why)), "started");
  assert.equal(voice.dictating(), true);
  let r = recs.at(-1);
  r.onresult({ results: [res("tell ada", false)] });
  r.onresult({ results: [res("tell ada to run", true), res(" the tests", false)] });
  assert.equal(box.at(-1), "tell ada to run the tests");
  const before = recs.length;
  r.onend(); // the browser ends a recognition on a long pause
  assert.equal(recs.length, before + 1, "it listens again by itself");
  r = recs.at(-1);
  r.onresult({ results: [res("and push", false)] });
  assert.equal(box.at(-1), "tell ada to run the tests and push", "the words before the pause stay");
  assert.equal(voice.dictate(() => {}, () => {}), "stopped");
  assert.equal(r.ended, "stop");
  assert.deepEqual(ends, [null], "ended once, with no error");
  assert.equal(voice.dictating(), false);
  assert.equal(recs.length, before + 1, "stopped: nothing starts again");
  assert.deepEqual(sent, [], "dictation never sends to the assistant");
});

test("dictate closes the assistant's open mic first, so one recognition runs at a time; its words still go to the assistant", () => {
  voice.toggleMic();
  const mic = recs.at(-1);
  mic.onresult({ results: [res("what is bo doing", true)] });
  assert.equal(voice.dictate(() => {}, () => {}), "started");
  assert.equal(mic.ended, "stop");
  assert.deepEqual(sent.splice(0), ["what is bo doing"], "what the owner said to the assistant before goes to it");
  assert.notEqual(recs.at(-1), mic, "the dictation's own recognition");
  voice.dictate(() => {}, () => {});
});

test("dictate: a blocked microphone ends it with the reason", () => {
  const ends = [];
  voice.dictate(() => {}, (why) => ends.push(why));
  const r = recs.at(-1);
  r.onerror({ error: "not-allowed" });
  r.onend();
  assert.deepEqual(ends, ["The microphone is blocked. Allow it from the address bar"]);
  assert.equal(voice.dictating(), false);
});
