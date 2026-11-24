// Lights, name tags, the selection panel, picking, camera views, the intro, the rally and the animation loop, plus
// npcUpdate and bossGo (below).
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { container, hooks } from './data.js';
import {
  REDUCED, V3, lerp, clamp, ease, smooth, wrapAngle, rand, renderer, labels, scene, camera, controls, composer, bloom, output, warmPrograms,
  canvasTex, add, now, sleptFor
} from './core.js';
import { POSES, REACH, SIP, HAND_UP, SEATS, pickables, pickParts, setPose } from './person.js';
import { wear } from './people.js';
import { FLOOR, ceiling, ticker, setRally } from './building.js';
import { ROOM } from './plan.js';
import { JET_Z, jet, strobe, throne, OFF_MAT } from './furniture.js';
import { persons, deskSample, BOSS_POS } from './rooms.js';
import { SPOTS, walkAlong, occupant, npcs, settle, go, pickSpot, sendTo, tickScreens } from './life.js';
import { boss, DESK_GAZE, TO_DESK, bossUpdate } from './boss.js';
import { tickLinks } from './links.js';
import { shown, streaming, setStreaming, onStreaming } from '../streamer.js';
import { usd, clock } from '../format.js';
import { CTX, CACHE } from '../warn.js';
import { beatLines } from './beat.js';
import { TYPE, typeState, endTyping, typeArms, untype } from './typing.js';
import { handUp } from './panel-data.js';

// ---------- npcUpdate and bossGo, from life.js and boss.js ----------
// npcUpdate turns an idle agent toward the boss and bossGo flies the camera: the one reads boss.js,
// the other calls flyTo() here. An import in that direction closes a cycle, and an import always
// evaluates before its importer, so boss.js would build before life.js and stage.js before boss.js.
// Both live here instead.
export function npcUpdate(P, t, dt, r) {
  const S = SPOTS[P.spot];
  if (!r) {
    // a desk spot never times out, setWorking() sends them on
    if (P.state === 'do') { if ((P.timer -= dt) <= 0) { if (S.seat) P.state = 'rise'; else sendTo(P, pickSpot(P), t); } }
    else if (P.state === 'rise') { P.sitW = Math.max(0, P.sitW - dt * 1.5); if (!P.sitW) { const k = P.next && (SPOTS[P.next].desk || !occupant[P.next]) ? P.next : pickSpot(P); P.next = null; go(P, k, t); } } // its desk, or a spot still free
    else if (P.state === 'walk') { if (walkAlong(P, dt, 1.2)) P.state = 'turn'; }
    else if (P.state === 'turn') {
      const d = wrapAngle(S.yaw - P.yaw); P.yaw += d * Math.min(1, dt * 6);
      if (Math.abs(d) < .03) {
        if (P.next) { const k = SPOTS[P.next].desk || !occupant[P.next] ? P.next : pickSpot(P); P.next = null; go(P, k, t); return; } // sent on while walking: leave from here, to its desk or a spot still free
        P.yaw = S.yaw; setPose(P, S.act); if (S.seat) { P.seat = SEATS[S.seat]; P.state = 'sit'; P.where = S.where; } else settle(P, t);
      }
    }
    else if (P.state === 'sit') { P.sitW = Math.min(1, P.sitW + dt * 1.5); if (P.sitW === 1) settle(P, t); }
  }
  P.walkW = P.state === 'walk' && !r ? Math.min(1, P.walkW + dt * 4) : Math.max(0, P.walkW - dt * 5);
  if (S.seat && P.seat) P.root.position.lerpVectors(S.standV, S.posV, smooth(P.sitW) * (1 - smooth(r * 1.4)));
  P.root.rotation.y = P.yaw + wrapAngle(Math.atan2(boss.root.position.x - P.root.position.x, boss.root.position.z - P.root.position.z) - P.yaw) * smooth(r * 1.4);
  const mate = S.with && occupant[S.with];
  P.mate = P.state === 'do' && mate && mate.state === 'do' ? mate : null;
  if (P.mate) P.gazeV = P.mate.headPos;
  else if (P.state === 'do' && S.lookAt) P.gazeV = P.fixedLook.set(...S.lookAt);
  else P.gazeV = P.fixedLook.set(P.root.position.x + Math.sin(P.yaw) * 3, 1.4, P.root.position.z + Math.cos(P.yaw) * 3);
}

// the boss moves: click the boss's desk to step down and sit at it, click it again to climb back up onto its nose
export function bossGo(where) {
  if (boss.state !== 'stage' && boss.state !== 'desk') return; // finish the current move first
  if (boss.state === where) return;
  boss.goal = where; boss.where = 'On the move';
  if (where === 'desk') { boss.path = TO_DESK; boss.pi = 0; boss.segLen = 0; boss.state = 'walk'; setPose(boss, 'walk'); }
  else boss.state = 'rise';
  flyTo(where === 'desk' ? 'desk' : 'floor', 2.2);
}

