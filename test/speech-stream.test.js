// lib/speech-stream.js: the reply is spoken while it is written. Its first sentence goes the moment it is complete, the
// rest of what spokenOf would say when the message ends; what is said is never more than spokenOf says of the whole
// message.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSpeechStream } = require("../lib/speech-stream");
const { spokenOf } = require("../lib/spoken");

function run(chunks, openers = ["No. 1"]) {
  const said = [];
  const s = createSpeechStream({ openers, say: (t) => said.push(t) });
  s.start();
  const after = [];
  for (const c of chunks) {
    s.text(c);
    after.push(said.length);
  }
  s.end();
  return { said, after };
}

test("the first sentence goes as soon as it is complete, before the rest is written; the rest goes when the message ends", () => {
  const { said, after } = run(["Three chats are ", "working. The build is ", "waiting on you. ", "The docs are done."], []);
  assert.deepEqual(after, [0, 1, 1, 1], "said once the first sentence ended, nothing more until the end");
  assert.deepEqual(said, ["Three chats are working.", "The build is waiting on you. The docs are done."]);
});

test("everything said adds up to what spokenOf says of the whole message: three sentences, no Status line, no Next steps", () => {
  const full = "No. 1: Done. It's live on abc1234.\n\nMore detail here. And more.\n\nStatus: all done.\n\n**Next steps**\n1. Refresh";
  const pieces = full.match(/[\s\S]{1,7}/g);
  const { said } = run(pieces);
  assert.equal(said.join(" "), spokenOf(full, { openers: ["No. 1"] }));
  assert.equal(said[0], "Done.", "the opener is never said, even while it comes in pieces");
});

test("an opener still coming in is waited for, never said in part", () => {
  const { said, after } = run(["No. ", "1: ", "All quiet. ", "Nothing waits."]);
  assert.deepEqual(after, [0, 0, 1, 1]);
  assert.deepEqual(said, ["All quiet.", "Nothing waits."]);
});

test("each message of a turn is its own: a line before a tool call is said, and the answer after it gets its own sentences", () => {
  const said = [];
  const s = createSpeechStream({ openers: [], say: (t) => said.push(t) });
  s.start();
  s.text("Let me check the board.");
  s.end();
  s.start();
  s.text("Two chats are waiting. One needs your yes.");
  s.end();
  assert.deepEqual(said, ["Let me check the board.", "Two chats are waiting.", "One needs your yes."]);
});

test("a message with nothing to say says nothing; an end with no start, or a second end, says nothing again", () => {
  const said = [];
  const s = createSpeechStream({ openers: [], say: (t) => said.push(t) });
  s.end();
  s.start();
  s.text("```\ncode\n```");
  s.end();
  s.end();
  assert.deepEqual(said, []);
  assert.equal(s.saidAny(), false);
  s.start();
  s.text("Hi there.");
  s.end();
  assert.equal(s.saidAny(), true, "this turn said something");
  s.turn();
  assert.equal(s.saidAny(), false, "a new turn starts at nothing said");
});
