// The HQ assistant's panel: one conversation, drawn in the Dashboard's Assistant module and in the Office's glass
// panel (floor/panels.js mounts it each time that panel opens), from the payload's assistant, readbacks, settled and
// window (app.js passes every poll to setAssistant). It shows the assistant's state; the approve window's countdown
// with its Off button; each read-back waiting for the owner's yes, titled so, with its time left, Confirm and Cancel;
// in the Dashboard, a Recent list of what became of the last proposals and decisions; the conversation, each prompt it
// sent shown in full under the chat it went to; a box whose words go to the assistant (Enter sends, Shift+Enter is a
// new line); the mic (voice.js); and this week's spend. Each part is written only when what it shows changed, so a poll
// that brings nothing new writes nothing, and a box keeps its focus and its text. Under Streamer every free text is the
// mask; the fixed words, the numbers and the buttons stay, but a read-back card asks the owner to turn Streamer off and
// takes no yes, since its text is what the owner would be saying yes to.
import { el, svg } from "./dom.js";
import { post, canAnswer } from "./control.js";
import { MASK, streaming, onStreaming } from "./streamer.js";
import { mdInline, mdBlocks } from "./format.js";
import { ms } from "./motion.js";
import { statusWord, windowChip, sentLabel, usageLine, spokenAnswer, settled, STREAMER_CARD, hiddenCard, mayConfirm, RB_TITLE, expiresIn, recentFeed } from "./assistant-rules.js";
import { canListen, toggleMic, setVoiceHooks, hush, levels, ack, primeFillers } from "./voice.js";
import { mountWave } from "./voice-wave.js";

const SAY_MAX = 2000; // /api/say takes 1 to 2000 characters
const CLOSED = { open: false, endsAt: null, sessions: null, approved: 0 };
const NO_CONTROL = "Talking to the assistant works when VibeQuarters runs with control on"; // switches.js says it so for its switches
const EMPTY = "Nothing yet today. Ask what's going on, or tell it what to send where.";
const SOON_MS = 60e3; // a card's time left turns red in its last minute
// the latest payload's assistant (null: off), read-backs, window and settled history (lib/settled.js, newest first)
let A = null, readbacks = [], win = CLOSED, history = [];
const mounts = new Set();
let hooks = { refresh() {} };
export const setAssistantHooks = (h) => { hooks = { ...hooks, ...h }; };

// text, a property or an attribute written only when it changes, so a quiet poll writes no node
const put = (n, t) => { if (n.textContent !== t) n.textContent = t; };
const prop = (n, k, v) => { if (n[k] !== v) n[k] = v; };
const attr = (n, k, v) => { if (n.getAttribute(k) !== v) n.setAttribute(k, v); };
const mask = () => el("span", { class: "masked", text: MASK });
const free = (t) => (streaming() ? mask() : t); // a free text, the mask under Streamer
// the mounts still on the page: a minimized glass panel empties its body, and the mount there goes with it
function live() {
  for (const m of mounts) if (!m.root.contains(m.box)) mounts.delete(m);
  return [...mounts];
}

// An assistant reply's light formatting, as the chat window builds it (chat.js): bold, code and a link as its label with
// its address beside it, never markup
const parts = (ps) => ps.map((p) => (p.b != null ? el("b", { text: p.b }) : p.code != null ? el("code", { text: p.code }) : p.link != null ? el("span", {}, p.link, el("span", { class: "as-url", text: ` (${p.url})` })) : p.t));
const blocks = (text) => mdBlocks(text).map((b) =>
  b.k === "p" ? el("p", {}, parts(b.parts))
  : b.k === "pre" ? el("pre", { text: b.text })
  : b.k === "table" ? el("div", { class: "as-table" }, el("table", {},
      el("thead", {}, el("tr", {}, b.head.map((c) => el("th", { scope: "col" }, parts(c))))),
      el("tbody", {}, b.rows.map((r) => el("tr", {}, r.map((c) => el("td", {}, parts(c))))))))
  : el(b.k, b.k === "ol" && b.start !== 1 ? { start: String(b.start) } : {}, b.items.map((it) => el("li", {}, parts(it)))));

// A message by its role: the owner's words, the assistant's reply, a system line, or a prompt it sent into a chat
function msgEl(x) {
  if (x.role === "sent") return el("li", { class: "as-m as-sent" }, el("p", { class: "as-to" }, streaming() ? ["Sent to ", mask()] : sentLabel(x.name || "a chat")), el("p", { class: "as-prompt" }, free(x.text)));
  if (x.role === "assistant") return el("li", { class: "as-m as-assistant" }, streaming() ? el("p", {}, mask()) : blocks(x.text));
  return el("li", { class: "as-m as-" + (x.role === "owner" ? "owner" : "system") }, free(x.text));
}

