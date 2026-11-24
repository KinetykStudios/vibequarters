// Formatting for every number on the page. "-" stands for no data.
export const usd = (n, d = 2) => (n == null ? "-" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
export const num = (n) => (n == null ? "-" : Math.round(n).toLocaleString("en-US"));
// A count and its noun agree: count(1, "subagent") is "1 subagent", count(2, "subagent") is "2 subagents"; noun() is
// the word alone
export const noun = (n, one, many = one + "s") => (n === 1 ? one : many);
export const count = (n, one, many) => `${num(n)} ${noun(n, one, many)}`;
export const tokens = (n) => {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
};
export function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}
export const ago = (t, now) => (t == null ? "-" : dur(now - t) + " ago");
export const clock = (t) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
export const slotLabel = clock;
export const dayLabel = (date) => new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const countdown = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};
export const STATUS = { working: "Working", thinking: "Thinking", "needs-you": "Needs you", idle: "Idle" };
// What a row's right side says when its chat waits on the owner (needs.js wantOf), in place of its status
export const WANT = { approval: "Needs your approval", answer: "Needs your answer", reply: "Needs your reply" };
// ...or when its turn ended while something it started still runs (the server's waitsOn): that wakes it, not the owner
export const waitText = (s) =>
  s.waitsOn === "subagent" ? `Waiting on ${count((s.waitingFor || []).length || 1, "agent")}`
  : s.waitsOn === "background" ? `Waiting on: ${(s.waitingFor || [])[0] || "a background job"}` + ((s.waitingFor || []).length > 1 ? ` +${s.waitingFor.length - 1} more` : "")
  : s.waitsOn === "timer" ? `Wakes itself at ${clock(s.wakeAt)}` : null;

// A reply's light formatting as data, for the chat window to build as text (chat.js): a line's parts are plain text,
// bold, code or a link (its label and its address, both shown as text, never a link)
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]\n]+\]\([^)\s]+\))/g;
export const mdInline = (line) => String(line).split(INLINE).filter(Boolean).map((p) => {
  if (p.length > 4 && p.startsWith("**") && p.endsWith("**")) return { b: p.slice(2, -2) };
  if (p.length > 2 && p.startsWith("`") && p.endsWith("`")) return { code: p.slice(1, -1) };
  const l = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(p);
  return l ? { link: l[1], url: l[2] } : { t: p };
});
// A table row's cells: cut at each pipe that is not inside code or escaped with a backslash; the outer pipes are optional
function cells(line) {
  const s = line.trim(), out = [];
  let cur = "", code = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "`") code = !code;
    if (s[i] === "|" && !code) { out.push(cur); cur = ""; continue; }
    cur += s[i];
  }
  out.push(cur);
  if (s.startsWith("|")) out.shift();
  if (s.endsWith("|") && !s.endsWith("\\|") && out.length > 1) out.pop();
  return out.map((c) => c.trim());
}
// The line under a table's header: dashes in each cell, a colon at either end for alignment, at least one pipe
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const divides = (line, width) => line.includes("|") && DIVIDER.test(line) && cells(line).length === width;
// Its blocks: paragraphs (a heading is one, marked), bullet lists, numbered lists that start at their first number,
// tables (a header, the divider under it, then rows up to a blank line or a line with no pipe) and code fences (one
// left open runs to the end)
export function mdBlocks(text) {
  const out = [];
  let list = null, pre = null;
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:```|~~~)/.test(line)) {
      if (pre) pre = null;
      else out.push((pre = { k: "pre", lines: [] }));
      list = null;
      continue;
    }
    if (pre) { pre.lines.push(line); continue; }
    if (line.includes("|") && i + 1 < lines.length && divides(lines[i + 1], cells(line).length)) {
      const head = cells(line), rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|") && !/^\s*(?:```|~~~)/.test(lines[i]); i++) {
        const row = cells(lines[i]);
        rows.push(head.map((_, j) => mdInline(row[j] ?? "")));
      }
      i--;
      out.push({ k: "table", head: head.map(mdInline), rows });
      list = null;
      continue;
    }
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line), ul = !ol && /^\s*[-*]\s+(.*)$/.exec(line);
    if (ol || ul) {
      const k = ol ? "ol" : "ul";
      if (!list || list.k !== k) out.push((list = k === "ol" ? { k, start: +ol[1], items: [] } : { k, items: [] }));
      list.items.push(mdInline(ol ? ol[2] : ul[1]));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
    out.push(h ? { k: "p", head: true, parts: mdInline(h[1]) } : { k: "p", parts: mdInline(line) });
  }
  return out.map((b) => (b.k === "pre" ? { k: "pre", text: b.lines.join("\n") } : b));
}
// A reply's Status line for the chat window's banner: its tone from its first words (waiting on you, still running, done;
// null for anything else) and its first letter a capital; null when there is none
export function statusOf(status) {
  const text = typeof status === "string" ? status.trim() : "";
  if (!text) return null;
  const words = text.replace(/[*`_]/g, "").toLowerCase();
  const tone = /^waiting on you\b/.test(words) ? "need" : /^still running\b/.test(words) ? "think" : /^done\b/.test(words) ? "work" : null;
  // the first letter a capital, past bold or italic marks only: never a letter inside code, after a bracket or mid-word
  return { tone, text: text.replace(/^([*_\s]*)(\p{Ll})/u, (_, a, c) => a + c.toUpperCase()) };
}
