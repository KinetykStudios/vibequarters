// Typing at a desk. Both hands sit on the keys: each frame the palms are placed on the desk's keyboard and the
// arms solved to reach them from the figure's own shoulders and bones, so a figure of any scale at either desk size types
// on its own keyboard, forearms over the desk's edge rather than through it. Each hand dips .5 to 1 cm at 6 to 10 Hz,
// out of step with the other. Now and then (every 15 to 30 s, 1 to 2 s long, staggered by the figure's phase) the mouse
// hand goes to the mouse and back, the hands rest while the head reads the screens left to right, or the figure leans
// back. Reduced motion: the hands stay still on the keys and nothing else happens.
import * as THREE from 'three';
import { REDUCED, lerp, smooth } from './core.js';

export const TYPE = {
  lean: .06, // the torso's lean while typing (the desk seat's own is .12): upright enough for the forearms to clear the edge
  leanBack: .12, // a lean back takes this much off
  palmX: .11, // each palm's center this far either side of the keyboard's center
  gap: .024, // the hand's lowest point over the keycaps, before a dip
  dip: [.005, .01], hz: [6.8, 8.6], hzStep: .6, // a dip's depth, and its rate (the right hand's .6 Hz faster)
  pitch: .21, turn: .26, // the fingers pitched down and turned in
  elbow: 1.13, // the elbow's side: out from straight down, across the figure (radians)
  rig: { lean: .2, reach: .56, more: 2.6, elbow: .62, gap: .016 }, // the same for a figure that wears a model (people.js), whose arms are longer and whose elbows bend like a person's; arms shorter than reach lean it further, more per meter
  first: [4, 22], every: [15, 30], dur: [1, 2], ramp: .3, // the events: the first, start to start, how long, the ramp in and out
};
const KINDS = ['mouse', 'read', 'lean'];
const hash = (a, b) => { const x = Math.sin(a * 91.345 + b * 47.853) * 43758.5453; return x - Math.floor(x); };
const span = ([a, b], k) => a + (b - a) * k;
function nextEvent(P, k, from) {
  const h = (i) => hash(P.phase + k * 1.618, i);
  return { k, start: from + span(k ? TYPE.every : TYPE.first, h(1)), dur: span(TYPE.dur, h(2)), kind: KINDS[Math.min(2, Math.floor(h(3) * 3))] };
}
// the figure's typing state at t (the room's clock): its mode ('type', or the event's kind), the event's envelope (0 to
// 1, in and out over TYPE.ramp) and its progress (0 to 1). P.typeMode is what the checks read.
export function typeState(P, t) {
  const st = P.typeSt || (P.typeSt = { mode: 'type', env: 0, u: 0 });
  if (REDUCED) { st.mode = P.typeMode = 'type'; st.env = st.u = 0; return st; }
  let E = P.typeEv || (P.typeEv = nextEvent(P, 0, t));
  while (t >= E.start + E.dur) E = P.typeEv = nextEvent(P, E.k + 1, E.start);
  const on = t >= E.start;
  st.mode = P.typeMode = on ? E.kind : 'type';
  st.u = on ? (t - E.start) / E.dur : 0;
  st.env = on ? smooth(Math.min(t - E.start, E.start + E.dur - t) / TYPE.ramp) : 0;
  return st;
}
export function endTyping(P) { P.typeEv = null; P.typeMode = null; }

const M = new THREE.Matrix4(), R3 = new THREE.Matrix3(), B = new THREE.Matrix4(), EU = new THREE.Euler(), UP = new THREE.Vector3(0, 1, 0), XA = new THREE.Vector3(1, 0, 0);
const Pd = new THREE.Vector3(), Xd = new THREE.Vector3(), Yd = new THREE.Vector3(), Zd = new THREE.Vector3();
const Xt = new THREE.Vector3(), Yt = new THREE.Vector3(), Zt = new THREE.Vector3(), Wt = new THREE.Vector3(), Ht = new THREE.Vector3();
const n = new THREE.Vector3(), p = new THREE.Vector3(), E = new THREE.Vector3(), Xs = new THREE.Vector3(), Ys = new THREE.Vector3(), Zs = new THREE.Vector3(), F = new THREE.Vector3();
const qS = new THREE.Quaternion(), qE = new THREE.Quaternion(), qH = new THREE.Quaternion();
const ID = new THREE.Quaternion();

// Both arms onto the desk's keys, blended in by w (1 seated at the desk, 0 standing): writes the arm arrays (as setArm
// takes them) and turns each hand flat over the keys. Call it once the stance (seat, lean, sway) is set for the frame.
export function typeArms(P, D, t, w, L, R, st) {
  P.top.updateWorldMatrix(true, false);
  M.copy(P.top.matrixWorld).invert().multiply(D.g.matrixWorld); // desk coordinates to the shoulders' frame
  R3.setFromMatrix4(M);
  const mouseArm = -D.mouse.side;
  for (const s of [1, -1]) solve(P, D, s, t, w, s === 1 ? L : R, st, st.mode === 'mouse' && s === mouseArm);
  P.handsTurned = true;
}
export function untype(P) {
  if (!P.handsTurned) return;
  P.arms[1].hand.quaternion.identity(); P.arms[-1].hand.quaternion.identity(); P.handsTurned = false;
}

