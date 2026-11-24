// The room itself: the floor and its inlay, ceiling, stone wall, glass, the ticker, the city below and the video wall
// (add() lives in core.js).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from './data.js';
import { clamp, rand, rad, scene, canvasTex, BRASS, marbleTex, rod, add } from './core.js';
import { ROOM, LOUNGE } from './plan.js';

// ---------- room ----------
export const FLOOR = ROOM;
export const GLASS_H = 4.7;
export const roomW = FLOOR.x * 2, roomD = FLOOR.zMax - FLOOR.zMin, roomZ = (FLOOR.zMax + FLOOR.zMin) / 2;
export const floorMat = new THREE.MeshStandardMaterial({ map: marbleTex('#26221f', '200,190,178', [9, 7], true), roughness: .38, metalness: 0 });
add(new THREE.PlaneGeometry(roomW, roomD), floorMat, [0, 0, roomZ], [-Math.PI / 2, 0, 0]);

// art deco sunburst inlay around the boss table, all the way round, its brass in one mesh
{
  const parts = [];
  for (let i = 0; i < 24; i++) {
    const r0 = 3.15, r1 = 4.95, g = new THREE.BoxGeometry(.035, .004, r1 - r0); g.translate(0, .003, (r0 + r1) / 2); g.rotateY(rad(i * 15)); parts.push(g);
  }
  for (const [R, w, y] of [[3.1, .02, .003], [4.95, .02, .003], [2.95, .012, .004], [2.75, .012, .004]]) { const g = new THREE.RingGeometry(R - w, R + w, 96); g.rotateX(-Math.PI / 2); g.translate(0, y, 0); parts.push(g); }
  add(mergeGeometries(parts), BRASS, null, null, { receive: false });
}
export const medal = new THREE.CircleGeometry(3.05, 96); medal.rotateX(-Math.PI / 2);
add(medal, new THREE.MeshStandardMaterial({ color: '#0d0c0b', roughness: .95 }), [0, .002, 0]);

// ceiling and roof (hidden from above for overhead shots)
export const ceiling = new THREE.Group(); scene.add(ceiling);
add(new THREE.PlaneGeometry(roomW, roomD), new THREE.MeshStandardMaterial({ color: '#09090b', roughness: .9 }), [0, FLOOR.h, roomZ], [Math.PI / 2, 0, 0], { parent: ceiling });
add(new THREE.BoxGeometry(roomW + 1, .8, roomD + 1), new THREE.MeshStandardMaterial({ color: '#0b0b0d', roughness: .8 }), [0, FLOOR.h + .4, roomZ], null, { parent: ceiling });
// no ceiling light panels: they were unlit material that lit nothing, so removing them leaves the room's lights
// (stage.js) and the overhead reflections (core.js) exactly as they were

