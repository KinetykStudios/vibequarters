// The boss: the built-in figure and its walk between its desk's nose and the throne (bossGo is in stage.js).
import { CONFIG } from './data.js';
import { V3, smooth, wrapAngle, scene } from './core.js';
import { SEATS, buildPerson, setPose } from './person.js';
import { dress } from './people.js';
import { DAIS_H, JET_Z, NOSE } from './furniture.js';
import { BOSS_POS, BOSS_WALK, persons } from './rooms.js';
import { walkAlong } from './life.js';

export const boss = buildPerson(CONFIG.owner); setPose(boss, 'boss');
boss.root.position.copy(BOSS_POS); boss.root.scale.setScalar(1.03); scene.add(boss.root); persons.push(boss); dress(boss);
boss.where = 'Standing on your desk';
Object.assign(boss, { state: 'stage', goal: 'stage', yaw: 0, sitW: 0, walkW: 0, stride: 0, seat: null, fixedLook: new V3() });
export const THRONE_SEAT = new V3(0, DAIS_H, JET_Z - 1.36), THRONE_STAND = new V3(0, DAIS_H, JET_Z - .92), DESK_GAZE = new V3(0, 1.3, 6);
// down off the nose to the dais in front of it, round the right wing and in behind the desk to the throne; back the
// same way
const FRONT = JET_Z + NOSE[1] + .3;
export const TO_DESK = [[0, FRONT, DAIS_H], [2.65, FRONT, DAIS_H], [2.65, JET_Z - .92, DAIS_H], [0, JET_Z - .92, DAIS_H]];
export const TO_STAGE = [[2.65, JET_Z - .92, DAIS_H], [2.65, FRONT, DAIS_H], [0, FRONT, DAIS_H], [BOSS_POS.x, BOSS_POS.z, BOSS_POS.y]];
export function bossUpdate(dt) {
  const B = boss;
  if (B.state === 'rise') {
    B.sitW = Math.max(0, B.sitW - dt * 1.3); B.root.position.lerpVectors(THRONE_STAND, THRONE_SEAT, smooth(B.sitW));
    if (!B.sitW) { B.seat = null; B.path = TO_STAGE; B.pi = 0; B.segLen = 0; B.state = 'walk'; setPose(B, 'walk'); }
  } else if (B.state === 'walk') { if (walkAlong(B, dt, BOSS_WALK)) B.state = 'turn'; }
  else if (B.state === 'turn') {
    const d = wrapAngle(-B.yaw); B.yaw += d * Math.min(1, dt * 6);
    if (Math.abs(d) < .03) {
      B.yaw = 0;
      if (B.goal === 'desk') { B.state = 'sit'; B.seat = SEATS.throne; setPose(B, 'throne'); }
      else { B.state = 'stage'; setPose(B, 'boss'); B.where = 'Standing on your desk'; }
    }
  } else if (B.state === 'sit') {
    B.sitW = Math.min(1, B.sitW + dt * 1.3); B.root.position.lerpVectors(THRONE_STAND, THRONE_SEAT, smooth(B.sitW));
    if (B.sitW === 1) { B.state = 'desk'; B.where = 'At your desk'; }
  }
  B.walkW = B.state === 'walk' ? Math.min(1, B.walkW + dt * 4) : Math.max(0, B.walkW - dt * 5);
  B.root.rotation.y = B.yaw;
  if (B.state === 'walk') B.fixedLook.set(B.root.position.x + Math.sin(B.yaw) * 3, 1.5 + B.root.position.y, B.root.position.z + Math.cos(B.yaw) * 3);
}

