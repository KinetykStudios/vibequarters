// The approvals chooser (public/approvals.js): what it shows from GET /api/approvals, when it opens by itself, and that
// it posts a preset's id and nothing else. Run with a small stand-in document.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PRESETS, NEVER_AUTO } = require("../lib/approvals");

// --- a stand-in for the few DOM parts the chooser uses ---
class Node {
  constructor(tag) { this.tag = tag; this.kids = []; this.attrs = {}; this.on = {}; this.hidden = false; this.disabled = false; this.isConnected = true; this.parent = null; this.text = ""; this.style = {}; }
  append(...k) { for (const n of k) { this.kids.push(n); if (n instanceof Node) n.parent = this; } }
  replaceChildren(...k) { this.kids = []; this.append(...k); }
  setAttribute(k, v) { this.attrs[k] = v; if (k === "hidden") this.hidden = true; if (k === "disabled") this.disabled = true; if (k === "checked") this.checked = true; if (k === "value" || k === "type") this[k] = v; }
  addEventListener(k, f) { this.on[k] = f; }
  get textContent() { return this.text + this.kids.map((k) => (k instanceof Node ? k.textContent : k)).join(""); }
  set textContent(t) { this.text = t; this.kids = []; }
  focus() { document.activeElement = this; }
  all() { return this.kids.flatMap((k) => (k instanceof Node ? [k, ...k.all()] : [])); }
  querySelector(q) { const a = this.all().filter((n) => n.tag === "input" && n.checked); return (q.includes(":not([disabled])") ? a.filter((n) => !n.disabled) : a)[0] || null; }
  querySelectorAll() { return this.all().filter((n) => n.tag === "button" || n.tag === "input"); }
}
globalThis.Node = Node;
globalThis.SVGElement = class {};
const body = new Node("body");
globalThis.document = { body, activeElement: body, createElement: (t) => new Node(t), querySelector: (q) => (q.includes("hq-token") ? { content: "ab".repeat(32) } : null) };
globalThis.addEventListener = () => {};
let served, posts = [];
globalThis.fetch = async (url, o = {}) => {
  if (o.method === "POST") {
    posts.push([url, JSON.parse(o.body)]);
    if (served.fail) return { ok: false };
    served = { ...served, chosen: JSON.parse(o.body).preset };
    return { ok: true, json: async () => ({ ok: true }) };
  }
  assert.equal(url, "/api/approvals");
  return { ok: true, json: async () => served };
};
const { chooserOf, startApprovals, TITLE, READ_ONLY, NOT_INSTALLED, ASK_NOT_INSTALLED } = await import("../public/approvals.js");

const view = (over = {}) => ({ chosen: null, canChoose: true, neverAuto: NEVER_AUTO, presets: PRESETS.map((p) => ({ ...p, recommended: !!p.recommended, installed: true })), ...over });

test("on a first run it opens by itself with the recommended preset picked and four presets in plain words", () => {
  const c = chooserOf(view());
  assert.equal(c.open, true);
  assert.equal(c.picked, "routine");
  assert.deepEqual(c.rows.map((r) => r.id), ["ask-all", "safe-reads", "routine", "routine-judge"]);
  assert.deepEqual(c.rows.filter((r) => r.recommended).map((r) => r.title), ["Approve routine coding work"]);
  assert.ok(c.rows.every((r) => r.line.length > 20 && !r.note && !r.current));
  assert.match(c.neverAuto, /Deletes, force pushes/);
});

test("with a saved choice it stays closed and starts on that choice", () => {
  const c = chooserOf(view({ chosen: "safe-reads" }));
  assert.equal(c.open, false);
  assert.equal(c.picked, "safe-reads");
  assert.deepEqual(c.rows.filter((r) => r.current).map((r) => r.id), ["safe-reads"]);
});

test("read-only (control off): it never opens by itself, says why, and cannot save", () => {
  const c = chooserOf(view({ canChoose: false }));
  assert.equal(c.open, false);
  assert.equal(c.canChoose, false);
  assert.equal(c.note, READ_ONLY);
});

test("without the system pack each preset says so, and Ask me everything says it needs none", () => {
  const c = chooserOf(view({ presets: view().presets.map((p) => ({ ...p, installed: false })) }));
  assert.deepEqual(c.rows.map((r) => r.note), [ASK_NOT_INSTALLED, NOT_INSTALLED, NOT_INSTALLED, NOT_INSTALLED]);
});

test("an answer it cannot read shows nothing", () => {
  for (const bad of [null, {}, { presets: [] }, { presets: "x" }]) assert.equal(chooserOf(bad), null);
});

test("the chooser opens on first run, saves the pick by id only, closes, and opens again from the button with it marked", async () => {
  served = view();
  const button = new Node("button");
  button.hidden = true;
  await startApprovals(button);
  assert.equal(button.hidden, false, "the header's button shows");
  const pop = body.kids.at(-1);
  assert.equal(pop.hidden, false, "open by itself");
  assert.ok(pop.textContent.includes(TITLE));
  const radios = () => pop.all().filter((n) => n.tag === "input");
  assert.deepEqual(radios().map((n) => !!n.checked), [false, false, true, false]);
  // pick the second, save: the server fails first
  for (const r of radios()) r.checked = r.value === "safe-reads";
  const save = pop.all().find((n) => n.textContent === "Save" && n.tag === "button");
  served.fail = true;
  await save.on.click();
  assert.equal(pop.hidden, false, "a failed save stays open");
  assert.ok(pop.textContent.includes("did not save"));
  served.fail = false;
  await save.on.click();
  assert.equal(pop.hidden, true, "saved and closed");
  assert.deepEqual(posts, [["/api/approvals", { preset: "safe-reads" }], ["/api/approvals", { preset: "safe-reads" }]]);
  await button.on.click();
  assert.equal(pop.hidden, false);
  assert.deepEqual(radios().map((n) => !!n.checked), [false, true, false, false]);
  assert.ok(pop.textContent.includes("Current"));
});
