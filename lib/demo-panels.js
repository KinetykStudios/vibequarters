// The demo's made-up data for the panels the system pack feeds: the coordination board, the Queue, the deploy wall,
// keep-warm, the agent switches, the plan line and the approvals chooser. Everything is written inside the demo folder,
// and the gh and process-list reads are answered here (queueRun, deploysRun), so a demo asks GitHub nothing.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = "demo/webapp";
const MIN = 60e3;
const sha = (n) => crypto.createHash("sha1").update("demo " + n).digest("hex"); // a made-up commit
const BASE = sha(100), BATCH = sha(210);
const MEMBERS = [
  { pr: 21, head: sha(121), title: "Validate the signup form" },
  { pr: 22, head: sha(122), title: "Rewrite the install guide" },
  { pr: 23, head: sha(123), title: "Use fake timers in the upload test" },
];
const CHECKS = ["build", "test"];
const ACCOUNTS = { demoaccount1: "Work", demoaccount2: "Personal" };
const MARKER = "vitest";

// What the demo adds to its config
function panelConfig(root) {
  return {
    systemDir: path.join(root, "system"),
    deploys: { repo: REPO, branch: "main", provider: "vercel", usualMinutes: 2 },
    queue: { repos: [REPO], requiredChecks: CHECKS },
    accountLabels: ACCOUNTS,
  };
}

// What the demo's Claude Code settings hold besides the compact size: the switch hook, so a switch reads as enforced
const switchHook = () => ({ PreToolUse: [{ matcher: "Agent|Task", hooks: [{ type: "command", command: "node", args: ["hq-agent-switch.js"] }] }] });

const put = (file, v) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, typeof v === "string" ? v : JSON.stringify(v));
  fs.renameSync(tmp, file);
};

// The four approval presets in the app's own shape; every one carries the app's never-auto list
function presets(appDir, system) {
  const base = JSON.parse(fs.readFileSync(path.join(appDir, "approval-levels.json"), "utf8"));
  const reads = base.routine;
  const none = { tools: [], commands: [], hooks: [] };
  const coding = { tools: reads.tools, commands: [...reads.commands, "git add", "git commit", "npm test", "npm run lint"], hooks: [] };
  for (const [id, routine] of [["ask-all", none], ["safe-reads", reads], ["routine", coding], ["routine-judge", coding]])
    put(path.join(system, "presets", "approvals", id + ".json"), { routine, yours: base.yours });
}

// Writes everything once. ids: the demo sessions, as { a, b, c, d, e, f }
function prepare({ appDir, root, data, ids, now = Date.now() }) {
  presets(appDir, path.join(root, "system"));
  const dir = path.join(data, "coordination");
  const { a, b, c, d, e, f } = ids;
  const session = (id, name, task) => ({ id, name, task, lastSeen: now });
  put(path.join(dir, "registry.json"), {
    sessions: {
      [a]: session(a, "webapp-1", "Add signup form validation"),
      [b]: session(b, "docs-site-2", "Rewrite the install guide"),
      [c]: session(c, "api-server-3", "Fix the flaky upload test"),
      [d]: session(d, "mobile-app-4", "Speed up the photo list"),
      [e]: session(e, "design-kit-5", "Add a dark theme"),
      [f]: session(f, "data-jobs-6", "Retry failed imports"),
    },
    claims: [
      { session: a, repo: "webapp", path: "src/forms/signup.ts", at: now - 4 * MIN },
      { session: a, repo: "webapp", path: "src/forms/password.ts", at: now - 3 * MIN },
      { session: b, repo: "docs-site", path: "install.md", at: now - 9 * MIN },
      { session: c, repo: "api-server", path: "test/upload.test.js", at: now - 5 * MIN },
    ],
    locks: { merge: { session: b, at: now - 2 * MIN } },
    notes: [
      { at: now - 8 * MIN, by: "api-server-3", text: "The upload test fails only under load" },
      { at: now - 2 * MIN, by: "docs-site-2", text: "Landing batch demo-2, three pull requests" },
    ],
    requests: [{ id: "req-00de01", state: "open", from: c, to: a, path: "src/forms/signup.ts", at: now - 3 * MIN }],
  });
  put(path.join(dir, "batches", "demo-2.json"), { id: "demo-2", repo: REPO, batchPr: 24, head: BATCH, base: BASE, state: "built", members: MEMBERS });
  const review = (m, verdict) => put(path.join(dir, "reviews", `webapp-${m.pr}-${m.head}.txt`), `PR #${m.pr} head ${m.head}\nRead the whole change.\n${verdict}\n`);
  review(MEMBERS[0], "VERDICT: CLEAN - 0 Critical, 0 Important, 3 Minor");
  review(MEMBERS[1], "VERDICT: CLEAN - 0 Critical, 0 Important, 2 Minor");
  put(path.join(data, "vibequarters-usage", "accounts.json"), {
    v: 1,
    accounts: [
      { accountKey: "demoaccount1", resetsAt: new Date(now + 3 * 864e5).toISOString(), lastSeenPct: 46, seenAt: new Date(now - 5 * MIN).toISOString() },
      { accountKey: "demoaccount2", resetsAt: new Date(now + 1 * 864e5).toISOString(), lastSeenPct: 71, seenAt: new Date(now - 30 * 60 * MIN).toISOString() },
    ],
  });
  put(path.join(data, "vibequarters-usage", "plan-usage.json"), { v: 1, accountKey: "demoaccount1", seven_day: 46, five_hour: 22, resetsAt: new Date(now + 3 * 864e5).toISOString(), at: new Date(now).toISOString() });
  put(path.join(data, "hq-feed", "agents-off.json"), { v: 1, at: now, off: [{ id: "guide", name: "Guide", agentTypes: ["claude-code-guide", "statusline-setup"] }] });
  put(path.join(data, "hq-feed", "control", a + ".json"), { keepWarm: true, at: now - 20 * MIN });
  tick({ data, ids, now });
}

