// Needs you: every open item in the payload's decisions (a permission, a question, a finished turn waiting for a
// reply), in the Dashboard's Live list and in a popup over either tab. In Live a chat's first open permission or
// question puts its buttons on its own row's right, in place of the row's status, so every chat keeps one line (the
// line under the chat's name says what it asks, and the next item takes the place once it goes); a finished turn there
// is no card, since the row opens that chat's pop-up, where the reply is typed; an item whose chat has no row is a card
// in a short list at Live's top. Collapsed, an item is its chip and reason, how long ago, one plain line that starts
// with the asker's name, and its buttons; a click on the line or its chevron opens the detail in place. Agent text is
// set as text only (el()); the only links are vscode:// links to a UUID session, from the server (a reply's Open this
// chat, and a notice's Open in VS Code, which posts nothing); an answer is only ever the owner's click or key, sent
// through the token-gated POST (control.js). A Risky Approve sends only from a second click on the confirm button it
// shows in the same item, which says what will run; a question of any other shape than one one-pick question is a picks
// form with a Send. Under Streamer the name is the mask, the line is the generic one, the detail and the folder are
// hidden, a picks form's questions are numbered with every known name masked in its labels, Approve is disabled with
// its note, the confirm button is gone, and Approve all safe is hidden; Ask for changes stays (it is a deny), and its
// box holds only what the owner types. Live's header carries the count, a line while the assistant waits for a yes (a
// click goes to its card), the Sound and Alerts switches and Approve all safe; the alert lines (an answer HQ did not
// write, an answers log HQ cannot read) sit right under it. A chip's title says why it is Risky or Check first, and its
// card says so after it.
import { el, svg } from "./dom.js";
import { ago } from "./format.js";
import { MASK, shown, streaming, onStreaming, splitNames } from "./streamer.js";
import { canAnswer, canReply, answersNote, post } from "./control.js";
import { GUARD_MS, ordered, safeBatch, buttonsOf, itemNote, keyChoice, noteOf, alertParts, needsConfirm, emptyPicks, pickOption, picksReady, chipWords, NOTE_MAX, NOTE_HINT, TITLE, HIDDEN } from "./asks.js";
import { waitingLine } from "./assistant-rules.js";

const SESSION_LINK = /^vscode:\/\/anthropic\.claude-code\/open\?session=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHEVRON = "M4 6l4 4 4-4";
let items = []; // the open items, in queue order, from the last payload
let alerts = []; // the payload's alerts, newest first
let known = []; // the names the page masks (dashboard.js namesOf), for a question's option labels under Streamer
let yesWaits = 0; // the assistant's read-backs waiting for the owner's yes (the payload's readbacks), for Live's header line
const answered = new Set(); // answered from this page, until the payload drops them
const skipped = new Set(); // passed over (Later, an Open in VS Code link, Escape, the close button) since the popup last opened
// refresh: a new poll at once; toReadback: the Assistant module's first read-back card comes into view (app.js)
let hooks = { refresh: () => {}, toReadback: () => {} };
export const setNeedsHooks = (h) => { hooks = { ...hooks, ...h }; };
// How many open items a chat has: the chat pop-up reads its status from it
export const needsOf = (sessionId) => items.filter((d) => d.sessionId === sessionId).length;
// What a chat waits on the owner for, from its first open item in queue order: an approval (a permission, a plan, a
// notice), an answer (a question) or a reply (a finished turn); null when nothing of it is open
export function wantOf(sessionId) {
  const d = items.find((x) => x.sessionId === sessionId);
  return !d ? null : d.kind === "question" ? "answer" : d.kind === "reply" ? "reply" : "approval";
}
// Live's order: the chats with an open item first, in the queue order of their first item (permissions, then questions,
// then replies, oldest first), then the rest as the server sent them, so what needs the owner is always at Live's top
export function attentionFirst(sessions) {
  const rank = new Map();
  items.forEach((d, i) => rank.has(d.sessionId) || rank.set(d.sessionId, i));
  const at = (s) => rank.get(s.id) ?? items.length;
  return sessions.slice().sort((a, b) => at(a) - at(b));
}
// Live's header's own switches (alerts.js: Sound and Alerts), kept for whenever the header is built
const controls = [];
export function addRailControl(...nodes) {
  controls.push(...nodes);
  if (rail) rail.ctl.append(...nodes);
}
// Text and the hidden flag are written only when they change, so a poll that changes nothing mutates nothing
const put = (n, t) => { if (n.textContent !== t) n.textContent = t; };
const hide = (n, v) => { if (n.hidden !== v) n.hidden = v; };

