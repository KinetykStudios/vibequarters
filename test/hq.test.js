const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHq } = require("../lib/hq");
const { createBoard } = require("../lib/board");
const { T0, at, asst, user, tool, text, jsonl } = require("./helpers");

const A = "aaaaaaaa-0000-0000-0000-000000000001"; // live, titled "alpha"
const OLD = "bbbbbbbb-0000-0000-0000-000000000002"; // yesterday
const C = "cccccccc-0000-0000-0000-000000000003"; // only with world({ gamma: true }): titled "gamma", its turn ended a minute ago
const NOW = T0 + 120e3;

const queued = (sec, content) => ({ type: "queue-operation", operation: "enqueue", timestamp: at(sec), content });
const notif = (taskId, useId, summary) => `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${useId}</tool-use-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`;
// Session A delegates twice to the Scout (the first finishes), messages a peer, hears back, and opens a PR.
const COLLAB = [
  asst({ sec: 20, content: [{ ...tool("Agent", { description: "Check the links", subagent_type: "Explore", prompt: "PROMPT-BODY", run_in_background: true }), id: "tu_d1" }] }),
  { type: "user", timestamp: at(21), toolUseResult: { status: "async_launched" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_d1", content: "launched" }] } },
  asst({ sec: 25, content: [{ ...tool("Agent", { description: "Check the headings", subagent_type: "Explore" }), id: "tu_d2" }] }),
  asst({ sec: 30, content: [tool("SendMessage", { to: "uds:pipe-b", summary: "Ask beta to release App.tsx", message: "PROMPT-BODY" })] }),
  queued(40, '<cross-session-message from="uds:pipe-b" from-name="beta" from-mode="prompting">\nReleased App.tsx\n</cross-session-message>'),
  queued(50, notif("x1", "tu_d1", 'Agent "Check the links" completed')),
  queued(60, notif("x2", "tu_other", "Tests passed")),
  { type: "pr-link", timestamp: at(70), prNumber: 12, prUrl: "https://github.com/o/r/pull/12", prRepository: "o/r" },
];

// Every folder world() makes, removed once this file's tests end, and nothing else.
const roots = [];
test.after(async () => {
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
// `open`: the files of Claude Code's sessions folder, { sessionId: pid }; absent, HQ is given no sessions folder.
// `assistant`: the ids of the assistant's own chats; absent, HQ is given none. `gamma`: a second chat, C, at rest.
// `registry`: a coordination registry naming A (with a task and a claim) and C (no transcript, seen a day ago); absent,
// HQ is given no board. `off`: the ids of the agents switched off; absent, HQ is given no switches.
function world({ extra = [], subExtra = [], chunk, home, edit, tail, open, assistant, drafter, gamma, registry, off } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hq-"));
  roots.push(root);
  const sessionsDir = open ? path.join(root, "sessions") : undefined;
  if (open) {
    fs.mkdirSync(sessionsDir);
    for (const [sessionId, pid] of Object.entries(open)) fs.writeFileSync(path.join(sessionsDir, pid + ".json"), JSON.stringify({ pid, sessionId, kind: "interactive" }));
  }
  const proj = path.join(root, "projects", "p1");
  fs.mkdirSync(path.join(proj, A, "subagents"), { recursive: true });
  const secret = "export TOKEN=sk-live-123";
  fs.writeFileSync(path.join(proj, A + ".jsonl"), jsonl([
    { type: "ai-title", aiTitle: "alpha", sessionId: A },
    user({ sec: 0, text: "go" }),
    ...extra,
    ...(tail || [asst({ sec: 100, content: [tool("Bash", { command: secret, description: "Set up the env" })] })]),
  ]));
  fs.writeFileSync(path.join(proj, A, "subagents", "agent-x1.jsonl"), jsonl([user({ sec: 90, sidechain: true }), ...subExtra, asst({ sec: 110, sidechain: true, content: [tool("Read", { file_path: "a.md" })] })])); // real subagent rows are all sidechain
  fs.writeFileSync(path.join(proj, A, "subagents", "agent-x1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Check the links", toolUseId: "tu_d1" }));
  fs.writeFileSync(path.join(proj, OLD + ".jsonl"), jsonl([user({ sec: -86400 })]));
  if (gamma) fs.writeFileSync(path.join(proj, C + ".jsonl"), jsonl([{ type: "ai-title", aiTitle: "gamma", sessionId: C }, user({ sec: 10, text: "go" }), asst({ sec: 20, stop: "end_turn", content: [text("Done.")] })]));
  const index = {
    mains: [
      { fp: path.join(proj, A + ".jsonl"), sessionId: A, mtimeMs: NOW - 5e3, project: "p1" },
      { fp: path.join(proj, OLD + ".jsonl"), sessionId: OLD, mtimeMs: NOW - 86400e3, project: "p1" },
      ...(gamma ? [{ fp: path.join(proj, C + ".jsonl"), sessionId: C, mtimeMs: NOW - 60e3, project: "p1" }] : []),
    ],
    subMtime: { [A]: NOW - 10e3 },
    subs: [{ fp: path.join(proj, A, "subagents", "agent-x1.jsonl"), sessionId: A, mtimeMs: NOW - 10e3 }],
  };
  const reg = path.join(root, "registry.json");
  if (registry)
    fs.writeFileSync(reg, JSON.stringify({
      sessions: { [A]: { id: A, name: "alpha-board", task: "ship the panel >/dev/null 2>" }, [C]: { id: C, name: "gamma", cwd: "C:/work/notes-app", lastSeen: NOW - 86400e3 } },
      claims: [{ repo: "r", path: "x.js", session: A, at: 1 }], locks: { merge: { session: A, at: NOW - 60e3 } }, notes: [],
    }));
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "hq.config.example.json"), "utf8")); // never a user's edited copy
  if (edit) edit(config, root);
  const hq = createHq({ config, board: registry ? createBoard(reg) : null, agentsOff: off ? () => new Set(off) : undefined, chunk, home, sessionsDir, assistantIds: assistant ? () => new Set(assistant) : undefined, drafterRows: drafter ? () => drafter : undefined });
  return { hq, index, proj, sessionsDir };
}

test("live = transcripts written in the last 15 minutes, each named by its title; yesterday's is not shown", async () => {
  const { hq, index } = world({ gamma: true });
  await hq.update(index, { today: 1.5, toolsToday: 7 }, NOW);
  const p = hq.payload();
  assert.deepEqual(p.sessions.map((s) => s.id).sort(), [A, C].sort());
  const a = p.sessions.find((s) => s.id === A);
  assert.equal(a.name, "alpha");
  assert.equal(a.task, null);
  assert.equal(a.status, "working");
  assert.equal(a.action, "Set up the env");
  const c = p.sessions.find((s) => s.id === C);
  assert.equal(c.name, "gamma");
  assert.equal(c.status, "needs-you");
  assert.equal(p.vitals.toolCallsToday, 7);
  assert.equal(p.pill.working, 1);
});

test("the payload carries today's top tools beside today's total", async () => {
  const { hq, index } = world();
  await hq.update(index, { today: 1.5, toolsToday: 7, byToolToday: [{ name: "Edit", count: 4 }] }, NOW);
  assert.deepEqual(hq.payload().vitals.byToolToday, [{ name: "Edit", count: 4 }]);
  await hq.update(index, null, NOW);
  assert.equal(hq.payload().vitals.byToolToday, null);
});

test("a running subagent turns the matching job agent green", async () => {
  const { hq, index } = world();
  await hq.update(index, null, NOW);
  const scout = hq.payload().floor.agents.find((x) => x.id === "scout");
  assert.equal(scout.working, true);
  assert.equal(scout.doing, "Check the links");
  assert.equal(hq.payload().floor.agents.find((x) => x.id === "guide").working, false);
});

test("the payload never carries shell command text", async () => {
  const { hq, index } = world();
  await hq.update(index, null, NOW);
  assert.ok(!hq.json().includes("sk-live-123"));
});

// a pid no process has: a child's, once it has exited
const DEAD = require("child_process").spawnSync(process.execPath, ["-e", ""]).pid;

test("a chat closed in VS Code leaves HQ: only sessions whose Claude Code process runs show", async () => {
  // A was written 5 s ago and ended its turn waiting on the owner, but its chat is closed; C's is open
  const { hq, index } = world({ gamma: true, open: { [C]: process.pid }, tail: [asst({ sec: 100, stop: "end_turn", content: [text("Done.")] })] });
  await hq.update(index, null, NOW);
  assert.deepEqual(hq.payload().sessions.map((s) => s.id), [C]);
  assert.deepEqual(hq.payload().decisions.map((d) => d.sessionId), [C]); // A's finished turn is no reply item either
});

