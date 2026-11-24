const test = require("node:test");
const assert = require("node:assert/strict");
const { newCollab, foldCollab, collabView } = require("../lib/collab");
const { T0, at, asst, tool } = require("./helpers");

const fold = (rows) => rows.reduce((c, r) => foldCollab(c, r), newCollab());
const call = (name, id, input) => ({ ...tool(name, input), id });
const result = (sec, id, toolUseResult, isError = false) => ({
  type: "user", timestamp: at(sec), toolUseResult,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "x" }] },
});
const queued = (sec, content, operation = "enqueue") => ({ type: "queue-operation", operation, timestamp: at(sec), content });
const said = (sec, content) => ({ type: "user", timestamp: at(sec), message: { role: "user", content } });
const notif = (taskId, toolUseId, status, summary) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

test("a foreground delegation ends with its result; an error fails it; the prompt is never kept", () => {
  const c = fold([
    asst({ sec: 0, content: [call("Agent", "d1", { description: "Audit", subagent_type: "docs-checker", prompt: "SECRET PROMPT" })] }),
    result(30, "d1", { status: "completed" }),
    asst({ sec: 40, content: [call("Agent", "d2", { description: "Fix", subagent_type: "general-purpose" })] }),
    result(41, "d2", "Error: limit", true),
  ]);
  const [d2, d1] = collabView(c).delegations;
  assert.deepEqual([d1.status, d1.doneAt, d1.type, d1.description], ["done", T0 + 30e3, "docs-checker", "Audit"]);
  assert.equal(d2.status, "failed");
  assert.ok(!JSON.stringify(collabView(c)).includes("SECRET PROMPT"));
});

test("a background delegation runs until its notification, which counts once and is not a separate completion", () => {
  const n = notif("t1", "d1", "completed", 'Agent "Audit" completed');
  const c = fold([
    asst({ sec: 0, content: [call("Agent", "d1", { description: "Audit", subagent_type: "x", run_in_background: true })] }),
    result(1, "d1", { status: "async_launched", isAsync: true }),
  ]);
  assert.equal(collabView(c).delegations[0].status, "running");
  foldCollab(c, queued(60, n));
  foldCollab(c, said(61, n));
  const v = collabView(c);
  assert.deepEqual([v.delegations[0].status, v.delegations[0].doneAt], ["done", T0 + 60e3]);
  assert.equal(v.completions.length, 0);
});

test("other background work becomes a completion, once per task; a shell job shows its description, never its command", () => {
  const c = fold([
    asst({ sec: 0, content: [call("Bash", "b1", { command: "deploy --token SECRET-CMD", description: "Build the site", run_in_background: true })] }),
    queued(5, notif("k1", "b1", "completed", 'Background command "deploy --token SECRET-CMD" completed (exit code 0)')),
    said(6, notif("k1", "b1", "completed", "a second copy")),
    queued(8, notif("k2", "tu_unknown", "completed", 'Background command "rm -rf SECRET-CMD" completed (exit code 0)')),
    queued(9, notif("k3", "tu_m", "killed", "Monitor stopped")),
  ]);
  const v = collabView(c);
  assert.deepEqual(v.completions.map((x) => [x.status, x.text]), [
    ["stopped", "Monitor stopped"],
    ["done", "A background command"],
    ["done", "Build the site"],
  ]);
  assert.deepEqual(v.completions.map((x) => x.useId), ["tu_m", "tu_unknown", "b1"]); // the call's id rides along so the session view can resolve a subagent's shell
  assert.ok(!JSON.stringify(v).includes("SECRET-CMD"));
});

test("sent messages keep their summary, received ones their sender and first line, once; pipes map to names", () => {
  const msg = '<cross-session-message from="uds:p1" from-name="beta" from-mode="prompting">\n\nReleased App.tsx\nmore detail\n</cross-session-message>';
  const c = fold([
    asst({ sec: 0, content: [call("SendMessage", "m1", { to: "uds:p1", recipient: "uds:p1", summary: "Ask beta to release App.tsx", message: "WHOLE BODY", type: "message" })] }),
    queued(10, msg),
    said(12, msg),
    queued(13, msg, "remove"),
  ]);
  const v = collabView(c);
  assert.deepEqual(v.sent.map((m) => [m.at, m.to, m.text]), [[T0, "uds:p1", "Ask beta to release App.tsx"]]);
  assert.deepEqual(v.received.map((m) => [m.at, m.from, m.text]), [[T0 + 10e3, "beta", "Released App.tsx"]]);
  assert.deepEqual(v.pipes, { "uds:p1": "beta" });
  assert.ok(!JSON.stringify(v).includes("WHOLE BODY"));
});

