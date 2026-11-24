import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROOM, DESK, LOUNGE, DAIS, GRID, SPOTS, liveRows, liveSlots, sections, deskBlocks, standOf, floorMap } from "../public/floor/plan.js";

// Where everything stands on the Office floor as public/floor/plan.js lays it out.
// Floor coordinates: the boss's table at the origin, the owner faces +z; from the Boss camera +x is the left side, -x
// the right.
const cfg = JSON.parse(readFileSync(new URL("../hq.config.example.json", import.meta.url)));
const live = liveSlots();
const lrows = liveRows();
const secs = sections(cfg.departments, cfg.agents);
const agentSlots = secs.flatMap((s) => s.slots);
// the fullest room config.js allows: 6 departments of 5
const maxDeps = Array.from({ length: 6 }, (_, d) => ({ name: "D" + d, color: "#fff" }));
const maxSecs = sections(maxDeps, maxDeps.flatMap((d) => Array.from({ length: 5 }, (_, i) => ({ id: d.name + i, dept: d.name }))));
const layouts = [secs, maxSecs].map((ss) => [ss, [...live, ...ss.flatMap((x) => x.slots)], [...lrows, ...ss]]);
const width = (s) => (s.narrow ? DESK.narrow : DESK.full);
// a slot's desk and chair as one rectangle in floor coordinates: across the desk, from its back edge to its chair's back
const corners = (s) => {
  const u = [Math.sin(s.yaw), Math.cos(s.yaw)], v = [Math.cos(s.yaw), -Math.sin(s.yaw)], hw = width(s) / 2;
  return [[-hw, -0.4], [hw, -0.4], [hw, 0.95], [-hw, 0.95]].map(([a, b]) => [s.x + v[0] * a + u[0] * b, s.z + v[1] * a + u[1] * b]);
};
const apart = (A, B) => { // separating axis test of two convex polygons
  for (const P of [A, B]) for (let i = 0; i < P.length; i++) {
    const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % P.length], ax = [z1 - z0, x0 - x1];
    const pa = A.map(([x, z]) => x * ax[0] + z * ax[1]), pb = B.map(([x, z]) => x * ax[0] + z * ax[1]);
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return true;
  }
  return false;
};
const box = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

test("the room is sized to what it holds: no wider than 27 m, no deeper than 30.5 m, its area capped", () => {
  assert.ok(ROOM.x * 2 <= 27, `width ${ROOM.x * 2}`);
  assert.ok(ROOM.zMax - ROOM.zMin <= 30.5, `depth ${ROOM.zMax - ROOM.zMin}`);
  assert.ok(ROOM.x * 2 * (ROOM.zMax - ROOM.zMin) < 36 * 28.8 * 0.8);
});

test("12 session seats on the right (-x): 3 straight rows of 4, screens toward the boss", () => {
  assert.equal(live.length, 12);
  assert.equal(lrows.length, 3);
  for (const r of lrows) assert.equal(r.slots.length, 4);
  for (const s of live) {
    assert.ok(s.x < 0, `seat at ${s.x.toFixed(2)} is on the right`);
    assert.equal(s.yaw, Math.PI, "its chair on the boss's side, its screens facing the owner");
  }
  assert.deepEqual(live.map((s) => s.id), live.map((_, i) => "live:" + i), "seats in order: the row nearest the boss first, each from the aisle out");
  for (let i = 1; i < live.length; i++) {
    const a = live[i - 1], b = live[i];
    assert.ok(b.z > a.z || (b.z === a.z && Math.abs(b.x) > Math.abs(a.x)), `live:${i} comes after live:${i - 1}`);
  }
});

test("every roster agent has one desk in its own department's row, on the left (+x), screens toward the boss", () => {
  assert.equal(secs.length, cfg.departments.length);
  for (const a of cfg.agents) {
    const mine = secs.filter((s) => s.slots.some((x) => x.id === a.id));
    assert.equal(mine.length, 1, `${a.id} has one desk`);
    assert.equal(mine[0].name, a.dept, `${a.id} sits in ${a.dept}`);
  }
  for (const s of agentSlots) {
    assert.ok(s.x > 0, `${s.id} at ${s.x.toFixed(2)} is on the left`);
    assert.equal(s.yaw, Math.PI, `${s.id}'s screens face the boss`);
  }
  secs.forEach((sec, k) => { for (const s of sec.slots) assert.equal(s.z, sec.z, `${s.id} sits on its row's line`); if (k) assert.ok(sec.z > secs[k - 1].z, `${sec.name} is behind ${secs[k - 1].name}`); });
});

test("every row lines up: the same lines front to back on both sides, every one from the aisle to the same outer edge", () => {
  for (const [ss, , rows] of layouts) {
    const zs = [...new Set(rows.map((r) => r.z))].sort((a, b) => a - b);
    zs.forEach((z, k) => assert.ok(Math.abs(z - (GRID.z0 + k * GRID.row)) < 1e-9, `row line ${k} at ${z}`));
    for (const r of rows) for (const s of r.slots) assert.ok(Math.abs(s.x) - width(s) / 2 >= GRID.aisle - 1e-9 && Math.abs(s.x) + width(s) / 2 <= GRID.out + 1e-9, `${s.id} inside its row`);
    assert.ok(ss.every((sec) => sec.side === 1) && lrows.every((r) => r.side === -1));
  }
});