const micIcon = () => svg("svg", { class: "as-mic-i", viewBox: "0 0 16 16", "aria-hidden": "true" },
  svg("rect", { x: "5.5", y: "1.5", width: "5", height: "8.5", rx: "2.5" }), svg("path", { d: "M3 7.5a5 5 0 0 0 10 0M8 12.5V15" }));

// --- mounting: the same parts in either place; compact (the glass panel) has its title and state in the panel's own
// header, so it draws no header of its own ---
export function mountAssistant(root, { compact = false } = {}) {
  for (const m of mounts) if (m.root === root) mounts.delete(m);
  const m = { root, compact, rows: new Map(), cards: new Map(), stKey: null };
  m.status = el("span", { class: "as-st" });
  m.chipT = el("span", { class: "as-win-t" });
  m.off = el("button", { type: "button", class: "ask-btn", text: "Turn off", onclick: windowOff });
  m.chip = el("p", { class: "as-win", hidden: true }, m.chipT, m.off);
  m.rbs = el("ul", { class: "as-rbs", "aria-label": "Waiting for your yes" });
  // the Dashboard's Recent list (the glass panel is a short strip, so it has none): what became of each of the last 5
  m.recentList = el("ol");
  m.recent = compact ? null : el("div", { class: "as-rec", hidden: true }, el("p", { class: "as-rec-h", text: "Recent" }), m.recentList);
  m.log = el("ol", { class: "as-log", "aria-label": "Conversation with the assistant" });
  m.ta = el("textarea", { class: "as-ta", rows: compact ? "1" : "2", maxlength: String(SAY_MAX), placeholder: compact && canListen() ? "Ask or tell it, or press Talk and just talk" : "Ask or tell the assistant", "aria-label": "Message the assistant" });
  m.micT = el("span", { text: "Talk" });
  m.mic = el("button", { type: "button", class: "as-mic", "aria-pressed": "false", title: "Open the mic and just talk; press again to close it. Or hold Ctrl+Space", onclick: () => toggleMic() }, micIcon(), m.micT);
  m.go = el("button", { type: "button", class: "as-go", text: "Send", onclick: () => say(m.ta.value) });
  m.halt = el("button", { type: "button", class: "ask-btn", text: "Stop", title: "Stop what the assistant is doing", hidden: true, onclick: halt });
  m.hint = el("span", { class: "as-hint", "aria-live": "polite" });
  m.use = el("p", { class: "as-use", hidden: true });
  m.ta.addEventListener("input", () => syncCompose(m));
  m.ta.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    say(m.ta.value);
  });
  // The Dashboard: the window and the read-backs under the header, never inside the conversation's scroll, then Recent,
  // then the conversation, which scrolls. Compact (the glass panel, a short strip): the conversation, then the window
  // and the read-backs right over the box, all in one scroll that rests at its end, so what waits for the owner is
  // always in view; the box and its buttons on one row, the hint under it only while it has something to say.
  m.scroll = compact ? el("div", { class: "as-top" }, m.log, m.chip, m.rbs) : m.log;
  // the Dashboard's voice mode: the wave's stage under the header, drawn only while the open mic is on (syncCompose)
  m.canvas = compact ? null : el("canvas");
  // Minimize: the conversation hides; the header, the window, what waits for the owner, Recent, the box and Talk stay.
  // Kept in localStorage.
  m.min = compact ? null : el("button", { type: "button", class: "ask-btn as-min-b", "aria-pressed": "false", onclick: () => minimize(m, !m.box.classList.contains("as-min")) });
  m.box = el("div", { class: "as" + (compact ? " as-c" : "") },
    ...(compact ? [m.scroll] : [el("div", { class: "nh" }, el("h2", { text: "Assistant" }), m.status, m.min), el("div", { class: "as-stage", "aria-hidden": "true" }, m.canvas), m.chip, m.rbs, m.recent, m.log]),
    el("div", { class: "as-box" }, m.ta, el("div", { class: "as-bar" }, compact ? null : m.hint, m.halt, m.mic, m.go)),
    compact ? m.hint : null, m.use);
  root.replaceChildren(m.box);
  mounts.add(m);
  primeFillers(); // the filler words' audio, held so one plays with no wait (voice.js ack)
  if (m.min) minimize(m, (() => { try { return localStorage.getItem("hq.assistant.min") === "1"; } catch { return false; } })(), false);
  draw(m);
  m.scroll.scrollTop = m.scroll.scrollHeight; // a panel opens on the latest words
}

