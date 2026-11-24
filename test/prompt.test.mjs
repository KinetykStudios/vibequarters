// The Prompt box's link, with no DOM: the exact link for a UUID chat; the owner's text arriving whole in VS Code, read
// the way VS Code and the Claude Code extension read it (the characters that would break it included); no link for any
// other id or for empty text; no link over 2,048 characters, with promptTooLong saying when that is the reason; and the
// UUID rule held equal to the one lib/describe.js keeps for its chat links.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { promptLink, promptTooLong, canPrompt, PROMPT_MAX, PROMPT_LINK_MAX } from "../public/prompt.js";

const ID = "0a1b2c3d-0000-4000-8000-0000000000aa";
const BASE = "vscode://anthropic.claude-code/open?session=" + ID + "&prompt=";
// built from code points, so no lone surrogate has to be written into this file
const ROCKET = String.fromCodePoint(0x1f680), HIGH = String.fromCharCode(0xd83d), LOW = String.fromCharCode(0xde80);
// What the extension gets: VS Code's Uri.parse percent-decodes the query once, then the extension's handleUri reads it
// with new URLSearchParams(uri.query) (the Claude Code extension), which splits on & and decodes again
const vscodeReads = (link) => new URLSearchParams(decodeURIComponent(link.slice(link.indexOf("?") + 1)));

test("a UUID chat with text gives the exact link, its text encoded twice", () => {
  assert.equal(promptLink(ID, "run the tests"), BASE + "run%2520the%2520tests");
  assert.equal(promptLink(ID, "  run the tests  "), BASE + "run%2520the%2520tests"); // the ends are trimmed
});

test("VS Code's two decodes hand the extension the exact text: &, +, %, #, ?, =, a newline and an emoji included", () => {
  for (const text of ["fix the header, then run tests & report", "C++ a+b", "50% #1 = done?", "first line\nsecond line", "ship it " + ROCKET, "plain words only"]) {
    const link = promptLink(ID, text);
    assert.ok(link && link.startsWith(BASE), text);
    assert.doesNotMatch(link.slice(BASE.length), /[&#?+\s]/); // nothing in the text can end the parameter or the URL
    const got = vscodeReads(link);
    assert.deepEqual([...got.keys()], ["session", "prompt"], text);
    assert.equal(got.get("session"), ID);
    assert.equal(got.get("prompt"), text);
  }
});

test("typed text naming another chat cannot steer the link: the extension reads the first session, and the text stays text", () => {
  const other = "0a1b2c3d-0000-4000-8000-0000000000bb", text = "ok&session=" + other;
  const got = vscodeReads(promptLink(ID, text));
  assert.equal(got.get("session"), ID);
  assert.equal(got.get("prompt"), text);
});

test("any id but a lowercase UUID gives null: uppercase, padded, a newline after it, a vscode:// link, a non-string", () => {
  for (const id of [ID.toUpperCase(), " " + ID, ID + " ", ID + "\n", "vscode://anthropic.claude-code/open?session=" + ID, "alpha", "", ID.slice(1), 42, null, undefined, {}, [ID]])
    assert.equal(promptLink(id, "run the tests"), null, JSON.stringify(id));
});

test("canPrompt says which chats get a Prompt box: a lowercase UUID id only, by the same rule as the link", () => {
  assert.equal(canPrompt(ID), true);
  for (const id of [ID.toUpperCase(), " " + ID, ID + "\n", "vscode://anthropic.claude-code/open?session=" + ID, "alpha", "", 42, null, undefined, {}]) {
    assert.equal(canPrompt(id), false, JSON.stringify(id));
    assert.equal(promptLink(id, "run the tests"), null); // never a box without a link, never a link without a box
  }
});

test("empty or space-only text gives null, and so does text that is not a string", () => {
  for (const text of ["", " ", "   \n\t  ", null, undefined, 42, ["run"]]) {
    assert.equal(promptLink(ID, text), null, JSON.stringify(text));
    assert.equal(promptTooLong(ID, text), false); // nothing typed is not too long
  }
});

test("a link over 2,048 characters is refused (Edge on Windows may drop it), and promptTooLong says that is why", () => {
  assert.equal(PROMPT_LINK_MAX, 2048);
  assert.equal(PROMPT_MAX, 2000); // the box's maxlength
  const fits = "a".repeat(PROMPT_LINK_MAX - BASE.length); // 1,960 characters that encode to themselves: a link of exactly 2,048
  assert.equal(promptLink(ID, fits).length, PROMPT_LINK_MAX);
  assert.equal(promptTooLong(ID, fits), false);
  assert.equal(promptLink(ID, fits + "a"), null); // 2,049
  assert.equal(promptTooLong(ID, fits + "a"), true);
  const prose = "fix the header, then run the tests and report back. ".repeat(40).slice(0, 1500); // spaces and commas grow 5 and 5 times
  assert.equal(promptLink(ID, prose), null);
  assert.equal(promptTooLong(ID, prose), true);
  const short = "fix the header, then run the tests and report back.";
  assert.ok(promptLink(ID, short).length <= PROMPT_LINK_MAX);
  assert.equal(promptTooLong(ID, short), false);
});

test("a lone surrogate anywhere (pasted text) gives null, never a throw, and is not called too long", () => {
  for (const text of ["fix " + LOW + " now", "fix " + HIGH + " now", HIGH + "fix", "fix" + LOW]) {
    assert.equal(promptLink(ID, text), null);
    assert.equal(promptTooLong(ID, text), false);
  }
});

test("the UUID rule is the one lib/describe.js keeps for its chat links (a reply's and a notice's)", () => {
  const rule = (file) => readFileSync(new URL("../" + file, import.meta.url), "utf8").match(/^const UUID = (\/.+\/);\r?$/m)?.[1];
  assert.ok(rule("lib/describe.js"));
  assert.equal(rule("public/prompt.js"), rule("lib/describe.js"));
});
