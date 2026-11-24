// The chat modal: a click on a live session opens its chat in one card centered over the dimmed room (or the
// Dashboard), in the page's light or dark theme, laid out around what is left for the owner, top to bottom: a banner
// from the reply's Status line; Needs your answer (its open requests, answered right here, needs.js, and the desktop
// app's ask with a button per action); Your to-do (the reply's Next steps, each with a Done button that tells the
// chat); Claude's message (the reply that ended a turn, whole, in its light formatting; while the chat works, the one
// before it stays); the box to reply to it; and Show the work, folded until asked for:
// What it did (what the owner typed, what the chat said, each tool step with a check once it finished, the agents it
// sent off; folded to the last 6 entries, with Show all). Esc or a click on the dimmed room closes it and leaves the
// chat working. The feed comes from /api/chat/<id> once a second while the panel shows and the page is visible, kept by
// entry number so a second that adds nothing moves nothing; the header and the agents follow every /api/hq payload
// (app.js), and a poll that changes nothing writes nothing, so a button never loses the focus to one. Every string is
// set as text (el()), a reply's light formatting (paragraphs, lists, bold, code) included. Under Streamer the title and
// the agents' names are the mask, names in step labels are masked in place, and what the owner and the chat wrote is
// hidden; a closed panel keeps none of the chat's text.
import { el } from "./dom.js";
import { usd, dur, clock, count, countdown, tokens, STATUS, mdInline, mdBlocks, statusOf } from "./format.js";
import { MASK, shown, streaming, onStreaming, splitNames } from "./streamer.js";
import { renderChatAsks, needsOf } from "./needs.js";
import { canPrompt, PROMPT_MAX } from "./prompt.js";
import { canAnswer, canReply, post } from "./control.js";
import { ctxWarn, cacheWarn, stuckWarn } from "./warn.js";
import { canListen, dictate } from "./voice.js";

const POLL_MS = 1000;
const HIDDEN = "Hidden while streaming";
const HINT = "Enter sends it to this chat, Shift+Enter for a new line";
const DONE_HINT = "Done tells Claude you finished that step";
const CUT = "The rest of this reply is in the chat itself."; // under a reply the server cut (lib/chat.js SAID_MAX)
// What the box says for each state of the chat's inbox (sendState)
const HINTS = {
  ready: HINT,
  hold: "It is working: your message goes in when this reply ends. " + HINT,
  pending: "Your message waits for this chat to end its reply",
  deaf: "This chat can hear VibeQuarters after its next reply ends. It restarted, or was quiet before VibeQuarters began to listen",
  off: "",
};
let ui = null;
let openId = null, lastFocus = null, timer = 0, pollSeq = 0, hintTimer = 0;
let gen = null, ver = -1, data = null, gone = false, waits = false;
let sending = false, expect = null; // a send in flight; the chat and delivery time a sent message waits to see change
let last = null, known = []; // the last payload and the names the page masks (dashboard.js namesOf)
const nodes = new Map(); // entry number -> its element

const host = () => document.fullscreenElement || document.body; // in full screen only the full screen element shows
const name = (text, tag = "span") => el(tag, { class: streaming() ? "masked" : null, text: shown(text) });
const masked = (text) => (streaming() ? splitNames(text, known).map((p) => (p.masked ? el("span", { class: "masked", text: MASK }) : p.text)) : [text]);
const sessionOf = (id) => (last && id ? last.sessions.find((s) => s.id === id) : null) || null;
// Writes made only when they change something, so a poll that changes nothing writes nothing
const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
const setHidden = (n, v) => { if (n.hidden !== v) n.hidden = v; };
const setOff = (n, v) => { if (n.disabled !== v) n.disabled = v; };
const setAttr = (n, k, v) => { if (n.getAttribute(k) !== v) n.setAttribute(k, v); };
// A node's children, built again only when the key of what they show changes
function keyed(n, key, make) {
  if (n.cpKey === key) return;
  n.cpKey = key;
  n.replaceChildren(...make());
}
const unkey = (n) => { n.cpKey = undefined; n.replaceChildren(); };

