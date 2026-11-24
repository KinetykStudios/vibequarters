// The three monitors on a desk, as numbers: furniture.js builds them and test/monitors.test.mjs checks them. Desk
// coordinates: x across the desk, y up from the floor, z toward the chair; the desktop is at y .77 and .8 deep.
export const DESKTOP_Y = .77, DESK_DEPTH = .8;
// the seated figure's eyes, at its desk while it types (in the room): every screen aims here
export const EYE = [0, 1.254, .483];
// one design on every desk: a 6 mm bezel on a 1.2 cm black front shell, a matte back housing 1.6 cm deep set in 2.5 cm
// from the edges (2.8 cm in all), 1 cm seams at mid height, and the screens' bottoms 14.8 cm over the desktop
export const BEZEL = .006, SHELL = .012, HOUSING = .016, INSET = .025, GAP = .01, LIFT = .148;
// the arm: all three hang on one bar 3.5 cm behind their housings, on a pole clamped at the desk's back edge
export const ARM = { behind: .035, pole: .015, mount: .05 };
// per desk: the face (bezel included; the screen inside is 16:10 like the screen textures), where the center screen
// stands, and the tilt back that keeps the seams within 0.5 to 1.5 cm while each screen faces the eye within about 11
// degrees
const SIZES = {
  full: { face: [.572, .362], z: -.30, tilt: -2 },
  narrow: { face: [.412, .262], z: -.32, tilt: -4 },
};
const rad = (d) => d * Math.PI / 180;
// a monitor's axes for rotation order YXZ (tilt about its own x, then the turn about the vertical): across, up, out
export function axes(yaw, tilt) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
  return { X: [cy, 0, -sy], Y: [sy * st, ct, cy * st], Z: [sy * ct, -st, cy * ct] };
}
const plus = (a, b, k = 1) => a.map((v, i) => v + k * b[i]);
// left, center, right: each { pos (the middle of its front face), yaw, tilt }. A side monitor sits GAP past the center's
// edge at mid height and turns until its face points at the eye in plan.
export function monitorLayout(narrow = false) {
  const S = narrow ? SIZES.narrow : SIZES.full, [W, H] = S.face, tilt = rad(S.tilt);
  const C = { pos: [0, DESKTOP_Y + LIFT + (H - 2 * BEZEL) / 2, S.z], yaw: 0, tilt }, cX = axes(0, tilt).X;
  const place = (yaw) => { const A = axes(yaw, tilt), u = plus(cX, A.X), n = Math.hypot(...u); return plus(plus(plus(C.pos, cX, W / 2), u, GAP / n), A.X, W / 2); };
  let lo = -1.2, hi = 0;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2, p = place(m), Z = axes(m, tilt).Z;
    if (Z[0] * (EYE[2] - p[2]) - Z[2] * (EYE[0] - p[0]) > 0) hi = m; else lo = m;
  }
  const yaw = (lo + hi) / 2, R = place(yaw);
  return {
    face: [W, H], screen: [W - 2 * BEZEL, H - 2 * BEZEL],
    monitors: [{ pos: [-R[0], R[1], R[2]], yaw: -yaw, tilt }, C, { pos: R, yaw, tilt }],
  };
}
