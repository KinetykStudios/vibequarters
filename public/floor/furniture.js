// Furniture: the chair, desks and their screens, then the boss's table, the dais, the jet desk and the throne.
import * as THREE from 'three';
import {
  clamp, rand, scene, ANISO, canvasTex, leather, BRASS, CHROME, BLACK, glow, woodTex, marbleTex, rod, slab,
  poly, sideExtrude, add, V3, REDUCED, now
} from './core.js';
import {
  newScreen, setScreen as screenTo, setStatus as statusTo, revealStep, isLive, pending, shotLoader, paintCenter, newSide, setSide, sideSig, paintSide, setReduced
} from './screens.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { monitorLayout, axes, DESKTOP_Y, DESK_DEPTH, SHELL, HOUSING, INSET, ARM } from './monitors.js';
import { KEYBOARD, PAD, MOUSE, PHONE, PAPERS, PLATE, plateAt, KINDS, hash32, deskKit } from './desk-kit.js';
import { shown, streaming, onStreaming } from '../streamer.js';

// ============================================================================
// FURNITURE
// ============================================================================
export const walnut = new THREE.MeshStandardMaterial({ map: woodTex('#4b2d19', [1, 1], true), roughness: .55 });
export const walnutDark = new THREE.MeshStandardMaterial({ color: '#140c08', roughness: .5 });
export const shadowAll = g => { g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); return g; };
// a prototype's parts as one mesh per material, so a chair and a desk's frame draw in fewer calls: one of each stands in
// the room for every seat
const fuse = g => {
  const by = new Map();
  for (const o of [...g.children]) { o.updateMatrix(); if (!by.has(o.material)) by.set(o.material, []); by.get(o.material).push((o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrix)); g.remove(o); }
  for (const [mat, geos] of by) g.add(new THREE.Mesh(mergeGeometries(geos), mat));
  return g;
};
export function protoChair() {
  const g = new THREE.Group(), lea = leather('#0d0d10');
  const seat = new THREE.Mesh(slab(.5, .5, .08, .08, .02), lea); seat.rotation.x = -Math.PI / 2; seat.position.y = .36; g.add(seat);
  const back = new THREE.Mesh(slab(.46, .62, .07, .1, .02), lea); back.position.set(0, .78, -.26); back.rotation.x = -.1; g.add(back);
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(.022, .026, .26, 12), CHROME).translateY(.19));
  for (let i = 0; i < 5; i++) { const a = new THREE.Mesh(new THREE.BoxGeometry(.03, .03, .3), CHROME); a.rotation.y = i * Math.PI * 2 / 5; a.position.set(Math.sin(a.rotation.y) * .15, .05, Math.cos(a.rotation.y) * .15); g.add(a); }
  return shadowAll(fuse(g));
}
export const CHAIR = protoChair();
export const SCREEN_OFF = canvasTex(384, 240, (g, w, h) => { g.fillStyle = '#050607'; g.fillRect(0, 0, w, h); g.fillStyle = '#34373e'; g.font = '600 20px ui-monospace,Consolas,monospace'; g.fillText('OPEN SEAT', 20, 40); });
export const LOCKED = canvasTex(384, 240, (g, w, h) => { g.fillStyle = '#040506'; g.fillRect(0, 0, w, h); g.fillStyle = '#1a1c21'; g.fillRect(20, h - 30, w - 40, 2); });
export const screenMat = tex => new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.4, 1.4, 1.4) });
export const OFF_MAT = new THREE.MeshBasicMaterial({ map: SCREEN_OFF, color: new THREE.Color(.9, .9, .9) });
export const LOCK_MAT = new THREE.MeshBasicMaterial({ map: LOCKED });
// a chart's line and a list's row widths are drawn from rand() once, so a side screen (below) can paint them again
const chartLine = () => { const ys = []; let y = 170; for (let x = 18; x < 384 - 14; x += 8) ys.push(y = clamp(y + (rand() - .48) * 22, 80, 225)); return ys; };
const rowWidths = () => Array.from({ length: 6 }, () => [50 + rand() * 140, 30 + rand() * 90]);
function drawChart(g, title, accent, ys) {
  const w = 384, h = 240;
  g.fillStyle = '#020605'; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,.06)'; for (let y = 70; y < h; y += 34) { g.beginPath(); g.moveTo(16, y); g.lineTo(w - 16, y); g.stroke(); }
  g.fillStyle = accent; g.font = '700 20px ui-monospace,SFMono-Regular,Consolas,monospace'; g.fillText(title.toUpperCase(), 18, 34);
  g.strokeStyle = accent; g.lineWidth = 3; g.beginPath(); ys.forEach((y, i) => (i ? g.lineTo(18 + i * 8, y) : g.moveTo(18, y))); g.stroke();
}
function drawRows(g, title, accent, ws) {
  g.fillStyle = '#020605'; g.fillRect(0, 0, 384, 240);
  g.fillStyle = accent; g.font = '700 20px ui-monospace,SFMono-Regular,Consolas,monospace'; g.fillText(title.toUpperCase(), 18, 34);
  ws.forEach(([a, b], r) => { const y = 62 + r * 28; g.globalAlpha = .55; g.fillRect(18, y, a, 12); g.globalAlpha = .25; g.fillRect(230, y, b, 12); });
  g.globalAlpha = 1;
}
export function chartTex(title, accent) { const ys = chartLine(); return canvasTex(384, 240, (g) => drawChart(g, title, accent, ys)); }
export function rowsTex(title, accent) { const ws = rowWidths(); return canvasTex(384, 240, (g) => drawRows(g, title, accent, ws)); }
// An idle agent's "Away" screen. Its name obeys Streamer like a terminal title: drawn through shown() with
// the blur and redrawn when the mode flips. A label that is not a name (the live row's "Open seat") is drawn as is.
export const awayScreens = [];
// A scheduled agent's screen says its next run in place of "Idle, no task" (live.js, through userData.setLine):
// a time, not a name, so Streamer leaves it; it draws only when the line changed.
export function awayTex(name, accent, isName = true) {
  const tex = canvasTex(384, 240, () => {}), c = tex.userData.canvas, g = c.getContext('2d');
  let line = null;
  const draw = () => {
    g.fillStyle = '#040506'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#e8e8ec'; g.font = '200 64px -apple-system,"Segoe UI",Inter,sans-serif'; g.fillText('Away', 22, 120);
    g.font = '600 18px -apple-system,"Segoe UI",Inter,sans-serif';
    g.save(); if (isName && streaming()) g.filter = 'blur(6px)'; g.fillStyle = accent; g.fillText(isName ? shown(name) : name, 24, 156); g.restore();
    if (line) { g.fillStyle = '#e8e8ec'; g.fillText(line, 24, 184, c.width - 48); } else { g.fillStyle = '#ff453a'; g.fillText('Idle, no task', 24, 184); }
    tex.needsUpdate = true;
  };
  tex.userData.setLine = (t) => { if (t === line) return; line = t; draw(); };
  tex.userData.line = () => line;
  draw(); if (isName) awayScreens.push(draw); return tex;
}
// A desk's center screen. It shows the figure's newest step drawn like its app (screens.js), typed in at the typing
// pace; while Streamer is on, with no step to show, or for a step of another kind it is the stand-in terminal, rows of
// code-shaped blocks that scroll while the agent types under a title line (an agent's name, a session's task, the
// step's label) drawn through shown() with the blur, so Streamer masks it. A live seat's canvas is 640 x 400 (`big`), a
// roster desk's 384 x 240; both draw in the same spaces, scaled. It paints only while in view (tickScreens, life.js):
// at most once a second for a change from the payload or a blink, and at each keystroke step while it types. A
// screenshot it shows is fetched by the id the server issued, never while Streamer is on. texture.userData.painted
// keeps what it painted.
export const terminals = [];
setReduced(REDUCED);
const LIGHT_PAGE = .7; // a light page's brightness: its white stays under the bloom's threshold (.78)
export function makeTerminal(title, accent, big = false) {
  const c = document.createElement('canvas'); c.width = big ? 640 : 384; c.height = big ? 400 : 240; const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = ANISO;
  const lines = [], line = () => { const ind = (rand() * 4) | 0, toks = []; let x = 16 + ind * 18; const n = 2 + (rand() * 4) | 0; for (let i = 0; i < n; i++) { const w = 14 + rand() * 60; toks.push([x, w, rand()]); x += w + 7; } return toks; };
  for (let i = 0; i < 12; i++) lines.push(line());
  const fake = (t) => { // the stand-in terminal in its 384 x 240 space; t is the title, masked while streaming
    g.fillStyle = '#030605'; g.fillRect(0, 0, 384, 240);
    g.fillStyle = accent; g.font = '700 17px ui-monospace,SFMono-Regular,Consolas,monospace';
    g.save(); if (streaming()) g.filter = 'blur(6px)'; g.fillText(t, 16, 26); g.restore();
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(16, 36, 352, 1);
    lines.forEach((toks, r) => toks.forEach(([x, w, k]) => { g.fillStyle = k < .35 ? accent : k < .75 ? 'rgba(235,235,240,.72)' : 'rgba(150,150,160,.45)'; g.fillRect(x, 48 + r * 15, Math.min(w, 368 - x), 8); }));
    const cy = 48 + 11 * 15; g.fillStyle = accent; g.fillRect(16, cy + 10, 9, 3);
  };
  const load = shotLoader(() => T); // the screenshot the screen names, once; it shows from the next paint
  const T = Object.assign(newScreen(title), {
    mat: new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.4, 1.4, 1.4) }), next: 0, paintedAt: -1e9, inView: true, gone: false,
    draw() {
      const p = tex.userData.painted = paintCenter(g, T, c.width, c.height, fake);
      T.mat.color.setScalar(p.light ? LIGHT_PAGE : 1.4); // a white page at the dark screens' 1.4 would flood the bloom
      T.dirty = false; T.paintedAt = now(); tex.needsUpdate = true; load();
    },
    paint() { if (T.inView) T.draw(); else T.dirty = true; },
    step() { if (isLive(T)) { if (revealStep(T)) T.paint(); } else { lines.shift(); lines.push(line()); T.paint(); } },
    setScreen(sc) { screenTo(T, sc); },
    setStatus(text) { return statusTo(T, text); },
    tick(t, seen) {
      T.inView = seen;
      if (!seen || t - T.paintedAt < 1) return;
      const blink = pending(T) && !REDUCED;
      if (blink) T.blink = !T.blink;
      if (T.dirty || blink) T.draw();
    },
  });
  T.draw(); // after T: draw reads T.title
  terminals.push(T); return T;
}
// A live seat's side screens: the left lists the figure's newest steps, the right the files it touched; while
// Streamer is on, or before the figure has a step, the stand-in activity line and claimed rows. Painted only while in view,
// and only when what they would show changes (a time ago changes once a minute).
export const sideScreens = [];
export function makeSide(which, accent) {
  const shape = which === 'steps' ? chartLine() : rowWidths(); // the draws chartTex and rowsTex took, in their order
  const tex = canvasTex(384, 240, () => {}), c = tex.userData.canvas, g = c.getContext('2d');
  const fake = () => (which === 'steps' ? drawChart(g, 'activity', accent, shape) : drawRows(g, 'files claimed', accent, shape));
  const S = Object.assign(newSide(which), {
    mat: screenMat(tex), paintedAt: -1e9, checkedAt: -1e9, dirty: true,
    draw() { const at = Date.now(); S.sig = sideSig(S, at); tex.userData.painted = paintSide(g, S, c.width, c.height, fake, at); S.paintedAt = S.checkedAt = now(); S.dirty = false; tex.needsUpdate = true; },
    set(sc) { if (setSide(S, sc)) S.dirty = true; },
    tick(t, seen) { if (!seen || t - S.checkedAt < 1) return; S.checkedAt = t; if (S.dirty || sideSig(S, Date.now()) !== S.sig) S.draw(); },
  });
  S.draw(); sideScreens.push(S); return S;
}
// Streamer flipped: every screen is painted again in place, in view or not, before the next frame
onStreaming(() => { terminals.forEach(T => T.draw()); sideScreens.forEach(S => S.draw()); awayScreens.forEach(d => d()); plates.forEach(P => P.draw()); }); // plates: the name plates, below
export function protoDesk(w) {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(w, .05, .8), walnut); top.position.y = .745; g.add(top);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(w, .014, .014), BRASS); edge.position.set(0, .745, .4); g.add(edge);
  for (const s of [1, -1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(.05, .72, .76), walnutDark); p.position.set(s * (w / 2 - .02), .36, 0); g.add(p); }
  const mod = new THREE.Mesh(new THREE.BoxGeometry(w - .08, .5, .03), walnutDark); mod.position.set(0, .45, -.3); g.add(mod);
  return shadowAll(fuse(g));
}
export const DESK = protoDesk(1.6), DESK_NARROW = protoDesk(1.25);
// ---------- what is on a desk ----------
// Everything on a desk's top is one mesh in one shared vertex-colored material, so a desk draws its top in one call: the
// keyboard, the mouse on its pad, the desk phone, the papers (a squared stack or a tray) and its owner's own things,
// chosen in desk-kit.js from the desk's key. Each part is a primitive (all indexed, no uv) in its own color; each thing's
// box (desk coordinates) goes on the group's userData.items for the checks.
export const KIT_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .55, metalness: .05 });
const tint3 = new THREE.Color();
function part(geo, color, pos = [0, 0, 0], rot = null, scl = null) {
  if (scl) geo.scale(...scl);
  if (rot) geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot)));
  geo.translate(...pos); geo.deleteAttribute('uv');
  tint3.set(color); const n = geo.attributes.position.count, c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set([tint3.r, tint3.g, tint3.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d), cyl = (r0, r1, h, n = 18) => new THREE.CylinderGeometry(r0, r1, h, n), ball = (r, a = 14, b = 10) => new THREE.SphereGeometry(r, a, b);
const PICTURES = [['#5d84a8', '#4f7a46'], ['#c27a4a', '#3e3550'], ['#3f6f8f', '#c9b48a'], ['#7d8fa6', '#5b6b4a']];
// each kind built around its own footprint, standing on y 0, its front (+z) toward the chair
const ITEMS = {
  mug: (c) => [part(cyl(.037, .035, .09, 20), c, [-.014, .045, 0]), part(cyl(.032, .032, .002, 20), '#2a1a10', [-.014, .0905, 0]), part(new THREE.TorusGeometry(.024, .0065, 8, 16, Math.PI), c, [.021, .047, 0], [0, 0, -Math.PI / 2])],
  plant: (c) => [part(cyl(.045, .036, .08), c, [0, .04, 0]), part(cyl(.041, .041, .004), '#2b1d14', [0, .079, 0]),
    part(ball(.04), '#3d7f45', [0, .128, 0]), ...[[.016, .104, .012, '#2f6b3a'], [-.017, .106, -.01, '#4f8a3a'], [.008, .1, -.018, '#356f3d'], [-.012, .1, .017, '#447f3f']].map(([x, y, z, g]) => part(ball(.03), g, [x, y, z]))],
  lamp: (c) => [part(cyl(.05, .052, .014, 20), c, [0, .007, 0]), part(cyl(.006, .006, .225, 8), '#77653f', [0, .1265, 0]), part(cyl(.028, .055, .07, 20), c, [0, .2735, 0])],
  headphones: (c) => [part(box(.09, .012, .07), '#2b2a2f', [0, .006, 0]), part(cyl(.006, .006, .22, 8), '#2b2a2f', [0, .122, 0]), part(box(.012, .012, .05), '#2b2a2f', [0, .238, 0]),
    part(new THREE.TorusGeometry(.062, .008, 8, 20, Math.PI), c, [0, .19, 0]), ...[1, -1].map((s) => part(cyl(.03, .03, .024, 16), c, [s * .064, .175, 0], [0, 0, Math.PI / 2]))],
  photo: (c) => { // tilted back on a leg behind it
    const [sky, land] = PICTURES[KINDS.photo.colors.indexOf(c) % PICTURES.length], back = new THREE.Matrix4().makeRotationX(-.2);
    return [part(box(.1, .13, .012), c, [0, .065, 0]), part(box(.084, .06, .002), sky, [0, .087, .0065]), part(box(.084, .05, .002), land, [0, .033, .0065])].map((g) => g.applyMatrix4(back)).concat(part(box(.03, .1, .006), c, [0, .048, -.034], [.35, 0, 0])); },
  notebook: (c) => [part(box(.21, .016, .15), c, [0, .008, 0]), part(box(.006, .0165, .152), '#151515', [.07, .008, 0]), part(cyl(.0045, .0045, .13, 8), '#1b1b1b', [-.01, .0205, .01], [0, .3, Math.PI / 2])],
  bottle: (c) => [part(cyl(.033, .033, .17), c, [0, .085, 0]), part(cyl(.02, .033, .02), c, [0, .18, 0]), part(cyl(.021, .021, .03, 14), '#1b1c20', [0, .205, 0])],
  pencup: (c) => [part(cyl(.038, .036, .095), c, [0, .0475, 0]), part(cyl(.034, .034, .002), '#111113', [0, .095, 0]),
    ...[['#1f4fa0', 0], ['#1b1b1b', 2.1], ['#b02a2a', 4.2]].map(([pc, a]) => { const lx = Math.sin(a), lz = Math.cos(a); return part(cyl(.004, .004, .11, 6), pc, [.014 * lx + .0545 * Math.sin(.15) * lx, .03 + .0545 * Math.cos(.15), .014 * lz + .0545 * Math.sin(.15) * lz], [.15 * lz, 0, -.15 * lx]); })],
  duck: (c) => [part(ball(.03), c, [0, .024, 0], null, [1.15, .8, 1.2]), part(ball(.018, 12, 8), c, [0, .055, .016]), part(new THREE.ConeGeometry(.008, .016, 8), '#d9822b', [0, .052, .036], [Math.PI / 2, 0, 0])],
  sticky: (c) => [part(box(.076, .014, .076), c, [0, .007, 0])],
};
// a thing's parts moved so its box is centered on its place and stands on the desktop
function standAt(parts, x, z) {
  const b = new THREE.Box3(); for (const g of parts) { g.computeBoundingBox(); b.union(g.boundingBox); }
  for (const g of parts) g.translate(x - (b.min.x + b.max.x) / 2, DESKTOP_Y - b.min.y, z - (b.min.z + b.max.z) / 2);
  return parts;
}
const PADS = ['#141518', '#1d2433', '#2a1f1a', '#1f2a24'], TRAYS = ['#1b1b1e', '#5a3d24', '#8c8f94'];
// The name plate: a black tent, its two faces leaning TILT off upright and meeting at a brass ridge, in its own frame
// (x along the ridge, +z its face toward the chair side). Its name is a quad on each face (PLATE_TEXT) under one canvas
// texture. LIFT: a 3 mm face leaning TILT reaches LIFT under its own center line, so the tent is raised by it to stand
// on the desk.
const TILT = .3, SLANT = PLATE.h / Math.cos(TILT), FOOT = SLANT * Math.sin(TILT), LIFT = .0015 * Math.sin(TILT), MID = DESKTOP_Y + PLATE.h / 2 + LIFT;
const TENT = [1, -1].map((s) => [box(PLATE.w, SLANT, .003), '#0d0d10', [0, MID, s * (FOOT / 2 - .0015)], [-s * TILT, 0, 0]])
  .concat([[cyl(.003, .003, PLATE.w, 8), '#9a7a45', [0, MID + PLATE.h / 2 - .002, 0], [0, 0, Math.PI / 2]]]);
const PLATE_TEXT = mergeGeometries([1, -1].map((s) => {
  const g = new THREE.PlaneGeometry(PLATE.w - .012, SLANT - .012); if (s < 0) g.rotateY(Math.PI); // seen from its own side, each face reads left to right
  g.rotateX(-s * TILT); g.translate(0, MID, s * (FOOT / 2 + .001)); return g; // a millimeter off its face
}));
export function deskTop(kit) {
  const size = kit.narrow ? 'narrow' : 'full', pick = (list) => list[hash32(kit.key + list[0]) % list.length], items = [], all = [];
  const add = (name, parts) => { const b = new THREE.Box3(); for (const g of parts) { g.computeBoundingBox(); b.union(g.boundingBox); } items.push({ name, box: [...b.min.toArray(), ...b.max.toArray()] }); all.push(...parts); };
  const y = DESKTOP_Y, m = kit.mouse;
  add('keyboard', [part(box(KEYBOARD.w, .012, KEYBOARD.d), '#141518', [KEYBOARD.x, y + .006, KEYBOARD.z]), part(box(.42, .004, .115), '#2b2c32', [KEYBOARD.x, y + .014, KEYBOARD.z - .005])]);
  add('pad', [part(box(PAD.w, PAD.h, PAD.d), pick(PADS), [m * PAD.x, y + PAD.h / 2, PAD.z])]);
  add('mouse', [part(new THREE.SphereGeometry(.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), '#1a1b1f', [m * PAD.x, y + PAD.h, PAD.z], null, [MOUSE.w, MOUSE.h * 2, MOUSE.d])]);
  const ph = PHONE[size];
  add('phone', [part(box(PHONE.w, .03, PHONE.d), '#18191c', [ph.x, y + .015, ph.z]), part(box(.09, .02, .14), '#2b2c31', [ph.x + .035, y + .036, ph.z + .01], [.18, 0, 0]),
    part(box(.06, .002, .03), '#3d4a55', [ph.x + .035, y + .0565, ph.z - .045], [.18, 0, 0]), part(new THREE.CapsuleGeometry(.016, .15, 4, 10), '#202125', [ph.x - .045, y + .046, ph.z], [Math.PI / 2, 0, 0])]);
  const pp = PAPERS[size];
  if (kit.papers === 'stack') add('papers', [part(box(.21, .016, .297), '#cfc9bb', [pp.x, y + .008, pp.z]), part(box(.21, .002, .297), '#e2ddd2', [pp.x, y + .017, pp.z])]);
  else {
    const T = PAPERS.tray, tc = pick(TRAYS);
    add('papers', [part(box(T.w, .006, T.d), tc, [pp.x, y + .003, pp.z]), ...[1, -1].map((s) => part(box(T.w, .044, .008), tc, [pp.x, y + .028, pp.z + s * (T.d / 2 - .004)])),
      ...[1, -1].map((s) => part(box(.008, .044, T.d - .016), tc, [pp.x + s * (T.w / 2 - .004), y + .028, pp.z])), part(box(.21, .02, .297), '#d8d2c6', [pp.x, y + .016, pp.z])]);
  }
  const pl = plateAt(kit.narrow, kit.plateSide), turn = new THREE.Matrix4().makeRotationY(pl.yaw).setPosition(pl.x, 0, pl.z);
  add('plate', TENT.map(([geo, c, pos, rot]) => part(geo.clone(), c, pos, rot).applyMatrix4(turn)));
  for (const it of kit.items) add(it.kind, standAt(ITEMS[it.kind](it.color), it.x, it.z));
  const mesh = new THREE.Mesh(mergeGeometries(all), KIT_MAT); mesh.castShadow = mesh.receiveShadow = true;
  return { mesh, items };
}
// The three monitors, from the numbers in monitors.js, built once per desk size: one black mesh for the three front
// shells, one matte gray mesh for their back housings and the arm they share (a bent bar on a pole clamped at the
// desk's back edge), and a screen plane each. A desk clones the two meshes and adds its three screens.
const HOUSING_MAT = new THREE.MeshStandardMaterial({ color: '#2b2d33', roughness: .7, metalness: .3 });
function monitorSet(narrow) {
  const L = monitorLayout(narrow), [W, H] = L.face, shells = [], backs = [];
  // a part drawn in a monitor's own frame (x across, y up, z out of the screen, 0 at the front face), set on the desk
  const frame = m => new THREE.Matrix4().compose(new V3(...m.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(m.tilt, m.yaw, 0, 'YXZ')), new V3(1, 1, 1));
  const at = (geo, m, z) => geo.translate(0, 0, z).applyMatrix4(frame(m));
  const flat = geo => geo.index ? geo.toNonIndexed() : geo;
  const back = SHELL + HOUSING, bar = back + ARM.behind, ends = [];
  for (const m of L.monitors) {
    shells.push(at(slab(W, H, SHELL - .004, .012, .002), m, -SHELL / 2));
    backs.push(at(slab(W - 2 * INSET, H - 2 * INSET, HOUSING - .006, .02, .003), m, -SHELL - HOUSING / 2));
    backs.push(flat(at(new THREE.BoxGeometry(ARM.mount, ARM.mount, ARM.behind), m, -back - ARM.behind / 2)));
    const Z = axes(m.yaw, m.tilt).Z; ends.push(m.pos.map((v, i) => v - bar * Z[i]));
  }
  // the bar: through the three mounts, bent where the line behind the center meets the lines behind the sides
  const [bl, bc, br] = ends, y = bc[1], knee = (b, m) => { const X = axes(m.yaw, m.tilt).X, t = (bc[2] - b[2]) / X[2]; return [b[0] + t * X[0], y, bc[2]]; };
  const pts = [[bl[0], y, bl[2]], knee(bl, L.monitors[0]), knee(br, L.monitors[2]), [br[0], y, br[2]]];
  for (let i = 0; i < 3; i++) backs.push(flat(rod(pts[i], pts[i + 1], .011, 10)));
  for (const p of pts.slice(1, 3)) backs.push(flat(new THREE.SphereGeometry(.011, 10, 6).translate(...p)));
  // the pole, from the desktop to just over the bar, and its clamp around the desk's back edge
  backs.push(flat(rod([0, DESKTOP_Y, bc[2]], [0, y + .03, bc[2]], ARM.pole, 14)));
  const edge = -DESK_DEPTH / 2, box = (w, h, d, x, yy, z) => flat(new THREE.BoxGeometry(w, h, d).translate(x, yy, z));
  backs.push(box(.08, .012, bc[2] + .035 - edge + .012, 0, DESKTOP_Y + .006, (bc[2] + .035 + edge - .012) / 2));
  backs.push(box(.08, .09, .012, 0, DESKTOP_Y - .035, edge - .006), box(.08, .012, .06, 0, DESKTOP_Y - .056, edge + .03));
  const shellMesh = new THREE.Mesh(mergeGeometries(shells), BLACK), backMesh = new THREE.Mesh(mergeGeometries(backs), HOUSING_MAT);
  shellMesh.castShadow = backMesh.castShadow = true;
  shellMesh.userData.monitors = backMesh.userData.monitors = true; // a desk's clones carry it: the checks find the monitors by it
  const screen = new THREE.PlaneGeometry(...L.screen);
  const places = L.monitors.map(m => { const Z = axes(m.yaw, m.tilt).Z; return { pos: m.pos.map((v, i) => v + .001 * Z[i]), rot: [m.tilt, m.yaw, 0, 'YXZ'] }; });
  return { shellMesh, backMesh, screen, places };
}
const MONITORS = [monitorSet(false), monitorSet(true)];
// ---------- the name plates ----------
// A desk's tent names who holds it, on both faces: one canvas texture per desk, drawn again in place (never a new
// texture) when the seat changes hands and when Streamer flips. A name is cleaned the way the server cleans names
// (lib/hq.js cap): white space squeezed and trimmed, at most 22 characters, an ellipsis past that. While streaming a name
// shows the tags' mask (shown); a label that is not a name ("Open seat") shows as is. The text drawn is kept on the mesh
// as userData.text for the checks.
export const OPEN_SEAT = 'Open seat', NAME_MAX = 22;
const ELLIPSIS = String.fromCharCode(0x2026), PLATE_FONT = (px) => `600 ${px}px -apple-system,"Segoe UI",Inter,sans-serif`;
export const plateName = (s) => { const c = [...String(s ?? '').replace(/\s+/g, ' ').trim()]; return c.length > NAME_MAX ? c.slice(0, NAME_MAX - 1).join('') + ELLIPSIS : c.join(''); };
export const plates = [];
function makePlate(kit) {
  const tex = canvasTex(384, 120, () => {}), c = tex.userData.canvas, g = c.getContext('2d'), W = c.width, H = c.height;
  const mesh = new THREE.Mesh(PLATE_TEXT, new THREE.MeshBasicMaterial({ map: tex }));
  const pl = plateAt(kit.narrow, kit.plateSide); mesh.position.set(pl.x, 0, pl.z); mesh.rotation.y = pl.yaw;
  const P = {
    mesh, name: OPEN_SEAT, isName: false,
    draw() {
      const masked = P.isName && streaming(), text = P.isName ? shown(plateName(P.name)) : P.name;
      g.fillStyle = '#0d0d10'; g.fillRect(0, 0, W, H);
      g.strokeStyle = '#9a7a45'; g.lineWidth = 3; g.strokeRect(7, 7, W - 14, H - 14);
      let px = 52; g.font = PLATE_FONT(px);
      while (px > 20 && g.measureText(text).width > W - 44) g.font = PLATE_FONT(px -= 2);
      g.save(); if (masked) g.filter = 'blur(5px)';
      g.fillStyle = P.isName ? '#e3c27e' : '#80838b'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, W / 2, H / 2 + 3);
      g.restore();
      mesh.userData.text = text; tex.needsUpdate = true;
    },
  };
  P.draw(); plates.push(P); return P;
}
// the plate of desk D names `name` (a session, a roster agent, a helper), or shows a label that is not a name
export function setPlate(D, name, isName = true) {
  const P = D.g.userData.plate;
  if (P.name === name && P.isName === isName) return;
  P.name = name; P.isName = isName; P.draw();
}
// a desk: its frame, its monitors and screens, and its top as the kit (desk-kit.js) lays it out
export function makeDesk(mats, narrow = false, kit = deskKit('', narrow)) {
  const g = (narrow ? DESK_NARROW : DESK).clone(), screens = [], M = MONITORS[narrow ? 1 : 0];
  g.add(M.shellMesh.clone(), M.backMesh.clone());
  M.places.forEach((p, i) => { const sc = new THREE.Mesh(M.screen, mats[i]); sc.position.set(...p.pos); sc.rotation.set(...p.rot); g.add(sc); screens.push(sc); });
  const top = deskTop(kit); g.add(top.mesh); g.userData.items = top.items;
  const plate = makePlate(kit); g.add(plate.mesh); g.userData.plate = plate;
  for (let i = 0; i < 6; i++) rand(); // the six draws the loose papers took, so every figure keeps the size and the timing it had
  return { g, screens };
}
// ---------- the boss: on a dais, the stealth-jet desk; the owner stands on its nose, ahead of its screen, or sits at it
// on the throne ----------
// the jet desk's top (JET_TOP over the dais), the nose's tip and half its width, and where the owner stands on it: the
// nose runs out past the canopy so their feet are clear of it and of the screen behind
export const DAIS_H = .14, JET_Z = -5.0, JET_TOP = .774, NOSE = [.55, 1.85], ON_NOSE = 1.35;
const DAIS_Z0 = JET_Z - 2.5, DAIS_Z1 = JET_Z + NOSE[1] + .55, DAIS_D = DAIS_Z1 - DAIS_Z0, DAIS_C = (DAIS_Z0 + DAIS_Z1) / 2;
add(new THREE.BoxGeometry(6.6, DAIS_H, DAIS_D), new THREE.MeshStandardMaterial({ map: marbleTex('#0b0b0d', '190,190,200', [2, 1.3]), roughness: .12 }), [0, DAIS_H / 2, DAIS_C], null, { receive: true });
for (const [w, d, x, z] of [[6.64, .03, 0, DAIS_Z1], [6.64, .03, 0, DAIS_Z0], [.03, DAIS_D + .04, 3.3, DAIS_C], [.03, DAIS_D + .04, -3.3, DAIS_C]]) add(new THREE.BoxGeometry(w, .03, d), BRASS, [x, DAIS_H, z]);

