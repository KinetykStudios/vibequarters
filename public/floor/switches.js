// The agent switches: one for every agent and one per agent, in a pop-up over the room (the Switches button in the
// Sessions and agents header opens it) and at the end of each Agents row. Each pop-up row says what its switch blocks
// (panel-data.js switchRows). A flip posts { id, on } or { all: true, on } (server.js /api/agents); while it is out the
// switch already shows its new place and takes no clicks until the payload matches or 15 s go by, as chat.js's
// keep-warm switch waits. A failed post puts it back at once and says so. With control off (no token) every switch is
// disabled and one line says why. While Claude Code's settings have no hook that enforces the switches (the payload's
// floor.switchesEnforced) the note says so: a switch then only changes the page. The every-agent switch is on while
// every agent is on; with any off, it turns them all on. Under Streamer a name is the mask and what a switch blocks
// reads "Hidden while streaming". The pop-up lives inside #floor, so it shows in full screen; Esc or a click outside
// closes it, Tab stays inside, and focus goes back to the button that opened it. A switch's state is written in place,
// and only when it changed, so a poll that brings nothing new writes nothing.
import { el } from '../dom.js';
import { container } from './data.js';
import { post, canAnswer } from '../control.js';
import { shown, streaming, onStreaming } from '../streamer.js';
import { switchRows, WIDE_WARN } from './panel-data.js';

const ALL = Symbol('all'); // the every-agent switch's key: no agent id can be it
const HELD_MS = 15e3;
const NO_CONTROL = 'Switches work when VibeQuarters runs with control on';
const NOT_ENFORCED = 'Install the system pack to enforce switches: until then an off switch only darkens the desk.';
const NOT_SAVED = 'The switch did not save. Try again in a moment';
const HIDDEN = 'Hidden while streaming';
const put = (n, t) => { if (n.textContent !== t) n.textContent = t; };
const attr = (n, k, v) => { if (n.getAttribute(k) !== v) n.setAttribute(k, v); };
const hide = (n, h) => { if (n.hidden !== h) n.hidden = h; };

let agents = []; // the last payload's floor.agents
const wants = new Map(); // a switch's key -> { key, on, at } while its flip is on its way
let failed = false; // the last flip did not save: the note says so until the next flip
let enforced = true; // whether Claude Code runs the hook that enforces the switches, as the last payload says
const views = new Set(); // every switch drawn: { btn, key, name, fixed }; one gone from the page is dropped
const notes = new Set(); // every note line drawn

const isOn = (key) => (key === ALL ? agents.length > 0 && agents.every((a) => !a.off) : !(agents.find((a) => a.id === key) || {}).off);
const held = (key) => wants.has(key) || wants.has(ALL) || (key === ALL && wants.size > 0);
const noteText = () => (!canAnswer() ? NO_CONTROL : failed ? NOT_SAVED : enforced ? '' : NOT_ENFORCED);

function paint(v) {
  const w = wants.get(v.key) || (v.key !== ALL ? wants.get(ALL) : undefined), on = w ? w.on : isOn(v.key), off = !canAnswer() || held(v.key);
  attr(v.btn, 'aria-checked', String(on));
  attr(v.btn, 'aria-label', (v.fixed ? v.name : shown(v.name)) + (on ? ', on' : ', off'));
  if (v.btn.disabled !== off) v.btn.disabled = off;
}
function sync() {
  for (const v of views) if (v.btn.isConnected) paint(v); else views.delete(v);
  const t = noteText();
  for (const n of notes) {
    if (!n.isConnected) { notes.delete(n); continue; }
    put(n, t);
    hide(n, !t);
  }
}
async function flip(key) {
  if (!canAnswer() || held(key)) return;
  const want = { key, on: !isOn(key), at: Date.now() };
  wants.set(key, want);
  failed = false;
  sync();
  const reply = await post('/api/agents', key === ALL ? { all: true, on: want.on } : { id: key, on: want.on });
  if (reply) return; // saved: the want stays until the payload shows it
  if (wants.get(key) === want) wants.delete(key);
  failed = true;
  sync();
}
function makeSwitch(key, name, fixed = false) {
  const v = { key, name, fixed, btn: el('button', { type: 'button', class: 'sw-t', role: 'switch', onclick: () => flip(key) }) };
  views.add(v);
  paint(v);
  return v;
}
// An Agents row's switch: a 30 x 17 button[role=switch], its label the agent's name (masked under Streamer) and its state
export const switchEl = (row) => makeSwitch(row.id, row.name).btn;
// The note line: why every switch is disabled, that the last flip did not save, or that nothing enforces the switches
// yet; empty and hidden otherwise
export function noteEl(tag = 'p') {
  const n = el(tag, { class: 'sw-note', 'aria-live': 'polite' });
  notes.add(n);
  const t = noteText();
  n.textContent = t;
  n.hidden = !t;
  return n;
}

