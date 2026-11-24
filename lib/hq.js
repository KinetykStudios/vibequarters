// Joins live transcripts, their subagents and the coordination board into the /api/hq payload.
// update() runs on the server's refresh tick; payload() and json() are cheap reads of the result.
const fs = require("fs");
const path = require("path");
const { newCursor, readNew } = require("./tail");
const { newSession, foldSession, statusOf, sparkOf } = require("./session");
const { newProgress, foldProgress, progressView } = require("./progress");
const { newCache, foldCache, cacheView, rewarm } = require("./cache");
const { boardView, clean } = require("./board");
const { newCollab, foldCollab, collabView } = require("./collab");
const { describe, describeReply } = require("./describe");
const { newScreens, foldScreen, screenOf, shotOf } = require("./session"); // The desk screens
const { checkShot } = require("./shots");
const { createChats } = require("./chat");
const { pidAlive } = require("./decisions");
const { randomBytes } = require("crypto");
const { weekUsage } = require("./usage");

const LIVE_MS = 15 * 60e3;
const GRACE_MS = 2 * 60 * 60e3; // a tracker outlives its session's live window by this, so a break shorter than that never costs a full re-read
const MAX_SUBS = 12;
const MAX_LIST = 20; // delegations and handoffs per session
const MAX_FLOW = 60;
const DAY = 86400e3;
const QUIET_MS = 2 * 60 * 60e3; // a running delegation with no write for this long reads as quiet
// A background job a chat waits on: one with no news for an hour most likely died with its chat's restart, and a server
// (by its description) never ends, so neither is awaited. A watch counts until its own timeout.
const BG_MAX = 60 * 60e3;
const SERVER = /\b(serve|server|serving|harness)\b|\bport \d{2,5}\b/i;
const FRESH_MS = 5 * 60e3; // a message this recent makes its link flow
const MOVED_MS = 2000; // a chat's row this soon after a notice was asked is still the asking turn
// A main chat whose request just left (answered, or ended by the bridge) still reads that prompt in its transcript until
// the refresh that reads the next row (4 s apart): no reply item for it until a row lands after the request left, or
// this long after, when a prompt still waiting in VS Code shows again as a reply item
const HELD_MS = 15e3;
const ORDER = { "needs-you": 0, working: 1, thinking: 2, idle: 3 };
// A heartbeat file (an agent that is not a subagent writes it with temp plus rename): { agent, status, task,
// startedAt, endedAt, summary }. Its text comes from AI answers and web pages, so it is kept short and only ever text.
const BEAT_MAX = 64 * 1024;
const BEAT_STATUS = new Set(["working", "idle", "failed"]);
const TASK_MAX = 200;
const LINE_MAX = 300;
const LINES_MAX = 5;
const SUB_ID = /^a[0-9a-f]{16}$/; // a subagent file's id: subagents/agent-<id>.jsonl
const matches = (type, pats) => (pats || []).some((p) => (p.endsWith("*") ? type.startsWith(p.slice(0, -1)) : type === p));
const hash = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
const RANK = { permission: 0, question: 1, reply: 2 }; // the Needs you queue: permissions, then questions, then finished turns
const FAIL_RUN = 3; // this many failed tool calls in a row flag a desk as stuck

function tracker(fp, id, sub = false) {
  return { fp, sub, cursor: newCursor(), s: newSession(id), p: newProgress(), c: newCache(), k: newCollab() };
}
// Folds what the file has gained since the tracker last read it, one chunk at a time, giving the event loop a turn
// between chunks so HTTP requests interleave with a long first read.
async function pump(t, chunk) {
  for (;;) {
    const { lines, cursor, reset, more } = readNew(t.fp, t.cursor, chunk);
    if (reset) Object.assign(t, tracker(t.fp, t.s.id, t.sub));
    if (reset || !t.v) t.v = newScreens(); // The screen of the newest step
    t.cursor = cursor;
    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      // Every row of a subagent's own file is marked sidechain;
      // in that file it is the main line, and the fold functions skip sidechain rows.
      if (t.sub && row.isSidechain) row = { ...row, isSidechain: false };
      foldSession(t.s, row);
      foldProgress(t.p, row);
      foldCache(t.c, row);
      foldCollab(t.k, row);
      foldScreen(t.v, row);
    }
    if (!more) return;
    await new Promise((r) => setImmediate(r));
  }
}
function readMeta(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch {
    return {};
  }
}
// At most n characters (code points, so no emoji is cut in half); a cut line ends in an ellipsis.
function cap(s, n) {
  const c = [...s];
  return c.length > n ? c.slice(0, n - 1).join("") + "\u2026" : s;
}
const UNREAD = Symbol("unread"); // a read that failed after a good stat (a scanner holding the file, say)
// A heartbeat file's contents, or null for anything that is not one: over 64 KB, not JSON, the wrong shape; UNREAD
// when the read itself fails. At most 64 KB and one byte is ever read, so a file that grew after its stat is never
// loaded whole.
function readBeat(fp) {
  let fd, n = 0;
  const buf = Buffer.alloc(BEAT_MAX + 1);
  try {
    fd = fs.openSync(fp, "r");
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, n);
      if (!got) break;
      n += got;
    }
  } catch {
    return UNREAD;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  if (n > BEAT_MAX) return null; // it grew past 64 KB between the stat and the read
  let b;
  try {
    b = JSON.parse(buf.toString("utf8", 0, n));
  } catch {
    return null;
  }
  const time = (t) => t == null || typeof t === "string";
  if (!b || typeof b !== "object" || !BEAT_STATUS.has(b.status) || typeof b.task !== "string") return null;
  if (!Array.isArray(b.summary) || !b.summary.every((l) => typeof l === "string") || !time(b.startedAt) || !time(b.endedAt)) return null;
  const at = Date.parse(b.endedAt || b.startedAt);
  return { status: b.status, task: cap(b.task, TASK_MAX), summary: b.summary.slice(0, LINES_MAX).map((l) => cap(l, LINE_MAX)), updatedAt: Number.isFinite(at) ? at : null };
}

