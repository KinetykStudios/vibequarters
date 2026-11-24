// The rows: the sessions' seats in three straight rows on the right, a row per department on the left, a floating label
// over a department's row while one of its agents works, and a desk record for every seat. A desk is built the first
// time its seat is held and stands in the room only while it is held (showDesk, hideDesk): an empty seat draws nothing.
// No glass, and no light per desk: the two sides share two. Where everything goes comes from plan.js.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { CONFIG } from './data.js';
import { V3, scene, BRASS, add } from './core.js';
import { CHAIR, screenMat, OFF_MAT, LOCK_MAT, chartTex, rowsTex, awayTex, makeTerminal, makeDesk, setPlate, DAIS_H, JET_Z, JET_TOP, ON_NOSE } from './furniture.js';
import { deskInputs, deskKit, NEAR } from './desk-kit.js';
import { ROOM, GRID, STAND, liveRows, sections } from './plan.js';

export const BOSS_POS = new V3(0, DAIS_H + JET_TOP, JET_Z + ON_NOSE), BOSS_WALK = 1.0; // on the boss's desk's nose; m/s
export const persons = [];
export const LIVE_GREEN = '#30d158';
const ZONE_Y = 1.35; // a row label's height, about desk-monitor height: far under the camera, so the rows' labels spread apart down the Boss view, and under the name tags (2.08)

// ---------- seats and their desks ----------
// A seat's record: where its desk stands (yaw: the way its figure faces, its back to the boss), where the figure sits and
// stands to sit, and its kit (desk-kit.js), drawn now from its key and the seats before it, so a desk is the same
// whenever it is built. g, chair, screens and lookPts come with the desk.
export const DESKS = [];
function seatAt(key, s, extra) {
  const ux = Math.sin(s.yaw), uz = Math.cos(s.yaw);
  const kit = deskKit(key, s.narrow, s.plateSide, DESKS.filter(D => Math.hypot(D.x - s.x, D.z - s.z) < NEAR).map(D => D.kit.set));
  const D = { key, slot: s, x: s.x, z: s.z, yaw: s.yaw + Math.PI, w: s.narrow ? 1.25 : 1.6, g: null, chair: null, screens: [], shown: false, lookPts: null,
    seat: new V3(s.x + ux * .68, 0, s.z + uz * .68), stand: new V3(s.x + ux * STAND, 0, s.z + uz * STAND), kit, ...deskInputs(kit.mouse), ...extra };
  DESKS.push(D); return D;
}
// the desk itself, once: its frame, monitors and screens (`mats` gives their idle materials), top, plate and chair
export function buildDesk(D) {
  if (D.g) return D;
  const s = D.slot, { g, screens } = makeDesk(D.mats(), s.narrow, D.kit);
  g.position.set(s.x, 0, s.z); g.rotation.y = s.yaw; g.updateMatrixWorld(true);
  const ch = CHAIR.clone(); ch.position.set(s.x + Math.sin(s.yaw) * .61, 0, s.z + Math.cos(s.yaw) * .61); ch.rotation.y = s.yaw + Math.PI; ch.updateMatrixWorld(true);
  for (const o of [g, ch]) o.traverse(c => { c.matrixAutoUpdate = false; }); // nothing on a desk moves: no frame recomposes its matrices
  Object.assign(D, { g, chair: ch, screens, lookPts: screens.map(sc => sc.getWorldPosition(new V3())), awayMats: screens.map(sc => sc.material) });
  D.built(D); return D;
}
export function showDesk(D) { buildDesk(D); if (!D.shown) { scene.add(D.g, D.chair); D.shown = true; } }
export function hideDesk(D) { if (D.shown) { scene.remove(D.g, D.chair); D.shown = false; } }