// ---------- the pop-up
const ALL_BLOCKS = 'Blocks every type listed below, in every chat';
const pop = { open: false, opener: null, rows: new Map(), ids: null };
pop.x = el('button', { type: 'button', class: 'x', 'aria-label': 'Close', text: '×', onclick: () => closeSwitches() });
pop.all = makeSwitch(ALL, 'All agents', true);
pop.allLine = el('p', { class: 'sw-l' }); // what the every-agent switch blocks, written by fillPop as the rows' lines are
pop.allWarn = el('p', { class: 'sw-w', text: WIDE_WARN, hidden: true });
pop.list = el('ul', { class: 'sw-rows' });
pop.root = el('section', { class: 'sw', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sw-title', hidden: true },
  pop.x, el('h2', { id: 'sw-title', text: 'Agent switches' }), noteEl(),
  el('div', { class: 'sw-all' }, el('div', { class: 'sw-r' }, el('span', { class: 'sw-nm', text: 'All agents' }), pop.all.btn), pop.allLine, pop.allWarn),
  pop.list,
  el('p', { class: 'sw-f', text: 'A * at the end of a type means every type that starts with it' }),
  el('p', { class: 'sw-f', text: 'Workflow agents are not blocked.' }),
  el('p', { class: 'sw-f', text: 'A subagent already running finishes its work.' }));
container.append(pop.root);

// a row per agent, built once while the pop-up is open and written in place: its name, its switch, what it blocks and,
// for a built-in type, the warning. The every-agent row says it blocks all of them, with the warning while any row
// carries it.
function popRow(r) {
  const x = { nm: el('span', { class: 'sw-nm' }), sw: makeSwitch(r.id, r.name), line: el('p', { class: 'sw-l' }), warn: el('p', { class: 'sw-w', text: WIDE_WARN }) };
  x.li = el('li', {}, el('div', { class: 'sw-r' }, x.nm, x.sw.btn), x.line, x.warn);
  return x;
}
function fillPop() {
  const on = streaming(), rows = switchRows(agents), ids = rows.map((r) => r.id).join('\n');
  if (ids !== pop.ids) {
    pop.ids = ids;
    pop.rows = new Map(rows.map((r) => [r.id, popRow(r)]));
    pop.list.replaceChildren(...[...pop.rows.values()].map((x) => x.li));
  }
  put(pop.allLine, on ? HIDDEN : ALL_BLOCKS);
  hide(pop.allWarn, !rows.some((r) => r.wide));
  for (const r of rows) {
    const x = pop.rows.get(r.id);
    x.sw.name = r.name;
    put(x.nm, shown(r.name));
    x.nm.classList.toggle('masked', on);
    put(x.line, on ? HIDDEN : r.line);
    hide(x.warn, !r.wide);
  }
}
// `from` is the control focus goes back to (panels.js passes its Switches button); by default the focused element
export function openSwitches(from = document.activeElement) {
  if (pop.open) return;
  pop.open = true;
  pop.opener = from && from !== document.body ? from : null;
  fillPop();
  sync();
  hide(pop.root, false);
  pop.x.focus({ preventScroll: true });
}
function closeSwitches() {
  if (!pop.open) return;
  pop.open = false;
  hide(pop.root, true);
  pop.list.replaceChildren(); // a closed pop-up keeps no names
  pop.rows.clear();
  pop.ids = null;
  if (pop.opener && pop.opener.isConnected) pop.opener.focus({ preventScroll: true });
  pop.opener = null;
}

// Every payload (panels.js drawPanels): a flip the payload now shows, or one out for 15 s, stops waiting
export function drawSwitches(list, isEnforced = true) {
  agents = list || [];
  enforced = isEnforced !== false;
  const now = Date.now();
  for (const w of [...wants.values()]) if (isOn(w.key) === w.on || now - w.at > HELD_MS) wants.delete(w.key);
  if (pop.open) fillPop();
  sync();
}
onStreaming(() => {
  if (pop.open) fillPop();
  sync();
});

// Esc closes the pop-up and Tab stays inside it (the trap from chat.js), while focus is in it or nowhere (a switch just
// pressed is disabled while its flip is out); a press anywhere outside it closes it too
addEventListener('keydown', (e) => {
  if (!pop.open || !(pop.root.contains(document.activeElement) || document.activeElement === document.body)) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeSwitches();
  } else if (e.key === 'Tab') {
    const f = [...pop.root.querySelectorAll('button')].filter((n) => !n.disabled && !n.closest('[hidden]'));
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (i < 0) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
    else if (e.shiftKey && i === 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  }
}, true);
document.addEventListener('pointerdown', (e) => {
  if (pop.open && !pop.root.contains(e.target) && !(pop.opener && pop.opener.contains(e.target))) closeSwitches();
}, true);
