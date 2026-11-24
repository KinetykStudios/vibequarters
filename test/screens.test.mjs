// The desk screens' painters (public/floor/screens.js), on a 2D context that records what is drawn: each kind of
// step drawn like its app, the left screen's steps and the right screen's files, the status strip and its setter, the
// typing reveal, the blinking cursor of a step whose result has not landed, the screenshot route, and Streamer, under
// which every screen paints the stand-in content and fetches nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { setStreaming, MASK } from "../public/streamer.js";
import {
  newScreen, setScreen, setStatus, revealStep, isLive, pending, wantShot, shotLoader, pageItems, paintCenter, newSide, setSide, sideSig, paintSide, setReduced, ago, STATUS_MAX,
} from "../public/floor/screens.js";
import * as SCR from "../public/floor/screens.js";

const ID = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2025-01-24T12:00:00Z");
// a 2D context that keeps every text drawn and every call made
function ctx() {
  const o = { texts: [], calls: [] };
  return new Proxy(o, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "measureText") return (s) => ({ width: String(s).length * 7 });
      if (k === "fillText" || k === "strokeText") return (s, ...a) => { t.texts.push(String(s)); t.calls.push([k, String(s), ...a]); };
      if (k === "createLinearGradient") return () => ({ addColorStop() {} });
      return (...a) => { t.calls.push([k, ...a]); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
// the stand-in terminal, as furniture.js passes it: it records the title it was asked to draw
function fakeOf(g) {
  const seen = [];
  const fake = (title) => { seen.push(title); g.fillText(title, 16, 26); };
  return { fake, seen };
}
const step = (kind, extra = {}) => ({ kind, tool: null, at: NOW - 30e3, done: true, error: false, head: null, title: null, lines: [], shot: null, steps: [], files: [], ...extra });
const SCREENS = {
  edit: step("edit", { tool: "Edit", head: "CartSummary.tsx", lines: [" const subtotal = sum(items);", "-const shipping = subtotal > 75 ? 0 : 6.95;", "+const discount = applyDiscount(subtotal, promo);", "+const shipping = subtotal - discount > 75 ? 0 : 6.95;"] }),
  shell: step("shell", { tool: "Bash", head: "npx vitest run src/cart", lines: ["Test Files  4 passed (4)", "Tests  33 passed (33)"] }),
  read: step("read", { tool: "Read", head: "pricing.ts", lines: ["     1  import type { Promo } from './types';", "     2  export const FLAT_SHIPPING = 6.95;"] }),
  search: step("search", { tool: "Grep", head: "applyDiscount\\(", title: "Grep", lines: ["src/cart/useCart.ts:57:      discount: applyDiscount(subtotal, state.promo),"] }),
  browser: step("browser", { tool: "mcp__playwright__browser_snapshot", head: "http://localhost:5173/products/ridgeline-40l", title: "Ridgeline 40L Pack | Northwind", lines: ["- main [ref=e9]:", "  - heading \"Ridgeline 40L Pack\" [level=1] [ref=e11]", "  - paragraph [ref=e12]: A 40 liter pack for long weekends.", "  - button \"Add to cart\" [ref=e14]"] }),
  shot: step("shot", { tool: "mcp__playwright__browser_take_screenshot", head: "http://localhost:5173/", title: "Northwind Outfitters", shot: ID }),
  web: step("web", { tool: "WebSearch", head: "vitest fake timers", lines: ["Timers | Guide | Vitest", "Fake timers and awaited promises"] }),
  reply: step("reply", { lines: ["The cart now applies a promo code before shipping.", "", "All 33 cart tests pass."] }),
  other: step("other", { tool: "TodoWrite", head: "Updating the todo list" }),
};
// the real strings each screen carries, which Streamer must never let a screen paint
const REAL = ["CartSummary.tsx", "applyDiscount", "npx vitest", "33 passed", "pricing.ts", "FLAT_SHIPPING", "localhost:5173", "Ridgeline", "Northwind", "vitest fake timers", "Timers | Guide", "promo code", "Updating the todo list", "useCart"];
const leaks = (texts) => REAL.filter((r) => texts.some((t) => t.includes(r)));
const shown = (sc) => { const T = newScreen("orchard task"); setScreen(T, sc); while (revealStep(T)); return T; };
const paint = (T) => { const g = ctx(), f = fakeOf(g); const rec = paintCenter(g, T, 640, 400, f.fake); return { g, rec, fake: f.seen }; };

test.afterEach(() => { setStreaming(false); setReduced(false); });

test("each kind of step paints its own app from its screen: an editor, a terminal, a search view, a browser, a search page, a reply", () => {
  const want = {
    edit: ["CartSummary.tsx", "const shipping = subtotal > 75 ? 0 : 6.95;", "const discount = applyDiscount(subtotal, promo);"],
    shell: ["npx vitest run src/cart", "Tests  33 passed (33)"],
    read: ["pricing.ts", "export const FLAT_SHIPPING = 6.95;"],
    search: ["applyDiscount\\(", "Grep", "src/cart/useCart.ts"],
    browser: ["http://localhost:5173/products/ridgeline-40l", "Ridgeline 40L Pack | Northwind", "Ridgeline 40L Pack", "A 40 liter pack for long weekends.", "Add to cart"],
    shot: ["http://localhost:5173/", "Northwind Outfitters"],
    web: ["vitest fake timers", "Timers | Guide | Vitest", "Fake timers and awaited promises"],
  };
  for (const [kind, strings] of Object.entries(want)) {
    const T = shown(SCREENS[kind]);
    assert.equal(isLive(T), true, kind);
    const { g, rec, fake } = paint(T);
    assert.equal(fake.length, 0, `${kind}: not the fake terminal`);
    assert.deepEqual([rec.source, rec.kind], ["live", kind]);
    assert.equal(rec.light, ["browser", "shot", "web"].includes(kind), kind + ": a white page says so, so its screen is dimmed");
    for (const s of strings) assert.ok(g.texts.some((t) => t.includes(s)), `${kind} draws "${s}" (drew ${JSON.stringify(g.texts)})`);
    assert.deepEqual(rec.text, g.texts, `${kind}: the painted record is what was drawn`);
  }
  // the browser draws the page from the snapshot's text, never its markup
  assert.ok(!paint(shown(SCREENS.browser)).g.texts.some((t) => /\[ref=|\[level=|^- /.test(t)));
  // a reply is its text, typed out
  const r = paint(shown(SCREENS.reply));
  assert.ok(r.g.texts.join(" ").includes("The cart now applies a promo code before shipping.") && r.g.texts.join(" ").includes("All 33 cart tests pass."));
});

test("an edit strikes its old lines in red over its new lines in green", () => {
  const { g } = paint(shown(SCREENS.edit));
  const at = (s) => g.calls.findIndex((c) => c[0] === "fillText" && c[1] === s);
  const gone = "const shipping = subtotal > 75 ? 0 : 6.95;";
  const old = at(gone), neu = at("const discount = applyDiscount(subtotal, promo);");
  assert.ok(old >= 0 && neu > old, "the removed line is drawn above the added one");
  // a rule as wide as the removed text (this context measures 7 px a character), drawn through it
  const strike = g.calls.slice(old + 1, neu).some((c) => c[0] === "fillRect" && c[3] === gone.length * 7 && c[4] <= 2);
  assert.ok(strike, "the removed line is struck through");
  const colors = [];
  const g2 = ctx(); paintCenter(new Proxy(g2, { set(t, k, v) { if (k === "fillStyle") colors.push(v); t[k] = v; return true; } }), shown(SCREENS.edit), 640, 400, () => {});
  assert.ok(colors.some((c) => /^#f[0-9a-f]{5}$/i.test(c) && parseInt(c.slice(1, 3), 16) > 0xd0 && parseInt(c.slice(3, 5), 16) < 0xa0), "a red is used");
  assert.ok(colors.some((c) => /^#[0-9a-f]{6}$/i.test(c) && parseInt(c.slice(3, 5), 16) > 0xb0 && parseInt(c.slice(1, 3), 16) < 0xa0), "a green is used");
});

test("a screenshot is drawn in the browser window once loaded, and only the screenshot its screen names", () => {
  const T = shown(SCREENS.shot);
  assert.equal(paint(T).g.calls.some((c) => c[0] === "drawImage"), false, "nothing loaded yet");
  T.img = { width: 1280, height: 800 }; T.imgId = ID;
  const { g, rec } = paint(T);
  assert.ok(g.calls.some((c) => c[0] === "drawImage" && c[1] === T.img));
  assert.equal(rec.shot, ID);
  T.imgId = "f".repeat(32); // a picture loaded for another screenshot is never drawn
  assert.equal(paint(T).g.calls.some((c) => c[0] === "drawImage"), false);
});

test("anything else, or no step yet, is the stand-in terminal titled with the step's label or the figure's task", () => {
  let { rec, fake } = paint(shown(SCREENS.other));
  assert.deepEqual(fake, ["UPDATING THE TODO LIST"]);
  assert.equal(rec.source, "fake");
  ({ rec, fake } = paint(newScreen("Wire the order review")));
  assert.deepEqual(fake, ["WIRE THE ORDER REVIEW"]);
  assert.equal(isLive(newScreen("x")), false);
});

test("Streamer on: every screen paints the stand-in content, with no real text, URL, file name or screenshot", () => {
  for (const [kind, sc] of Object.entries(SCREENS)) {
    const T = shown(sc);
    if (kind === "shot") { T.img = { width: 1280, height: 800 }; T.imgId = ID; }
    setStatus(T, "Waiting for you");
    const before = paint(T);
    if (kind !== "other") assert.equal(before.rec.source, "live", `control: ${kind} paints its real screen with Streamer off`);
    setStreaming(true);
    const { g, rec, fake } = paint(T);
    assert.equal(rec.source, "fake", kind);
    assert.equal(rec.light, false);
    assert.deepEqual(fake, [MASK], `${kind}: the fake terminal's title is the mask`);
    assert.deepEqual(leaks(g.texts), [], `${kind} paints no real text`);
    assert.ok(!g.texts.includes("Waiting for you"), `${kind}: the status strip is masked too`);
    assert.equal(g.calls.some((c) => c[0] === "drawImage"), false, `${kind} draws no screenshot`);
    assert.equal(rec.shot, null);
    assert.equal(wantShot(T), null, `${kind} asks for no screenshot`);
    assert.equal(isLive(T), false);
    setStreaming(false);
  }
  // the side screens: the steps list and the files list become the stand-in activity line and claimed rows
  const sc = { ...SCREENS.edit, steps: [{ at: NOW - 5e3, label: "Editing CartSummary.tsx" }], files: [{ name: "useCart.ts", edit: true }] };
  for (const which of ["steps", "files"]) {
    const S = newSide(which); setSide(S, sc);
    const off = ctx(); assert.equal(paintSide(off, S, 384, 240, () => off.fillText("FAKE", 0, 0), NOW).source, "live");
    assert.ok(leaks(off.texts).length > 0, `control: the ${which} screen paints real names with Streamer off`);
    setStreaming(true);
    const g = ctx();
    const rec = paintSide(g, S, 384, 240, () => g.fillText("FAKE", 0, 0), NOW);
    assert.equal(rec.source, "fake");
    assert.deepEqual(g.texts, ["FAKE"]);
    setStreaming(false);
  }
});

test("wantShot names the screenshot's route by its id only while Streamer is off, once, and never a malformed id", () => {
  const T = shown(SCREENS.shot);
  assert.equal(wantShot(T), "/api/screen/" + ID);
  setStreaming(true);
  assert.equal(wantShot(T), null);
  setStreaming(false);
  T.imgId = ID;
  assert.equal(wantShot(T), null, "already loaded");
  for (const bad of ["../../etc/passwd", ID + "?x", ID.toUpperCase(), "abc"]) assert.equal(wantShot(shown({ ...SCREENS.shot, shot: bad })), null, bad);
  assert.equal(wantShot(shown(SCREENS.browser)), null, "no screenshot named");
});

// The page-text parser on a real inline snapshot's lines and a real error's lines, as the server sends them
// (test/screen.test.js "real formats")
test("real formats: a snapshot's lines read as its page, an error's lines as text", () => {
  const snap = pageItems(["- generic [ref=e2]:", '  - button "Text (e3)":', "    - img [ref=e4]", '  - link "Home" [ref=e5] [cursor=pointer]:', "    - /url: /"]);
  assert.deepEqual(snap, [{ role: "button", text: "Text (e3)" }, { role: "link", text: "Home" }]);
  const err = pageItems(["Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/", "Call log:", '  - navigating to "http://localhost:5173/", waiting until "domcontentloaded"']);
  assert.deepEqual(err.map((i) => i.role), ["paragraph", "paragraph", "listitem"]);
  assert.ok(err[0].text.includes("ERR_CONNECTION_REFUSED"));
});

// The screenshot loader, on fake images that record each src set
function images() {
  const made = [];
  const make = () => { const img = { srcs: [], onload: null, onerror: null }; Object.defineProperty(img, "src", { set(v) { img.srcs.push(v); }, get() { return img.srcs[img.srcs.length - 1]; } }); made.push(img); return img; };
  return { made, make };
}
test("a screenshot in flight when Streamer is pressed is dropped: its src is emptied, and a late load shows nothing", () => {
  const T = shown(SCREENS.shot), { made, make } = images(), load = shotLoader(() => T, make);
  load();
  assert.deepEqual(made.map((i) => i.srcs), [["/api/screen/" + ID]], "one request");
  const late = made[0].onload;
  setStreaming(true);
  load(); // the Streamer press repaints every screen, and each paint calls load
  assert.equal(made[0].src, "", "the request in flight is dropped");
  late();
  assert.equal(T.img, null, "a late load shows nothing");
  setStreaming(false);
  load();
  assert.equal(made.length, 2, "with Streamer off again the screenshot is asked for anew");
  made[1].onload();
  assert.equal(T.imgId, ID);
});
test("a newer screenshot drops the older load, and the older's late load starts no second request for the newer", () => {
  const ID2 = "fedcba9876543210fedcba9876543210";
  const T = shown(SCREENS.shot), { made, make } = images(), load = shotLoader(() => T, make);
  load();
  const late = made[0].onload;
  setScreen(T, { ...SCREENS.shot, shot: ID2 });
  load();
  assert.deepEqual([made.length, made[0].src, made[1].src], [2, "", "/api/screen/" + ID2], "the older is dropped, the newer asked for");
  late();
  load();
  assert.equal(made.length, 2, "no duplicate request for the newer id");
  assert.equal(T.imgId, null, "the older shows nothing");
  made[1].onload();
  assert.equal(T.imgId, ID2);
});

test("setStatus sets the one-line strip: squeezed, capped, drawn at the bottom, and says whether it changed", () => {
  const T = shown(SCREENS.shell);
  T.dirty = false;
  assert.equal(setStatus(T, "  Waiting \n for   you "), true);
  assert.equal(T.status, "Waiting for you");
  assert.equal(T.dirty, true);
  T.dirty = false;
  assert.equal(setStatus(T, "Waiting for you"), false, "the same text is no change");
  assert.equal(T.dirty, false);
  const { g } = paint(T);
  assert.ok(g.texts.includes("Waiting for you"));
  assert.equal(setStatus(T, "x".repeat(60)), true);
  assert.equal([...T.status].length, STATUS_MAX);
  assert.ok(T.status.endsWith(String.fromCharCode(0x2026)));
  assert.equal(setStatus(T, null), true);
  assert.equal(T.status, "");
  assert.ok(!paint(T).g.texts.some((t) => t.startsWith("xxx")), "an empty status draws no strip");
  // the strip shows on the stand-in terminal too
  const F = newScreen("Wire the order review"); setStatus(F, "Waiting for you");
  assert.ok(paint(F).g.texts.includes("Waiting for you"));
});

test("setScreen: the same screen is no change; the same step's result landing keeps what was typed; a new step starts over", () => {
  const pend = { ...SCREENS.shell, done: false, lines: [] };
  const T = newScreen("t");
  assert.equal(setScreen(T, pend), true);
  assert.equal(setScreen(T, { ...pend }), false, "an identical poll changes nothing");
  while (revealStep(T));
  const typed = T.reveal.chars;
  assert.equal(typed, pend.head.length, "the command typed in full");
  assert.equal(setScreen(T, SCREENS.shell), true, "its result landed");
  assert.equal(T.reveal.chars, typed, "the command stays typed");
  assert.equal(T.reveal.lines, 0, "the output reveals from its first line");
  assert.equal(setScreen(T, { ...SCREENS.shell, at: NOW }), true, "a new step");
  assert.deepEqual(T.reveal, { chars: 0, lines: 0 });
  T.img = { width: 1, height: 1 }; T.imgId = ID;
  setScreen(T, SCREENS.shot); assert.equal(T.img, null, "a new step drops the loaded picture");
  T.img = { width: 1, height: 1 }; T.imgId = ID;
  setScreen(T, { ...SCREENS.shot, shot: "a".repeat(32) }); assert.equal(T.img, null, "so does a new screenshot");
  setScreen(T, null); assert.equal(T.screen, null); assert.equal(isLive(T), false);
});

test("the reveal types at the existing step timing: a reply 4 characters a step, a command 6, then the lines; everything at once with reduced motion", () => {
  let T = newScreen("t"); setScreen(T, SCREENS.reply);
  assert.equal(revealStep(T), true); assert.equal(T.reveal.chars, 4);
  let n = 1; while (revealStep(T)) n++;
  const total = SCREENS.reply.lines.join("\n").length;
  assert.equal(T.reveal.chars, total); assert.equal(n, Math.ceil(total / 4));
  const part = newScreen("t"); setScreen(part, SCREENS.reply); revealStep(part); revealStep(part);
  const partial = paint(part).g.texts;
  assert.ok(partial.includes("The cart") && !partial.some((t) => t.includes("now")), `two steps show 8 characters (${JSON.stringify(partial)})`);
  T = newScreen("t"); setScreen(T, SCREENS.shell);
  revealStep(T); assert.deepEqual(T.reveal, { chars: 6, lines: 0 });
  while (T.reveal.chars < SCREENS.shell.head.length) revealStep(T);
  revealStep(T); assert.equal(T.reveal.lines, 1, "a terminal's output appears a line a step");
  T = newScreen("t"); setScreen(T, SCREENS.edit); revealStep(T); assert.equal(T.reveal.lines, 1, "an edit types a line a step");
  T = newScreen("t"); setScreen(T, SCREENS.read); revealStep(T); assert.equal(T.reveal.lines, 2, "a result shows 3 lines a step (2 here)");
  assert.equal(revealStep(T), false, "nothing more to show");
  setReduced(true);
  T = newScreen("t"); setScreen(T, SCREENS.reply);
  assert.equal(T.reveal.chars, total, "reduced motion: shown at once");
  assert.equal(revealStep(T), false);
});

test("a step whose result has not landed shows its input with a blinking cursor", () => {
  for (const sc of [{ ...SCREENS.shell, done: false, lines: [] }, { ...SCREENS.browser, done: false, lines: [] }, { ...SCREENS.read, done: false, lines: [] }, { ...SCREENS.search, done: false, lines: [] }]) {
    const T = shown(sc);
    assert.equal(pending(T), true, sc.kind);
    T.blink = true;
    const on = paint(T);
    assert.ok(on.g.texts.some((t) => t.includes(sc.head)), `${sc.kind} shows its input`);
    assert.equal(on.rec.cursor, true, `${sc.kind}: the cursor shows`);
    T.blink = false;
    assert.equal(paint(T).rec.cursor, false, `${sc.kind}: and blinks`);
  }
  assert.equal(pending(shown(SCREENS.shell)), false, "a landed result is not pending");
  setReduced(true);
  const R = shown({ ...SCREENS.shell, done: false, lines: [] }); R.blink = false;
  assert.equal(paint(R).rec.cursor, true, "reduced motion: a steady cursor");
});

test("the left screen lists the newest steps with their time ago, the right the files touched; each says what it would paint", () => {
  const sc = { ...SCREENS.edit, steps: [{ at: NOW - 5e3, label: "Editing CartSummary.tsx" }, { at: NOW - 125e3, label: "Running the cart tests" }, { at: NOW - 3 * 3600e3, label: "Reading pricing.ts" }],
    files: [{ name: "CartSummary.tsx", edit: true }, { name: "pricing.ts", edit: false }] };
  const L = newSide("steps"), R = newSide("files");
  assert.equal(setSide(L, sc), true); assert.equal(setSide(L, { ...sc }), false, "an identical poll changes nothing");
  setSide(R, sc);
  const g = ctx();
  const rec = paintSide(g, L, 384, 240, () => assert.fail("not fake"), NOW);
  assert.equal(rec.source, "live");
  for (const s of ["Editing CartSummary.tsx", "Running the cart tests", "Reading pricing.ts", "now", "2m", "3h"]) assert.ok(g.texts.includes(s), `steps draw "${s}" (${JSON.stringify(g.texts)})`);
  const h = ctx();
  paintSide(h, R, 384, 240, () => assert.fail("not fake"), NOW);
  for (const s of ["CartSummary.tsx", "pricing.ts"]) assert.ok(h.texts.includes(s), `files draw "${s}"`);
  // a minute on, the time ago changes and so does what it would paint; a few seconds on, it does not
  assert.equal(sideSig(L, NOW + 3e3), sideSig(L, NOW));
  assert.notEqual(sideSig(L, NOW + 60e3), sideSig(L, NOW));
  assert.equal(sideSig(R, NOW + 3600e3), sideSig(R, NOW), "the files list has no clock");
  // no screen: the stand-in content
  const E = newSide("steps"); let faked = 0;
  assert.equal(paintSide(ctx(), E, 384, 240, () => faked++, NOW).source, "fake"); assert.equal(faked, 1);
  assert.deepEqual([ago(0), ago(59e3), ago(60e3), ago(3599e3), ago(3600e3), ago(864e5 * 2)], ["now", "now", "1m", "59m", "1h", "2d"]);
});

// A secret line comes from the server as a bar (its indent in spaces, a NUL, its length), never as text.
// Each painter draws a dim bar that long where the text would be; an edit's row keeps its red or green under it; a
// hidden command shows its prompt, then the bar; the page text, a tab and an address bar show bars too.
const NUL = String.fromCharCode(0);
const B = (len, indent = 0) => " ".repeat(indent) + NUL + len;
// a context that keeps each fillRect with the fill style it was drawn in
function styled() {
  const o = { texts: [], rects: [], fillStyle: "" };
  return new Proxy(o, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "measureText") return (s) => ({ width: String(s).length * 7 });
      if (k === "fillText" || k === "strokeText") return (s) => { t.texts.push(String(s)); };
      if (k === "fillRect") return (x, y, w, h) => { t.rects.push({ style: t.fillStyle, x, y, w, h }); };
      if (k === "createLinearGradient") return () => ({ addColorStop() {} });
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
const HIDDEN_SCREENS = {
  edit: step("edit", { tool: "Edit", head: "config.yml", lines: [" user: a", "-" + B(12), "+" + B(14, 2), "+ok: 1"] }),
  shell: step("shell", { tool: "Bash", head: B(30), lines: ["ok", B(20)] }),
  read: step("read", { tool: "Read", head: "a.yml", lines: ["     1  user: a", B(18)] }),
  search: step("search", { tool: "Grep", head: B(8), title: "Grep", lines: [B(40), "src/a.ts:2:ok"] }),
  browser: step("browser", { tool: "WebFetch", head: B(30), title: B(12), lines: ["# Guide", B(25), "Install it."] }),
  web: step("web", { tool: "WebSearch", head: B(10), lines: [B(30), "Fake timers"] }),
  reply: step("reply", { lines: ["Done.", B(40), "Next."] }),
};
test("a hidden line is a bar its length in every painter, and no marker is ever drawn as text", () => {
  assert.equal(typeof SCR.barOf, "function", "the painters read a bar");
  assert.deepEqual(SCR.barOf(B(12, 4)), { indent: 4, len: 12 });
  for (const s of ["", "12", NUL, NUL + "x", "a" + NUL + "1", NUL + "1234"]) assert.equal(SCR.barOf(s), null, JSON.stringify(s));
  for (const [k, sc] of Object.entries(HIDDEN_SCREENS)) {
    const g = styled(), rec = paintCenter(g, shown(sc), 640, 400, () => assert.fail("not fake"));
    assert.ok(rec.bars > 0, k + ": bars drawn, " + rec.bars);
    assert.ok(!g.texts.some((t) => t.includes(NUL)), k + ": no marker drawn as text " + JSON.stringify(g.texts));
    assert.ok(!rec.text.some((t) => t.includes(NUL)), k);
  }
});
test("an edit's hidden line keeps its red or green row under its bar; a hidden command is its prompt, then the bar", () => {
  const g = styled(), rec = paintCenter(g, shown(HIDDEN_SCREENS.edit), 640, 400, () => {});
  const row = (y) => g.rects.filter((r) => r.y >= y && r.y < y + 17);
  const red = row(61), green = row(78);
  assert.ok(red.some((r) => r.style === "rgba(244,71,71,.16)" && r.w === 640), "the removed row stays red: " + JSON.stringify(red));
  assert.ok(green.some((r) => r.style === "rgba(80,200,120,.14)" && r.w === 640), "the added row stays green: " + JSON.stringify(green));
  assert.equal(rec.bars, 2);
  assert.ok(g.texts.includes("-") && g.texts.includes("+") && g.texts.includes("user: a") && g.texts.includes("ok: 1"), JSON.stringify(g.texts));
  const bar = g.rects.filter((r) => r.y >= 78 && r.y < 95 && r.style !== "rgba(80,200,120,.14)");
  assert.ok(bar.some((r) => r.x === 48 + 2 * 7 && r.w === 14 * 7), "the bar starts at the indent and runs the length: " + JSON.stringify(bar));
  const s = styled(), r2 = paintCenter(s, shown(HIDDEN_SCREENS.shell), 640, 400, () => {});
  assert.ok(s.texts.includes("$ ") && !s.texts.some((t) => t.includes(NUL)), JSON.stringify(s.texts));
  assert.ok(s.rects.some((r) => r.x === 14 + 2 * 7 && r.w === 30 * 7), "the bar follows the prompt: " + JSON.stringify(s.rects.slice(-4)));
  assert.equal(r2.bars, 2);
});
test("page text, a tab and an address bar show bars; a bar line is its own item", () => {
  assert.deepEqual(pageItems([B(12), '- link "Home" [ref=e5]', B(7, 2)]), [{ role: "hidden", len: 12 }, { role: "link", text: "Home" }, { role: "hidden", len: 7 }]);
  assert.deepEqual(pageItems(["# Guide", B(9)]), [{ role: "heading", level: 1, text: "Guide" }, { role: "hidden", len: 9 }]);
  const g = styled(), rec = paintCenter(g, shown(HIDDEN_SCREENS.browser), 640, 400, () => {});
  assert.equal(rec.bars, 3, "the tab, the address bar and the page's line");
  assert.ok(g.texts.includes("Guide") && g.texts.includes("Install it."), JSON.stringify(g.texts));
});
test("Streamer still paints the stand-in content over hidden lines", () => {
  setStreaming(true);
  for (const [k, sc] of Object.entries(HIDDEN_SCREENS)) {
    const g = styled(), rec = paintCenter(g, shown(sc), 640, 400, (t) => g.fillText(t, 0, 0));
    assert.equal(rec.source, "fake", k);
    assert.ok(!rec.bars, k);
  }
});
