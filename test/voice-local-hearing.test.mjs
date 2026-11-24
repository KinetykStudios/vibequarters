// public/voice.js in a browser whose speech recognition takes start() and then never fires a single event (no start, no
// audio, no result, no error). There Talk hears through whisper.cpp on this computer instead (public/hear.js), and
// everything after the words works as it does with the browser's own recognition.
import test, { mock } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.document = { querySelector: () => ({ content: "ab".repeat(32) }) };
Object.defineProperty(globalThis, "navigator", {
  value: {
    userActivation: { hasBeenActive: true },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36 OPR/100.0.0.0",
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  },
  configurable: true,
});
const browserRecs = [];
globalThis.SpeechRecognition = class { constructor() { browserRecs.push(this); } start() {} stop() {} abort() {} };
globalThis.BroadcastChannel = class { addEventListener() {} postMessage() {} };
let node = null;
globalThis.AudioContext = class {
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 0, connect() {}, getFloatTimeDomainData() {} }; }
  createScriptProcessor() { node = { connect() {}, disconnect() {} }; return node; }
  get destination() { return {}; }
};
const played = [];
globalThis.Audio = class { constructor() { played.push(this); } pause() { this.paused = true; } play() { return new Promise(() => {}); } };
URL.createObjectURL = () => "blob:line";
URL.revokeObjectURL = () => {};
const heard = [], spoken = [];
globalThis.fetch = (url, opts) => new Promise((ok, fail) => {
  if (url === "/api/hear") return heard.push((text) => ok({ ok: true, status: 200, json: async () => ({ text }) }));
  spoken.push({ url, ok });
  if (opts.signal) opts.signal.addEventListener("abort", () => fail(new Error("aborted")));
});

const listeners = {};
globalThis.addEventListener = (type, f) => { listeners[type] = f; };

const { spokenAnswer } = await import("../public/assistant-rules.js");
const { BLOCK } = await import("../public/hear.js");
const voice = await import("../public/voice.js");
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const feed = (level, n) => { for (let i = 0; i < n; i++) node.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(BLOCK).fill(level) } }); };
const got = [], ats = [], notes = [], mics = [], interim = [];
voice.setVoiceHooks({ final: (t, at) => { got.push(t); ats.push(at); }, note: (t) => notes.push(t), mic: (on, via) => mics.push([on, via]), interim: (t) => interim.push(t) });
mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });

test("local hearing: Talk opens the mic through whisper.cpp, never the browser's recognition, and the owner's words go to the assistant", async () => {
  assert.equal(voice.canListen(), true, "Talk is offered");
  voice.toggleMic();
  await flush();
  assert.equal(browserRecs.length, 0, "the browser's deaf recognition is never used");
  assert.deepEqual(mics.at(-1), [true, "open"]);
  assert.deepEqual(notes, []);
  feed(0.2, 4);
  feed(0.0005, 6);
  await flush();
  heard.shift()("what is ada doing");
  await flush();
  assert.deepEqual(got, [], "still inside the owner's pause");
  mock.timers.tick(1600);
  assert.deepEqual(got, ["what is ada doing"]);
  assert.deepEqual(interim, [], "the open mic types none of the words into the box as they are said");
  voice.toggleMic();
  await flush();
  assert.deepEqual(mics.at(-1), [false, "open"]);
});

test("local hearing: while whisper works on what was just said, a pause does not cut the sentence in two", async () => {
  got.length = 0;
  voice.toggleMic();
  await flush();
  feed(0.2, 4);
  feed(0.0005, 6);
  await flush();
  heard.shift()("open the page");
  await flush();
  mock.timers.tick(1000);
  feed(0.2, 4); // the owner goes on; no words back yet
  await flush();
  mock.timers.tick(5000);
  assert.deepEqual(got, [], "the dots hold the turn open");
  feed(0.0005, 6);
  await flush();
  heard.shift()("after the cart");
  await flush();
  mock.timers.tick(1600);
  assert.deepEqual(got, ["open the page after the cart"]);
  voice.toggleMic();
  await flush();
});