function build() {
  ui = {
    dot: el("i", { class: "cp-dot" }), title: el("h2", { class: "cp-title", id: "cp-title" }), meta: el("p", { class: "cp-meta" }),
    vit: el("span", { class: "cp-vit-t" }), warm: el("button", { type: "button", class: "cp-warm", hidden: true, onclick: toggleWarm }),
    agents: el("div", { class: "cp-agents", hidden: true }),
    typing: el("div", { class: "cp-typing", hidden: true }, el("span", { class: "cp-spin" }), el("span")),
    asks: el("div", { class: "cp-asks" }),
    ta: el("textarea", { class: "cp-ta", rows: "2", maxlength: String(PROMPT_MAX), placeholder: "Reply to Claude", "aria-label": "Reply to Claude" }),
    go: el("button", { type: "button", class: "cp-go", disabled: true, text: "Send", onclick: sendNow }),
    cancel: el("button", { type: "button", class: "cp-cancel", hidden: true, text: "Take back", onclick: takeBack }),
    hint: el("span", { class: "cp-hint", "aria-live": "polite" }),
    talk: el("button", { type: "button", class: "cp-cancel cp-talk", "aria-pressed": "false", hidden: !canListen(), text: "Talk", title: "Say your message: it goes into the box for you to send. Press again to stop", onclick: () => toggleTalk() }),
  };
  // Show the work: What it did, folded behind one button
  ui.feed = el("div", { class: "cp-feed", onscroll: () => { if (atBottom()) ui.jump.hidden = true; } }, ui.typing);
  ui.jump = el("button", { type: "button", class: "cp-jump", hidden: true, text: "Jump to latest", onclick: toBottom });
  ui.all = el("button", { type: "button", class: "cp-all", hidden: true, text: "Show all", onclick: () => fold(!ui.log.classList.contains("all")) });
  ui.more = el("button", { type: "button", class: "cp-more", "aria-expanded": "false", "aria-controls": "cp-work", onclick: () => unfold(ui.work.hidden) });
  ui.work = el("div", { class: "cp-work", id: "cp-work", hidden: true }, ui.all, ui.agents, ui.feed, ui.jump);
  ui.log = el("section", { class: "cp-log" }, ui.more, ui.work);
  // what is left for the owner: the banner, Needs your answer, Your to-do, Claude's message
  Object.assign(ui, {
    banner: el("p", { class: "cp-banner", hidden: true }),
    need: el("p", { class: "cp-fl", text: "Needs your answer" }), blocked: el("p", { class: "cp-blocked", text: "Blocked on you" }),
    ask: el("p", { class: "cp-ask" }), recap: el("p", { class: "cp-recap" }), acts: el("div", { class: "cp-acts" }), actsHint: el("p", { class: "cp-acts-hint" }),
    // the list holds the focus once no Done is left in it (refocus)
    steps: el("ol", { class: "cp-steps", tabindex: "-1" }), todoHint: el("p", { class: "cp-todo-hint" }), msgBody: el("div", { class: "cp-msg-body cp-md" }),
  });
  ui.wrap = el("div", { class: "cp-wrap", hidden: true }, ui.blocked, ui.ask, ui.recap, ui.acts, ui.actsHint);
  ui.focus = el("section", { class: "cp-focus", hidden: true }, ui.need, ui.asks, ui.wrap);
  ui.todo = el("section", { class: "cp-todo", hidden: true }, el("h3", { class: "cp-h", text: "Your to-do" }), ui.steps, ui.todoHint);
  ui.msg = el("section", { class: "cp-msg", hidden: true }, el("h3", { class: "cp-h", text: "Claude's message" }), ui.msgBody);
  ui.compose = el("div", { class: "cp-compose" }, el("div", { class: "cp-box" }, ui.ta, el("div", { class: "cp-bar" }, ui.hint, ui.cancel, ui.talk, ui.go)));
  ui.root = el("section", { class: "cp", role: "dialog", "aria-modal": "true", "aria-labelledby": "cp-title" },
    el("header", { class: "cp-head" },
      el("div", { class: "cp-1" }, ui.dot, ui.title, el("span", { class: "cp-x" }, el("kbd", { text: "Esc" }), " closes, it keeps working",
        el("button", { type: "button", class: "cp-close", "aria-label": "Close", text: "×", onclick: closeChat }))),
      ui.meta, el("p", { class: "cp-vit" }, ui.vit, ui.warm)),
    ui.banner, ui.focus, ui.todo, ui.msg, ui.compose, ui.log);
  ui.scrim = el("div", { class: "cp-scrim", onclick: closeChat });
  ui.ta.addEventListener("input", sync);
  ui.ta.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if (!ui.go.disabled) sendNow();
  });
}

