// The people: rigged models (assets/people, from Microsoft's Rocketbox library, MIT) that ride the built-in figures.
// A built-in figure (person.js) still does everything it did: its joints are posed each frame, its hidden parts are what
// a click hits. dress() takes its model's own bone lengths onto those joints, so a hand that is solved onto the keys
// (typing.js) lands there, and wear() turns the model's bones with the joints. A model that is missing, or fails on the
// way in, leaves the built-in figure showing.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { V3, warmPrograms } from './core.js';
import { HIP_Y } from './person.js';
import { TYPE } from './typing.js';

// each model and the words for its look
export const PEOPLE = {
  'charcoal-suit': 'Charcoal suit, white shirt, green tie.',
  'blue-shirt': 'Light blue shirt, sleeves rolled, dark trousers.',
  'shirt-tie': 'White shirt, striped tie, jeans.',
  pantsuit: 'Black pantsuit, white blouse.',
  'tan-blazer': 'Tan wrap cardigan, dark jeans, boots.',
  'white-shirt': 'White shirt, black trousers.',
  'purple-tie': 'Dark check suit, purple shirt, black tie.',
  'pink-blazer': 'Pink blazer, blue shirt, jeans.',
  denim: 'Denim jacket, white top, light jeans.',
  sweater: 'Beige V-neck sweater, dark trousers.',
  'gray-suit': 'Pinstripe suit.',
  'navy-suit': 'Navy suit, white shirt, navy tie.',
  'pink-shirt': 'Pink shirt, jeans.',
};
const KEYS = Object.keys(PEOPLE), worn = new Map(); // how many figures in the room wear each
const hashOf = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
// the model the config names; else one by the figure's id, or the next one nobody in the room wears
function modelOf(agent) {
  if (Object.hasOwn(PEOPLE, agent.avatar?.model ?? '')) return agent.avatar.model;
  const from = hashOf(String(agent.id)) % KEYS.length, order = KEYS.map((_, i) => KEYS[(from + i) % KEYS.length]);
  return order.find((k) => !worn.get(k)) || order[0];
}

const loaded = new Map();
function load(key) {
  if (!loaded.has(key)) loaded.set(key, new GLTFLoader().loadAsync(`/assets/people/${key}.glb`).then(async (g) => {
    g.scene.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; o.userData.shared = true; } });
    // compiled and linked before it joins the scene: drawn uncompiled, its first frame would wait on the links
    await warmPrograms(g.scene);
    return g.scene;
  }).catch((e) => { loaded.delete(key); throw e; })); // the next figure tries again
  return loaded.get(key);
}