test("local hearing: sound from the speakers does not stop a reply until there are words, and its own words never do", async () => {
  got.length = 0;
  voice.toggleMic();
  await flush();
  await voice.speak({ id: "local-1", text: "The docs build is done." });
  await flush();
  const line = played.at(-1);
  feed(0.2, 4); // the reply coming through the speakers, no words yet
  await flush();
  assert.notEqual(line.paused, true, "sound alone does not cut the reply");
  feed(0.0005, 6);
  await flush();
  heard.shift()("the docs build is done");
  await flush();
  assert.notEqual(line.paused, true, "its own words are not the owner");
  feed(0.2, 4); // now the owner
  feed(0.0005, 6);
  await flush();
  heard.shift()("stop and show me the board");
  await flush();
  assert.equal(line.paused, true, "the owner's words stop it");
  mock.timers.tick(1600);
  assert.deepEqual(got, ["stop and show me the board"]);
  voice.toggleMic();
  await flush();
});

// A read takes seconds, and "is this its own voice?" asks how long ago the line ended. Timed from when the read came
// back, the reply's own words would go to the assistant as the owner's.
test("local hearing: the reply's own words are echo however long whisper takes over them, and the same words said later are the owner", async () => {
  voice.hush();
  got.length = 0;
  voice.toggleMic();
  await flush();
  await voice.speak({ id: "local-echo", text: "The docs build is done." });
  await flush();
  spoken.at(-1).ok({ ok: true, body: null, blob: async () => new Blob([]) });
  await flush();
  const line = played.at(-1);
  feed(0.2, 4); // the reply through the speakers
  await flush();
  line.onended();
  await flush();
  feed(0.0005, 6);
  await flush();
  mock.timers.tick(5000); // a slow read
  heard.shift()("the docs build is done");
  await flush();
  mock.timers.tick(1600);
  assert.deepEqual(got, [], "its own voice, read late");
  mock.timers.tick(3000);
  feed(0.2, 4); // long after the line, so this is the owner
  feed(0.0005, 6);
  await flush();
  mock.timers.tick(5000);
  heard.shift()("the docs build is done");
  await flush();
  mock.timers.tick(1600);
  assert.deepEqual(got, ["the docs build is done"]);
  voice.toggleMic();
  await flush();
});

// The safety rule: a yes never answers a card that came after the speech began, so it is never timed from when the read
// came back.
test("local hearing: a yes counts from when the owner said it, so it never answers a card that came after", async () => {
  voice.hush();
  got.length = 0;
  voice.toggleMic();
  await flush();
  mock.timers.tick(1000);
  feed(0.2, 4); // a cough, its read still out
  feed(0.0005, 6);
  await flush();
  mock.timers.tick(300);
  const saidAt = Date.now();
  feed(0.2, 4); // "yes"
  feed(0.0005, 6);
  await flush();
  mock.timers.tick(700);
  const cardAt = Date.now();
  mock.timers.tick(1000);
  heard.shift()("");
  await flush();
  heard.shift()("yes");
  await flush();
  mock.timers.tick(1600);
  assert.deepEqual(got, ["yes"]);
  assert.equal(ats.at(-1), saidAt);
  assert.equal(spokenAnswer("yes", [{ id: "card", at: cardAt, text: "x" }], Date.now(), { heardFrom: ats.at(-1) }).kind, "refuse");
  voice.toggleMic();
  await flush();
});

test("local hearing: let go of the key, the page stops showing the mic on, and a press while the words are read says so", async () => {
  voice.hush();
  got.length = 0;
  voice.bindTalkKey();
  const down = { ctrlKey: true, code: "Space", key: " ", repeat: false, preventDefault() {}, target: null };
  listeners.keydown(down);
  await flush();
  feed(0.2, 4);
  await flush();
  listeners.keyup({ code: "Space", key: " " });
  await flush();
  assert.deepEqual(mics.at(-1), [false, "key"], "the mic is off though the words take seconds");
  listeners.keydown(down);
  await flush();
  assert.match(notes.at(-1), /Still reading/);
  assert.deepEqual(mics.at(-1), [false, "key"], "the second press started nothing");
  listeners.keyup({ code: "Space", key: " " });
  voice.toggleMic(); // Talk says the same, and does not turn the open mic on behind it
  await flush();
  assert.deepEqual(mics.at(-1), [false, "key"]);
  heard.shift()("first thing");
  await flush();
  assert.deepEqual(got, ["first thing"]);
  voice.hush();
  notes.length = 0;
});

