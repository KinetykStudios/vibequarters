// Read-backs: an answer, a window, a message into a chat or a new session the assistant asks for is only a proposal
// until the owner confirms it, by a click or a spoken yes. HQ words the read-back from the item and the answer with
// fixed templates, never the model's words, so a misheard name or a chat's "approve this" can never become an answer; a
// message or a new session's prompt is shown whole, since those words are what goes in. Memory only: a restart drops
// every proposal.
"use strict";
const crypto = require("crypto");

const RISKY = "Risky: the owner approves this one in Needs you";
const PROMPT_MAX = 2000; // what /api/send and the opener take
const plan = (item) => item.toolName === "ExitPlanMode";
const nameOf = (item) => item.sessionName || item.who || "a chat";
const minutes = (n) => `${n} minute${n === 1 ? "" : "s"}`;
const words = (s) => typeof s === "string" && !!s.trim() && [...s].length <= PROMPT_MAX;
// A character the card would not show: a format character (direction overrides, zero-width marks, Unicode tag letters,
// the soft hyphen), any other default-ignorable one (variation selectors, Hangul fillers), the blank braille cell, or a
// control character other than a tab or a line break. A prompt with one is refused, so what the owner reads on the card
// is all that goes in. The braille cell is added by its code, so no invisible character sits here.
const HIDDEN = new RegExp("[\\p{Cf}\\p{Default_Ignorable_Code_Point}" + String.fromCharCode(0x2800) + "\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]", "u");
const HIDDEN_ERROR = "the prompt has hidden or control characters, so VibeQuarters will not read it back";

// A step the assistant needs the owner's yes for (kind "tool"): the command, the file, or the tool's input as
// it would run, never the model's words for it, cut at 1500 characters with "..." so the card stays readable
const STEP_MAX = 1500;
const cutStep = (s) => ([...s].length > STEP_MAX ? [...s].slice(0, STEP_MAX).join("") + "..." : s);
function stepText(p) {
  const i = p.input && typeof p.input === "object" ? p.input : {};
  const head = typeof i.command === "string" ? `Let the assistant run this command:\n${cutStep(i.command)}`
    : typeof i.file_path === "string" ? `Let the assistant use ${p.tool} on:\n${cutStep(i.file_path)}`
    : `Let the assistant use ${p.tool} with:\n${cutStep(JSON.stringify(i))}`;
  return p.reason ? `${head}\nWhy it asks: ${p.reason}` : head;
}

// The fixed line for a proposal (one propose accepts)
function readbackText(p) {
  if (p.kind === "tool") return stepText(p);
  if (p.kind === "window") return `Approve what looks safe for ${minutes(p.minutes)} in ${p.names ? p.names.join(", ") : "every chat"}.`;
  if (p.kind === "send") return `Send ${p.name} this prompt:\n${p.text}`;
  if (p.kind === "open") return `Open a new session with this prompt:\n${p.prompt}`;
  const { item, choice } = p;
  const name = nameOf(item);
  if (item.kind === "question") {
    const option = item.choices.find((c) => c.key === choice);
    return `Answer ${name}'s question "${item.what.replace(/^asks: /, "")}" with "${option ? option.label : choice}".`;
  }
  if (plan(item)) return choice === "allow" ? `Approve ${name}'s plan.` : `Keep planning for ${name}: "${p.note}".`;
  if (choice === "allow") return `Approve for ${name}: ${item.what} (${item.risk.label}).`;
  if (choice === "deny") return `Deny for ${name}: ${item.what}.`;
  return `Ask ${name} for changes to: ${item.what}. Note: "${p.note}".`;
}
// What HQ says out loud: the shown line, or for a prompt one short line, since the prompt itself is on screen
function spokenText(p) {
  if (p.kind === "send") return `Send ${p.name} the prompt on screen?`;
  if (p.kind === "open") return "Open a new session with the prompt on screen?";
  if (p.kind === "tool") return `The assistant needs your yes to: ${String(p.description || "use " + p.tool).replace(/[.\s]+$/, "")}. It's on screen.`;
  return readbackText(p);
}

