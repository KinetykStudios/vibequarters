// The assistant's voice in the page. Hearing: the browser's own speech recognition (or hear.js where that never fires),
// while Ctrl+Space is held, or on the open mic from one press of Talk to the next, where each finished phrase goes on by
// itself; on the held key what it hears shows live in the box (the open mic types nothing), and the final words go to
// assistant.js, which sends them on. Speaking: the lines the server sends on the event stream (alerts.js) are read
// aloud through HQ's /api/tts, streamed so the first words play while the rest arrive, by one page of however many are
// open. Starting to talk stops the speaking at once. With no key the server answers 503 and the voice stays quiet; the
// text panel carries every reply either way.
import { talkKey, claimSpeech, watchSpeech, FILLERS, pickFiller } from "./assistant-rules.js";
import { streaming, onStreaming } from "./streamer.js";
import { LocalRecognition, WAITING } from "./hear.js";

// The page's token, as control.js reads it: its post() parses JSON, and /api/tts answers audio
const meta = document.querySelector('meta[name="hq-token"]');
const TOKEN = meta && /^[0-9a-f]{64}$/.test(meta.content) ? meta.content : null;

let hooks = { interim() {}, final() {}, mic() {}, note() {} };
export const setVoiceHooks = (h) => { hooks = { ...hooks, ...h }; };