test("a session file whose process is gone, or that is not a session file, opens nothing", async () => {
  const { hq, index, sessionsDir } = world({ open: { [A]: DEAD } });
  fs.writeFileSync(path.join(sessionsDir, "123.json"), "{ half");
  fs.writeFileSync(path.join(sessionsDir, "456.json"), JSON.stringify({ pid: "456", sessionId: C }));
  fs.writeFileSync(path.join(sessionsDir, process.pid + ".abc.key"), JSON.stringify({ pid: process.pid, sessionId: C }));
  await hq.update(index, null, NOW);
  assert.deepEqual(hq.payload().sessions.map((s) => s.id), []);
});

test("a closed chat that opens again shows again", async () => {
  const { hq, index, sessionsDir } = world({ open: {} });
  await hq.update(index, null, NOW);
  assert.deepEqual(hq.payload().sessions.map((s) => s.id), []);
  fs.writeFileSync(path.join(sessionsDir, process.pid + ".json"), JSON.stringify({ pid: process.pid, sessionId: A }));
  await hq.update(index, null, NOW);
  assert.deepEqual(hq.payload().sessions.map((s) => s.id), [A]);
});

test("with no sessions folder to read, every recent session shows", async () => {
  const { hq, index, sessionsDir } = world({ open: {}, gamma: true });
  fs.rmdirSync(sessionsDir);
  await hq.update(index, null, NOW);
  assert.deepEqual(hq.payload().sessions.map((s) => s.id).sort(), [A, C].sort());
});

test("a half-written line is picked up whole on the next refresh", async () => {
  const { hq, index, proj } = world();
  await hq.update(index, null, NOW);
  const fp = path.join(proj, A + ".jsonl");
  const line = JSON.stringify(asst({ sec: 115, content: [tool("Grep", {})] }));
  fs.appendFileSync(fp, line.slice(0, 20));
  await hq.update(index, null, NOW);
  assert.equal(hq.payload().sessions.find((s) => s.id === A).toolCount, 1);
  fs.appendFileSync(fp, line.slice(20) + "\n");
  await hq.update(index, null, NOW);
  assert.equal(hq.payload().sessions.find((s) => s.id === A).toolCount, 2);
});

test("delegations, handoffs and finished work reach the session, the flow, the team map and the floor", async () => {
  const { hq, index } = world({ extra: COLLAB });
  await hq.update(index, null, NOW);
  const p = hq.payload();
  const a = p.sessions.find((s) => s.id === A);
  assert.deepEqual(a.delegations.map((d) => [d.id, d.agentId, d.status]), [["tu_d2", "scout", "running"], ["tu_d1", "scout", "done"]]);
  assert.equal(a.delegations[1].doneAt, T0 + 50e3);
  assert.deepEqual(a.handoffs.map((h) => [h.dir, h.peer]), [["in", "beta"], ["out", "beta"]]); // the pipe resolved to a name
  assert.deepEqual(a.completions.map((c) => c.text), ["Tests passed"]);
  assert.equal(a.prs[0].number, 12);
  assert.equal(a.spark.length, 30);
  assert.deepEqual(p.flow.map((e) => e.kind), ["pr", "done", "delegate", "handoff", "handoff", "delegate"]);
  const del = p.team.edges.find((e) => e.kind === "delegate");
  assert.deepEqual([del.from, del.to, del.count, del.active], ["s:" + A, "a:scout", 2, true]);
  assert.equal(p.team.edges.find((e) => e.kind === "handoff").count, 2);
  assert.deepEqual(p.floor.links, [{ from: A, to: "scout" }]);
  assert.ok(!hq.json().includes("PROMPT-BODY"));
  index.mains[0].mtimeMs = T0 + 3 * 3600e3 - 5e3; // A writes again 3 h later; its subagent has said nothing since
  await hq.update(index, null, T0 + 3 * 3600e3);
  assert.equal(hq.payload().sessions.find((s) => s.id === A).delegations[0].status, "quiet");
});

test("a chat whose turn ended while its background subagent runs waits on the agent, not on the owner; after the report it needs the owner", async () => {
  const bg = COLLAB.slice(0, 2); // tu_d1, launched in the background, its agent writing until sec 110
  const ended = (sec) => asst({ sec, stop: "end_turn", content: [text("Started the audit; it reports back when done.")] });
  const waiting = world({ extra: bg, tail: [ended(100)] });
  await waiting.hq.update(waiting.index, null, NOW);
  const w = waiting.hq.payload().sessions.find((s) => s.id === A);
  assert.deepEqual([w.status, w.waitsOn], ["working", "subagent"]);
  const reported = world({ extra: bg, tail: [queued(105, notif("x1", "tu_d1", 'Agent "Check the links" completed')), ended(110)] });
  await reported.hq.update(reported.index, null, NOW);
  const r = reported.hq.payload().sessions.find((s) => s.id === A);
  assert.deepEqual([r.status, r.waitsOn], ["needs-you", null]);
});

test("a chat whose turn ended while a background job of its own runs waits on it, not on the owner; a server, a refused launch or a job silent an hour never holds it; a wakeup does", async () => {
  const ended = (sec) => asst({ sec, stop: "end_turn", content: [text("CI is running; I report back once it clears.")] });
  const bash = (sec, id, description) => asst({ sec, content: [{ ...tool("Bash", { command: "gh pr checks 12 --watch", description, run_in_background: true }), id }] });
  const launch = (sec, id, task, error) => ({ type: "user", timestamp: at(sec), toolUseResult: error ? "Error: hook" : { stdout: "", backgroundTaskId: task },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: !!error, content: error ? "PreToolUse:Bash hook error" : "Command running in background with ID: " + task }] } });
  const state = async (rows, now = NOW) => {
    const w = world({ tail: rows });
    w.index.mains[0].mtimeMs = now - 5e3; // live at `now`
    await w.hq.update(w.index, null, now);
    const p = w.hq.payload(), s = p.sessions.find((x) => x.id === A);
    return { status: s.status, waitsOn: s.waitsOn, waitingFor: s.waitingFor, wakeAt: s.wakeAt, reply: p.decisions.some((d) => d.kind === "reply" && d.sessionId === A), needsYou: p.pill.needsYou };
  };
  const ci = [bash(90, "tu_b1", "Wait for PR 12 checks"), launch(91, "tu_b1", "k1")];
  assert.deepEqual(await state([...ci, ended(100)]), { status: "working", waitsOn: "background", waitingFor: ["Wait for PR 12 checks"], wakeAt: null, reply: false, needsYou: 0 });
  assert.deepEqual(await state([...ci, queued(105, notif("k1", "tu_b1", "done")), ended(110)]), { status: "needs-you", waitsOn: null, waitingFor: [], wakeAt: null, reply: true, needsYou: 1 });
  const nobody = { status: "needs-you", waitsOn: null, waitingFor: [], wakeAt: null, reply: true, needsYou: 1 };
  assert.deepEqual(await state([bash(90, "tu_b2", "Start the preview server on port 3000"), launch(91, "tu_b2", "k2"), ended(100)]), nobody, "a server never ends, so nothing is awaited");
  assert.deepEqual(await state([bash(90, "tu_b3", "Type-check the app"), launch(91, "tu_b3", null, true), ended(100)]), nobody, "a refused launch never ran");
  assert.deepEqual(await state([...ci, ended(100)], T0 + 62 * 60e3), nobody, "an hour with no news: the job most likely died with a restart");
  const wake = asst({ sec: 95, content: [tool("ScheduleWakeup", { delaySeconds: 600, reason: "watching CI", prompt: "/loop" })] });
  assert.deepEqual(await state([wake, ended(100)]), { status: "working", waitsOn: "timer", waitingFor: [], wakeAt: T0 + 695e3, reply: false, needsYou: 0 });
  assert.deepEqual(await state([wake, ended(100)], T0 + 700e3), { ...nobody, needsYou: 1 }, "past its wake time it waits on nothing");
});

