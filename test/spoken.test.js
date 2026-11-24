const test = require("node:test");
const assert = require("node:assert/strict");
const { spokenOf } = require("../lib/spoken");

// One reply with each thing a spoken line leaves out: an opener, a table, paths, an id, a link, code, a Status line and a
// Next steps block.
const REPLY = [
  "Sure thing, the export works and its 9 tests pass.",
  "",
  "| File | State |",
  "|---|---|",
  "| lib/tts.js | new |",
  "",
  "The key is read at `lib/tts.js` from C:/x/hq/secrets/elevenlabs.key on each call, see [the docs](https://elevenlabs.io/docs/x) for more. Head 1a2b3c4d is on the branch. A fourth sentence is never spoken.",
  "",
  "```js",
  "const key = readKey(home);",
  "```",
  "",
  "Status: waiting on you: read the handoff.",
  "",
  "**Next steps**",
  "1. Open the handoff `C:/x/handoff.md`",
].join("\n");

test("a reply speaks only its plain sentences", () => {
  assert.equal(
    spokenOf(REPLY, { openers: ["Sure thing"] }),
    "the export works and its 9 tests pass. The key is read at from on each call, see the docs for more. Head is on the branch.",
  );
});

test("an opener that is not listed is spoken", () => {
  assert.equal(spokenOf("Sure thing, it works."), "Sure thing, it works.");
});

test("an opener is dropped only as a whole word at the start", () => {
  assert.equal(spokenOf("Surely, it works.", { openers: ["Sure"] }), "Surely, it works.");
  assert.equal(spokenOf("It works, Sure.", { openers: ["Sure"] }), "It works, Sure.");
});

test("each list item ends a sentence and only the first 3 are spoken", () => {
  assert.equal(spokenOf("- one\n- two\n3. three\n- four"), "one. two. three.");
});

test("an id needs a digit, so a 7-letter word of hex letters stays", () => {
  assert.equal(spokenOf("It defaced 1a2b3c4 and 1234567."), "It defaced and.");
});

test("an unclosed fence drops everything after it", () => {
  assert.equal(spokenOf("It works.\n```\nconst a = 1;\nIt still works."), "It works.");
});

test("a bare address and a relative folder are never spoken, and/or is", () => {
  assert.equal(spokenOf("Open https://example.com/a or docs/specs/ and/or ~/notes now."), "Open or and/or now.");
});

test("at most 400 characters, cut at a word", () => {
  const long = Array.from({ length: 3 }, () => "word ".repeat(40).trim() + ".").join(" ");
  const out = spokenOf(long);
  assert.ok([...out].length <= 400, String(out.length));
  assert.ok(long.startsWith(out));
  assert.match(out, /word$/);
});

test("nothing to say gives an empty string", () => {
  assert.equal(spokenOf("| a | b |\n|---|---|\nStatus: all done."), "");
});