function minimize(m, on, keep = true) {
  m.box.classList.toggle("as-min", on);
  m.min.textContent = on ? "Show chat" : "Minimize";
  m.min.setAttribute("aria-pressed", String(on));
  m.min.title = on ? "Show the conversation again" : "Hide the conversation; you can still type or talk to it";
  if (keep) try { localStorage.setItem("hq.assistant.min", on ? "1" : "0"); } catch {}
}

// Every poll's payload (/api/hq): the assistant's own part, and the read-backs and window at its top level
export function setAssistant(hq) {
  A = (hq && hq.assistant) || null;
  readbacks = (hq && Array.isArray(hq.readbacks) && hq.readbacks) || [];
  const ids = readbacks.map((r) => r.id).join(" ");
  if (ids !== cardIds) [cardIds, cardsAt] = [ids, Date.now()]; // a card came or went: the others may have moved
  win = (hq && hq.window) || CLOSED;
  history = (hq && Array.isArray(hq.settled) && hq.settled) || [];
  for (const id of answering.keys()) if (!readbacks.some((r) => r.id === id)) answering.delete(id); // answered: its card is gone
  for (const m of live()) draw(m);
  ticker();
}

function draw(m) {
  const on = streaming();
  const st = A && A.state, word = statusWord(st), hide = on && !!st && st.status === "error" && !!st.error; // the reason is free text
  const stKey = JSON.stringify([(st && st.status) || "off", word, hide]);
  if (m.stKey !== stKey) {
    m.stKey = stKey;
    m.status.className = "as-st st-" + ((st && st.status) || "off");
    m.status.replaceChildren(...(hide ? ["Offline: ", mask()] : [word]));
  }
  prop(m.halt, "hidden", !(st && st.status === "working"));
  // the scroll follows what is new (a message, a read-back, the window) while it rests at its end, and stays where the
  // owner scrolled it otherwise; drawn on the hidden tab, it goes to the end once it shows
  const sc = m.scroll, end = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 24, was = sc.scrollHeight;
  drawChip(m);
  drawCards(m, on);
  drawRecent(m, on);
  // A line that comes or changes takes the conversation to its newest words, wherever the owner left it
  if (drawLog(m, on)) m.toEnd = true;
  if (!sc.clientHeight) m.toEnd = true;
  else if (m.toEnd || (end && sc.scrollHeight !== was)) {
    m.toEnd = false;
    sc.scrollTop = sc.scrollHeight;
  }
  const use = usageLine(A && A.usage);
  prop(m.use, "hidden", !use);
  if (use) put(m.use, use);
  syncCompose(m);
}

function drawChip(m) {
  prop(m.chip, "hidden", !win.open);
  if (win.open) put(m.chipT, windowChip(win.endsAt, Date.now()));
  prop(m.off, "disabled", offing);
}

// The read-backs, oldest first, each card kept by id and rebuilt only when its text, its answer's state or Streamer
// changed, so a poll never takes the focus from its buttons. A card says it waits for the owner's yes and how long it
// has left; its time left moves each second in place (drawLeft).
const answering = new Map(); // read-back id -> "sending" or "failed", across both places
let cardIds = "", cardsAt = 0; // the waiting read-backs' ids, and when that list last changed
const clicked = (id, confirm) => () => { if (settled(cardsAt, Date.now())) answer(id, confirm); };
function drawCards(m, on) {
  const next = new Map();
  for (const rb of readbacks) {
    const k = JSON.stringify([rb.text, answering.get(rb.id) || null, on]);
    const c = m.cards.get(rb.id);
    next.set(rb.id, c && c.k === k ? c : { k, ...cardEl(rb) });
  }
  place(m.rbs, next);
  m.cards = next;
  drawLeft(m);
}
function cardEl(rb) {
  const state = answering.get(rb.id), busy = state === "sending", hidden = hiddenCard(rb, streaming());
  const left = el("span", { class: "as-rb-left", hidden: typeof rb.expiresAt !== "number" });
  const li = el("li", { class: "as-rb", tabindex: "-1" },
    el("p", { class: "as-rb-h" }, el("b", { text: RB_TITLE }), left),
    el("p", { class: "as-rb-t" }, hidden ? STREAMER_CARD : rb.text),
    el("div", { class: "ask-btns" },
      el("button", { type: "button", class: "ask-btn primary as-rb-yes", disabled: busy || hidden, text: "Confirm", onclick: clicked(rb.id, true) }),
      el("button", { type: "button", class: "ask-btn as-rb-no", disabled: busy, text: "Cancel", onclick: clicked(rb.id, false) })),
    state === "failed" ? el("p", { class: "ask-note", text: "Did not go through. It may be answered already; try again" }) : null);
  return { li, left, expiresAt: rb.expiresAt };
}
// Each card's time left, written only when its words change
function drawLeft(m, now = Date.now()) {
  for (const c of m.cards.values()) {
    if (typeof c.expiresAt !== "number") continue;
    put(c.left, expiresIn(c.expiresAt, now));
    c.left.classList.toggle("soon", c.expiresAt - now < SOON_MS);
  }
}
// Live's "waiting for your yes" line (needs.js, through app.js): the Dashboard module's first card comes into view, takes
// the focus and is ringed for a moment, so the owner's eye lands on it; nothing is confirmed
export function focusReadback() {
  const m = live().find((x) => !x.compact);
  const c = m && m.cards.values().next().value;
  if (!c) return;
  c.li.scrollIntoView({ behavior: ms("slow") ? "smooth" : "auto", block: "center" });
  c.li.focus({ preventScroll: true });
  c.li.classList.add("as-rb-ring");
  setTimeout(() => c.li.classList.remove("as-rb-ring"), 1600);
}