// --- hearing: one recognition at a time, its interim words shown as they come ---
// A browser can list the recognition with nothing behind it: start() is taken and no event ever comes. Where that is known
// (by the browser's own mark), whisper.cpp on this computer hears instead.
const SR = /\bOPR\//.test(navigator.userAgent || "") ? LocalRecognition : window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = () => !!SR;
let rec = null, via = null, said = "", heardFrom = 0; // heardFrom: when the words began, so a yes answers only a card that had already been heard
// The open mic (one press of Talk): it stays open until the next press, and it listens while a reply plays too. Phrases
// join into one message that goes after 1.6 s of quiet, 2.5 s after a word that leaves the sentence hanging, so a short
// pause never splits one prompt into two. A voice over a reply stops it at once; what the mic hears of the reply's own
// voice through the speakers does not count (echo below). done: the results of this recognition already taken; turn: the
// phrases waiting to go, turnFrom: when they began; cut: a reply was talked over while they were said.
let openMic = false, done = 0, turn = [], turnFrom = 0, turnTimer = 0, cut = false, soundAt = 0;
const QUIET_MS = 1600, HANGING_MS = 2500, RECHECK_MS = 250; // RECHECK_MS: talking again, so look again soon
const HANGING = /\b(and|or|but|so|the|a|an|to|of|for|at|with|my|your|our|next|then|that|if|because|like|um|uh)$/i;
const words = (t) => String(t).toLowerCase().match(/[a-z0-9']+/g) || [];
// Its own voice coming back: most of what was heard is in the line playing, or the one that ended under ECHO_MS ago. A
// lone answer (yes, cancel) counts as spoken once its line has been over for ANSWER_MS, even when the line asked for a
// yes: a spoken yes to a read-back would otherwise be dropped as echo. at: when the sound was heard, which hear.js says,
// since its words come back seconds later; the browser's come as they are said
const ECHO_MS = 2500, ANSWER_MS = 800;
const ANSWER = /^(yes|yeah|yep|yes please|confirm|cancel|no|stop)$/;
let lastLine = "", lastLineEnd = 0;
function echo(t, at = Date.now()) {
  const heard = words(t);
  const recent = at - lastLineEnd < (ANSWER.test(heard.join(" ")) ? ANSWER_MS : ECHO_MS);
  const line = new Set(words((playing ? playing.text : "") + " " + (recent ? lastLine : "")));
  return heard.length > 0 && line.size > 0 && heard.filter((w) => line.has(w)).length / heard.length >= 0.6;
}
function gather(text, at, heardAt) {
  if (!text || echo(text, heardAt)) return;
  if (!turn.length) turnFrom = at;
  turn.push(text);
}
// the end of a turn waits while a phrase is being said, and starts again with each word
function waitTurn() {
  clearTimeout(turnTimer);
  if (!turn.length) return;
  // the quiet counts from when the sound stopped: hear.js's words come back seconds after that, the browser's at once
  const left = (HANGING.test(turn.at(-1)) ? HANGING_MS : QUIET_MS) - (Date.now() - soundAt);
  turnTimer = setTimeout(() => (said ? waitTurn() : endTurn()), Math.max(left, said ? RECHECK_MS : 0));
}
function endTurn() {
  clearTimeout(turnTimer);
  if (!turn.length) return;
  const text = turn.join(" "), at = turnFrom, how = { cut };
  turn = [];
  turnFrom = 0;
  cut = false;
  hooks.final(text, at, how);
  if (!playing && !said) next(); // the lines that waited for the owner to finish
}
// The meter for voice mode: while the open mic is on, one analyser listens to the microphone, and each reply plays
// through a second on its way out, so the panel's wave can read how loud each of them is right now, 0 to 1
let actx = null, micMeter = null, micStream = null, voiceMeter = null;
function loudness(an) {
  if (!an) return 0;
  const d = new Float32Array(1024);
  an.getFloatTimeDomainData(d);
  let s = 0;
  for (const v of d) s += v * v;
  return Math.min(1, Math.sqrt(s / d.length) * 6);
}
export const levels = () => ({ you: loudness(micMeter), ai: loudness(voiceMeter) });
// opened from the Talk press itself, since a browser starts sound only from a press
function openMeter() {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia || !window.AudioContext) return;
  try { actx = actx || new AudioContext(); } catch { return; }
  if (actx.resume) actx.resume().catch(() => {});
  md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then((stream) => {
    if (!openMic || micStream) return stream.getTracks().forEach((t) => t.stop()); // closed while it opened
    micStream = stream;
    micMeter = actx.createAnalyser();
    micMeter.fftSize = 1024;
    actx.createMediaStreamSource(stream).connect(micMeter);
  }).catch(() => {}); // blocked: the recognition says so in the hint, and the wave stays still
}
function closeMeter() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = micMeter = null;
}
// a reply through the voice analyser, only while the sound runs (a suspended one would mute the reply)
function route(audio) {
  if (!actx || actx.state !== "running") return;
  try {
    if (!voiceMeter) {
      voiceMeter = actx.createAnalyser();
      voiceMeter.fftSize = 1024;
      voiceMeter.connect(actx.destination);
    }
    actx.createMediaElementSource(audio).connect(voiceMeter);
  } catch {}
}
const MIC_NOTE = { "not-allowed": "The microphone is blocked. Allow it from the address bar", "service-not-allowed": "The microphone is blocked. Allow it from the address bar", "no-speech": "Heard nothing. Try again", "audio-capture": "No microphone found", "hear-off": "Hearing is not set up on this computer. Open VibeQuarters in Microsoft Edge to talk", "hear-failed": "Could not turn that into words. Try again" };
// hear.js's stop: the mic is off at once and the owner's last words take seconds. A press in that time starts nothing,
// so it says so
const STILL_READING = "Still reading what you said. Try again in a moment";
const reading = () => {
  if (!rec || !rec.stopping) return false;
  hooks.note(STILL_READING);
  return true;
};
// keep: the open mic starting again on its own, so a reply that plays goes on
function start(how, keep = false) {
  if (!SR || reading() || rec) return;
  if (dict) dictate(); // talking to the assistant ends a dictation; its words stay in their box
  if (!keep) {
    stopSpeaking(); // talking over it, here and on every other HQ page
    if (chan) chan.postMessage({ stop: true });
  }
  said = "";
  heardFrom = how === "open" ? 0 : Date.now();
  done = 0;
  via = how;
  rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = true; // a pause in the middle of a sentence does not end it; the release does
  rec.onresult = (e) => {
    const all = Array.from(e.results);
    if (via !== "open") {
      said = all.map((r) => r[0].transcript).join("").trim();
      return hooks.interim(said);
    }
    soundAt = all.at(-1)?.to || Date.now();
    for (; done < all.length && all[done].isFinal; done++) {
      gather(all[done][0].transcript.trim(), all[done].from || heardFrom || Date.now(), all[done].to);
      heardFrom = 0;
    }
    said = all.slice(done).map((r) => r[0].transcript).join("").trim(); // the phrase still under way
    if (said && echo(said, all.at(-1)?.to)) said = "";
    if (said && !heardFrom) heardFrom = all[done]?.from || Date.now();
    if (playing && (words(said).length || turn.length)) { // hear.js's dots have no words: sound alone may be the reply itself
      cut = true; // the owner talked over it: quiet at once, here and on every other HQ page
      stopSpeaking();
      if (chan) chan.postMessage({ stop: true });
    }
    // On the open mic the words are not typed into the box as they are said; they show once, as a message, when they go
    waitTurn();
    if (!playing && !said && !turn.length && all.at(-1)?.isFinal) next(); // what seemed to be the owner came to nothing: the lines waiting behind it go
  };
  rec.onerror = (e) => {
    if (e.error === "aborted" || (via === "open" && e.error === "no-speech")) return; // silence is normal on an open mic
    if (via === "open") { openMic = false; closeMeter(); } // blocked, missing or failing: the open mic closes rather than retry forever
    hooks.note(MIC_NOTE[e.error] || "The microphone stopped: " + e.error);
  };
  rec.onend = () => {
    rec = null;
    if (via === "open") {
      gather(said, heardFrom || Date.now()); // the words heard so far
      said = "";
      if (openMic) {
        waitTurn();
        return start("open", true); // the browser ended it on a pause: open it again, and a reply that plays goes on
      }
      endTurn(); // closed: what the owner said goes now
    } else if (said) hooks.final(said, heardFrom || Date.now());
    said = "";
    hooks.mic(false, via);
    if (!playing) next(); // the lines that came while the owner talked
  };
  try {
    rec.start();
  } catch {
    rec = null;
    if (how === "open") { openMic = false; closeMeter(); }
    hooks.mic(false, how);
    return;
  }
  hooks.mic(true, how);
}
// stop, not abort: the words heard so far still come back as final
const stop = () => {
  if (!rec) return;
  rec.stop();
  if (rec && rec.stopping) hooks.mic(false, via); // hear.js: nothing is listening now, though the words are still to come
};
export function toggleMic() {
  if (openMic) {
    openMic = false;
    closeMeter();
    if (rec) return stop();
    endTurn();
    hooks.mic(false, "open"); // closed while no recognition ran
    return;
  }
  if (reading()) return;
  if (rec) return stop(); // a held Ctrl+Space ends as it would on release
  openMic = true;
  openMeter();
  start("open");
}
// Dictation into a box: the chat window's Talk. put(text) gets everything said since the press, as it is said; nothing
// is sent. A pause the browser ends on starts it again with the words kept; the next press stops it, and ended(why)
// runs once, why null or the reason it stopped by itself. One recognition at a time: it closes the assistant's mic
// first (what was said to it still goes to it), the voice goes quiet, and a reply waits until it ends. Returns
// "started", "stopped", or the reason it cannot start.
let dict = null; // { put, ended, kept, now, rec, stop, error } while dictating
export const dictating = () => !!dict;
const joined = (a, b) => [a, b].filter(Boolean).join(" ");
export function dictate(put, ended = () => {}) {
  if (dict) {
    if (put && dict.stop) return STILL_READING; // a press in another chat, with this one's last words still to come
    dict.stop = true;
    if (dict.rec) dict.rec.stop(); // stop, not abort: the last words still come back
    return "stopped";
  }
  if (typeof put !== "function") return "stopped"; // a stop with nothing running
  if (!SR) return "This browser cannot turn speech into words. Open VibeQuarters in Microsoft Edge to talk";
  if (openMic) toggleMic();
  else if (rec) stop();
  stopSpeaking();
  if (chan) chan.postMessage({ stop: true });
  dict = { put, ended, kept: "", now: "", rec: null, stop: false, error: null };
  listen(dict);
  return dict ? "started" : "The microphone did not start";
}
function listen(d) {
  const r = new SR();
  r.lang = "en-US";
  r.interimResults = true;
  r.continuous = true;
  d.rec = r;
  r.onresult = (e) => {
    d.now = Array.from(e.results).map((x) => x[0].transcript).join("").replaceAll(WAITING, "").replace(/\s+/g, " ").trim();
    d.put(joined(d.kept, d.now));
  };
  r.onerror = (e) => {
    if (e.error === "aborted" || e.error === "no-speech") return; // silence is normal while the owner thinks
    d.stop = true;
    d.error = MIC_NOTE[e.error] || "The microphone stopped: " + e.error;
  };
  r.onend = () => {
    d.kept = joined(d.kept, d.now);
    d.now = "";
    if (dict !== d) return;
    if (!d.stop) return listen(d); // the browser ended it on a pause
    dict = null;
    d.ended(d.error);
    if (!playing) next(); // the lines that waited while the owner dictated
  };
  try {
    r.start();
  } catch {
    dict = null;
    d.ended("The microphone did not start");
  }
}

