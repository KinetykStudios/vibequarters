import test from "node:test";
import assert from "node:assert/strict";
import { monitorLayout, axes, EYE, DESKTOP_Y, DESK_DEPTH, SHELL, HOUSING, INSET } from "../public/floor/monitors.js";

// The desk monitors as boxes in desk coordinates (x across, y up, z toward the chair): each monitor's black front shell
// and its back housing, from public/floor/monitors.js, the numbers furniture.js builds from.
const DESKS = [["full", false, 1.6], ["narrow", true, 1.25]];
const plus = (a, b, k = 1) => a.map((v, i) => v + k * b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => a.map((v) => v / Math.hypot(...a));
function bodies(L) {
  const [W, H] = L.face;
  return L.monitors.map((m) => {
    const A = axes(m.yaw, m.tilt), boxes = [{ c: plus(m.pos, A.Z, -SHELL / 2), h: [W / 2, H / 2, SHELL / 2], A }];
    if (HOUSING > 0) boxes.push({ c: plus(m.pos, A.Z, -SHELL - HOUSING / 2), h: [W / 2 - INSET, H / 2 - INSET, HOUSING / 2], A });
    return boxes;
  });
}
const corners = (b) => [-1, 1].flatMap((i) => [-1, 1].flatMap((j) => [-1, 1].map((k) => plus(plus(plus(b.c, b.A.X, i * b.h[0]), b.A.Y, j * b.h[1]), b.A.Z, k * b.h[2]))));
// separating axis test for two boxes: their 3 + 3 face axes and the 9 edge cross products
function intersect(a, b) {
  const ax = [a.A.X, a.A.Y, a.A.Z], bx = [b.A.X, b.A.Y, b.A.Z];
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const tests = [...ax, ...bx, ...ax.flatMap((u) => bx.map((v) => cross(u, v)))].filter((n) => Math.hypot(...n) > 1e-9);
  const d = plus(b.c, a.c, -1);
  return tests.every((n) => {
    const ra = ax.reduce((s, u, i) => s + a.h[i] * Math.abs(dot(u, n)), 0), rb = bx.reduce((s, u, i) => s + b.h[i] * Math.abs(dot(u, n)), 0);
    return Math.abs(dot(d, n)) <= ra + rb;
  });
}
// distance from a point to a box (0 inside)
function distance(p, b) {
  const r = plus(p, b.c, -1), q = [b.A.X, b.A.Y, b.A.Z].map((u, i) => Math.max(Math.abs(dot(r, u)) - b.h[i], 0));
  return Math.hypot(...q);
}

for (const [name, narrow, w] of DESKS) {
  const L = monitorLayout(narrow), B = bodies(L), [W, H] = L.face, [sw, sh] = L.screen;

  test(`${name} desk: no two monitors intersect`, () => {
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) for (const a of B[i]) for (const b of B[j]) assert.equal(intersect(a, b), false, `monitors ${i} and ${j}`);
  });

  test(`${name} desk: every monitor stays over the desktop with 3 cm to spare at each edge`, () => {
    const pts = B.flat().flatMap(corners);
    const reach = Math.max(...pts.map((p) => Math.abs(p[0]))), back = Math.min(...pts.map((p) => p[2])), front = Math.max(...pts.map((p) => p[2]));
    assert.ok(reach <= w / 2 - 0.03, `outer edge at ${reach.toFixed(3)} m, the desk's half width is ${w / 2}`);
    assert.ok(back >= -DESK_DEPTH / 2 + 0.03 && front <= DESK_DEPTH / 2 - 0.03, `from z ${back.toFixed(3)} to ${front.toFixed(3)}`);
    assert.ok(Math.min(...pts.map((p) => p[1])) > DESKTOP_Y, "above the desktop");
  });

  test(`${name} desk: each screen faces the seated eye (its normal's dot with the way to the eye over .98)`, () => {
    L.monitors.forEach((m, i) => {
      const Z = axes(m.yaw, m.tilt).Z, f = dot(Z, unit(plus(EYE, m.pos, -1)));
      assert.ok(f > 0.98, `monitor ${i}: ${f.toFixed(4)} (${(Math.acos(f) * 180 / Math.PI).toFixed(1)} degrees off)`);
    });
  });

  test(`${name} desk: a real monitor (thin bezel, 3 cm body, screens 10 to 15 cm up and level, seams 0.5 to 1.5 cm)`, () => {
    assert.ok(Math.max(W - sw, H - sh) / 2 <= 0.012, `bezel ${(Math.max(W - sw, H - sh) / 2 * 100).toFixed(1)} cm`);
    assert.ok((sw * sh) / (W * H) >= 0.92, `the screen fills ${((100 * sw * sh) / (W * H)).toFixed(1)} percent of the face`);
    assert.ok(SHELL + HOUSING <= 0.03, `the body is ${((SHELL + HOUSING) * 100).toFixed(1)} cm deep`);
    for (const m of L.monitors) {
      const A = axes(m.yaw, m.tilt), low = plus(m.pos, A.Y, -sh / 2)[1] - DESKTOP_Y;
      assert.ok(low >= 0.1 && low <= 0.15, `screen bottom ${(low * 100).toFixed(1)} cm over the desktop`);
      assert.ok(Math.abs(m.pos[1] - L.monitors[1].pos[1]) < 1e-9, "the centers are level");
    }
    for (const side of [0, 2]) { // the side's inner front corners, top and bottom, from the center's shell
      const m = L.monitors[side], A = axes(m.yaw, m.tilt), inner = plus(m.pos, A.X, side ? -W / 2 : W / 2);
      for (const k of [1, -1]) {
        const g = distance(plus(inner, A.Y, k * H / 2), B[1][0]);
        assert.ok(g >= 0.005 && g <= 0.015, `monitor ${side} seam ${(g * 100).toFixed(2)} cm at the ${k > 0 ? "top" : "bottom"}`);
      }
    }
  });
}
