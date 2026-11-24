// The things on a desk, as numbers: furniture.js builds them, rooms.js keeps where the keyboard and the mouse
// are for the typing hands (typing.js), and the checks test them. Desk coordinates as in monitors.js: x across the desk,
// y up from the floor, z toward the chair; the desktop is at y .77, its front edge at z .4.
import { DESKTOP_Y } from './monitors.js';

// the keyboard, centered under the center screen and square to the front edge, 10 cm in from where it sat: the typing
// hands reach it with the forearms over the desk's edge, not through it
export const KEYBOARD = { x: 0, z: .1, w: .44, d: .14, h: .016 };
// the mouse on its pad beside the keyboard, on the mouse hand's side (side 1 is the figure's right, desk +x)
export const PAD = { x: .36, z: .14, w: .22, d: .19, h: .003 };
export const MOUSE = { w: .062, d: .1, h: .032 };
// the dark box is the desk phone: a fixed place under the right monitor, clear of the mouse pad and of the arm's pole
export const PHONE = { full: { x: .56, z: -.15 }, narrow: { x: .43, z: -.2 }, w: .18, d: .2, h: .07 };
// the papers, a squared stack or a tray, under the left monitor
export const PAPERS = { full: { x: -.55, z: -.17 }, narrow: { x: -.43, z: -.19 }, stack: { w: .21, d: .297, h: .02 }, tray: { w: .25, d: .33, h: .05 } };
// The name plate: a tent at the front edge's corner on the plate's side (the aisle's), turned `turn` in toward the desk's
// middle: one face reads from the chair, from behind it and from the table side, the other from the aisle beside the desk
// and past it. Its box stays out past MOUSE_REACH, where a mousing forearm reaches over the front of the desk (it reaches
// .466 at the front edge, with the elbow out as typing.js sets it), so on a narrow desk it turns 60 degrees, not 30, to
// fit between that and the desk's side. w and d are the tent's own footprint (across its faces, and from face to face at
// the foot), h its height.
export const PLATE = { full: { x: .6, z: .325, turn: Math.PI / 6 }, narrow: { x: .5575, z: .31, turn: Math.PI / 3 }, w: .18, d: .045, h: .062 };
export const MOUSE_REACH = .47;
export function plateAt(narrow, side) {
  const p = PLATE[narrow ? 'narrow' : 'full'], yaw = -side * p.turn, c = Math.cos(p.turn), s = Math.sin(p.turn);
  return { x: side * p.x, z: p.z, yaw, w: PLATE.w * c + PLATE.d * s, d: PLATE.w * s + PLATE.d * c }; // w and d here: its box on the desk
}

// where the typing hands find the keys and the mouse, for a desk whose mouse is on `side`
export function deskInputs(side = 1) {
  return {
    keyboard: { x: KEYBOARD.x, z: KEYBOARD.z, w: KEYBOARD.w, d: KEYBOARD.d, top: DESKTOP_Y + KEYBOARD.h },
    mouse: { x: side * PAD.x, z: PAD.z, top: DESKTOP_Y + PAD.h + MOUSE.h, side },
  };
}