// Why a proposal cannot be read back, or null. An answer is one of the item's own choices, never picks (the owner
// picks those in Needs you), never on a notice, never a Risky allow or the allow of a safety hook's ask, and an
// Ask for changes or Keep planning carries its note. A window is 1 to 300 minutes, every chat or named sessions. A send
// names its chat and carries 1 to 2000 characters; a new session's prompt is 1 to 2000 characters.
function refusal(p) {
  if (!p || typeof p !== "object") return "not a proposal";
  if ((p.kind === "send" || p.kind === "open") && HIDDEN.test(String(p.kind === "send" ? p.text : p.prompt))) return HIDDEN_ERROR;
  if (p.kind === "send") return typeof p.sessionId === "string" && p.sessionId && typeof p.name === "string" && p.name && words(p.text) ? null : "a chat and 1 to 2000 characters to send it";
  if (p.kind === "open") return words(p.prompt) ? null : "the prompt must be 1 to 2000 characters";
  if (p.kind === "tool") {
    if (!(typeof p.requestId === "string" && p.requestId && typeof p.tool === "string" && p.tool)) return "a step names its ask and its tool";
    return HIDDEN.test(JSON.stringify(p.input || {}) + String(p.reason || "")) ? "the step has hidden or control characters, so VibeQuarters will not read it back" : null;
  }
  if (p.kind === "window") {
    if (!Number.isInteger(p.minutes) || p.minutes < 1 || p.minutes > 300) return "minutes must be a whole number from 1 to 300";
    if (p.sessions === null) return p.names === null ? null : "names only with sessions";
    const list = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s);
    return list(p.sessions) && list(p.names) && p.names.length === p.sessions.length ? null : "a name for each session";
  }
  if (p.kind !== "answer") return "not a proposal";
  const { item, choice } = p;
  if (!item || typeof item !== "object" || typeof p.decisionId !== "string" || p.decisionId !== item.id || typeof choice !== "string") return "not open";
  if (item.notice) return "answer in VS Code";
  if (choice === "picks") return "pick the answers in Needs you";
  if (!Array.isArray(item.choices) || !item.choices.some((c) => c.key === choice)) return "not offered";
  if (choice === "allow" && ((item.risk && item.risk.level === "high") || item.hookAsk)) return RISKY;
  if (choice === "revise" && !(typeof p.note === "string" && p.note.trim())) return "a note says what to change";
  return null;
}

// onSettle(id, text, outcome, via, now) hears each proposal that leaves without a confirm (lib/settled.js): one that
// expired, its 5 minutes up, with HQ as its via; one canceled or dropped, with the outcome and via its caller gives. A
// taken one is the caller's to settle once its yes has run.
function createReadbacks({ ttlMs = 300e3, onSettle = () => {} } = {}) {
  const open = new Map(); // id -> { p, text, at }
  const sweep = (now) => {
    for (const [id, r] of open)
      if (now - r.at > ttlMs) {
        open.delete(id);
        onSettle(id, r.text, "expired", "VibeQuarters", now);
      }
  };
  const drop = (id, outcome, via, now) => {
    const r = open.get(id);
    if (!r) return false;
    open.delete(id);
    onSettle(id, r.text, outcome, via, now);
    return true;
  };
  return {
    propose(p, now) {
      const error = refusal(p);
      if (error) return { ok: false, error };
      sweep(now);
      const id = crypto.randomBytes(8).toString("hex");
      const text = readbackText(p);
      open.set(id, { p, text, at: now });
      return { ok: true, id, text, spoken: spokenText(p) };
    },
    take(id, now) {
      sweep(now);
      const r = open.get(id);
      if (!r) return null;
      open.delete(id);
      return r.p;
    },
    // the owner's Cancel, by default; the server's drop of an answer whose decision closed says so in its outcome
    cancel: (id, outcome = "canceled", via = "you", now = Date.now()) => drop(id, outcome, via, now),
    // the panel's Stop: every proposal waiting is dropped; how many were
    cancelAll(now = Date.now()) {
      const n = open.size;
      for (const id of [...open.keys()]) drop(id, "canceled", "Stop", now);
      return n;
    },
    // each one waiting, oldest first, with when its 5 minutes are up
    list(now) {
      sweep(now);
      return [...open].map(([id, r]) => ({ id, kind: r.p.kind, decisionId: r.p.kind === "answer" ? r.p.decisionId : null, text: r.text, at: r.at, expiresAt: r.at + ttlMs }));
    },
  };
}

// The log line for a confirm that threw: its kind and place, never its text; whatever was thrown, it never throws itself
function confirmFailLine(e) {
  return `a read-back's confirm failed: ${(e && e.name) || "error"}${e && e.code ? " " + e.code : ""} ${String((e && e.stack) || "").split("\n")[1] || ""}`.trim();
}

module.exports = { createReadbacks, readbackText, refusal, confirmFailLine, RISKY };