// the sessions' seats, the nearest row first: sessions and helpers take them at runtime (live.js)
export const LIVE_ROWS = liveRows();
export const LIVE_SLOTS = LIVE_ROWS.flatMap((r) => r.slots).map((s, i) => seatAt('live:' + i, s, {
  live: i, owner: null,
  mats: () => [OFF_MAT, screenMat(awayTex('Open seat', LIVE_GREEN, false)), OFF_MAT],
  built: () => {},
}));
// a desk per roster agent in its department's section; its screens show its name while away and its work while working
export const SECTIONS = sections(CONFIG.sections, CONFIG.roster);
const deptScreens = new Map(); // a department's chart and queue screens, shared by its desks, made with the first
for (const sec of SECTIONS) for (const s of sec.slots) {
  const a = CONFIG.roster.find(r => r.id === s.id);
  seatAt('desk:' + a.id, s, {
    agent: a, color: sec.color,
    mats: () => [LOCK_MAT, screenMat(awayTex(a.name, sec.color)), LOCK_MAT],
    built: (D) => {
      if (!deptScreens.has(sec.name)) deptScreens.set(sec.name, [screenMat(chartTex(sec.name, sec.color)), screenMat(rowsTex('queue', sec.color))]);
      const [chart, rows] = deptScreens.get(sec.name), T = makeTerminal(a.name, sec.color);
      setPlate(D, a.name); // its own agent's name, there or not
      Object.assign(D, { term: T, workMats: [chart, T.mat, rows] });
    },
  });
}
export const deskOf = (id) => DESKS.find(D => D.key === 'desk:' + id);
// the first live seat's desk, built now so the room's first compile (stage.js) covers a desk's programs: a desk that
// appears later never waits on a shader
export function deskSample() { const D = buildDesk(LIVE_SLOTS[0]); return new THREE.Group().add(D.g.clone(), D.chair.clone()); }

// ---------- what marks the rows ----------
// A label floating over a row's aisle end: "Live sessions" over the sessions' nearest row, always (three alike would
// stack in the Boss camera), and a department's name over its row only while one of its agents is at work (showZones,
// from live.js), so an idle room carries no floating words. The labels are page text like the name tags, so they read
// from any height, the overhead included, and draw nothing on the GPU. No back panels, no neon, nothing hung from the
// roof.
function zone(name, color, r) {
  const el = document.createElement('div'); el.className = 'zone'; el.textContent = name; el.style.setProperty('--c', color);
  const label = new CSS2DObject(el); label.position.set(r.side * (GRID.aisle - .2), ZONE_Y, r.z + .6); scene.add(label); // over the aisle's edge, just behind the row, clear of the first desk's tag
  return label;
}
zone('Live sessions', LIVE_GREEN, LIVE_ROWS[0]);
export const ZONES = new Map(SECTIONS.map((sec) => {
  const L = zone(sec.name, sec.color, sec);
  L.visible = sec.slots.some((s) => CONFIG.roster.find((a) => a.id === s.id).inSession); // until the first poll says
  return [sec.name, L];
}));
export function showZones(depts) { for (const [name, L] of ZONES) L.visible = depts.has(name); }
// the aisle: a dark runner from the boss's inlay to the front glass, brass down both edges
{
  const z0 = 5.3, z1 = ROOM.zMax - .5, w = 2.4, runner = new THREE.PlaneGeometry(w, z1 - z0); runner.rotateX(-Math.PI / 2);
  add(runner, new THREE.MeshStandardMaterial({ color: '#0f0d0b', roughness: .95 }), [0, .004, (z0 + z1) / 2]);
  add(mergeGeometries([-1, 1].map((s) => new THREE.BoxGeometry(.04, .006, z1 - z0).translate(s * (w / 2 - .1), .006, (z0 + z1) / 2))), BRASS, null, null, { receive: false });
}
// each side's own light, high over the middle of its rows (no light per desk: a light that comes and goes would
// recompile every lit material in the room)
for (const [x, z] of [[(GRID.aisle + GRID.out) / 2, GRID.z0 + 2 * GRID.row], [-(GRID.aisle + GRID.out) / 2, GRID.z0 + GRID.row]]) { const l = new THREE.PointLight('#ffe0bd', 44, 18, 2); l.position.set(x, 4.4, z); scene.add(l); }