// the open mic again once nothing is playing or waiting
function reopen() { if (openMic && !rec && !playing && !queue.length) start("open"); }

// Hold Ctrl+Space to talk, let go to send. A key typed in a box is text, so the shortcut leaves boxes alone. A release
// the page never sees (the window lost focus while it was held) ends it too.
const inBox = (t) => !!(t && t.closest && t.closest("input, textarea, select, [contenteditable]"));
export function bindTalkKey() {
  addEventListener("keydown", (e) => {
    if (!talkKey(e) || inBox(e.target)) return;
    e.preventDefault();
    if (!e.repeat) start("key");
  });
  addEventListener("keyup", (e) => { if (rec && via === "key" && (e.code === "Space" || e.key === "Control")) stop(); });
  addEventListener("blur", () => { if (rec && via === "key") stop(); });
}

// --- speaking: a queue of lines, one playing at a time ---
let chan = null;
try { chan = watchSpeech(new BroadcastChannel("hq-say")); } catch {}
// another page's mic started: the owner is talking, so this page stops too
if (chan) chan.addEventListener("message", (e) => { if (e.data && e.data.stop === true) stopSpeaking(); });
// Streamer mode masks names on screen and the voice would say them, so the voice is quiet while it is on
onStreaming((on) => { if (on) stopSpeaking(); });
const queue = [];
let playing = null; // { abort, audio, text } of the line being fetched or played