const msgs = () => (A && Array.isArray(A.messages) && A.messages) || [];
// Recent (the Dashboard only): the newest 5 of the settled history and of the lines HQ noted on its own, with their
// outcome, what each was and how long ago (assistant-rules.js recentFeed), written again only when one of those words
// changed; none, no list
const recentEl = (x) => el("li", { class: "as-rec-i" },
  el("b", { class: "as-rec-o t-" + x.tone }, x.outcome, x.reason === null ? [" (", mask(), ")"] : x.reason ? ` (${x.reason})` : null, ":"),
  el("span", { class: "as-rec-w" }, x.what === null ? mask() : x.what),
  el("span", { class: "as-rec-a", text: x.ago }));
function drawRecent(m, on) {
  if (!m.recent) return;
  const lines = recentFeed(history, msgs(), Date.now(), { streamer: on });
  const k = JSON.stringify(lines);
  if (m.recentKey === k) return;
  m.recentKey = k;
  prop(m.recent, "hidden", !lines.length);
  m.recentList.replaceChildren(...lines.map(recentEl));
}

// The conversation, its rows kept by message id and written in place; true when a row came, went or changed. In the
// Dashboard the lines HQ noted on its own are in Recent, so the conversation is the owner's words, its replies and its
// sends; the glass panel has no Recent and keeps them.
function drawLog(m, on) {
  const all = msgs(), list = m.compact ? all : all.filter((x) => x.role !== "system");
  if (!list.length) {
    const had = m.rows.size > 0;
    m.rows.clear();
    if (!m.log.firstChild || m.log.firstChild.className !== "as-empty") m.log.replaceChildren(el("li", { class: "as-empty", text: EMPTY }));
    return had;
  }
  const next = new Map();
  let changed = list.length !== m.rows.size;
  for (const x of list) {
    const k = JSON.stringify([x.role, x.text, x.name || null, on]);
    const r = m.rows.get(x.id);
    if (!(r && r.k === k)) changed = true;
    next.set(x.id, r && r.k === k ? r : { k, li: msgEl(x) });
  }
  place(m.log, next);
  m.rows = next;
  return changed;
}

// Puts each row's node in order under the list, moving only what moved; what is left after them is gone from the list
function place(list, rows) {
  let at = list.firstChild;
  for (const r of rows.values()) {
    if (r.li === at) at = at.nextSibling;
    else list.insertBefore(r.li, at);
  }
  while (at) { const n = at.nextSibling; at.remove(); at = n; }
}

