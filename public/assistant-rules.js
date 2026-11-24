// The assistant panel's words and the voice's rules, with no DOM (assistant.js and voice.js use them): the approve
// window's countdown, the status line, the label over a prompt it sent, this week's spend, the talk key, a spoken yes
// or cancel, and the claim that lets one HQ page, of several open, speak each line.
import { usd, countdown as left } from "./format.js";

export const countdown = (endsAt, now) => left(endsAt - now);
// past an hour the chip reads hours and minutes, not "299:59"
const hoursLeft = (ms) => { const m = Math.floor(ms / 60e3); return Math.floor(m / 60) + " h" + (m % 60 ? " " + (m % 60) + " min" : ""); };
export const windowChip = (endsAt, now) => "Approving everything: " + (endsAt - now > 3600e3 ? hoursLeft(endsAt - now) : countdown(endsAt, now)) + " left";
export const sentLabel = (name) => "Sent to " + name;

// The server's process states in the owner's words; no payload, or one the page does not know, reads Offline
const WORD = { off: "Offline", starting: "Starting", idle: "Listening", working: "Thinking" };
export function statusWord(state) {
  if (state && state.status === "error") return state.error ? "Offline: " + state.error : "Offline";
  return (state && WORD[state.status]) || "Offline";
}

// lib/usage.js weekUsage: the assistant's spend over the last 7 days, the week's total, its share of it (a fraction) and
// the split by model; null while the payload has no usage
export function usageLine(u) {
  if (!u) return null;
  return `This week: ${usd(u.assistantUsd)} of ${usd(u.totalUsd)} (${Math.round(100 * (u.share || 0))}%), Sonnet ${usd(u.byModel.sonnet)}, Opus ${usd(u.byModel.opus)}`;
}

// Hold Ctrl+Space to talk: Ctrl, never Cmd, and no other modifier that would make it someone else's shortcut
export const talkKey = (e) => e.ctrlKey && e.code === "Space" && !e.altKey && !e.metaKey;

// A final transcript is a yes or a cancel only when that is all it says ("Yes!", "cancel it"); a sentence that starts
// with one ("Yes, send it", "Yeah, no") is words for the assistant
const YES = /^(yes|yeah|yep|confirm|confirmed|do it|yes do it|yes please|yes confirm)$/, CANCEL = /^(no|nope|cancel|cancel it|cancel that|stop|don't|no thanks)$/;
export function yesOrNo(text) {
  const t = String(text || "").toLowerCase().replace(/[.,!?;:]/g, " ").replace(/\s+/g, " ").trim();
  return YES.test(t) ? "yes" : CANCEL.test(t) ? "cancel" : null;
}

// Under Streamer every card's text is masked and the voice is quiet, so a card of any kind shows this line in place of
// its text and takes no yes by click or voice, since the owner can neither read it nor hear it; a cancel still goes
export const STREAMER_CARD = "Turn Streamer off to read this before you confirm it";
export const hiddenCard = (rb, streamer) => !!streamer && !!rb;
// A Confirm goes only to a card still in the list (one gone or not yet shown is never confirmed) and not hidden
export const mayConfirm = (readbacks, id, streamer) => {
  const rb = readbacks.find((r) => r.id === id);
  return !!rb && !hiddenCard(rb, streamer);
};

// What a spoken yes or cancel does: it answers the one read-back waiting, if that one is under a minute
// old, so the owner heard it just now; with two or more waiting it answers none and points to the buttons; anything
// else, or a yes with nothing fresh to answer, is words for the assistant. A yes never answers a card that came after
// the owner started talking (heardFrom, when the mic started) or one Streamer hides.
const FRESH_MS = 60e3;
export function spokenAnswer(text, readbacks, now, { streamer = false, heardFrom = Infinity } = {}) {
  const word = yesOrNo(text);
  const open = Array.isArray(readbacks) ? readbacks : [];
  if (!word || !open.length) return { kind: "say" };
  if (open.length > 1) return { kind: "refuse", note: `${open.length} read-backs are waiting. Use Confirm or Cancel on the one you mean` };
  const rb = open[0];
  if (!(typeof rb.at === "number" && now - rb.at <= FRESH_MS)) return { kind: "say" };
  if (word === "yes" && rb.at >= heardFrom) return { kind: "refuse", note: "That read-back came while you were talking. Say yes again, or use Confirm" };
  if (word === "yes" && hiddenCard(rb, streamer)) return { kind: "refuse", note: STREAMER_CARD };
  return { kind: "answer", id: rb.id, yes: word === "yes" };
}

// A card's buttons take a click only 700 ms after the cards last changed, so a card that slides under the pointer as it
// arrives is not answered by a click meant for the one before
export const settled = (changedAt, now) => now - changedAt >= 700;

// A read-back card's title line and the time it has left before HQ drops it: whole minutes rounded up, seconds in
// its last minute
export const RB_TITLE = "Waiting for your yes";
export function expiresIn(expiresAt, now) {
  const ms = expiresAt - now;
  if (!(ms > 0)) return "expiring now";
  return ms < 60e3 ? `expires in ${Math.ceil(ms / 1000)} s` : `expires in ${Math.ceil(ms / 60e3)} min`;
}
// Live's header line while read-backs wait; a click on it goes to the first card
export const waitingLine = (n) => (n > 1 ? `The assistant is waiting for your yes on ${n}` : "The assistant is waiting for your yes");

// How long ago, in the Recent list's words
export function since(t, now) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}
// The Recent list: the newest 5 of the payload's settled history (lib/settled.js), each as its outcome first ("Sent",
// "Expired", "Approved by you", "Not sent (one message at a time)"), what it was, how long ago, and a tone for its
// color: good when it went through, bad when a yes did not, warn when it expired, quiet otherwise. Under Streamer what
// it was and any reason are null, for the mask; the fixed words and the time stay.
const BY = { you: " by you", "approve window": " by the approve window", "assistant read-back": " by your yes to the assistant", Stop: " with Stop" };
const DONE = new Set(["sent", "approved", "denied", "answered", "changes asked", "window opened", "session opened"]);
export function recentLines(list, now, { streamer = false, max = 5 } = {}) {
  return (Array.isArray(list) ? list : []).slice(0, max).map((e) => {
    const [head, ...rest] = String(e.outcome || "").split(": ");
    const by = e.kind === "decision" || e.via === "Stop" ? BY[e.via] || "" : "";
    const tone = head.startsWith("not ") ? "bad" : head === "expired" ? "warn" : DONE.has(head) ? "good" : "quiet";
    return {
      key: `${e.kind}:${e.id}:${e.at}`, tone, ago: since(e.at, now),
      outcome: head.charAt(0).toUpperCase() + head.slice(1) + by, reason: rest.length ? (streamer ? null : rest.join(": ")) : "",
      what: streamer ? null : String(e.what || ""),
    };
  });
}