// ---------- lights ----------
scene.add(new THREE.HemisphereLight('#b9c0d6', '#3a2a1c', 1.05));
export const spot = new THREE.SpotLight('#ffdcaa', 60, 0, .36, .7, 2);
spot.position.set(0, FLOOR.h - .1, BOSS_POS.z + .7); spot.target.position.set(0, BOSS_POS.y + .82, BOSS_POS.z); scene.add(spot, spot.target);
spot.castShadow = true; spot.shadow.mapSize.set(2048, 2048); spot.shadow.bias = -.0004; spot.shadow.normalBias = .02; spot.shadow.camera.near = 1; spot.shadow.camera.far = 14;
export const coneTex = canvasTex(4, 256, (g, w, h) => { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#000'); gr.addColorStop(1, '#fff'); g.fillStyle = gr; g.fillRect(0, 0, w, h); });
export const coneH = FLOOR.h - .1 - BOSS_POS.y;
add(new THREE.CylinderGeometry(.08, Math.tan(.36) * coneH, coneH, 48, 1, true), new THREE.MeshBasicMaterial({ color: '#ffd9a0', alphaMap: coneTex, transparent: true, opacity: .012, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), [0, BOSS_POS.y + coneH / 2, BOSS_POS.z + .35], null, { receive: false });
export const moon = new THREE.DirectionalLight('#86a6ff', .18); moon.position.set(8, 9, -4); scene.add(moon);
const fill = new THREE.DirectionalLight('#ffe6c8', .75); fill.position.set(0, 6, -9); scene.add(fill); // from the boss's end, onto the faces at the desks
export const warm = new THREE.PointLight('#ffcf99', 18, 14, 2); warm.position.set(0, 3.4, -6.2); scene.add(warm);
export const deskSpot = new THREE.SpotLight('#ffd6a0', 18, 9, .5, .6, 2); deskSpot.position.set(0, FLOOR.h - .1, JET_Z - .2); deskSpot.target.position.set(0, .8, JET_Z); scene.add(deskSpot, deskSpot.target);

// ---------- labels ----------
export const tagByAgent = new Map();
export const dotClass = a => 'dot ' + (a.id === 'owner' ? 'd-boss' : a.off ? 'd-off' : a.inSession ? 'd-work' : 'd-idle');
export function addTag(P) {
  const wrap = document.createElement('div'); wrap.className = 'tagw';
  const b = document.createElement('button'); b.className = 'tag'; b.type = 'button';
  const dot = document.createElement('i'); dot.className = dotClass(P.agent);
  const nm = document.createElement('span'); nm.textContent = shown(P.agent.name); nm.classList.toggle('masked', streaming());
  b.append(dot, nm);
  // over the tag while the figure waits on the owner (refreshTag), out of the tag's flow; a click opens what it waits
  // on (select)
  const ping = document.createElement('button'); ping.className = 'ping'; ping.type = 'button'; ping.hidden = true;
  const bub = document.createElement('span'); bub.className = 'bub'; bub.textContent = '!';
  const pl = document.createElement('span'); pl.className = 'pl'; pl.textContent = 'Needs you';
  ping.append(bub, pl); ping.addEventListener('click', e => { e.stopPropagation(); select(P.agent); });
  wrap.append(ping, b);
  if (P.agent.helper) { // a helper also names the session it works for, masked like any session name
    const fs = document.createElement('span'); fs.className = 'for'; fs.textContent = shown(P.agent.forSession); fs.classList.toggle('masked', streaming());
    const word = document.createElement('em'); word.className = 'of'; word.textContent = 'for'; // its own box: a flex tag drops a bare text node's spaces
    b.append(word, fs);
  }
  b.addEventListener('click', e => { e.stopPropagation(); select(P.agent); });
  const bd = document.createElement('div'); bd.className = 'bdg'; bd.hidden = true; wrap.append(bd);
  const o = new CSS2DObject(wrap); o.position.set(0, 2.08, 0); P.root.add(o); P.tag = o;
  tagByAgent.set(P.agent, b);
  drawBadge(b, P.agent.badge);
}
export function refreshTag(P) {
  const b = tagByAgent.get(P.agent);
  if (!b) return;
  b.querySelector('.dot').setAttribute('class', dotClass(P.agent));
  b.parentNode.querySelector('.ping').hidden = !P.handUp;
  drawBadge(b, P.agent.badge);
}
// A working session's tag carries a second line (lib/hq.js badgeOf): its plan's progress and finish time, its cost, how
// full its context is, its prompt cache, and a red flag once its last three tool calls failed or its last check did.
// Numbers and fixed words only, so Streamer leaves it; redrawn only when what it says changed.
function badgeParts(x) {
  if (!x) return [];
  const out = [];
  if (x.pct != null) out.push(['prog', x.finishAt ? 'done ' + clock(x.finishAt) : x.pct + '%', x.pct]);
  if (x.cost != null) out.push(['', usd(x.cost)]);
  // amber ('hot') past warn.js's first line, red ('bad') past its second
  if (x.ctx != null) out.push([x.ctx >= CTX[1] ? 'bad' : x.ctx >= CTX[0] ? 'hot' : '', 'ctx ' + x.ctx + '%']);
  if (x.cache === 'warm') out.push([x.cacheLeft <= CACHE[1] ? 'bad' : x.cacheLeft <= CACHE[0] ? 'hot' : 'warm', 'warm ' + Math.max(1, Math.round(x.cacheLeft / 60e3)) + 'm' + (x.warm ? ', kept' : '')]);
  else if (x.cache) out.push(['cold', 'cold']);
  if (x.failing) out.push(['flag', '3 fails in a row']);
  else if (x.check === 'fail') out.push(['flag', 'check failed']);
  else if (x.check === 'pass') out.push(['ok', 'checks pass']);
  return out;
}
function drawBadge(b, x) {
  const box = b.parentNode.querySelector('.bdg'), parts = badgeParts(x), key = JSON.stringify(parts);
  b.classList.toggle('fail', !!(x && x.failing));
  if (box.dataset.k === key) return;
  box.dataset.k = key; box.hidden = !parts.length;
  box.replaceChildren(...parts.map(([cls, text, pct]) => {
    const s = document.createElement('span'); s.className = cls;
    if (cls === 'prog') { const bar = document.createElement('i'), fill = document.createElement('b'); fill.style.width = pct + '%'; bar.append(fill); s.append(bar, ' '); }
    s.append(text);
    return s;
  }));
}
export function deselectIf(P) { if (selected === P.agent) deselect(); P.tag && P.tag.removeFromParent(); tagByAgent.delete(P.agent); }
for (const P of persons) addTag(P);

// ---------- selection panel ----------
container.append(document.getElementById('floor-ui').content.cloneNode(true));
export const $ = id => container.querySelector('#' + id);
export const panel = $('panel');
export const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.7, .8), transparent: true, opacity: .9 });
export const ring = add(new THREE.RingGeometry(.42, .46, 64), ringMat, [0, .01, 0], [-Math.PI / 2, 0, 0], { receive: false }); ring.visible = false;
export let selected = null, shownWhere = '';
// a masked panel says "Working on a task": the task line is a name's worth of detail. An agent whose desk follows a
// heartbeat or a named session (it carries a status) shows its status word; its task has its own line (beatPanel)
function statusLine(agent) {
  if (agent.off) return 'Switched off';
  if (agent.status) return beatLines(agent, Date.now()).status;
  return agent.id === 'owner' ? 'The boss' : agent.inSession ? (agent.helper ? 'Working, helping a session' : agent.live ? 'Working, in a session' : agent.doing && !streaming() ? 'Working: ' + agent.doing : 'Working on a task') : 'Idle, no task';
}
// the panel is an aria-live region: text is set only when it changed, and the summary list rebuilt only when its
// lines or their mask changed, so a poll that changes nothing announces nothing
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
let sumKey = null; // the summary list as drawn (kept here, never in the document)
// a closed panel, or the block of an agent with no status, keeps none of the last one's text: Streamer never paints a
// real name, and text left in the document counts even when no one sees it
function clearBeat() { sumKey = null; $('p-task').textContent = ''; $('p-sum').replaceChildren(); $('p-upd').textContent = ''; }
// that agent's task, summary lines and last update, set as text only, the mask while streaming (beat.js)
function beatPanel(agent) {
  const box = $('p-beat'); box.hidden = !agent.status;
  if (box.hidden) return clearBeat();
  const L = beatLines(agent, Date.now()), key = JSON.stringify([L.summary, L.masked]);
  setText($('p-task'), L.task || 'No task line yet.'); $('p-task').classList.toggle('masked', L.masked && !!L.task);
  if (key !== sumKey) { sumKey = key; $('p-sum').replaceChildren(...L.summary.map(t => { const li = document.createElement('li'); li.textContent = t; li.classList.toggle('masked', L.masked); return li; })); }
  setText($('p-upd'), L.updated || ''); $('p-upd').hidden = !L.updated;
}
// a poll redraws the open panel of such an agent in place: its status, its dot and its blocks
export function refreshPanel() {
  if (!selected || !selected.status) return;
  $('p-dot').className = dotClass(selected); setText($('p-status'), statusLine(selected)); beatPanel(selected);
}
export function select(agent) {
  // a session opens its chat, in full screen too (the chat's centered modal shows inside it). A helper or agent that
  // waits on the owner opens the Needs you pop-up on what it waits on; with nothing open there, its own panel opens, as
  // for any figure
  if (agent.sessionId && hooks.openSession) { hooks.openSession(agent.sessionId); return; }
  if (hooks.openAsk && handUp(agent) && hooks.openAsk(agent.helper ? { id: agent.waiting[0] } : { figure: 'a:' + agent.id })) return;
  selected = agent;
  const P = persons.find(p => p.agent === agent);
  ring.visible = true; ring.position.set(P.root.position.x, P.root.position.y + .012, P.root.position.z);
  tagByAgent.forEach((b, a) => b.classList.toggle('sel', a === agent));
  $('p-dept').textContent = agent.dept;
  $('p-name').textContent = shown(agent.name); $('p-name').classList.toggle('masked', streaming());
  $('p-dot').className = dotClass(agent);
  $('p-status').textContent = statusLine(agent); beatPanel(agent);
  $('p-doing').textContent = shownWhere = P.where || '';
  $('p-move').hidden = agent.id !== 'owner'; syncMove();
  $('p-look').textContent = agent.look;
  const sw = $('p-sw'); sw.replaceChildren();
  const av = agent.avatar;
  // the swatches are the built-in figure's colors: a modeled one shows none
  if (!P.rig) [...new Set([av.jacket, av.vest, av.shirt, av.tie, av.pants].filter(Boolean))].forEach(c => { const s = document.createElement('span'); s.style.background = c; s.title = c; sw.append(s); });
  $('p-json').textContent = JSON.stringify(P.rig ? { model: P.model } : av, null, 2);
  $('p-note').textContent = agent.id === 'owner'
    ? 'Click your desk to step down and sit at it. Click it again to climb back up onto it. Your avatar lives in hq.config.json under owner.'
    : agent.helper ? 'A subagent a live session started, at a live desk while it runs. Its center screen names its latest tool call.'
    : agent.live ? 'A real Claude Code session. Its desk screens show its live tool calls.'
    : 'Red means idle: it wanders the office until it gets a task, then it turns green, sits at its desk and its screens show its work.';
  panel.classList.add('open');
}
// your own panel carries the move as a button too: works on a phone, where the desk may be out of the frame
export function syncMove() {
  const b = $('p-move'), atDesk = boss.goal === 'desk';
  b.textContent = atDesk ? 'Stand on your desk' : 'Sit at your desk';
  b.disabled = boss.state !== 'stage' && boss.state !== 'desk';
}
$('p-move').addEventListener('click', () => bossGo(boss.goal === 'desk' ? 'stage' : 'desk'));
export function deselect() { selected = null; ring.visible = false; tagByAgent.forEach(b => b.classList.remove('sel')); panel.classList.remove('open'); $('p-name').textContent = $('p-status').textContent = ''; clearBeat(); }
$('close').addEventListener('click', deselect);