// back wall: dark stone with brass fins
export const stoneTex = canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = '#121214'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(${rand() < .5 ? '255,255,255' : '0,0,0'},${rand() * .035})`; g.fillRect(rand() * w, rand() * h, 2, 2); }
  for (let x = 0; x < w; x += 128) { g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x, 0, 3, h); }
  g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, h / 2, w, 3);
}, [10, 1.4]);
export const stoneMat = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: .6 });
add(new THREE.PlaneGeometry(roomW, FLOOR.h), stoneMat, [0, FLOOR.h / 2, FLOOR.zMin]);
{ // the fins, in one mesh, clear of the video wall, the coffee station and the back bar
  const fins = [];
  for (let x = -FLOOR.x + .8; x <= FLOOR.x - .8; x += 1.6) {
    if (Math.abs(x) < 5.4 || Math.abs(x - LOUNGE.coffee.x) < 1.3 || Math.abs(x - LOUNGE.bar.x) < 3.4) continue;
    fins.push(new THREE.BoxGeometry(.05, FLOOR.h - .5, .08).translate(x, FLOOR.h / 2, FLOOR.zMin + .05));
  }
  add(mergeGeometries(fins), BRASS);
}

// glass on three sides: the city all around forceSinglePass on the flat transparent panes (here, the clouds, the
// screens, the holo, the room glass and frost): three.js otherwise draws a transparent double-sided material twice,
// re-keying its program before each pass, and for a plane the camera sees one side anyway, so the pixels are the same
// and the room stops lagging at its normal height roughness .3, not mirror-smooth: at .04 each ceiling light left a hot
// pinpoint in the glass that the bloom blew up into a white disk at the top of the Boss view
export const glassMat = new THREE.MeshPhysicalMaterial({ color: '#a7b4c8', transparent: true, opacity: .06, roughness: .3, metalness: .2, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
export const steel = new THREE.MeshStandardMaterial({ color: '#141518', metalness: .75, roughness: .35 });
export const header = new THREE.MeshStandardMaterial({ color: '#0b0b0d', roughness: .8 });
export function glassWall(len, place) {
  const g = new THREE.Group(); place(g); scene.add(g);
  add(new THREE.PlaneGeometry(len, GLASS_H), glassMat, [0, GLASS_H / 2, 0], null, { parent: g, receive: false });
  for (let x = -len / 2; x <= len / 2 + .01; x += len / Math.round(len / 3.2)) add(new THREE.BoxGeometry(.08, GLASS_H, .14), steel, [x, GLASS_H / 2, 0], null, { parent: g });
  add(new THREE.BoxGeometry(len, .14, .3), steel, [0, .07, 0], null, { parent: g });
  add(new THREE.BoxGeometry(len, .1, .16), steel, [0, GLASS_H, 0], null, { parent: g });
  add(new THREE.BoxGeometry(len, FLOOR.h - GLASS_H, .2), header, [0, (FLOOR.h + GLASS_H) / 2, 0], null, { parent: g });
  return g;
}
glassWall(roomW, g => g.position.set(0, 0, FLOOR.zMax));
glassWall(roomD, g => { g.position.set(FLOOR.x, 0, roomZ); g.rotation.y = Math.PI / 2; });
glassWall(roomD, g => { g.position.set(-FLOOR.x, 0, roomZ); g.rotation.y = Math.PI / 2; });

// LED ticker above the front glass. The canvas is one text unit wide so it tiles with no seam.
export const TICKER_FONT = '700 64px ui-monospace,SFMono-Regular,Consolas,monospace';
export function tickerDraw(text) {
  return (g, w, h) => {
    g.fillStyle = '#030201'; g.fillRect(0, 0, w, h);
    g.font = TICKER_FONT; g.textBaseline = 'middle';
    g.fillStyle = '#ffb000'; g.shadowColor = '#ff8a00'; g.shadowBlur = 12;
    g.fillText(text + '   ◆   ', 0, h / 2 + 4);
    g.shadowBlur = 0; g.fillStyle = 'rgba(0,0,0,.6)';
    for (let i = 0; i < w; i += 4) g.fillRect(i, 0, 1, h);
    for (let j = 0; j < h; j += 4) g.fillRect(0, j, w, 1);
  };
}
export const tickerWidth = text => { const g = document.createElement('canvas').getContext('2d'); g.font = TICKER_FONT; return Math.ceil(g.measureText(text + '   ◆   ').width / 4) * 4; };
// what the ticker and the video wall count: live data through setCounts(), zero until the first payload. The counts are
// padded to two characters so the text keeps one width as they change (the canvas is cut to it once) and the tile stays
// seamless.
export const counts = { working: 0, idle: 0, rooms: CONFIG.sections.length };
let seatWait = 0; // the working or waiting sessions and helpers with no live seat (live.js): the video wall says how many
const two = n => String(n).padStart(2, ' ');
export const tickerText = () => `THE OFFICE   ◆   ${two(counts.working)} WORKING   ◆   ${two(counts.idle)} IDLE   ◆   ${counts.rooms} TEAMS   ◆   ALL EYES ON THE BOSS`;
export const RALLY_TEXT = "LET'S GO   ◆   ALL HANDS   ◆   EVERY AGENT ON THEIR FEET";
export const TICKER_W = Math.max(tickerWidth(tickerText()), tickerWidth(RALLY_TEXT));
export const ticker = canvasTex(TICKER_W, 96, tickerDraw(tickerText()), [Math.max(1, Math.round(((roomW - .4) / .36) / (TICKER_W / 96))), 1]);
ticker.wrapT = THREE.ClampToEdgeWrapping;
add(new THREE.PlaneGeometry(roomW - .4, .36), new THREE.MeshBasicMaterial({ map: ticker, color: new THREE.Color(1.5, 1.5, 1.5) }), [0, GLASS_H + .45, FLOOR.zMax - .12], [0, Math.PI, 0]);
export function redrawTicker(text) { const c = ticker.userData.canvas; tickerDraw(text)(c.getContext('2d'), c.width, c.height); ticker.needsUpdate = true; }

// ============================================================================ THE CITY BELOW: a
// few blocks around our tower, every roof well under our floor, in one merged mesh with a custom
// shader for sodium haze, uplit crowns and lit windows; and the sky. No rain, clouds, searchlights
// or beacons. ============================================================================
export const winTex = canvasTex(256, 512, (g, w, h) => {
  g.fillStyle = '#07080c'; g.fillRect(0, 0, w, h);
  const cols = ['#ffc46b', '#ffd89a', '#ffe9c4', '#ffb35a', '#ffd89a', '#c9d8ff'];
  for (let y = 2; y < h; y += 12) {
    const floorLit = rand() < .42;
    for (let x = 1; x < w; x += 7) if ((floorLit && rand() < .58) || rand() < .05) {
      g.globalAlpha = .3 + rand() * .6; g.fillStyle = cols[(rand() * cols.length) | 0]; g.fillRect(x, y, 5, 8);
    }
  }
  g.globalAlpha = 1;
}, [1, 1]);
export const cityParts = [];
export function cityAttrs(g, win, shade, crown, up) {
  const n = g.attributes.position.count, W = [], S = [], C = [], U = [];
  for (let k = 0; k < n; k++) { W.push(typeof win === 'function' ? win(k) : win); S.push(shade); C.push(crown); U.push(up); }
  g.setAttribute('aWin', new THREE.Float32BufferAttribute(W, 1)); g.setAttribute('aShade', new THREE.Float32BufferAttribute(S, 1));
  g.setAttribute('aCrown', new THREE.Float32BufferAttribute(C, 1)); g.setAttribute('aUp', new THREE.Float32BufferAttribute(U, 1));
}
export function pushBox(w, h, d, x, y0, z, shade, crown, up) {
  const g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv, uo = rand(), vo = rand();
  for (let k = 0; k < uv.count; k++) { const f = (k / 4) | 0, ext = f < 2 ? d : w; uv.setXY(k, uv.getX(k) * ext / 48 + uo, uv.getY(k) * h / 95 + vo); }
  cityAttrs(g, k => { const f = (k / 4) | 0; return f === 2 || f === 3 ? 0 : 1; }, shade, crown, up);
  g.translate(x, y0 + h / 2, z); cityParts.push(g);
}
export function pushCone(r, h, x, y0, z, shade, up, sides = 4) {
  const g = new THREE.ConeGeometry(r, h, sides, 1); g.rotateY(Math.PI / 4); cityAttrs(g, 0, shade, y0 + h, up);
  g.translate(x, y0 + h / 2, z); cityParts.push(g);
}
export const BASE_Y = -240; // the floor sits 240 m up
export function tower(x, z, w, d, h) {
  const dist = Math.hypot(x, z), shade = clamp(1.05 - (dist - 70) / 600, .4, 1.05);
  const tiers = rand() < .5 ? 1 : rand() < .65 ? 2 : 3;
  const hs = []; let rem = h;
  for (let i = 0; i < tiers; i++) { const th = i === tiers - 1 ? rem : rem * (.5 + rand() * .2); hs.push(th); rem -= th; }
  const crown = BASE_Y + h, up = .28;
  let y = BASE_Y, cw = w, cd = d;
  hs.forEach(th => { pushBox(cw, th, cd, x, y, z, shade, crown, up); y += th; cw *= .72 + rand() * .1; cd *= .72 + rand() * .1; });
  if (rand() < .3) pushCone(Math.min(cw, cd) * .6, 5 + rand() * 12, x, y, z, shade, up);
}
// our own tower under the floor, seen on the intro fly-in
pushBox(roomW + 1, -BASE_Y, roomD + 1, 0, BASE_Y - .5, roomZ, 1, 0, 0);
// 36 blocks within about 400 m, up to 210 m tall plus a 17 m cap, every top under our floor; then 30 towers farther out
// that rise past our floor, so a skyline stands in the glass
for (let i = 0; i < 36; i++) {
  const a = rand() * Math.PI * 2, d = 90 + Math.pow(rand(), .7) * 320;
  tower(Math.sin(a) * d, Math.cos(a) * d + roomZ, 14 + rand() * 18, 14 + rand() * 18, 70 + rand() * 140);
}
for (let i = 0; i < 30; i++) {
  const a = -Math.PI * .82 + (i + rand() * .7) / 30 * Math.PI * 1.64, d = 210 + rand() * 260; // all round but behind the back wall, which is stone
  tower(Math.sin(a) * d, Math.cos(a) * d + roomZ, 22 + rand() * 26, 22 + rand() * 26, 248 + rand() * 80);
}
export const towerMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: winTex }, haze: { value: new THREE.Color('#8a5a48') }, hazeHigh: { value: new THREE.Color('#39425f') }, uplight: { value: new THREE.Color('#ffb36b') }, stone: { value: new THREE.Color('#1b2135') } },
  vertexShader: `
    attribute float aWin; attribute float aShade; attribute float aCrown; attribute float aUp;
    varying vec2 vUv; varying vec3 vW; varying vec3 vN; varying float vWin; varying float vShade; varying float vCrown; varying float vUp;
    void main() {
      vUv = uv; vWin = aWin; vShade = aShade; vCrown = aCrown; vUp = aUp; vN = normal;
      vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: `
    uniform sampler2D map; uniform vec3 haze; uniform vec3 hazeHigh; uniform vec3 uplight; uniform vec3 stone;
    varying vec2 vUv; varying vec3 vW; varying vec3 vN; varying float vWin; varying float vShade; varying float vCrown; varying float vUp;
    void main() {
      float lam = .4 + .6 * clamp(dot(normalize(vN), normalize(vec3(.25, .35, -.9))) * .5 + .5, 0., 1.);
      vec3 tex = texture2D(map, vUv).rgb;
      float lit = smoothstep(.06, .3, dot(tex, vec3(.3, .59, .11))) * vWin;
      vec3 c = mix(stone * lam, tex, lit);
      float crown = smoothstep(vCrown - 40., vCrown, vW.y) * vUp;
      c += uplight * crown * .35 * (1. - lit);
      c *= vShade;
      float d = length(vW.xz);
      float f = smoothstep(50., 540., d);
      float low = 1. - smoothstep(-240., 10., vW.y);
      c = mix(c, mix(hazeHigh, haze, low), clamp(f * .8 + low * .6, 0., .95));
      gl_FragColor = vec4(c, 1.);
      #include <colorspace_fragment>
    }`,
});
add(mergeGeometries(cityParts), towerMat, null, null, { receive: false });
// sky dome: blue dusk above, the last of the sunset at the horizon
export const skyTex = canvasTex(16, 1024, (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#060b1c'); gr.addColorStop(.3, '#0e1a38'); gr.addColorStop(.41, '#25345f'); gr.addColorStop(.465, '#6a4f78'); gr.addColorStop(.49, '#d9855a'); gr.addColorStop(.502, '#f0a868'); gr.addColorStop(.52, '#5b4152'); gr.addColorStop(.6, '#1a1a2c'); gr.addColorStop(1, '#0a0b14');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
add(new THREE.SphereGeometry(1900, 48, 24), new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }), [0, 0, 0], null, { receive: false });

