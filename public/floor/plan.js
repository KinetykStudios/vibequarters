// Where everything stands on the Office floor, as numbers: the room, the boss's dais, the lounge, the sessions' rows
// and a row per department with a desk for each of its agents. No three.js here, so the checks
// (test/floor-plan.test.mjs) run it as is. Floor coordinates: the boss's inlay at the origin, the boss faces +z from
// the desk on the dais behind it; from the Boss camera +x is the left side of the room (the agents) and -x the right
// (the sessions). A desk's yaw turns its own +z (its front, where its chair stands) toward the boss: every desk here is
// yaw π, its screens facing the boss.
export const ROOM = { x: 13.5, zMin: -10.8, zMax: 19.3, h: 5.6 }; // 27 x 30.1 m: sized to the rows (6 agent rows) and the lounge
export const DAIS = { w: 6.6, z0: -7.5, z1: -2.6 }; // its front runs .55 m past the boss's desk's nose (furniture.js)
export const DESK = { full: 1.6, narrow: 1.25 };
export const STAND = 1.2; // where a figure stands to sit down, in front of its desk's center (the seat is at .68)
// The command floor: an aisle from the boss's inlay to the front glass, the agents' rows on its left (+x), the
// sessions' on its right (-x). Every row runs from the aisle's edge out to the same outer edge, on the same lines front
// to back (z0, then one every `row` m), clear of the inlay round the boss, its screens toward the boss. No back panels:
// open floor between the rows, a label over each row's aisle end (rooms.js).
export const GRID = { aisle: 3.3, out: 11.8, z0: 3.9, row: 2.6 };
// the lounge, each piece as a footprint box (center x z, w across x, d along z): coffee on the back wall on the left, the
// bar at the back on the right, the couches by the front glass on the right, past the sessions' rows
export const LOUNGE = {
  coffee: { x: 7.4, z: -10.5, w: 1.7, d: 0.6 },
  couches: { x: -7.55, z: 16.2, w: 2.3, d: 3.3 },
  lamp: { x: -5.55, z: 16.2, w: 0.5, d: 0.5 },
  bar: { x: -9.6, z: -8.0, w: 6.2, d: 1.5 },
};

// u: from the desk toward its chair and the boss; v: across the desk, its own +x
const axes = (yaw) => ({ u: [Math.sin(yaw), Math.cos(yaw)], v: [Math.cos(yaw), -Math.sin(yaw)] });

// A row on one side (1 the agents', -1 the sessions'), k rows back from the boss, its desks from the aisle out; the name
// plate on the aisle's side of each desk
const PITCH = 1.7, LIVE_PITCH = (GRID.out - GRID.aisle) / 4; // desk to desk: the agents' narrow ones, the sessions' full ones
function row(side, k, pitch, ids, narrow) {
  const z = GRID.z0 + k * GRID.row;
  return { side, z, slots: ids.map((id, i) => ({ id, x: side * (GRID.aisle + pitch / 2 + i * pitch), z, yaw: Math.PI, narrow, plateSide: side })) };
}
// The sessions: 3 rows of 4, the row nearest the boss first and each from the aisle out, so the first seats taken are the
// ones the Boss camera sees best
export const liveRows = () => [0, 1, 2].map((k) => row(-1, k, LIVE_PITCH, [0, 1, 2, 3].map((i) => 'live:' + (k * 4 + i)), false));
export const liveSlots = () => liveRows().flatMap((r) => r.slots);
// The agents: a row per department in the config's order, the first nearest the boss (6 rows of 5 desks at most,
// config.js, fill it)
export function sections(departments, agents) {
  return departments.map((dep, k) => ({ name: dep.name, color: dep.color, ...row(1, k, PITCH, agents.filter((a) => a.dept === dep.name).map((a) => a.id), true) }));
}

export function standOf(s) { const { u } = axes(s.yaw); return [s.x + u[0] * STAND, s.z + u[1] * STAND]; }
// is the floor point (x, z) within margin m of slot s's desk or its chair? Built or not, a slot is always in the way, so
// the walking routes never change when a desk comes or goes
export function deskBlocks(s, x, z, m) {
  const { u, v } = axes(s.yaw), dx = x - s.x, dz = z - s.z, lx = dx * v[0] + dz * v[1], lz = dx * u[0] + dz * u[1];
  const hw = (s.narrow ? DESK.narrow : DESK.full) / 2;
  if (Math.abs(lx) < hw + m && lz > -0.4 - m && lz < 0.4 + m) return true;
  return Math.abs(lx) < 0.3 + m && lz >= 0.4 && lz < 0.91 + m;
}