// The payload's items, on every poll on either tab (app.js): the popup follows them now, Live's cards draw with the
// Dashboard
export function setNeeds(hq, names = []) {
  items = ordered(hq.decisions);
  alerts = hq.alerts || [];
  yesWaits = Array.isArray(hq.readbacks) ? hq.readbacks.length : 0;
  known = names;
  syncPop(); // before the prune below: an item answered here and then gone is not "answered in VS Code"
  const ids = new Set(items.map((d) => d.id));
  for (const id of answered) if (!ids.has(id)) answered.delete(id);
  for (const id of skipped) if (!ids.has(id)) skipped.delete(id);
}

// One item's element: kept by id across polls (Live's cards, "rail"), reused for each item (the popup, "pop"), or built
// once for a caller outside both (askItem, "card"); fillAsk writes it
function makeAsk(mode) {
  const a = {
    pop: mode === "pop", rail: mode === "rail", d: null, open: false, status: null, busy: false, buttons: [], wellKey: null, btnKey: null, shownAt: Date.now(),
    picks: null, picksFor: null, formKey: null, confAt: 0,
    chip: el("span", { class: "ask-chip" }), why: el("span", { class: "ask-why" }), time: el("time", { class: "ask-time" }),
    who: el("b"), what: el("span", { class: "ask-what" }),
    well: el("div", { class: "ask-well scroll" }), where: el("p", { class: "ask-where" }),
    form: el("div", { class: "ask-picks", hidden: true }),
    btns: el("div", { class: "ask-btns" }), note: el("p", { class: "ask-note", "aria-live": "polite", hidden: true }),
  };
  // A Risky Approve's second click: one button saying what will run, shown under the item's buttons by the first
  a.conf = el("button", { type: "button", class: "ask-btn primary ask-conf", hidden: true, onclick: () => confirmRisky(a) });
  // Ask for changes: one line the owner types, sent as the note of a deny (Enter sends, Escape closes the box alone)
  a.fix = el("input", { type: "text", class: "ask-fix", maxlength: String(NOTE_MAX), autocomplete: "off", hidden: true,
    placeholder: "What should change? Enter sends, Esc cancels", "aria-label": "What should change", onkeydown: (e) => fixKey(a, e) });
  a.line = el("button", { type: "button", class: "ask-line", "aria-expanded": "false", onclick: () => toggle(a) },
    a.who, " ", a.what, svg("svg", { class: "ask-chev", viewBox: "0 0 16 16", "aria-hidden": "true" }, svg("path", { d: CHEVRON })));
  a.more = el("div", { class: "ask-more", hidden: true }, a.well, a.where);
  a.root = el(mode === "rail" ? "li" : "div", { class: "ask" }, el("p", { class: "ask-head" }, a.chip, a.why, a.time), a.line, a.more, a.form, a.btns, a.conf, a.fix, a.note);
  return a;
}
function toggle(a) {
  a.open = !a.open;
  hide(a.more, !a.open);
  a.line.setAttribute("aria-expanded", String(a.open));
}

