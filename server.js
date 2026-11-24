// Local HQ server (127.0.0.1 only; GET only unless `control` is on). Indexes asynchronously and incrementally
// so the page never hangs: until the first index is ready the APIs answer {building, progress}.
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildIndex, computeStats } = require("./collect");
const { loadConfig } = require("./config");
const { createHq } = require("./lib/hq");
const { createDecisions } = require("./lib/decisions");
const { newCursor, readNew } = require("./lib/tail");
const { plainNote, picksFit, answerKey, canConfirm } = require("./bridge/hq-bridge");
const { createInbox, plainText, textHash } = require("./lib/inbox");
const { loadInstance, sealedConfig, settingsPath } = require("./lib/instance");
const { createWindow, windowEndLine } = require("./lib/window");
const { levelOf } = require("./lib/levels");
const { judgeItems, itemOf } = require("./lib/judge");
const { createReminder } = require("./lib/remind");
const { createReadbacks, refusal, confirmFailLine, readbackText } = require("./lib/readback");
const { createSettled, confirmedOutcome } = require("./lib/settled");
const { runCommand } = require("./lib/assistant-cmds");
const { createHeadsUp } = require("./lib/heads-up");
const childProcess = require("child_process");
const { createAssistant, claudePath } = require("./lib/assistant");
const { draftPrompt } = require("./lib/drafter");
const { spokenOf } = require("./lib/spoken");
const { createSpeechStream } = require("./lib/speech-stream");
const { ttsStream } = require("./lib/tts");
const { hear } = require("./lib/hear");
const { openSession } = require("./lib/opener");
const { createBoard } = require("./lib/board");
const { createQueue } = require("./lib/queue");
const { createFeed } = require("./lib/feed");
const { createDeploys } = require("./lib/deploys");
const { createSwitches, createEnforcement } = require("./lib/switches");
const { planOf, accountsOf } = require("./lib/accounts");
const { createApprovals } = require("./lib/approvals");
const { Readable } = require("stream");

const DIR = __dirname;
// --demo (lib/demo.js): made-up sessions in a throwaway folder, read through a generated settings file, so the real
// ~/.claude is never read
const DEMO = require.main === module && process.argv.includes("--demo");
const demo = DEMO ? require("./lib/demo") : null;
// Every folder this copy reads and writes: the default ones with no --settings, else the settings file's. A copy started
// from its settings stops on a settings problem with one line on stderr, never a stack or a path; required as
// a module, or with no settings file, the error is thrown as it always was.
const SETTINGS = DEMO ? demo.prepare({ appDir: __dirname }).settings : settingsPath(process.argv);
function stop(e) {
  if (!SETTINGS || require.main !== module) throw e;
  console.error(e.message);
  process.exit(1);
}
let inst, config;
try {
  inst = loadInstance(SETTINGS, { appDir: DIR, home: os.homedir() });
  config = loadConfig(DIR, inst.configPath);
  sealedConfig(SETTINGS, inst, config, os.homedir()); // the heartbeat paths are known only once the config is read
} catch (e) {
  // loadInstance's messages are one clean line already; a config file that cannot be read gets the same shape
  stop(SETTINGS && inst && e.code ? new Error(`settings ${path.basename(SETTINGS)}: configPath cannot be read (${e.code})`) : e);
}