// --- the box, the mic and their one-line hint ---
let sending = false, offing = false, micVia = null, noteText = "", noteTimer = 0;
function syncCompose(m) {
  const can = canAnswer();
  prop(m.ta, "disabled", !can);
  prop(m.go, "disabled", !can || sending || !m.ta.value.trim());
  prop(m.mic, "hidden", !can || !canListen());
  attr(m.mic, "aria-pressed", String(!!micVia));
  put(m.micT, micVia === "open" ? "Mic on" : "Talk");
  const voice = micVia === "open" && !m.compact;
  m.box.classList.toggle("as-voice", voice);
  if (voice && !m.stopWave) m.stopWave = mountWave(m.canvas, levels, m.box);
  else if (!voice && m.stopWave) {
    m.stopWave();
    m.stopWave = null;
  }
  put(m.hint, !can ? NO_CONTROL : noteText || (micVia === "key" ? "Listening. Let go of Ctrl+Space to send"
    : micVia ? "Mic is open: just talk, it answers out loud. Press Mic on to close it" : m.compact ? "" : canListen() ? "Enter sends. Press Talk for an open mic" : "Enter sends, Shift+Enter for a new line"));
}
const syncAll = () => { for (const m of live()) syncCompose(m); };
// a line in the hint for 6 s, in place of what it says
function note(text) {
  noteText = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { noteText = ""; syncAll(); }, 6000);
  syncAll();
}
const boxes = (text) => { for (const m of live()) { m.ta.value = text; syncCompose(m); } };

// A message to the assistant: on success the box empties; on a failure the words stay in it, so nothing is lost
async function say(text, { reconsider = false } = {}) {
  text = String(text || "").trim().slice(0, SAY_MAX);
  if (!text || sending || !canAnswer()) return;
  sending = true;
  ack(); // a filler plays the moment the owner's words go, while the assistant works on its answer
  syncAll();
  const ok = await post("/api/say", reconsider ? { text, reconsider: true } : { text });
  sending = false;
  if (ok) {
    boxes("");
    for (const m of live()) m.toEnd = true;
    hooks.refresh();
  } else {
    boxes(text);
    note(A ? "Did not send. Try again in a moment" : "The assistant is off, so this did not send"); // off: /api/say is a 503
  }
  syncAll();
}

async function answer(id, confirm) {
  if (answering.get(id) === "sending") return;
  if (confirm && !mayConfirm(readbacks, id, streaming())) return;
  answering.set(id, "sending");
  for (const m of live()) drawCards(m, streaming());
  const ok = await post("/api/readback", { id, confirm });
  if (ok) hooks.refresh(); // its card stays, its buttons off, until the payload drops it
  else answering.set(id, "failed");
  for (const m of live()) drawCards(m, streaming());
}

// The Stop button: the turn that runs ends, the owner's waiting words and its read-backs are dropped, and the voice
// goes quiet
let halting = false;
async function halt() {
  if (halting) return;
  halting = true;
  hush();
  const ok = await post("/api/say", { stop: true });
  halting = false;
  if (ok) hooks.refresh();
  else note("Did not stop. Try again");
}

async function windowOff() {
  if (offing) return;
  offing = true;
  for (const m of live()) drawChip(m);
  const ok = await post("/api/window", { off: true });
  offing = false;
  if (ok) hooks.refresh();
  else note("The window did not turn off. Try again");
  for (const m of live()) drawChip(m);
}

// The window's countdown and each card's time left move each second while a window is open or a read-back waits, and
// the panel is somewhere on the page
let tick = 0;
function ticker() {
  const want = (win.open || readbacks.length > 0) && mounts.size > 0;
  if (want && !tick) tick = setInterval(() => { for (const m of live()) { drawChip(m); drawLeft(m); } ticker(); }, 1000);
  else if (!want && tick) { clearInterval(tick); tick = 0; }
}

// What the mic heard: a lone yes or cancel answers the one fresh read-back, two waiting send the owner to the buttons,
// and anything else goes to the assistant (assistant-rules.js spokenAnswer). Its interim words show in the box as they
// come. On the open mic phrases can come faster than a send, so each waits for the one before instead of being dropped.
let saying = Promise.resolve();
setVoiceHooks({
  interim: (text) => boxes(text),
  // how, from the open mic: new words end a turn still thinking on the last ones (reconsider); cut: a reply was talked
  // over
  final: (text, heardFrom, how) => {
    const r = spokenAnswer(text, readbacks, Date.now(), { streamer: streaming(), heardFrom });
    if (r.kind === "say") return (saying = saying.then(() => say(how && how.cut ? "(I cut you off) " + text : text, { reconsider: !!how })));
    boxes("");
    if (r.kind === "refuse") return note(r.note);
    answer(r.id, r.yes);
  },
  mic: (on, via) => {
    micVia = on ? via : null;
    syncAll();
    if (on) post("/api/say", { warm: true }); // the owner's words are coming, so the assistant is up before they are
  },
  note,
});

// A Streamer toggle draws every part again at once, masked or not
onStreaming(() => {
  for (const m of live()) {
    m.rows.clear();
    m.cards.clear();
    m.recentKey = null;
    m.log.replaceChildren();
    m.rbs.replaceChildren();
    draw(m);
  }
});