// Writes one item: its text, its picks form, then its buttons (Send off until each question has a pick), its confirm
// button (gone once Approve is not there to send, under Streamer, or answered) and its note
function fillAsk(a, d, now) {
  const on = streaming(), done = answered.has(d.id);
  fillText(a, d, now);
  let offered = buttonsOf(d, { control: canReply(), streaming: on, popup: a.pop });
  const form = offered.some((b) => b.key === "picks");
  // a picks form has no room in a Live row: there the row hides it and its Send, and Answer opens the popup on the item
  if (form && a.rail) offered = [...offered, { key: "answer", label: "Answer", n: null, primary: true, disabled: false, href: null }];
  if (form && a.picksFor !== d.id) Object.assign(a, { picks: emptyPicks(d), picksFor: d.id, formKey: null });
  fillPicks(a, form ? d : null, done);
  fillButtons(a, offered.map((b) => (done && !b.href ? { ...b, disabled: true } : b.key === "picks" && !picksReady(d, a.picks) ? { ...b, disabled: true } : b)));
  if (done || on || !needsConfirm(d) || !a.buttons.some((b) => b.key === "allow" && !b.disabled)) quietConf(a);
  put(a.note, a.status || (done ? "" : itemNote(d, offered, on)));
  hide(a.note, !a.note.textContent);
}
// A picks form: each question (numbered under Streamer, which masks every known name in its option labels) with its
// options as buttons that are pressed or not; a click picks (pickOption) and writes the item again. Built again only
// when the questions, Streamer, the masked names or the answered state change, so a pick keeps focus on its button and
// only moves aria-pressed; with no form, empty and hidden.
function fillPicks(a, d, done) {
  const on = streaming();
  const formKey = d ? JSON.stringify([d.id, d.questions, done, on, on ? known : []]) : null;
  if (formKey !== a.formKey) {
    a.formKey = formKey;
    hide(a.form, !d);
    if (!d) return a.form.replaceChildren();
    const label = (t) => (on ? splitNames(t, known).map((p) => (p.masked ? el("span", { class: "masked", text: MASK }) : p.text)) : [t]);
    a.form.replaceChildren(...d.questions.map((q, i) => el("fieldset", { class: "ask-q" },
      el("legend", {}, on ? `Question ${i + 1}` : q.question, el("span", { class: "muted", text: q.multiSelect ? " (one or more)" : " (one)" })),
      el("div", { class: "ask-opts" }, ...q.options.map((o, k) => el("button", {
        type: "button", class: "ask-opt", "aria-pressed": "false", disabled: done, onclick: () => pick(a, i, k),
      }, ...label(o.label)))))));
  }
  if (!d) return;
  a.form.querySelectorAll(".ask-q").forEach((q, i) => q.querySelectorAll(".ask-opt").forEach((b, k) => {
    const v = String(a.picks[i].includes(k));
    if (b.getAttribute("aria-pressed") !== v) b.setAttribute("aria-pressed", v);
  }));
}
function pick(a, q, k) {
  const d = a.d;
  if (!d || a.busy || answered.has(d.id) || a.picksFor !== d.id || Date.now() - a.shownAt < GUARD_MS) return;
  a.picks = pickOption(d, a.picks, q, k);
  fillAsk(a, d, Date.now());
}
// An item's buttons, built again only when they or (under Streamer) the masked names change
function fillButtons(a, bs) {
  const btnKey = JSON.stringify(bs) + (streaming() ? "|" + known.join("|") : "");
  if (btnKey === a.btnKey) return;
  a.btnKey = btnKey;
  a.buttons = bs;
  a.btns.replaceChildren(...bs.map((b) => button(a, b)).filter(Boolean));
}
// An item's text. Under Streamer: the masked name, the generic line, "Hidden while streaming" for the detail, no folder
function fillText(a, d, now) {
  const on = streaming();
  a.d = d;
  if (a.root.dataset.id !== d.id) a.root.dataset.id = d.id;
  hide(a.chip, !d.risk);
  hide(a.why, !(d.risk && d.risk.reason));
  if (d.risk) {
    const cls = "ask-chip r-" + d.risk.level, w = chipWords(d.risk);
    if (a.chip.className !== cls) a.chip.className = cls;
    put(a.chip, w.label);
    put(a.why, w.why);
    if (w.title) a.chip.title = w.title;
    else a.chip.removeAttribute("title");
  }
  put(a.time, ago(d.askedAt, now));
  put(a.who, shown(d.who));
  a.who.classList.toggle("masked", on);
  put(a.what, on ? d.generic : d.what);
  const wellKey = on ? HIDDEN : d.detailKind + JSON.stringify(d.detail);
  if (wellKey !== a.wellKey) {
    a.wellKey = wellKey;
    a.well.className = "ask-well scroll" + (on || d.detailKind === "text" ? "" : d.detailKind === "change" ? " mono change" : " mono");
    const mark = (l) => (d.detailKind !== "change" ? null : l.startsWith("+ ") ? "add" : l.startsWith("- ") ? "del" : null);
    a.well.replaceChildren(...(on ? [el("span", { class: "muted", text: HIDDEN })] : d.detail.map((l) => el("span", { class: mark(l), text: l }))));
  }
  put(a.where, on || !d.folder ? "" : "In " + d.folder);
  hide(a.where, !a.where.textContent);
}