// The Dashboard's Recent: the settled history with the lines HQ noted on its own (role "system": a heads-up, a reminder,
// a send that failed), newest first by time, the newest 5. The owner's words, its replies and the prompts it sent stay
// in the conversation.
export function recentFeed(list, msgs, now, { streamer = false, max = 5 } = {}) {
  const said = (Array.isArray(msgs) ? msgs : []).filter((x) => x && x.role === "system").map((x) => ({
    at: x.at, line: { key: `said:${x.id}:${x.at}`, tone: "quiet", ago: since(x.at, now), outcome: "Said", reason: "", what: streamer ? null : String(x.text || "") },
  }));
  const done = Array.isArray(list) ? list : [];
  const lines = recentLines(done, now, { streamer, max: done.length }).map((line, i) => ({ at: done[i].at, line }));
  return [...said, ...lines].sort((a, b) => b.at - a.at).slice(0, max).map((x) => x.line);
}

// Filler words: one plays the moment the owner's words go, from audio the page already holds, while the assistant works
// on its answer
export const FILLERS = ["Got it, one sec.", "On it.", "Okay, give me a second.", "Sure, let me check.", "Alright, one moment."];
export function pickFiller(last, rnd = Math.random) {
  const pool = FILLERS.filter((f) => f !== last);
  return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))];
}

// One page speaks each line: a page claims a line's id on the shared BroadcastChannel("hq-say") before it plays it, and
// a page that has seen the id claimed, by itself or another page, leaves it. A channel is watched from the moment it is
// made, so it knows every claim posted after that.
const claims = new WeakMap(); // channel -> the ids claimed on it
export function watchSpeech(channel) {
  if (!claims.has(channel)) {
    const ids = new Set();
    claims.set(channel, ids);
    channel.addEventListener("message", (e) => { if (e.data && e.data.claim != null) ids.add(e.data.claim); });
  }
  return channel;
}
export function claimSpeech(id, channel) {
  const ids = claims.get(watchSpeech(channel));
  if (ids.has(id)) return false;
  ids.add(id);
  channel.postMessage({ claim: id });
  return true;
}