addEventListener('keydown', e => { if (e.key === 'Escape') { if (container.classList.contains('expanded')) shrink(); deselect(); } });

// ---------- streamer mode and full screen
// Full screen and streamer mode are separate controls: going full screen or leaving it keeps streamer mode as it was.
// A browser cannot see a screen recorder, so the toggle covers a recording, full screen or not. Where the browser has
// no element full screen (an iPhone), the floor fills the window instead.
const streamBtn = $('streamer'), expandBtn = $('expand');
export function expanded() { return document.fullscreenElement === container || container.classList.contains('expanded'); }
function maskTag(b, agent) {
  const nm = b.querySelector('span'); nm.textContent = shown(agent.name); nm.classList.toggle('masked', streaming());
  const fs = b.querySelector('.for'); if (fs) { fs.textContent = shown(agent.forSession); fs.classList.toggle('masked', streaming()); }
}
// updates the open panel in place rather than through select(), so a Streamer toggle with a session selected does not
// pop its row open
function syncStreamer(on) {
  streamBtn.setAttribute('aria-pressed', String(on));
  tagByAgent.forEach(maskTag);
  $('p-name').classList.toggle('masked', on);
  if (selected) { $('p-name').textContent = shown(selected.name); $('p-status').textContent = statusLine(selected); beatPanel(selected); }
}
onStreaming(syncStreamer);
syncStreamer(streaming()); // still on after a reload in the middle of a recording
streamBtn.addEventListener('click', () => setStreaming(!streaming()));
function grow() { expandBtn.textContent = 'Exit full screen'; }
function shrink() { container.classList.remove('expanded'); expandBtn.textContent = 'Full screen'; }
function expandInPage() { container.classList.add('expanded'); grow(); }
expandBtn.addEventListener('click', () => {
  if (document.fullscreenElement === container) document.exitFullscreen();
  else if (container.classList.contains('expanded')) shrink();
  else if (container.requestFullscreen) container.requestFullscreen().catch(expandInPage);
  else expandInPage();
});
document.addEventListener('fullscreenchange', () => (document.fullscreenElement === container ? grow() : shrink()));