test("a cross-session message counts only as a real delivery, never when a longer prompt quotes it", () => {
  const msg = (pipe, name) => `<cross-session-message from="uds:${pipe}" from-name="${name}" from-mode="prompting">\nReleased App.tsx\n</cross-session-message>`;
  const c = fold([
    said(1, "This session is being continued from a previous conversation. Earlier a peer wrote:\n" + msg("p7", "name")),
    said(2, "Another Claude session sent a message:\n" + msg("p8", "beta")),
    queued(3, msg("p9", "gamma")),
  ]);
  const v = collabView(c);
  assert.deepEqual(v.received.map((m) => [m.at, m.from]), [[T0 + 3e3, "gamma"], [T0 + 2e3, "beta"]]);
  assert.deepEqual(Object.keys(v.pipes).sort(), ["uds:p8", "uds:p9"]);
});

test("pull requests list once; an assistant quoting a notification and sidechain rows change nothing", () => {
  const pr = { type: "pr-link", timestamp: at(0), prNumber: 12, prUrl: "https://github.com/o/r/pull/12", prRepository: "o/r" };
  const c = fold([
    pr,
    { ...pr, timestamp: at(5) },
    asst({ sec: 6, content: [{ type: "text", text: notif("q1", "tu_q", "completed", "quoted") }] }),
    asst({ sec: 7, sidechain: true, content: [call("Agent", "s1", { description: "inner" })] }),
  ]);
  const v = collabView(c);
  assert.deepEqual(v.prs.map((p) => [p.number, p.repo, p.at]), [[12, "o/r", T0]]);
  assert.equal(v.completions.length, 0);
  assert.equal(v.delegations.length, 0);
});

test("a background shell or watch the chat started is pending until its notification; a refused launch never is; a wakeup keeps its time", () => {
  const c = fold([
    asst({ sec: 0, content: [call("Bash", "b1", { command: "gh pr checks 12 --watch", description: "Wait for PR 12 checks", run_in_background: true })] }),
    result(1, "b1", { stdout: "", backgroundTaskId: "k1" }),
    asst({ sec: 2, content: [call("Bash", "b2", { command: "npx tsc", description: "Type-check the app", run_in_background: true })] }),
    result(3, "b2", "PreToolUse:Bash hook error: heavy-job gate", true), // refused: nothing runs
    asst({ sec: 4, content: [call("Monitor", "m1", { command: "until x; do sleep 5; done", description: "prod build of abc1234", timeout_ms: 900000 })] }),
    result(5, "m1", { taskId: "k2", timeoutMs: 900000, persistent: false }),
    asst({ sec: 6, content: [call("Bash", "b3", { command: "npm test", description: "Run the tests", run_in_background: true })] }),
    result(7, "b3", { stdout: "", backgroundTaskId: "k3" }),
    said(60, notif("k3", "b3", "completed", "Background command done")),
  ]);
  const v = collabView(c);
  assert.deepEqual(v.background.map((b) => [b.text, b.kind, b.at, b.until]), [["prod build of abc1234", "watch", T0 + 4e3, T0 + 5e3 + 900e3], ["Wait for PR 12 checks", "shell", T0, null]]);
  assert.ok(!JSON.stringify(v.background).includes("gh pr"), "never the command");
  foldCollab(c, said(70, notif("k2", "m1", "completed", "Monitor ended")));
  assert.deepEqual(collabView(c).background.map((b) => b.text), ["Wait for PR 12 checks"]);
  assert.equal(collabView(c).wakeAt, null);
  foldCollab(c, asst({ sec: 80, content: [call("ScheduleWakeup", "w1", { delaySeconds: 600, reason: "watching CI", prompt: "/loop" })] }));
  assert.equal(collabView(c).wakeAt, T0 + 80e3 + 600e3);
  foldCollab(c, asst({ sec: 90, content: [call("ScheduleWakeup", "w2", { stop: true })] }));
  assert.equal(collabView(c).wakeAt, null);
});