function solve(P, D, s, t, w, A, st, onMouse) {
  const arm = P.arms[s], mesh = arm.palm, kb = D.keyboard, ph = P.phase, sg = -s; // the left arm (s 1) is at desk -x
  // the palm's center on the keys, in desk coordinates
  let x = kb.x + sg * TYPE.palmX, z = kb.z, low = kb.top + (P.rig ? TYPE.rig.gap : TYPE.gap), turn = TYPE.turn, dip = 0;
  if (!REDUCED) {
    x += .01 * Math.sin(t * .37 + ph + s); z += .008 * Math.sin(t * .29 + ph * 2 + s);
    const hz = span(TYPE.hz, hash(ph, 5)) + (s < 0 ? TYPE.hzStep : 0), amp = lerp(TYPE.dip[0], TYPE.dip[1], .5 + .5 * Math.sin(t * 1.3 + ph + s * 2));
    dip = amp * (.5 - .5 * Math.cos(2 * Math.PI * hz * t + ph * 3 + (s < 0 ? Math.PI : 0)));
  }
  const ev = st.env;
  if (st.mode === 'read') dip *= 1 - ev; // the hands rest on the keys while the head reads
  if (st.mode === 'lean') { z += .05 * ev; dip *= 1 - .5 * ev; } // leaning back, the hands slide toward the keyboard's front
  if (onMouse) { // over to the mouse in an arc, a little movement there, and back
    const m = D.mouse;
    x = lerp(x, m.x + .008 * Math.sin(t * 2.3 + ph), ev); z = lerp(z, m.z + .01 + .006 * Math.sin(t * 1.7 + ph), ev);
    low = lerp(low, m.top - .012, ev) + .03 * Math.sin(Math.PI * ev); turn *= 1 - ev; dip *= 1 - ev;
  }
  // the hand's frame in desk coordinates: fingers (its -y) forward, pitched down and turned in; its back (+z) up
  const c = Math.cos(TYPE.pitch);
  Yd.set(-s * Math.sin(turn) * c, Math.sin(TYPE.pitch), Math.cos(turn) * c);
  Zd.copy(UP).addScaledVector(Yd, -Yd.y).normalize(); Xd.crossVectors(Yd, Zd);
  // the palm's center sits its own half height over its lowest point (the hand is a scaled sphere)
  const r = mesh.geometry.parameters.radius * P.root.scale.x, sc = mesh.scale;
  Pd.set(x, low - dip + r * Math.hypot(sc.y * Yd.y, sc.z * Zd.y), z);
  // into the shoulders' frame, where the bones have their own lengths
  Wt.copy(Pd).applyMatrix4(M);
  Xt.copy(Xd).applyMatrix3(R3).normalize(); Yt.copy(Yd).applyMatrix3(R3).normalize(); Zt.copy(Zd).applyMatrix3(R3).normalize();
  const o = mesh.position; Wt.addScaledVector(Xt, -o.x).addScaledVector(Yt, -o.y).addScaledVector(Zt, -o.z); // the wrist
  const S = arm.sh.position, u = -arm.el.position.y, f = -arm.hand.position.y;
  n.subVectors(Wt, S); const d = Math.min(Math.max(n.length(), Math.abs(u - f) + 1e-3), (u + f) * .999); n.normalize();
  const a = (u * u - f * f + d * d) / (2 * d), h = Math.sqrt(Math.max(0, u * u - a * a));
  const side = P.rig ? TYPE.rig.elbow : TYPE.elbow;
  Ht.set(sg * Math.sin(side), -Math.cos(side), 0).applyMatrix3(R3).normalize(); // the elbow's side
  p.copy(Ht).addScaledVector(n, -Ht.dot(n)).normalize();
  E.copy(S).addScaledVector(n, a).addScaledVector(p, h);
  // the shoulder's frame: its -y down the upper arm; its z in the plane of the two bones, so the elbow bends about its x
  Ys.subVectors(S, E).normalize();
  F.copy(S).addScaledVector(n, d).sub(E).normalize(); // the forearm
  Zs.copy(F).addScaledVector(Ys, -F.dot(Ys));
  if (Zs.lengthSq() < 1e-10) Zs.copy(p).negate().addScaledVector(Ys, p.dot(Ys));
  Zs.normalize(); Xs.crossVectors(Ys, Zs);
  const e = Math.atan2(-F.dot(Zs), -F.dot(Ys));
  B.makeBasis(Xs, Ys, Zs); EU.setFromRotationMatrix(B, 'YXZ');
  A[0] = lerp(A[0], EU.x, w); A[1] = lerp(A[1], -s * EU.y, w); A[2] = lerp(A[2], s * EU.z, w); A[3] = lerp(A[3], e, w);
  // the hand: its frame, relative to the forearm's
  qS.setFromRotationMatrix(B); qE.setFromAxisAngle(XA, e); qS.multiply(qE).invert();
  B.makeBasis(Xt, Yt, Zt); qH.setFromRotationMatrix(B);
  arm.hand.quaternion.copy(ID).slerp(qS.multiply(qH), w);
}