test("a message to the session's own subagent shows as its agent, never as a raw id", async () => {
  const { hq, index } = world({
    extra: [
      asst({ sec: 30, content: [tool("SendMessage", { to: "x1", summary: "Also check the last page", message: "PROMPT-BODY" })] }),
      asst({ sec: 31, content: [tool("SendMessage", { to: "a0123456789abcdef", summary: "Status?", message: "PROMPT-BODY" })] }), // a subagent whose file is not loaded
    ],
  });
  await hq.update(index, null, NOW);
  const p = hq.payload();
  const a = p.sessions.find((s) => s.id === A);
  assert.deepEqual(a.handoffs.map((h) => [h.dir, h.peer, h.agentId]), [["out", "a subagent", null], ["out", "Scout", "scout"]]);
  const labels = p.team.nodes.map((n) => n.label);
  assert.ok(!labels.includes("x1") && !labels.includes("a0123456789abcdef"), labels.join(", "));
  assert.deepEqual(p.team.nodes.filter((n) => n.kind === "agent").map((n) => [n.id, n.label]), [["t:subagent", "a subagent"], ["a:scout", "Scout"]]);
  assert.deepEqual(p.team.edges.map((e) => [e.from, e.to, e.kind]), [["s:" + A, "t:subagent", "handoff"], ["s:" + A, "a:scout", "handoff"]]);
  assert.deepEqual(p.flow.filter((e) => e.kind === "handoff").map((e) => [e.from, e.to]), [["alpha", "a subagent"], ["alpha", "Scout"]]);
  assert.ok(!hq.json().includes("PROMPT-BODY"));
});