const DOWN = new V3(0, -1, 0), B = (n) => 'Bip01_' + n;
// the bones that follow a joint; every other bone keeps its place on its parent
const CHAIN = ['Pelvis', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', ...['L', 'R'].flatMap((s) => [`${s}_Clavicle`, `${s}_UpperArm`, `${s}_Forearm`, `${s}_Hand`, `${s}_Thigh`, `${s}_Calf`])];
const HEAD_SHARE = .4; // of the head's turn, the neck's part
const CURL = [.5, .75, .45]; // a hand that holds something: each finger joint's bend

export async function dress(P) {
  const key = modelOf(P.agent); P.model = key; worn.set(key, (worn.get(key) || 0) + 1);
  try {
    const m = clone(await load(key));
    if (P.gone) return;
    const bones = {}; m.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    const at = (n) => bones[B(n)].getWorldPosition(new V3()), turn = (n) => bones[B(n)].getWorldQuaternion(new THREE.Quaternion());
    // the legs hang from the pelvis and the arms from the chest, so a lean or a look moves neither
    m.updateMatrixWorld(true);
    for (const s of ['L', 'R']) { bones[B('Pelvis')].attach(bones[B(s + '_Thigh')]); bones[B('Spine2')].attach(bones[B(s + '_Clavicle')]); }
    const size = HIP_Y / at('L_Thigh').y; m.scale.multiplyScalar(size); m.updateMatrixWorld(true);
    const R = { bones, chain: [], rest: {}, hands: {}, turnW: 0, curlW: 0 };
    for (const n of CHAIN) {
      const b = bones[B(n)], q0 = turn(n), next = { UpperArm: 'Forearm', Forearm: 'Hand', Thigh: 'Calf', Calf: 'Foot' }[n.slice(2)];
      const r = { b, n, parent: b.parent.name, q: new THREE.Quaternion(), local: b.quaternion.clone(), zero: q0.clone() };
      // a limb's zero is the limb hanging straight down, as the figure's joints have it
      if (next) r.zero.premultiply(new THREE.Quaternion().setFromUnitVectors(at(n.slice(0, 2) + next).sub(at(n)).normalize(), DOWN));
      R.rest[b.name] = r; R.chain.push(r);
    }
    for (const [s, n] of [[1, 'L'], [-1, 'R']]) {
      const wrist = at(n + '_Hand'), fingers = at(n + '_Finger2').sub(wrist).normalize(), across = at(n + '_Finger1').sub(at(n + '_Finger4')).normalize();
      const back = new V3().crossVectors(fingers, across).normalize(); if (back.x * s * .6 + back.y < 0) back.negate();
      const Y = fingers.clone().negate(), Z = back.clone().addScaledVector(Y, -back.dot(Y)).normalize(), X = new V3().crossVectors(Y, Z);
      const flat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z)).invert().multiply(turn(n + '_Hand'));
      // at rest the palm faces the thigh; over the keys the figure's hand has its back to +z (typing.js)
      const rest = R.rest[B(n + '_Hand')].zero.premultiply(new THREE.Quaternion().setFromUnitVectors(fingers, DOWN));
      const curls = [];
      if (s === -1) for (const f of [1, 2, 3, 4]) ['', '1', '2'].forEach((j, i) => {
        const b = bones[B(`${n}_Finger${f}${j}`)]; if (!b) return;
        const axis = across.clone().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()).invert());
        const probe = fingers.clone().applyAxisAngle(across, .5); if (probe.dot(back) > 0) axis.negate(); // toward the palm
        curls.push({ b, local: b.quaternion.clone(), axis, k: CURL[i] });
      });
      R.hands[n] = { flat, rest, curls };
      const arm = P.arms[s], sh = at(n + '_UpperArm'), el = at(n + '_Forearm');
      arm.sh.position.set(sh.x, sh.y, sh.z); arm.el.position.y = -sh.distanceTo(el); arm.hand.position.y = -el.distanceTo(wrist);
      const hip = at(n + '_Thigh'); P.legs[s].hip.position.set(hip.x, HIP_Y, hip.z);
    }
    const L = P.arms[1]; R.lean = TYPE.rig.lean + Math.max(0, TYPE.rig.reach + L.el.position.y + L.hand.position.y) * TYPE.rig.more; // its lean at a keyboard
    const pelvis = bones[B('Pelvis')];
    R.pelvis = at('Pelvis'); R.into = pelvis.parent.matrixWorld.clone().invert();
    R.up = {}; let p = pelvis.parent; R.up[p.name] = p.getWorldQuaternion(new THREE.Quaternion());
    m.traverse((o) => { if (!o.isSkinnedMesh) return; const inv = o.matrixWorld.clone().invert(); o.boundingSphere = new THREE.Sphere(new V3(0, .9, .1).applyMatrix4(inv), 1.35 * inv.getMaxScaleOnAxis()); });
    P.body.traverse((o) => { if (o.isSkinnedMesh) o.visible = false; });
    P.jackL = P.jackS = null; // the built-in jacket's two cuts stay hidden too
    P.root.add(m); P.rig = R;
    P.agent.look = PEOPLE[key]; P.agent.model = key; // the panel names what it wears (stage.js)
  } catch (e) { console.warn('VibeQuarters: a person model failed to load, keeping the built-in figure', e); }
}