// The sessions whose chat is open: while one runs, Claude Code keeps <pid>.json ({ pid, sessionId, ... }) in its
// sessions folder and removes it when the chat closes; a file whose process is gone (a crash) opens nothing. Null when
// the folder cannot be read, so every session counts as open, as before HQ read it.
function openSessions(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const open = new Set();
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      if (Number.isInteger(j.pid) && typeof j.sessionId === "string" && pidAlive(j.pid)) open.add(j.sessionId);
    } catch {}
  }
  return open;
}

// `home` is the user's home directory: its folder name reaches the page so Streamer mode can mask it
// wherever a path shows it. `chunk` caps one transcript read (tests pass a small one). `sessionsDir` is Claude Code's
// sessions folder (openSessions); absent, every session counts as open.
// `feed` is the chats' hq-feed reports (lib/feed.js), absent in tests that do not need it; `compactAt` is the context
// size at which Claude Code compacts a chat (settings autoCompactWindow), null when unknown. `agentsOff` gives the ids of
// the agents switched off on the page (lib/switches.js offIds), read once a build. `plan` gives the weekly plan limit's
// last reading and `accounts` the accounts strip (lib/accounts.js), each null when unknown. `board` is null with no
// coordination registry. `switchesEnforced` says whether the system pack's switch hook is registered (lib/switches.js
// createEnforcement), so the page can say an off switch is not enforced yet.
// `assistantIds` gives the ids of the HQ assistant's own chats: flagged `assistant`, and never a reply item.
// `drafterRows` gives the drafter's { at, costUsd, model } rows, for the assistant's weekly usage line.
function createHq({ config, board = null, home = null, chunk, sessionsDir = null, feed = null, compactAt = null, agentsOff = () => new Set(), plan = () => null, accounts = () => null, switchesEnforced = () => false, assistantIds = () => new Set(), drafterRows = () => [] }) {
  const live = new Map(); // session id -> { main, project, subs: Map(fp -> { t, meta, mtimeMs }), shown }
  let deploys = null; // the deploy wall's list (lib/deploys.js view), set by the server
  let deploysText = "null";
  const beats = new Map(); // agent id -> { mtimeMs, size, beat }: its heartbeat file as last read
  const homeName = home ? path.basename(home) : null;
  let snapshot = null;
  let text = "null";
  let built = null; // the payload without its decisions, from the last update
  let seats = new Map(); // session id -> the agent whose desk it sits at, from the last update
  let requests = []; // the open requests in HQ's decisions folder (lib/decisions.js scan)
  let requestIds = "";
  const held = new Map(); // session id -> when its main chat's last request left (HELD_MS)
  let alerts = []; // answers HQ did not write, newest first (the server keeps the list)
  let alertsText = "[]";
  // sending from the pop-up (server.js syncInbox): the chats a waiter listens for, those with a message waiting, and
  // when each chat's newest message was delivered
  let inbox = { listening: [], pending: [], delivered: {} };
  let inboxText = JSON.stringify(inbox);
  // the approve window (server.js applyWindow, lib/window.js): open, when it ends, its sessions and what it approved
  let win = { open: false, endsAt: null, sessions: null, approved: 0 };
  let winText = JSON.stringify(win);
  // the read-backs waiting for the owner's yes (server.js syncReadbacks, lib/readback.js): [{ id, kind, text, at }]
  let readbacks = [];
  let readbacksText = "[]";
  // what became of each read-back and each decision that left the open list, newest first (server.js, lib/settled.js):
  // [{ id, at, kind, what, outcome, via }]
  let settled = [];
  let settledText = "[]";
  // the assistant (server.js, lib/assistant.js): { state, messages, usage }, or null when it is off
  let assistant = null;
  let assistantText = "null";
  // the assistant's own chats of the last 8 days, read for its weekly usage (a live tracker drops a chat 2 h after it
  // goes quiet), and that usage as of the last update
  const aTracks = new Map();
  let usage = null;
  const chats = createChats(); // the chat pop-ups' feeds (lib/chat.js), read only while a pop-up asks

  // One stat per heartbeat a refresh; the file is read again only when its time or size changed. A missing file is
  // no activity for that desk; a read that fails keeps what was last read and is tried again on the next refresh.
  // Neither ever stops the rest of the payload.
  function readBeats() {
    for (const a of config.agents) {
      if (!a.heartbeat) continue;
      let st;
      try {
        st = fs.statSync(a.heartbeat);
      } catch {
        beats.delete(a.id);
        continue;
      }
      const was = beats.get(a.id);
      if (was && was.mtimeMs === st.mtimeMs && was.size === st.size) continue;
      const beat = st.isFile() && st.size <= BEAT_MAX ? readBeat(a.heartbeat) : null;
      if (beat !== UNREAD) beats.set(a.id, { mtimeMs: st.mtimeMs, size: st.size, beat });
    }
  }

  async function update(index, stats, now = Date.now()) {
    readBeats();
    if (feed) feed.read(now);
    const snap = board ? board.read(now) : null;
    const byId = new Map(index.mains.map((m) => [m.sessionId, m]));
    const lastOf = (m) => Math.max(m.mtimeMs, index.subMtime[m.sessionId] || 0);
    const open = sessionsDir ? openSessions(sessionsDir) : null;
    const isOpen = (id) => !open || open.has(id);
    const ids = new Set(); // shown: open, and written to in the last 15 minutes or registered and not ended
    for (const m of index.mains) if (now - lastOf(m) <= LIVE_MS && isOpen(m.sessionId)) ids.add(m.sessionId);
    if (snap) for (const s of Object.values(snap.sessions)) if (!s.endedAt && isOpen(s.id)) ids.add(s.id);
    const kept = new Set(ids); // tracked: shown, or quiet for less than the grace period, so coming back reads only what is new
    for (const m of index.mains) if (now - lastOf(m) <= GRACE_MS) kept.add(m.sessionId);
    for (const [id, L] of [...live]) {
      if (kept.has(id)) L.shown = ids.has(id);
      else live.delete(id);
    }
    for (const id of ids) {
      const m = byId.get(id);
      let L = live.get(id);
      if (!L) live.set(id, (L = { main: null, project: null, subs: new Map(), shown: true }));
      if (!L.main && m) {
        L.main = tracker(m.fp, id);
        L.project = m.project;
      }
      if (L.main) await pump(L.main, chunk);
    }
    for (const sub of index.subs) {
      const L = live.get(sub.sessionId);
      if (!L || !L.shown) continue;
      let S = L.subs.get(sub.fp);
      if (!S) L.subs.set(sub.fp, (S = { t: tracker(sub.fp, path.basename(sub.fp, ".jsonl"), true), meta: readMeta(sub.fp), mtimeMs: -1 }));
      if (sub.mtimeMs !== S.mtimeMs) {
        S.mtimeMs = sub.mtimeMs;
        await pump(S.t, chunk);
      }
    }
    const ours = assistantIds();
    const recent = (m) => ours.has(m.sessionId) && now - m.mtimeMs <= 8 * DAY;
    for (const m of index.mains) {
      if (!recent(m)) continue;
      let t = aTracks.get(m.fp);
      if (!t) aTracks.set(m.fp, (t = tracker(m.fp, m.sessionId)));
      await pump(t, chunk);
    }
    const keep = new Set(index.mains.filter(recent).map((m) => m.fp));
    for (const fp of [...aTracks.keys()]) if (!keep.has(fp)) aTracks.delete(fp);
    usage = weekUsage({ sessions: [...aTracks.values()].map((t) => t.c), drafter: drafterRows(), last30: (stats && stats.last30) || [], now });
    built = build(snap, stats, now);
    built = withScreens(built);
    finish(now);
  }

  function finish(now = Date.now()) {
    snapshot = { ...withDecisions(built, now), alerts, inbox, deploys, window: win, readbacks, settled, assistant: assistant && { ...assistant, usage } };
    text = JSON.stringify(snapshot);
  }

  // The deploy wall's list; true when the payload changed.
  function setDeploys(view) {
    const t = JSON.stringify(view);
    if (t === deploysText) return false;
    deploysText = t;
    deploys = view;
    if (!built) return false;
    finish();
    return true;
  }

  // The open requests from the decisions folder; true when the payload changed. The server calls it after each update
  // and whenever the folder changes, so an answer or a new request shows without waiting for the next refresh.
  function setRequests(list, now = Date.now()) {
    const ids = list.map((r) => r.id + ":" + r.hash).join(","); // a request rewritten in place keeps its id, never its hash
    if (ids === requestIds) return false;
    const open = new Set(list.map((r) => r.id));
    for (const r of requests) if (!r.agentId && !open.has(r.id)) held.set(r.sessionId, now); // a main chat's request left
    requestIds = ids;
    requests = list;
    if (!built) return false;
    finish(now);
    return true;
  }
  // Whether a chat has moved past a prompt asked at askedAt (ms): read from the session's transcript, or from its
  // subagent's own file when agentId is given; null when HQ does not follow that transcript. True when a typed prompt
  // (any user row that is not only call results or a meta row) or a new message (an assistant row whose message id
  // differs from the calling message's, the newest at or before askedAt) lands over 2 s after askedAt. A call's result
  // alone never counts, nor does another row of the calling message, except the result of the asking call itself when
  // its id is known (a question's toolUseId), at any time.
  function movedOn(sessionId, agentId, askedAt, toolUseId = null) {
    const L = live.get(sessionId);
    if (!L) return null;
    let s = null;
    if (!agentId) s = L.main ? L.main.s : null;
    else for (const S of L.subs.values()) if (S.t.s.id === "agent-" + agentId) { s = S.t.s; break; }
    if (!s) return null;
    if (toolUseId && s.results.includes(toolUseId)) return true;
    const after = askedAt + MOVED_MS;
    if (s.promptAt != null && s.promptAt > after) return true;
    let calling = null;
    for (const m of s.marks) if (m.at <= askedAt && (!calling || m.at >= calling.at)) calling = m;
    const mid0 = calling ? calling.mid : null;
    return s.marks.some((m) => m.at > after && (mid0 == null || m.mid !== mid0));
  }
  // The alerts for answers HQ did not write ({ at, id, sessionName, toolName }, newest first); true when the payload
  // changed.
  function setAlerts(list) {
    const t = JSON.stringify(list);
    if (t === alertsText) return false;
    alertsText = t;
    alerts = list;
    if (!built) return false;
    finish();
    return true;
  }

  // The inbox's state for the pop-up's Send; true when the payload changed.
  function setInbox(state) {
    const t = JSON.stringify(state);
    if (t === inboxText) return false;
    inboxText = t;
    inbox = state;
    if (!built) return false;
    finish();
    return true;
  }

  // The approve window's state for the countdown chip; true when the payload changed.
  function setWindow(state) {
    const t = JSON.stringify(state);
    if (t === winText) return false;
    winText = t;
    win = state;
    if (!built) return false;
    finish();
    return true;
  }

  // The read-backs waiting for the owner's yes; true when the payload changed.
  function setReadbacks(list) {
    const t = JSON.stringify(list);
    if (t === readbacksText) return false;
    readbacksText = t;
    readbacks = list;
    if (!built) return false;
    finish();
    return true;
  }

  // The settled history, newest first; true when the payload changed.
  function setSettled(list) {
    const t = JSON.stringify(list);
    if (t === settledText) return false;
    settledText = t;
    settled = list;
    if (!built) return false;
    finish();
    return true;
  }

  // The assistant's panel: its state, its last messages and its usage; true when the payload changed.
  function setAssistant(view) {
    const t = JSON.stringify(view);
    if (t === assistantText) return false;
    assistantText = t;
    assistant = view;
    if (!built) return false;
    finish();
    return true;
  }

  // The Needs you items: the open requests, then the finished turns waiting for a reply that have no request open; a
  // figure with an open item raises its hand. A subagent's request belongs to its floor agent (by type), a seated
  // session's to its desk, any other to the session's own figure. A chat whose request just left gets no reply item
  // while its transcript still ends before that moment (HELD_MS).
  function withDecisions(p, now) {
    for (const [id, left] of held) if (now - left >= HELD_MS) held.delete(id);
    const byId = new Map(p.sessions.map((s) => [s.id, s]));
    const agentFor = (type) => config.agents.find((a) => matches(type || "", a.agentTypes));
    const items = [];
    const asking = new Set();
    for (const r of requests) {
      try {
        const s = byId.get(r.sessionId);
        const sessionName = s ? s.name : r.sessionId.slice(0, 8);
        const a = r.agentId ? agentFor(r.agentType) : null;
        const desk = seats.get(r.sessionId);
        const figure = a ? "a:" + a.id : desk ? "a:" + desk : "s:" + r.sessionId;
        items.push(describe(r, { name: a ? a.name : sessionName, sessionName, figure }));
        asking.add(r.sessionId);
      } catch {} // a request that cannot be described is dropped, never the payload (requestOf already refuses a bad file)
    }
    for (const s of p.sessions) {
      if (s.status !== "needs-you" || asking.has(s.id) || s.assistant) continue; // the assistant's own turn waits on no one
      if (held.has(s.id) && !(s.lastAt > held.get(s.id))) continue; // no row since its request left: still that prompt
      try {
        items.push(describeReply(s, { figure: seats.has(s.id) ? "a:" + seats.get(s.id) : "s:" + s.id }));
      } catch {}
    }
    items.sort((x, y) => RANK[x.kind] - RANK[y.kind] || (x.askedAt || 0) - (y.askedAt || 0));
    const waiting = new Set(items.map((d) => d.figure));
    return {
      ...p,
      pill: { ...p.pill, needsYou: items.length },
      decisions: items,
      floor: {
        ...p.floor,
        needYou: items.length,
        agents: p.floor.agents.map((a) => ({ ...a, waiting: waiting.has("a:" + a.id) })),
        sessions: p.floor.sessions.map((s) => ({ ...s, waiting: waiting.has("s:" + s.id) })),
        helpers: p.floor.helpers.map((h) => ({ ...h, waiting: items.filter((d) => d.agentId && d.sessionId === h.sessionId && "agent-" + d.agentId === h.id).map((d) => d.id) })),
      },
    };
  }

  // A session's delegations with their agent, cost and quiet state, and its handoffs with names for pipes.
  function collabOf(L, k, peerOf, now) {
    if (!k) return { delegations: [], handoffs: [], prs: [], completions: [], background: [], wakeAt: null };
    const byUse = new Map([...L.subs.values()].filter((x) => x.meta.toolUseId).map((x) => [x.meta.toolUseId, x.t]));
    const byId = new Map([...L.subs.values()].map((x) => [x.t.s.id, x]));
    const agentOf = (type) => config.agents.find((a) => matches(type, a.agentTypes));
    const delegations = k.delegations.slice(0, MAX_LIST).map((d) => {
      const sub = byUse.get(d.id);
      const agent = agentOf(d.type);
      const lastWrite = Math.max(d.startedAt, (sub && sub.s.lastAt) || 0);
      return {
        ...d,
        status: d.status === "running" && now - lastWrite > QUIET_MS ? "quiet" : d.status,
        agentId: agent ? agent.id : null,
        agentName: agent ? agent.name : d.type,
        cost: sub ? sub.c.cost : null,
      };
    });
    // A message to one of this session's own subagents is a follow-up to that agent, not a handoff to a peer.
    const toAgent = (to) => {
      const sub = byId.get("agent-" + to);
      if (!sub && !SUB_ID.test(to)) return null;
      const type = (sub && sub.meta.agentType) || "subagent";
      const agent = agentOf(type);
      return { peer: agent ? agent.name : type === "subagent" ? "a subagent" : type, agentId: agent ? agent.id : null, agentType: type };
    };
    const handoffs = [
      ...k.sent.map((m) => ({ at: m.at, dir: "out", ...(toAgent(m.to) || { peer: peerOf(m.to), agentId: null, agentType: null }), text: m.text })),
      ...k.received.map((m) => ({ at: m.at, dir: "in", peer: m.from, agentId: null, agentType: null, text: m.text })),
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_LIST);
    // A shell that finished inside a subagent: its launching call sits in that subagent's transcript, so the
    // description comes from there and the command never does (the notification quotes the command when
    // the call had no description).
    const shells = new Map();
    for (const x of L.subs.values()) for (const [id, desc] of x.t.k.shell) shells.set(id, desc);
    const completions = k.completions.slice(0, 10).map(({ useId, ...c }) => ({ ...c, text: shells.has(useId) ? shells.get(useId) || "A background command" : c.text }));
    const background = k.background.filter((j) => (j.until != null ? now < j.until : now - j.at <= BG_MAX) && !SERVER.test(j.text)).slice(0, 10);
    return { delegations, handoffs, prs: k.prs.slice(0, 10), completions, background, wakeAt: k.wakeAt != null && now < k.wakeAt ? k.wakeAt : null };
  }

  // The last 24 h of work between sessions, agents and peers, newest first.
  function flowOf(sessions, view, byName, now) {
    const flow = [];
    for (const x of sessions) {
      for (const d of x.delegations)
        flow.push({ at: d.doneAt || d.startedAt, kind: "delegate", from: x.name, to: d.agentName, agentId: d.agentId, sessionId: x.id, text: d.description, status: d.status, startedAt: d.startedAt, doneAt: d.doneAt });
      for (const h of x.handoffs) {
        if (h.dir === "in" && byName.has(h.peer)) continue; // the live sender already shows it
        flow.push({ at: h.at, kind: "handoff", from: h.dir === "out" ? x.name : h.peer, to: h.dir === "out" ? h.peer : x.name, sessionId: x.id, text: h.text });
      }
      for (const c of x.completions) flow.push({ at: c.at, kind: "done", from: x.name, sessionId: x.id, text: c.text, status: c.status });
      for (const p of x.prs) flow.push({ at: p.at, kind: "pr", from: x.name, sessionId: x.id, text: `Opened PR #${p.number}` + (p.repo ? ` in ${p.repo}` : ""), url: p.url });
    }
    if (view) for (const e of view.feed) flow.push({ at: e.at, kind: e.kind, from: e.by, sessionId: byName.has(e.by) ? byName.get(e.by).id : null, text: e.text });
    return flow.filter((e) => now - e.at <= DAY).sort((a, b) => b.at - a.at).slice(0, MAX_FLOW);
  }

  // Who worked with whom over the last 24 h: one node per session, agent or peer, one edge per pair and kind.
  function teamOf(sessions, byName, now) {
    const nodes = new Map();
    const edges = new Map();
    const node = (id, n) => {
      if (!nodes.has(id)) nodes.set(id, { id, ...n });
    };
    const sessionNode = (x) => node("s:" + x.id, { label: x.name, kind: "session", status: x.status, sessionId: x.id });
    const link = (from, to, kind, at, active) => {
      const key = [from, to].sort().join("|") + "|" + kind;
      if (!edges.has(key)) edges.set(key, { from, to, kind, count: 0, lastAt: 0, active: false });
      const e = edges.get(key);
      e.count++;
      e.lastAt = Math.max(e.lastAt, at);
      e.active = e.active || active;
    };
    const agentNode = (agentId, type, label) => {
      const agent = agentId ? config.agents.find((a) => a.id === agentId) : null;
      const dept = agent ? config.departments.find((p) => p.name === agent.dept) : null;
      const aid = agent ? "a:" + agent.id : "t:" + type;
      node(aid, { label, kind: "agent", color: dept ? dept.color : null });
      return aid;
    };
    for (const x of sessions) {
      const me = "s:" + x.id;
      for (const d of x.delegations) {
        if (d.status !== "running" && now - (d.doneAt || d.startedAt) > DAY) continue;
        sessionNode(x);
        link(me, agentNode(d.agentId, d.type, d.agentName), "delegate", d.doneAt || d.startedAt, d.status === "running");
      }
      for (const h of x.handoffs) {
        if (now - h.at > DAY) continue;
        if (h.agentType) {
          sessionNode(x); // a follow-up to this session's own subagent joins its agent node
          link(me, agentNode(h.agentId, h.agentType, h.peer), "handoff", h.at, now - h.at <= FRESH_MS);
          continue;
        }
        const peer = byName.get(h.peer);
        if (h.dir === "in" && peer) continue; // counted on the sender
        const pid = peer ? "s:" + peer.id : "p:" + h.peer;
        sessionNode(x);
        if (peer) sessionNode(peer);
        else node(pid, { label: h.peer, kind: "peer" });
        link(h.dir === "out" ? me : pid, h.dir === "out" ? pid : me, "handoff", h.at, now - h.at <= FRESH_MS);
      }
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  // What a session's desk tag shows under its name: the plan's progress and finish time, its cost, whether its prompt
  // cache is warm, how full it is, and a flag when its last three tool calls all failed (FAIL_RUN).
  function badgeOf(x, now) {
    const last = x.checks && x.checks[0];
    return {
      pct: x.progress && !x.progress.done ? x.progress.pct : null,
      finishAt: x.progress && !x.progress.done ? x.progress.finishAt : null,
      cost: x.cost,
      cache: x.cache ? x.cache.state : null,
      cacheLeft: x.cache && x.cache.state === "warm" ? x.cache.expiresAt - now : null,
      ctx: x.context ? x.context.pct : null,
      failing: x.failRun >= FAIL_RUN,
      check: last ? (last.ok ? "pass" : "fail") : null,
      warm: !!(x.warm && x.warm.on),
    };
  }

  // Where an agent named in config by `sessions` or `heartbeat` gets its work: a matched live session that is working
  // or thinking, else a running subagent of its type (the plain rule), else its heartbeat; `source` names which one
  // ("session", "subagent", "heartbeat", or null for none). A working heartbeat whose file has not changed for
  // QUIET_MS reads as quiet. An agent switched off (`isOff`) has no job and its heartbeat is not read: only a working
  // seated session lights its desk.
  function deskOf(a, mine, job, now, isOff) {
    const s = mine.find((x) => x.status === "working" || x.status === "thinking");
    if (s) return { working: true, doing: s.action, forSession: s.name, source: "session", status: "working", task: s.action, summary: [], updatedAt: s.lastAt, lines: s.events.slice(0, 6).map((e) => e.label), badge: badgeOf(s, now) };
    if (job) return { source: "subagent", status: "working", task: job.description, summary: [], updatedAt: null };
    const b = isOff ? null : beats.get(a.id);
    if (!b || !b.beat) return { source: null, status: "idle", task: null, summary: [], updatedAt: null };
    const status = b.beat.status === "working" && now - b.mtimeMs > QUIET_MS ? "quiet" : b.beat.status;
    return { working: status === "working", doing: status === "working" ? b.beat.task : null, forSession: null, source: "heartbeat", status, task: b.beat.task, summary: b.beat.summary, updatedAt: b.beat.updatedAt };
  }

  function build(snap, stats, now) {
    const shown = [...live].filter(([, L]) => L.shown); // a tracker kept through a quiet spell is not a session on the page
    const view = boardView(snap, shown.map(([id]) => id));
    const views = new Map(shown.map(([id, L]) => [id, L.main ? collabView(L.main.k) : null]));
    const pipes = Object.assign({}, ...[...views.values()].map((k) => (k ? k.pipes : {})));
    const peerOf = (to) => (to.startsWith("uds:") ? pipes[to] || "another session" : to);
    const sessions = [];
    const subLines = new Map(); // a subagent's own newest 6 action labels, newest first, for its floor agent's monitor
    const boardNames = new Map(); // session id -> its name on the coordination board
    const assistants = assistantIds(); // the assistant's own chats
    for (const [id, L] of shown) {
      const r = snap && snap.sessions[id];
      if (r && r.name) boardNames.set(id, r.name);
      const s = L.main ? L.main.s : newSession(id);
      const subs = [...L.subs.values()]
        .map(({ t, meta }) => {
          const st = statusOf(t.s, now);
          subLines.set(t.s.id, t.s.events.slice(-6).reverse().map((e) => e.label));
          return {
            id: t.s.id, type: meta.agentType || null, description: meta.description ? clean(meta.description) : null,
            running: st === "working" || st === "thinking", cost: t.c.cost, cache: cacheView(t.c, now), toolCount: t.s.toolCount, lastAt: t.s.lastAt,
          };
        })
        .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
      const collab = collabOf(L, views.get(id), peerOf, now);
      // a chat whose turn ended while something it started still runs waits on that, not on the owner: a subagent's
      // report, a background job's or a watch's notice, or its own scheduled wakeup starts its next turn, and only a
      // turn that ends with nothing left running needs the owner's reply. A question it asked still needs the owner.
      const ended = statusOf(s, now) === "needs-you" && !s.last.asks;
      const agents = collab.delegations.filter((d) => d.status === "running");
      const waitsOn = !ended ? null : agents.length ? "subagent" : collab.background.length ? "background" : collab.wakeAt ? "timer" : null;
      const status = waitsOn ? "working" : statusOf(s, now);
      const cwd = (r && r.cwd) || s.cwd;
      const rep = feed ? feed.get(id) : null; // its hq-feed mod's report: keep-warm pings, the spend brake
      const cache = L.main ? rewarm(cacheView(L.main.c, now), rep && rep.warm.lastPingAt, now) : null;
      const ctl = rep ? feed.controlOf(id) : null;
      sessions.push({
        id,
        name: (r && r.name) || s.customTitle || s.title || id.slice(0, 8),
        title: s.customTitle || s.title, // the chat's name in VS Code: the owner's own name for it, else the one Claude Code made
        project: (cwd && path.basename(cwd)) || L.project, // the folder's own name, never the encoded one
        cwd,
        branch: s.branch === "HEAD" ? null : s.branch, // outside a branch Claude Code records "HEAD"
        task: r && r.task ? clean(r.task) : null,
        status,
        waitsOn,
        waitingFor: waitsOn === "subagent" ? agents.map((d) => d.description) : waitsOn === "background" ? collab.background.map((j) => j.text) : [], // what it waits on, by name
        action: s.events.length ? s.events[s.events.length - 1].label : null,
        startedAt: s.firstAt,
        lastAt: s.lastAt != null ? s.lastAt : (r && r.lastSeen) || null,
        toolCount: s.toolCount,
        cost: (L.main ? L.main.c.cost : 0) + subs.reduce((x, u) => x + u.cost, 0),
        progress: L.main ? progressView(L.main.p, now) : null,
        cache,
        // how close the chat is to compacting: the last request's whole prompt against the compaction point
        context: cache && compactAt ? { tokens: cache.prefix, of: compactAt, pct: Math.min(100, Math.round((100 * cache.prefix) / compactAt)) } : null,
        fails: s.fails.slice(-5).reverse(),
        failRun: s.failRun,
        checks: s.checks.slice().reverse(),
        // keep-warm needs the mod in the chat (a chat started after it was installed): canWarm says whether it is there
        warm: rep ? { canWarm: true, on: !!(ctl && ctl.keepWarm), pings: rep.warm.pings, lastPingAt: rep.warm.lastPingAt, stopped: rep.warm.stopped } : { canWarm: false },
        brake: rep ? rep.brake : null,
        subagents: subs.slice(0, MAX_SUBS),
        subagentsTotal: subs.length,
        locks: view ? view.locks.filter((l) => l.session === id || (r && l.session === r.name)).map((l) => l.name) : [],
        claims: view ? view.claims.filter((c) => c.session === id).map((c) => c.path) : [],
        events: s.events.slice().reverse(),
        registered: !!r,
        assistant: assistants.has(id),
        avatar: hash(id) % config.sessionAvatars.length,
        spark: sparkOf(s, now),
        ...collab,
      });
    }
    sessions.sort((a, b) => ORDER[a.status] - ORDER[b.status] || (b.lastAt || 0) - (a.lastAt || 0));
    const byName = new Map(sessions.map((x) => [x.name, x]));
    const links = [];
    for (const x of sessions)
      for (const d of x.delegations)
        if (d.status === "running" && d.agentId && !links.some((l) => l.from === x.id && l.to === d.agentId)) links.push({ from: x.id, to: d.agentId });
    // oldest first (its first row), so a roster figure keeps the job it took and the helpers keep their order while
    // they run
    const startOf = new Map(shown.flatMap(([, L]) => [...L.subs.values()].map(({ t }) => [t.s.id, t.s.firstAt == null ? Infinity : t.s.firstAt])));
    const running = sessions
      .flatMap((x) => x.subagents.filter((u) => u.running).map((u) => ({ ...u, sessionName: x.name, sessionId: x.id })))
      .sort((u, v) => startOf.get(u.id) - startOf.get(v.id));
    // a live session whose board name an agent's `sessions` matches sits at that agent's desk, never in a live seat;
    // its Live row on the Dashboard is unchanged
    const seatOf = new Map();
    for (const a of config.agents)
      if (a.sessions) for (const x of sessions) if (!seatOf.has(x.id) && matches(boardNames.get(x.id) || x.name, a.sessions)) seatOf.set(x.id, a.id);
    seats = seatOf;
    const onFigure = new Set(); // the running subagents a roster figure shows
    const off = agentsOff(); // an agent switched off takes no job: its running subagent is a helper until it ends
    const agents = config.agents.map((a) => {
      const isOff = off.has(a.id);
      const job = isOff ? null : running.find((u) => matches(u.type || "", a.agentTypes));
      const out = { id: a.id, name: a.name, dept: a.dept, hangout: a.hangout, look: a.look, avatar: a.avatar, off: isOff, agentTypes: a.agentTypes || [], working: !!job, doing: job ? job.description : null, forSession: job ? job.sessionName : null, lines: job ? subLines.get(job.id) || [] : [] };
      if (a.sessions || a.heartbeat) Object.assign(out, deskOf(a, sessions.filter((x) => seatOf.get(x.id) === a.id), job, now, isOff));
      if (job && out.source !== "session") onFigure.add(job.id); // a working named session wins its desk over the job
      return out;
    });
    // every other running subagent is a helper in the live row (the page seats them), oldest first, at most 8, its name
    // one line of at most 60 characters; `waiting` is filled with its open Needs you items once the decisions are known
    // (withDecisions)
    const helpers = running.filter((u) => !onFigure.has(u.id)).slice(0, 8).map((u) => ({
      id: u.id, name: cap((u.description || "").replace(/\s+/g, " ").trim() || u.type || "A subagent", 60), type: u.type,
      forSession: u.sessionName, sessionId: u.sessionId, working: true, lines: subLines.get(u.id) || [], waiting: [],
    }));
    const count = (st) => sessions.filter((x) => x.status === st).length;
    const conflicts = view ? view.conflicts.length : null;
    return {
      generatedAt: now,
      appName: config.appName,
      homeName,
      vitals: {
        liveSessions: sessions.length,
        subagentsRunning: running.length,
        toolCallsToday: stats ? stats.toolsToday : null,
        byToolToday: stats ? stats.byToolToday || [] : null,
        spendToday: stats ? stats.today : null,
        planUsd: config.planUsd,
        plan: plan(), // the weekly plan limit's last reading (server.js planOf), or null
        accounts: accounts(), // the Claude accounts: signed-in one, each weekly reset, next to reset (lib/accounts.js), or null
        filesClaimed: view ? view.claims.length : null,
        conflicts,
      },
      pill: { working: count("working") + count("thinking"), needsYou: count("needs-you"), conflicts: conflicts || 0 },
      sessions,
      board: view ? { conflicts: view.conflicts, locks: view.locks, feed: view.feed } : null,
      activity: stats && stats.activity ? stats.activity : null,
      flow: flowOf(sessions, view, byName, now),
      team: teamOf(sessions, byName, now),
      floor: {
        departments: config.departments,
        owner: config.owner,
        accent: config.accent,
        sessionAvatars: config.sessionAvatars,
        links,
        agents,
        helpers,
        switchesEnforced: !!switchesEnforced(),
        sessions: sessions.filter((x) => !seatOf.has(x.id)).map((x) => ({ id: x.id, name: x.name, status: x.status, working: x.status === "working" || x.status === "thinking", action: x.action, avatar: x.avatar, task: x.task, lines: x.events.slice(0, 6).map((e) => e.label), badge: badgeOf(x, now) })),
      },
    };
  }

  // ---------- Each figure's screens ----------
  // The screen each figure's monitors show, from its own transcript (lib/session.js screenOf): a live session's, a
  // helper's, and a roster figure's at work, from its matched session or else its job (picked as build picks them: the
  // oldest running subagent of its types). A roster figure with no running job gets none and keeps its heartbeat task.
  // A screenshot the screen shows is checked (lib/shots.js) and given an opaque id; the page fetches it by that id only
  // (GET /api/screen/<id>, screenFile). Only the newest per figure is live, at most SHOT_IDS: a figure whose screen no
  // longer shows its screenshot loses the id, and figures past the cap (sessions first, in the payload's order, then
  // helpers, then roster figures) get none.
  const SHOT_IDS = 16;
  let shots = new Map(); // figure key -> { rel, at, opts, id }: the screenshot its screen shows, as last checked
  function withScreens(p) {
    const trackerOf = (sessionId, subId = null) => {
      const L = live.get(sessionId);
      if (!L) return null;
      if (!subId) return L.main;
      for (const S of L.subs.values()) if (S.t.s.id === subId) return S.t;
      return null;
    };
    const next = new Map();
    let issued = 0;
    const shotFor = (key, t) => {
      const want = shotOf(t.v);
      if (!want || issued >= SHOT_IDS) return null;
      let rec = shots.get(key);
      if (!rec || rec.rel !== want.rel || rec.at !== want.at) {
        const opts = { home, cwd: t.s.cwd, since: t.s.firstAt };
        rec = { rel: want.rel, at: want.at, opts, id: checkShot(want.rel, opts) ? randomBytes(16).toString("hex") : null };
      }
      next.set(key, rec);
      if (rec.id) issued++;
      return rec.id;
    };
    const screen = (t, key) => (t && t.v ? screenOf(t.v, t.s.events, shotFor(key, t)) : null);
    const firstOf = (t) => (t && t.s.firstAt != null ? t.s.firstAt : Infinity);
    const sessions = p.floor.sessions.map((x) => ({ ...x, screen: screen(trackerOf(x.id), "s:" + x.id) }));
    const helpers = p.floor.helpers.map((h) => ({ ...h, screen: screen(trackerOf(h.sessionId, h.id), "h:" + h.id) }));
    const running = p.sessions
      .flatMap((x) => x.subagents.filter((u) => u.running).map((u) => ({ type: u.type, t: trackerOf(x.id, u.id) })))
      .sort((a, b) => firstOf(a.t) - firstOf(b.t));
    const agents = p.floor.agents.map((a) => {
      if (!a.working) return a;
      const conf = config.agents.find((c) => c.id === a.id) || {};
      const own = a.source === "session" ? p.sessions.find((x) => seats.get(x.id) === a.id && x.name === a.forSession) : null;
      const job = own ? null : running.find((r) => matches(r.type || "", conf.agentTypes));
      const t = own ? trackerOf(own.id) : job ? job.t : null;
      return t ? { ...a, screen: screen(t, "a:" + a.id) } : a;
    });
    shots = next;
    return { ...p, floor: { ...p.floor, agents, sessions, helpers } };
  }
  // A screenshot by the id withScreens issued: { type, body } read and checked again now, or null for any other string.
  function screenFile(id) {
    if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) return null;
    for (const rec of shots.values()) if (rec.id === id) return checkShot(rec.rel, rec.opts, true);
    return null;
  }

  // A live session's chat for its pop-up: { gen, v, entries } from its transcript (lib/chat.js), and each of its agents'
  // newest step, by id. Null for a session HQ does not show or has no transcript for.
  function chat(id, now = Date.now()) {
    const L = live.get(id);
    if (!L || !L.shown || !L.main) return null;
    const c = chats.read(L.main.fp, now);
    if (!c) return null;
    const agents = [...L.subs.values()].map(({ t }) => ({ id: t.s.id, action: t.s.events.length ? t.s.events[t.s.events.length - 1].label : null }));
    return { ...c, agents };
  }

  return { update, setRequests, setAlerts, setInbox, setWindow, setReadbacks, setSettled, setAssistant, setDeploys, movedOn, chat, payload: () => snapshot, json: () => text, screenFile };
}

module.exports = { createHq };