// One button: its number key, then its label (a question's option with every known name masked in place under
// Streamer). A link is only a vscode:// link to a UUID session: a reply's Open this chat, or a notice's Open in VS Code,
// which posts nothing and, in the popup, passes the item over.
function button(a, b) {
  const label = streaming() && b.key.startsWith("opt:") ? splitNames(b.label, known).map((p) => (p.masked ? el("span", { class: "masked", text: MASK }) : p.text)) : [b.label];
  const kids = [b.n ? el("kbd", { text: String(b.n) }) : null, ...label];
  const cls = "ask-btn" + (b.primary ? " primary" : "") + (b.key === "allow" ? " ask-approve" : b.key === "picks" ? " ask-send" : b.key === "answer" ? " ask-answer" : "");
  if (b.href) return SESSION_LINK.test(b.href) ? el("a", { class: cls, href: b.href, onclick: b.key === "vscode" ? (e) => inVsCode(a, e) : null }, ...kids) : null;
  return el("button", { type: "button", class: cls, disabled: b.disabled, onclick: () => (b.key === "later" ? later() : b.key === "answer" ? openAsk({ id: a.d.id }) : choose(a, b.key)) }, ...kids);
}
// A notice's Open in VS Code: the link opens its chat, where VS Code is asking now; nothing is sent. It takes no click
// within GUARD_MS of the item coming up, and in the popup it passes the item over, as Later does.
function inVsCode(a, e) {
  if (Date.now() - a.shownAt < GUARD_MS) return e.preventDefault();
  if (a.pop) later();
}

function setStatus(a, text) {
  a.status = text;
  put(a.note, text);
  hide(a.note, false);
}
// Ask for changes opens a one-line box on the item; Enter in it sends the note (choose), Escape closes the box alone
function openFix(a) {
  hide(a.fix, false);
  a.fix.focus();
  return false;
}
function closeFix(a) {
  a.fix.value = "";
  hide(a.fix, true);
  if (a.status === NOTE_HINT) {
    a.status = null;
    if (a.d) fillAsk(a, a.d, Date.now());
  }
}
function fixKey(a, e) {
  if (e.key === "Enter") {
    e.preventDefault();
    const note = noteOf(a.fix.value);
    if (note) choose(a, "revise", note);
    else setStatus(a, NOTE_HINT);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation(); // the box alone: an open row or the room keeps its own Escape
    closeFix(a);
    a.line.focus();
  }
}
// A Risky Approve's first click (or its number key) shows the confirm button, which says what will run; it takes no
// click within GUARD_MS of showing, has no number key, and its click is the only one that sends the allow, with confirm
// (the server refuses a Risky allow without it). quietConf empties and hides it.
function openConf(a) {
  put(a.conf, a.d.confirm || "Yes, approve");
  hide(a.conf, false);
  a.confAt = Date.now();
  return false;
}
function quietConf(a) {
  put(a.conf, "");
  hide(a.conf, true);
  a.confAt = 0;
}
function confirmRisky(a) {
  if (a.conf.hidden || Date.now() - a.confAt < GUARD_MS) return false;
  return choose(a, "allow", undefined, true);
}
// The owner's answer: one POST with the page's token and the hash of the item as shown; the server writes it for the
// waiting chat and logs one line. Ask for changes (a plan's Keep planning) sends only from its box, with its note; a
// Risky Approve only from its confirm button; Send with the picks. An item takes no answer within GUARD_MS of coming up,
// so a click or key meant for the one before it never lands on it. A link is never an answer.
async function choose(a, key, note, confirmed = false) {
  const d = a.d;
  if (!d || a.busy || answered.has(d.id) || Date.now() - a.shownAt < GUARD_MS) return false;
  if (!a.buttons.some((b) => b.key === key && !b.disabled && !b.href)) return false;
  if (key === "revise" && note === undefined) return openFix(a);
  if (key === "allow" && needsConfirm(d) && !confirmed) return openConf(a);
  if (key === "picks" && !picksReady(d, a.picks)) return false;
  a.busy = true;
  setStatus(a, "Sending");
  const extra = key === "revise" ? { note } : key === "picks" ? { picks: a.picks } : key === "allow" && confirmed ? { confirm: true } : {};
  const ok = await post("/api/answer", { id: d.id, choice: key, hash: d.hash, ...extra });
  a.busy = false;
  if (ok) {
    answered.add(d.id);
    a.root.classList.remove("pulse"); // a card in Live stops pulsing once answered here
  }
  if (!a.d || a.d.id !== d.id) return ok; // the popup moved on or closed meanwhile (a poll only brings the same item anew)
  if (!ok) {
    setStatus(a, "Not sent; reload VibeQuarters and try again");
    return false;
  }
  closeFix(a);
  setStatus(a, "Sent");
  fillAsk(a, d, Date.now()); // its buttons go quiet
  if (a.pop) popNext(400);
  hooks.refresh(); // the payload follows now, not at the next poll
  return true;
}