// ---------- walking ----------
// The lounge's spots, where a regular idles: where it stands (pos), what it faces, an optional seat it sits into from
// `stand`, `via` points that thread it in past the furniture, and the spot it talks to. Each is set from the piece it
// belongs to, so moving a piece moves its spots.
const C = LOUNGE.couches, B = LOUNGE.bar, K = LOUNGE.coffee, at = (o, dx, dz) => [o.x + dx, o.z + dz];
export const SPOTS = {
  'coffee': { pos: at(K, -.25, .75), face: at(K, -.25, -.3), act: 'coffee', with: 'coffee-chat', name: 'the coffee machine', where: 'Grabbing a coffee', dur: [9, 14] },
  'coffee-chat': { pos: at(K, .8, 1.25), face: at(K, -.25, .75), act: 'mugTalk', with: 'coffee', name: 'the coffee machine', where: 'Coffee and small talk' },
  'chat-a': { pos: [8.6, -3.4], face: [9.5, -4.1], act: 'talk', with: 'chat-b', name: 'the floor', where: 'Chatting on the floor' },
  'chat-b': { pos: [9.5, -4.1], face: [8.6, -3.4], act: 'pockets', with: 'chat-a', name: 'the floor', where: 'Chatting on the floor' },
  'couch-a': { pos: at(C, -.4, -1.25), stand: at(C, -.4, -.56), via: [at(C, -1.65, -.56)], face: at(C, -.4, 3.8), seat: 'couch', act: 'talkSeat', with: 'couch-b', name: 'the couches', where: 'On the couch, talking' },
  'couch-b': { pos: at(C, .45, 1.25), stand: at(C, .45, .56), via: [at(C, 1.5, .56)], face: at(C, .45, -4.2), seat: 'couch', act: 'crossed', with: 'couch-a', name: 'the couches', where: 'On the couch, listening' },
  'nap': { pos: at(C, -.55, 1.25), stand: at(C, -.55, .56), via: [at(C, -1.65, .56)], face: at(C, -.55, -4.2), seat: 'couch', act: 'sleep', name: 'the couches', where: 'Napping on the couch', dur: [26, 40] },
  'window': { pos: [ROOM.x - .8, -3.0], face: [ROOM.x + 12, -3.0], act: 'phone', lookAt: [80, -30, -3], name: 'the window', where: 'At the window, on a call' },
  'window-gaze': { pos: [-(ROOM.x - .8), -4.0], face: [-(ROOM.x + 12), -4.0], act: 'pockets', lookAt: [-90, -30, -10], name: 'the window', where: 'At the window, taking in the city' },
  'bar-stool': { pos: at(B, -.8, .55), stand: at(B, -.8, 1.2), face: at(B, -.8, -.8), seat: 'stool', act: 'drink', with: 'bar-stand', name: 'the bar', where: 'At the bar, whiskey in hand' },
  'bar-stool-2': { pos: at(B, -2.0, .55), stand: at(B, -2.0, 1.2), face: at(B, -2.0, -.8), seat: 'stool', act: 'drink', with: 'bar-stool', name: 'the bar', where: 'At the bar' },
  'bar-stand': { pos: at(B, .95, .9), face: at(B, -.8, .55), act: 'talkDrink', with: 'bar-stool', name: 'the bar', where: 'At the bar, talking' },
  'skyline-a': { pos: [-1.2, ROOM.zMax - .7], face: [-1.2, ROOM.zMax + 13], act: 'pockets', lookAt: [-40, -30, 160], name: 'the skyline', where: 'At the glass, on top of the world' },
  'skyline-b': { pos: [1.2, ROOM.zMax - .7], face: [1.2, ROOM.zMax + 13], act: 'phone', lookAt: [10, -30, 160], name: 'the skyline', where: 'At the glass, on a call' },
};
// the lounge's furniture as boxes a figure walks around: [x, z, half across x, half along z]
export const OBST = [
  [C.x, C.z - 1.2, 1.05, .44], [C.x, C.z + 1.2, 1.05, .44], [C.x, C.z, .7, .35], [LOUNGE.lamp.x, LOUNGE.lamp.z, .15, .15],
  [B.x, B.z - .3, 3.1, .45], ...[-2, -.8, .4].map((dx) => [B.x + dx, B.z + .55, .21, .21]),
  [K.x, K.z, .83, .3],
];
// The floor a figure walks: inside the glass, off the dais, the lounge's furniture and every desk slot, a
// body's width (.26) clear of each. A slot blocks whether its desk stands or not, so the routes never change. The routes
// run over a graph: a 1.5 m grid on the open floor, every desk's stand point and the spots' own points, joined where in
// sight within 3.6 m; a route is the graph's shortest, pulled straight wherever a later point is in sight.
export function floorMap(slots) {
  const M = .26, REACH = 3.6;
  const blocked = (x, z) => Math.abs(x) > ROOM.x - .45 || z < ROOM.zMin + .6 || z > ROOM.zMax - .45
    || (Math.abs(x) < DAIS.w / 2 + .35 && z > DAIS.z0 - .35 && z < DAIS.z1 + .5)
    || OBST.some(([cx, cz, hx, hz]) => Math.abs(x - cx) < hx + M && Math.abs(z - cz) < hz + M)
    || slots.some((s) => (x - s.x) ** 2 + (z - s.z) ** 2 < 2.4 && deskBlocks(s, x, z, M)); // nothing of a desk reaches 1.5 m out
  const los = (a, b) => {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / .2); // a sample every .2 m: inside the .26 m margin
    for (let i = 1; i < n; i++) if (blocked(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n)) return false;
    return true;
  };
  const nodes = [];
  for (let x = -ROOM.x + .9; x < ROOM.x - .4; x += 1.5) for (let z = ROOM.zMin + 1; z < ROOM.zMax - .4; z += 1.5) nodes.push([x, z]);
  for (const s of slots) nodes.push(standOf(s));
  for (const S of Object.values(SPOTS)) nodes.push(S.stand || S.pos, ...(S.via || []));
  const open = nodes.filter((p) => !blocked(p[0], p[1]));
  const adj = open.map(() => []);
  open.forEach((a, i) => { for (let j = i + 1; j < open.length; j++) { const b = open[j], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (d > 0 && d < REACH && los(a, b)) { adj[i].push([j, d]); adj[j].push([i, d]); } } });
  function route(a, b) {
    if (los(a, b)) return [b];
    const n = open.length, dist = new Array(n).fill(Infinity), prev = new Array(n).fill(-1), done = new Array(n).fill(false);
    open.forEach((p, i) => { const d = Math.hypot(a[0] - p[0], a[1] - p[1]); if (d < REACH && los(a, p)) dist[i] = d; });
    if (!dist.some(Number.isFinite)) { // standing somewhere odd (a hair inside a margin): start from the nearest point
      let k = 0; open.forEach((p, i) => { if (Math.hypot(a[0] - p[0], a[1] - p[1]) < Math.hypot(a[0] - open[k][0], a[1] - open[k][1])) k = i; });
      dist[k] = Math.hypot(a[0] - open[k][0], a[1] - open[k][1]);
    }
    for (;;) {
      let u = -1; for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0) break; done[u] = true;
      for (const [v, d] of adj[u]) if (dist[u] + d < dist[v]) { dist[v] = dist[u] + d; prev[v] = u; }
    }
    let best = -1, bd = Infinity;
    open.forEach((p, i) => { const d = Math.hypot(p[0] - b[0], p[1] - b[1]); if (dist[i] + d < bd && d < REACH && los(p, b)) { bd = dist[i] + d; best = i; } });
    if (best < 0) return null;
    const pts = [b]; for (let i = best; i >= 0; i = prev[i]) pts.unshift(open[i]); pts.unshift(a);
    const out = [];
    for (let i = 0; i < pts.length - 1;) { let j = pts.length - 1; while (j > i + 1 && !los(pts[i], pts[j])) j--; out.push(pts[j]); i = j; }
    return out;
  }
  return { blocked, los, route, nodes: open };
}