test("local hearing: dictating, the dots stay out of the box, and the owner's last words still come after Stop, before it ends", async () => {
  const box = [], ends = [];
  assert.equal(voice.dictate((t) => box.push(t), (why) => ends.push(why)), "started");
  await flush();
  feed(0.2, 4);
  await flush();
  assert.ok(box.every((t) => !t.includes("…")), JSON.stringify(box));
  feed(0.0005, 6);
  await flush();
  heard.shift()("please fix the header");
  await flush();
  feed(0.2, 4);
  feed(0.0005, 6);
  await flush();
  assert.equal(voice.dictate(), "stopped");
  assert.deepEqual(ends, [], "the last words are still to come");
  assert.match(voice.dictate(() => {}, () => {}), /Still reading/, "a Talk press in another chat says why nothing starts");
  heard.shift()("and the footer too");
  await flush();
  assert.equal(box.at(-1), "please fix the header and the footer too");
  assert.deepEqual(ends, [null]);
});

test("local hearing: a line does not play over the owner's dictation when the open mic's last words come in late", async () => {
  voice.toggleMic();
  await flush();
  feed(0.2, 4); // what the owner said to the assistant, its read out
  feed(0.0005, 6);
  await flush();
  const ends = [];
  voice.dictate(() => {}, (why) => ends.push(why));
  await flush();
  const before = spoken.length;
  await voice.speak({ id: "local-3", text: "Ada is done." });
  await flush();
  heard.shift()("the last thing i said");
  await flush();
  assert.equal(spoken.length, before, "no line while the owner dictates");
  voice.dictate();
  await flush();
  assert.deepEqual(ends, [null]);
  assert.equal(spoken.length, before + 1, "it goes once the owner is done");
  voice.hush();
});

test("filler words: once held, one plays the moment the owner sends, with no fetch, and the answer still playing stops", async () => {
  voice.hush();
  const before = spoken.length;
  const primed = voice.primeFillers();
  await flush();
  const first = spoken.splice(before);
  assert.equal(first.length, 1, "one filler asks whether the voice is on");
  first[0].ok({ ok: true, status: 200, blob: async () => new Blob([]) });
  await flush();
  const asks = spoken.splice(before);
  assert.equal(asks.length, 4, "each other filler's audio is fetched once");
  for (const a of asks) a.ok({ ok: true, status: 200, blob: async () => new Blob([]) });
  await primed;
  assert.equal(voice.primeFillers(), primed, "held: never fetched again");
  await voice.speak({ id: "filler-old", text: "The old answer." });
  await flush();
  const old = played.at(-1);
  const fetched = spoken.length;
  voice.ack();
  assert.equal(old.paused, true, "the old answer stops at once");
  assert.equal(spoken.length, fetched, "no fetch: the filler was already held");
  assert.equal(played.at(-1).src, "blob:line", "the filler plays from the held audio");
  voice.hush();
});

test("local hearing: a line that waited behind the dots plays once they turn out to be nothing", async () => {
  voice.toggleMic();
  await flush();
  feed(0.2, 4); // a noise the owner made
  await flush();
  const before = spoken.length;
  await voice.speak({ id: "local-2", text: "Ada is done." });
  await flush();
  assert.equal(spoken.length, before, "it waits while the owner might be talking");
  feed(0.0005, 6);
  await flush();
  heard.shift()("");
  await flush();
  assert.equal(spoken.length, before + 1, "nothing was said, so the line goes");
  voice.toggleMic();
  await flush();
});
