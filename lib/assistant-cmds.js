// The assistant's command channel (server.js POST /api/assistant): what each command reads from the
// payload and what it asks of HQ. It never acts on its own word: `ask`, `window <minutes>`, `send` and `open` only
// propose a read-back the owner confirms (lib/readback.js), since text other chats wrote reaches the model every turn. A
// chat is found by its exact id, its exact name or a prefix only one name starts with (a send takes no prefix), never by
// a guess, and never the assistant's own chat.
"use strict";
const { plainText } = require("./inbox");

const STATUS_MAX = 6000;
const REPLY_MAX = 1500;
const WAIT = "Read-back shown to the owner; waiting for the owner's yes.";
const OPEN_LABEL = "Drafted by the VibeQuarters assistant at the user's request: ";
const cap = (s, max) => {
  const c = [...String(s)];
  return c.length > max ? c.slice(0, max - 3).join("") + "..." : String(s);
};
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();

// A chat's name as the owner sees it in Live (public/dashboard.js: its VS Code title, else its session name). Its
// session name still finds it.
const liveName = (s) => s.title || s.name;
const namesOf = (s) => [...new Set([s.title, s.name].filter((n) => typeof n === "string" && n))];

// { ok: true, session } or { ok: false, error, candidates }: an exact id, or an exact Live title or session name (any case)
// or, unless exact, a prefix (any case) of either that only one chat has; the assistant's own chats are never candidates
function resolveSession(sessions, query, { exact = false } = {}) {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) return { ok: false, error: "name a chat", candidates: [] };
  const list = (sessions || []).filter((s) => !s.assistant);
  const lower = q.toLowerCase();
  const byId = list.find((s) => s.id === q);
  if (byId) return { ok: true, session: byId };
  const named = list.filter((s) => namesOf(s).some((n) => n.toLowerCase() === lower));
  if (named.length === 1) return { ok: true, session: named[0] };
  const ids = named.map((s) => s.id);
  if (ids.length) return { ok: false, error: `two or more chats are named "${q}": name one by its id, ${ids.join(" or ")}`, candidates: ids };
  const starts = list.filter((s) => namesOf(s).some((n) => n.toLowerCase().startsWith(lower)));
  const candidates = starts.map(liveName);
  if (exact) return { ok: false, error: `no chat named "${q}"${candidates.length ? ": say its whole name, " + candidates.join(" or ") : ""}`, candidates };
  if (starts.length === 1) return { ok: true, session: starts[0] };
  if (candidates.length) return { ok: false, error: `more than one chat starts with "${q}": ${candidates.join(", ")}`, candidates };
  return { ok: false, error: `no chat named "${q}"`, candidates: [] };
}