// --- the composer: the text goes to this chat from HQ (server.js /api/send), through the waiter that listens for it
// (bridge/hq-inbox.js); the payload's inbox says whether one listens, whether a message waits, and when one arrived ---
function sendState() {
  const s = sessionOf(openId), ib = last && last.inbox;
  if (!s || !ib || gone) return "off";
  if (ib.pending.includes(openId)) return "pending";
  if (ib.listening.includes(openId)) return "ready";
  return s.status === "working" || s.status === "thinking" ? "hold" : "deaf";
}
const deliveredAt = (id) => (last && last.inbox && last.inbox.delivered[id]) || null;
function sync() {
  const st = sendState();
  setOff(ui.go, sending || !ui.ta.value.trim() || (st !== "ready" && st !== "hold"));
  setHidden(ui.cancel, st !== "pending");
  const d = deliveredAt(openId);
  if (expect && expect.id === openId && d && d !== expect.at) {
    expect = null;
    say("Delivered. The chat has your message");
  }
  if (!hintTimer) setText(ui.hint, st === "ready" && waits ? "It finished and waits for your reply. " + HINT : HINTS[st]);
  if (data) drawFocus(data); // the wrap's buttons and the Done buttons follow the same inbox state and the same send in flight
}
// One send for the box, the wrap's buttons and the Done buttons alike: the sending flag guards them all, a button's text
// never goes out under Streamer, and only the box's text is cleared. True once the server took it
async function sendText(text, fromBox) {
  const id = openId;
  if (!id || !text || sending || (fromBox ? ui.go.disabled : offFor(text) || streaming())) return false;
  sending = true;
  sync();
  const at = deliveredAt(id);
  const ok = await post("/api/send", { sessionId: id, text });
  sending = false;
  if (openId !== id) return false;
  if (ok) {
    if (fromBox) ui.ta.value = "";
    expect = { id, at };
    say(sendState() === "ready" ? "Sent" : "Sent. It goes in when this reply ends");
  } else say("Not sent. Try again in a moment");
  sync();
  return !!ok;
}
const sendNow = () => {
  if (!talk) return sendText(ui.ta.value.trim(), true);
  talk.send = true;
  stopTalk();
};
// Talk: spoken words go into the box after what is typed there, as they are said (voice.js dictate); the owner reads them
// and sends, or presses Talk again to stop. Stop and Send turn the mic off and the last words still come, seconds later
// with local hearing (hear.js), so a Send goes once they are in. Closing the chat or opening another drops what is left.
let talk = null; // { base, send } from the press until the last words are in
function toggleTalk() {
  if (talk) return stopTalk();
  const mine = { base: ui.ta.value.trim(), send: false };
  const r = dictate(
    (t) => { if (talk === mine) { ui.ta.value = [mine.base, t].filter(Boolean).join(" "); sync(); } },
    (why) => {
      if (why) say(why);
      if (talk !== mine) return;
      talk = null;
      paintTalk();
      if (mine.send && !why) sendText(ui.ta.value.trim(), true);
    },
  );
  if (r !== "started") return say(r);
  talk = mine;
  paintTalk();
  say("Listening. Say your message, then press Send");
  ui.ta.focus();
}
function stopTalk() {
  say(talk.send ? "Getting your last words, then it sends" : "Getting your last words");
  dictate(); // stops it
}
function endTalk() {
  if (!talk) return;
  talk = null;
  dictate(); // stops it
  paintTalk();
}
function paintTalk() {
  ui.talk.textContent = talk ? "Stop" : "Talk";
  ui.talk.setAttribute("aria-pressed", String(!!talk));
  ui.talk.classList.toggle("on", !!talk);
}
async function takeBack() {
  const id = openId;
  if (!id) return;
  const ok = await post("/api/send", { sessionId: id, cancel: true });
  if (openId !== id) return;
  if (ok) expect = null;
  say(ok ? "Taken back. The chat will not get it" : "Too late to take back: it may have gone in");
  ui.ta.focus(); // Take back hides itself, which would drop the focus out of the box
}
function say(text) {
  clearTimeout(hintTimer);
  ui.hint.textContent = text;
  hintTimer = setTimeout(() => { hintTimer = 0; sync(); }, 6000);
}

