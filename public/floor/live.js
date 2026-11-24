// Applies each /api/hq floor payload: every roster agent stays at its desk, green with its work on its screens or red
// with its name on them; sessions and helpers (running subagents no roster figure shows) appear at the live seats while
// they work or wait, those who need one most first, and leave 2 polls after they stop. The ticker and the video wall
// count what is real, and the wall says how many still wait for a seat. Each figure's desk screens get its screen
// (lib/session.js screenOf): the center its newest step, a live seat's sides its steps and files.
import { CONFIG } from './data.js';
import { npcs, setWorking, setOff, addLivePerson, removePerson } from './life.js';
import { LIVE_SLOTS, showZones } from './rooms.js';
import { setCounts, setSeatWait } from './building.js';
import { addTag, refreshTag, deselectIf, refreshPanel } from './stage.js';
import { setLinks } from './links.js';
import { drawPanels } from './panels.js';
import { handUp } from './panel-data.js';

const sig = (f) => JSON.stringify([f.departments.map((d) => d.name), f.agents.map((a) => a.id + a.dept + (a.hangout || ''))]);
let built = null;
const IDLE_POLLS = 2; // a live figure idle this many polls in a row leaves (a session, a helper)
const idleFor = new Map(); // a figure's id -> the polls in a row it has been idle (a helper: gone from the payload)
const hashOf = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
const lookOf = (f, i) => { const L = f.sessionAvatars[i]; return { look: L.look, avatar: L.avatar }; };
const agentOf = (x, f) => x.s
  ? { id: x.id, sessionId: x.s.id, name: x.s.name, dept: 'Live session', live: true, inSession: true, ...lookOf(f, x.s.avatar) }
  : { id: x.id, name: x.h.name, forSession: x.h.forSession, dept: 'Live helper', live: true, helper: true, inSession: true, ...lookOf(f, hashOf(x.h.id) % f.sessionAvatars.length) };
function leave(P, id) { deselectIf(P); removePerson(P); idleFor.delete(id); }
// one more idle poll for a live figure: true once it has had its IDLE_POLLS and left
function idlePoll(P, id) {
  const n = (idleFor.get(id) || 0) + 1;
  if (n >= IDLE_POLLS) { leave(P, id); return true; }
  idleFor.set(id, n); setWorking(P, false); return false;
}

export function updateFloor(f) {
  if (built == null) built = sig(f);
  else if (sig(f) !== built) return location.reload(); // departments or roster changed in the config: rebuild
  const byId = new Map(npcs.map((P) => [P.agent.id, P]));
  for (const a of f.agents) {
    const P = byId.get(a.id);
    if (!P) continue;
    if (a.status) { // a desk that follows a heartbeat or a named session: its panel lines, and its monitor names the task (masked while streaming)
      Object.assign(P.agent, { source: a.source, status: a.status, task: a.task, summary: a.summary, updatedAt: a.updatedAt, badge: a.badge || null });
      const title = a.task || a.name;
      if (P.term.title !== title) { P.term.title = title; P.term.draw(); }
    }
    P.agent.waiting = a.waiting; P.handUp = handUp(a); // its hand goes up while something of it waits on the owner (stage.js)
    // switched off: its desk goes dark unless it is at work, which for an off agent is only a chat seated there by board
    // name (lib/hq.js deskOf; the server gives it no job). Its dot and panel say off either way.
    setOff(P, !!a.off && !a.working); P.agent.off = !!a.off;
    setWorking(P, a.working, a.doing); refreshTag(P);
    P.term.setScreen(a.screen || null); // a figure at work on a job or a named session shows its newest step
  }
  refreshPanel();
  showZones(new Set(f.agents.filter((a) => a.working).map((a) => a.dept))); // a department's label shows while one of its agents works
  // the live seats. Who needs one, in order: sessions and helpers waiting on the owner, then working sessions, then
  // working helpers. An idle session never comes in.
  const helpers = f.helpers || [];
  const live = [
    ...f.sessions.filter((s) => s.waiting || s.working).map((s) => ({ id: 's:' + s.id, s, rank: s.waiting ? 0 : 2 })),
    ...helpers.map((h) => ({ id: 'h:' + h.id, h, rank: (h.waiting || []).length ? 1 : 3 })),
  ];
  const want = new Map(live.map((x) => [x.id, x]));
  const seated = new Map(npcs.filter((P) => P.agent.live).map((P) => [P.agent.id, P]));
  // a session gone from the payload leaves at once, so a swap at a full room seats the newcomer in the same poll; one
  // that went idle, or a helper that stopped, sits with its screens dark for 2 polls, then leaves
  for (const [id, P] of seated) {
    if (want.has(id)) { idleFor.delete(id); continue; }
    if (id.startsWith('s:') && !f.sessions.some((s) => 's:' + s.id === id)) { leave(P, id); seated.delete(id); }
    else if (idlePoll(P, id)) seated.delete(id);
  }
  // the rest take the first free seat, a seat freed above among them
  let waitingForSeat = 0;
  for (const x of live.filter((x) => !seated.has(x.id)).sort((a, b) => a.rank - b.rank)) {
    const D = LIVE_SLOTS.find((d) => !d.owner);
    if (!D) { waitingForSeat++; continue; }
    const P = addLivePerson(agentOf(x, f), D); addTag(P); seated.set(x.id, P);
  }
  for (const x of live) {
    const P = seated.get(x.id);
    if (!P) continue;
    const doing = x.s ? x.s.action : x.h.lines[0] || null;
    setWorking(P, true, doing); // a waiting figure sits at its desk too, its hand raised
    const title = doing || (x.s ? x.s.name : x.h.name);
    if (P.term.title !== title) { P.term.title = title; P.term.draw(); } // the center screen names the task now, not at the next keystroke
    const screen = (x.s ? x.s.screen : x.h.screen) || null; // its newest step, steps and files
    P.term.setScreen(screen); if (P.desk.side) P.desk.side.forEach((S) => S.set(screen));
    P.agent.badge = x.s ? x.s.badge || null : null; // a session's tag line (stage.js drawBadge); a helper has none
    P.agent.waiting = x.s ? x.s.waiting : x.h.waiting; P.handUp = handUp(x.s || x.h);
    refreshTag(P);
  }
  const working = f.agents.filter((a) => a.working).length + f.sessions.filter((s) => s.working).length + helpers.length;
  setCounts(working, f.agents.length + f.sessions.length + helpers.length - working, CONFIG.sections.length);
  setSeatWait(waitingForSeat);
  drawPanels(f);
  setLinks(f.links || [], (id) => { const P = npcs.find((x) => x.agent.id === 's:' + id); return P ? P.desk : null; });
}
