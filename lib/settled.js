// The settled history: what became of each read-back the assistant proposed and of each decision that left the open
// list, newest first, at most 20, in memory only, so a restart forgets it. An entry is { id, at, kind: "readback" |
// "decision", what, outcome, via }: `what` is one plain line (a read-back's first line, or a decision's chat and what it
// asked), `outcome` HQ's fixed words, `via` who or what settled it. The payload carries it (server.js), the Assistant
// module shows its newest 5, and the assistant reads it for its status.
"use strict";

const MAX = 20;
const PENDING_MAX = 256; // answers HQ wrote whose item was never seen to leave: the oldest goes first
const REASON_MAX = 200; // a failed confirm's reason (a VS Code error can be long), in characters

// A decision's answer in the history's words, by its choice: a question's option or its picks are an answer
const answeredAs = (choice) => (choice === "allow" ? "approved" : choice === "deny" ? "denied" : choice === "revise" ? "changes asked" : "answered");
// Who wrote it, by lib/decisions.js `via`: none is the owner's own click
const VIA = { window: "approve window", readback: "assistant read-back" };
// A confirmed read-back's outcome by its kind; one that did not go through says what did not happen, with HQ's reason
const DONE = { send: "sent", window: "window opened", open: "session opened", tool: "approved" };
const NOT = { send: "not sent", window: "window not opened", open: "session not opened", answer: "not answered", tool: "not run" };
function confirmedOutcome(p, result) {
  if (result !== true) return `${NOT[p.kind] || "not done"}: ${[...String(result)].slice(0, REASON_MAX).join("")}`;
  return p.kind === "answer" ? answeredAs(p.choice) : DONE[p.kind];
}
// A read-back's line: its text's first line, without the colon that leads into a prompt shown under it
const firstLine = (text) => String(text).split("\n")[0].replace(/:$/, "");

function createSettled({ max = MAX } = {}) {
  let list = [];
  let shown = new Map(); // decision id -> its line, for each item open at the last look
  const wrote = new Map(); // decision id -> { choice, via } of the answer HQ wrote, until its item leaves
  const add = (e) => {
    list = [e, ...list].slice(0, max);
  };
  return {
    // A read-back settled: confirmed (confirmedOutcome), canceled, expired, or dropped since its decision closed
    readback(id, text, outcome, via, now) {
      add({ id, at: now, kind: "readback", what: firstLine(text), outcome, via });
    },
    // An answer HQ wrote for an open item, kept until the item leaves the open list
    answered(id, choice, via) {
      wrote.delete(id);
      wrote.set(id, { choice, via });
      if (wrote.size > PENDING_MAX) wrote.delete(wrote.keys().next().value);
    },
    // The open items now (the payload's decisions; a reply has no request, so it is left out). Each one open at the last
    // look that is not open now has left: with the answer HQ wrote for it, or answered in VS Code or gone (the chat
    // answered it there, the bridge gave up, the chat closed). One pass over the items then and now.
    sync(items, now) {
      const next = new Map();
      for (const d of items) if (d.kind !== "reply") next.set(d.id, `${d.sessionName || d.who} ${d.what}`);
      for (const [id, what] of shown) {
        if (next.has(id)) continue;
        const a = wrote.get(id);
        wrote.delete(id);
        add({ id, at: now, kind: "decision", what, outcome: a ? answeredAs(a.choice) : "answered in VS Code or gone", via: a ? VIA[a.via] || "you" : "outside VibeQuarters" });
      }
      shown = next;
    },
    list: () => list,
  };
}

module.exports = { createSettled, confirmedOutcome };