// One item rendered outside Live and the popup (a figure's card), through the same code: its element, written
// for the item as it is now and answered through the same token-gated POST. It is written once; the caller renders it
// again for a newer payload or a Streamer toggle.
export function askItem(d) {
  const a = makeAsk("card");
  fillAsk(a, d, Date.now());
  return a.root;
}

// A box of cards kept by id in `kept`: each item's element written for the item as it is now and placed in the given
// order, and the element of an item that left removed, so a poll that changes nothing moves nothing
function renderCards(box, ds, kept, now) {
  const ids = new Set(ds.map((d) => d.id));
  for (const [id, a] of kept) if (!ids.has(id)) { kept.delete(id); a.root.remove(); }
  let at = box.firstChild;
  for (const d of ds) {
    let a = kept.get(d.id);
    if (!a) kept.set(d.id, (a = makeAsk("card")));
    fillAsk(a, d, now);
    if (a.root === at) at = at.nextSibling;
    else box.insertBefore(a.root, at);
  }
}

// --- the chat pop-up's requests (chat.js): the open permissions and questions of the chat on screen, each the element
// and answer Live's cards have, kept by id in its box. A finished turn is no card there, since the pop-up's own box answers it;
// the return says whether the chat waits for that reply. A null session empties the box. ---
const chatItems = new Map(); // id -> its element in the pop-up
export function renderChatAsks(box, sessionId) {
  const now = Date.now();
  const mine = sessionId ? items.filter((d) => d.sessionId === sessionId) : [];
  const cards = mine.filter((d) => d.kind !== "reply");
  renderCards(box, cards, chatItems, now);
  return mine.some((d) => d.kind === "reply");
}

// --- the room's Live panel (floor/panels.js): every open permission and question, in queue order, kept by id in its
// box; the return is how many there are ---
const openItems = new Map(); // id -> its element in the room's Live panel
export function renderOpenAsks(box) {
  const cards = items.filter((d) => d.kind !== "reply");
  renderCards(box, cards, openItems, Date.now());
  return cards.length;
}

