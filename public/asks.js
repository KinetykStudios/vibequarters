// The Needs you rules the page follows, with no DOM, so node:test covers them: the queue's order, the buttons an item
// offers, Approve all safe, the Risky second click, a picks form's state, the number-key guard, the Ask for
// changes note, an item's own note and the alert lines.
import { MASK } from "./streamer.js";
import { ago } from "./format.js";

export const GUARD_MS = 350; // an item takes no number key (and no click) this long after it comes up
export const STREAM_NOTE = "Turn Streamer off to approve";
export const HIDDEN = "Hidden while streaming";
export const OPEN_VS = "Open in VS Code"; // a notice's one button: its chat, where VS Code is asking now
export const TITLE = { permission: "Needs your OK", question: "Question for you", reply: "Waiting for your reply" };
const RANK = { permission: 0, question: 1, reply: 2 };

// Permissions, then questions, then finished turns; oldest first within each
export const ordered = (items) => [...(items || [])].sort((a, b) => RANK[a.kind] - RANK[b.kind] || (a.askedAt || 0) - (b.askedAt || 0));

// HQ answers every prompt but a notice: one HQ held past the bridge's cap, which VS Code is asking now. This is the
// server's own rule (server.js, /api/answer: a truthy notice is refused); the asks test holds the two equal.
const notice = (d) => !!d.notice;
// A Risky Approve sends only from a second, deliberate click on the confirm button (needs.js); the server refuses a
// Risky allow without it (server.js, /api/answer, "confirm first").
export const needsConfirm = (d) => !!(d.risk && d.risk.level === "high");

// A risk chip's words: its label, with a colon when a reason follows it in the text; the reason itself (lib/describe.js
// chip(): generic words, never a name, so Streamer shows it); and its title, the label and reason together for a pointer
// that rests on the chip. A card shows every reason; a Live row's one line has room for a Risky one only (riskyOnly).
// Safe has none: its label alone, no title.
export function chipWords(risk, { riskyOnly = false } = {}) {
  const reason = (risk && risk.reason) || "";
  const shows = !!reason && (!riskyOnly || risk.level === "high");
  return { label: risk.label + (shows ? ":" : ""), why: shows ? reason : "", title: reason ? `${risk.label}: ${reason}` : null };
}

// The only tools Approve all safe takes: the reads and file tools, the ones the risk rules can rate Safe (lib/describe.js
// READ_ONLY and FILE_TOOLS; the asks test holds this list equal to them). A shell call, a connector or any other tool
// stays out whatever its chip says.
export const BATCH_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite", "Edit", "MultiEdit", "Write", "NotebookEdit"]);
// Approve all safe: the open permission items whose chip is Safe and whose tool is in BATCH_TOOLS, never a notice or a
// safety hook's ask (lib/askmark.js), only when there are 2 or more, never under Streamer. A call the bridge marked
// Risky reads high (lib/describe.js), so it stays out whatever its tool.
export function safeBatch(items, streaming) {
  if (streaming) return [];
  const safe = (items || []).filter((d) => d.kind === "permission" && !notice(d) && !d.hookAsk && d.risk && d.risk.level === "low" && BATCH_TOOLS.has(d.toolName));
  return safe.length >= 2 ? safe : [];
}

export const NOTE_MAX = 500; // the bridge refuses a longer note (bridge/hq-bridge.js plainNote)
export const NOTE_HINT = "Write what to change, up to 500 characters";
// The Ask for changes note as the page sends it: control characters and runs of white space become one space, then it
// is trimmed; null when nothing is left or it is over NOTE_MAX characters (code points, as the bridge counts them)
export function noteOf(text) {
  if (typeof text !== "string") return null;
  const t = text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return t && [...t].length <= NOTE_MAX ? t : null;
}

