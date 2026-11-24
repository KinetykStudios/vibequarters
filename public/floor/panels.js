// The five glass panels over the room (panel-data.js PANELS): Live, Deploys, Top tools, Sessions and agents, and the
// Assistant (assistant.js draws its body). Each is a header with its title, a muted count and a minimize button, a
// body, and a pill (its title and count) that stands in for it, in the same corner, while it is minimized. Built at
// import, as stage.js builds its controls; drawPanels takes every floor payload, with the payload's sessions, vitals
// and masked names under f.panels (app.js). A minimized panel holds no nodes in its body. Each choice is kept in
// localStorage (hq.panel.<key>, "min" or "open"); with none, a panel starts as a pill at phone width (startMin). At 720
// px and under one panel at most is open: opening one minimizes the others, and so does a start or a narrowing with
// more than one open, none of it saved.
// An open panel draws only when its rows or Streamer changed since it last drew, so a poll that brings nothing new
// writes nothing; Live's Needs you cards are written on every poll by needs.js, which writes only what changed. Under
// Streamer a name is the mask and a commit subject too; numbers stay. The agent switches (switches.js) open from a
// Switches button in the Sessions and agents header, and each Agents row ends with its agent's switch.
import { el } from '../dom.js';
import { hooks } from './data.js';
import { $ } from './stage.js';
import { attentionFirst, needsOf, wantOf, renderOpenAsks } from '../needs.js';
import { MASK, streaming, shown, onStreaming } from '../streamer.js';
import { num, dur, count } from '../format.js';
import { PANELS, startMin, liveList, toolBars, sessionList, agentList } from './panel-data.js';
import { openSwitches, drawSwitches, switchEl, noteEl } from './switches.js';
import { mountAssistant } from '../assistant.js';
import { statusWord, RB_TITLE } from '../assistant-rules.js';

const NARROW = matchMedia('(max-width:720px)');
const load = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key, v) => { try { localStorage.setItem(key, v); } catch {} };
const put = (n, t) => { if (n.textContent !== t) n.textContent = t; }; // text written only when it changes
const span = (cls, text) => el('span', { class: cls, text });
const said = (parts) => parts.map((x) => (x.masked ? span('masked', MASK) : x.text)); // free text, a known name masked in place
const NO_PANELS = { sessions: [], vitals: null, names: [] };
const NO_CHATS = 'No live sessions. Start one and it shows up here within a few seconds.'; // the Dashboard's Live list says it so

// Deploys: the last builds of the repo hq.config.json names under deploys (lib/deploys.js), each while it builds or for
// the hour after it ended, at most 3, a build past twice the usual length in red; null when the payload has no deploys
const WALL_MS = 60 * 60e3, SLOW_X = 2; // a build past SLOW_X times the usual length is slow
const WORD = { building: 'Building', ready: 'Live', failed: 'Failed' };
function deployRows(d, now) {
  if (!d) return null;
  const items = d.items ? d.items.filter((x) => x.startedAt && (x.state === 'building' || now - (x.endedAt || 0) < WALL_MS)).slice(0, 3) : [];
  return {
    branch: 'Deploys to ' + d.branch, usual: 'usual ' + dur(d.usual), error: d.error ? 'Not updating: ' + d.error : null,
    items: items.map((x) => {
      const ms = x.state === 'building' ? now - x.startedAt : x.ms, slow = x.state === 'building' && ms > SLOW_X * d.usual;
      return { st: x.state, slow, word: WORD[x.state] || x.state, subject: shown(x.subject || x.sha), time: slow ? dur(ms) + ', past 2x usual' : x.state === 'building' ? dur(ms) + ' so far' : dur(ms) };
    }),
  };
}

// The Sessions and agents panel's tab, remembered
let tab = load('hq.panel.team.tab') === 'agents' ? 'agents' : 'sessions';

