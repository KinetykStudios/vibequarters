// Every roster agent sits at its own desk all day: its screens show its work while it works and its name while it is
// idle. Only the live seats come and go (live.js); a live seat's desk stands only while it is held.
import * as THREE from 'three';
import { CONFIG } from './data.js';
import { V3, lerp, clamp, wrapAngle, rand, scene, now } from './core.js';
import { SEATS, buildPerson, setPose, pickables } from './person.js';
import { dress, undress } from './people.js';
import { persons, DESKS, deskOf, buildDesk, showDesk, hideDesk } from './rooms.js';
import { makeTerminal, terminals, makeSide, sideScreens, setPlate, OFF_MAT } from './furniture.js';
import { SPOTS as PLAN_SPOTS, floorMap } from './plan.js';

// ============================================================================
// WALKING: the spots, routes and legs a figure can walk (coffee, chats, naps).
// Every figure sits at its desk all day (above) and none walks; stage.js still steps one whose state
// says so. Scripted motion, not AI behavior.
// ============================================================================
export function prepSpot(S) {
  S.yaw = Math.atan2(S.face[0] - S.pos[0], S.face[1] - S.pos[1]);
  S.posV = new V3(S.pos[0], 0, S.pos[1]); S.stand = S.stand || S.pos; S.standV = new V3(S.stand[0], 0, S.stand[1]);
  return S;
}
export const SPOTS = {};
for (const [k, S] of Object.entries(PLAN_SPOTS)) SPOTS[k] = prepSpot({ ...S });
// a desk spot per roster desk and per live seat. It never times out (Infinity would make settle() compute NaN)
for (const D of DESKS) {
  SPOTS[D.key] = prepSpot({ pos: [D.seat.x, D.seat.z], stand: [D.stand.x, D.stand.z], face: [D.seat.x + Math.sin(D.yaw), D.seat.z + Math.cos(D.yaw)],
    seat: 'desk', act: 'type', name: 'its desk', where: 'At its desk, working', dur: [1e9, 1e9], desk: D });
}
// the walkable floor and its routes (plan.js floorMap): every desk slot is in the way, built or not
const floor = floorMap(DESKS.map(D => D.slot));
export const { blocked, los } = floor;
export function navRoute(a, b) {
  const r = floor.route(a, b);
  if (!r) { console.warn('VibeQuarters: no walking route', a, b); return [b]; }
  return r;
}
// walk a path of [x, z, y?] points; a drop or climb over .3 m is a hop
export function walkAlong(P, dt, speed) {
  const p = P.root.position, tgt = P.path[P.pi], ty = tgt[2] ?? 0;
  const dx = tgt[0] - p.x, dz = tgt[1] - p.z, d = Math.hypot(dx, dz);
  if (!P.segLen) { P.segLen = Math.max(d, 1e-3); P.segY0 = p.y; }
  const hop = Math.abs(ty - P.segY0) > .3, v = speed * (hop ? .6 : 1) * Math.max(.35, P.walkW), step = v * dt;
  P.stride += dt * v / 1.4 * Math.PI * 2;
  if (d > .02) P.yaw += wrapAngle(Math.atan2(dx, dz) - P.yaw) * Math.min(1, dt * 7);
  if (d <= step) { p.set(tgt[0], ty, tgt[1]); P.segLen = 0; return ++P.pi >= P.path.length; }
  p.x += dx / d * step; p.z += dz / d * step;
  const f = clamp(1 - (d - step) / P.segLen, 0, 1); p.y = lerp(P.segY0, ty, f) + (hop ? .16 * Math.sin(Math.PI * f) : 0);
  return false;
}
export const occupant = {};
export const npcs = [];
export function settle(P, t) {
  const S = SPOTS[P.spot], [a, b] = S.dur || [14, 30];
  P.state = 'do'; P.timer = a + rand() * (b - a); P.actT = t; P.where = S.where;
  if (S.desk) { setScreens(P, true); P.lookPts = S.desk.lookPts; }
  if (P.leftDesk) { hideDesk(P.leftDesk); P.leftDesk = null; } // the desk it walked away from goes once it is somewhere else
}
// an idle spot to wander to: never a desk, a free one, drawn toward company and away from the nap
export function pickSpot(P) {
  const opts = Object.keys(SPOTS).filter(k => !occupant[k] && k !== P.spot && !SPOTS[k].desk);
  if (!opts.length) return P.spot; // every hangout taken: stay put (a step out and back), never an undefined spot
  const w = opts.map(k => { const m = SPOTS[k].with; return (m && occupant[m] ? 3 : 1) * (k === 'nap' ? .5 : 1); });
  let x = rand() * w.reduce((s, v) => s + v, 0), k = opts[0];
  for (let i = 0; i < opts.length; i++) if ((x -= w[i]) <= 0) { k = opts[i]; break; }
  return k;
}
export function go(P, k, t) {
  const from = SPOTS[P.spot]; if (occupant[P.spot] === P) occupant[P.spot] = null;
  const S = SPOTS[k]; occupant[k] = P; P.spot = k; P.seat = null; P.lookPts = null;
  if (from && from.desk && from.desk !== S.desk) P.leftDesk = from.desk;
  if (S.desk) { showDesk(S.desk); P.leftDesk = null; }
  const out = from && from.via ? [...from.via].reverse() : [], into = S.via || [];
  const start = out.length ? out[out.length - 1] : [P.root.position.x, P.root.position.z];
  P.path = [...out, ...navRoute(start, into.length ? into[0] : S.stand), ...(into.length ? [...into.slice(1), S.stand] : [])];
  P.pi = 0; P.segLen = 0; P.state = 'walk'; P.where = S.desk ? 'Heading to its desk' : `Walking to ${S.name}`;
  setPose(P, 'walk');
}
// send a person somewhere: a walker finishes its leg first, a sitter stands up first
export function sendTo(P, k, t) {
  if (P.state === 'walk' || P.state === 'turn') { P.next = k; return; }
  if (P.seat) { P.next = k; P.state = 'rise'; return; }
  go(P, k, t);
}
export function setScreens(P, on) {
  const D = P.desk; if (!D || !D.g) return;
  D.screens.forEach((s, i) => { s.material = P.off ? OFF_MAT : on ? D.workMats[i] : D.awayMats[i]; }); // switched off on the page: dark
}
// switched off or on: its screens go dark or come back at once, working or not (setWorking skips an unchanged state)
export function setOff(P, off) { if (P.off === off) return; P.off = off; setScreens(P, !!P.goingToWork); }
// A figure never leaves its desk for work: on or off, it stays seated and its screens turn to its work or its name. A
// live seat's figure off work waits there for live.js to send it out.
export function setWorking(P, on, doing) {
  P.agent.inSession = on; P.agent.doing = doing || null;
  if (P.goingToWork === on) return;
  P.goingToWork = on;
  setScreens(P, on); P.where = on ? SPOTS[P.spot].where : P.agent.live ? 'At its desk, about to head home' : 'At its desk, idle';
}
function sitAt(P, D, t) {
  P.spot = D.key; occupant[D.key] = P; P.root.position.copy(D.seat); P.yaw = D.yaw; P.seat = SEATS.desk; P.sitW = 1; setPose(P, 'type'); settle(P, t);
}
function enter(P) { P.root.rotation.y = P.yaw; scene.add(P.root); persons.push(P); npcs.push(P); dress(P); return P; }