// video wall behind the boss's desk
export const wallCanvasTex = canvasTex(2048, 728, () => {});
export function drawVideoWall(rally) {
  const c = wallCanvasTex.userData.canvas, g = c.getContext('2d'), w = c.width, h = c.height;
  const gr = g.createRadialGradient(w * .3, h * .45, 40, w * .3, h * .45, w * .8);
  gr.addColorStop(0, '#0d1424'); gr.addColorStop(1, '#030409'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,.035)'; g.lineWidth = 1;
  for (let x = 0; x < w; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y < h; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  g.textBaseline = 'alphabetic'; g.fillStyle = '#ffffff';
  g.font = `200 ${rally ? 210 : 280}px -apple-system,"Segoe UI",Inter,sans-serif`;
  g.fillText(rally ? "LET'S GO" : 'HQ', 110, 400);
  g.fillStyle = '#d4b060'; g.font = '600 44px -apple-system,"Segoe UI",Inter,sans-serif';
  if (g.letterSpacing !== undefined) g.letterSpacing = '12px';
  g.fillText(rally ? 'ALL HANDS' : 'ALL HANDS ON DECK', 118, 500);
  if (g.letterSpacing !== undefined) g.letterSpacing = '0px';
  if (!rally && seatWait) { g.fillStyle = '#9a9aa3'; g.font = '500 34px -apple-system,"Segoe UI",Inter,sans-serif'; g.fillText(`+${seatWait} waiting for a seat`, 118, 572); }
  const stats = [[counts.working, 'WORKING'], [counts.idle, 'IDLE'], [counts.rooms, 'TEAMS']];
  stats.forEach(([n, l], i) => {
    const x = 1180 + i * 290;
    g.fillStyle = '#ffffff'; g.font = '200 150px -apple-system,"Segoe UI",Inter,sans-serif'; g.fillText(String(n), x, 400);
    g.fillStyle = '#9a9aa3'; g.font = '600 26px -apple-system,"Segoe UI",Inter,sans-serif'; g.fillText(l, x + 4, 450);
  });
  wallCanvasTex.needsUpdate = true;
}
drawVideoWall(false);
add(new THREE.BoxGeometry(9.3, 3.5, .1), BRASS, [0, 2.75, FLOOR.zMin + .06]);
add(new THREE.PlaneGeometry(9, 3.2), new THREE.MeshBasicMaterial({ map: wallCanvasTex, color: new THREE.Color(1.2, 1.2, 1.2) }), [0, 2.75, FLOOR.zMin + .12]);
for (let i = 0; i <= 12; i++) { const a = rad(-60 + i * 10); add(rod([Math.sin(a) * .3, 4.55 + Math.cos(a) * .3, FLOOR.zMin + .08], [Math.sin(a) * 1.0, 4.55 + Math.cos(a) * 1.0, FLOOR.zMin + .08], .012, 6), BRASS); }
// the rally takes the ticker and the wall for its run; counts that arrive meanwhile show when it ends
let rallying = false;
export function setRally(on) { rallying = on; drawVideoWall(on); redrawTicker(on ? RALLY_TEXT : tickerText()); }
export function setCounts(working, idle, rooms) {
  if (counts.working === working && counts.idle === idle && counts.rooms === rooms) return;
  Object.assign(counts, { working, idle, rooms });
  if (rallying) return;
  redrawTicker(tickerText()); drawVideoWall(false);
}
export function setSeatWait(n) {
  if (seatWait === n) return;
  seatWait = n;
  if (!rallying) drawVideoWall(false);
}
