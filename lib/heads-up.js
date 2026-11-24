// What HQ tells the owner on its own after each refresh (server.js says each line out loud and notes it in the
// Assistant panel): a watched chat's reply ended; a chat's context reached 75% (time to compact) or 90% (time to hand
// it off to a fresh session). A context level is said again only after the chat drops below it (it compacted).
// Memory only.
"use strict";
const { liveName, contextLevel } = require("./assistant-cmds");

const working = (s) => s.status === "working" || s.status === "thinking";
const and = (names) => (names.length < 2 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names.at(-1));
function contextLines(crossed, level) {
  if (!crossed.length) return [];
  const [mark, one, many] = level === 2
    ? [90, "Time to hand it off to a fresh session.", "Time to hand them off to fresh sessions."]
    : [75, "Time to compact.", "Time to compact them."];
  if (crossed.length === 1) return [`${liveName(crossed[0])} is at ${crossed[0].context.pct} percent context. ${one}`];
  return [`${and(crossed.map(liveName))} are past ${mark} percent context. ${many}`];
}

function createHeadsUp() {
  const watches = new Map(); // id -> whether HQ has seen it working since the watch began
  const levels = new Map(); // id -> the context level last said (0, 1 or 2)
  return {
    watch: (id, seenWorking) => watches.set(id, !!seenWorking),
    // the lines to say for this refresh's chats, in order: watches, then context (90% before 75%)
    next(sessions) {
      const list = (sessions || []).filter((s) => !s.assistant);
      const byId = new Map(list.map((s) => [s.id, s]));
      const lines = [];
      for (const [id, seen] of watches) {
        const s = byId.get(id);
        if (!s) watches.delete(id);
        else if (working(s)) watches.set(id, true);
        else if (seen) {
          watches.delete(id);
          lines.push(`${liveName(s)} finished its reply.`);
        }
      }
      const up = { 1: [], 2: [] };
      for (const s of list) {
        const level = contextLevel(s);
        if (level > (levels.get(s.id) || 0)) up[level].push(s);
        levels.set(s.id, level);
      }
      for (const id of levels.keys()) if (!byId.has(id)) levels.delete(id);
      return [...lines, ...contextLines(up[2], 2), ...contextLines(up[1], 1)];
    },
  };
}

module.exports = { createHeadsUp };