// --- what is left for the owner (lib/chat.js focusOf): the banner from the reply's Status line, the turn's own ask (a desktop-app
// wrap) with a button per action, Your to-do and Claude's message. Each is rebuilt only when what it shows changes, so a
// poll never takes the focus from a button ---
const reach = () => canPrompt(openId) && canReply(); // the reply box shows, so HQ can send to this chat
const offFor = (text) => { const st = sendState(); return sending || (st !== "ready" && st !== "hold") || text.length > PROMPT_MAX || !reach(); };
// a reply's light formatting as text nodes: bold, code, and a link as its label with its address beside it
const parts = (ps) => ps.map((p) => (p.b != null ? el("b", { text: p.b }) : p.code != null ? el("code", { text: p.code }) : p.link != null ? el("span", {}, p.link, el("span", { class: "cp-url", text: ` (${p.url})` })) : p.t));
const inline = (t) => parts(mdInline(t));
const blocks = (text) => mdBlocks(text).map((b) =>
  b.k === "p" ? el("p", { class: b.head ? "cp-hd" : null }, parts(b.parts))
  : b.k === "pre" ? el("pre", { text: b.text })
  // a table scrolls sideways inside its own box when it is wider than the message
  : b.k === "table" ? el("div", { class: "cp-table" }, el("table", {},
      el("thead", {}, el("tr", {}, b.head.map((c) => el("th", { scope: "col" }, parts(c))))),
      el("tbody", {}, b.rows.map((r) => el("tr", {}, r.map((c) => el("td", {}, parts(c))))))))
  : el(b.k, b.k === "ol" && b.start !== 1 ? { start: String(b.start) } : {}, b.items.map((it) => el("li", {}, parts(it)))));