// a figure left the room: its model is free for the next
export function undress(P) { P.gone = true; if (P.model) worn.set(P.model, worn.get(P.model) - 1); }

const q = { body: new THREE.Quaternion(), upper: new THREE.Quaternion(), head: new THREE.Quaternion(), neck: new THREE.Quaternion(), sh: new THREE.Quaternion(), el: new THREE.Quaternion(), hand: new THREE.Quaternion(), hip: new THREE.Quaternion(), knee: new THREE.Quaternion() };
const T = new THREE.Quaternion(), U = new THREE.Quaternion(), ax = new V3(), pos = new V3();
// the model's bones turned with the figure's joints: once per frame, after the figure is posed (stage.js)
export function wear(P, dt) {
  const R = P.rig;
  if (!R) return;
  R.turnW += ((P.handsTurned ? 1 : 0) - R.turnW) * Math.min(1, dt * 6);
  R.curlW += ((P.pose.prop ? 1 : 0) - R.curlW) * Math.min(1, dt * 6);
  q.body.copy(P.body.quaternion); q.upper.copy(q.body).multiply(P.upper.quaternion); q.head.copy(q.upper).multiply(P.head.quaternion); q.neck.copy(q.upper).slerp(q.head, HEAD_SHARE);
  const set = {
    Pelvis: q.body, Spine: q.upper, Neck: q.neck, Head: q.head, L_Clavicle: q.upper, R_Clavicle: q.upper,
  };
  for (const r of R.chain) {
    const parent = R.rest[r.parent]?.q || R.up[r.parent], n = r.n, d = set[n];
    if (d) r.q.copy(d).multiply(r.zero);
    else if (n[1] === '_') {
      const s = n[0] === 'L' ? 1 : -1, limb = n.slice(2), arm = P.arms[s], leg = P.legs[s];
      if (limb === 'UpperArm') r.q.copy(q.sh.copy(q.upper).multiply(arm.sh.quaternion)).multiply(r.zero);
      else if (limb === 'Forearm') {
        q.el.copy(q.upper).multiply(arm.sh.quaternion).multiply(arm.el.quaternion); r.q.copy(q.el).multiply(r.zero);
        // half of the hand's twist is the forearm's, so the wrist does not wring
        const H = R.hands[n[0]];
        T.copy(H.rest).slerp(H.flat, R.turnW); T.premultiply(U.copy(q.el).multiply(arm.hand.quaternion)); // the hand's turn
        U.copy(q.el).multiply(H.rest).invert(); U.premultiply(T);
        ax.copy(DOWN).applyQuaternion(q.el);
        let a = 2 * Math.atan2(U.x * ax.x + U.y * ax.y + U.z * ax.z, U.w); if (a > Math.PI) a -= 2 * Math.PI; if (a < -Math.PI) a += 2 * Math.PI;
        r.q.premultiply(U.setFromAxisAngle(ax, a / 2));
        H.q = (H.q || new THREE.Quaternion()).copy(T);
      } else if (limb === 'Hand') { r.q.copy(R.hands[n[0]].q); r.b.scale.setScalar(P.pose.hideHands ? 1e-3 : 1); }
      else if (limb === 'Thigh') r.q.copy(q.body).multiply(leg.hip.quaternion).multiply(r.zero);
      else if (limb === 'Calf') r.q.copy(q.body).multiply(leg.hip.quaternion).multiply(leg.knee.quaternion).multiply(r.zero);
    } else { r.q.copy(parent).multiply(r.local); continue; } // the rest of the spine, carried along
    r.b.quaternion.copy(parent).invert().multiply(r.q);
  }
  pos.copy(R.pelvis).applyQuaternion(q.body).add(P.body.position); R.rest[B('Pelvis')].b.position.copy(pos.applyMatrix4(R.into));
  for (const c of R.hands.R.curls) c.b.quaternion.copy(c.local).multiply(T.setFromAxisAngle(c.axis, c.k * R.curlW));
}