// ---------- picking ----------
export const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
export let downAt = null, hoverEvt = null, hovered = null;
// a person wins over the furniture behind it; the jet desk or throne moves the boss: standing, to sit; seated, back up
export function pick(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera); pickParts();
  const h = ray.intersectObjects(pickables, false)[0], f = ray.intersectObjects([jet, throne], true)[0];
  if (h && (!f || h.distance <= f.distance)) return { agent: h.object.userData.agent };
  if (f) return { go: boss.goal === 'desk' ? 'stage' : 'desk' };
  return null;
}
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt) return; const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]); downAt = null;
  if (moved > 6) return; const hit = pick(e);
  if (!hit) deselect(); else if (hit.agent) select(hit.agent); else bossGo(hit.go);
});
renderer.domElement.addEventListener('pointermove', e => { hoverEvt = e; });

// ---------- camera views ----------
export const VIEWS = {
  boss: { pos: [-.6, 5.3, -10.3], target: [-.2, .3, 5.8] }, // over the boss on the desk's nose, down the aisle: the desk below, both sides and every row's sign in frame from a 1.55 window
  floor: { pos: [2.2, 1.9, .4], target: [-.6, 2.0, -6.4] }, // from the floor, a step off the aisle: the boss on the desk, its screen clear at one side
  agents: { pos: [-1.5, 4.6, .8], target: [7.6, .4, 9.5] }, // from the aisle over the agents' rows on the left
  sessions: { pos: [1.5, 4.6, .8], target: [-7.6, .4, 7.5] }, // and over the sessions' rows on the right
  top: { pos: [0, 42, 4.3], target: [0, 0, 4.25] }, // high enough for the whole room, back wall to front glass
  desk: { pos: [5.5, 2.8, -1.2], target: [-.3, 1.1, -5.0] }, // frames you on your desk or at it, so the move back is one click
};
export let tween = null;
export function flyTo(name, dur = 1.6) {
  const v = VIEWS[name], key = name === 'desk' ? 'boss' : name;
  tween = { from: camera.position.clone(), fromT: controls.target.clone(), to: new V3(...v.pos), toT: new V3(...v.target), t: 0, dur: REDUCED ? .001 : dur };
  container.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.view === key));
}
// "Boss" follows you: behind the table, or behind your desk when you sit there.
// W and S carry the camera and the point it orbits forward and back along the view, flat over the floor, A and D slide
// them left and right. The point stays inside the room. A key typed into a field, or held with Ctrl, Alt or Meta, moves
// nothing, and a key takes the camera from a flight.
const held = new Set(), WALK = { KeyW: [0, 1], KeyS: [0, -1], KeyA: [-1, 0], KeyD: [1, 0] }, WALK_SPEED = 6; // m/s
addEventListener('keydown', e => { if (WALK[e.code] && !e.ctrlKey && !e.altKey && !e.metaKey && !e.target.closest?.('input, textarea, select, [contenteditable]')) held.add(e.code); });
addEventListener('keyup', e => held.delete(e.code));
addEventListener('blur', () => held.clear());
const fwd = new V3(), side = new V3(), step = new V3();
function walkCamera(dt) {
  if (!held.size) return;
  if (tween) { tween = null; controls.enabled = true; }
  fwd.subVectors(controls.target, camera.position).setY(0);
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 1, 0).applyQuaternion(camera.quaternion).setY(0); // straight down: the screen's up
  fwd.normalize(); side.set(-fwd.z, 0, fwd.x); step.set(0, 0, 0);
  for (const k of held) step.addScaledVector(side, WALK[k][0]).addScaledVector(fwd, WALK[k][1]);
  if (step.lengthSq() < 1e-6) return;
  step.normalize().multiplyScalar(WALK_SPEED * dt);
  const T = controls.target;
  step.set(clamp(T.x + step.x, -ROOM.x, ROOM.x) - T.x, 0, clamp(T.z + step.z, ROOM.zMin, ROOM.zMax) - T.z);
  T.add(step); camera.position.add(step);
}
container.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => flyTo(b.dataset.view === 'boss' && boss.goal === 'desk' ? 'desk' : b.dataset.view)));
// Intro: start outside over the city, fly through the glass, land behind the boss.
export const introPath = new THREE.CatmullRomCurve3([new V3(16, 4.6, 52), new V3(5, 4.6, 21), new V3(-1.5, 4.4, 7.5), new V3(-2.6, 3.6, 1.6), new V3(...VIEWS.boss.pos)]);
export const camHash = /cam=([-\d.,]+)/.exec(location.search);
if (camHash) { const v = camHash[1].split(',').map(Number); camera.position.set(v[0], v[1], v[2]); controls.target.set(v[3], v[4], v[5]); }
else if (REDUCED) { camera.position.set(...VIEWS.boss.pos); controls.target.set(...VIEWS.boss.target); }
else { camera.position.copy(introPath.getPoint(0)); controls.target.set(0, 2, 8); tween = { intro: true, t: 0, dur: 6, fromT: new V3(0, 2, 8), toT: new V3(...VIEWS.boss.target) }; }