// The reply the window follows (lib/chat.js focusOf): the one that ended a turn. The latest turn's reply counts once
// the chat stops working; while it works (or thinks), its newest text may be narration ("Let me check."), so Your
// to-do, Claude's message and the Status line stay those of the reply that ended the turn before, and the banner says
// it is working
const WORKING = { tone: "think", text: "Claude is working" };
const working = () => { const s = sessionOf(openId); return !!s && !gone && (s.status === "working" || s.status === "thinking"); };
function replyIn(f) {
  if (f.n != null && !working()) return { n: f.n, left: f.left, status: f.status };
  return f.before || null;
}
// Your to-do, kept with its Done marks while it comes from the same reply: a Done the owner sends starts a turn, and the
// list stays until the reply that ends it replaces it
let focusKey = null, todoKey = null, msgKey = null, todo = null; // todo: { gen, from (the reply's entry number), steps, done (indexes) }
function stepsOf(c, r) {
  if (!r || !r.left.length) return (todo = null);
  if (!todo || todo.gen !== c.gen || todo.from !== r.n || JSON.stringify(todo.steps) !== JSON.stringify(r.left)) todo = { gen: c.gen, from: r.n, steps: r.left, done: new Set() };
  return todo;
}
function drawFocus(c) {
  const f = c.focus || { wrap: null, left: [], status: null, last: null, n: null, before: null }, w = f.wrap, hide = streaming();
  const r = replyIn(f);
  const said = (r && c.entries.find((e) => e.k === "said" && e.n === r.n)) || null;
  const t = stepsOf(c, r);
  const rs = statusOf(r && r.status);
  const st = working() ? WORKING : rs;
  const sub = working() ? rs : null; // while it works, the last reply's Status line sits under "Claude is working"
  const key = JSON.stringify([w, st, sub, hide, sendState(), sending, reach()]);
  if (key !== focusKey) {
    focusKey = key;
    const put = (n, s) => { n.hidden = !s; n.textContent = s ? (hide ? HIDDEN : s) : ""; };
    ui.banner.hidden = !st;
    ui.banner.dataset.tone = (st && st.tone) || "plain";
    ui.banner.replaceChildren(...(st ? (hide ? [HIDDEN] : [...inline(st.text), ...(sub ? [el("span", { class: "cp-banner-st" }, "Status: ", ...inline(sub.text))] : [])]) : []));
    ui.wrap.hidden = !w;
    if (w) {
      const acts = w.actions.map((a) => ({ label: a.label, text: a.message || a.label }));
      ui.blocked.hidden = !w.blocked;
      put(ui.ask, w.ask);
      put(ui.recap, w.recap);
      ui.acts.hidden = hide || !acts.length;
      ui.acts.replaceChildren(...(hide ? [] : acts.map((a) => el("button", { type: "button", class: "cp-act", text: a.label, disabled: offFor(a.text), onclick: () => sendText(a.text, false) }))));
      ui.actsHint.hidden = !acts.length;
      ui.actsHint.textContent = hide ? "Turn Streamer off to answer" : acts.some((a) => a.text.length > PROMPT_MAX) ? "Too long to send from VibeQuarters" : !reach() ? "VibeQuarters cannot send to this chat" : HINTS[sendState()];
    }
  }
  // Your to-do: its rows are built again only when its steps, a step's Done mark or Streamer change, so a send in flight
  // never takes the keyboard focus from a Done button; their disabled state and the line under them follow it in place
  const tk = JSON.stringify([t && [t.steps, [...t.done]], hide]);
  if (tk !== todoKey) {
    const li = ui.steps.contains(document.activeElement) ? document.activeElement.closest("li") : null;
    const at = li ? [...ui.steps.children].indexOf(li) : -1; // the row that holds the focus, kept on its place
    todoKey = tk;
    ui.todo.hidden = !t;
    ui.steps.replaceChildren(...(t ? t.steps.map((s, i) => stepRow(t, s, i, hide)) : []));
    if (at >= 0) refocus(at);
  }
  for (const b of ui.steps.querySelectorAll(".cp-done")) setOff(b, hide || offFor(b.cpText));
  const ss = sendState();
  setText(ui.todoHint, !t ? "" : hide ? "Turn Streamer off to answer" : !reach() ? "VibeQuarters cannot send to this chat"
    : ss === "ready" ? DONE_HINT : ss === "hold" ? DONE_HINT + ". It goes in when this reply ends" : HINTS[ss] || "VibeQuarters cannot send to this chat");
  // Claude's message: that reply, whole; a new one shows from its top
  const mk = JSON.stringify([said && [said.n, said.text, !!said.cut], hide]);
  if (mk !== msgKey) {
    const fresh = !msgKey || JSON.parse(msgKey)[0]?.[0] !== (said && said.n);
    msgKey = mk;
    ui.msg.hidden = false;
    ui.msgBody.replaceChildren(...(!said ? [el("p", { class: "muted", text: "No finished reply VibeQuarters can read for this chat yet." })] : hide ? [el("p", { class: "muted", text: HIDDEN })]
      : [...blocks(said.text), ...(said.cut ? [el("p", { class: "muted cp-cut", text: CUT })] : [])]));
    if (fresh) ui.msg.scrollTop = 0;
  }
  fit();
}
// One step of Your to-do: its number (a check once its Done went out), its text, and its Done button, which sends
// "Done: <the step>" to the chat as the wrap's buttons send theirs, and is off for the same reasons and under Streamer
function stepRow(t, s, i, hide) {
  const sent = t.done.has(i);
  let b = null;
  if (!sent) {
    b = el("button", { type: "button", class: "cp-done", text: "Done", "aria-label": `Done with step ${i + 1}`, onclick: () => markDone(t, i) });
    b.cpText = "Done: " + s; // what it sends, which offFor measures (drawFocus sets disabled in place)
  }
  return el("li", { class: sent ? "cp-row is-done" : "cp-row" },
    el("span", { class: "cp-num", "aria-hidden": "true", text: sent ? "✓" : String(i + 1) }),
    el("span", { class: "cp-row-t" }, ...(hide ? [HIDDEN] : inline(s))),
    sent ? el("span", { class: "cp-sent", text: "Sent" }) : b);
}
// The keyboard focus back in the to-do after its rows changed: on row i's Done, else the next row's, else an earlier
// row's, else the list itself
function refocus(i) {
  const rows = [...ui.steps.children], btn = (r) => (r ? r.querySelector(".cp-done") : null);
  const b = btn(rows[i]) || rows.slice(i + 1).map(btn).find(Boolean) || rows.slice(0, i).reverse().map(btn).find(Boolean);
  (b || ui.steps).focus({ preventScroll: true });
}
async function markDone(t, i) {
  if (t !== todo || t.done.has(i) || streaming()) return;
  const ok = await sendText("Done: " + t.steps[i], false);
  if (t !== todo) return;
  if (ok) t.done.add(i);
  if (data) drawFocus(data);
  // a button the send turned off lets the focus fall out of the window: it comes back to this step, or the next one
  const a = document.activeElement;
  if (!a || a === document.body || ui.todo.contains(a)) refocus(i);
}
// Needs your answer heads the open cards and the wrap, and hides with neither
function fit() {
  const f = data && data.focus;
  setHidden(ui.focus, !(ui.asks.childElementCount > 0) && !(f && f.wrap));
}
function clearFocus() {
  focusKey = todoKey = msgKey = null;
  todo = null;
  for (const n of [ui.banner, ui.ask, ui.recap, ui.acts, ui.actsHint, ui.steps, ui.todoHint, ui.msgBody]) n.replaceChildren();
  ui.banner.hidden = ui.wrap.hidden = ui.focus.hidden = ui.todo.hidden = ui.msg.hidden = true;
}

