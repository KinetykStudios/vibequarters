import test from "node:test";
import assert from "node:assert/strict";
import { deskKit, fixedBoxes, KINDS, SLOTS, MOUSE_REACH } from "../public/floor/desk-kit.js";

// What is on a desk, as public/floor/desk-kit.js lays it out: boxes in desk coordinates (x across, z toward
// the chair; the desktop is .8 deep), the footprints each kind declares. The smoke checks the built meshes in the room.
const WIDTH = { full: 1.6, narrow: 1.25 };
const keys = Array.from({ length: 600 }, (_, i) => `desk:agent-${i}`);
const overlap = (a, b) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2;
const onDesk = (b, size) => Math.abs(b.x) + b.w / 2 <= WIDTH[size] / 2 && Math.abs(b.z) + b.d / 2 <= 0.4;

test("a kit of at least 8 kinds, each in several colors", () => {
  assert.ok(Object.keys(KINDS).length >= 8);
  for (const [k, K] of Object.entries(KINDS)) assert.ok(K.colors.length >= 3, k);
});

test("the same key gives the same desk twice", () => {
  for (const key of keys.slice(0, 100)) for (const narrow of [false, true]) for (const side of [1, -1]) assert.deepEqual(deskKit(key, narrow, side), deskKit(key, narrow, side));
});

test("2 to 4 things of different kinds, each inside its free place", () => {
  for (const key of keys) for (const narrow of [false, true]) {
    const kit = deskKit(key, narrow, 1), size = narrow ? "narrow" : "full";
    assert.ok(kit.items.length >= 2 && kit.items.length <= 4, `${key}: ${kit.items.length} things`);
    assert.equal(new Set(kit.items.map((it) => it.kind)).size, kit.items.length);
    for (const it of kit.items) {
      const s = SLOTS[size][it.slot], K = KINDS[it.kind];
      assert.ok(K.w <= s.w && K.d <= s.d && K.h <= s.h, `${it.kind} fits slot ${it.slot}`);
      assert.ok(K.colors.includes(it.color));
    }
  }
});

test("every free place is on the desktop, clear of the fixed things, of each other and of the typing forearms", () => {
  for (const narrow of [false, true]) for (const mouse of [1, -1]) for (const plateSide of [1, -1]) for (const papers of ["stack", "tray"]) {
    const size = narrow ? "narrow" : "full", kit = { narrow, mouse, plateSide, papers };
    const slots = SLOTS[size].map((s) => ({ ...s, x: plateSide * s.x })), fixed = fixedBoxes(kit);
    for (const b of [...slots, ...fixed]) assert.ok(onDesk(b, size), `${size}: ${b.name || "slot"} on the desktop`);
    slots.forEach((s, i) => {
      for (const f of fixed) assert.ok(!overlap(s, f), `${size} mouse ${mouse} plate ${plateSide} ${papers}: slot ${i} clear of the ${f.name}`);
      slots.forEach((t, j) => j > i && assert.ok(!overlap(s, t), `${size}: slots ${i} and ${j} apart`));
      // the forearms cross the front edge within .36 of the center line
      if (s.z + s.d / 2 > 0.17) assert.ok(Math.abs(s.x) - s.w / 2 >= 0.36, `${size}: slot ${i} clear of the forearms`);
    });
    fixed.forEach((f, i) => fixed.forEach((g, j) => j > i && assert.ok(!overlap(f, g), `${size} mouse ${mouse} plate ${plateSide}: the ${f.name} and the ${g.name} apart`)));
  }
});

test("the name plate and the free places stay past a mousing forearm's reach over the front of the desk", () => {
  // the mousing forearm (the hand on the mouse, the elbow out) reaches .41 to .47 out from the center line from z .2 to
  // the front edge
  for (const narrow of [false, true]) for (const mouse of [1, -1]) for (const plateSide of [1, -1]) {
    const size = narrow ? "narrow" : "full", kit = { narrow, mouse, plateSide, papers: "stack" };
    const plate = fixedBoxes(kit).find((f) => f.name === "plate");
    assert.ok(Math.abs(plate.x) - plate.w / 2 >= MOUSE_REACH, `${size} plate ${plateSide}: the plate starts ${(Math.abs(plate.x) - plate.w / 2).toFixed(3)} out`);
    SLOTS[size].forEach((s, i) => { if (s.z + s.d / 2 > 0.2) assert.ok(Math.abs(s.x) - s.w / 2 >= MOUSE_REACH, `${size}: slot ${i} past the mousing forearm`); });
  }
});

test("the mouse goes on the left for about 1 desk in 6", () => {
  const left = keys.filter((k) => deskKit(k, false).mouse === -1).length / keys.length;
  assert.ok(left > 0.1 && left < 0.23, `${(left * 100).toFixed(1)}% on the left`);
});

test("a set a neighbor already has is drawn again until it differs, and the mouse stays where it was", () => {
  for (const key of keys.slice(0, 100)) {
    const a = deskKit(key, true, 1), b = deskKit(key, true, 1, [a.set]);
    assert.notEqual(b.set, a.set);
    assert.equal(b.mouse, a.mouse);
    assert.deepEqual(deskKit(key, true, 1, [a.set]), b);
  }
});