// ---------- rally: everyone stops, stands, turns to the boss, cheers ----------
export let rallyStart = -1;
export const rallyBtn = $('rally');
rallyBtn.addEventListener('click', () => {
  rallyStart = now(); rallyBtn.disabled = true;
  setRally(true); // frame() ends it 4.6 s on, on the room's clock, so a sleep in the middle holds it rather than cutting it short
});

// ---------- animation ----------
export const bossHead = new V3(), lk = new V3();
const FLAT = new THREE.Quaternion(); // a raised hand's turn: none, in line with its forearm
export function setArm(arm, side, p) { arm.sh.rotation.set(p[0], -side * p[1], side * p[2]); arm.el.rotation.x = p[3]; }
export function look(P, target, k) {
  const h = P.head; lk.copy(target); h.parent.worldToLocal(lk); lk.sub(h.position); lk.y -= .12;
  const yaw = clamp(Math.atan2(lk.x, lk.z), -1.05, 1.05), pitch = clamp(-Math.atan2(lk.y, Math.hypot(lk.x, lk.z)), -.55, .65);
  h.rotation.y = lerp(h.rotation.y, yaw, k); h.rotation.x = lerp(h.rotation.x, pitch, k);
}
export function animate(P, t, dt, rally) {
  const ph = P.phase, isBoss = P === boss, still = REDUCED ? 0 : 1;
  const L = P.pose.L.slice(), R = P.pose.R.slice();
  L[0] += .02 * Math.sin(t * 1.1 + ph) * still; R[0] += .02 * Math.sin(t * 1.3 + ph + 1) * still;
  // at a desk the hands go onto the keys (typing.js), once the stance below has placed the shoulders
  const typing = P.act === 'type' && P.desk?.keyboard ? typeState(P, t) : null;
  if (!typing && P.typeEv) endTyping(P);
  // talkers gesture big when someone is there to listen, small when alone
  if (P.pose.talk) { const k = still * (P.npc && !P.mate ? .25 : 1); L[0] += .16 * Math.sin(t * 2.1 + ph) * k; L[3] += .22 * Math.sin(t * 2.9 + ph) * k; L[1] += .1 * Math.sin(t * 1.7 + ph) * k; }
  if (P.pose.prop === 'glass' || P.pose.prop === 'mug') { const c = (t * .09 + ph * .3) % 1, sip = still * (c < .14 ? Math.sin(c / .14 * Math.PI) : 0); for (let i = 0; i < 4; i++) R[i] = lerp(R[i], SIP[i], sip); }
  if (P.act === 'coffee') { const e = t - P.actT, k = e < 2.4 ? Math.sin(Math.PI * e / 2.4) : 0; for (let i = 0; i < 4; i++) R[i] = lerp(R[i], REACH[i], k); P.props.mug.visible = e > 1.2; }
  const W = P.walkW || 0, stride = P.stride || 0;
  if (W) { const sw = .34 * Math.sin(stride) * W; L[0] += sw; R[0] -= sw; }
  const onStage = isBoss && P.state === 'stage';
  if (onStage) { L[1] += .38 * Math.sin(t * .5) * still; L[0] += .1 * Math.sin(t * 1.4) * still; }
  if (isBoss) P.body.rotation.y = onStage ? .14 * Math.sin(t * .5) * still : lerp(P.body.rotation.y, 0, Math.min(1, dt * 4));
  const r = isBoss ? 0 : rally;
  // stance: sitting (desk agents always, idle agents and the boss by their sitW), walking, and during a rally everyone
  // seated stands up and turns to face the boss
  const S = P.seat, sitW = S ? (P.sitW ?? 1) * (1 - smooth(r * 1.6)) : 0, tw = typing ? smooth(sitW) : 0;
  for (const s of [1, -1]) {
    const lp = stride + (s === 1 ? 0 : Math.PI);
    P.legs[s].hip.rotation.x = (S ? S.hip * sitW : 0) - .42 * Math.sin(lp) * W; P.legs[s].hip.rotation.z = S ? s * .07 * sitW : 0;
    P.legs[s].knee.rotation.x = (S ? S.knee * sitW : 0) + .75 * Math.max(0, Math.cos(lp)) * W;
  }
  const jump = .08 * Math.max(0, Math.sin(t * 8 + ph)) * smooth(r * 2 - 1);
  P.body.position.y = (S ? S.off * sitW : 0) + .004 * Math.sin(t * 1.7 + ph) * still + jump + .022 * (Math.abs(Math.cos(stride)) - .6) * W;
  P.upper.rotation.x = (S ? S.lean * sitW : 0) + (typing ? tw * ((P.rig ? P.rig.lean : TYPE.lean) - (S ? S.lean : 0) - (typing.mode === 'lean' ? TYPE.leanBack * typing.env : 0)) : 0) + .05 * W + (P.pose.sleep ? .02 * Math.sin(t * 1.2) * still : 0);
  P.body.rotation.z = isBoss ? 0 : .008 * Math.sin(t * .8 + ph) * still;
  if (P.jackL) { P.jackL.visible = sitW < .5; P.jackS.visible = sitW >= .5; }
  if (tw > 0) typeArms(P, P.desk, t, tw, L, R, typing); else untype(P);
  // the terminal steps only while the hands type
  if (typing && typing.mode === 'type' && tw > .6 && !REDUCED && P.term && t > P.term.next) { P.term.step(); P.term.next = t + .1 + rand() * .25; }
  // a figure that waits on the owner raises its right hand, a typing hand straightening as it rises; a rally below
  // still wins
  P.handW = REDUCED ? (P.handUp ? 1 : 0) : lerp(P.handW || 0, P.handUp ? 1 : 0, Math.min(1, dt * 2.5));
  const hu = smooth(P.handW);
  for (let i = 0; i < 4; i++) R[i] = lerp(R[i], HAND_UP[i], hu);
  if (hu > 0) P.arms[-1].hand.quaternion.slerp(FLAT, hu);
  if (rally > 0) {
    const pump = Math.sin(t * 11 + ph * 3);
    const up = [-2.7 + .28 * pump, .05, .22, -.35 - .3 * pump], v = [-.15, 0, 2.45 + .1 * pump, -.32];
    if (isBoss) { const BL = [-2.6 + .2 * pump, .1, .3, -.2]; for (let i = 0; i < 4; i++) L[i] = lerp(L[i], BL[i], rally); }
    else { const RL = persons.indexOf(P) % 2 ? v : POSES.down.L; for (let i = 0; i < 4; i++) { L[i] = lerp(L[i], RL[i], r); R[i] = lerp(R[i], up[i], r); } }
  }
  setArm(P.arms[1], 1, L); setArm(P.arms[-1], -1, R);
  if (P.home) {
    const k = smooth(r * 1.4);
    P.root.position.lerpVectors(P.home, P.standPos, k);
    P.root.rotation.y = P.yaw + P.dYaw * k;
  }
  P.tag.position.y = 2.08 + P.body.position.y;
  const hk = Math.min(1, dt * 2), h = P.head.rotation;
  if (P.pose.sleep && r < .3) { h.x = lerp(h.x, .5, hk); h.y = lerp(h.y, 0, hk); h.z = lerp(h.z, .2, hk); } // chin down, head tipped
  else if (onStage) h.set(.16, .3 * Math.sin(t * .5) * still, 0);
  else {
    h.z = lerp(h.z, 0, hk * 2);
    let target = bossHead;
    if (isBoss) target = P.state === 'desk' || P.state === 'sit' ? DESK_GAZE : P.fixedLook;
    else if (r < .3) {
      // at a desk the head faces the center screen; a read takes it across the screens, left, center, right
      if (P.lookPts) target = P.lookPts[typing?.mode === 'read' ? (typing.u < .4 ? 0 : typing.u < .6 ? 1 : 2) : 1];
      else if (P.gazeV) target = P.gazeV;
    }
    look(P, target, Math.min(1, dt * (typing?.mode === 'read' ? 8 : 4)));
  }
  P.head.getWorldPosition(P.headPos);
}