// --- the header and its agents, from the payload ---
function head() {
  const s = sessionOf(openId);
  const st = needsOf(openId) > 0 ? "needs-you" : s ? s.status : "idle";
  const live = !!s && !gone;
  const dot = "cp-dot st-" + (live ? st : "idle");
  if (ui.dot.className !== dot) ui.dot.className = dot;
  setText(ui.title, shown(s ? s.title || s.name : "This chat"));
  ui.title.classList.toggle("masked", streaming());
  const now = Date.now();
  const bits = [live ? STATUS[st] : "Not live now", s && s.startedAt ? dur(now - s.startedAt) + " so far" : null, s ? count(s.toolCount, "step") : null, s ? usd(s.cost) : null].filter(Boolean);
  const where = s ? [s.project, s.branch].filter(Boolean) : [];
  keyed(ui.meta, JSON.stringify([bits, where, streaming()]), () => [...bits.map((t) => el("span", { text: t })), ...(where.length ? [el("span", {}, ...where.flatMap((t, i) => (i ? [" / ", name(t)] : [name(t)])))] : [])]);
  const busy = live && (st === "working" || st === "thinking");
  ui.root.classList.toggle("busy", busy);
  setHidden(ui.typing, !busy);
  setText(ui.typing.lastChild, st === "thinking" ? "Thinking" : "Working");
  vitals(s, now);
  agents(s);
}
// Its vitals under the header: how full its context is, its prompt cache, its last check, a run of failed tool calls,
// the spend brake, and the keep-warm switch (a chat the hq-feed mod reports from; server.js /api/warm). The switch is
// one element kept across payloads, so a poll never takes its focus; it waits disabled until the payload shows the flip.
let warmWant = null; // { id, on } while a flip is on its way
const vc = (w) => w && (w.level === "bad" ? "v-red" : "v-warn"); // v-bad is the failed check's amber
function vitals(s, now) {
  const bits = []; // [class, text, a label whose names are masked under Streamer, a title]
  const cw = ctxWarn(s), kw = cacheWarn(s, now), sw = stuckWarn(s, now); // amber or red, with what it means (warn.js)
  if (s && s.context) bits.push([vc(cw), `Context ${s.context.pct}% of ${tokens(s.context.of)}`, null, cw && cw.tip]);
  if (s && s.cache) bits.push(s.cache.state === "warm" ? [vc(kw) || "v-warm", `Cache warm, ${countdown(s.cache.expiresAt - now)} left`, null, kw && kw.tip] : ["v-cold", `Cache cold, waking it costs ${usd(s.cache.wakeCost)}`]);
  if (sw) bits.push([vc(sw), `No new step in ${dur(now - s.lastAt)}`, null, sw.tip]);
  const k = s && s.checks && s.checks[0];
  if (k) bits.push([k.ok ? "v-ok" : "v-bad", k.ok ? "Last check passed: " : "Last check failed: ", k.label]);
  if (s && s.failRun >= 3) bits.push(["v-flag", `${s.failRun} failed in a row, last: `, s.fails[0].label]);
  if (s && s.brake && s.brake.asks) bits.push([null, `Spend brake asked ${count(s.brake.asks, "time")}`]);
  const w = s && s.warm;
  if (w && w.canWarm && w.stopped) bits.push(["v-cold", w.stopped]);
  else if (w && w.canWarm && w.pings) bits.push([null, `Kept warm ${count(w.pings, "time")}`]);
  else if (w && !w.canWarm && s.cache) bits.push(["v-cold", "Keep warm works in chats started after the hq-feed mod was installed"]);
  keyed(ui.vit, JSON.stringify([bits, streaming(), streaming() ? known : null]), () => bits.map(([cls, t, label, title]) => el("span", { class: cls, title }, t, ...(label != null ? masked(label) : []))));
  if (warmWant && (!s || warmWant.id !== s.id || w.on === warmWant.on || now - warmWant.at > 15e3)) warmWant = null; // shown, or given up on
  setHidden(ui.warm, !(w && w.canWarm && canAnswer()));
  setOff(ui.warm, !!warmWant);
  setAttr(ui.warm, "aria-pressed", String(!!(w && w.on)));
  setText(ui.warm, w && w.on ? "Keep warm: on" : "Keep warm: off");
  setHidden(ui.vit.parentNode, !bits.length && ui.warm.hidden);
}
async function toggleWarm() {
  const s = sessionOf(openId);
  if (!s || !s.warm || !s.warm.canWarm || warmWant) return;
  warmWant = { id: s.id, on: !s.warm.on, at: Date.now() };
  ui.warm.disabled = true;
  const ok = await post("/api/warm", { sessionId: s.id, on: warmWant.on });
  if (!ok) { warmWant = null; ui.warm.disabled = false; say("Keep warm did not switch. Try again in a moment"); }
}
function agents(s) {
  const subs = s ? s.subagents : [];
  const doing = new Map(((data && data.agents) || []).map((a) => [a.id, a.action]));
  const on = subs.filter((u) => u.running), off = subs.filter((u) => !u.running);
  const label = (u) => u.description || u.type || "Agent";
  setHidden(ui.agents, !subs.length);
  keyed(ui.agents, JSON.stringify([on.map((u) => [label(u), doing.get(u.id) || null]), off.map(label), streaming(), streaming() ? known : null]), () => (subs.length ? [el("span", { class: "cp-agents-l", text: "Its agents" }),
    ...on.map((u) => el("span", { class: "cp-ag" }, el("i", { class: "dia" }), name(label(u), "b"), doing.get(u.id) ? el("span", { class: "cp-ag-do" }, ...masked(doing.get(u.id))) : null)),
    ...off.slice(0, 3).map((u) => el("span", { class: "cp-ag" }, el("i", { class: "dia off" }), name(label(u)), el("span", { class: "cp-ag-do", text: "done" }))),
    ...(off.length > 3 ? [el("span", { class: "cp-ag" }, el("i", { class: "dia off" }), el("span", { text: `${off.length - 3} more done` }))] : [])] : []));
}