export const carbonTex = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#09090b'; g.fillRect(0, 0, w, h);
  const s = 16;
  for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
    const k = ((x / s + y / s) % 4) < 2;
    const gr = k ? g.createLinearGradient(x, y, x + s, y) : g.createLinearGradient(x, y, x, y + s);
    gr.addColorStop(0, '#08080a'); gr.addColorStop(.5, k ? '#202126' : '#16171a'); gr.addColorStop(1, '#08080a');
    g.fillStyle = gr; g.fillRect(x + .5, y + .5, s - 1, s - 1);
  }
}, [2.5, 2.5]);
export const CARBON = new THREE.MeshPhysicalMaterial({ map: carbonTex, roughness: .36, metalness: .25, clearcoat: 1, clearcoatRoughness: .05, flatShading: true });
export const MATTE = new THREE.MeshPhysicalMaterial({ color: '#08080a', roughness: .5, metalness: .45, flatShading: true });
export const AMBER = glow('#ffad42', 2.4), AMBER_SOFT = glow('#ff8a2a', 1.4);
export const hexTex = (glowOnly) => canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = glowOnly ? '#000' : '#0a0a0c'; g.fillRect(0, 0, w, h);
  const r = 14, dx = r * Math.sqrt(3), dy = r * 1.5;
  for (let row = -1; row * dy < h + r; row++) for (let col = -1; col * dx < w + dx; col++) {
    const cx = col * dx + (row % 2 ? dx / 2 : 0), cy = row * dy;
    g.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; g.lineTo(cx + Math.cos(a) * (r - 3), cy + Math.sin(a) * (r - 3)); } g.closePath();
    g.fillStyle = glowOnly ? '#fff' : '#020203'; g.fill();
  }
}, [2, 2]);
export const VENT = new THREE.MeshStandardMaterial({ map: hexTex(false), emissiveMap: hexTex(true), emissive: '#ff6a1a', emissiveIntensity: 1.3, roughness: .5, metalness: .6, side: THREE.DoubleSide });