// Kept moving while the demo runs: the test run holding the heavy-job gate, the session waiting on it, the merge lock
// and the sessions' last-seen times, and each session's keep-warm report, which follows the page's switch
function tick({ data, ids, now = Date.now() }) {
  const dir = path.join(data, "coordination");
  put(path.join(dir, "heavy-claims", "demo.json"), { session: ids.a, command: "npx vitest run", marker: MARKER, started: now - 2 * MIN, until: now + 5 * MIN, background: false });
  put(path.join(dir, "shell-hygiene.log"), `${new Date(now - MIN).toISOString()} deny heavy cpu 82% ${ids.c.slice(0, 8)} npm test -- upload\n`);
  const regFile = path.join(dir, "registry.json");
  const reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
  for (const s of Object.values(reg.sessions)) s.lastSeen = now;
  if (now - reg.locks.merge.at > 10 * MIN) reg.locks.merge.at = now - 2 * MIN;
  put(regFile, reg);
  for (const id of Object.values(ids)) {
    const fp = path.join(data, "hq-feed", id + ".json");
    let on = false, was = null;
    try { on = JSON.parse(fs.readFileSync(path.join(data, "hq-feed", "control", id + ".json"), "utf8")).keepWarm === true; } catch {}
    try { was = JSON.parse(fs.readFileSync(fp, "utf8")); } catch {}
    const first = { pings: id === ids.a ? 3 : 0, lastPingAt: id === ids.a ? now - 4 * MIN : null };
    const w = was ? was.warm : first;
    const due = on && (!w.lastPingAt || now - w.lastPingAt > 5 * MIN);
    put(fp, { v: 1, sessionId: id, updatedAt: now, warm: { on, pings: w.pings + (due ? 1 : 0), lastPingAt: due ? now : w.lastPingAt, stopped: null }, brake: { asks: 0, lastAt: null, opusThisTurn: 0 } });
  }
}

// The Queue's reads, as execFile would answer them: the process list, the open pull requests and the branch's tip
function queueRun(file, args, opts, done) {
  const answer = (out) => setImmediate(() => done(null, out));
  if (file !== "gh") return answer(`node ${MARKER}.mjs run\n`);
  if (args[0] === "api") return answer(BASE + "\n");
  const passed = CHECKS.map((name) => ({ name, status: "COMPLETED", conclusion: "SUCCESS", startedAt: new Date(Date.now() - 8 * MIN).toISOString() }));
  const running = [passed[0], { name: CHECKS[1], status: "IN_PROGRESS", conclusion: "", startedAt: new Date(Date.now() - MIN).toISOString() }];
  answer(JSON.stringify([{ number: 24, headRefOid: BATCH, statusCheckRollup: running }, ...MEMBERS.map((m) => ({ number: m.pr, headRefOid: m.head, statusCheckRollup: passed }))]));
}
const queueOptions = { run: queueRun, platform: "win32", markerAlive: (marker, procs) => procs.some((p) => p.includes(marker)) };

// The deploy wall's reads: a new commit every few minutes, its build about two minutes long, one of them failed
const EVERY = 6 * MIN, BUILD = 2 * MIN;
const SUBJECTS = ["Round the corners of the cards", "Cache the forecast for an hour", "Add a dark theme", "Fix the search box on phones", "Show the empty cart", "Speed up the first load"];
function deploysRunAt(clock) {
  const known = new Map(); // commit -> its number
  const t0 = clock() - BUILD / 2; // the newest build is half done when the demo opens
  return async (args) => {
    const url = String(args[1]);
    const at = (n) => t0 + n * EVERY;
    if (url.includes("/commits?")) {
      const n = Math.floor((clock() - t0) / EVERY);
      return JSON.stringify([0, 1, 2, 3, 4].map((k) => n - k).map((k) => (known.set(sha(1000 + k), k), { sha: sha(1000 + k), subject: SUBJECTS[((k % SUBJECTS.length) + SUBJECTS.length) % SUBJECTS.length], at: new Date(at(k)).toISOString() })));
    }
    const m = /\/commits\/([0-9a-f]{40})\//.exec(url);
    const k = m ? known.get(m[1]) || 0 : 0;
    const out = [{ state: "pending", at: new Date(at(k)).toISOString() }];
    const end = at(k) + BUILD + (((k % 3) + 3) % 3) * 10e3;
    if (clock() >= end) out.push({ state: k === -3 ? "failure" : "success", at: new Date(end).toISOString() });
    return JSON.stringify(out);
  };
}
const deploysRun = () => deploysRunAt(Date.now);

module.exports = { prepare, tick, panelConfig, switchHook, queueOptions, queueRun, deploysRun, deploysRunAt, REPO, CHECKS, MARKER };