// The personal kit: what makes a desk someone's. Each kind's footprint (w across, d deep) and height bound what
// furniture.js builds for it; its colors are the choices a desk draws from. The notebook is flat and wide: it lies only
// in the space under the center screen.
export const KINDS = {
  mug: { w: .106, d: .074, h: .095, colors: ['#a8352b', '#2f5d8a', '#d3cbbb', '#2c2c30', '#3f7d5a', '#b8952a'] },
  plant: { w: .1, d: .1, h: .17, colors: ['#9c4f2c', '#c9c2b4', '#1d1d20', '#74876c'] },
  lamp: { w: .11, d: .11, h: .31, colors: ['#8a6d3b', '#1f1f22', '#2e5e3e', '#c8c1b1'] },
  headphones: { w: .16, d: .09, h: .3, colors: ['#18181b', '#cfcbc3', '#8e2a24', '#24324f'] },
  photo: { w: .1, d: .07, h: .13, colors: ['#1b1c20', '#7a5230', '#a8864f', '#d2cdc1'] },
  notebook: { w: .21, d: .15, h: .027, colors: ['#1f2a44', '#6f2a24', '#2d4a35', '#3b3b3f', '#b0904f'] },
  bottle: { w: .066, d: .066, h: .22, colors: ['#8f959b', '#2b7a78', '#b85a2a', '#222226', '#5f82a8'] },
  pencup: { w: .09, d: .09, h: .14, colors: ['#2c2c30', '#aea89c', '#7a5230', '#3a5a7a'] },
  duck: { w: .07, d: .08, h: .075, colors: ['#d8b23a', '#2a6fb0', '#c96f96', '#26262a'] },
  sticky: { w: .076, d: .076, h: .014, colors: ['#cfbd55', '#c97a9a', '#69a0c2', '#80ae66', '#d6914a'] },
};
// The free places for personal things, per desk size. x is signed by the plate's side: `+` on the plate's side, `-`
// away from it. Each slot is clear of the keyboard, the mouse pad on either side, the phone, the papers, the plate, the
// arm's pole and clamp, and the typing forearms (|x| under .36 toward the front); h is the room over it (the side
// monitors' front corners over the full desk's third slot, the center screen over the last).
export const SLOTS = {
  full: [{ x: -.6, z: .29, w: .2, d: .16, h: .45 }, { x: .62, z: .17, w: .18, d: .14, h: .45 }, { x: -.6, z: .08, w: .2, d: .14, h: .13 }, { x: 0, z: -.15, w: .3, d: .2, h: .12 }],
  narrow: [{ x: -.545, z: .3, w: .11, d: .14, h: .45 }, { x: .545, z: .15, w: .11, d: .14, h: .45 }, { x: -.545, z: .1, w: .11, d: .14, h: .45 }, { x: 0, z: -.15, w: .26, d: .18, h: .12 }],
};
// desks whose centers are closer than this are neighbors: no two of them share a set of things
export const NEAR = 2.5;
// FNV-1a over the key's characters, and a small generator from it: the same key gives the same desk on every load
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function gen(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// A desk's things from its key: the mouse's side (left for about 1 desk in 6), the papers (stack or tray), and 2 to 4
// personal things in its free places, each in a color of its kind. `taken` holds the sets of the desks already built
// near it: a set one of them has is drawn again (the key with a salt) until it differs.
export function deskKit(key, narrow, plateSide = -1, taken = []) {
  // the mouse's side from a mixed draw: the raw hash's low bits follow the key's last character (every "...3" key alike)
  const mouse = gen(hash32(key))() < 1 / 6 ? -1 : 1, size = narrow ? 'narrow' : 'full';
  for (let salt = 0; ; salt++) {
    const r = gen(hash32(key + '#' + salt)), n = 2 + Math.floor(r() * 3);
    const order = SLOTS[size].map((s, i) => [r(), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    const items = [], used = new Set();
    for (const i of order) {
      if (items.length === n) break;
      const s = SLOTS[size][i], fit = Object.keys(KINDS).filter((k) => !used.has(k) && KINDS[k].w <= s.w && KINDS[k].d <= s.d && KINDS[k].h <= s.h);
      if (!fit.length) continue;
      const kind = fit[Math.floor(r() * fit.length)], K = KINDS[kind]; used.add(kind);
      items.push({ kind, slot: i, x: plateSide * s.x, z: s.z, color: K.colors[Math.floor(r() * K.colors.length)] });
    }
    const set = items.map((it) => it.kind).sort().join(',');
    if (!taken.includes(set) || salt > 50) return { key, narrow, mouse, plateSide, papers: r() < .5 ? 'stack' : 'tray', items, set, salt };
  }
}
// the fixed things' boxes on a desk (desk coordinates, x and z centers, w and d sizes), for the checks
export function fixedBoxes(kit) {
  const size = kit.narrow ? 'narrow' : 'full', P = PAPERS[size], pp = PAPERS[kit.papers], pl = plateAt(kit.narrow, kit.plateSide);
  return [
    { name: 'keyboard', x: KEYBOARD.x, z: KEYBOARD.z, w: KEYBOARD.w, d: KEYBOARD.d },
    { name: 'pad', x: kit.mouse * PAD.x, z: PAD.z, w: PAD.w, d: PAD.d },
    { name: 'phone', x: PHONE[size].x, z: PHONE[size].z, w: PHONE.w, d: PHONE.d },
    { name: 'papers', x: P.x, z: P.z, w: pp.w, d: pp.d },
    { name: 'plate', x: pl.x, z: pl.z, w: pl.w, d: pl.d },
  ];
}
