// The owner's attention and the alerts. The page tells the server that it is open, and whether the owner is here (the
// window focused and the document visible); the bridge holds prompts for HQ only while a page is open, and focus
// decides only whether a browser notification goes out. The event stream's decision ids, not a faster poll, drive a
// two-note chime when an item comes and again at 60 s and 120 s while it is open, here or away, and, while HQ is away,
// a browser notification with no names in it. Sound is on by default and plays only after the first click or key;
// Alerts is off until it is switched on. Both switches sit in Live's header.
import { el } from "./dom.js";
import { post, canAnswer } from "./control.js";
import { addRailControl } from "./needs.js";

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const soundOn = () => store.get("hq.sound") !== "off";
const alertsOn = () => store.get("hq.alerts") === "on";

// --- presence: posted on focus, blur and visibility changes, and every 20 s here or away, so the bridge knows a page is
// open (a hidden tab's timers may run once a minute; the bridge allows 90 s). A closed tab says so at once and tells
// HQ's other tabs, which say a second later, after its report, that a page is still open ---
let focused = document.hasFocus();
const here = () => focused && document.visibilityState === "visible";
let sent = null;
function report(force = false) {
  const now = here();
  if (now === sent && !force) return;
  sent = now;
  post("/api/presence", { focused: now });
}
function startPresence() {
  addEventListener("focus", () => { focused = true; report(); });
  addEventListener("blur", () => { focused = false; report(); });
  document.addEventListener("visibilitychange", () => report());
  if (!canAnswer()) return; // control off: nothing to report (post() sends nothing without a token), and no event stream
  setInterval(() => report(true), 20e3);
  let tabs = null;
  try {
    tabs = new BroadcastChannel("hq-presence");
    tabs.onmessage = () => setTimeout(() => report(true), 1000);
  } catch {}
  addEventListener("pagehide", () => {
    post("/api/presence", { focused: false, open: false }, { keepalive: true });
    if (tabs) tabs.postMessage("closed");
  });
  report(true);
}

// --- the chime: two short sine notes; the audio context is made on the first one and suspended 900 ms after each ---
let armed = false, ctx = null, rest = 0, lastChime = -Infinity;
const arm = () => { armed = true; }; // a browser plays sound only after the person has clicked or typed on the page
addEventListener("pointerdown", arm, { capture: true, once: true });
addEventListener("keydown", arm, { capture: true, once: true });
function chime() {
  if (!armed || !soundOn()) return;
  lastChime = Date.now();
  try {
    ctx = ctx || new AudioContext();
    ctx.resume();
    const t = ctx.currentTime;
    for (const [hz, at] of [[880, 0], [1320, 0.12]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.15, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(t + at);
      o.stop(t + at + 0.32);
    }
    clearTimeout(rest);
    rest = setTimeout(() => ctx.suspend(), 900); // a suspended context costs nothing
  } catch {}
}

// --- the reminders: an item that comes while the page is open chimes when it comes and at 60 s and 120 s after, while
// it is still open (3 chimes in all), here or away. One chime plays for every item due at once, and at most one per 2 s:
// an item due inside that waits for its end. An item gone before a reminder gets none; with Sound off it is passed
// silently. Items open when the page loaded get none ---
const REMIND = [0, 60e3, 120e3];
const GAP = 2e3;
const due = new Map(); // id -> the times its chimes still to come are due, earliest first
let remindTimer = 0;
function remind() {
  remindTimer = 0;
  const now = Date.now();
  const ready = [...due].filter(([, at]) => at[0] <= now);
  if (ready.length && now - lastChime < GAP) return schedule(lastChime + GAP);
  if (ready.length) {
    chime();
    for (const [id, at] of ready) at.length > 1 ? at.shift() : due.delete(id);
  }
  schedule();
}
// The next run: at the earliest time due, never inside the 2 s after a chime, never twice
function schedule(at = Math.max(Math.min(...[...due.values()].map((x) => x[0])), lastChime + GAP)) {
  clearTimeout(remindTimer);
  remindTimer = due.size ? setTimeout(remind, Math.max(0, at - Date.now())) : 0;
}

// --- notifications while HQ is away (hidden or unfocused): one per 20 s at most, the latest count trailing ---
let lastNote = 0, noteTimer = 0, noteCount = 0;
function notify(count) {
  if (!alertsOn() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  noteCount = count;
  const wait = lastNote + 20e3 - Date.now();
  if (wait <= 0) return showNote();
  if (!noteTimer) noteTimer = setTimeout(showNote, wait);
}
function showNote() {
  noteTimer = 0;
  if (here() || !noteCount) return; // the owner came back meanwhile: the page shows it
  lastNote = Date.now();
  try {
    new Notification("VibeQuarters", { body: noteCount === 1 ? "1 thing needs you" : `${noteCount} things need you`, tag: "hq-needs", silent: true }); // never a name
  } catch {}
}

// --- the event stream: the open ids at once, then on every change ---
let known = null;
function takeIds(msg, refresh) {
  const ids = Array.isArray(msg.ids) ? msg.ids : [];
  if (known === null) {
    known = new Set(ids); // what was already open when the page loaded: no chime
    return;
  }
  const fresh = ids.filter((id) => !known.has(id));
  const changed = fresh.length > 0 || ids.length !== known.size;
  known = new Set(ids);
  const now = Date.now();
  for (const id of due.keys()) if (!known.has(id)) due.delete(id); // an item gone takes its reminders with it
  for (const id of fresh) due.set(id, REMIND.map((ms) => now + ms));
  if (fresh.length) {
    remind(); // its first chime now, or at the end of the 2 s after the last one
    if (!here()) notify(ids.length);
  } else if (changed) schedule();
  if (changed && document.visibilityState === "visible") refresh(); // the payload now, not at the next 3 s poll
}

export function startAlerts({ onDecisions, onSay = () => {} }) {
  const sound = el("button", { type: "button", class: "quiet ask-switch", title: "A short chime when something new needs you", onclick: () => { store.set("hq.sound", soundOn() ? "off" : "on"); paint(); } }, "Sound");
  const alerts = el("button", { type: "button", class: "quiet ask-switch", title: "A browser notification while VibeQuarters is in the background, with no names in it", onclick: async () => {
    if (alertsOn()) store.set("hq.alerts", "off");
    else if (typeof Notification !== "undefined" && (Notification.permission === "granted" || (await Notification.requestPermission()) === "granted")) store.set("hq.alerts", "on");
    paint();
  } }, "Alerts");
  const paint = () => {
    sound.setAttribute("aria-pressed", String(soundOn()));
    alerts.setAttribute("aria-pressed", String(alertsOn()));
  };
  paint();
  addRailControl(sound, alerts);
  startPresence();
  // control off: no answer is possible, so no stream; each open stream holds one of the browser's 6 connections to HQ
  if (!canAnswer()) return;
  try {
    const es = new EventSource("/api/events");
    es.addEventListener("decisions", (e) => {
      let msg = null;
      try { msg = JSON.parse(e.data); } catch {}
      if (msg) takeIds(msg, onDecisions);
    });
    // any other change to the payload (a chat's reply or status, a send delivered): the page now, not at the next 3 s
    // poll
    es.addEventListener("hq", () => document.visibilityState === "visible" && onDecisions());
    // a line for the assistant's voice ({ id, text }: a read-back, a window's end, a watched chat's reply, the
    // assistant's own reply), here or away; voice.js lets one page speak it
    es.addEventListener("say", (e) => {
      let msg = null;
      try { msg = JSON.parse(e.data); } catch {}
      if (msg && msg.id != null && typeof msg.text === "string") onSay(msg);
    });
  } catch {}
}