export const jet = new THREE.Group(); jet.position.set(0, DAIS_H, JET_Z); scene.add(jet);
export let strobe;
{
  // delta-wing top with a sawtooth trailing edge, chamfered so every face catches light
  const [NX, NZ] = NOSE;
  const PL = [[-NX, NZ], [NX, NZ], [1.98, -.04], [1.84, -.52], [1.06, -.24], [.62, -.64], [-.62, -.64], [-1.06, -.24], [-1.84, -.52], [-1.98, -.04]];
  const topGeo = new THREE.ExtrudeGeometry(poly(PL.map(([x, z]) => [x, -z])), { depth: .05, bevelEnabled: true, bevelThickness: .024, bevelSize: .032, bevelSegments: 1 });
  topGeo.rotateX(-Math.PI / 2); topGeo.translate(0, .70, 0);
  // satin, not CARBON's mirror clearcoat: the boss's spotlight lands on this top now and a gloss turns it into a hot
  // sheen
  const top = CARBON.clone(); top.clearcoatRoughness = .45; top.roughness = .5;
  add(topGeo, top, null, null, { cast: true, parent: jet });
  // amber light lines along the leading edges and the nose
  const edge = (a, b, y, off, mat, r = .006) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz), nx = -dz / l, nz = dx / l, sgn = (nx * (a[0] + b[0]) + nz * (a[1] + b[1])) > 0 ? 1 : -1;
    add(rod([a[0] + nx * off * sgn, y, a[1] + nz * off * sgn], [b[0] + nx * off * sgn, y, b[1] + nz * off * sgn], r, 6), mat, null, null, { receive: false, parent: jet });
  };
  edge([NX, NZ], [1.98, -.04], .725, .045, AMBER, .011); edge([-NX, NZ], [-1.98, -.04], .725, .045, AMBER, .011);
  edge([-NX, NZ], [NX, NZ], .725, .045, AMBER, .011);
  edge([1.98, -.04], [1.84, -.52], .725, .045, AMBER_SOFT, .008); edge([-1.98, -.04], [-1.84, -.52], .725, .045, AMBER_SOFT, .008);
  edge([NX + .08, NZ - .12], [1.9, -.04], .66, -.02, AMBER_SOFT, .014); edge([-NX - .08, NZ - .12], [-1.9, -.04], .66, -.02, AMBER_SOFT, .014);
  // Y-shaped lamps on the nose
  for (const x of [-.25, .25]) {
    add(rod([x, .69, NZ + .042], [x, .716, NZ + .042], .004, 6), AMBER, null, null, { parent: jet });
    add(rod([x, .716, NZ + .042], [x - .04, .748, NZ + .038], .004, 6), AMBER, null, null, { parent: jet });
    add(rod([x, .716, NZ + .042], [x + .04, .748, NZ + .038], .004, 6), AMBER, null, null, { parent: jet });
  }
  // canted twin tail fins as legs, with glowing hex vents
  const finGeo = (() => { const g = new THREE.ExtrudeGeometry(poly([[-.62, 0], [.5, 0], [.16, .72], [-.48, .72]]), { depth: .05, bevelEnabled: true, bevelThickness: .014, bevelSize: .014, bevelSegments: 1 }); g.translate(0, 0, -.025); g.rotateY(-Math.PI / 2); return g; })();
  for (const s of [1, -1]) {
    const fin = add(finGeo, CARBON, [s * 1.24, 0, -.02], [0, 0, s * .3], { cast: true, parent: jet });
    add(new THREE.PlaneGeometry(.52, .26), VENT, [s * .042, .3, -.08], [0, s * Math.PI / 2, 0], { parent: fin });
  }
  add(new THREE.BoxGeometry(2.2, .06, .3), MATTE, [0, .42, -.04], null, { parent: jet });
  // smoked faceted canopy, lit from inside
  const canopy = new THREE.OctahedronGeometry(1, 0); canopy.scale(.26, .07, .5);
  add(canopy, new THREE.MeshPhysicalMaterial({ color: '#170d06', roughness: .06, metalness: .3, clearcoat: 1, emissive: '#5a2a08', emissiveIntensity: .7, flatShading: true }), [0, .776, .42], null, { parent: jet });
  // wingtip nav lights and a tail strobe
  add(new THREE.SphereGeometry(.02, 10, 8), glow('#ff2a1a', 3), [1.98, .725, -.06], null, { parent: jet });
  add(new THREE.SphereGeometry(.02, 10, 8), glow('#2aff6a', 3), [-1.98, .725, -.06], null, { parent: jet });
  strobe = add(new THREE.SphereGeometry(.018, 10, 8), glow('#ffffff', 4), [0, .74, -.69], null, { parent: jet });
  // hologram display and keyboard
  const holo = canvasTex(1024, 440, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,170,70,.5)'; g.lineWidth = 2; g.strokeRect(6, 6, w - 12, h - 12);
    g.strokeStyle = 'rgba(255,170,70,.12)'; for (let x = 0; x < w; x += 48) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    g.strokeStyle = '#ffb35a'; g.lineWidth = 4; g.beginPath(); let y = 300; for (let x = 30; x < w - 30; x += 14) { y = clamp(y + (rand() - .45) * 34, 90, 380); x === 30 ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke();
    g.fillStyle = 'rgba(120,220,255,.75)'; for (let i = 0; i < 14; i++) g.fillRect(40 + i * 66, h - 40 - rand() * 90, 40, 6);
  });
  holo.colorSpace = THREE.SRGBColorSpace;
  add(new THREE.PlaneGeometry(1.3, .56), new THREE.MeshBasicMaterial({ map: holo, transparent: true, opacity: .8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, color: new THREE.Color(1.3, 1.3, 1.3) }), [0, 1.13, -.16], [-.12, 0, 0], { receive: false, parent: jet });
  add(new THREE.BoxGeometry(1.3, .016, .04), AMBER, [0, .79, -.16], null, { parent: jet });
  add(new THREE.BoxGeometry(.5, .014, .16), MATTE, [0, .785, -.42], null, { parent: jet });
}
// the throne: a faceted bucket seat in hex-quilted leather with amber stitching
export const quilt = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#0e0c0c'; g.fillRect(0, 0, w, h);
  const r = 20, dx = r * Math.sqrt(3), dy = r * 1.5;
  g.strokeStyle = 'rgba(214,140,50,.55)'; g.lineWidth = 1.5; g.setLineDash([4, 3]);
  for (let row = -1; row * dy < h + r; row++) for (let col = -1; col * dx < w + dx; col++) {
    const cx = col * dx + (row % 2 ? dx / 2 : 0), cy = row * dy; g.beginPath();
    for (let i = 0; i <= 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } g.stroke();
  }
}, [5, 5]);
export const QUILT = new THREE.MeshPhysicalMaterial({ map: quilt, roughness: .45, clearcoat: .5, clearcoatRoughness: .3, flatShading: true });
export const throne = new THREE.Group(); throne.position.set(0, DAIS_H, JET_Z - 1.4); scene.add(throne);
add(sideExtrude([[.3, .4], [.3, .52], [-.16, .5], [-.24, 1.3], [-.2, 1.52], [-.36, 1.5], [-.38, .6], [-.26, .4]], .52, .016), QUILT, null, null, { cast: true, parent: throne });
for (const s of [1, -1]) {
  const b = add(sideExtrude([[.26, .4], [.3, .66], [-.1, .63], [-.2, 1.12], [-.32, 1.16], [-.38, .58], [-.26, .4]], .08, .01), MATTE, [s * .3, 0, 0], null, { cast: true, parent: throne });
  add(sideExtrude([[-.14, 1.3], [-.08, 1.5], [-.3, 1.55], [-.36, 1.3]], .07, .008), MATTE, [s * .22, 0, 0], null, { parent: throne });
  add(rod([s * .345, .66, .3], [s * .345, .63, -.1], .005, 6), AMBER_SOFT, null, null, { parent: throne });
}
add(new THREE.CylinderGeometry(.03, .036, .34, 12), CHROME, [0, .22, -.04], null, { parent: throne });
for (let i = 0; i < 5; i++) { const a = i * Math.PI * 2 / 5; add(rod([0, .05, -.04], [Math.sin(a) * .34, .03, -.04 + Math.cos(a) * .34], .022, 6), CHROME, null, null, { parent: throne }); }