// every roster agent, seated at its desk from the first frame: at work its screens show its work, idle its name
for (const a of CONFIG.roster) {
  const D = buildDesk(deskOf(a.id)), P = buildPerson(a);
  P.npc = true; P.desk = D; P.term = D.term; P.walkW = 0; P.stride = 0; P.fixedLook = new V3();
  showDesk(D); sitAt(P, D, 0); P.goingToWork = true;
  if (!a.inSession) setWorking(P, false);
  enter(P);
}
// a live figure (a real session, or a helper: a subagent no roster figure shows) appears at the live seat live.js gives
// it, already at work
export function addLivePerson(agent, D) {
  const P = buildPerson(agent); P.npc = true; P.desk = D; D.owner = P; P.fixedLook = new V3(); P.walkW = 0; P.stride = 0;
  showDesk(D); setPlate(D, agent.name); // its plate names it, as its tag does
  // its three screens: its steps, its newest step drawn like its app (a 640 x 400 canvas), the files it touched
  const T = makeTerminal(agent.name, '#30d158', true); P.term = T; D.term = T;
  D.side = [makeSide('steps', '#30d158'), makeSide('files', '#30d158')];
  D.workMats = [D.side[0].mat, T.mat, D.side[1].mat];
  sitAt(P, D, now()); P.goingToWork = true;
  return enter(P);
}
// Each standing desk's screens paint only while its work screens show and its center screen is in the camera's
// view (furniture.js makeTerminal and makeSide); called every frame
const frustum = new THREE.Frustum(), viewProj = new THREE.Matrix4();
export function tickScreens(t, camera) {
  camera.updateMatrixWorld(); viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(viewProj);
  for (const D of DESKS) {
    const T = D.term;
    if (!T || !D.shown) continue;
    const seen = D.screens[1].material === T.mat && frustum.intersectsObject(D.screens[1]);
    T.tick(t, seen);
    if (D.side) for (const S of D.side) S.tick(t, seen);
  }
}
// a figure leaves the floor, and its desk with it
export function removePerson(P) {
  if (occupant[P.spot] === P) occupant[P.spot] = null;
  const D = P.desk;
  if (D) {
    setScreens(P, false); D.owner = null; hideDesk(D);
    if (D.live != null) { // a live seat's three screens are the session's own: free them and stop repainting them; a roster desk keeps its set
      if (D.workMats) { for (const m of D.workMats) { m.map.dispose(); m.dispose(); } D.workMats = D.term = null; }
      if (D.side) { for (const S of D.side) { const si = sideScreens.indexOf(S); if (si >= 0) sideScreens.splice(si, 1); } D.side = null; }
      const ti = terminals.indexOf(P.term); if (ti >= 0) { terminals.splice(ti, 1); P.term.gone = true; } // a screenshot on its way is dropped
    }
  }
  for (let i = pickables.length - 1; i >= 0; i--) if (pickables[i].userData.root === P.root) pickables.splice(i, 1); // and stop a click where it stood from picking it
  const bones = new Set(); P.root.traverse(o => { if (o.isSkinnedMesh) { if (!o.userData.shared) o.geometry.dispose(); bones.add(o.skeleton); } }); bones.forEach(b => b.dispose()); // its baked meshes (person.js) are its own, its model's are shared (people.js)
  undress(P);
  scene.remove(P.root);
  const pi = persons.indexOf(P); if (pi >= 0) persons.splice(pi, 1);
  const ni = npcs.indexOf(P); if (ni >= 0) npcs.splice(ni, 1);
}