// One page speaks each line. A page the owner has not clicked or typed in cannot play sound, so it leaves the line to
// one that can. The BroadcastChannel claim keeps a page from playing an id another page took, or one it played before;
// the Web Lock on the id settles two pages that get the same line in the same moment, which the channel cannot, since
// a claim reaches the other page only a moment later. The lock is held a minute, long past the line.
function claim(id) {
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return Promise.resolve(false);
  if (chan && !claimSpeech(id, chan)) return Promise.resolve(false);
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((done) => navigator.locks.request("hq-say:" + id, { ifAvailable: true }, (lock) => {
    done(!!lock);
    return lock ? new Promise((r) => setTimeout(r, 60e3)) : null;
  }));
}

export async function speak({ id, text } = {}) {
  if (!TOKEN || !text || id == null || streaming() || !(await claim(String(id)))) return;
  queue.push(String(text).slice(0, 600)); // /api/tts takes 1 to 600 characters
  if (playing) return;
  // the open mic listens on while it speaks, so a reply can be talked over; a held key, or words not sent yet, make it
  // wait
  if (!dict && (!rec || (via === "open" && !said && !turn.length))) next();
}

// --- filler words: the page holds each filler's audio (HQ's /api/tts keeps short lines, so a reload costs no new voice), and the
// moment the owner's words go one plays from that audio, with no fetch. Whatever was still playing or waiting from the answer
// before is dropped, here and on every other HQ page, since the owner has moved on. ---
const fillers = new Map(); // filler text -> its audio's object URL
let priming = null, lastFiller = null;
export function primeFillers() {
  if (priming || !TOKEN) return priming;
  const prime = async (text) => {
    try {
      const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json", "X-HQ-Token": TOKEN }, body: JSON.stringify({ text }), cache: "no-store" });
      if (r.ok) fillers.set(text, URL.createObjectURL(await r.blob()));
      return r.status !== 503;
    } catch { return true; } // the voice failed: no filler, the answer still shows and plays
  };
  priming = prime(FILLERS[0]).then((on) => on && Promise.all(FILLERS.slice(1).map(prime))); // 503: the voice is off, so the rest are not asked for
  return priming;
}
export function ack() {
  if (!TOKEN || streaming() || dict) return;
  hush();
  const text = pickFiller(lastFiller);
  lastFiller = text;
  const url = fillers.get(text);
  if (!url) return void primeFillers(); // not held yet: the next send has it
  const mine = { abort: new AbortController(), audio: new Audio(), text };
  playing = mine;
  mine.audio.src = url;
  route(mine.audio);
  new Promise((done) => {
    mine.audio.onended = mine.audio.onerror = () => done();
    mine.abort.signal.addEventListener("abort", () => done());
    mine.audio.play().catch(() => done());
  }).then(() => {
    if (playing !== mine) return; // the owner talked over it
    [lastLine, lastLineEnd] = [text, Date.now()];
    next(); // the answer's first words, if they came while it played
  });
}

