// public/hear.js: the page's side of hearing where the browser's own recognition never fires. It has the face of the
// browser's SpeechRecognition, so voice.js runs the same in both, and whisper.cpp on this computer is behind it. The mic,
// the sound system and the server are stood in for.
import test, { mock } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.document = { querySelector: () => ({ content: "ab".repeat(32) }) };
let node = null, tracksStopped = 0, micFails = null;
Object.defineProperty(globalThis, "navigator", {
  value: {
    mediaDevices: {
      getUserMedia: async () => {
        if (micFails) throw micFails;
        return { getTracks: () => [{ stop: () => tracksStopped++ }] };
      },
    },
  },
  configurable: true,
});
globalThis.AudioContext = class {
  constructor(o) { this.rate = o.sampleRate; globalThis.lastRate = o.sampleRate; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { node = { connect() {}, disconnect() {} }; return node; }
  get destination() { return {}; }
};
// each request waits for the test to answer it
const asked = [];
globalThis.fetch = (url, opts) => new Promise((ok) => asked.push({ url, opts, answer: (text, status = 200) => ok({ ok: status === 200, status, json: async () => ({ text }) }) }));

const { LocalRecognition, wavOf, phrases, RATE, BLOCK } = await import("../public/hear.js");
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const loud = () => new Float32Array(BLOCK).fill(0.2);
const quiet = () => new Float32Array(BLOCK).fill(0.0005);
const feed = (b) => node.onaudioprocess({ inputBuffer: { getChannelData: () => b } });
const talk = (n = 4) => { for (let i = 0; i < n; i++) feed(loud()); };
const hush = (n = 6) => { for (let i = 0; i < n; i++) feed(quiet()); };

async function open() {
  asked.length = 0;
  const r = new LocalRecognition();
  r.seen = [];
  r.ends = 0;
  r.errors = [];
  r.onresult = (e) => r.seen.push(Array.from(e.results).map((x) => [x[0].transcript, x.isFinal]));
  r.onend = () => r.ends++;
  r.onerror = (e) => r.errors.push(e.error);
  r.start();
  await flush();
  return r;
}

test("wavOf: a 16 kHz mono 16-bit WAV of the samples", () => {
  const w = Buffer.from(wavOf([new Float32Array([0, 1]), new Float32Array([-1])]));
  assert.equal(w.toString("latin1", 0, 4), "RIFF");
  assert.equal(w.toString("latin1", 8, 12), "WAVE");
  assert.equal(w.readUInt32LE(4), 36 + 6, "the RIFF size");
  assert.equal(w.readUInt16LE(20), 1, "plain PCM");
  assert.equal(w.readUInt16LE(22), 1, "one channel");
  assert.equal(w.readUInt32LE(24), RATE);
  assert.equal(w.readUInt16LE(34), 16, "16 bits");
  assert.equal(w.readUInt32LE(40), 6, "the data size");
  assert.deepEqual([w.readInt16LE(44), w.readInt16LE(46), w.readInt16LE(48)], [0, 32767, -32767]);
});

test("phrases: a phrase starts on sustained sound, keeps the lead-in, ends on quiet, and a click is nothing", () => {
  const ev = [];
  const cut = phrases({ start: () => ev.push("start"), more: () => {}, end: (b) => ev.push(["end", b.length]) });
  cut.feed(quiet()); cut.feed(loud()); cut.feed(quiet()); cut.feed(quiet());
  assert.deepEqual(ev, [], "a lone click starts nothing");
  cut.feed(loud()); cut.feed(loud());
  assert.deepEqual(ev, ["start"]);
  for (let i = 0; i < 5; i++) cut.feed(quiet());
  assert.equal(ev.length, 2, "quiet ended it");
  assert.equal(ev[1][0], "end");
  assert.ok(ev[1][1] >= 7, "the lead-in, the owner's words and the quiet are all in it");
});

test("phrases: a long phrase is cut so a run never gets too much at once, and flush ends what is under way", () => {
  const ev = [];
  const cut = phrases({ start: () => ev.push("start"), more: () => {}, end: (b) => ev.push(b.length) });
  for (let i = 0; i < 300; i++) cut.feed(loud());
  assert.ok(ev.filter((x) => typeof x === "number").length >= 1, "cut at least once");
  const sizes = ev.filter((x) => typeof x === "number");
  assert.ok(Math.max(...sizes) * BLOCK * 2 + 44 <= 1024 * 1024, "every piece fits the server's limit");
  cut.flush();
  const after = ev.filter((x) => typeof x === "number").length;
  cut.flush();
  assert.equal(ev.filter((x) => typeof x === "number").length, after, "a second flush has nothing to end");
});

test("LocalRecognition: 16 kHz from the mic; shows it is hearing the owner at once, then the final words, in the browser's shape", async () => {
  const r = await open();
  assert.equal(globalThis.lastRate, RATE);
  talk();
  assert.deepEqual(r.seen.at(-1), [[" …", false]], "the owner is talking, words on the way");
  hush();
  await flush();
  const final = asked.at(-1);
  assert.equal(final.url, "/api/hear");
  assert.equal(final.opts.method, "POST");
  assert.equal(final.opts.headers["Content-Type"], "audio/wav");
  assert.equal(final.opts.headers["X-HQ-Token"], "ab".repeat(32));
  final.answer("what is ada doing");
  await flush();
  assert.deepEqual(r.seen.at(-1), [[" what is ada doing", true]]);
  r.stop();
  await flush();
  assert.equal(r.ends, 1);
});

test("LocalRecognition: words come while the owner is still talking, and the final replaces them", async () => {
  const r = await open();
  talk(12); // over a second of speech: an interim goes
  await flush();
  assert.equal(asked.length, 1, "one interim at a time");
  talk(12);
  assert.equal(asked.length, 1, "still one while it runs");
  asked[0].answer("what is");
  await flush();
  assert.deepEqual(r.seen.at(-1), [[" what is", false]]);
  hush();
  await flush();
  asked.at(-1).answer("what is ada doing");
  await flush();
  assert.deepEqual(r.seen.at(-1), [[" what is ada doing", true]]);
  r.stop();
  await flush();
});

test("LocalRecognition: an interim that comes back after the phrase ended changes nothing", async () => {
  const r = await open();
  talk(12);
  await flush();
  const interim = asked[0];
  hush();
  await flush();
  const final = asked.at(-1);
  assert.notEqual(final, interim);
  final.answer("the whole thing");
  await flush();
  interim.answer("the who");
  await flush();
  assert.deepEqual(r.seen.at(-1), [[" the whole thing", true]]);
  r.stop();
  await flush();
});

// The read of the whole phrase must not sit behind a read of its first second
test("LocalRecognition: when a phrase ends, the interim read still out is taken back, so the whole phrase is read next", async () => {
  const r = await open();
  talk(12);
  await flush();
  const interim = asked[0];
  assert.equal(interim.opts.signal.aborted, false, "while the owner talks it may finish");
  hush();
  assert.equal(interim.opts.signal.aborted, true, "the phrase ended: nobody needs it now");
  await flush();
  const final = asked.at(-1);
  assert.notEqual(final, interim);
  assert.notEqual(final.opts.signal && final.opts.signal.aborted, true, "the read that matters is never taken back");
  final.answer("the whole thing");
  await flush();
  assert.deepEqual(r.seen.at(-1), [[" the whole thing", true]]);
  r.stop();
  await flush();
});

test("LocalRecognition: a taken-back read frees the next phrase's interim read at once, even before it fails", async () => {
  const r = await open();
  talk(12);
  await flush();
  hush();
  await flush();
  asked.at(-1).answer("first part");
  await flush();
  const before = asked.length;
  talk(12); // the next phrase, while the taken-back read has still not answered
  await flush();
  assert.equal(asked.length, before + 1, "its own interim goes");
  r.stop();
  await flush();
});

test("LocalRecognition: two phrases keep their order even when the second starts before the first is back", async () => {
  const r = await open();
  talk(); hush();
  await flush();
  talk(); hush();
  await flush();
  const finals = asked.slice();
  assert.equal(finals.length, 1, "the second waits for the first");
  finals[0].answer("first part");
  await flush();
  asked.at(-1).answer("second part");
  await flush();
  assert.deepEqual(r.seen.at(-1), [[" first part", true], [" second part", true]]);
  r.stop();
  await flush();
});

test("LocalRecognition: stop sends what the owner was saying, gives the words, and only then ends; the mic is let go", async () => {
  const before = tracksStopped;
  const r = await open();
  talk();
  r.stop();
  assert.equal(tracksStopped, before + 1, "the mic is off at once");
  assert.equal(r.ends, 0, "the words are still to come");
  await flush();
  asked.at(-1).answer("last words");
  await flush();
  assert.deepEqual(r.seen.at(-1), [[" last words", true]]);
  assert.equal(r.ends, 1);
  r.stop();
  await flush();
  assert.equal(r.ends, 1, "ends once");
});

test("LocalRecognition: nothing heard ends quietly, and silence never goes to whisper", async () => {
  const r = await open();
  hush(20);
  r.stop();
  await flush();
  assert.equal(asked.length, 0);
  assert.equal(r.ends, 1);
  assert.deepEqual(r.errors, []);
});

test("LocalRecognition: a blocked mic reports as the browser's own does, then ends", async () => {
  micFails = Object.assign(new Error("no"), { name: "NotAllowedError" });
  const r = await open();
  micFails = null;
  assert.deepEqual(r.errors, ["not-allowed"]);
  assert.equal(r.ends, 1);
});

test("LocalRecognition: no microphone reports audio-capture", async () => {
  micFails = Object.assign(new Error("no"), { name: "NotFoundError" });
  const r = await open();
  micFails = null;
  assert.deepEqual(r.errors, ["audio-capture"]);
  assert.equal(r.ends, 1);
});

test("LocalRecognition: whisper not installed says so, clears what it was showing, and ends", async () => {
  const before = tracksStopped;
  const r = await open();
  talk(); hush();
  await flush();
  asked.at(-1).answer("", 503);
  await flush();
  assert.deepEqual(r.errors, ["hear-off"]);
  assert.deepEqual(r.seen.at(-1), [["", true]], "no dots left behind");
  assert.equal(r.ends, 1);
  assert.equal(tracksStopped, before + 1, "the mic is let go");
});

test("LocalRecognition: a failed run reports hear-failed", async () => {
  const r = await open();
  talk(); hush();
  await flush();
  asked.at(-1).answer("", 502);
  await flush();
  assert.deepEqual(r.errors, ["hear-failed"]);
  assert.equal(r.ends, 1);
});

test("LocalRecognition: a read that comes back after a failure ended it shows nothing more", async () => {
  const r = await open();
  talk(); hush();
  await flush();
  talk(12); // the next phrase, its interim read out
  await flush();
  assert.equal(asked.length, 2);
  asked[0].answer("", 502);
  await flush();
  assert.equal(r.ends, 1);
  const shown = r.seen.length;
  asked[1].answer("late words");
  await flush();
  assert.equal(r.seen.length, shown, "it has ended");
});

test("LocalRecognition: a phrase carries when it started and when its sound stopped, however long the read takes", async () => {
  let now = 5000;
  const clock = mock.method(Date, "now", () => now);
  const r = await open();
  talk(2);
  now = 5500;
  talk(3);
  now = 6200;
  hush();
  await flush();
  now = 9000;
  asked.at(-1).answer("some words");
  await flush();
  const said = r.results[0];
  assert.equal(said.isFinal, true);
  assert.deepEqual([said.from, said.to], [5000, 5500]);
  clock.mock.restore();
  r.stop();
  await flush();
});

test("LocalRecognition: stopped before the mic opened, the mic is let go and it ends", async () => {
  const before = tracksStopped;
  asked.length = 0;
  const r = new LocalRecognition();
  r.ends = 0;
  r.onresult = () => {};
  r.onerror = () => {};
  r.onend = () => r.ends++;
  r.start();
  r.stop();
  await flush();
  assert.equal(tracksStopped, before + 1);
  assert.equal(r.ends, 1);
});