new ResizeObserver(() => {
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h); composer.setSize(w, h); labels.setSize(w, h);
}).observe(container);

const SPEED = +(new URLSearchParams(location.search).get('speed') || 1); // ?speed=4: the headless checks watch a whole walk in reasonable time
export let last = now(), first = true;
export function frame() {
  const t = now(), dt = Math.min(t - last, slow ? SLOW_DT : .05) * SPEED; last = t;
  if (!container.getClientRects().length) { last = t; schedule(t); return; }
  walkCamera(dt);
  if (tween) {
    tween.t = Math.min(1, tween.t + dt / tween.dur); const k = ease(tween.t);
    if (tween.intro) camera.position.copy(introPath.getPoint(k)); else camera.position.lerpVectors(tween.from, tween.to, k);
    controls.target.lerpVectors(tween.fromT, tween.toT, k);
    controls.enabled = tween.t >= 1; if (tween.t >= 1) tween = null;
  }
  controls.update();
  ceiling.visible = camera.position.y < FLOOR.h - .1;
  const re = rallyStart < 0 ? 0 : t - rallyStart;
  if (re > 4.6) { rallyStart = -1; setRally(false); rallyBtn.disabled = false; }
  const rally = re <= 0 || re > 4.4 ? 0 : Math.min(1, re / .6) * Math.min(1, (4.4 - re) / .9);
  bloom.strength = .6 + .4 * rally;
  boss.head.getWorldPosition(bossHead);
  bossUpdate(dt);
  for (const P of npcs) npcUpdate(P, t, dt, rally);
  for (const P of persons) { animate(P, t, first ? 1 : dt, rally); wear(P, first ? 1 : dt); }
  tickLinks(t);
  if (!REDUCED) ticker.offset.x = (ticker.offset.x + dt * .018) % 1;
  strobe.visible = (t % 1.6) < .08;
  if (ring.visible) {
    ringMat.opacity = .55 + .35 * Math.sin(t * 3); const P = persons.find(p => p.agent === selected);
    if (P) { ring.position.set(P.root.position.x, P.root.position.y + .012, P.root.position.z); if (P.where !== shownWhere) { $('p-doing').textContent = shownWhere = P.where; if (P === boss) syncMove(); } }
  }
  if (hoverEvt) {
    const hit = pick(hoverEvt), a = hit?.agent || null; hoverEvt = null;
    if (a !== hovered) { if (hovered) tagByAgent.get(hovered)?.classList.remove('hover'); hovered = a; if (a) tagByAgent.get(a)?.classList.add('hover'); }
    renderer.domElement.style.cursor = hit ? 'pointer' : '';
  }
  tickScreens(t, camera); // the desk screens in view repaint what changed
  composer.render(); labels.render(scene, camera);
  if (first) { first = false; $('loading').classList.add('done'); }
  schedule(t);
}