// --- Show the work: the feed ---
// a reply's text as VS Code shows it: paragraphs, bullet and numbered lists, bold and code, every part a text node
const reply = (text) => el("div", { class: "cp-said" }, blocks(text));
function entryNode(e) {
  if (e.k === "you") return el("div", { class: "cp-you" }, el("span", { class: "cp-w", text: e.hq ? "You, from VibeQuarters" : "You" }), streaming() ? el("span", { class: "muted", text: HIDDEN }) : e.text);
  if (e.k === "said") return streaming() ? el("div", { class: "cp-said" }, el("p", { class: "muted", text: HIDDEN })) : reply(e.text);
  return el("div", { class: "cp-step" }, el("span", { class: "cp-mark", "aria-hidden": "true" }), el("span", { class: "cp-label" }, ...masked(e.label)), el("time", { text: clock(e.at) }));
}
// a step that has not finished spins while its chat works (app.css .cp.busy), else it waits quietly
function markStep(n, e) {
  const st = e.error ? "bad" : e.done ? "ok" : "open";
  if (n.dataset.st === st) return;
  n.dataset.st = st;
  n.firstChild.textContent = e.error ? "×" : e.done ? "✓" : "";
}
const atBottom = () => ui.feed.scrollHeight - ui.feed.scrollTop - ui.feed.clientHeight < 60;
function toBottom() {
  ui.feed.scrollTop = ui.feed.scrollHeight;
  ui.jump.hidden = true;
}
// What it did shows its last 6 entries (app.css .cp-log:not(.all)); Show all unfolds the rest, Show less folds them again
function fold(all) {
  ui.log.classList.toggle("all", all);
  ui.all.textContent = all ? "Show less" : "Show all";
}
// Show the work unfolds What it did, and Hide the work folds it again; the choice holds while the window stays on this
// chat
function unfold(open) {
  setHidden(ui.work, !open);
  setAttr(ui.more, "aria-expanded", String(open));
  workLabel();
  if (open) {
    toBottom();
    if (ui.root.scrollHeight > ui.root.clientHeight) ui.root.scrollTop = ui.root.scrollHeight; // a full card scrolls to it
  }
}
// The button says how much the work holds: its steps, or its messages when it has no step
function workLabel() {
  const es = (data && data.entries) || [], steps = es.filter((e) => e.k === "step").length;
  setText(ui.more, !ui.work.hidden ? "Hide the work" : "Show the work" + (steps ? ", " + count(steps, "step") : es.length ? ", " + count(es.length, "message") : ""));
}
function clearFeed() {
  nodes.clear();
  ui.feed.replaceChildren(ui.typing);
  gen = null;
  ver = -1;
}
function draw(c) {
  const first = c.gen !== gen;
  if (first) clearFeed();
  if (!first && c.v === ver) return;
  gen = c.gen;
  ver = c.v;
  const stick = first || atBottom();
  const keep = new Set(c.entries.map((e) => e.n));
  for (const [n, node] of nodes) if (!keep.has(n)) { node.remove(); nodes.delete(n); }
  let added = false;
  for (const e of c.entries) {
    let node = nodes.get(e.n);
    if (!node) {
      node = entryNode(e);
      if (!first) node.classList.add("cp-enter");
      nodes.set(e.n, node);
      ui.feed.insertBefore(node, ui.typing);
      added = true;
    }
    if (e.k === "step") markStep(node, e);
  }
  const empty = ui.feed.querySelector(".cp-empty");
  if (!c.entries.length && !empty) ui.feed.prepend(el("p", { class: "cp-empty", text: "No messages VibeQuarters can read for this chat yet." }));
  else if (c.entries.length && empty) empty.remove();
  setHidden(ui.all, c.entries.length <= 6);
  if (stick) toBottom();
  else if (added) ui.jump.hidden = false;
  workLabel();
}

