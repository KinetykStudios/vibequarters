// Hearing for a browser whose own speech recognition never fires (see voice.js). It has the face of the browser's
// SpeechRecognition, so voice.js runs the same in both, with whisper.cpp on this computer behind it (POST /api/hear,
// lib/hear.js). It listens for speech and sends each phrase as a WAV to HQ's server and nowhere else. Until the words are
// back a phrase shows as dots, so voice.js knows someone is talking.
const meta = document.querySelector('meta[name="hq-token"]');
const TOKEN = meta && /^[0-9a-f]{64}$/.test(meta.content) ? meta.content : null;

export const RATE = 16000; // what whisper takes; the browser resamples the mic to it
export const BLOCK = 2048; // the mic's sound comes in blocks of 128 ms
const MIN_LOUD = 2; // loud blocks in a row that start a phrase, so a click is not one
const LEAD = 3; // blocks kept from before the speech started, so the first word is whole
const QUIET = 5; // quiet blocks that end a phrase, 640 ms
const MAX_BLOCKS = 234; // a phrase is cut at 30 s, which also keeps it under the server's 1 MB
const INTERIM_EVERY = 8; // new loud sound, about a second, before the words so far are read again
const LOUDEST_ROOM = 0.01; // sound under this level is never the owner
export const WAITING = " …";

const levelOf = (b) => Math.sqrt(b.reduce((t, s) => t + s * s, 0) / b.length);

// The blocks as a 16 kHz, mono, 16-bit WAV
export function wavOf(blocks) {
  const n = blocks.reduce((t, b) => t + b.length, 0);
  const v = new DataView(new ArrayBuffer(44 + n * 2));
  const tag = (at, s) => { for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  tag(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, n * 2, true);
  let at = 44;
  for (const b of blocks) for (const s of b) {
    v.setInt16(at, Math.max(-1, Math.min(1, s)) * 32767, true);
    at += 2;
  }
  return v.buffer;
}

// Cuts the mic's blocks into phrases. noise follows the room: quickly while it is quiet, slowly while it is loud, so a
// steady fan stops counting as speech while a voice barely moves it.
export function phrases(on) {
  let lead = [], now = null, run = 0, quiet = 0, noise = 0;
  const end = () => {
    const blocks = now;
    now = null;
    run = 0;
    on.end(blocks);
  };
  return {
    feed(block) {
      const level = levelOf(block);
      const loud = level > Math.max(LOUDEST_ROOM, noise * 3);
      noise += (level - noise) * (loud ? 0.002 : 0.05);
      if (!now) {
        lead.push(block);
        if (lead.length > LEAD + MIN_LOUD) lead.shift();
        run = loud ? run + 1 : 0;
        if (run < MIN_LOUD) return;
        [now, lead, quiet] = [lead, [], 0];
        return on.start();
      }
      now.push(block);
      quiet = loud ? 0 : quiet + 1;
      if (quiet >= QUIET || now.length >= MAX_BLOCKS) return end();
      if (loud) on.more(now);
    },
    flush() { if (now) end(); },
  };
}

async function ask(wav, signal) {
  const r = await fetch("/api/hear", { method: "POST", headers: { "Content-Type": "audio/wav", "X-HQ-Token": TOKEN }, body: wav, cache: "no-store", signal }).catch(() => null);
  if (!r || !r.ok) throw new Error(r && r.status === 503 ? "hear-off" : "hear-failed");
  return (await r.json()).text;
}

export class LocalRecognition {
  results = []; // the browser's shape, each { 0: { transcript }, isFinal }, a later one starting with a space. Its reads take
  // seconds, so each also carries from and to: when the speech started and when its sound stopped
  work = Promise.resolve(); // the finished phrases, read one after another, in the order spoken
  phrase = null; // the one being said now
  asking = null; // the interim read that is out: its AbortController
  sent = 0; // how many blocks it had
  stopping = false;
  over = false;

  start() {
    this.cut = phrases({ start: () => this.begin(), more: (b) => this.more(b), end: (b) => this.end(b) });
    this.open().catch((e) => this.fail(e && e.name === "NotAllowedError" ? "not-allowed" : "audio-capture"));
  }

  // stop, as the browser's does: the mic is off at once, and the words heard so far still come before onend
  stop() {
    if (this.stopping || this.over) return;
    this.stopping = true;
    this.shut();
    this.cut.flush();
    this.work.then(() => this.finish());
  }

  async open() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (this.stopping) return stream.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.ctx = new AudioContext({ sampleRate: RATE });
    this.ctx.resume().catch(() => {});
    this.source = this.ctx.createMediaStreamSource(stream);
    this.node = this.ctx.createScriptProcessor(BLOCK, 1, 1);
    this.node.onaudioprocess = (e) => this.cut.feed(e.inputBuffer.getChannelData(0).slice());
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination); // it runs only when connected; it writes nothing, so nothing plays
  }

  shut() {
    if (this.node) {
      this.node.onaudioprocess = null;
      this.node.disconnect();
      this.source.disconnect();
      this.ctx.close().catch(() => {});
      this.node = null;
    }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  show() { this.onresult({ results: this.results }); }

  begin() {
    const at = Date.now();
    this.phrase = { 0: { transcript: WAITING }, isFinal: false, from: at, to: at };
    this.results.push(this.phrase);
    this.sent = 0;
    this.show();
  }

  more(blocks) {
    this.phrase.to = Date.now();
    if (this.asking || blocks.length - this.sent < INTERIM_EVERY) return;
    const asking = (this.asking = new AbortController());
    this.sent = blocks.length;
    const phrase = this.phrase;
    ask(wavOf(blocks), asking.signal).then((text) => {
      if (text && phrase === this.phrase) {
        phrase[0].transcript = " " + text;
        this.show();
      }
    }, () => {}).finally(() => { if (this.asking === asking) this.asking = null; }); // a failed read shows when the phrase's final read fails
  }

  end(blocks) {
    const phrase = this.phrase, wav = wavOf(blocks);
    this.phrase = null;
    // the whole phrase is in hand, so a read of its first part must not hold up this one
    if (this.asking) this.asking.abort();
    this.asking = null;
    this.work = this.work.then(async () => {
      if (this.over) return;
      try {
        const text = await ask(wav);
        phrase.isFinal = true;
        phrase[0].transcript = text ? " " + text : "";
        this.show();
      } catch (e) {
        this.fail(e.message);
      }
    });
  }

  fail(error) {
    if (this.over) return;
    this.phrase = null; // an interim read still out shows nothing now
    this.shut();
    this.results.forEach((r) => { if (!r.isFinal) Object.assign(r, { 0: { transcript: "" }, isFinal: true }); });
    if (this.results.length) this.show();
    this.onerror({ error });
    this.finish();
  }

  finish() {
    if (this.over) return;
    this.over = true;
    this.onend();
  }
}