// A picks form (any question shape but one one-pick question): one list of option places per question, in the options'
// order. A one-pick question holds exactly the option last clicked; a several-pick one adds an option or takes it off.
// Each returns a new state and never changes the one it was given.
export const emptyPicks = (d) => d.questions.map(() => []);
export function pickOption(d, picks, q, k) {
  const out = picks.map((p) => [...p]);
  if (d.questions[q].multiSelect !== true) out[q] = [k];
  else out[q] = out[q].includes(k) ? out[q].filter((x) => x !== k) : [...out[q], k].sort((a, b) => a - b);
  return out;
}
// Send is ready once every question has at least one pick
export const picksReady = (d, picks) => picks.length === d.questions.length && picks.every((p) => p.length >= 1);

// An item's buttons. A reply opens its chat (the server's link). A notice offers only Open in VS Code, a link to its
// chat that posts nothing, whatever control and Streamer say (none when its chat has no link). With control off nothing
// else is offered. Every other item offers its own choices: a permission's Approve, Deny and Ask for changes (a Risky
// Approve asks for the second click in needs.js), a plan's Approve and Keep planning, a question's options, or Send for
// a picks form. Approve is the primary button and is disabled under Streamer. Send is primary too, with no number, as
// it sends only on a click. Keys 1 to 9 follow the order. In the popup every item ends with Later (no key), which
// passes it over, so the popup steps through the items with control off too.
export function buttonsOf(d, { control, streaming, popup = false }) {
  const out = ownButtons(d, control, streaming);
  if (popup) out.push({ key: "later", label: "Later", n: null, primary: false, disabled: false, href: null });
  return out;
}
function ownButtons(d, control, streaming) {
  if (d.kind === "reply") return d.link ? [{ key: "open", label: "Open this chat", n: null, primary: true, disabled: false, href: d.link }] : [];
  if (notice(d)) return d.link ? [{ key: "vscode", label: OPEN_VS, n: null, primary: false, disabled: false, href: d.link }] : [];
  if (!control) return [];
  let n = 0;
  return d.choices.map((c) => ({ key: c.key, label: c.label, n: c.key === "picks" ? null : ++n, primary: c.key === "allow" || c.key === "picks", disabled: c.key === "allow" && !!streaming, href: null }));
}

// The note an item carries by itself: a notice says how long HQ held it before it moved to VS Code, and the Streamer
// note shows where Approve is offered (it is disabled then)
export function itemNote(d, buttons, streaming) {
  if (notice(d)) return d.moved || "";
  return streaming && buttons.some((b) => b.key === "allow") ? STREAM_NOTE : "";
}

// The button a number key picks: none inside the guard, none for a disabled button or a link
export function keyChoice(buttons, key, shownAt, now) {
  if (!/^[1-9]$/.test(key) || now - shownAt < GUARD_MS) return null;
  const b = buttons.find((x) => x.n === Number(key));
  return b && !b.disabled && !b.href ? b : null;
}

// One alert line (payload alerts): an answer HQ did not write, an answer HQ could not confirm in time (unchecked: the
// owner answers again), or the answers log HQ cannot read. Under Streamer the chat's name is the mask; the tool stays.
// The server sends null for a chat it never showed and a tool it would not keep. In three parts, the words before its
// time, its time, and the words after, so the page can keep the time, the only part that moves with the clock, out of
// what the alert region announces.
export function alertParts(a, now, streaming) {
  if (a.unreadable) return ["VibeQuarters cannot read answers.log, so it cannot tell who answered, ", ago(a.at, now), "."];
  const who = (a.sessionName ? (streaming ? MASK : a.sessionName) : "an unknown chat") + (a.toolName ? ` (${a.toolName})` : "");
  if (a.unchecked) return [`VibeQuarters could not confirm your answer for ${who} in time, `, ago(a.at, now), ". Answer it again."];
  return [`An answer for ${who} was written outside VibeQuarters, `, ago(a.at, now), ". See answers.log."];
}
export const alertText = (a, now, streaming) => alertParts(a, now, streaming).join("");