// Each panel: its rows from the payload, its count from them, and how its body draws them
const SPEC = {
  live: {
    rows: (f, P) => liveList(attentionFirst(P.sessions), { needs: needsOf, want: wantOf, names: P.names }),
    count: (rows) => count(rows.length, 'chat'),
    // rows kept by chat and written in place, so a row keeps its focus and a click across a poll lands
    fill: (p, rows) => {
      if (!rows.length) {
        p.rows.clear();
        return p.list.replaceChildren(el('li', { class: 'pp-none', text: NO_CHATS }));
      }
      p.rows = new Map(rows.map((r) => [r.id, patchLive(p.rows.get(r.id) || liveRow(r.id), r)]));
      let at = p.list.firstChild;
      for (const row of p.rows.values()) {
        if (row.li === at) at = at.nextSibling;
        else p.list.insertBefore(row.li, at);
      }
      while (at) { const next = at.nextSibling; at.remove(); at = next; } // what is left after them is gone from the list
    },
  },
  deploys: {
    rows: (f, P, now) => deployRows(f.deploys || null, now),
    count: (r) => (r ? count(r.items.length, 'build') : ''),
    fill: (p, r) => p.body.replaceChildren(...(!r ? [el('p', { class: 'pp-none', text: 'Deploys are not set up' })] : [
      el('p', { class: 'dw-h' }, span('', r.branch), span('dw-u', r.usual)),
      r.items.length ? el('ul', {}, ...r.items.map((x) => el('li', { class: 'dw-' + x.st + (x.slow ? ' dw-slow' : '') }, span('dw-st', x.word), span('dw-s' + (streaming() ? ' masked' : ''), x.subject), span('dw-t', x.time))))
        : el('p', { class: 'pp-none', text: 'Nothing built in the last hour' }),
      ...(r.error ? [span('dw-e', r.error)] : []),
    ])),
  },
  tools: {
    rows: (f, P) => toolBars(P.vitals),
    count: (r) => (r.total == null ? '' : count(r.total, 'call')),
    // the bars, then today's total; with no calls today, or none counted yet, one muted line in its place
    fill: (p, r) => p.body.replaceChildren(
      ...r.rows.map((t) => el('div', { class: 'pp-tool' }, span('pp-tn', t.name), el('span', { class: 'pp-track' }, el('b', { style: { width: t.pct + '%' } })), span('pp-num', num(t.count)))),
      r.total ? el('p', { class: 'pp-total', text: count(r.total, 'tool call') + ' today' })
        : el('p', { class: 'pp-none', text: r.total == null ? "Today's tool calls are not counted yet" : 'No tool calls yet today' })),
  },
  team: {
    rows: (f, P, now) => ({ tab, list: tab === 'agents' ? agentList(f.agents) : sessionList(P.sessions, now) }),
    // the chats the Sessions tab shows (its newest 12), and how many there are when that is fewer than all
    count: (r, f, P) => {
      const shownN = sessionList(P.sessions, 0).length, all = P.sessions.length;
      return (shownN < all ? shownN + ' of ' : '') + count(all, 'chat') + ', ' + count(f.agents.length, 'agent');
    },
    fill: (p, r) => {
      for (const b of p.tabs.children) b.setAttribute('aria-pressed', String(b.dataset.tab === r.tab));
      p.list.replaceChildren(...(r.tab === 'agents' ? [noteEl('li'), ...r.list.map(agentRow)] : r.list.length ? [SESSION_HEAD(), ...r.list.map(sessionRow)] : [el('li', { class: 'pp-none', text: NO_CHATS })]));
    },
  },
  assistant: {
    // its state in fixed words on the header and the pill (a read-back waiting for the owner's yes first, so even the
    // pill of a minimized panel says so; then an open approve window; the offline reason, free text, only in the body);
    // the body is assistant.js's, mounted once each time the panel opens, and it draws every payload itself (app.js
    // setAssistant), so a new state word never rebuilds the box the owner is typing in
    rows: (f, P) => ({ word: P.readbacks && P.readbacks.length ? RB_TITLE : P.window && P.window.open ? 'Approving' : statusWord(P.assistant && P.assistant.state && { status: P.assistant.state.status }) }),
    count: (r) => r.word,
    fill: (p) => { if (!p.body.firstChild) mountAssistant(p.body, { compact: true }); },
  },
};

// Live: a chat's status dot, its name and what it needs from the owner, waits on or is doing; a click opens its chat. A
// row is built once per chat and patched: its dot, its name and, when it changed, its doing line, as the Dashboard's
// rows are.
function liveRow(id) {
  const row = { dot: el('i', { class: 'dot' }), nm: span('pp-nm', ''), doing: el('span', { class: 'pp-do' }), doKey: null };
  row.li = el('li', {}, el('button', { type: 'button', class: 'pp-row', onclick: () => hooks.openSession(id) }, row.dot, row.nm, row.doing));
  return row;
}
function patchLive(row, r) {
  const dot = 'dot s-' + r.st, nm = 'pp-nm' + (r.nameMasked ? ' masked' : ''), doKey = JSON.stringify(r.doing);
  if (row.dot.className !== dot) row.dot.className = dot;
  if (row.nm.className !== nm) row.nm.className = nm;
  put(row.nm, r.name);
  if (row.doKey !== doKey) {
    row.doKey = doKey;
    row.doing.replaceChildren(...(r.doing.length ? said(r.doing) : ['No tool calls yet']));
  }
  return row;
}
// Sessions: the chat's name, its prompt cache, how full its context is (amber or red past warn.js's lines; a muted dash
// when unknown) and its spend
const SESSION_HEAD = () => el('li', { class: 'pp-sx pp-sh' }, span('', 'Chat'), span('', 'Cache'), span('', 'Context'), span('pp-num', 'Spent'));
const sessionRow = (s) => el('li', { class: 'pp-sx' }, span('pp-nm' + (streaming() ? ' masked' : ''), s.name), span(s.cold ? 'cold' : s.cache === '-' ? '' : s.cacheLevel ? 'w-' + s.cacheLevel : 'warm', s.cache),
  s.ctx == null ? span('pp-none', '-') : el('span', { class: 'pp-ctx' + (s.ctxLevel ? ' ' + s.ctxLevel : ''), title: 'Context ' + s.ctx + '% full' }, el('b', { style: { width: s.ctx + '%' } })), span('pp-num', s.spend));
