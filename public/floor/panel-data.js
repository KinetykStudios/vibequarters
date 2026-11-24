// The room panels' rows, with no DOM (panels.js and switches.js draw them): the Live list as the Dashboard keeps it,
// Top tools' bars, the Sessions and Agents tabs, the agent switches' rows, whether a figure's hand is up, and whether a
// panel starts as a pill. Under Streamer a row's name is the mask and its free text has every known name masked in
// place, the way the Dashboard's Live list does it; the numbers stay.
import { WANT, waitText, dur, usd } from '../format.js';
import { MASK, streaming, splitNames } from '../streamer.js';
import { ctxWarn, cacheWarn } from '../warn.js';

// The built-in subagent types every chat starts: an agent that blocks one blocks it for every chat
export const WIDE = new Set(['general-purpose', 'claude', 'Plan', 'Explore']);
export const WIDE_WARN = 'Every chat uses this type: while it is off, no chat can start one.';
export const PANELS = [{ key: 'live', title: 'Live' }, { key: 'deploys', title: 'Deploys' }, { key: 'tools', title: 'Top tools' }, { key: 'team', title: 'Sessions and agents' }, { key: 'assistant', title: 'Assistant' }];

// In Live: a chat in use, an idle one only while something of it is open for the owner, never the HQ assistant's own
// chat, which has its own panel
export const inLive = (s, needs) => !s.assistant && (s.status !== 'idle' || needs(s.id) > 0);
// Live: those chats, in the caller's order (attentionFirst). Its line is what it needs from the owner, else what it
// waits on, else what it is doing, as segments for el().
export function liveList(sessions, { needs, want, names }) {
  const on = streaming();
  return sessions.filter((s) => inLive(s, needs)).map((s) => {
    const w = want(s.id);
    const text = w ? WANT[w] : waitText(s) || s.action || s.task || '';
    return { id: s.id, st: needs(s.id) > 0 ? 'needs-you' : s.status, name: on ? MASK : s.title || s.name, nameMasked: on, doing: splitNames(text, on ? names : []) };
  });
}

// Top tools: today's top 5 tools, each bar its share of the top one, and today's total (null until stats are read)
export function toolBars(vitals) {
  const top = ((vitals && vitals.byToolToday) || []).slice(0, 5);
  return {
    total: vitals && vitals.toolCallsToday != null ? vitals.toolCallsToday : null,
    rows: top.map((t) => ({ name: t.name, count: t.count, pct: Math.round((100 * t.count) / top[0].count) })),
  };
}

// Sessions: the newest 12 chats with their prompt cache, how full their context is and spend, each with its warning
// level (warn.js: amber "warn" or red "bad")
export function sessionList(sessions, now) {
  return sessions.slice().sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 12).map((s) => {
    const ctx = s.context ? s.context.pct : null;
    const warm = !!s.cache && s.cache.state === 'warm';
    const cw = cacheWarn(s, now), xw = ctxWarn(s);
    return {
      id: s.id,
      name: streaming() ? MASK : s.title || s.name,
      cache: !s.cache ? '-' : warm ? 'Warm, ' + dur(s.cache.expiresAt - now) + ' left' : 'Cold',
      cold: !!s.cache && !warm,
      cacheLevel: cw ? cw.level : null,
      ctx,
      ctxLevel: xw ? xw.level : null,
      spend: usd(s.cost),
    };
  });
}

// Agents: each roster agent off, working or idle (an off desk reads off even while a seated chat works at it), and what
// it is doing; under Streamer only the state word.
const STATE = { off: 'Off', working: 'Working', idle: 'Idle' };
export function agentList(agents) {
  const on = streaming();
  return agents.map((a) => {
    const st = a.off ? 'off' : a.working ? 'working' : 'idle';
    return { id: a.id, name: on ? MASK : a.name, st, doing: !on && st === 'working' && a.doing ? a.doing : STATE[st] };
  });
}

// The agent switches: each agent's subagent types, which an off switch blocks in every chat, and whether one of them
// is a built-in type (WIDE)
export function switchRows(agents) {
  return agents.map((a) => {
    const blocks = a.agentTypes || [];
    return {
      id: a.id, name: a.name, on: !a.off, blocks, wide: blocks.some((p) => WIDE.has(p)),
      line: blocks.length ? 'Blocks ' + blocks.join(', ') + ' in every chat' : 'Nothing to block yet: its desk only goes dark',
    };
  });
}

// A figure's hand is up while something of it waits on the owner: true for an agent or a session, open item ids for a
// helper
export const handUp = (x) => (Array.isArray(x.waiting) ? x.waiting.length > 0 : x.waiting === true);
// A panel starts as a pill when the owner minimized it, open when they opened it, and else as a pill on a phone-width
// screen
export const startMin = (width, stored) => (stored === 'min' ? true : stored === 'open' ? false : width <= 720);