test("the desks fill each row from the aisle, so a short row starts where a full one does", () => {
  for (const [ss] of layouts) for (const sec of ss) {
    const xs = sec.slots.map((s) => s.x);
    assert.ok(Math.abs(xs[0] - (GRID.aisle + DESK.narrow / 2)) < 0.5, `${sec.name}'s first desk at the aisle`);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], `${sec.name} runs outward`);
  }
});

test("no two desks (with their chairs) touch, and none meets the dais, the lounge or the boss's inlay", () => {
  const fixed = [["the dais", box(-DAIS.w / 2, DAIS.z0, DAIS.w / 2, DAIS.z1)],
    ...Object.entries(LOUNGE).map(([k, L]) => [k, box(L.x - L.w / 2, L.z - L.d / 2, L.x + L.w / 2, L.z + L.d / 2)])];
  for (const [, all] of layouts) {
    for (let i = 0; i < all.length; i++) {
      const A = corners(all[i]), s = all[i], chair = [s.x + Math.sin(s.yaw) * 0.61, s.z + Math.cos(s.yaw) * 0.61];
      for (let j = i + 1; j < all.length; j++) assert.ok(apart(A, corners(all[j])), `${all[i].id} and ${all[j].id} touch`);
      for (const [name, B] of fixed) assert.ok(apart(A, B), `${all[i].id} meets ${name}`);
      assert.ok(Math.hypot(...chair) > 5.2, `${s.id}'s chair sits on the boss's inlay`);
    }
  }
});

test("every desk and lounge piece stays inside the room, clear of the glass", () => {
  const inside = ([x, z], m) => Math.abs(x) <= ROOM.x - m && z >= ROOM.zMin + m && z <= ROOM.zMax - m;
  for (const [, all] of layouts) for (const s of all) for (const p of corners(s)) assert.ok(inside(p, 0.5), `${s.id} reaches ${p.map((v) => v.toFixed(2))}`);
  for (const [k, L] of Object.entries(LOUNGE)) for (const p of box(L.x - L.w / 2, L.z - L.d / 2, L.x + L.w / 2, L.z + L.d / 2)) assert.ok(inside(p, -1e-9), `${k} reaches ${p}`); // the coffee station and the bar stand against the back wall
});

test("every desk's stand point is clear of every desk, so a figure can walk up to it", () => {
  for (const [, all] of layouts) for (const s of all) {
    const [x, z] = standOf(s);
    for (const o of all) assert.ok(!deskBlocks(o, x, z, 0.2), `${s.id}'s stand point is inside ${o.id}`);
  }
});

test("deskBlocks covers the desk and the chair, and leaves the stand point free", () => {
  const s = live[0], u = [Math.sin(s.yaw), Math.cos(s.yaw)], at = (k) => [s.x + u[0] * k, s.z + u[1] * k];
  assert.ok(deskBlocks(s, s.x, s.z, 0), "its center");
  assert.ok(deskBlocks(s, ...at(0.61), 0), "its chair");
  assert.ok(!deskBlocks(s, ...standOf(s), 0.26), "its stand point, with a body's margin");
  assert.ok(!deskBlocks(s, ...at(-1.2), 0.26), "behind it");
});

test("a department of any size from 1 to 5 (config.js's most) fits its row", () => {
  for (let n = 1; n <= 5; n++) {
    const agents = Array.from({ length: n }, (_, i) => ({ id: "a" + i, dept: "Solo" }));
    const [sec] = sections([{ name: "Solo", color: "#fff" }], agents);
    assert.equal(sec.slots.length, n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert.ok(apart(corners(sec.slots[i]), corners(sec.slots[j])), `n=${n}: ${i} and ${j} touch`);
  }
});

test("nothing stands between the rows: behind each row's desks, across the whole row, is open floor", () => {
  for (const [, all, rows] of layouts) {
    const F = floorMap(all, rows); // passing the rows puts up no walls
    // .85 m behind the desks' line: past a desk's back edge and its body margin (.66), short of the next row's chairs
    for (const r of rows) for (let x = GRID.aisle + 0.5; x <= GRID.out - 0.5; x += 0.5) assert.ok(!F.blocked(r.side * x, r.z + 0.85), `the floor behind the row at z ${r.z} is walled at x ${r.side * x}`);
  }
});

// the walking floor: a regular walks from any lounge spot to its desk and back, every leg in sight
const walkable = (ss) => {
  const F = floorMap([...live, ...ss.flatMap((s) => s.slots)]), entry = (S) => (S.via ? S.via[0] : S.stand || S.pos);
  for (const [k, S] of Object.entries(SPOTS)) assert.ok(!F.blocked(...entry(S)), `${k} is on open floor`);
  for (const s of [...live, ...ss.flatMap((x) => x.slots)]) for (const [k, S] of Object.entries(SPOTS)) {
    for (const [a, b, label] of [[entry(S), standOf(s), `${k} to ${s.id}`], [standOf(s), entry(S), `${s.id} to ${k}`]]) {
      const r = F.route(a, b);
      assert.ok(r, `a route from ${label}`);
      let at = a; for (const p of r) { assert.ok(F.los(at, p), `${label}: a leg out of sight`); at = p; }
      assert.deepEqual(r[r.length - 1], b, `${label} ends at its stand point`);
    }
  }
};
test("a regular can walk from every lounge spot to every desk and back", () => walkable(secs));
test("and so can one in the fullest room the config allows (6 departments of 5)", () => walkable(maxSecs));
