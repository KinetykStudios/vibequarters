// The reply spoken while it is written. Each message of a turn is fed in as it streams (start, text, end): its first
// sentence is said the moment it is complete, and the rest of what spokenOf says of the whole message when it ends, so
// the first words play while the rest is still being written, and what is said never goes past spokenOf (three sentences,
// no opener, path, code, Status line or Next steps).
"use strict";
const { spokenOf } = require("./spoken");

// where the text written so far ends a sentence or a line: everything before it is complete
function complete(s) {
  let end = -1;
  for (const m of s.matchAll(/[.!?](?=\s)|\n/g)) end = m.index + 1;
  return end > 0 ? s.slice(0, end) : "";
}

function createSpeechStream({ openers = [], say }) {
  let buf = null; // the message being written, or null between messages
  let first = null; // its first sentence, once said
  let any = false; // this turn said something
  const sentences = (t) => spokenOf(t, { openers }).split(/(?<=[.!?])\s+/).filter(Boolean);
  // an opener still coming in in pieces waits, so it is never said
  const opening = (t) => {
    const x = t.trim().toLowerCase();
    return !!x && openers.some((o) => o.toLowerCase().startsWith(x));
  };
  return {
    start() {
      buf = "";
      first = null;
    },
    text(delta) {
      if (buf === null) buf = "";
      buf += delta;
      if (first !== null) return;
      const done = complete(buf);
      if (!done || opening(done)) return;
      const s = sentences(done)[0];
      if (!s) return;
      first = s;
      any = true;
      say(s);
    },
    end() {
      if (buf === null) return;
      const all = sentences(buf);
      const rest = first !== null ? all.slice(1) : all;
      buf = null;
      first = null;
      if (!rest.length) return;
      any = true;
      say(rest.join(" "));
    },
    saidAny: () => any,
    turn() {
      any = false;
      buf = null;
      first = null;
    },
  };
}

module.exports = { createSpeechStream };