// The context size at which Claude Code compacts a chat, from its own settings; unknown, the page shows no context gauge.
function compactAtOf(dataDir) {
  try {
    const n = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")).autoCompactWindow;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
// The drafter's { at, costUsd, model } rows (lib/drafter.js), for the assistant's weekly usage; a bad line is skipped
function drafterRows() {
  let text;
  try {
    text = fs.readFileSync(path.join(inst.stateDir, "assistant", "usage.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((l) => {
    try {
      return l ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
}
// The assistant's own chats (each one it starts is added): flagged in the payload, never a reply item, never found by a
// command
const assistantChats = new Set();
// Answering from HQ: only when run as a program with `control: true` in its config, and never in a sealed
// copy. Off, there is no POST route, no token and no decisions folder, and the bridge stays silent.
const control = require.main === module && config.control === true && !inst.sealed;
// Where the system pack is installed (config systemDir, default <dataDir>/vibequarters, which is ~/.claude/vibequarters): its
// hooks folder gives the Queue panel the gate's own process matcher, and its presets folder the approval presets. A
// leading ~ is the home folder. Missing, the panels it feeds still work and say what they cannot know.
const systemDir = !config.systemDir ? path.join(inst.dataDir, "vibequarters") : config.systemDir.startsWith("~") ? path.join(inst.homeDir, config.systemDir.slice(1)) : path.resolve(inst.configPath ? path.dirname(inst.configPath) : DIR, config.systemDir);
const usageDir = path.join(inst.dataDir, "vibequarters-usage"); // the usage-line mod's plan readings (plan-usage.json)
// the plan meter's figures; the account's key stays on the server
function planForPage() {
  const p = planOf(path.join(usageDir, "plan-usage.json"));
  return p && { pct: p.pct, fiveHour: p.fiveHour, resetsAt: p.resetsAt, at: p.at };
}
// What each chat's hq-feed mod reports (keep-warm, spend brake), and the keep-warm switch VibeQuarters writes for it
const feed = createFeed(path.join(inst.dataDir, "hq-feed"));
// The agents switched off on the page (POST /api/agents), in the file the system pack's hq-agent-switch hook reads to
// deny their subagents; whether that hook is registered in Claude Code's settings decides the page's install note
const switches = createSwitches({ file: path.join(inst.dataDir, "hq-feed", "agents-off.json"), agents: config.agents || [] });
const switchesEnforced = createEnforcement(path.join(inst.dataDir, "settings.json"));
// The deploy wall (config deploys): off with no config
const deploys = config.deploys ? createDeploys(config.deploys, demo ? { run: demo.deploysRun() } : undefined) : null; // a demo asks GitHub nothing
// The Queue panel's read-only view of the coordination folder (lib/queue.js), next to the registry the board reads.
// GitHub is asked only about the repositories the config lists (queue.repos), so with none nothing leaves this computer.
// A sealed copy loads no hook code and asks GitHub nothing, so it reaches nothing outside its own data.
const queueCfg = config.queue || {};
const queue = createQueue({ dir: path.dirname(inst.registryPath), hooksDir: inst.sealed ? null : path.join(systemDir, "hooks"), github: !inst.sealed && !!(queueCfg.repos && queueCfg.repos.length), repos: queueCfg.repos || null, requiredChecks: queueCfg.requiredChecks || null, mainBranch: queueCfg.mainBranch || "main", ...(demo ? demo.queueOptions : {}) });
// How much an approve window approves (lib/approvals.js): the preset picked on the page, else approval-levels.json
const approvals = createApprovals({ stateDir: inst.stateDir, systemDir, levelsFile: path.join(DIR, "approval-levels.json") });
const hq = createHq({
  config, board: createBoard(inst.registryPath), home: inst.homeDir, sessionsDir: path.join(inst.dataDir, "sessions"), feed, compactAt: compactAtOf(inst.dataDir),
  agentsOff: () => switches.offIds(), plan: planForPage,
  accounts: () => accountsOf({ file: path.join(usageDir, "accounts.json"), planFile: path.join(usageDir, "plan-usage.json"), labels: config.accountLabels || {}, record: !inst.sealed }),
  switchesEnforced: () => switchesEnforced(), assistantIds: () => assistantChats, drafterRows,
});
const TOKEN = control ? crypto.randomBytes(32).toString("hex") : null; // new every start; only the served page carries it
// The assistant's token for POST /api/assistant: new every start, served by no route; the assistant's
// process gets it in its env, a new one each time that process starts
let assistantToken = control ? crypto.randomBytes(32).toString("hex") : null;
const decisions = control ? createDecisions({ stateDir: inst.stateDir }) : null;
const streams = new Set(); // open /api/events responses, at most MAX_STREAMS
const MAX_STREAMS = 8; // one per open HQ tab with room to spare; a ninth is refused, never kept
let sentIds = ""; // the decision ids the stream last sent
let sentHq = ""; // the payload the stream last announced, from its first comma on (generatedAt left out)
// The bridge logs every answer it acts on, and HQ alerts when one has no click of its own behind it.
const LOG_READ = 256 * 1024; // one read of the answers log, in bytes
const MAX_ALERTS = 5;
const UNREADABLE_SCANS = 3; // failed scans in a row before a log that is there but cannot be read raises its alert
const startedAt = Date.now(); // a bridge line from before this, read in the first read that works, is history
const clicked = new Set(); // ids with HQ's own answer line (no source) in the answers log
const judged = new Set(); // ids whose bridge line was read: alerted once, or learned as history
let alerts = []; // newest first
let logAt = null; // where the next read of the answers log starts: { cursor, skip }, set at the first stat that works
let failures = 0; // scans in a row whose stat or read of the answers log failed while it was there
let saidUnreadable = false; // the unreadable alert, at most once a run
let firstRead = true; // until a read of the answers log works, or finds it not there: only that read can learn history
// The answers HQ wrote this run, by id, as answerKey text, the newest last; the bridge acts on an answer file only
// once HQ says it wrote exactly that answer. A restart forgets them all, which only means the bridge waits on.
const wrote = new Map();
const WROTE_MAX = 256;
const forged = new Set(); // ids whose answer HQ did not write was found: alerted once each
// Sending from the pop-up (bridge/hq-inbox.js): HQ holds one message per chat until a waiter for that chat listens,
// hands it over, and counts it delivered once it says yes to the waiter's check. A restart forgets every message;
// what a past run left in the inbox folder is removed at start.
const inbox = control ? createInbox({ stateDir: inst.stateDir }) : null;
const outbox = new Map(); // session id -> { id, text, hash, at, written }
const delivered = new Map(); // session id -> when HQ said yes to the check of its newest message
const takenBack = new Set(); // ids cancelled or expired, so a waiter's late check of one raises no alert
const confirmed = new Map(); // id -> { sessionId, hash, at } of a message HQ said yes to: one more yes within AGAIN_MS
const AGAIN_MS = 2 * 60e3; // covers the waiter's retry when HQ's first yes did not reach it in time
const OUTBOX_MS = 30 * 60e3; // a message no waiter has taken in this long is dropped
const SEND_BODY = 16384; // a send carries up to 2000 characters of the owner's text

// The approve window (lib/window.js), the read-backs (lib/readback.js) and the settled history of both read-backs and
// decisions (lib/settled.js), with control on only; memory only, so a restart closes the window, drops every proposal
// and forgets the history
const approveWindow = control ? createWindow({ file: path.join(inst.stateDir, "approve-window.json") }) : null;
const restoredWindow = approveWindow && approveWindow.current(Date.now());
if (restoredWindow) hq.setWindow({ open: true, endsAt: restoredWindow.endsAt, sessions: restoredWindow.sessions, approved: restoredWindow.approved });
const settled = control ? createSettled() : null;
// A step the assistant asked the owner's yes for (kind "tool"): its read-back id -> the process's request id. A card
// that leaves without the owner's yes (canceled, expired, Stop) refuses the step, so the process never waits on a card
// that is gone.
const stepAsks = new Map();
const readbacks = control ? createReadbacks({
  onSettle: (id, ...rest) => {
    settled.readback(id, ...rest);
    const req = stepAsks.get(id);
    if (req === undefined) return;
    stepAsks.delete(id);
    if (helper) helper.answer(req, false);
  },
}) : null;
// What HQ says on its own (lib/heads-up.js): the chats the assistant asked it to watch, a chat's context at 75% or 90%.
// Memory only.
const headsUp = createHeadsUp();

function syncDecisions() {
  if (!decisions) return;
  readLog();
  let open = decisions.scan(Date.now(), { stale: moved });
  hq.setRequests(open);
  lastOpen = open;
  if (applyWindow()) {
    open = decisions.scan(Date.now(), { stale: moved }); // what the window answered is no longer open
    hq.setRequests(open);
    lastOpen = open;
  }
  remind();
  settleDecisions();
  syncReadbacks(open);
  syncInbox();
  settleUnchecked(open);
}
// Each item that left the open list since the last look goes into the settled history, with the answer HQ wrote for it
// or none (lib/settled.js); syncReadbacks puts the history in the payload. Before the first index there is no payload,
// so nothing is taken as gone.
function settleDecisions(now = Date.now()) {
  const p = hq.payload();
  if (p) settled.sync(p.decisions, now);
}
// An answer HQ writes for an open item: the owner's click, a window's allow or a confirmed read-back. HQ keeps it,
// so the bridge's /api/verify finds every answer HQ wrote, and the settled history says who answered. False when the
// request is gone or already answered.
function recordAnswer(item, choice, { note, picks, via, windowId } = {}, now = Date.now()) {
  if (!decisions.answer(item.id, item, choice, now, choice === "revise" ? note : undefined, choice === "picks" ? picks : undefined, via, windowId)) return false;
  wrote.set(item.id, answerKey({ id: item.id, hash: item.hash, choice, note, picks }));
  if (wrote.size > WROTE_MAX) wrote.delete(wrote.keys().next().value);
  settled.answered(item.id, choice, via);
  return true;
}
// The approval levels (the preset picked on the page, lib/approvals.js, else approval-levels.json) and the judge's
// verdicts. A verdict is kept by the item's id and hash, so an item rewritten in place is judged again; a check that
// fails is tried once more after JUDGE_RETRY_MS, then its items are left for the owner. Memory only.
const JUDGE_BATCH = 8;
const JUDGE_RETRY_MS = 30e3;
const verdicts = new Map(); // id:hash -> { approve, why }
const judgeFails = new Map(); // id:hash -> { n, at }
let judgingNow = false;
let lastOpen = []; // the open requests as the bridge wrote them, from the last scan
const verdictKey = (item) => item.id + ":" + item.hash;
// What the window does with one covered item: "allow", "leave" (the owner's), or "judge" (no verdict yet). With the
// judge off everything but routine is left for the owner. A saved preset decides it (on only for "Routine plus an AI
// judge"); with none saved, config "judge" does (absent or false is off, the default).
function windowLevel(item) {
  const req = lastOpen.find((r) => r.id === item.id);
  if (!req || req.hash !== item.hash) return "leave";
  const now = approvals.current();
  const level = levelOf(now.levels, req);
  if (level === "routine") return "allow";
  if (level === "yours" || !(now.preset ? now.judge : config.judge === true)) return "leave";
  const v = verdicts.get(verdictKey(item));
  return v ? (v.approve ? "allow" : "leave") : "judge";
}
// One judge run on up to JUDGE_BATCH waiting items. Its verdicts only ever act through applyWindow, so one that comes
// back after the window ended approves nothing; a later window the owner opens may use it for the same item and hash.
function startJudge(items, p, now) {
  if (judgingNow) return;
  const due = items.filter((item) => {
    const f = judgeFails.get(verdictKey(item));
    return !f || now - f.at >= JUDGE_RETRY_MS;
  }).slice(0, JUDGE_BATCH);
  if (!due.length) return;
  judgingNow = true;
  const taskOf = (id) => {
    const s = p.sessions.find((x) => x.id === id);
    return s && typeof s.task === "string" ? s.task : "";
  };
  // a throw while starting counts as a failed check, and one while applying the answer is logged, never left unhandled
  // (an unhandled rejection stops HQ) and never leaves judgingNow stuck on
  let run;
  try {
    const asked = due.map((item) => itemOf(lastOpen.find((r) => r.id === item.id), item, taskOf(item.sessionId)));
    run = judgeItems(asked, { spawn: childProcess.spawn, claude: claudeBin(), rulesFile: path.join(DIR, "assistant", "judge.md"), stateDir: inst.stateDir });
  } catch {
    run = Promise.resolve({ ok: false });
  }
  run.catch(() => ({ ok: false })).then((r) => {
    judgingNow = false;
    if (r.ok) for (const v of r.verdicts) verdicts.set(v.id + ":" + v.hash, { approve: v.approve, why: v.why });
    else
      for (const item of due) {
        const k = verdictKey(item);
        const f = judgeFails.get(k);
        if (f) verdicts.set(k, { approve: false, why: "the check failed" });
        else judgeFails.set(k, { n: 1, at: Date.now() });
      }
    syncDecisions();
    publish();
  }).catch((e) => {
    judgingNow = false;
    console.error("hq: the judge's answer could not be applied:", e && e.message);
  });
}
// While the window runs, HQ answers allow for each open item it covers (every permission, Risky ones, plans and safety
// prompts too, never a question or a notice) that the levels call routine or the judge finds fine, logged via "window";
// when it ends (time, off, replaced) HQ says so, naming the deletes and live changes, with what still waits. The payload
// shows it. True when it answered any.
function applyWindow(now = Date.now()) {
  if (!approveWindow) return false;
  const p = hq.payload();
  const w = approveWindow.current(now);
  let answered = false;
  if (w && p) {
    const toJudge = [];
    for (const item of p.decisions) {
      if (!approveWindow.covers(item, now)) continue;
      const act = windowLevel(item);
      if (act === "judge") toJudge.push(item);
      else if (act === "allow" && recordAnswer(item, "allow", { via: "window", windowId: w.id }, now)) {
        approveWindow.note(item.risk && item.risk.reason);
        answered = true;
      }
    }
    if (toJudge.length) startJudge(toJudge, p, now);
  }
  if (p) {
    const open = new Set(p.decisions.map(verdictKey));
    for (const k of [...verdicts.keys(), ...judgeFails.keys()])
      if (!open.has(k)) {
        verdicts.delete(k);
        judgeFails.delete(k);
      }
  }
  const ended = approveWindow.takeEnded();
  if (ended.length) {
    const waiting = p ? p.decisions.filter((d) => d.kind === "permission" && !d.notice).length : 0;
    for (const e of ended) emit("say", { id: e.id, text: windowEndLine(e.approved, waiting, e.tally) });
  }
  const cur = approveWindow.current(now);
  hq.setWindow(cur ? { open: true, endsAt: cur.endsAt, sessions: cur.sessions, approved: cur.approved } : { open: false, endsAt: null, sessions: null, approved: 0 });
  return answered;
}
// The 30-second reminder (lib/remind.js): said out loud and noted in the Assistant panel, once per approval that waited
// 30 seconds and that HQ will not approve itself (no window covers it, or the levels or the judge left it for the owner)
const reminder = createReminder();
function remind(now = Date.now()) {
  const p = hq.payload();
  if (!p) return;
  const auto = (item) => !!approveWindow && approveWindow.covers(item, now) && windowLevel(item) !== "leave";
  const text = reminder.next(p.decisions, auto, now);
  if (!text) return;
  emit("say", { id: crypto.randomBytes(8).toString("hex"), text });
  if (helper) helper.note({ role: "system", text });
}
// The approve window's off: from the page's button or the assistant's `window off`
function windowOff() {
  approveWindow.close("off", Date.now());
  applyWindow();
  publish();
}
const workingNow = (s) => !!s && (s.status === "working" || s.status === "thinking");
// After each refresh: each heads-up is said out loud and noted in the Assistant panel, so the owner sees it in HQ too
function checkWatches() {
  const p = hq.payload();
  if (!p) return;
  for (const text of headsUp.next(p.sessions)) {
    emit("say", { id: crypto.randomBytes(8).toString("hex"), text });
    if (helper) helper.note({ role: "system", text });
  }
  showAssistant(false);
}
// What the assistant's commands (lib/assistant-cmds.js) may ask of HQ: whether a chat would take a message now, a
// read-back proposal (an answer, a window, a message, a new session), the window's off, a watch, a draft. Nothing here
// answers a decision, sends a message or opens a session: those wait for the owner's yes (confirmReadback).
const assistantCtx = {
  now: () => Date.now(),
  payload: () => hq.payload(),
  chat: (id) => hq.chat(id),
  // a chat that cannot take this message now (busy with one, or not listening) is said before any read-back
  canSend(id, text) {
    const r = queueMessage({ sessionId: id, text }, "assistant", true);
    return r.status === 200 ? null : { status: r.status, text: r.text };
  },
  // one prompt from the owner's idea (lib/drafter.js, Opus, no tools), for the assistant to send through a read-back
  draft: (d) =>
    draftPrompt(d, { spawn: childProcess.spawn, claude: claudeBin(), rulesFile: path.join(DIR, "assistant", "draft.md"), stateDir: inst.stateDir }).then((r) =>
      r.ok ? { status: 200, text: r.text } : { status: 502, text: r.error },
    ),
  propose: (p) => proposeReadback(p),
  windowOff,
  watch(id) {
    const p = hq.payload();
    headsUp.watch(id, workingNow(p && p.sessions.find((x) => x.id === id)));
  },
};
// The HQ assistant (lib/assistant.js): with control on and an `assistant` key in the config, made once HQ listens, as
// its process needs HQ's port. Each start's new token is the only one /api/assistant takes, and every day's conversation
// is marked the assistant's chat, so it never shows as waiting on the owner. Off: null, and /api/say says so.
let helper = null;
// short spoken lines kept once made (/api/tts): voice + model + text -> the MP3; memory only, at most 50 of them
const TTS_KEEP_CHARS = 40, TTS_KEEP_MAX = 50;
const ttsKept = new Map();
const claudeBin = () => (config.assistant && config.assistant.claude) || claudePath();
function makeAssistant(port) {
  if (!control || !config.assistant) return;
  helper = createAssistant({
    claude: claudeBin(),
    cwd: inst.homeDir, // the home folder, where a new Claude Code session starts by default
    stateDir: inst.stateDir,
    port,
    hqaPath: path.join(DIR, "bin", "hqa-mcp.js"),
    promptFile: path.join(DIR, "assistant", "prompt.md"),
    onToken: (token, sessionId) => {
      assistantToken = token;
      assistantChats.add(sessionId);
    },
  });
  for (const id of helper.sessionIds()) assistantChats.add(id);
  // a step the owner's rules ask about: a read-back card, spoken; one HQ will not read back is refused at once
  helper.onAsk((x) => {
    const r = proposeReadback({ kind: "tool", ...x });
    if (r.ok) stepAsks.set(r.id, x.requestId);
    else helper.answer(x.requestId, false);
  });
  // its process ended with the step still waiting: the card goes
  helper.onAskGone((req) => {
    for (const [id, r] of stepAsks) if (r === req) {
      stepAsks.delete(id);
      readbacks.cancel(id, "dropped: the assistant stopped", "VibeQuarters");
      syncReadbacks(decisions.scan(Date.now(), { stale: moved }));
      publish();
    }
  });
  // words a reply always opens with (assistant.stripOpeners) that the voice leaves out
  const openers = config.assistant.stripOpeners || [];
  // real-time talking: each message is spoken while it is written (lib/speech-stream.js)
  const speech = createSpeechStream({ openers, say: (text) => emit("say", { id: crypto.randomBytes(8).toString("hex"), text }) });
  helper.onStream((x) => (x.kind === "start" ? speech.start() : x.kind === "text" ? speech.text(x.text) : speech.end()));
  helper.onReply((r) => {
    // a reply that streamed nothing (no partial messages came) is said whole, as before
    const said = !speech.saidAny() && r.text ? spokenOf(r.text, { openers }) : "";
    if (said) emit("say", { id: r.id, text: said });
    speech.turn();
    showAssistant();
  });
  process.on("exit", () => helper.stop());
  showAssistant();
}
// The panel's view of the assistant in the payload (null while it is off); publish when it changed
function showAssistant(send = true) {
  if (hq.setAssistant(helper ? { state: helper.state(), messages: helper.messages(), usage: null } : null) && send) publish();
}

// The read-backs waiting for the owner's yes, each with when it expires, in the payload; one for an answer whose request
// is no longer open (answered elsewhere, or gone) is dropped, and an expired one drops itself, each kept in the settled
// history, which goes in the payload with them.
function syncReadbacks(open, now = Date.now()) {
  if (!readbacks) return;
  const ids = new Set(open.map((r) => r.id));
  for (const r of readbacks.list(now)) if (r.kind === "answer" && !ids.has(r.decisionId)) readbacks.cancel(r.id, "dropped: answered elsewhere", "VibeQuarters", now);
  hq.setReadbacks(readbacks.list(now).map(({ id, kind, text, at, expiresAt }) => ({ id, kind, text, at, expiresAt })));
  hq.setSettled(settled.list());
}
// A proposal from the assistant's channel: listed and spoken as its fixed read-back, written only on the owner's yes
function proposeReadback(p, now = Date.now()) {
  const r = readbacks.propose(p, now);
  if (!r.ok) return r;
  emit("say", { id: r.id, text: r.spoken + " Say yes to confirm, or cancel." });
  syncReadbacks(decisions.scan(now, { stale: moved }), now);
  publish();
  return r;
}
// The panel's line for a prompt that went in (shown whole) or did not (with HQ's reason)
function noteSent(name, text, error) {
  if (!helper) return;
  helper.note(error ? { role: "system", text: `Not sent to ${name}: ${error}` } : { role: "sent", name, text });
  showAssistant();
}
// The owner's yes to a send: the message goes to its chat as the owner's pop-up sends one, marked via "assistant"
function sendConfirmed(p) {
  const r = queueMessage({ sessionId: p.sessionId, text: p.text }, "assistant");
  noteSent(p.name, p.text, r.status === 200 ? null : r.text);
  return r.status === 200 ? true : r.text;
}
// The owner's yes to a new session: a new attended tab with the prompt (lib/opener.js), in the last focused VS Code
// window
function openConfirmed(p) {
  return openSession({ prompt: p.prompt }).then((r) => {
    noteSent("a new session", p.prompt, r.ok ? null : r.error);
    return r.ok ? true : r.error;
  });
}
// The owner's yes to a read-back: a window opens; a message or a new session goes out; an answer is written only for
// the same item, still open, under the hash it was proposed on, with every limit checked again on the item as it is
// now. True, or why not (a new session's, a promise of it).
function confirmReadback(p, now = Date.now()) {
  if (p.kind === "tool") {
    for (const [id, r] of stepAsks) if (r === p.requestId) stepAsks.delete(id);
    return helper && helper.answer(p.requestId, true) ? true : "the assistant is no longer waiting for it";
  }
  if (p.kind === "send") return sendConfirmed(p);
  if (p.kind === "open") return openConfirmed(p);
  if (p.kind === "window") {
    const r = approveWindow.open({ minutes: p.minutes, sessions: p.sessions }, now);
    if (!r.ok) return r.error;
    applyWindow(now);
    return true;
  }
  syncDecisions();
  const pay = hq.payload();
  const item = pay && pay.decisions.find((d) => d.id === p.decisionId && d.kind !== "reply");
  if (!item || item.hash !== p.item.hash) return "not open";
  const error = refusal({ ...p, item });
  if (error) return error;
  if (p.choice === "revise" && !plainNote(p.note)) return "note must be one line of 1 to 500 characters";
  return recordAnswer(item, p.choice, { note: p.note, via: "readback" }, now) ? true : "not open";
}
// The owner's yes, carried out (confirmReadback) and kept in the settled history with what came of it: done, or not done
// with HQ's reason. One that threw is kept as failed and throws on, for the route to log.
function confirmAndKeep(id, p) {
  const keep = (done) => settled.readback(id, readbackText(p), confirmedOutcome(p, done), "you", Date.now());
  return Promise.resolve()
    .then(() => confirmReadback(p))
    .then(
      (done) => (keep(done), done),
      (e) => {
        keep("failed");
        throw e;
      },
    );
}
// An alert that HQ could not confirm an answer in time asks the owner to answer again, so it lasts only while there is
// something to answer: its request still open, or its message still held for its chat. Once that is answered (here or in
// VS Code), delivered, taken back or gone, the alert goes. Every other alert stays as it was.
function settleUnchecked(open) {
  const live = new Set(open.map((r) => r.id));
  for (const m of outbox.values()) live.add(m.id);
  const kept = alerts.filter((a) => !a.unchecked || live.has(a.id));
  if (kept.length === alerts.length) return;
  alerts = kept;
  hq.setAlerts(alerts);
}
// Each message HQ holds goes to its chat's waiter once one listens; one a waiter removed without a yes (it stood down,
// or found it bad) is handed over again; one older than OUTBOX_MS is dropped. The payload says which chats listen, which
// have a message waiting, and when each chat's newest message was delivered.
function syncInbox(now = Date.now(), done = null) {
  if (!inbox) return;
  const on = inbox.listening();
  if (done) on.delete(done); // its waiter has its message and is ending, its wait file a moment from gone
  for (const [id, c] of confirmed) if (now - c.at >= AGAIN_MS) confirmed.delete(id);
  for (const [sid, m] of outbox) {
    if (now - m.at > OUTBOX_MS) {
      if (m.written) inbox.take(sid);
      takenBack.add(m.id);
      outbox.delete(sid);
      continue;
    }
    if (m.written && !inbox.waiting(sid)) m.written = false;
    if (!m.written && on.has(sid)) {
      try {
        inbox.put(sid, m);
        m.written = true;
      } catch {} // a folder that cannot be written now is tried again at the next sync
    }
  }
  hq.setInbox({ listening: [...on].sort(), pending: [...outbox.keys()].sort(), delivered: Object.fromEntries(delivered) });
}
// HQ's own yes, for a message: yes only for the message HQ holds for that chat, by its id and its text's hash; that yes
// is the delivery. The same check once more within AGAIN_MS is yes too, for a waiter that missed the first. A message
// file HQ never wrote, there in the inbox, raises one alert for its chat, so the owner sees it was found; nothing acted
// on it.
function verifiedSend(b) {
  if (typeof b.id !== "string" || !HEX32.test(b.id) || typeof b.sessionId !== "string" || !UUID.test(b.sessionId)) return false;
  const m = outbox.get(b.sessionId);
  // how it was sent (the assistant's, or the owner's own with no via) is part of what HQ wrote: it picks the wake's
  // prefix. The message HQ wrote, asked about with another via (a waiter that started before via existed sends none),
  // is a no but never an alert: HQ did write it.
  if (m && m.written && m.id === b.id && b.hash === m.hash && b.via !== m.via) return false;
  if (m && m.written && m.id === b.id && b.hash === m.hash && b.via === m.via) {
    outbox.delete(b.sessionId);
    confirmed.set(b.id, { sessionId: b.sessionId, hash: b.hash, via: b.via, at: Date.now() });
    delivered.set(b.sessionId, Date.now());
    syncInbox(Date.now(), b.sessionId);
    if (ready) publish();
    return true;
  }
  const c = confirmed.get(b.id);
  if (c) {
    confirmed.delete(b.id);
    if (c.sessionId === b.sessionId && c.hash === b.hash && c.via === b.via && Date.now() - c.at < AGAIN_MS) return true;
  }
  if (!takenBack.has(b.id) && !forged.has(b.id) && inbox && inbox.waiting(b.sessionId)) {
    forged.add(b.id);
    alerts = [foreign({ id: b.id, sessionId: b.sessionId, tool: "VibeQuarters message" }, Date.now(), false), ...alerts].slice(0, MAX_ALERTS);
    hq.setAlerts(alerts);
    if (ready) publish();
  }
  return false;
}
// A notice ends when its prompt is answered in VS Code: the asking chat (a subagent's own file when it names one) has
// moved past it, a typed prompt or a new message over 2 s after it was asked, or for a question its own call's result
// (hq.movedOn). A transcript HQ does not follow says nothing.
function moved(r) {
  return hq.movedOn(r.sessionId, r.agentId, r.askedAt, r.toolUseId) === true;
}
// Reads what the answers log gained since the last read, at most 256 KB a read. HQ's own line (no source) marks its id
// clicked; a bridge line whose id has no such line before it is an answer HQ did not write, judged once: it is history,
// learned and never alerted, only when its time is before HQ started AND it was read in the first read that worked (a
// log not there counts as that read, with nothing in it). Any other alerts: one at or after the start, one whose time
// does not parse, and one read in any later read whatever its time says. An unconfirmed line is an answer the bridge
// found while the port file named a process it could not confirm as this server: one alert for its request, shared with
// the check's (verified), under the same history rule. An unchecked line is an answer the bridge could not confirm in
// time (its lookup or its check failed or was slow): an alert of its own for each line, never the outside-HQ one, under
// the same history rule, kept only while its request or message is open (settleUnchecked). The first read begins at the
// log's last 256 KB (its first line dropped, as it may be cut) at the first stat that works, or at 0 when the log is
// not there; a read that fails leaves the cursor where it was for the next scan. A log rewritten in place is read again
// from its start (the guard).
function readLog() {
  if (!logAt) {
    let size = 0;
    try {
      size = fs.statSync(decisions.log).size;
    } catch (e) {
      if (e.code !== "ENOENT") return unreadable();
    }
    logAt = { cursor: { ...newCursor(), pos: Math.max(0, size - LOG_READ) }, skip: size > LOG_READ };
  }
  const r = readNew(decisions.log, logAt.cursor, LOG_READ, { guard: 64 });
  if (r.failed) {
    if (missing()) {
      failures = 0; // a log that is not there is no failure, and has no history
      firstRead = false;
    } else unreadable();
    return;
  }
  failures = 0;
  const first = firstRead;
  firstRead = false;
  logAt.cursor = r.cursor;
  let lines = r.lines;
  if (r.reset) logAt.skip = false; // replaced or cut short: read again from its start, whole lines only
  if (logAt.skip && lines.length) {
    lines = lines.slice(1);
    logAt.skip = false;
  }
  const found = []; // this read's alerts, oldest first; the payload is set once, after the read
  for (const l of lines) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !HEX32.test(e.id)) continue;
    if (!("source" in e)) clicked.add(e.id);
    else if (e.source === "bridge" && !clicked.has(e.id) && !judged.has(e.id)) {
      judged.add(e.id);
      if (!(first && timeOf(e.at) < startedAt)) found.push(foreign(e));
    } else if (e.source === "unconfirmed" && !forged.has(e.id)) {
      forged.add(e.id); // the bridge found an answer it could not confirm with HQ's own server; nothing acted on it
      if (!(first && timeOf(e.at) < startedAt)) found.push(foreign(e, Date.now(), false));
    } else if (e.source === "unchecked" && !(first && timeOf(e.at) < startedAt)) {
      // the bridge's lookup or check could not tell in time whether HQ wrote an answer: no tamper alert, one alert per
      // line saying so, so a second try that also fails shows too
      found.push({ at: Date.now(), id: e.id, sessionName: nameOf(e.sessionId), toolName: typeof e.tool === "string" && e.tool.length <= 128 ? e.tool : null, unchecked: true });
    }
  }
  if (found.length) {
    alerts = [...found.slice(-MAX_ALERTS).reverse(), ...alerts].slice(0, MAX_ALERTS);
    hq.setAlerts(alerts);
  }
}
const timeOf = (at) => (typeof at === "string" ? Date.parse(at) : NaN); // NaN when it does not parse
// Whether the answers log is not there; a log that is there but cannot be looked at is not missing.
function missing() {
  try {
    fs.statSync(decisions.log);
    return false;
  } catch (e) {
    return e.code === "ENOENT";
  }
}
// One more scan whose stat or read of a log that is there failed: on the third in a row, one line on stderr naming no
// path and one alert at the front of the list, at most once a run.
function unreadable() {
  failures++;
  if (failures < UNREADABLE_SCANS || saidUnreadable) return;
  saidUnreadable = true;
  console.error(`the answers log cannot be read (${failures} scans in a row): VibeQuarters cannot tell whether an answer came from outside it`);
  alerts = [{ at: Date.now(), id: null, sessionName: null, toolName: null, unreadable: true }, ...alerts].slice(0, MAX_ALERTS);
  hq.setAlerts(alerts);
}
// An answer HQ did not write: one line in the answers log and one line on stderr naming no path; it returns the alert,
// the newest of at most 5 in the payload. The line's session id and tool are anyone's text: the session becomes the name
// HQ last showed for it (else null), and the tool is kept only as text of at most 128 characters (else null). `acted`:
// a bridge line says the bridge acted on it; else the bridge's check found it and nothing acted on it.
function foreign(e, now = Date.now(), acted = true) {
  const sessionName = nameOf(e.sessionId);
  const toolName = typeof e.tool === "string" && e.tool.length <= 128 ? e.tool : null;
  try {
    fs.appendFileSync(decisions.log, JSON.stringify({ at: new Date(now).toISOString(), id: e.id, session: sessionName, tool: toolName, source: "outside VibeQuarters" }) + "\n");
  } catch {}
  console.error(acted ? `an answer VibeQuarters did not write was acted on, from outside VibeQuarters (request ${e.id})` : `an answer VibeQuarters did not write was found, from outside VibeQuarters; nothing acted on it (request ${e.id})`);
  return { at: now, id: e.id, sessionName, toolName };
}
// The bridge's check before it acts on an answer file. Yes only for exactly an answer HQ wrote this run; the reply
// says yes or no and nothing else. An answer HQ did not write for a request the bridge has open raises one alert for
// that request, so the owner sees it was found; nothing else changes.
function verified(b) {
  if (!b || typeof b !== "object" || typeof b.id !== "string" || !HEX32.test(b.id)) return false;
  if (b.kind === "send") return verifiedSend(b);
  let key = null;
  try {
    key = answerKey(b);
  } catch {}
  if (key !== null && wrote.get(b.id) === key) return true;
  if (!forged.has(b.id) && fs.existsSync(path.join(decisions.dir, b.id + ".json"))) {
    forged.add(b.id);
    alerts = [foreign({ id: b.id, sessionId: b.sessionId, tool: b.toolName }, Date.now(), false), ...alerts].slice(0, MAX_ALERTS);
    hq.setAlerts(alerts);
    if (ready) publish();
  }
  return false;
}
function nameOf(sessionId) {
  const p = hq.payload();
  if (!p) return null;
  const s = p.sessions.find((x) => x.id === sessionId);
  if (s) return s.name;
  const d = p.decisions.find((x) => x.sessionId === sessionId);
  return d ? d.sessionName : null;
}
function emit(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(msg);
}
// Tells open event streams what changed: the decision ids, and that the payload changed at all.
function publish() {
  const p = hq.payload();
  if (!p) return;
  const ids = p.decisions.map((d) => d.id);
  if (ids.join(",") !== sentIds) {
    sentIds = ids.join(",");
    emit("decisions", { count: ids.length, ids });
  }
  const t = hq.json();
  const body = t.slice(t.indexOf(","));
  if (body !== sentHq) {
    sentHq = body;
    emit("hq", {});
  }
}
let watcher = null; // the decisions folder's watch; one that fails is closed, and the next refresh arms a new one

// Watches the decisions folder (made if missing) so a new or removed request shows within 100 ms; the 4 s refresh
// rescans as a safety net and calls this again, so a failed watch is replaced.
function watchDecisions() {
  if (!decisions || watcher) return;
  try {
    decisions.ensure();
    const folder = fs.statSync(decisions.dir).ino;
    let wait = null;
    const w = fs.watch(decisions.dir, () => {
      // Windows reports a deleted folder as an endless run of events, never an error, even once a new one is made
      if (!sameFolder(folder)) return unwatch(w, "folder gone");
      clearTimeout(wait);
      wait = setTimeout(() => {
        try {
          syncDecisions();
          if (ready) publish();
        } catch (e) {
          console.error(e); // a bad file never stops the server; the next change or refresh tries again
        }
      }, 100);
    });
    w.on("error", (e) => unwatch(w, e.code || "error"));
    watcher = w;
  } catch {}
}
function sameFolder(ino) {
  try {
    return fs.statSync(decisions.dir).ino === ino;
  } catch {
    return false;
  }
}
// One line naming no path (an fs error's message carries one), and the watch closed for the next refresh to replace.
function unwatch(w, why) {
  if (watcher !== w) return;
  watcher = null;
  w.close();
  console.error(`decisions folder watch stopped (${why}); the next refresh watches it again`);
}
const indexOwn = (onProgress) => buildIndex(onProgress, inst.projectsDir, { cacheFile: inst.cacheFile, home: inst.homeDir });
let stats = null;
let ready = false;
let error = null; // the last refresh's failure, cleared by the next good one
let progress = { done: 0, total: 0 };
let busy = false;

// `build` is a seam for tests; the server itself always indexes its own data folder.
async function refresh(build = indexOwn) {
  watchDecisions();
  if (busy) return;
  busy = true;
  try {
    const index = await build((d, t) => {
      progress = { done: d, total: t };
    });
    stats = computeStats(index.mains, index.subMtime, config.planUsd, index.subs);
    await hq.update(index, stats);
    syncDecisions();
    checkWatches();
    showAssistant(false); // a crash or an idle stop shows by the next refresh; published below
    if (deploys) deploys.poll().then(() => hq.setDeploys(deploys.view()) && publish()); // its own pace (15 s building, 60 s idle); never holds the refresh
    ready = true;
    error = null;
    publish();
  } catch (e) {
    console.error(e);
    error = String((e && e.stack) || e);
    stats = { error };
  } finally {
    busy = false;
  }
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".glb": "model/gltf-binary", ".png": "image/png", ".svg": "image/svg+xml",
};
const ROOTS = { "/public/": "public", "/vendor/": "vendor", "/assets/": "assets" };
// The pinned engine never changes between launches, so the browser may keep it an hour; the page, its modules and the
// two APIs are always fetched fresh.
const CACHED = ["/vendor/", "/assets/"];
const INDEX = path.join(DIR, "public", "index.html");
const MAX_BODY = 4095; // "a body under 4 KB"
const HEAR_BODY = 1024 * 1024; // public/hear.js cuts a phrase at 30 s, 960 KB
const BODY_MS = 5000; // a body not whole by then is refused (408), so no slow client holds a socket
const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Bytes that are not UTF-8 are bad JSON, never U+FFFD; a byte order mark is kept, so JSON.parse refuses it as before
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// A refused POST closes its connection, so the rest of its body is never read.
const closing = (req) => (req.method === "POST" ? { Connection: "close" } : undefined);

// The two write routes and the bridge's check. The Host was checked in handler; then the Origin, the token,
// the type and the size, before a byte of the body is used: 403 for who is asking, 400 for what they sent. The check
// comes from the bridge, a program on this computer: it carries no token, and any request a browser marks (an Origin or
// a fetch site) is refused, so no web page can ask it.
function post(req, res) {
  const refuse = (status, text) => send(res, status, "text/plain", text, closing(req));
  const url = (req.url || "/").split("?")[0];
  if (url !== "/api/answer" && url !== "/api/presence" && url !== "/api/verify" && url !== "/api/send" && url !== "/api/warm" && url !== "/api/agents" && url !== "/api/approvals" && url !== "/api/window" && url !== "/api/readback" && url !== "/api/assistant" && url !== "/api/say" && url !== "/api/tts" && url !== "/api/hear") return refuse(404, "not found");
  const verify = url === "/api/verify";
  // the assistant's channel, like the check, is for a program on this computer, never a web page; it takes its own token
  const assistant = url === "/api/assistant";
  const audio = url === "/api/hear"; // one phrase from the page's mic, as a WAV (lib/hear.js)
  const max = audio ? HEAR_BODY : url === "/api/send" || assistant ? SEND_BODY : MAX_BODY;
  if (verify || assistant ? req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined : req.headers.origin !== "http://" + req.headers.host) return refuse(403, "wrong origin");
  const got = Buffer.from(String((assistant ? req.headers["x-hq-assistant-token"] : req.headers["x-hq-token"]) || ""));
  const want = Buffer.from(assistant ? assistantToken : TOKEN);
  if (!verify && (got.length !== want.length || !crypto.timingSafeEqual(got, want))) return refuse(403, "wrong token");
  if (audio ? !/^audio\/wav$/i.test(req.headers["content-type"] || "") : !/^application\/json(\s*;|$)/i.test(req.headers["content-type"] || "")) return refuse(400, audio ? "WAV only" : "JSON only");
  if (Number(req.headers["content-length"]) > max) return refuse(400, "too big");
  const parts = [];
  let size = 0, over = false; // over: refused for its size or its time, so the rest is never used
  const deadline = setTimeout(() => {
    over = true;
    refuse(408, "too slow");
  }, BODY_MS);
  res.on("close", () => clearTimeout(deadline));
  req.on("data", (c) => {
    if (over) return;
    size += c.length;
    if (size > max) {
      over = true;
      return refuse(400, "too big");
    }
    parts.push(c);
  });
  req.on("end", () => {
    clearTimeout(deadline);
    if (over) return;
    if (audio) {
      const gone = new AbortController(); // the page took this read back, or closed
      res.on("close", () => gone.abort());
      return hear({ wav: Buffer.concat(parts), whisperDir: config.assistant && config.assistant.whisperDir, signal: gone.signal }).then((r) => (r.ok ? send(res, 200, "application/json", JSON.stringify({ text: r.text })) : refuse(r.status, r.error)), () => send(res, 500, "text/plain", "failed"));
    }
    try {
      let b;
      try {
        b = JSON.parse(UTF8.decode(Buffer.concat(parts)));
      } catch {
        return refuse(400, "bad JSON");
      }
      if (verify) return send(res, 200, "application/json", JSON.stringify({ wrote: verified(b) }));
      if (url === "/api/presence") {
        if (!b || typeof b.focused !== "boolean") return refuse(400, "focused must be true or false");
        if (b.open !== undefined && typeof b.open !== "boolean") return refuse(400, "open must be true or false");
        decisions.presence(b.focused, b.open !== false);
        return send(res, 200, "application/json", '{"ok":true}');
      }
      if (url === "/api/send") return sendMessage(res, refuse, b);
      // one assistant command: { cmd, args }, its reply plain text (lib/assistant-cmds.js)
      if (assistant) {
        if (!b || typeof b.cmd !== "string" || !Array.isArray(b.args) || !b.args.every((a) => typeof a === "string") || Object.keys(b).length !== 2) return refuse(400, "cmd and args, a list of text");
        syncDecisions(); // the folder as it is now
        return runCommand(assistantCtx, b.cmd, b.args).then((r) => send(res, r.status, "text/plain; charset=utf-8", r.text), () => send(res, 500, "text/plain", "failed"));
      }
      // the owner's words to the assistant from the page: { text }, 1 to 2000 characters; or the panel's Stop: { stop:
      // true }
      if (url === "/api/say") {
        if (!helper) return refuse(503, "the assistant is off");
        if (b && b.stop === true && Object.keys(b).length === 1) {
          const r = helper.halt();
          if (readbacks && readbacks.cancelAll()) { // nothing it proposed waits for a yes
            syncReadbacks(decisions.scan(Date.now(), { stale: moved }));
            publish();
          }
          showAssistant();
          return send(res, 200, "application/json", JSON.stringify({ ok: true, stopped: r.stopped }));
        }
        // the mic opened: { warm: true } has the process up before the owner's words are
        if (b && b.warm === true && Object.keys(b).length === 1) {
          helper.warm();
          showAssistant();
          return send(res, 200, "application/json", '{"ok":true}');
        }
        // { text, reconsider: true } from the open mic: a turn on the last words that still runs ends, one answers both
        const keys = b ? Object.keys(b).filter((k) => k !== "reconsider") : [];
        const text = b && keys.length === 1 && (b.reconsider === undefined || b.reconsider === true) ? plainText(b.text) : null;
        if (text === null) return refuse(400, "text must be 1 to 2000 characters");
        const r = helper.say(text, { reconsider: b.reconsider === true });
        showAssistant();
        return r.ok ? send(res, 200, "application/json", JSON.stringify({ ok: true, queued: r.queued })) : refuse(409, r.error);
      }
      // a line to speak in the assistant's voice: { text }, 1 to 600 characters, streamed back as ElevenLabs' audio/mpeg.
      // The key is read from the environment by lib/tts.js and never comes back; a page that stops listening stops it.
      if (url === "/api/tts") {
        if (!helper) return refuse(503, "voice off: the assistant is off");
        if (!b || Object.keys(b).length !== 1 || typeof b.text !== "string") return refuse(400, "text must be 1 to 600 characters");
        // a short line (the filler words) is kept once made, so every page that holds it costs no new voice
        const key = b.text.length <= TTS_KEEP_CHARS ? `${config.assistant.voiceId}|${config.assistant.ttsModel}|${b.text}` : null;
        if (key && ttsKept.has(key)) return send(res, 200, "audio/mpeg", ttsKept.get(key));
        return ttsStream({ text: b.text, voiceId: config.assistant.voiceId, modelId: config.assistant.ttsModel }).then((r) => {
          if (!r.ok) return refuse(r.status, r.error);
          const audio = Readable.fromWeb(r.stream);
          res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
          res.on("close", () => audio.destroy());
          audio.on("error", () => res.destroy());
          if (key) {
            const got = [];
            audio.on("data", (c) => got.push(c));
            audio.on("end", () => { if (ttsKept.size < TTS_KEEP_MAX) ttsKept.set(key, Buffer.concat(got)); });
          }
          audio.pipe(res);
        });
      }
      // the approve window's off button: { off: true }. A window opens only through a confirmed read-back, never here
      // the keep-warm switch of one chat whose hq-feed mod reports in: { sessionId, on }
      if (url === "/api/warm") {
        if (!b || typeof b.sessionId !== "string" || !UUID.test(b.sessionId) || typeof b.on !== "boolean") return refuse(400, "sessionId and on, true or false");
        const p = hq.payload();
        const s = p && p.sessions.find((x) => x.id === b.sessionId);
        if (!s || !s.warm || !s.warm.canWarm) return refuse(400, "that chat has no hq-feed mod");
        feed.setWarm(b.sessionId, b.on);
        return send(res, 200, "application/json", '{"ok":true}');
      }
      // an agent's switch, or every agent's: { id, on } or { all: true, on }; the page shows it from the next refresh
      if (url === "/api/agents") {
        const r = switches.set(b, Date.now());
        if (!r.ok) return refuse(400, r.error);
        refresh(); // not awaited: a refresh already running holds this one off (busy), and the next tick reads the switch
        return send(res, 200, "application/json", '{"ok":true}');
      }
      // the approvals chooser: { preset } by id only; the lists themselves are never written from the page
      if (url === "/api/approvals") {
        const r = approvals.choose(b, Date.now());
        if (!r.ok) return refuse(400, r.error);
        return send(res, 200, "application/json", '{"ok":true}');
      }
      if (url === "/api/window") {
        if (!b || b.off !== true || Object.keys(b).length !== 1) return refuse(400, "off only");
        windowOff();
        return send(res, 200, "application/json", '{"ok":true}');
      }
      // the owner's yes or no to a read-back: { id, confirm }. Yes writes it (lib/readback.js), no drops it
      if (url === "/api/readback") {
        if (!b || typeof b.id !== "string" || typeof b.confirm !== "boolean" || Object.keys(b).length !== 2) return refuse(400, "id and confirm, true or false");
        const p = b.confirm ? readbacks.take(b.id, Date.now()) : null;
        if (b.confirm ? !p : !readbacks.cancel(b.id)) return refuse(400, "not open");
        return Promise.resolve()
          .then(() => (b.confirm ? confirmAndKeep(b.id, p) : true))
          .then((done) => {
            syncDecisions();
            publish();
            return done === true ? send(res, 200, "application/json", '{"ok":true}') : refuse(400, done);
          })
          .catch((e) => { // a throw is a failed answer, never an unhandled rejection; logged by its kind and place, never its text
            console.error(confirmFailLine(e));
            send(res, 500, "text/plain", "failed");
          });
      }
      if (!b || typeof b.id !== "string" || !HEX32.test(b.id) || typeof b.choice !== "string") return refuse(400, "not open");
      syncDecisions(); // the folder as it is now: a request the bridge has just given up on is not open
      const p = hq.payload();
      const item = p && p.decisions.find((d) => d.id === b.id && d.kind !== "reply");
      if (!item) return refuse(400, "not open");
      // a notice (a prompt HQ held to the cap) is asked in VS Code now: HQ shows it and never answers it
      if (item.notice) return refuse(400, "answer in VS Code");
      if (!item.choices.some((c) => c.key === b.choice)) return refuse(400, "not offered");
      // the answer is for the call the owner saw: its hash must be the open item's (the bridge checks it again)
      if (typeof b.hash !== "string" || b.hash !== item.hash) return refuse(400, "not what was shown");
      // a Risky allow (Risky on its own, or marked risky by the bridge, which describe always shows Risky) takes the
      // second click: the page sends confirm: true only from the confirm button that says what will run
      if (b.choice === "allow" && item.risk && item.risk.level === "high" && b.confirm !== true) return refuse(400, "confirm first");
      if (b.choice === "revise" && !plainNote(b.note)) return refuse(400, "note must be one line of 1 to 500 characters");
      if (b.choice === "picks" && !picksFit(item.questions, b.picks)) return refuse(400, "picks do not fit");
      if (!recordAnswer(item, b.choice, { note: b.note, picks: b.picks })) return refuse(400, "not open");
      syncDecisions();
      publish();
      return send(res, 200, "application/json", '{"ok":true}');
    } catch {
      send(res, 500, "text/plain", "failed");
    }
  });
}

// The owner's message for a chat HQ follows, from the pop-up: { sessionId, text }, or { sessionId, cancel: true } to take
// back the one still waiting. One message per chat at a time. It is held for a chat that is working (its waiter starts
// when the reply ends) and handed over at once to a chat a waiter listens for; a chat that is neither cannot hear HQ
// until it ends a reply (a restarted chat, or one that went quiet before HQ listened).
function sendMessage(res, refuse, b) {
  const r = queueMessage(b);
  return r.status === 200 ? send(res, 200, "application/json", '{"ok":true}') : refuse(r.status, r.text);
}
// The pop-up's send or take back, or the assistant's send (via "assistant", which the message carries to its waiter):
// { status, text }, with working when the message is held for a working chat. With dry, only whether it would be taken.
function queueMessage(b, via, dry = false) {
  if (!b || typeof b.sessionId !== "string" || !UUID.test(b.sessionId)) return { status: 400, text: "not a chat" };
  const p = hq.payload();
  const s = p && p.sessions.find((x) => x.id === b.sessionId);
  if (!s) return { status: 400, text: "not a chat VibeQuarters follows" };
  if (!canConfirm()) return { status: 409, text: "messages to a chat work on Windows only" };
  syncInbox();
  let working = false;
  if (b.cancel === true) {
    const m = outbox.get(b.sessionId);
    if (!m) return { status: 400, text: "nothing waiting" };
    if (m.written) inbox.take(b.sessionId);
    takenBack.add(m.id);
    outbox.delete(b.sessionId);
  } else {
    const text = plainText(b.text);
    if (text === null) return { status: 400, text: "text must be 1 to 2000 characters" };
    if (outbox.has(b.sessionId)) return { status: 409, text: "one message at a time" };
    working = workingNow(s);
    if (!working && !inbox.listening().has(b.sessionId)) return { status: 409, text: "this chat cannot hear VibeQuarters until it ends a reply" };
    if (dry) return { status: 200, text: "ok", working };
    outbox.set(b.sessionId, { id: crypto.randomBytes(16).toString("hex"), text, hash: textHash(text), at: Date.now(), written: false, ...(via ? { via } : {}) });
  }
  syncInbox();
  publish();
  return { status: 200, text: "ok", working };
}

// Maps a URL path to a file inside one of the static roots, or null.
function staticPath(urlPath) {
  for (const prefix in ROOTS) {
    if (!urlPath.startsWith(prefix)) continue;
    let rel;
    try {
      rel = decodeURIComponent(urlPath.slice(prefix.length));
    } catch {
      return null;
    }
    // a NUL byte truncates paths in C APIs; a backslash or a colon means something in a path on Windows only. No file here has one
    if (/[\0\\:]/.test(rel)) return null;
    const base = path.join(DIR, ROOTS[prefix]);
    const fp = path.resolve(base, rel);
    return fp.startsWith(base + path.sep) ? fp : null;
  }
  return null;
}

// No other site may frame HQ (clickjacking): every response says so, the event stream's too.
const NO_FRAME = { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" };
function send(res, status, type, body, headers) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...NO_FRAME, ...headers });
  res.end(body);
}

// DNS rebinding guard: a hostile page whose domain resolves to 127.0.0.1 still sends its own Host.
function localHost(host) {
  const name = String(host || "").replace(/:\d+$/, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost";
}

function handler(req, res) {
  try {
    if (!localHost(req.headers.host)) return send(res, 403, "text/plain", "local only", closing(req));
    if (req.method === "POST" && control) return post(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "GET only", { Allow: control ? "GET, HEAD, POST" : "GET, HEAD", ...closing(req) });
    const url = (req.url || "/").split("?")[0];
    if (url === "/api/hq") {
      if (!ready) return send(res, 200, "application/json", JSON.stringify({ building: true, progress, error }));
      // The last good payload stays up while a refresh fails; only then is it parsed again to carry the error.
      return send(res, 200, "application/json", error ? JSON.stringify({ ...JSON.parse(hq.json()), error }) : hq.json());
    }
    // A screenshot a desk screen shows, by the opaque id HQ issued for it (lib/hq.js screenFile, which checks the
    // file again as it reads it). The page never sends a path: a request carrying a query or a body serves nothing.
    if (url === "/api/screen" || url.startsWith("/api/screen/")) {
      const SAME = { "Cross-Origin-Resource-Policy": "same-origin" }; // no other site may embed it
      const body = Number(req.headers["content-length"] || 0) > 0 || req.headers["transfer-encoding"] !== undefined;
      if (body) { // read off (at most 64 KB, else the socket goes) so the 404 reaches the asker instead of a reset
        let n = 0;
        req.on("data", (c) => { if ((n += c.length) > 65536) req.destroy(); });
        req.on("end", () => send(res, 404, "text/plain", "not found", SAME));
        return;
      }
      const shot = (req.url || "").includes("?") ? null : hq.screenFile(url.slice("/api/screen/".length));
      return shot ? send(res, 200, shot.type, shot.body, SAME) : send(res, 404, "text/plain", "not found", SAME);
    }
    // A live session's chat for its pop-up (lib/hq.js chat): its newest messages and steps, by the session's own id.
    if (url.startsWith("/api/chat/")) {
      const SAME = { "Cross-Origin-Resource-Policy": "same-origin" };
      const id = url.slice("/api/chat/".length);
      const chat = ready && UUID.test(id) ? hq.chat(id) : null;
      return chat ? send(res, 200, "application/json", JSON.stringify(chat), SAME) : send(res, 404, "text/plain", "not found", SAME);
    }
    if (url === "/api/queue") return send(res, 200, "application/json", JSON.stringify(queue.read()));
    // the approvals chooser: the four presets, which the system pack holds, and the saved choice (null on first run)
    if (url === "/api/approvals") return send(res, 200, "application/json", JSON.stringify({ ...approvals.view(), canChoose: control }));
    if (url === "/api/stats") {
      const body = stats ? Object.assign({ building: busy, progress }, stats) : { building: true, progress };
      return send(res, 200, "application/json", JSON.stringify(body));
    }
    if (url === "/api/events") {
      // the page's own stream only: a same-origin EventSource sends no Origin, and a browser marks another site's request
      const origin = req.headers.origin, site = String(req.headers["sec-fetch-site"] || "");
      if ((origin !== undefined && origin !== "http://" + req.headers.host) || /^(cross|same)-site$/i.test(site)) return send(res, 403, "text/plain", "wrong origin");
      if (streams.size >= MAX_STREAMS) return send(res, 503, "text/plain", "too many streams");
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...NO_FRAME, Connection: "keep-alive" });
      const ids = ready && hq.payload() ? hq.payload().decisions.map((d) => d.id) : [];
      res.write(`retry: 3000\n\nevent: decisions\ndata: ${JSON.stringify({ count: ids.length, ids })}\n\n`);
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    const fp = url === "/" || url === "/index.html" ? INDEX : staticPath(url);
    if (!fp || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) return send(res, 404, "text/plain", "not found");
    let body = fs.readFileSync(fp); // read before writeHead so a throw can still 500
    if (fp === INDEX) {
      // the product's name (config.js PRODUCT_NAME, or the config's appName) in the title and header, escaped
      const name = String(config.appName).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
      body = body.toString("utf8").replace("<title>HQ</title>", `<title>${name}</title>`).replace('<span class="brand" id="app-name">HQ</span>', `<span class="brand" id="app-name">${name}</span>`);
      if (TOKEN) body = body.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta name="hq-token" content="${TOKEN}">${canConfirm() ? "" : '\n<meta name="hq-answers" content="off">'}`);
    }
    const cache = CACHED.some((p) => url.startsWith(p)) ? { "Cache-Control": "max-age=3600" } : undefined;
    return send(res, 200, TYPES[path.extname(fp)] || "application/octet-stream", body, cache);
  } catch (e) {
    send(res, 500, "text/plain", String(e));
  }
}

function listen(port, attemptsLeft) {
  const server = http.createServer(handler);
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" && attemptsLeft > 0 && port < 65535) listen(port + 1, attemptsLeft - 1); // the walk ends at the last port
    else process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    try {
      fs.writeFileSync(inst.runtimeFile, JSON.stringify({ pid: process.pid, port: server.address().port, startedAt: new Date().toISOString(), control }));
    } catch {}
    console.log(`${config.appName}${DEMO ? " (demo)" : ""} is running at http://127.0.0.1:${server.address().port}/`);
    setInterval(() => { for (const r of streams) r.write(": ping\n\n"); }, 30e3); // keeps idle streams open through proxies and sleep
    if (control) switches.resync(Date.now()); // the file's names and types as the config gives them now
    if (demo) demo.start();
    makeAssistant(server.address().port);
    refresh();
    setInterval(refresh, 4000); // incremental, cheap once warm
  });
}

if (require.main === module) {
  // The port file and the parse cache live in the state folder, so it exists before anything listens or indexes.
  // A folder that cannot be made stops the start like any other settings problem; the message carries the error
  // code, never the folder's path. With no settings file the state folder is this app folder, which exists.
  try {
    fs.mkdirSync(inst.stateDir, { recursive: true });
  } catch (e) {
    console.error(`settings ${SETTINGS ? path.basename(SETTINGS) : ""}: stateDir cannot be created (${e.code})`);
    process.exit(1);
  }
  if (decisions) readLog(); // the answers log's first read: a bridge line in it from before this start is learned, never alerted
  if (inbox) inbox.clear(); // a past run's messages: no waiter could have one confirmed now
  // VIBEQUARTERS_PORT picks the first port to try; the next free one up is taken when it is busy
  listen(Number(process.env.VIBEQUARTERS_PORT) || inst.port, 25);
}
module.exports = { handler, refresh, staticPath };