// ---------- sleep and wake ----------
// The room is a game: out of the viewport, with no box (the Dashboard tab showing, its view hidden) or in a hidden tab it asks for no
// animation frame and draws nothing, and its clock stops with it (sleptFor, core.js), so when it wakes, on the next frame,
// motion picks up where it left off; nothing is freed, so nothing is rebuilt. Visible in a window that lost focus to another
// app it draws SLOW frames a second at real speed, except full screen, which can be on one monitor while another app has the focus.
const SLOW = 10, SLOW_DT = 1.5 / SLOW; // frames a second unfocused, and the frame clamp that keeps motion at real speed at that rate
let raf = 0, timer = 0, sleptAt = 0, slow = false, inView = true, focused = document.hasFocus();
addEventListener('focus', () => { focused = true; });
addEventListener('blur', () => { focused = false; });
function schedule(t) { // from the end of a frame: the next one, or none while asleep
  if (!inView || document.visibilityState !== 'visible') { sleptAt = performance.now(); return; }
  slow = !focused && !expanded();
  if (slow) timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(frame); }, Math.max(0, 1000 / SLOW - (now() - t) * 1000));
  else raf = requestAnimationFrame(frame);
}
function sleep() { if (sleptAt) return; cancelAnimationFrame(raf); clearTimeout(timer); raf = timer = 0; sleptAt = performance.now(); }
function wake() { if (!sleptAt) return; sleptFor(performance.now() - sleptAt); sleptAt = 0; raf = requestAnimationFrame(frame); }
function sync() { if (inView && document.visibilityState === 'visible') wake(); else sleep(); }
// The first render links every program the room uses, and linked on the main thread that is a long block on a cold
// shader cache. Compiled here first (warmPrograms, in core.js), the links finish on the driver's worker threads while
// the page stays live; the loading text stays up until the first frame. The first frame also waits on links the scene
// compile never reaches: the shadow pass's depth programs (warmPrograms covers them), and the composer's own passes,
// compiled here on the passes' own materials over the same kind of triangle Pass.js draws them with, against a scene
// with no lights and no fog, which is how a pass draws (its mesh is not a scene). OutputPass sets its defines on its
// first render (OutputPass.js 97 to 114); set first for this renderer's sRGB output and ACES tone mapping, so the
// compile keys the program the pass will ask for. The frame given back first parts the build of the room (the modules
// above, one task) from the compile's own synchronous half (the shader sources).
await new Promise(requestAnimationFrame);
await warmPrograms(scene);
await warmPrograms(deskSample()); // a desk is in the room only while it is held: its programs are ready before the first one comes
const tri = new THREE.BufferGeometry();
tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
output.material.defines = { SRGB_TRANSFER: '', ACES_FILMIC_TONE_MAPPING: '' };
const passes = new THREE.Group();
for (const m of [bloom.materialHighPassFilter, ...bloom.separableBlurMaterials, bloom.compositeMaterial, bloom.blendMaterial, output.material]) passes.add(new THREE.Mesh(tri, m));
await warmPrograms(passes, new THREE.Scene());
frame();
// the sleep controller starts after the first frame, which draws in or out of view so the loading text clears
new IntersectionObserver(es => { inView = es[es.length - 1].isIntersecting; sync(); }).observe(container);
document.addEventListener('visibilitychange', sync);
if (new URLSearchParams(location.search).has('debug')) window.__hqFloor = { scene, camera, controls, renderer, npcs, persons, boss, SPOTS, occupant, bossGo, OFF_MAT }; // renderer: the checks read its texture count and frame counter
