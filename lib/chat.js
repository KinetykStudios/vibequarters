// One chat as its pop-up shows it: what the owner typed, what the chat said, and each tool step with whether it
// finished. The first read starts near the end of the transcript; each later read folds only what was added since,
// so a pop-up polling every second costs one stat while the chat is quiet. Every string passes through cutSecrets
// before it leaves the server, and a shell command is never kept, only its step's label (lib/session.js actionOf).
const fs = require("fs");
const crypto = require("crypto");
const { newCursor, readNew } = require("./tail");
const { actionOf } = require("./session");
const { cutSecrets } = require("./describe");

const TAIL = 1024 * 1024; // the first read starts this many bytes from the end
const KEEP = 80; // entries kept per chat, the newest
const TEXT_MAX = 4000; // characters of one message shown
// characters of one of the chat's own replies shown: the pop-up shows the newest whole, Next steps and all (tailOf reads
// them from the reply's end). At KEEP entries the worst case is 80 x 16,000 code points, about 2.6 MB of string for a
// chat a pop-up keeps open (5 MB if every one were outside the BMP); a chat no pop-up asks for is dropped (FORGET_MS)
const SAID_MAX = 16000;
const READS = 64; // chunks folded in one call at most
const FORGET_MS = 60e3; // a chat no pop-up has asked for in this long is dropped
// The tool call a chat in the Claude desktop app ends its turn with; the app draws its input as the next-step box
const WRAP = "mcp__ccd_turn__wrap_up";
const WINDOW = 8000; // code points at the end of a reply its closing lines are read from
// A reply's closing lines: the heading over its Next steps list, one item of that list, its status line (the colon
// inside or after the bold), and a code fence's line
const NEXT_BOLD = /^\s*(?:#{1,6}\s*)?\*\*Next steps(?::\*\*|\*\*:?)\s*$/i;
const NEXT_HEAD = /^\s*#{1,6}\s*Next steps:?\s*$/i;
const ITEM = /^\s*\d+[.)]\s+(.+)$/;
const STATUS = /^\s*(?:\*\*)?Status(?::(?:\*\*)?|\*\*:)\s*(.+)$/i;
const FENCE = /^\s*(?:```|~~~)/;

// The wrappers Claude Code puts around text it injects into a user row; a typed prompt is what is left once they go.
// A slash command shows as its name and its arguments.
const WRAPPED = /<(system-reminder|ide_selection|ide_opened_file|ide_diagnostics|command-message|command-args|command-name|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>/g;
const COMMAND = /<command-name>([\s\S]*?)<\/command-name>/;
// A message the owner sent from the pop-up, as Claude Code writes the turn the inbox waiter woke (bridge/hq-inbox.js
// PREFIX, or ASSISTANT_PREFIX for one the HQ assistant sent): a task notification row whose whole
// head is the Stop hook's, its text ending at the first reminder close
const FROM_HQ = /^<task-notification>\n<summary>Stop hook feedback<\/summary>\n<\/task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": Message from the user, (?:typed in the VibeQuarters dashboard|written by the VibeQuarters assistant from their words): ([\s\S]*?)\n<\/system-reminder>/;
const ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n") : "");
function typed(s) {
  const name = COMMAND.exec(s);
  if (name) {
    const args = ARGS.exec(s);
    return (name[1].trim() + (args && args[1].trim() ? " " + args[1].trim() : "")).trim();
  }
  return s.replace(WRAPPED, "").trim();
}
// At most max characters (code points), cut after the secrets are, so a cut never splits a secret into a part the
// cuts no longer see; cut says whether it was
function clip(s, max) {
  const c = [...cutSecrets([...s].slice(0, max * 2).join(""))];
  return c.length > max ? { text: c.slice(0, max - 1).join("") + "…", cut: true } : { text: c.join(""), cut: false };
}
const shorten = (s) => clip(s, TEXT_MAX).text;
// At most max code points, cut with the ellipsis as shorten cuts
function cap(s, max) {
  const c = [...s];
  return c.length > max ? c.slice(0, max - 1).join("") + "…" : s;
}
// A string that is not blank, trimmed and shortened; null for anything else
const filled = (v) => (typeof v === "string" && v.trim() ? shorten(v.trim()) : null);

// A wrap_up call's input as the turn's ask: its recap, its ask, its first 6 actions that have a label (with their
// message when there is one) and whether the turn waits on the owner. Anything else in the input is never kept.
function wrapOf(input, at) {
  const o = input && typeof input === "object" ? input : {};
  const actions = [];
  for (const a of Array.isArray(o.actions) ? o.actions : []) {
    const label = a && typeof a === "object" ? filled(a.label) : null;
    if (!label) continue;
    const message = filled(a.message);
    actions.push(message ? { label, message } : { label });
    if (actions.length === 6) break;
  }
  return { k: "wrap", at, recap: filled(o.recap), ask: filled(o.ask), actions, blocked: o.blocked === true };
}

// A reply's closing lines, read from its last WINDOW code points once their secrets are cut: the numbered list under
// its last Next steps heading (left), its last Status line outside a code fence (status) and its last paragraph (last)
function tailOf(raw) {
  const cps = [...raw];
  let s = cps.slice(-WINDOW).join("");
  if (cps.length > WINDOW) {
    // the window starts inside a line: that partial line goes, all of the window when it holds no other, so a secret
    // the cut splits into a piece too short for its shape never shows
    const nl = s.indexOf("\n");
    s = nl < 0 ? "" : s.slice(nl + 1);
  }
  s = cutSecrets(s);
  const lines = s.split(/\r?\n/);
  const left = [];
  let i = lines.findLastIndex((l) => NEXT_BOLD.test(l) || NEXT_HEAD.test(l));
  if (i >= 0) {
    for (i++; i < lines.length && !lines[i].trim(); i++);
    for (let m; i < lines.length && left.length < 10 && (m = ITEM.exec(lines[i])); i++) left.push(cap(m[1].trim(), 500));
  }
  // the last Status line outside a code fence: one with an odd count of fence lines after it sits inside a block
  // (counted from the end, so a block the window starts inside still reads right)
  let st = null;
  for (let i = lines.length - 1, fences = 0; i >= 0 && !st; i--) {
    if (FENCE.test(lines[i])) fences++;
    else if (fences % 2 === 0 && STATUS.test(lines[i])) st = lines[i];
  }
  const last = s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).pop();
  return { left, status: st ? cap(STATUS.exec(st)[1].trim(), 500) || null : null, last: last ? cap(last, 1000) : null };
}

// A turn's reply: its newest text with no tool step after it (text followed by steps is narration the turn went on
// from); null when it has none
function replyOf(turn) {
  const i = turn.findLastIndex((e) => e.k === "said");
  return i >= 0 && !turn.slice(i + 1).some((e) => e.k === "step") ? turn[i] : null;
}
// What the latest turn (the entries after the owner's last prompt) leaves the owner: its newest wrap_up, and its reply's entry
// number (n), Next steps and Status; that reply's last paragraph only when the turn has none of the three. before is
// the reply that ended an earlier turn, the newest one that has one: a reply ends its turn once the owner speaks after
// it, while the latest turn's text may still be narration, so the page keeps before while the chat works
function focusOf(entries) {
  const start = entries.findLastIndex((e) => e.k === "you") + 1;
  const turn = entries.slice(start);
  const w = turn.findLast((e) => e.k === "wrap");
  const said = replyOf(turn);
  const wrap = w ? { at: w.at, recap: w.recap, ask: w.ask, actions: w.actions, blocked: w.blocked } : null;
  const left = said ? said.tail.left : [];
  const status = said ? said.tail.status : null;
  let before = null;
  for (let end = start - 1; end >= 0 && !before; ) { // end: the owner's prompt that closed the turn read next
    const from = entries.findLastIndex((e, i) => i < end && e.k === "you") + 1;
    const r = replyOf(entries.slice(from, end));
    if (r) before = { n: r.n, left: r.tail.left, status: r.tail.status };
    end = from - 1;
  }
  return { wrap, left, status, last: !wrap && !left.length && !status && said ? said.tail.last : null, n: said ? said.n : null, before };
}

function push(c, e) {
  e.n = ++c.n;
  c.entries.push(e);
  c.v++;
  while (c.entries.length > KEEP) {
    const old = c.entries.shift();
    if (old.k === "step") c.steps.delete(old.id);
  }
}
function fold(c, row) {
  if (!row || typeof row !== "object" || row.isSidechain || (row.type !== "user" && row.type !== "assistant")) return;
  const at = Date.parse(row.timestamp);
  if (!Number.isFinite(at)) return;
  const raw = row.message && row.message.content;
  if (row.type === "user") {
    if (Array.isArray(raw))
      for (const b of raw) {
        const e = b && b.type === "tool_result" ? c.steps.get(b.tool_use_id) : null;
        if (!e) continue;
        e.done = true;
        e.error = b.is_error === true;
        c.v++;
      }
    if (row.isMeta || row.isCompactSummary) return;
    const s = textOf(raw);
    const kind = row.origin && row.origin.kind;
    const hq = kind === "task-notification" ? FROM_HQ.exec(s) : null;
    if (hq) {
      if (hq[1].trim()) push(c, { k: "you", at, text: shorten(hq[1].trim()), hq: true });
      return;
    }
    // any other task notification (a background task, a subagent, a hook) or a peer session's message is not the owner's:
    // no entry, so it neither shows as the owner's nor starts a turn that would clear the turn's ask
    if (kind === "task-notification" || kind === "peer") return;
    const t = typed(s);
    if (t) push(c, { k: "you", at, text: shorten(t) });
    return;
  }
  for (const b of Array.isArray(raw) ? raw : []) {
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      const r = clip(b.text.trim(), SAID_MAX);
      push(c, { k: "said", at, text: r.text, ...(r.cut ? { cut: true } : {}), tail: tailOf(b.text) });
    }
    else if (b.type === "tool_use" && b.name === WRAP) push(c, wrapOf(b.input, at)); // never a step, so its result is skipped
    else if (b.type === "tool_use") {
      const e = { k: "step", at, id: typeof b.id === "string" ? b.id : null, label: cutSecrets(actionOf(b)), done: false, error: false };
      push(c, e);
      if (e.id) c.steps.set(e.id, e);
    }
  }
}
const view = (e) => (e.k === "step" ? { n: e.n, k: e.k, at: e.at, label: e.label, done: e.done, error: e.error } : { n: e.n, k: e.k, at: e.at, text: e.text, ...(e.hq ? { hq: true } : {}), ...(e.cut ? { cut: true } : {}) });

function createChats() {
  const chats = new Map(); // transcript path -> { gen, cursor, skip, entries, steps, n, v, usedAt }
  function start(fp, now) {
    let size;
    try {
      size = fs.statSync(fp).size;
    } catch {
      return null;
    }
    const pos = Math.max(0, size - TAIL);
    // gen names this read of the file: a pop-up that sees a new one starts its feed again
    const c = { gen: crypto.randomBytes(6).toString("hex"), cursor: { ...newCursor(), pos }, skip: pos > 0, entries: [], steps: new Map(), n: 0, v: 0, usedAt: now };
    chats.set(fp, c);
    return c;
  }
  // { gen, v, entries, focus } for the transcript at fp, oldest entry first (a wrap_up is never an entry, only part of
  // the focus); null when it cannot be read
  function read(fp, now = Date.now(), again = true) {
    for (const [k, x] of chats) if (now - x.usedAt > FORGET_MS) chats.delete(k);
    const c = chats.get(fp) || start(fp, now);
    if (!c) return null;
    c.usedAt = now;
    for (let i = 0; i < READS; i++) {
      const r = readNew(fp, c.cursor);
      if (r.failed) break;
      if (r.reset) {
        // replaced or cut short: read its end again, never the whole file
        chats.delete(fp);
        return again ? read(fp, now, false) : null;
      }
      c.cursor = r.cursor;
      let lines = r.lines;
      if (c.skip && lines.length) {
        lines = lines.slice(1); // the first line of a read that starts mid-file is the tail of a row
        c.skip = false;
      }
      for (const l of lines) {
        let row;
        try {
          row = JSON.parse(l);
        } catch {
          continue;
        }
        fold(c, row);
      }
      if (!r.more) break;
    }
    return { gen: c.gen, v: c.v, entries: c.entries.filter((e) => e.k !== "wrap").map(view), focus: focusOf(c.entries) };
  }
  return { read };
}

module.exports = { createChats, typed, tailOf, WRAP, TAIL, KEEP, TEXT_MAX, SAID_MAX };