// How full a chat's context is, against the point it auto-compacts (lib/hq.js context.pct; public/warn.js CTX draws the
// same marks on its Live row): 1 from 75%, time to compact; 2 from 90%, time to hand off to a fresh session
const contextLevel = (s) => {
  const pct = s && s.context ? s.context.pct : null;
  return pct == null ? 0 : pct >= 90 ? 2 : pct >= 75 ? 1 : 0;
};
const CONTEXT_DO = ["", "time to compact", "time to hand off to a fresh session"];
const ago = (ms) => {
  const m = Math.floor(Math.max(0, ms) / 60e3);
  return m < 1 ? `${Math.floor(Math.max(0, ms) / 1e3)} s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
};
const kTokens = (n) => `${Math.round(n / 1000)}k`;
const num = (n) => Number(n).toLocaleString("en-US");
const usd = (n) => "$" + Number(n).toFixed(2);

// One chat as its Live row shows it: its title, state and task, the plan's step, a context past 75% with what to do
function sessionLine(s) {
  const p = s.progress;
  const level = contextLevel(s);
  const extra = [
    p && !p.done ? `step ${p.step} of ${p.of}` : null,
    level ? `context ${s.context.pct}%, ${CONTEXT_DO[level]}` : null,
  ].filter(Boolean);
  return cap(`${liveName(s)}: ${s.status}${s.task ? ", " + oneLine(s.task) : ""}${extra.length ? "; " + extra.join("; ") : ""}`, 300);
}
const openDecisions = (p) => (p.decisions || []).filter((d) => d.kind !== "reply");
// A decision by its chat's Live title (names: session id -> title), with why HQ rated it as it did
const riskWords = (r) => (r ? ` [${r.label}${r.reason && r.level !== "low" ? ": " + r.reason : ""}]` : "");
const decisionLine = (d, names = new Map()) =>
  cap(`${d.id.slice(0, 8)} ${names.get(d.sessionId) || d.sessionName}: ${oneLine(d.what)}${riskWords(d.risk)}${d.hookAsk ? " (a safety hook's prompt: only the owner answers it)" : ""}${d.notice ? " (answer in VS Code)" : ""}`, 260);
const titles = (p) => new Map((p.sessions || []).map((s) => [s.id, liveName(s)]));
// Live's own rule (public/floor/panel-data.js inLive): a chat in use, or one at rest with something open for the owner
const inLive = (s, p) => !s.assistant && (s.status !== "idle" || (p.decisions || []).some((d) => d.sessionId === s.id));
// A question's options by the key hq_ask takes; a several-question ask (picks) is the owner's to answer in HQ
function optionLines(d) {
  if (d.kind !== "question") return [];
  const opts = (d.choices || []).filter((c) => /^opt:\d+$/.test(c.key));
  if (opts.length) return [cap("  options: " + opts.map((c) => `${c.key} ${oneLine(c.label)}`).join(" | "), 400)];
  return (d.choices || []).some((c) => c.key === "picks") ? ["  several questions: the owner answers these in HQ"] : [];
}
function windowLine(w, now) {
  if (!w || !w.open) return "Approve window: closed";
  const min = Math.max(0, Math.ceil((w.endsAt - now) / 60e3));
  return `Approve window: open, ${min} min left, ${w.sessions ? w.sessions.length + " chat(s)" : "every chat"}, approved ${w.approved}`;
}
// The lines that fit in max characters (newlines counted), then one line saying how many did not
function fit(lines, max) {
  const out = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const more = `(${lines.length - i} more not shown)`;
    const room = max - used - (i < lines.length - 1 ? more.length + 1 : 0);
    if (lines[i].length + 1 > room) return [...out, more];
    out.push(lines[i]);
    used += lines[i].length + 1;
  }
  return out;
}

// The Dashboard's header and vitals (public/dashboard.js renderHeader, renderStats), as one line
function dashboardLine(p, now) {
  const c = p.pill, v = p.vitals || {};
  const plan = v.plan && v.plan.pct != null && !(v.plan.resetsAt && v.plan.resetsAt <= now) ? `weekly plan ${v.plan.pct}% used` : null;
  const today = [v.toolCallsToday != null ? `${num(v.toolCallsToday)} actions` : null, v.spendToday != null ? `${usd(v.spendToday)} API-equivalent` : null].filter(Boolean);
  const parts = [
    c ? `${c.working} working, ${c.needsYou} need you${p.board ? `, ${c.conflicts} conflicts` : ""}` : null,
    v.liveSessions != null ? `${v.liveSessions} live chats, ${v.subagentsRunning} subagents running` : null,
    today.length ? "today " + today.join(", ") : null,
    plan,
    v.filesClaimed != null ? `${v.filesClaimed} files claimed` : null,
  ].filter(Boolean);
  return parts.length ? cap("Dashboard: " + parts.join("; "), 400) : null;
}
// The Office's desks (payload floor): who is at work on what, for which chat by its title, and the helpers
function officeLine(p) {
  if (!p.floor) return null;
  const byName = new Map((p.sessions || []).map((s) => [s.name, liveName(s)]));
  const forOf = (n) => (n ? byName.get(n) || n : null);
  const at = (p.floor.agents || []).filter((a) => a.working).map((a) => `${a.name} is working on ${oneLine(a.doing || a.task || "a task")}${a.forSession ? " for " + forOf(a.forSession) : ""}`);
  const helpers = (p.floor.helpers || []).map((h) => `${oneLine(h.name)}${h.forSession ? ` (for ${forOf(h.forSession)})` : ""}`);
  if (!at.length && !helpers.length) return "Office: every desk is quiet";
  return cap("Office: " + [...at, ...(helpers.length ? ["helpers: " + helpers.join(", ")] : [])].join("; "), 600);
}

// The read-backs waiting for the owner's yes in HQ, then what became of the latest read-backs and decisions
// (payload settled, lib/settled.js), newest first
function readbackLines(p, now) {
  const first = (t) => oneLine(String(t || "").split("\n")[0].replace(/:\s*$/, ""));
  const wait = (p.readbacks || []).map((r) => cap(`  ${first(r.text)} (expires in ${ago(r.expiresAt - now)})`, 200));
  const done = (p.settled || []).slice(0, 8).map((s) => cap(`  ${ago(now - s.at)} ago: ${oneLine(s.what)}: ${s.outcome}${s.via ? `, by ${s.via}` : ""}`, 240));
  return [
    ...(wait.length ? ["Waiting for the owner's yes in HQ:", ...fit(wait, 600)] : []),
    ...(done.length ? ["What happened lately (newest first):", ...fit(done, 1000)] : []),
  ];
}

// The whole of HQ in at most 6000 characters: Live as Live shows it, by the same titles, then the other chats; the
// decisions waiting on the owner, the approve window, the dashboard's counts, the Office and today's deploys. All but
// the chats get their room first; Live fills what is left, and the other chats what Live leaves.
function statusText(payload, now) {
  const p = payload || {};
  const sameDay = (t) => new Date(t).toDateString() === new Date(now).toDateString();
  const deploys = ((p.deploys && p.deploys.items) || []).filter((d) => sameDay(d.startedAt)).map((d) => cap(`${d.sha} ${d.state}: ${oneLine(d.subject)}`, 160));
  const open = openDecisions(p);
  const names = titles(p);
  const tail = [
    ...(open.length ? ["Waiting on the owner:", ...fit(open.map((d) => decisionLine(d, names)), 1600)] : ["Waiting on the owner: nothing"]),
    ...readbackLines(p, now),
    windowLine(p.window, now),
    dashboardLine(p, now),
    officeLine(p),
    ...(deploys.length ? ["Deploys today:", ...fit(deploys, 400)] : []),
  ].filter(Boolean);
  const chats = (p.sessions || []).filter((s) => !s.assistant);
  const LIVE = "Live (what the owner sees in HQ's Live list, by the same titles):";
  const OTHER = "Other chats (idle, not in Live):";
  let room = STATUS_MAX - tail.join("\n").length - 1;
  const live = chats.filter((s) => inLive(s, p));
  const liveLines = live.length ? [LIVE, ...fit(live.map(sessionLine), room - LIVE.length - 1)] : ["Live: no chat is in use"];
  room -= liveLines.join("\n").length + 1;
  const rest = chats.filter((s) => !inLive(s, p));
  const restLines = rest.length && room > OTHER.length + 40 ? [OTHER, ...fit(rest.map(sessionLine), room - OTHER.length - 1)] : [];
  return [...liveLines, ...restLines, ...tail].join("\n").slice(0, STATUS_MAX);
}

// One chat for the assistant: its line, then what its Live row and details show (folder, what it does now, the plan,
// time, actions, cost, context, subagents, locks, prompt cache, what it waits on, its latest steps), its last reply's
// first 1500 characters, the Status and Next steps that reply ends with (or the turn's wrap ask), and its open decisions
function readText(payload, chat, session, now = Date.now()) {
  const s = session;
  const out = [sessionLine(s)];
  if (s.project) out.push(`Folder: ${s.project}${s.branch ? ", branch " + s.branch : ""}`);
  if (s.action) out.push("Now: " + oneLine(s.action));
  if (s.progress && s.progress.finishAt && !s.progress.done) out.push(`Plan: step ${s.progress.step} of ${s.progress.of}, done around ${new Date(s.progress.finishAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`);
  const time = [s.startedAt ? `${ago(now - s.startedAt)} elapsed` : null, s.toolCount != null ? `${num(s.toolCount)} actions` : null, s.cost != null ? `${usd(s.cost)} API-equivalent` : null].filter(Boolean);
  if (time.length) out.push(time.join(", "));
  if (s.context) out.push(`Context: ${kTokens(s.context.tokens)} of ${kTokens(s.context.of)} tokens (${s.context.pct}%)${contextLevel(s) ? ", " + CONTEXT_DO[contextLevel(s)] : ""}`);
  if (s.subagentsTotal) {
    const running = (s.subagents || []).filter((u) => u.running);
    out.push(`Subagents: ${running.length} of ${s.subagentsTotal} running${running.length ? ": " + running.map((u) => oneLine(u.description || u.type || "a subagent")).join(", ") : ""}`);
  }
  if (s.locks && s.locks.length) out.push(`Holds the ${s.locks.join(", ")} lock${s.locks.length === 1 ? "" : "s"}`);
  if (s.cache) out.push(s.cache.state === "warm" ? `Prompt cache: warm, ${ago(s.cache.expiresAt - now)} left` : `Prompt cache: ${s.cache.state}`);
  if (s.waitsOn) out.push("Waiting on: " + ((s.waitingFor || []).map(oneLine).join(", ") || s.waitsOn));
  if (s.events && s.events.length) out.push(cap("Latest steps: " + s.events.slice(0, 6).map((e) => `${oneLine(e.label)} (${ago(now - e.at)} ago)`).join("; "), 600));
  const said = chat && chat.entries ? chat.entries.findLast((e) => e.k === "said") : null;
  out.push(said ? "Last reply:\n" + [...said.text].slice(0, REPLY_MAX).join("") : "(no reply to read)");
  const f = (chat && chat.focus) || {};
  if (f.status) out.push("Status: " + f.status);
  if (f.left && f.left.length) out.push("Next steps:", ...f.left.map((s, i) => `${i + 1}. ${s}`));
  if (f.wrap && f.wrap.ask) out.push("Asks: " + f.wrap.ask);
  const mine = openDecisions(payload || {}).filter((d) => d.sessionId === session.id);
  if (mine.length) out.push("Waiting on the owner:", ...mine.flatMap((d) => [decisionLine(d, titles(payload || {})), ...optionLines(d)]));
  return out.join("\n");
}

const reply = (status, text) => ({ status, text });
const chatOf = (ctx, q, opts) => resolveSession((ctx.payload() || {}).sessions, q, opts);
const proposed = (r) => (r.ok ? reply(200, WAIT) : reply(400, r.error));

// One command: { status, text }. ctx gives payload(), chat(id), canSend(id, text) (null, or HQ's { status, text } refusal
// of that message), propose(p), windowOff(), watch(id), now(), and draft; a command whose ctx part is missing is not
// built yet (501).
async function runCommand(ctx, cmd, args = []) {
  const got = ctx.payload();
  // before HQ's first read there is no list yet: an empty one would read as "nothing is running"
  if (!got && cmd !== "open") return reply(503, "HQ is still reading the sessions; ask again in a few seconds.");
  const p = got || {};
  switch (cmd) {
    case "status":
      return reply(200, statusText(p, ctx.now()));
    case "read": {
      const r = chatOf(ctx, args[0]);
      if (!r.ok) return reply(400, r.error);
      return reply(200, readText(p, ctx.chat(r.session.id), r.session, ctx.now()));
    }
    case "send": {
      const r = chatOf(ctx, args[0], { exact: true });
      if (!r.ok) return reply(400, r.error);
      const said = args.slice(1).join(" ");
      if (!said.trim()) return reply(400, "say what to send: send <chat> <text>");
      const text = plainText(said); // shown as the chat would get it
      if (text === null) return reply(400, "text must be 1 to 2000 characters");
      const no = ctx.canSend(r.session.id, text);
      if (no) return no;
      return proposed(ctx.propose({ kind: "send", sessionId: r.session.id, name: liveName(r.session), text }));
    }
    case "ask": {
      const prefix = String(args[0] || "").toLowerCase();
      const choice = args[1];
      if (!prefix || typeof choice !== "string" || !choice) return reply(400, "ask <decision id> <choice> [note]: name the decision and the choice");
      const hits = openDecisions(p).filter((d) => d.id.startsWith(prefix));
      if (!hits.length) return reply(400, `no open decision starts with "${prefix}"`);
      if (hits.length > 1) return reply(400, `more than one open decision starts with "${prefix}": ${hits.map((d) => d.id.slice(0, 12)).join(", ")}`);
      const note = args.slice(2).join(" ").trim();
      const r = ctx.propose({ kind: "answer", decisionId: hits[0].id, choice, item: hits[0], ...(note ? { note } : {}) });
      return r.ok ? reply(200, WAIT) : reply(400, r.error);
    }
    case "window": {
      if (args[0] === "off" && args.length === 1) {
        ctx.windowOff();
        return reply(200, "Approve window off.");
      }
      const minutes = /^\d{1,3}$/.test(args[0] || "") ? Number(args[0]) : NaN;
      if (!(minutes >= 1 && minutes <= 300)) return reply(400, "window <minutes> [chat...]: minutes must be a whole number from 1 to 300");
      const chats = [];
      for (const q of args.slice(1)) {
        const r = chatOf(ctx, q);
        if (!r.ok) return reply(400, r.error);
        if (!chats.some((s) => s.id === r.session.id)) chats.push(r.session);
      }
      const r = ctx.propose({ kind: "window", minutes, sessions: chats.length ? chats.map((s) => s.id) : null, names: chats.length ? chats.map(liveName) : null });
      return r.ok ? reply(200, WAIT) : reply(400, r.error);
    }
    case "watch": {
      const r = chatOf(ctx, args[0]);
      if (!r.ok) return reply(400, r.error);
      ctx.watch(r.session.id);
      return reply(200, `Watching ${liveName(r.session)}; HQ says when its reply ends.`);
    }
    case "draft": {
      if (!ctx.draft) return reply(501, "drafting is off here");
      const idea = args.slice(1).join(" ").trim();
      if (!idea) return reply(400, "say the idea: draft <chat or new> <idea>");
      if (String(args[0] || "").trim().toLowerCase() === "new") return ctx.draft({ target: "new", idea, context: null });
      const r = chatOf(ctx, args[0]);
      if (!r.ok) return reply(400, r.error);
      const chat = ctx.chat(r.session.id);
      const said = chat && chat.entries ? chat.entries.findLast((e) => e.k === "said") : null;
      return ctx.draft({ target: liveName(r.session), idea, context: { task: r.session.task || "", lastReply: said ? said.text : "" } });
    }
    // HQ's own words for a chat past 75% (compact) or 90% (hand off), sent as a send is: a read-back the owner confirms.
    // A message HQ sends reaches the chat as a hook's text, not as typed input, so it cannot run /compact: it asks the
    // chat to reach a clean stop and says the owner types /compact.
    case "context": {
      const r = chatOf(ctx, args[0], { exact: true });
      if (!r.ok) return reply(400, r.error);
      const how = String(args[1] || "").trim().toLowerCase();
      if (how !== "compact" && how !== "handoff") return reply(400, "say compact or handoff: context <chat> <compact|handoff>");
      const s = r.session;
      const full = s.context ? `VibeQuarters: your context is ${s.context.pct}% full` : "VibeQuarters: your context is filling up";
      const text = how === "compact"
        ? `${full}. Finish the step you are on, then stop and say in one line that you are ready to compact. The user types /compact in this chat, since a message VibeQuarters sends cannot run a command. Start nothing new until then.`
        : `${full}, so this chat should hand off to a fresh session. Finish or park the step you are on and leave nothing half done, then reply with a handoff prompt for a fresh session: the goal, what is done, what is left, the branch and folder, the files in flight, and the exact next step. Then stop.`;
      const no = ctx.canSend(s.id, text);
      if (no) return no;
      return proposed(ctx.propose({ kind: "send", sessionId: s.id, name: liveName(s), text }));
    }
    case "open": {
      if (!args.join(" ").trim()) return reply(400, "say the prompt: open <prompt>");
      const prompt = plainText(args.join(" ")); // cleaned as a send's text is: line breaks as \n, other controls gone
      if (prompt === null) return reply(400, "the prompt must be 1 to 2000 characters");
      // the new tab knows the words came through the assistant, as a sent message does (bridge/hq-inbox.js)
      return proposed(ctx.propose({ kind: "open", prompt: OPEN_LABEL + prompt }));
    }
    default:
      return reply(400, `unknown command: ${cap(oneLine(cmd), 40)}`);
  }
}

module.exports = { resolveSession, statusText, readText, runCommand, liveName, contextLevel };