// --- Live's part (#live, the Dashboard): its header's count, switches and Approve all safe, the alert lines under it, the
// short list of items whose chat has no row, and each row's cards (renderRowAsks, for dashboard.js) ---
let rail = null;
const railItems = new Map(); // id -> its card in Live, in its chat's row or in the top list
let rowIds = new Set(); // the chats with a row in the Live list, from the sessions the Dashboard last drew
function buildRail() {
  const live = document.getElementById("live");
  rail = {
    head: live.querySelector(".nh"), n: el("span", { class: "nh-n" }), ctl: el("span", { class: "nh-ctl" }, ...controls),
    alerts: el("ol", { class: "ask-alerts", role: "alert" }), alertLines: new Map(),
    all: el("button", { type: "button", class: "safe-all", hidden: true, onclick: approveSafe }),
    // While the assistant's read-backs wait: one line that takes the owner to the first card in the Assistant module
    yes: el("button", { type: "button", class: "nh-yes", hidden: true, onclick: () => hooks.toReadback() }),
    list: el("ol", { class: "asks scroll", hidden: true }),
  };
  rail.head.querySelector("h2").append(rail.n);
  rail.head.append(rail.yes, rail.ctl, rail.all);
  rail.head.after(rail.list);
  if (answersNote()) rail.list.before(el("p", { class: "ask-note", text: answersNote() }));
  live.addEventListener("keydown", railKey); // a number key on a card, in its row or in the top list
}
// The alert lines, after Live's header, in one alert region. A line is added once, when its alert comes, so a new
// alert is announced and the lines already there are not; its time ("5s ago") sits in an aria-hidden part and moves on
// in place, so a poll that only moves the time announces nothing; a Streamer toggle rewrites its words in place. Text
// is written only when it changes, and there is no list at all when there are none.
function renderAlerts(now) {
  const keys = new Set(alerts.map((x) => JSON.stringify(x)));
  for (const [key, line] of rail.alertLines) if (!keys.has(key)) { rail.alertLines.delete(key); line.li.remove(); } // first, so no line still there moves
  let at = rail.alerts.firstChild;
  for (const x of alerts) {
    const key = JSON.stringify(x), [before, time, after] = alertParts(x, now, streaming());
    let line = rail.alertLines.get(key);
    if (!line) {
      line = { before: document.createTextNode(""), time: el("span", { class: "ask-ago", "aria-hidden": "true" }), after: document.createTextNode("") };
      line.li = el("li", { class: "ask-alert" }, line.before, line.time, line.after);
      rail.alertLines.set(key, line);
    }
    if (line.before.nodeValue !== before) line.before.nodeValue = before;
    put(line.time, time);
    if (line.after.nodeValue !== after) line.after.nodeValue = after;
    if (line.li === at) at = at.nextSibling;
    else rail.alerts.insertBefore(line.li, at);
  }
  if (!alerts.length) return rail.alerts.remove();
  if (!rail.alerts.isConnected) rail.head.after(rail.alerts);
}
// Drawn with the Dashboard (renderDashboard, with the sessions its rows come from) and in place on a Streamer toggle.
// Every card is kept by id and written here; the top list takes those whose chat has no row, in queue order, and each
// row places its own when it draws (renderRowAsks). A finished turn whose chat has a row gets no card.
export function renderRail(now, sessions) {
  if (!rail) buildRail();
  if (sessions) rowIds = new Set(sessions.map((s) => s.id));
  renderAlerts(now);
  put(rail.n, items.length ? `${items.length} ${items.length === 1 ? "needs" : "need"} you` : ""); // worded as the pill says it: a bare number by Live reads as live chats
  hide(rail.yes, !yesWaits);
  if (yesWaits) put(rail.yes, waitingLine(yesWaits));
  const batch = canReply() ? safeBatch(items.filter((d) => !answered.has(d.id)), streaming()) : [];
  hide(rail.all, !batch.length);
  if (batch.length) put(rail.all, `Approve all safe (${batch.length})`);
  const cards = items.filter((d) => !(d.kind === "reply" && rowIds.has(d.sessionId)));
  const ids = new Set(cards.map((d) => d.id));
  for (const [id, a] of railItems) if (!ids.has(id)) { railItems.delete(id); a.root.remove(); }
  for (const d of cards) {
    let a = railItems.get(d.id);
    if (!a) railItems.set(d.id, (a = makeAsk("rail")));
    fillAsk(a, d, now);
    a.root.classList.toggle("pulse", !answered.has(d.id)); // it pulses until it is gone, or answered here
  }
  const top = cards.filter((d) => !rowIds.has(d.sessionId));
  hide(rail.list, !top.length);
  place(rail.list, top);
}
// A Live row's own card (dashboard.js, as the row draws): the first of its chat's open permissions and questions, a
// subagent's among them (its request carries its main chat's session id), in queue order. Its buttons sit on the row's
// right, so the row keeps one line, and the next takes its place once it goes. Returns them all, the one shown first.
export function renderRowAsks(box, sessionId) {
  const ds = rowIds.has(sessionId) ? items.filter((d) => d.sessionId === sessionId && d.kind !== "reply" && railItems.has(d.id)) : [];
  place(box, ds.slice(0, 1));
  return ds;
}
// Puts these items' cards in this list in their order, each moved only when the node at its place differs, so a poll
// that keeps the order moves nothing; a card left after them (its chat's row came or went) is taken out, for the list
// that holds it now. A card put in a place takes no answer for GUARD_MS from then, as one just come up: a row's next item
// takes the place of the one answered, under the same pointer, so a double click on the first never answers it.
function place(list, ds) {
  let at = list.firstChild;
  for (const d of ds) {
    const a = railItems.get(d.id);
    if (!a) continue;
    if (a.root === at) at = at.nextSibling;
    else {
      list.insertBefore(a.root, at);
      a.shownAt = Date.now();
    }
  }
  while (at) {
    const next = at.nextSibling;
    at.remove();
    at = next;
  }
}
// Approve all safe: each Safe permission item gets its own answer and its own log line, one after another
async function approveSafe() {
  for (const d of safeBatch(items.filter((x) => !answered.has(x.id)), streaming())) {
    const a = railItems.get(d.id);
    if (a) await choose(a, "allow");
  }
}
// A number key on a focused card in Live picks that card's button
function railKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.tagName === "INPUT") return; // a key typed in the box is text
  const li = e.target.closest(".ask");
  const a = li && [...railItems.values()].find((x) => x.root === li);
  const b = a && keyChoice(a.buttons, e.key, a.shownAt, Date.now());
  if (!b) return;
  e.preventDefault();
  choose(a, b.key);
}