// Agents: the agent's dot (off, working or idle), its name, what it is doing and its switch; the name sits in its own
// block. Above the rows, the switches' note line (empty and hidden unless a switch cannot work or did not save).
const DOT = { off: 'd-off', working: 'd-work', idle: 'd-idle' };
const agentRow = (a) => el('li', { class: 'pp-ag' }, el('i', { class: 'dot ' + DOT[a.st] }),
  el('span', { class: 'pp-who' }, span('pp-nm' + (streaming() ? ' masked' : ''), a.name)), span('pp-do', a.doing), switchEl(a));

let last = null; // the last floor payload
const panels = PANELS.map(({ key, title }) => {
  const p = { key, title, drawn: null, n: span('pp-n', ''), pillN: span('pp-n', ''), body: el('div', { class: 'pp-b' }) };
  p.minBtn = el('button', { type: 'button', class: 'pp-min', 'aria-label': 'Minimize ' + title, onclick: () => { setMin(p, true); p.pill.focus(); } });
  p.pill = el('button', { type: 'button', class: 'pp-pill', onclick: () => { setMin(p, false); p.minBtn.focus(); } }, title, ' ', p.pillN);
  if (key === 'team') p.swBtn = el('button', { type: 'button', class: 'pp-sw', text: 'Switches', onclick: () => openSwitches(p.swBtn) });
  p.root = el('section', { class: 'pp pp-' + key, 'aria-label': title }, el('div', { class: 'pp-h' }, el('h2', { text: title }), p.n, p.swBtn, p.minBtn), p.body, p.pill);
  if (key === 'team') p.tabs = el('div', { class: 'pp-tabs' }, ...[['sessions', 'Sessions'], ['agents', 'Agents']].map(([k, label]) =>
    el('button', { type: 'button', class: 'pp-tab', 'data-tab': k, 'aria-pressed': 'false', onclick: () => setTab(p, k), text: label })));
  p.min = startMin(innerWidth, load('hq.panel.' + key));
  p.root.classList.toggle('min', p.min);
  return p;
});
$('pp-layer').append(...panels.map((p) => p.root));
// At 720 px and under at most one panel is open: the first open one in PANELS order stays, the rest become pills without
// saving, at start (two stored "open") and whenever the screen narrows past 720 px. Widened past it again, each pill
// that rule made opens again, unsaved; one the owner minimized (stored "min") stays a pill.
function narrowOne() {
  if (!NARROW.matches) {
    for (const p of panels) if (p.min && !startMin(innerWidth, load('hq.panel.' + p.key))) setMin(p, false, false);
    return;
  }
  let kept = false;
  for (const p of panels) {
    if (p.min) continue;
    if (kept) setMin(p, true, false);
    kept = true;
  }
}
narrowOne();
NARROW.addEventListener('change', narrowOne);

// Minimizing empties the body and saves "min"; opening saves "open" and draws at once. At phone width an opened panel
// minimizes the others, unsaved, so each keeps the choice made for it.
function setMin(p, on, saved = true) {
  p.min = on;
  p.root.classList.toggle('min', on);
  if (saved) save('hq.panel.' + p.key, on ? 'min' : 'open');
  if (on) {
    p.drawn = null;
    return p.body.replaceChildren();
  }
  if (NARROW.matches) for (const o of panels) if (o !== p && !o.min) setMin(o, true, false);
  draw(p);
}
function setTab(p, k) {
  tab = k;
  save('hq.panel.team.tab', k);
  draw(p);
}

// A panel's count, in its header and on its pill; then, open, its body: Live's cards on every poll, and the rows when
// they or Streamer changed since the body last drew them
function draw(p) {
  if (!last) return;
  const P = last.panels || NO_PANELS, S = SPEC[p.key], rows = S.rows(last, P, Date.now()), n = S.count(rows, last, P);
  put(p.n, n);
  put(p.pillN, n);
  if (p.min) return;
  if (p.key === 'live') {
    if (!p.body.firstChild) {
      p.body.append((p.cards = el('div', { class: 'pp-cards' })), (p.list = el('ul', { class: 'pp-rows' })));
      p.rows = new Map(); // the rows by chat id, for this list
    }
    renderOpenAsks(p.cards);
  } else if (p.key === 'team' && !p.body.firstChild) p.body.append(p.tabs, (p.list = el('ul', { class: 'pp-rows' })));
  const key = JSON.stringify([rows, streaming()]);
  if (key === p.drawn) return;
  p.drawn = key;
  S.fill(p, rows);
}

export function drawPanels(f) {
  last = f;
  drawSwitches(f.agents, f.switchesEnforced); // first, so a switch drawn below already knows this payload's agents and flips
  for (const p of panels) draw(p);
}
// A Streamer toggle draws every open panel again at once, masked or not, its Needs you cards among them
onStreaming(() => {
  for (const p of panels) {
    p.drawn = null;
    draw(p);
  }
});
