import test from "node:test";
import assert from "node:assert/strict";
import { usd, tokens, dur, countdown, num, dayLabel, count, noun, clock, waitText, mdInline, mdBlocks, statusOf } from "../public/format.js";

test("money, tokens, durations, counts, countdowns and days", () => {
  assert.equal(usd(1234.5), "$1,234.50");
  assert.equal(usd(null), "-");
  assert.equal(tokens(1530000), "1.5M");
  assert.equal(dur(59e3), "59s");
  assert.equal(dur(61e3), "1m");
  assert.equal(dur(3725e3), "1h 2m");
  assert.equal(countdown(65e3), "1:05");
  assert.equal(num(1284.4), "1,284");
  assert.equal(num(null), "-");
  assert.equal(dayLabel("2025-01-15"), "Jan 15");
});

test("a count's noun agrees with its number", () => {
  assert.equal(count(1, "subagent"), "1 subagent");
  assert.equal(count(2, "subagent"), "2 subagents");
  assert.equal(count(0, "conflict"), "0 conflicts");
  assert.equal(count(1840, "action"), "1,840 actions");
  assert.equal(count(1, "file conflict"), "1 file conflict");
  assert.equal(count(null, "action"), "- actions");
  assert.equal(noun(1, "lock"), "lock");
  assert.equal(noun(3, "lock"), "locks");
});

test("waitText names what a finished turn waits on: agents, a background job, a timer, else nothing", () => {
  assert.equal(waitText({ waitsOn: "subagent", waitingFor: ["Review the diff", "Run the tests"] }), "Waiting on 2 agents");
  assert.equal(waitText({ waitsOn: "subagent", waitingFor: [] }), "Waiting on 1 agent");
  assert.equal(waitText({ waitsOn: "background", waitingFor: ["npm test"] }), "Waiting on: npm test");
  assert.equal(waitText({ waitsOn: "background", waitingFor: ["npm test", "vercel build", "watch logs"] }), "Waiting on: npm test +2 more");
  assert.equal(waitText({ waitsOn: "background", waitingFor: [] }), "Waiting on: a background job");
  const wakeAt = Date.UTC(2025, 0, 6, 15, 30);
  assert.equal(waitText({ waitsOn: "timer", wakeAt }), "Wakes itself at " + clock(wakeAt));
  assert.equal(waitText({ waitsOn: null, waitingFor: [] }), null);
});

test("mdInline cuts a line into plain text, bold, code and links (a link's label and its address, both text)", () => {
  assert.deepEqual(mdInline("Run **the save** command `npm run save` now"), [{ t: "Run " }, { b: "the save" }, { t: " command " }, { code: "npm run save" }, { t: " now" }]);
  assert.deepEqual(mdInline("See [the PR](https://github.com/o/r/pull/12) first"), [{ t: "See " }, { link: "the PR", url: "https://github.com/o/r/pull/12" }, { t: " first" }]);
  assert.deepEqual(mdInline("an empty `` pair stays"), [{ t: "an empty `` pair stays" }]);
  assert.deepEqual(mdInline("**"), [{ t: "**" }]);
  assert.deepEqual(mdInline(""), []);
  assert.deepEqual(mdInline('<img src=x onerror="1">'), [{ t: '<img src=x onerror="1">' }]);
});

test("mdBlocks reads paragraphs, bullet lists, numbered lists from their first number, headings and code fences", () => {
  const text = "### The checks\nI ran **5** checks:\n1. Build\n2. Lint\n\n3. Tests\n- one\n* two\n```\nnpm test\n  --watch\n```\nDone.";
  assert.deepEqual(mdBlocks(text), [
    { k: "p", head: true, parts: [{ t: "The checks" }] },
    { k: "p", parts: [{ t: "I ran " }, { b: "5" }, { t: " checks:" }] },
    { k: "ol", start: 1, items: [[{ t: "Build" }], [{ t: "Lint" }]] },
    { k: "ol", start: 3, items: [[{ t: "Tests" }]] },
    { k: "ul", items: [[{ t: "one" }], [{ t: "two" }]] },
    { k: "pre", text: "npm test\n  --watch" },
    { k: "p", parts: [{ t: "Done." }] },
  ]);
  assert.deepEqual(mdBlocks("1) first\n2) second"), [{ k: "ol", start: 1, items: [[{ t: "first" }], [{ t: "second" }]] }]);
  assert.deepEqual(mdBlocks("```\nnever closed"), [{ k: "pre", text: "never closed" }]);
  assert.deepEqual(mdBlocks(""), []);
});

