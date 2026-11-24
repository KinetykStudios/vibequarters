import test from "node:test";
import assert from "node:assert/strict";
import { MASK, streaming, shown, setStreaming, onStreaming, splitNames } from "../public/streamer.js";
import { beatLines } from "../public/floor/beat.js";

test("off by default: text shows as written", () => {
  assert.equal(streaming(), false);
  assert.equal(shown("Fix the cart page"), "Fix the cart page");
});

test("on: every text becomes the same mask, whatever its length", () => {
  setStreaming(true);
  assert.equal(shown("QA"), MASK);
  assert.equal(shown("A much longer task name than the mask itself"), MASK);
  assert.ok(!/[A-Za-z0-9]/.test(MASK));
  setStreaming(false);
  assert.equal(shown("QA"), "QA");
});

test("listeners hear each change once; setting the same value again is not a change", () => {
  const heard = [];
  onStreaming((on) => heard.push(on));
  setStreaming(true);
  setStreaming(true);
  setStreaming(false);
  setStreaming(false);
  assert.deepEqual(heard, [true, false]);
});

test("a name inside a sentence is masked in place and the segments join back to the input", () => {
  const text = "Ask for the notes in app-11 before noon";
  const seg = splitNames(text, ["app-11"]);
  assert.deepEqual(seg, [{ text: "Ask for the notes in ", masked: false }, { text: "app-11", masked: true }, { text: " before noon", masked: false }]);
  assert.equal(seg.map((s) => s.text).join(""), text);
  assert.deepEqual(splitNames("C:/Users/x/app-11", ["app-11"]), [{ text: "C:/Users/x/", masked: false }, { text: "app-11", masked: true }]);
});

test("the longest name wins, matched literally and case-sensitively", () => {
  assert.deepEqual(splitNames("app-11 and app", ["app", "app-11"]), [
    { text: "app-11", masked: true }, { text: " and ", masked: false }, { text: "app", masked: true }]);
  assert.deepEqual(splitNames("wt.pre+x and wtXpre+x", ["wt.pre+x"]), [{ text: "wt.pre+x", masked: true }, { text: " and wtXpre+x", masked: false }]);
});

test("a name of 6 or more characters masks whatever its capitals, keeping the text as written; 3 to 5 stay exact", () => {
  assert.deepEqual(splitNames("Storefront", ["storefront"]), [{ text: "Storefront", masked: true }]);
  const text = "Finish after App-11 ships";
  const seg = splitNames(text, ["app-11"]);
  assert.deepEqual(seg, [{ text: "Finish after ", masked: false }, { text: "App-11", masked: true }, { text: " ships", masked: false }]);
  assert.equal(seg.map((s) => s.text).join(""), text);
  assert.deepEqual(splitNames("Main Street and main", ["main"]), [{ text: "Main Street and ", masked: false }, { text: "main", masked: true }]);
});

test("a short name masks only as a whole word; a name of 6 or more characters masks wherever it is glued", () => {
  assert.deepEqual(splitNames("maintenance on main, origin/main and main2", ["main"]), [
    { text: "maintenance on ", masked: false }, { text: "main", masked: true }, { text: ", origin/", masked: false },
    { text: "main", masked: true }, { text: " and main2", masked: false }]);
  assert.deepEqual(splitNames("alphabet alpha", ["alpha"]), [{ text: "alphabet ", masked: false }, { text: "alpha", masked: true }]);
  assert.deepEqual(splitNames("foo/r and o/r.", ["o/r"]), [{ text: "foo/r and ", masked: false }, { text: "o/r", masked: true }, { text: ".", masked: false }]);
  // 6 characters and up fail closed: the name never shows because something is glued to it
  assert.deepEqual(splitNames("My_Site_v2 vs My_Site's", ["My_Site"]), [
    { text: "My_Site", masked: true }, { text: "_v2 vs ", masked: false }, { text: "My_Site", masked: true }, { text: "'s", masked: false }]);
  assert.deepEqual(splitNames("app-11s", ["app-11"]), [{ text: "app-11", masked: true }, { text: "s", masked: false }]);
  assert.deepEqual(splitNames("xclaudex", ["claude"]), [{ text: "x", masked: false }, { text: "claude", masked: true }, { text: "x", masked: false }]);
  assert.deepEqual(splitNames("app-11d", ["app-11", "app"]), [{ text: "app-11", masked: true }, { text: "d", masked: false }]);
});

// A heartbeat's task and summary come from AI answers and web pages and can name anyone, the owner included: while
// streaming the room panel shows each as the mask, whole, never a name masked in place. A planted name proves it, and
// the control proves the check can see it: with Streamer off the same name is there.
test("a heartbeat-driven panel shows its task and summary in full, and while streaming only the mask, whole", () => {
  const NAME = "Zephyrine Quillfeather";
  const now = Date.parse("2025-01-06T12:00:00Z");
  const agent = { status: "working", source: "heartbeat", task: `Email ${NAME} the page list`, summary: [`${NAME} asked for the list`, "Sent 3 pages", `Follow up with ${NAME}.`], updatedAt: now - 5 * 60e3 };
  const off = beatLines(agent, now);
  assert.equal(streaming(), false);
  assert.equal(off.task, agent.task);
  assert.deepEqual(off.summary, agent.summary);
  assert.equal(off.status, "Working");
  assert.equal(off.updated, "Updated 5m ago");
  assert.ok(JSON.stringify(off).includes(NAME), "control: the scan sees the planted name when Streamer is off");
  setStreaming(true);
  try {
    const on = beatLines(agent, now);
    assert.ok(!JSON.stringify(on).includes(NAME) && !JSON.stringify(on).includes("Quill"), JSON.stringify(on));
    assert.equal(on.task, MASK);
    assert.deepEqual(on.summary, [MASK], "one mask for the lines, so not even their count shows");
    assert.equal(on.masked, true);
    assert.equal(on.status, "Working");
    assert.equal(on.updated, "Updated 5m ago");
    const session = beatLines({ ...agent, source: "session", summary: [] }, now); // session-driven text masks the same way in the room
    assert.deepEqual([session.task, session.summary], [MASK, []]);
  } finally {
    setStreaming(false);
  }
  const words = ["idle", "failed", "quiet"].map((status) => beatLines({ status, task: null, summary: [], updatedAt: null }, now));
  assert.deepEqual(words.map((w) => [w.status, w.task, w.updated]), [["Idle, no task", null, null], ["Failed", null, null], ["Quiet, no update for 2 h", null, null]]);
});

test("names under 3 characters, empty or not strings are ignored; no names and no text are the trivial cases", () => {
  assert.deepEqual(splitNames("go to x", ["x", "go", "", null, 7]), [{ text: "go to x", masked: false }]);
  assert.deepEqual(splitNames("hello", []), [{ text: "hello", masked: false }]);
  assert.deepEqual(splitNames("hello"), [{ text: "hello", masked: false }]);
  assert.deepEqual(splitNames("", ["hello"]), []);
  assert.deepEqual(splitNames(null, ["hello"]), []);
  assert.deepEqual(splitNames("abc abc", ["abc", "abc"]), [{ text: "abc", masked: true }, { text: " ", masked: false }, { text: "abc", masked: true }]);
});