test("a shell finished inside a subagent shows that call's description, never its command or the summary's quote", async () => {
  const note = (taskId, useId, status, summary) => `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${useId}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
  const { hq, index } = world({
    subExtra: [
      asst({ sec: 95, sidechain: true, content: [{ ...tool("Bash", { command: "SECRET-SUB-CMD-1", description: 'Say "hi" to the log', run_in_background: true }), id: "tu_bg1" }] }),
      asst({ sec: 96, sidechain: true, content: [{ ...tool("Bash", { command: "SECRET-SUB-CMD-2", run_in_background: true }), id: "tu_bg2" }] }), // no description
    ],
    extra: [
      queued(60, note("x3", "tu_bg1", "completed", 'Background command "Say "hi" to the log" completed (exit code 0)')),
      queued(61, note("x4", "tu_bg2", "failed", 'Background command "SECRET-SUB-CMD-2" failed with exit code 1')), // Claude Code quotes the command when there is no description
      queued(62, note("x5", "tu_unknown", "completed", "Background command finished")), // no quote, no known call
    ],
  });
  await hq.update(index, null, NOW);
  const a = hq.payload().sessions.find((s) => s.id === A);
  assert.deepEqual(a.completions.map((c) => [c.status, c.text]), [
    ["done", "A background command"],
    ["failed", "A background command"],
    ["done", 'Say "hi" to the log'],
  ]);
  assert.equal(a.completions[0].useId, undefined); // an internal handle, not payload
  assert.ok(!hq.json().includes("SECRET-SUB-CMD"));
});

test("project is the cwd's folder, else the index's name; a branch of HEAD is no branch", async () => {
  const { hq, index } = world({ extra: [{ ...user({ sec: 1 }), cwd: "C:/work/web-feature", gitBranch: "HEAD" }] });
  await hq.update(index, null, NOW);
  const p = hq.payload();
  const a = p.sessions.find((s) => s.id === A);
  assert.equal(a.project, "web-feature");
  assert.equal(a.branch, null);
  const plain = world();
  await plain.hq.update(plain.index, null, NOW);
  assert.equal(plain.hq.payload().sessions.find((s) => s.id === A).project, "p1"); // no cwd anywhere: the index's name
});

test("a transcript folded in chunks gives the same payload as one read, and no read is ever larger than the chunk", async () => {
  const whole = world({ extra: COLLAB });
  const chunked = world({ extra: COLLAB, chunk: 64 }); // every row is longer than this, so every row straddles a chunk
  const orig = fs.readSync;
  let largest = 0;
  fs.readSync = (fd, buf, off, len, pos) => { largest = Math.max(largest, len); return orig(fd, buf, off, len, pos); };
  try {
    await whole.hq.update(whole.index, null, NOW);
    const before = largest;
    largest = 0;
    await chunked.hq.update(chunked.index, null, NOW);
    assert.ok(before > 64 && largest === 64, `one read ${before} bytes, chunked at most ${largest}`);
  } finally {
    fs.readSync = orig;
  }
  assert.deepEqual(chunked.hq.payload(), whole.hq.payload());
  assert.equal(chunked.hq.payload().sessions.find((s) => s.id === A).delegations.length, 2);
});

test("a session quiet for under 2 h keeps its tracker, so coming back reads only the new bytes; past 2 h it starts over", async () => {
  const { hq, index, proj } = world(); // shown by its transcript's age alone
  const fp = path.join(proj, A + ".jsonl");
  await hq.update(index, null, NOW);
  assert.deepEqual(hq.payload().sessions.map((s) => s.id), [A]);
  await hq.update(index, null, NOW + 20 * 60e3); // 20 quiet minutes: off the live list
  assert.deepEqual(hq.payload().sessions.map((s) => s.id), []);
  const line = JSON.stringify(asst({ sec: 1300, content: [tool("Grep", {})] })) + "\n";
  fs.appendFileSync(fp, line);
  index.mains[0].mtimeMs = NOW + 21 * 60e3;
  const orig = fs.readSync;
  let bytes = 0;
  fs.readSync = (...a) => { const n = orig(...a); bytes += n; return n; };
  try {
    await hq.update(index, null, NOW + 21 * 60e3);
    assert.equal(bytes, Buffer.byteLength(line), "only the appended row was read");
    assert.equal(hq.payload().sessions.find((s) => s.id === A).toolCount, 2);
    // the same break, 3 h long: the tracker is gone and the file is read from the start
    await hq.update(index, null, NOW + 4 * 3600e3);
    assert.deepEqual(hq.payload().sessions.map((s) => s.id), []);
    fs.appendFileSync(fp, line);
    index.mains[0].mtimeMs = NOW + 4 * 3600e3 + 60e3;
    bytes = 0;
    await hq.update(index, null, NOW + 4 * 3600e3 + 60e3);
    assert.equal(bytes, fs.statSync(fp).size + fs.statSync(path.join(proj, A, "subagents", "agent-x1.jsonl")).size, "the whole file and its subagent's were read again");
    assert.equal(hq.payload().sessions.find((s) => s.id === A).toolCount, 3);
  } finally {
    fs.readSync = orig;
  }
});

test("the payload names the home folder so the page masks it while streaming; none given, none named", async () => {
  const named = world({ home: path.join("C:", "Users", "homeuser") });
  await named.hq.update(named.index, null, NOW);
  assert.equal(named.hq.payload().homeName, "homeuser");
  const plain = world();
  await plain.hq.update(plain.index, null, NOW);
  assert.equal(plain.hq.payload().homeName, null);
});

// Desks for agents that are not subagents: the Guide (no running subagent of its type in this world) follows named
// live sessions, a heartbeat file in the world's folder, or both. `heartbeat` is the file's object, its raw text, or null
// for a file that is named but missing.
const iso = (t) => new Date(t).toISOString();
const HB = (fields = {}) => ({ agent: "guide", status: "working", task: "Running the suites", startedAt: iso(NOW - 60e3), endedAt: null, summary: ["Ran 8 suites", "2 need a rerun"], ...fields });
const NO_DESK_WORK = { working: false, doing: null, forSession: null, source: null, status: "idle", task: null, summary: [], updatedAt: null };
function desk(opts = {}) {
  let file = null;
  const w = world({
    gamma: opts.gamma,
    off: opts.off,
    edit: (config, root) => {
      const a = config.agents.find((x) => x.id === "guide");
      if (opts.sessions) a.sessions = opts.sessions;
      if (!("heartbeat" in opts)) return;
      a.heartbeat = file = path.join(root, "guide.json");
      if (opts.heartbeat != null) fs.writeFileSync(file, typeof opts.heartbeat === "string" ? opts.heartbeat : JSON.stringify(opts.heartbeat));
    },
  });
  return { ...w, file };
}
const guide = (hq) => hq.payload().floor.agents.find((a) => a.id === "guide");
const pick = (a, keys) => Object.fromEntries(keys.map((k) => [k, a[k]]));
const DESK_KEYS = Object.keys(NO_DESK_WORK);
const withoutGuide = (p) => ({ ...p, floor: { ...p.floor, agents: p.floor.agents.filter((a) => a.id !== "guide") } });
async function baseline() {
  const b = world();
  await b.hq.update(b.index, null, NOW);
  return b.hq.payload();
}

test("a live session named in an agent's sessions puts it to work with that session's action and takes no live seat; its Live row is unchanged", async () => {
  const base = await baseline();
  assert.deepEqual(base.floor.sessions.map((s) => s.id), [A]);
  for (const pats of [["alpha"], ["alph*"]]) {
    const { hq, index } = desk({ sessions: pats });
    await hq.update(index, null, NOW);
    const p = hq.payload();
    assert.deepEqual(pick(guide(hq), DESK_KEYS), { working: true, doing: "Set up the env", forSession: "alpha", source: "session", status: "working", task: "Set up the env", summary: [], updatedAt: T0 + 100e3 }, pats.join());
    assert.deepEqual(p.floor.sessions.map((s) => s.id), [], "alpha sits at the Guide's desk, not in a live seat");
    assert.deepEqual(p.sessions, base.sessions, "its Dashboard Live row is unchanged");
    assert.deepEqual(p.floor.agents.filter((a) => a.id !== "guide"), base.floor.agents.filter((a) => a.id !== "guide"), "agents without the keys carry exactly the usual fields");
  }
});

test("a name that matches no live session does nothing; a matched session that is not working still sits at the desk, the agent idle", async () => {
  const base = await baseline();
  const { hq, index } = desk({ sessions: ["alp", "beta", "alpha-*", "ALPHA"] });
  await hq.update(index, null, NOW);
  assert.deepEqual(pick(guide(hq), DESK_KEYS), NO_DESK_WORK);
  assert.deepEqual(withoutGuide(hq.payload()), withoutGuide(base));
  const idle = desk({ sessions: ["gamma"], gamma: true }); // its turn ended a minute ago
  await idle.hq.update(idle.index, null, NOW);
  assert.deepEqual(pick(guide(idle.hq), DESK_KEYS), NO_DESK_WORK);
  assert.deepEqual(idle.hq.payload().floor.sessions.map((s) => s.id), [A], "gamma takes no live seat either");
});

test("a heartbeat working puts the agent to work on its task; idle and failed leave it idle with its task, summary and time", async () => {
  const work = desk({ heartbeat: HB() });
  await work.hq.update(work.index, null, NOW);
  assert.deepEqual(pick(guide(work.hq), DESK_KEYS), { working: true, doing: "Running the suites", forSession: null, source: "heartbeat", status: "working", task: "Running the suites", summary: ["Ran 8 suites", "2 need a rerun"], updatedAt: NOW - 60e3 });
  for (const status of ["idle", "failed"]) {
    const d = desk({ heartbeat: HB({ status, task: `run ended (${status})`, endedAt: iso(NOW - 30e3) }) });
    await d.hq.update(d.index, null, NOW);
    assert.deepEqual(pick(guide(d.hq), DESK_KEYS), { working: false, doing: null, forSession: null, source: "heartbeat", status, task: `run ended (${status})`, summary: ["Ran 8 suites", "2 need a rerun"], updatedAt: NOW - 30e3 }, status);
  }
});

test("a heartbeat that is missing, not JSON, the wrong shape or over 64 KB is no activity, and the rest of the payload is as it was", async () => {
  const base = await baseline();
  const at64k = (n) => { const s = JSON.stringify(HB({ pad: "" })); return JSON.stringify(HB({ pad: "x".repeat(n - s.length) })); };
  assert.equal(Buffer.byteLength(at64k(65536)), 65536);
  const bad = {
    missing: null, "not JSON": "{ not json", "JSON null": "null", "an array": "[]", "a bad status": HB({ status: "busy" }), "no status": HB({ status: undefined }),
    "a task that is not text": HB({ task: 7 }), "a summary that is one string": HB({ summary: "one line" }), "a summary line that is not text": HB({ summary: ["ok", 7] }),
    "a start that is not a time": HB({ startedAt: 5 }), "over 64 KB": at64k(65537),
  };
  for (const [what, heartbeat] of Object.entries(bad)) {
    const d = desk({ heartbeat });
    await d.hq.update(d.index, null, NOW);
    assert.deepEqual(pick(guide(d.hq), DESK_KEYS), NO_DESK_WORK, what);
    assert.deepEqual(withoutGuide(d.hq.payload()), withoutGuide(base), what);
  }
  const edge = desk({ heartbeat: at64k(65536) }); // exactly 64 KB is still read
  await edge.hq.update(edge.index, null, NOW);
  assert.equal(guide(edge.hq).status, "working");
});

test("a working heartbeat whose file has not changed for over 2 h reads as quiet, not working", async () => {
  const { hq, index, file } = desk({ heartbeat: HB() });
  const touch = (t) => fs.utimesSync(file, new Date(t), new Date(t));
  touch(NOW - 2 * 3600e3 - 60e3);
  await hq.update(index, null, NOW);
  assert.deepEqual(pick(guide(hq), ["working", "doing", "source", "status", "task"]), { working: false, doing: null, source: "heartbeat", status: "quiet", task: "Running the suites" });
  touch(NOW - 2 * 3600e3 + 60e3);
  await hq.update(index, null, NOW);
  assert.deepEqual(pick(guide(hq), ["working", "status"]), { working: true, status: "working" });
  const idle = desk({ heartbeat: HB({ status: "idle", endedAt: iso(NOW - 5 * 3600e3) }) });
  fs.utimesSync(idle.file, new Date(NOW - 5 * 3600e3), new Date(NOW - 5 * 3600e3));
  await idle.hq.update(idle.index, null, NOW);
  assert.equal(guide(idle.hq).status, "idle", "only a working heartbeat goes quiet");
});

test("a heartbeat keeps at most 5 summary lines of at most 300 characters and a task line of at most 200", async () => {
  const long = (n, c) => c.repeat(n);
  const d = desk({ heartbeat: HB({ task: long(250, "t"), summary: Array.from({ length: 7 }, (_, i) => i + long(450, "y")) }) });
  await d.hq.update(d.index, null, NOW);
  const b = guide(d.hq);
  assert.equal(b.task.length, 200);
  assert.ok(b.task.startsWith(long(199, "t")) && b.task.endsWith("\u2026"), "a cut line says it was cut");
  assert.equal(b.summary.length, 5);
  assert.ok(b.summary.every((s, i) => s.length === 300 && s.startsWith(i + "yyy") && s.endsWith("\u2026")));
  const fits = desk({ heartbeat: HB({ task: long(200, "t"), summary: [long(300, "s")] }) });
  await fits.hq.update(fits.index, null, NOW);
  assert.deepEqual(pick(guide(fits.hq), ["task", "summary"]), { task: long(200, "t"), summary: [long(300, "s")] }, "lines at the cap stay whole");
});

test("a working matched session wins over the heartbeat; otherwise the heartbeat speaks", async () => {
  const both = desk({ sessions: ["alpha"], heartbeat: HB() });
  await both.hq.update(both.index, null, NOW);
  assert.deepEqual(pick(guide(both.hq), ["working", "doing", "forSession", "source", "task", "summary"]), { working: true, doing: "Set up the env", forSession: "alpha", source: "session", task: "Set up the env", summary: [] });
  const quiet = desk({ sessions: ["gamma"], heartbeat: HB(), gamma: true }); // gamma is matched but not working
  await quiet.hq.update(quiet.index, null, NOW);
  assert.deepEqual(pick(guide(quiet.hq), ["working", "doing", "forSession", "source", "status"]), { working: true, doing: "Running the suites", forSession: null, source: "heartbeat", status: "working" });
});

test("a heartbeat costs one stat a refresh and is read again only when its time or size changed", async () => {
  const { hq, index, file } = desk({ heartbeat: HB() });
  const orig = { stat: fs.statSync, open: fs.openSync };
  let stats = 0, reads = 0;
  fs.statSync = function (p, ...a) { if (String(p) === file) stats++; return orig.stat.call(this, p, ...a); };
  fs.openSync = function (p, ...a) { if (String(p) === file) reads++; return orig.open.call(this, p, ...a); }; // every read opens the file (readFileSync too)
  try {
    for (let i = 0; i < 3; i++) await hq.update(index, null, NOW);
    assert.deepEqual([stats, reads], [3, 1], "three refreshes, one read");
    fs.writeFileSync(file, JSON.stringify(HB({ task: "Running the suites again" }))); // a new size
    await hq.update(index, null, NOW);
    assert.deepEqual([reads, guide(hq).task], [2, "Running the suites again"]);
    fs.writeFileSync(file, JSON.stringify(HB({ task: "Running the suites AGAIN" }))); // the same size, a new time
    const t = new Date(Date.now() + 60e3);
    fs.utimesSync(file, t, t);
    await hq.update(index, null, NOW);
    assert.deepEqual([reads, guide(hq).task], [3, "Running the suites AGAIN"]);
    fs.unlinkSync(file);
    await hq.update(index, null, NOW);
    assert.deepEqual([stats, reads], [6, 3], "a missing file costs its stat and nothing more");
    assert.deepEqual(pick(guide(hq), DESK_KEYS), NO_DESK_WORK);
  } finally {
    fs.statSync = orig.stat;
    fs.openSync = orig.open;
  }
});

test("an agent with a heartbeat and a running subagent of its type works from the subagent, and the source says so", async () => {
  const { hq, index } = world({
    edit: (config, root) => {
      const file = path.join(root, "scout.json");
      fs.writeFileSync(file, JSON.stringify(HB({ agent: "scout" })));
      config.agents.find((x) => x.id === "scout").heartbeat = file; // the scout's type, Explore, runs in alpha
    },
  });
  await hq.update(index, null, NOW);
  const scout = hq.payload().floor.agents.find((x) => x.id === "scout");
  assert.deepEqual(pick(scout, DESK_KEYS), { working: true, doing: "Check the links", forSession: "alpha", source: "subagent", status: "working", task: "Check the links", summary: [], updatedAt: null });
});

test("a heartbeat read that fails after a good stat is not kept: the next refresh reads it again", async () => {
  const { hq, index, file } = desk({ heartbeat: HB() });
  const orig = { read: fs.readFileSync, open: fs.openSync };
  let fail = 0;
  const flaky = (f) => function (p, ...a) {
    if (String(p) === file && fail > 0) { fail--; throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); } // a scanner holding the file
    return f.call(this, p, ...a);
  };
  fs.readFileSync = flaky(orig.read);
  fs.openSync = flaky(orig.open);
  try {
    fail = 1;
    await hq.update(index, null, NOW);
    assert.deepEqual(pick(guide(hq), DESK_KEYS), NO_DESK_WORK, "nothing read yet: no activity for now");
    await hq.update(index, null, NOW);
    assert.equal(guide(hq).task, "Running the suites", "the next refresh reads it again");
    fs.writeFileSync(file, JSON.stringify(HB({ task: "Running the suites again" })));
    fail = 1;
    await hq.update(index, null, NOW);
    assert.equal(guide(hq).task, "Running the suites", "a failed read keeps what was last read");
    await hq.update(index, null, NOW);
    assert.equal(guide(hq).task, "Running the suites again", "and the next refresh reads the new one");
  } finally {
    fs.readFileSync = orig.read;
    fs.openSync = orig.open;
  }
});

test("a heartbeat that grows past 64 KB after its stat is never read whole: at most 64 KB and one byte", async () => {
  const { hq, index, file } = desk({ heartbeat: HB() });
  const small = fs.statSync(file);
  fs.writeFileSync(file, JSON.stringify(HB({ pad: "x".repeat(1024 * 1024) }))); // 1 MB now, the stat still says small
  const orig = { stat: fs.statSync, read: fs.readFileSync, open: fs.openSync, readSync: fs.readSync, close: fs.closeSync };
  const fds = new Set(); // the heartbeat's open handles (a closed handle's number is reused by the transcript reads)
  let whole = 0, bytes = 0;
  fs.statSync = function (p, ...a) { return String(p) === file ? small : orig.stat.call(this, p, ...a); };
  fs.readFileSync = function (p, ...a) { if (String(p) === file) whole++; return orig.read.call(this, p, ...a); };
  fs.openSync = function (p, ...a) { const fd = orig.open.call(this, p, ...a); if (String(p) === file) fds.add(fd); return fd; };
  fs.readSync = function (fd, ...a) { const n = orig.readSync.call(this, fd, ...a); if (fds.has(fd)) bytes += n; return n; };
  fs.closeSync = function (fd, ...a) { fds.delete(fd); return orig.close.call(this, fd, ...a); };
  try {
    await hq.update(index, null, NOW);
  } finally {
    Object.assign(fs, { statSync: orig.stat, readFileSync: orig.read, openSync: orig.open, readSync: orig.readSync, closeSync: orig.close });
  }
  assert.equal(whole, 0, "never read whole");
  assert.ok(bytes > 0 && bytes <= 64 * 1024 + 1, `read ${bytes} bytes`);
  assert.deepEqual(pick(guide(hq), DESK_KEYS), NO_DESK_WORK, "too big is no activity");
});

// The decision loop: the open requests (lib/decisions.js scan) become Needs you items in the payload.
const RID = (n) => String(n).padStart(32, "0");
const RQ = (n, extra = {}) => ({ v: 1, id: RID(n), pid: 1, askedAt: NOW - 10e3 * n, event: "PermissionRequest", sessionId: A, transcriptPath: "t", agentId: null, agentType: null, toolName: "Bash", toolInput: { command: "rm -rf build", description: "Clean the build" }, trimmed: false, toolUseId: null, cwd: "C:/Users/me/work/quarry", ...extra });
const COLOR_Q = { questions: [{ question: "Which color do you pick?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] };
const itemRow = (d) => [d.id, d.kind, d.who + " " + d.what, d.figure, d.askedAt];

test("open requests become Needs you items: permissions, then questions, oldest first, each with its line, chip and folder", async () => {
  const { hq, index } = world();
  await hq.update(index, null, NOW);
  assert.deepEqual(hq.payload().decisions, []);
  const list = [RQ(2), RQ(1, { event: "PreToolUse", toolName: "AskUserQuestion", toolInput: COLOR_Q, toolUseId: "toolu_q", askedAt: NOW - 90e3 }), RQ(3)];
  assert.equal(hq.setRequests(list), true);
  const p = hq.payload();
  assert.deepEqual(p.decisions.map(itemRow), [
    [RID(3), "permission", "alpha wants to clean the build", "s:" + A, NOW - 30e3],
    [RID(2), "permission", "alpha wants to clean the build", "s:" + A, NOW - 20e3],
    [RID(1), "question", "alpha asks: Which color do you pick?", "s:" + A, NOW - 90e3],
  ]);
  assert.deepEqual([p.decisions[0].risk.label, p.decisions[0].risk.reason, p.decisions[0].folder, p.decisions[0].sessionName], ["Risky", "deletes files", "work/quarry", "alpha"]);
  assert.deepEqual([p.pill.needsYou, p.floor.needYou], [3, 3]);
  assert.equal(p.floor.sessions.find((s) => s.id === A).waiting, true);
  assert.ok(p.floor.agents.every((a) => a.waiting === false));
  assert.equal(JSON.parse(hq.json()).decisions.length, 3, "json() carries the same items");
  assert.equal(hq.setRequests([...list]), false, "the same set changes nothing");
});

test("a request's command reaches the payload only in its item's detail, and leaves with it", async () => {
  const { hq, index } = world();
  await hq.update(index, null, NOW);
  hq.setRequests([RQ(1, { toolInput: { command: "canary-cmd-9 --now", description: "Run the canary" } })]);
  assert.equal(hq.json().split("canary-cmd-9").length - 1, 1);
  assert.deepEqual(hq.payload().decisions[0].detail, ["canary-cmd-9 --now"]);
  assert.equal(hq.setRequests([]), true);
  assert.ok(!hq.json().includes("canary-cmd-9"));
  await hq.update(index, null, NOW);
  assert.ok(!hq.json().includes("canary-cmd-9"), "an update keeps the empty set");
});

test("a subagent's request raises its floor agent's hand and names that agent; a seated session raises its desk's", async () => {
  const { hq, index } = world();
  await hq.update(index, null, NOW);
  hq.setRequests([RQ(1, { agentId: "a0123456789abcdef", agentType: "Explore", toolInput: { command: "npm test", description: "Run the tests" } })]);
  const p = hq.payload();
  const d = p.decisions[0];
  assert.deepEqual([d.figure, d.who + " " + d.what, d.sessionName, d.agentId, d.risk.label], ["a:scout", "Scout wants to run the tests", "alpha", "a0123456789abcdef", "Check first"]);
  assert.equal(p.floor.agents.find((a) => a.id === "scout").waiting, true);
  assert.equal(p.floor.sessions.find((s) => s.id === A).waiting, false, "the session's own figure keeps working");
  hq.setRequests([RQ(2, { agentId: "a0123456789abcdef", agentType: "mystery" })]);
  assert.deepEqual([hq.payload().decisions[0].figure, hq.payload().decisions[0].who], ["s:" + A, "alpha"], "a type no agent takes falls back to the session");
  const seated = desk({ sessions: ["alpha"] });
  await seated.hq.update(seated.index, null, NOW);
  seated.hq.setRequests([RQ(1)]);
  assert.equal(seated.hq.payload().decisions[0].figure, "a:guide");
  assert.equal(seated.hq.payload().floor.agents.find((a) => a.id === "guide").waiting, true);
});

test("a finished turn with no request open is a reply item; a request from that chat replaces it", async () => {
  const { hq, index, proj } = world();
  fs.appendFileSync(path.join(proj, A + ".jsonl"), jsonl([asst({ sec: 115, content: [text("Done. Want me to ship it?")], stop: "end_turn" })]));
  await hq.update(index, null, NOW);
  const p = hq.payload();
  assert.deepEqual(p.decisions.map((d) => [d.id, d.kind, d.who + " " + d.what, d.link, d.choices.length]), [["reply:" + A, "reply", "alpha is waiting for your reply", "vscode://anthropic.claude-code/open?session=" + A, 0]]);
  assert.deepEqual([p.pill.needsYou, p.decisions[0].detail, p.decisions[0].askedAt], [1, ["Set up the env"], T0 + 115e3]);
  hq.setRequests([RQ(1, { event: "PreToolUse", toolName: "AskUserQuestion", toolInput: COLOR_Q, toolUseId: "toolu_q" })]);
  assert.deepEqual(hq.payload().decisions.map((d) => d.kind), ["question"]);
});

test("the assistant's own chat is flagged assistant and its finished turn is no reply item, so it never counts as needing the owner", async () => {
  const { hq, index, proj } = world({ assistant: [A] });
  fs.appendFileSync(path.join(proj, A + ".jsonl"), jsonl([asst({ sec: 115, content: [text("Done. Want me to ship it?")], stop: "end_turn" })]));
  await hq.update(index, null, NOW);
  const p = hq.payload();
  assert.equal(p.sessions.find((s) => s.id === A).assistant, true);
  assert.deepEqual([p.decisions, p.pill.needsYou, p.floor.needYou], [[], 0, 0]);
  const plain = world();
  await plain.hq.update(plain.index, null, NOW);
  assert.equal(plain.hq.payload().sessions.find((s) => s.id === A).assistant, false, "any other chat is not");
});

test("the assistant's usage this week: its own chats' spend by model and the drafter's rows, beside the week's total; none while it is off", async () => {
  const { hq, index, proj } = world({ assistant: [A], drafter: [{ at: new Date(NOW - 60e3).toISOString(), costUsd: 0.5, model: "opus" }, { at: new Date(NOW - 8 * 86400e3).toISOString(), costUsd: 9, model: "opus" }] });
  fs.appendFileSync(path.join(proj, A + ".jsonl"), jsonl([asst({ sec: 115, model: "claude-sonnet-5-5", usage: { input_tokens: 1000, output_tokens: 1000 }, content: [text("Done.")], stop: "end_turn" })]));
  hq.setAssistant({ state: { status: "idle" }, messages: [] });
  await hq.update(index, { last30: [{ date: new Date(NOW).toISOString().slice(0, 10), cost: 10, tools: 0 }] }, NOW);
  const u = hq.payload().assistant.usage;
  assert.equal(Math.round(u.byModel.sonnet * 1e6), 12000, "its own Sonnet turn: 1000 in at $2, 1000 out at $10 a million");
  assert.equal(u.byModel.opus, 0.5, "the drafter, this week only");
  assert.equal(Math.round(u.assistantUsd * 1e6), 512000);
  assert.equal(u.totalUsd, 10.5, "the week's total plus the drafter, which has no transcript");
  hq.setAssistant(null);
  assert.equal(hq.payload().assistant, null, "off: no panel and no usage");
});

// A main-chat question at sec 115 (its transcript's last row, so the chat reads needs-you), asked through HQ: the request
// is open, then leaves at NOW + 1 s. Until a row lands after it leaves, the chat's transcript still reads that question.
async function askedThenLeft() {
  const { hq, index, proj } = world();
  const q = tool("AskUserQuestion", COLOR_Q);
  const fp = path.join(proj, A + ".jsonl");
  fs.appendFileSync(fp, jsonl([asst({ sec: 115, content: [q] })]));
  await hq.update(index, null, NOW);
  hq.setRequests([RQ(1, { event: "PreToolUse", toolName: "AskUserQuestion", toolInput: COLOR_Q, toolUseId: q.id })], NOW);
  assert.deepEqual(hq.payload().decisions.map((d) => d.kind), ["question"]);
  hq.setRequests([], NOW + 1e3);
  return { hq, index, fp, q };
}
const itemIds = (hq) => hq.payload().decisions.map((d) => d.id);

test("a question that leaves (answered from HQ) gives its chat no reply item while the transcript still reads it; a new turn's end does", async () => {
  const { hq, index, fp, q } = await askedThenLeft();
  assert.deepEqual(itemIds(hq), [], "no reply item the moment it leaves");
  await hq.update(index, null, NOW + 3e3);
  assert.deepEqual(itemIds(hq), [], "nor at a refresh that reads no new row");
  const answer = { type: "user", timestamp: at(122), message: { role: "user", content: [{ type: "tool_result", tool_use_id: q.id, content: "Red" }] } };
  fs.appendFileSync(fp, jsonl([answer, asst({ sec: 125, content: [text("Red it is. Anything else?")], stop: "end_turn" })]));
  await hq.update(index, null, NOW + 6e3);
  assert.deepEqual(itemIds(hq), ["reply:" + A], "a turn that ends after it left is a reply item at once");
});

test("a question that leaves unanswered (the owner left HQ) shows again as a reply item 15 s after it left, while it still waits in VS Code", async () => {
  const { hq, index } = await askedThenLeft();
  await hq.update(index, null, NOW + 1e3 + 14e3);
  assert.deepEqual(itemIds(hq), [], "held for 15 s");
  await hq.update(index, null, NOW + 1e3 + 15e3);
  assert.deepEqual(itemIds(hq), ["reply:" + A], "then the chat that still waits is a reply item");
});

test("monitor lines: a session's and a subagent's newest action labels, newest first, at most 6", async () => {
  const { hq, index } = world({ extra: Array.from({ length: 7 }, (_, k) => asst({ sec: 10 + k, content: [tool("Bash", { command: "x", description: "Step " + k })] })) });
  await hq.update(index, null, NOW);
  const f = hq.payload().floor;
  const alpha = f.sessions.find((s) => s.id === A);
  assert.deepEqual([alpha.task, alpha.lines], [null, ["Set up the env", "Step 6", "Step 5", "Step 4", "Step 3", "Step 2"]]);
  assert.deepEqual(f.agents.find((a) => a.id === "scout").lines, ["Reading a.md"]);
  assert.deepEqual(f.agents.find((a) => a.id === "guide").lines, []);
  const seated = desk({ sessions: ["alpha"] });
  await seated.hq.update(seated.index, null, NOW);
  assert.deepEqual(seated.hq.payload().floor.agents.find((a) => a.id === "guide").lines, ["Set up the env"]);
});

test("the payload's alerts are [] until setAlerts gives a list, which an update keeps; setAlerts says whether it changed", async () => {
  const { hq, index } = world();
  await hq.update(index, null, NOW);
  assert.deepEqual(hq.payload().alerts, []);
  const list = [{ at: NOW, id: RID(2), sessionName: "alpha", toolName: "Bash" }, { at: NOW - 5e3, id: RID(1), sessionName: null, toolName: null }];
  assert.equal(hq.setAlerts(list), true);
  assert.deepEqual(hq.payload().alerts, list);
  assert.deepEqual(JSON.parse(hq.json()).alerts, list, "json() carries the same list");
  assert.equal(hq.setAlerts([...list]), false, "the same list changes nothing");
  await hq.update(index, null, NOW);
  assert.deepEqual(hq.payload().alerts, list, "an update keeps it");
});

test("the payload's settled history is [] until setSettled gives a list, which an update keeps; setSettled says whether it changed", async () => {
  const { hq, index } = world();
  await hq.update(index, null, NOW);
  assert.deepEqual(hq.payload().settled, []);
  const list = [
    { id: "0123456789abcdef", at: NOW, kind: "readback", what: "Send alpha this prompt", outcome: "sent", via: "you" },
    { id: RID(1), at: NOW - 5e3, kind: "decision", what: "alpha wants to clean the build", outcome: "approved", via: "approve window" },
  ];
  assert.equal(hq.setSettled(list), true);
  assert.deepEqual(hq.payload().settled, list);
  assert.deepEqual(JSON.parse(hq.json()).settled, list, "json() carries the same list");
  assert.equal(hq.setSettled([...list]), false, "the same list changes nothing");
  await hq.update(index, null, NOW);
  assert.deepEqual(hq.payload().settled, list, "an update keeps it");
});

test("a notice is a permission item marked notice with its plain words, its risk as computed, no choices, how long HQ held it and a link to its chat; it counts and raises its figure's hand", async () => {
  const { hq, index } = world();
  await hq.update(index, null, NOW);
  hq.setRequests([RQ(1, { notice: true, movedAt: NOW - 10e3 + 600e3, toolInput: { command: "git push origin main", description: "Push the branch" } })]);
  const p = hq.payload();
  const d = p.decisions[0];
  assert.deepEqual([d.id, d.kind, d.notice, d.who + " " + d.what, d.risk.label, d.risk.reason, d.detail], [RID(1), "permission", true, "alpha wants to push the branch", "Risky", "publishes or pushes code", ["git push origin main"]]);
  assert.deepEqual([d.choices, d.moved, d.link], [[], "Moved to VS Code after 10 min", "vscode://anthropic.claude-code/open?session=" + A]);
  assert.deepEqual([p.pill.needsYou, p.floor.needYou], [1, 1]);
  assert.equal(p.floor.sessions.find((s) => s.id === A).waiting, true, "its figure raises its hand");
  hq.setRequests([RQ(2)]);
  const plain = hq.payload().decisions[0];
  assert.deepEqual(["notice" in plain, plain.choices.length, plain.link], [false, 3, null], "a request is no notice and keeps its three choices");
});

// A notice's chat after its ask: session A's calling message msg_call (a Bash call at sec 101, asked at sec 101.5) in
// its main transcript, or subagent x1's msg_subcall (sec 111, asked at sec 111.5) in its own file, then `main` and `sub`
// rows land and HQ reads them. Returns movedOn for the main chat and for x1, each at its own ask.
const ASKED = T0 + 101.5e3;
const SUB_ASKED = T0 + 111.5e3;
async function movedAfter({ main = [], sub = [] } = {}) {
  const { hq, index, proj } = world();
  const mainFp = path.join(proj, A + ".jsonl");
  const subFp = path.join(proj, A, "subagents", "agent-x1.jsonl");
  fs.appendFileSync(mainFp, jsonl([asst({ sec: 101, id: "msg_call", content: [tool("Bash", { command: "git push", description: "Push" })] })]));
  fs.appendFileSync(subFp, jsonl([asst({ sec: 111, id: "msg_subcall", sidechain: true, content: [tool("Bash", { command: "git push", description: "Push" })] })]));
  await hq.update(index, null, NOW);
  if (main.length) fs.appendFileSync(mainFp, jsonl(main));
  if (sub.length) fs.appendFileSync(subFp, jsonl(sub));
  index.subs[0].mtimeMs += 1;
  await hq.update(index, null, NOW);
  return { main: hq.movedOn(A, null, ASKED), sub: hq.movedOn(A, "x1", SUB_ASKED), hq };
}
const results = (sec, ids, sidechain = false) => ({ type: "user", timestamp: at(sec), isSidechain: sidechain, message: { role: "user", content: ids.map((u) => ({ type: "tool_result", tool_use_id: u, content: "ok" })) } });

test("movedOn is false until the chat has moved past the prompt: never on a sibling call's result, the calling message's own rows or a row within 2 s of the ask", async () => {
  assert.deepEqual((await movedAfter()).main, false, "nothing after the ask");
  assert.equal((await movedAfter({ main: [results(106.5, ["tu_sibling"])] })).main, false, "a sibling call's result 5 s after");
  assert.equal((await movedAfter({ main: [asst({ sec: 106.5, id: "msg_call", content: [tool("Read", { file_path: "b.md" })] })] })).main, false, "a row of the calling message 5 s after");
  assert.equal((await movedAfter({ main: [asst({ sec: 102.5, content: [text("Next.")], stop: "end_turn" })] })).main, false, "a new message only 1 s after");
  assert.equal((await movedAfter({ main: [user({ sec: 102.5, text: "wait" })] })).main, false, "a typed prompt only 1 s after");
  assert.equal((await movedAfter({ main: [{ ...user({ sec: 106.5, text: "Base directory for this skill: x" }), isMeta: true }] })).main, false, "a meta row (an injected skill body) 5 s after");
});

test("movedOn is true on a new message or a typed prompt over 2 s after the ask, and reads the subagent's own file for its notice; null for one HQ does not follow", async () => {
  assert.equal((await movedAfter({ main: [results(106, ["tu_call"]), asst({ sec: 106.5, content: [text("Pushed.")], stop: "end_turn" })] })).main, true, "a new message 5 s after");
  assert.equal((await movedAfter({ main: [user({ sec: 106.5, text: "stop" })] })).main, true, "a typed prompt 5 s after");
  const interrupt = { type: "user", timestamp: at(106.5), message: { role: "user", content: [text("[Request interrupted by user]")] } };
  assert.equal((await movedAfter({ main: [interrupt] })).main, true, "the interrupt notice 5 s after");
  // a subagent's notice: its own file moves, the main one does not; then only the main one moves
  const own = await movedAfter({ sub: [asst({ sec: 116.5, sidechain: true, content: [text("Done.")], stop: "end_turn" })] });
  assert.deepEqual([own.sub, own.main], [true, false], "the subagent's own new message ends its notice");
  const other = await movedAfter({ main: [asst({ sec: 116.5, content: [text("Meanwhile.")], stop: "end_turn" })] });
  assert.equal(other.sub, false, "the main chat moving never ends a subagent's notice");
  assert.equal(other.hq.movedOn(A, "a0123456789abcdef", SUB_ASKED), null, "a subagent HQ has no file for");
  assert.equal(other.hq.movedOn(OLD, null, ASKED), null, "a session HQ does not follow");
});

test("a question's notice ends on its own call's result, even within 2 s and before any new message; another call's result never does", async () => {
  const q = await movedAfter({ main: [results(102, ["tu_q"])] });
  assert.equal(q.hq.movedOn(A, null, ASKED, "tu_q"), true, "its own result 0.5 s after the ask");
  assert.equal(q.hq.movedOn(A, null, ASKED, "tu_other"), false, "another call's result");
  assert.equal(q.main, false, "with no call id, a result alone says nothing, as before");
  // a subagent's question: its own file holds its result, the main chat's never does
  const s = await movedAfter({ sub: [results(112, ["tu_sq"], true)] });
  assert.deepEqual([s.hq.movedOn(A, "x1", SUB_ASKED, "tu_sq"), s.hq.movedOn(A, null, ASKED, "tu_sq")], [true, false]);
});

test("a request rewritten in place (the same id, now a notice under a new hash) changes the payload at once", async () => {
  const { hq, index } = world();
  await hq.update(index, null, NOW);
  const r = RQ(1, { toolInput: { command: "npm test", description: "Run the tests" } });
  hq.setRequests([{ ...r, hash: "a".repeat(64) }]);
  assert.equal(hq.payload().decisions[0].notice, undefined);
  assert.equal(hq.setRequests([{ ...r, hash: "b".repeat(64), notice: true }]), true, "the payload changed");
  assert.deepEqual([hq.payload().decisions[0].id, hq.payload().decisions[0].notice], [RID(1), true]);
  assert.equal(hq.setRequests([{ ...r, hash: "b".repeat(64), notice: true }]), false, "the same list changes nothing");
});

test("an item that cannot be described is dropped, never the payload", async () => {
  const { hq, index } = world({ edit: (config) => { config.agents.find((a) => a.id === "scout").agentTypes = ["Explore", "research-*"]; } }); // a wildcard calls startsWith
  await hq.update(index, null, NOW);
  // a type the agent matcher cannot read (lib/hq.js `matches` calls startsWith) and a question with no questions:
  // requestOf refuses both files, and this proves the payload survives them anyway
  const list = [RQ(1, { agentId: "a0123456789abcdef", agentType: 7 }), RQ(2, { event: "PreToolUse", toolName: "AskUserQuestion", toolInput: {} }), RQ(3)];
  assert.doesNotThrow(() => hq.setRequests(list));
  assert.deepEqual(hq.payload().decisions.map((d) => d.id), [RID(3)]);
  assert.equal(hq.payload().pill.needsYou, 1);
});

// Running subagents of session A beside the world's x1: each starts at `start` s (its first row) and runs a tool at 110
// s.
const SUB = (n) => "a" + String(n).padStart(16, "0"); // a subagent's id, as a request names it
function addSubs(proj, index, subs) {
  const dir = path.join(proj, A, "subagents");
  for (const { n, type = "general-purpose", description, start } of subs) {
    const fp = path.join(dir, `agent-${SUB(n)}.jsonl`);
    fs.writeFileSync(fp, jsonl([user({ sec: start, sidechain: true }), asst({ sec: 110, sidechain: true, content: [tool("Read", { file_path: `part${n}.md` })] })]));
    fs.writeFileSync(path.join(dir, `agent-${SUB(n)}.meta.json`), JSON.stringify({ agentType: type, description: description || `Job ${n}` }));
    index.subs.push({ fp, sessionId: A, mtimeMs: NOW - 10e3 });
  }
}

test("two running general-purpose subagents give one Builder job and one helper, with its own open items", async () => {
  const { hq, index, proj } = world();
  addSubs(proj, index, [{ n: 2, description: "Fix the login form", start: 30 }, { n: 1, description: "Wire the floor", start: 10 }]);
  await hq.update(index, null, NOW);
  const f = hq.payload().floor;
  const eng = f.agents.find((a) => a.id === "builder");
  assert.deepEqual([eng.working, eng.doing, eng.forSession], [true, "Wire the floor", "alpha"], "the Builder keeps the oldest job");
  assert.equal(f.agents.find((a) => a.id === "scout").doing, "Check the links", "x1 is the Scout's, so no helper");
  assert.deepEqual(f.helpers.map(({ screen, ...h }) => h), [{ id: "agent-" + SUB(2), name: "Fix the login form", type: "general-purpose", forSession: "alpha", sessionId: A, working: true, lines: ["Reading part2.md"], waiting: [] }]); // its screen: hq-screen.test.js
  hq.setRequests([RQ(1, { agentId: SUB(2), agentType: "general-purpose" }), RQ(2, { agentId: SUB(1), agentType: "general-purpose" }), RQ(3)]);
  assert.deepEqual(hq.payload().floor.helpers.map((h) => h.waiting), [[RID(1)]], "the helper's waiting is its own subagent's open items only");
});

test("the 9th running extra subagent is not in helpers: at most 8, oldest first", async () => {
  const { hq, index, proj } = world();
  addSubs(proj, index, Array.from({ length: 10 }, (_, i) => ({ n: 10 - i, start: 10 - i }))); // written newest first
  await hq.update(index, null, NOW);
  const f = hq.payload().floor;
  assert.equal(f.agents.find((a) => a.id === "builder").doing, "Job 1");
  assert.deepEqual(f.helpers.map((h) => h.id), [2, 3, 4, 5, 6, 7, 8, 9].map((n) => "agent-" + SUB(n)));
  assert.equal(hq.payload().vitals.subagentsRunning, 11, "every running subagent still counts");
});

test("a helper's name is cleaned and at most 60 characters", async () => {
  const { hq, index, proj } = world();
  const long = "Rewrite   the\n upgrade guide so every new reader finds the first step near the top of the page >/dev/null 2>&1";
  addSubs(proj, index, [{ n: 1, start: 10 }, { n: 2, description: long, start: 20 }]);
  await hq.update(index, null, NOW);
  const name = hq.payload().floor.helpers[0].name;
  assert.equal([...name].length, 60);
  assert.equal(name, "Rewrite the upgrade guide so every new reader finds the fir" + String.fromCharCode(8230));
});

test("a session's title is the name the owner gave it in VS Code, else the one Claude Code made", async () => {
  const { hq, index } = world({ extra: [{ type: "custom-title", customTitle: "docs-analyst", sessionId: A }] });
  await hq.update(index, null, NOW);
  assert.equal(hq.payload().sessions.find((s) => s.id === A).title, "docs-analyst");
  const plain = world();
  await plain.hq.update(plain.index, null, NOW);
  assert.equal(plain.hq.payload().sessions.find((s) => s.id === A).title, "alpha");
});

test("chat gives a shown session's messages, steps and agents, never a command; null for one HQ does not show or has no transcript", async () => {
  const { hq, index } = world();
  await hq.update(index, null, NOW);
  const c = hq.chat(A, NOW);
  assert.deepEqual(c.entries.map((e) => [e.k, e.text || e.label]), [["you", "go"], ["step", "Set up the env"]]);
  assert.deepEqual(c.agents, [{ id: "agent-x1", action: "Reading a.md" }]);
  assert.ok(!JSON.stringify(c).includes("sk-live-123"));
  assert.equal(hq.chat(OLD, NOW), null, "not shown");
  assert.equal(hq.chat(C, NOW), null, "no transcript");
  assert.equal(hq.chat("nope", NOW), null);
});

// ---------- the coordination board (lib/board.js), when the system pack's registry is there
test("with a registry: a registered chat takes its board name, task, claims and locks; a registered chat with no transcript shows idle with its age", async () => {
  const { hq, index } = world({ registry: true });
  await hq.update(index, null, NOW);
  const p = hq.payload();
  assert.deepEqual(p.sessions.map((s) => s.id).sort(), [A, C].sort());
  const a = p.sessions.find((s) => s.id === A);
  assert.deepEqual([a.name, a.task, a.claims, a.locks, a.registered], ["alpha-board", "ship the panel", ["x.js"], ["merge"], true]);
  const c = p.sessions.find((s) => s.id === C);
  assert.deepEqual([c.name, c.status, c.lastAt, c.project], ["gamma", "idle", NOW - 86400e3, "notes-app"]);
  assert.deepEqual([p.vitals.filesClaimed, p.vitals.conflicts, p.pill.conflicts], [1, 0, 0]);
  assert.deepEqual(p.board.locks.map((l) => [l.name, l.sessionName]), [["merge", "alpha-board"]]);
});

test("no registry still lists sessions; the board is null and the board's counts are unknown", async () => {
  const { hq, index } = world();
  await hq.update(index, null, NOW);
  const p = hq.payload();
  assert.equal(p.board, null);
  assert.deepEqual(p.sessions.map((s) => s.id), [A]);
  assert.deepEqual([p.vitals.filesClaimed, p.vitals.conflicts, p.pill.conflicts], [null, null, 0]);
  assert.deepEqual([p.sessions[0].claims, p.sessions[0].locks, p.sessions[0].registered], [[], [], false]);
});

// ---------- agent switches (lib/switches.js)
test("an agent switched off sits idle and dark: its running subagent becomes a helper", async () => {
  assert.deepEqual((await baseline()).floor.helpers, [], "on, the scout's figure shows the subagent");
  const { hq, index } = world({ off: ["scout"] });
  await hq.update(index, null, NOW);
  const p = hq.payload();
  const scout = p.floor.agents.find((x) => x.id === "scout");
  assert.equal(scout.working, false);
  assert.equal(scout.doing, null);
  assert.equal(scout.off, true);
  assert.deepEqual(scout.agentTypes, ["Explore"]);
  assert.equal(p.floor.helpers.length, 1);
  assert.equal(p.floor.helpers[0].type, "Explore");
  assert.equal(guide(hq).off, false);
});

test("an off agent's desk keeps a live chat seated at it by name", async () => {
  const { hq, index } = desk({ sessions: ["alpha"], off: ["guide"] });
  await hq.update(index, null, NOW);
  const b = guide(hq);
  assert.equal(b.working, true);
  assert.equal(b.source, "session");
  assert.equal(b.off, true);
});

test("an off agent's heartbeat is not read: its desk is idle with no task", async () => {
  const { hq, index } = desk({ heartbeat: HB(), off: ["guide"] });
  await hq.update(index, null, NOW);
  assert.deepEqual(pick(guide(hq), DESK_KEYS), { working: false, doing: null, forSession: null, source: null, status: "idle", task: null, summary: [], updatedAt: null });
  assert.equal(guide(hq).off, true);
});

test("the plan reading, the accounts strip and whether the switch hook is registered ride in the payload", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hq-plan-"));
  roots.push(root);
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "hq.config.example.json"), "utf8"));
  const plan = { pct: 62, fiveHour: 18, resetsAt: NOW + 86400e3, at: NOW, accountKey: "k1aaaaaaaa" };
  const accounts = { rows: [{ label: "Work", resetsAt: NOW + 86400e3, lastSeenPct: 62, seenAt: null, current: true, next: false }] };
  const hq = createHq({ config, plan: () => plan, accounts: () => accounts, switchesEnforced: () => true });
  await hq.update({ mains: [], subMtime: {}, subs: [] }, null, NOW);
  const p = hq.payload();
  assert.deepEqual([p.vitals.plan, p.vitals.accounts, p.floor.switchesEnforced], [plan, accounts, true]);
  const bare = createHq({ config });
  await bare.update({ mains: [], subMtime: {}, subs: [] }, null, NOW);
  assert.deepEqual([bare.payload().vitals.plan, bare.payload().vitals.accounts, bare.payload().floor.switchesEnforced], [null, null, false]);
});