// --- the poll: once a second while the panel shows and the page is visible; a hidden page asks again on its return ---
function startPoll() {
  clearTimeout(timer);
  loop(++pollSeq);
}
async function loop(seq) {
  if (seq !== pollSeq || !openId) return;
  const id = openId;
  if (document.visibilityState === "visible") {
    try {
      const r = await fetch("/api/chat/" + id, { cache: "no-store" });
      const c = r.ok ? await r.json() : null;
      if (seq !== pollSeq) return;
      gone = r.status === 404; // HQ no longer follows it: the feed keeps what it had
      if (c) {
        data = c;
        draw(c);
        drawFocus(c);
      }
    } catch {} // the server is away for a moment: the next second asks again
    if (seq !== pollSeq) return;
    head();
  }
  timer = setTimeout(() => loop(seq), POLL_MS);
}
document.addEventListener("visibilitychange", () => { if (openId && document.visibilityState === "visible") startPoll(); });

// --- open and close ---
export function openChat(id) {
  if (!id) return;
  if (!ui) build();
  if (openId !== id) {
    endTalk(); // the owner's words were for the other chat
    clearFeed();
    fold(false);
    clearFocus();
    data = null;
    gone = false;
    ui.ta.value = "";
    ui.jump.hidden = true;
    unfold(false);
  }
  if (!openId) lastFocus = document.activeElement;
  openId = id;
  const h = host();
  if (ui.root.parentNode !== h) h.append(ui.scrim, ui.root);
  ui.compose.hidden = !canPrompt(id) || !canReply();
  asks();
  head();
  sync();
  requestAnimationFrame(() => { ui.scrim.classList.add("on"); ui.root.classList.add("on"); });
  startPoll();
  setTimeout(() => { if (openId === id) (ui.compose.hidden ? ui.root.querySelector(".cp-close") : ui.ta).focus({ preventScroll: true }); }, 60);
}
export function closeChat() {
  if (!openId) return;
  endTalk();
  openId = null;
  pollSeq++;
  clearTimeout(timer);
  clearTimeout(hintTimer);
  hintTimer = 0;
  ui.root.classList.remove("on");
  ui.scrim.classList.remove("on");
  clearFeed();
  fold(false);
  ui.all.hidden = true;
  clearFocus();
  data = null;
  unfold(false);
  ui.ta.value = "";
  ui.title.replaceChildren();
  for (const n of [ui.meta, ui.agents, ui.vit]) unkey(n);
  renderChatAsks(ui.asks, null);
  if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}
export const chatOpen = () => openId;
function asks() {
  waits = renderChatAsks(ui.asks, openId);
  fit();
}

// Every payload on either tab (app.js): the header, the agents and the open requests follow it now
export function chatPayload(hq, names = []) {
  last = hq;
  known = names;
  if (!openId) return;
  asks();
  head();
  sync();
}

// Escape closes the panel (an Ask for changes box closes alone, needs.js); Tab stays inside it. The Needs you popup, when
// it shows over the panel, takes its keys first (its listener is earlier), so these only act while focus is in the panel.
addEventListener("keydown", (e) => {
  if (!openId) return;
  const inside = ui.root.contains(document.activeElement) || document.activeElement === document.body;
  if (!inside) return;
  if (e.key === "Escape") {
    if (e.target.classList && e.target.classList.contains("ask-fix")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    closeChat();
  } else if (e.key === "Tab") {
    const f = [...ui.root.querySelectorAll("button, a[href], input, textarea")].filter((n) => !n.disabled && !n.closest("[hidden]"));
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (i < 0) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
    else if (e.shiftKey && i === 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  }
}, true);
document.addEventListener("fullscreenchange", () => { if (ui && openId) host().append(ui.scrim, ui.root); });
// A Streamer toggle redraws the panel now: its header, its agents, its requests, what is left for the owner and every
// entry of the feed
onStreaming(() => {
  if (!openId) return;
  asks();
  head();
  if (data) {
    const keep = ui.feed.scrollTop;
    clearFeed();
    draw(data);
    ui.feed.scrollTop = keep;
    drawFocus(data);
  }
});
