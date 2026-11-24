// The lounge: couches and a lamp by the front glass on the right, past the sessions' rows;
// coffee on the back wall on the left; the bar at the back on the right. Where each stands comes from plan.js LOUNGE. The
// bar's bottles are one mesh.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rand, scene, canvasTex, leather, BRASS, CHROME, BLACK, WHISKEY, MUG, glow, marbleTex, add } from './core.js';
import { G } from './person.js';
import { FLOOR } from './building.js';
import { walnutDark } from './furniture.js';
import { LOUNGE } from './plan.js';

export const oxblood = new THREE.MeshPhysicalMaterial({ map: canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#3a1710'; g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 32) for (let x = (y / 32) % 2 ? 16 : 0; x < w; x += 32) { const gr = g.createRadialGradient(x, y, 1, x, y, 18); gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - 18, y - 18, 36, 36); }
}, [3, 1]), roughness: .4, clearcoat: .5, clearcoatRoughness: .3 });
export function couch(x, z, yaw) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = yaw; scene.add(g);
  add(new THREE.BoxGeometry(2.1, .28, .88), oxblood, [0, .2, 0], null, { parent: g, cast: true });
  add(new THREE.BoxGeometry(1.8, .1, .66), oxblood, [0, .37, .06], null, { parent: g });
  add(new THREE.BoxGeometry(2.1, .44, .22), oxblood, [0, .56, -.33], null, { parent: g, cast: true });
  for (const s of [1, -1]) { add(new THREE.BoxGeometry(.16, .3, .88), oxblood, [s * .97, .45, 0], null, { parent: g }); const r = new THREE.CylinderGeometry(.11, .11, .88, 20); r.rotateX(Math.PI / 2); add(r, oxblood, [s * .97, .62, 0], null, { parent: g }); }
  for (const s of [1, -1]) for (const t of [1, -1]) add(new THREE.CylinderGeometry(.03, .022, .06, 10), BRASS, [s * .95, .03, t * .38], null, { parent: g });
}
// rug, two couches facing over a coffee table, a floor lamp, and a light over them with no fixture on the roof
{
  const { x, z } = LOUNGE.couches;
  add(new THREE.PlaneGeometry(4.6, 4.2), new THREE.MeshStandardMaterial({ map: canvasTex(512, 512, (g, w, h) => { g.fillStyle = '#14100d'; g.fillRect(0, 0, w, h); g.strokeStyle = '#8a6a34'; g.lineWidth = 6; g.strokeRect(20, 20, w - 40, h - 40); g.lineWidth = 2; g.strokeRect(36, 36, w - 72, h - 72); }), roughness: .95 }), [x, .005, z], [-Math.PI / 2, 0, 0]);
  couch(x, z - 1.2, 0); couch(x, z + 1.2, Math.PI);
  add(new THREE.BoxGeometry(1.4, .05, .7), new THREE.MeshStandardMaterial({ map: marbleTex('#0b0b0d', '200,195,185'), roughness: .1 }), [x, .42, z], null, { cast: true });
  for (const s of [1, -1]) for (const t of [1, -1]) add(new THREE.BoxGeometry(.03, .4, .03), BRASS, [x + s * .62, .2, z + t * .28]);
  add(new THREE.CylinderGeometry(.05, .07, .22, 16), new THREE.MeshPhysicalMaterial({ color: '#e8eef5', roughness: .05, transparent: true, opacity: .35 }), [x - .3, .555, z + .05]);
  add(new THREE.CylinderGeometry(.045, .065, .1, 16), WHISKEY, [x - .3, .5, z + .05]);
  const L = LOUNGE.lamp; // lit shade only: the light over the table lights the couches
  add(new THREE.CylinderGeometry(.012, .012, 1.6, 8), BRASS, [L.x, .8, L.z]);
  add(new THREE.CylinderGeometry(.16, .24, .3, 24, 1, true), new THREE.MeshStandardMaterial({ color: '#d9b98a', emissive: '#ffb066', emissiveIntensity: .9, side: THREE.DoubleSide }), [L.x, 1.65, L.z]);
  const l = new THREE.PointLight('#ffbd7a', 11, 10, 2); l.position.set(x, 3.4, z); scene.add(l);
}
// the bar: counter, stools, and the back bar on the back wall (mirror, lit shelves, bottles)
{
  const { x: bx, z: bz } = LOUNGE.bar, cz = bz - .3, wall = FLOOR.zMin;
  add(new THREE.BoxGeometry(6, 1.0, .5), new THREE.MeshStandardMaterial({ map: canvasTex(512, 128, (g, w, h) => { g.fillStyle = '#100c09'; g.fillRect(0, 0, w, h); for (let x = 0; x < w; x += 12) { g.fillStyle = 'rgba(200,150,80,.18)'; g.fillRect(x, 0, 2, h); } }, [6, 1]), roughness: .5 }), [bx, .5, cz], null, { cast: true });
  add(new THREE.BoxGeometry(6.2, .05, .8), new THREE.MeshStandardMaterial({ map: marbleTex('#0b0b0d', '200,195,185', [3, 1]), roughness: .08 }), [bx, 1.05, cz + .05], null, { cast: true });
  add(new THREE.BoxGeometry(6.2, .02, .02), BRASS, [bx, 1.03, cz + .45]);
  add(new THREE.BoxGeometry(6, .03, .03), BRASS, [bx, .2, cz + .28]);
  add(new THREE.PlaneGeometry(6, 1.6), new THREE.MeshStandardMaterial({ color: '#2b2a2f', metalness: 1, roughness: .06 }), [bx, 2.0, wall + .03]);
  add(new THREE.PlaneGeometry(6, .05), glow('#ffb066', 2.4), [bx, 1.18, wall + .04]);
  const bottles = [], cols = ['#7a3d0e', '#2d4a1e', '#c9b48a', '#5a1010', '#9a5a14'];
  const tinted = (geo, x, y, c) => { geo.translate(x, y, wall + .17); const n = geo.attributes.position.count, a = new Float32Array(n * 3); for (let k = 0; k < n; k++) c.toArray(a, k * 3); geo.setAttribute('color', new THREE.BufferAttribute(a, 3)); bottles.push(geo); };
  for (const y of [1.25, 1.85]) {
    add(new THREE.BoxGeometry(6, .03, .3), BRASS, [bx, y, wall + .17]);
    add(new THREE.PlaneGeometry(6, .5), glow('#ff9a3a', .55), [bx, y + .25, wall + .035]);
    for (let x = bx - 2.7; x < bx + 2.8; x += .16 + rand() * .1) {
      const h = .22 + rand() * .12, c = new THREE.Color(cols[(rand() * cols.length) | 0]);
      tinted(new THREE.CylinderGeometry(.035, .035, h, 12), x, y + .015 + h / 2, c);
      tinted(new THREE.CylinderGeometry(.012, .02, .07, 8), x, y + .015 + h + .035, c);
    }
  }
  add(mergeGeometries(bottles), new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: .1, transparent: true, opacity: .85, emissive: '#3a1a04', emissiveIntensity: .4 }), null, null, { receive: false });
  // a downward spot, so its reflection on the polished floor stays under the bar
  const l = new THREE.SpotLight('#ffb066', 22, 7, .75, .6, 2); l.position.set(bx, 3.2, cz + .5); l.target.position.set(bx, 0, cz + .5); scene.add(l, l.target);
  for (const x of [bx - 2, bx - .8, bx + .4]) {
    add(new THREE.CylinderGeometry(.21, .2, .07, 24), leather('#3a1710'), [x, .755, cz + .85], null, { cast: true });
    add(new THREE.CylinderGeometry(.022, .022, .72, 10), CHROME, [x, .37, cz + .85]);
    add(new THREE.CylinderGeometry(.2, .22, .03, 24), CHROME, [x, .015, cz + .85]);
    const ring = new THREE.TorusGeometry(.17, .01, 8, 28); ring.rotateX(Math.PI / 2); add(ring, CHROME, [x, .3, cz + .85]);
  }
}
// coffee station on the back wall
{
  const { x: cx, z: cz } = LOUNGE.coffee;
  add(new THREE.BoxGeometry(1.6, .9, .55), walnutDark, [cx, .45, cz], null, { cast: true });
  add(new THREE.BoxGeometry(1.66, .04, .6), new THREE.MeshStandardMaterial({ map: marbleTex('#0b0b0d', '200,195,185'), roughness: .1 }), [cx, .92, cz]);
  add(new THREE.BoxGeometry(1.6, .02, .02), BRASS, [cx, .9, cz + .29]);
  add(new THREE.BoxGeometry(.56, .42, .4), CHROME, [cx - .25, 1.15, cz - .04], null, { cast: true });
  add(new THREE.BoxGeometry(.58, .05, .42), BLACK, [cx - .25, 1.385, cz - .04]);
  for (const s of [-1, 1]) add(new THREE.CylinderGeometry(.03, .026, .07, 14), BLACK, [cx - .25 + s * .12, 1.0, cz + .2]);
  add(new THREE.BoxGeometry(.1, .018, .004), glow('#ffad42', 2.2), [cx - .25, 1.29, cz + .162]);
  for (let i = 0; i < 4; i++) add(G.mug, MUG, [cx + .28 + (i % 2) * .1, .99 + Math.floor(i / 2) * .1, cz - .05], [-Math.PI / 2, 0, 0]);
  add(new THREE.CylinderGeometry(.07, .08, .32, 18), BLACK, [cx + .6, 1.1, cz - .06]);
  add(new THREE.PlaneGeometry(1.5, .04), glow('#ffb066', 1.4), [cx, 1.6, cz - .26]);
  const l = new THREE.PointLight('#ffc78a', 3.5, 4, 2); l.position.set(cx, 2.1, cz + .9); scene.add(l);
}
