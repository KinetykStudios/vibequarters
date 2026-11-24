// public/voice.js's meter for voice mode. The open mic opens a level meter on the microphone, each reply plays through a
// second one, and closing the mic lets go of the microphone. The browser parts are stood in for: its recognition,
// getUserMedia and an AudioContext whose analysers read whatever loudness the test sets.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.document = { querySelector: () => ({ content: "ab".repeat(32) }) };
const tracks = [];
const media = { getUserMedia: async () => { const t = { stopped: false, stop() { this.stopped = true; } }; tracks.push(t); return { getTracks: () => [t] }; } };
Object.defineProperty(globalThis, "navigator", { value: { userActivation: { hasBeenActive: true }, mediaDevices: media }, configurable: true });
const recs = [];
globalThis.SpeechRecognition = class { constructor() { recs.push(this); } start() {} stop() { this.onend(); } abort() { this.onend(); } };
globalThis.BroadcastChannel = class { addEventListener() {} postMessage() {} }; // Node's own would keep the test running
// one loudness per analyser, set by the test: what its microphone or its voice line is playing right now
const loud = new Map();
const analyser = (who) => ({ fftSize: 0, connect() {}, getFloatTimeDomainData(d) { d.fill(loud.get(who) || 0); } });
const routed = [];
globalThis.AudioContext = class {
  constructor() { this.state = "running"; this.destination = {}; this.made = 0; }
  createAnalyser() { return analyser(this.made++ === 0 ? "mic" : "voice"); }
  createMediaStreamSource() { return { connect() {} }; }
  createMediaElementSource(audio) { routed.push(audio); return { connect() {} }; }
  resume() { return Promise.resolve(); }
};
globalThis.Audio = class { pause() {} play() { return new Promise(() => {}); } };
globalThis.URL.createObjectURL = () => "blob:x";
globalThis.URL.revokeObjectURL = () => {};
globalThis.fetch = async () => ({ ok: true, body: null, blob: async () => ({}) });
const tick = () => new Promise((r) => setTimeout(r, 0));

const voice = await import("../public/voice.js");

test("voice mode: with nothing open both levels read 0", () => {
  assert.deepEqual(voice.levels(), { you: 0, ai: 0 });
});

test("voice mode: Talk opens a meter on the mic that rises with the owner's voice, and closing the mic lets go of it", async () => {
  voice.toggleMic();
  await tick();
  assert.equal(tracks.length, 1, "the mic is open for the meter");
  loud.set("mic", 0.05);
  const quiet = voice.levels().you;
  loud.set("mic", 0.2);
  const talking = voice.levels().you;
  assert.ok(quiet > 0 && talking > quiet, `the level rises with the voice (${quiet} then ${talking})`);
  loud.set("mic", 5);
  assert.equal(voice.levels().you, 1, "a level never passes 1");
  voice.toggleMic();
  assert.equal(tracks[0].stopped, true, "closing the mic lets go of the microphone");
  assert.equal(voice.levels().you, 0);
});

test("voice mode: a reply plays through the meter, so the wave moves with the assistant's voice", async () => {
  voice.toggleMic();
  await tick();
  await voice.speak({ id: "m1", text: "The tests are done." });
  await tick();
  await tick();
  assert.equal(routed.length, 1, "the reply's audio goes through the meter");
  loud.set("voice", 0.2);
  assert.ok(voice.levels().ai > 0, "its level moves while it talks");
  voice.toggleMic();
});