// --- the popup: one item at a time, a light card over either tab and over the room in full screen ---
let pop = null; // { a, title, card, scrim }
let cur = null, lastFocus = null, nextTimer = 0, closeTimer = 0;
const host = () => document.fullscreenElement || document.body; // in full screen only the full screen element shows
function buildPop() {
  const a = makeAsk("pop");
  const title = el("h2", { class: "ask-title", id: "ask-title" });
  const card = el("div", { class: "ask-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "ask-title" },
    el("div", { class: "ask-top" }, title, el("button", { type: "button", class: "ask-x", "aria-label": "Close", text: "×", onclick: () => { skip(); closeAsk(); } })),
    a.root);
  const scrim = el("div", { class: "ask-pop", hidden: true, onclick: (e) => { if (e.target === e.currentTarget) { skip(); closeAsk(); } } }, card);
  pop = { a, title, card, scrim };
  host().append(scrim);
}
// Opens the popup on one item ({ id }: a Live row's Answer), or on the first open item of a chat ({ sessionId }) or of a
// figure in the room ({ figure }: "s:<session id>" or "a:<agent id>"); false when there is none, so the caller does what
// it did before
export function openAsk(filter = {}) {
  const d = items.find((x) => !answered.has(x.id) && (filter.id ? x.id === filter.id : filter.sessionId ? x.sessionId === filter.sessionId : filter.figure ? x.figure === filter.figure : true));
  if (!d) return false;
  if (!pop) buildPop();
  skipped.clear();
  if (pop.scrim.hidden) lastFocus = document.activeElement;
  hide(pop.scrim, false);
  showItem(d);
  return true;
}
function showItem(d) {
  clearTimeout(nextTimer);
  clearTimeout(closeTimer);
  const a = pop.a;
  cur = d.id;
  Object.assign(a, { status: null, busy: false, wellKey: null, btnKey: null, open: false, shownAt: Date.now(), picks: null, picksFor: null, formKey: null });
  closeFix(a); // a note half typed, picks or a confirm button for the item before never carry over
  quietConf(a);
  hide(a.more, true);
  a.line.setAttribute("aria-expanded", "false");
  hide(a.root, false);
  put(pop.title, TITLE[d.kind]);
  fillAsk(a, d, Date.now());
  a.line.focus(); // never a button: an Enter meant for something else opens the detail, it never answers
}
// The next open item not answered or passed over here; with none, "All caught up" and the popup closes 900 ms on
function popNext(delay) {
  clearTimeout(nextTimer);
  nextTimer = setTimeout(() => {
    if (!pop || pop.scrim.hidden) return;
    const d = items.find((x) => !answered.has(x.id) && !skipped.has(x.id) && x.id !== cur);
    if (d) return showItem(d);
    cur = null;
    put(pop.title, "All caught up");
    hide(pop.a.root, true);
    closeTimer = setTimeout(closeAsk, 900);
  }, delay);
}
const skip = () => { if (cur) skipped.add(cur); };
function later() {
  skip();
  popNext(0);
}
// A closed popup keeps none of the last item's text, so Streamer never finds a real name left in the document
function closeAsk() {
  clearTimeout(nextTimer);
  clearTimeout(closeTimer);
  if (!pop || pop.scrim.hidden) return;
  hide(pop.scrim, true);
  cur = null;
  const a = pop.a;
  Object.assign(a, { d: null, status: null, wellKey: null, btnKey: null, buttons: [], picks: null, picksFor: null, formKey: null });
  closeFix(a);
  quietConf(a);
  for (const n of [a.chip, a.why, a.time, a.who, a.what, a.where, a.note]) n.textContent = "";
  a.well.replaceChildren();
  a.btns.replaceChildren();
  a.form.replaceChildren();
  hide(a.form, true);
  pop.title.textContent = "";
  if (lastFocus && lastFocus.isConnected) lastFocus.focus();
  lastFocus = null;
}
// The popup's item left the payload without an answer from here: the owner answered in VS Code. While it says "Sent"
// the answer was this page's, even once the first payload without it has pruned it from answered
function syncPop() {
  if (!pop || pop.scrim.hidden || !cur) return;
  const d = items.find((x) => x.id === cur);
  if (d) return fillAsk(pop.a, d, Date.now());
  if (answered.has(cur) || pop.a.status === "Sent" || pop.a.status === "Answered in VS Code") return;
  setStatus(pop.a, "Answered in VS Code");
  closeFix(pop.a);
  quietConf(pop.a);
  pop.a.buttons = [];
  for (const b of pop.a.root.querySelectorAll(".ask-btns button, .ask-picks button")) b.disabled = true;
  popNext(1400);
}
// Keys while the popup shows, caught before the page and the room see them: Escape closes it alone (the item waits),
// Tab stays inside, 1 to 9 pick a button once the guard is over
function popKey(e) {
  if (!pop || pop.scrim.hidden) return;
  const inBox = e.target === pop.a.fix; // the Ask for changes box: keys are text, and Escape closes the box alone
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (inBox) {
      closeFix(pop.a);
      return pop.a.line.focus();
    }
    skip();
    closeAsk();
  } else if (e.key === "Tab") trap(e);
  else if (!inBox && /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const b = !pop.a.root.hidden && keyChoice(pop.a.buttons, e.key, pop.a.shownAt, Date.now());
    if (b) choose(pop.a, b.key);
  }
}
function trap(e) {
  const f = [...pop.card.querySelectorAll("button, a[href], input")].filter((n) => !n.disabled && !n.closest("[hidden]"));
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  if (i < 0) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
  else if (e.shiftKey && i === 0) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
}
addEventListener("keydown", popKey, true);
document.addEventListener("fullscreenchange", () => { if (pop) host().append(pop.scrim); });
// A Streamer toggle rewrites Live's cards in place on either tab (text only, nothing measured), so no real name stays
// in a hidden Dashboard, and the popup's item while it shows; an item that has left the payload (the popup moves on
// from it in a moment) has its text rewritten and its buttons and picks form built again with every one off, so their
// labels are masked as a live item's are, its note kept; its confirm button is gone
onStreaming(() => {
  const now = Date.now();
  if (rail) renderRail(now);
  if (!pop || pop.scrim.hidden || !pop.a.d || pop.a.root.hidden) return;
  const d = pop.a.d;
  if (items.some((x) => x.id === d.id)) return fillAsk(pop.a, d, now);
  fillText(pop.a, d, now);
  const bs = buttonsOf(d, { control: canReply(), streaming: streaming(), popup: true });
  fillPicks(pop.a, bs.some((b) => b.key === "picks") && pop.a.picksFor === d.id ? d : null, true);
  fillButtons(pop.a, bs.map((b) => ({ ...b, disabled: true })));
  quietConf(pop.a);
});