// The panel's Stop: quiet here and on every other HQ page, as talking over it does
export function hush() {
  stopSpeaking();
  if (chan) chan.postMessage({ stop: true });
}

export function stopSpeaking() {
  queue.length = 0;
  if (!playing) return;
  playing.abort.abort();
  playing.audio.pause();
  [lastLine, lastLineEnd] = [playing.text, Date.now()]; // its last words may still come back through the speakers
  playing = null;
  if (openMic) queueMicrotask(reopen); // a reply cut short: the open mic opens again
}

async function next() {
  if (dict) return; // a late word from the mic closed for dictation; the line goes when that ends
  const text = queue.shift();
  if (text == null) { playing = null; reopen(); return; }
  const mine = { abort: new AbortController(), audio: new Audio(), text };
  playing = mine;
  try {
    const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json", "X-HQ-Token": TOKEN }, body: JSON.stringify({ text }), cache: "no-store", signal: mine.abort.signal });
    if (r.ok) await play(mine, r);
    else {
      queue.length = 0; // the voice is off or failed: the lines waiting behind this one would fail the same way
      hooks.note(r.status === 503 ? offReason(await r.text().catch(() => "")) : "The voice did not play. Replies still show here");
    }
  } catch {} // stopped, or the server went away
  if (playing === mine) {
    [lastLine, lastLineEnd] = [text, Date.now()];
    next();
  }
}

// The server's 503 says why the voice is off ("voice off: ..."), as text or as a JSON error
function offReason(body) {
  let t = body;
  try { const j = JSON.parse(body); t = (j && (j.error || j.message)) || body; } catch {}
  t = String(t || "").trim().replace(/^voice off:\s*/i, "");
  return "Voice is off" + (t ? ": " + t : "") + ". Replies still show here";
}

// Plays an audio/mpeg answer as it streams in (MediaSource), or whole once it has arrived where MediaSource cannot take
// MP3; resolves when the line ends, fails to play, or is stopped
async function play(mine, r) {
  const { audio, abort } = mine;
  const ms = r.body && window.MediaSource && MediaSource.isTypeSupported("audio/mpeg") ? new MediaSource() : null;
  audio.src = URL.createObjectURL(ms || (await r.blob()));
  route(audio);
  try {
    await new Promise((done) => {
      if (abort.signal.aborted) return done();
      audio.onended = audio.onerror = () => done();
      abort.signal.addEventListener("abort", () => done());
      if (ms) ms.addEventListener("sourceopen", () => feed(ms, r.body.getReader()).catch(() => done()), { once: true });
      audio.play().catch(() => done()); // a page that cannot play sound yet
    });
  } finally {
    URL.revokeObjectURL(audio.src);
  }
}
async function feed(ms, reader) {
  const sb = ms.addSourceBuffer("audio/mpeg");
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sb.appendBuffer(value);
    await new Promise((ok) => sb.addEventListener("updateend", ok, { once: true }));
  }
  ms.endOfStream();
}