test("mdBlocks reads a table: its header, the divider under it, and its rows, each cell with its own formatting", () => {
  const text = "Before:\n| Suite | Time | Note |\n|---|---|---|\n| Cart | 4 min | Covers the **cart** page |\n| Docs | 30-40 s | Uses `npm test` now |\nAfter.";
  assert.deepEqual(mdBlocks(text), [
    { k: "p", parts: [{ t: "Before:" }] },
    {
      k: "table",
      head: [[{ t: "Suite" }], [{ t: "Time" }], [{ t: "Note" }]],
      rows: [
        [[{ t: "Cart" }], [{ t: "4 min" }], [{ t: "Covers the " }, { b: "cart" }, { t: " page" }]],
        [[{ t: "Docs" }], [{ t: "30-40 s" }], [{ t: "Uses " }, { code: "npm test" }, { t: " now" }]],
      ],
    },
    { k: "p", parts: [{ t: "After." }] },
  ]);
});

test("mdBlocks table edge cases: no outer pipes, aligned dividers, short and long rows, pipes inside code or escaped", () => {
  assert.deepEqual(mdBlocks("a | b\n:--- | ---:\n1 | 2"), [{ k: "table", head: [[{ t: "a" }], [{ t: "b" }]], rows: [[[{ t: "1" }], [{ t: "2" }]]] }]);
  // a short row is filled with empty cells, a long one cut to the header's width
  assert.deepEqual(mdBlocks("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |").find((b) => b.k === "table").rows, [[[{ t: "1" }], []], [[{ t: "1" }], [{ t: "2" }]]]);
  // a pipe inside code or escaped with a backslash stays in its cell
  assert.deepEqual(mdBlocks("| cmd | note |\n|---|---|\n| `a | b` | x \\| y |").find((b) => b.k === "table").rows, [[[{ code: "a | b" }], [{ t: "x | y" }]]]);
  // a header with no divider under it is a plain line, and so is a divider with nothing above it
  assert.deepEqual(mdBlocks("| not | a table |\nnext"), [{ k: "p", parts: [{ t: "| not | a table |" }] }, { k: "p", parts: [{ t: "next" }] }]);
  assert.deepEqual(mdBlocks("|---|---|"), [{ k: "p", parts: [{ t: "|---|---|" }] }]);
  // a divider whose cell count differs from the header's is not a table
  assert.deepEqual(mdBlocks("| a | b |\n|---|").map((b) => b.k), ["p", "p"]);
  // the table ends at a blank line or a line with no pipe
  assert.deepEqual(mdBlocks("| a |\n|---|\n| 1 |\n\n| 2 |").map((b) => b.k), ["table", "p"]);
});

test("statusOf reads a reply's Status line: its tone from its first words, its first letter a capital", () => {
  assert.deepEqual(statusOf("waiting on you: the token"), { tone: "need", text: "Waiting on you: the token" });
  assert.deepEqual(statusOf("**Still running:** the build"), { tone: "think", text: "**Still running:** the build" });
  assert.deepEqual(statusOf("done, nothing left"), { tone: "work", text: "Done, nothing left" });
  assert.deepEqual(statusOf("Done"), { tone: "work", text: "Done" });
  assert.deepEqual(statusOf("doneness unknown"), { tone: null, text: "Doneness unknown" });
  assert.deepEqual(statusOf("3 checks left"), { tone: null, text: "3 checks left" });
  assert.equal(statusOf("   "), null);
  assert.equal(statusOf(null), null);
});

test("statusOf capitalizes only a first letter, past bold or italic marks, never one inside code or a word", () => {
  assert.deepEqual(statusOf("`bun test` still failing"), { tone: null, text: "`bun test` still failing" });
  assert.deepEqual(statusOf("état final: the merge"), { tone: null, text: "État final: the merge" });
  assert.deepEqual(statusOf("**still running:** the build"), { tone: "think", text: "**Still running:** the build" });
  assert.deepEqual(statusOf("_waiting on you_: the token"), { tone: "need", text: "_Waiting on you_: the token" });
  assert.deepEqual(statusOf("(done) nothing left"), { tone: null, text: "(done) nothing left" });
});
