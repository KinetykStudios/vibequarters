// The Office's live additions: failed calls and checks from a transcript, the context gauge, the hq-feed mod's
// keep-warm report and switch, and the deploy wall's list.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { newSession, foldSession, checkOf } = require("../lib/session");
const { createHq } = require("../lib/hq");
const { rewarm } = require("../lib/cache");
const { createFeed } = require("../lib/feed");
const { createDeploys, deployOf, deployOfChecks, BASE_MS } = require("../lib/deploys");
const { createBoard } = require("../lib/board");
const { T0, at, asst, user, tool, jsonl } = require("./helpers");

const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const roots = [];
test.after(async () => {
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const tmp = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "hq-live-"));
  roots.push(r);
  return r;
};
const result = (sec, id, isError, content = "ok") => ({ type: "user", timestamp: at(sec), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }] } });

test("a test, type check, lint or build command is a check; anything else is not", () => {
  assert.equal(checkOf(tool("Bash", { command: "npx vitest run src/a.test.ts", description: "Run the cart tests" })), "Run the cart tests");
  assert.equal(checkOf(tool("Bash", { command: "node --test test/x.test.js" })), "node --test");
  assert.equal(checkOf(tool("PowerShell", { command: "bun run typecheck" })), "bun run typecheck");
  assert.equal(checkOf(tool("Bash", { command: "git status" })), null);
  assert.equal(checkOf(tool("Read", { file_path: "vitest.config.ts" })), null);
});

test("failed calls are kept newest last, a success ends the run, and a check records its exit", () => {
  const s = newSession(A);
  const a = tool("Bash", { command: "git push", description: "Push the branch" });
  const b = tool("Bash", { command: "npx tsc --noEmit", description: "Type check" });
  const c = tool("Read", { file_path: "C:/x/app.ts" });
  for (const row of [asst({ sec: 1, content: [a] }), result(2, a.id, true, "Exit code 1"), asst({ sec: 3, content: [b] }), result(4, b.id, true, "Exit code 2")]) foldSession(s, row);
  assert.equal(s.failRun, 2);
  assert.deepEqual(s.fails.map((f) => f.label), ["Push the branch", "Type check"]);
  assert.deepEqual(s.checks.map((k) => [k.label, k.ok]), [["Type check", false]]);
  foldSession(s, asst({ sec: 5, content: [c] }));
  foldSession(s, result(6, c.id, undefined)); // a result with no is_error is a success
  assert.equal(s.failRun, 0);
  assert.equal(s.fails.length, 2);
});

test("a keep-warm ping moves the cache's expiry, and an older one changes nothing", () => {
  const v = { state: "cold", ttl: 3600e3, expiresAt: T0, prefix: 300000, cooling: false };
  const w = rewarm(v, T0 + 600e3, T0 + 700e3);
  assert.equal(w.state, "warm");
  assert.equal(w.expiresAt, T0 + 600e3 + 3600e3);
  assert.equal(rewarm(v, T0 - 3600e3 - 1, T0), v);
  assert.equal(rewarm(v, null, T0), v);
});

test("the feed reads each chat's report, skips junk, and the switch round-trips through control/", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, A + ".json"), JSON.stringify({ v: 1, updatedAt: T0, warm: { on: true, pings: 2, lastPingAt: T0 - 5e3, stopped: null }, brake: { asks: 1 } }));
  fs.writeFileSync(path.join(dir, "not-a-session.json"), "{}");
  fs.writeFileSync(path.join(dir, "bbbbbbbb-0000-0000-0000-00000000000b.json"), "{half");
  const f = createFeed(dir);
  f.read(Date.now());
  assert.deepEqual(f.get(A).warm, { on: true, pings: 2, lastPingAt: T0 - 5e3, stopped: null });
  assert.equal(f.get(A).brake.asks, 1);
  assert.equal(f.get("bbbbbbbb-0000-0000-0000-00000000000b"), null);
  assert.equal(f.controlOf(A), null);
  assert.equal(f.setWarm(A, true), true);
  assert.deepEqual(f.controlOf(A), { keepWarm: true });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "control", A + ".json"), "utf8"))).sort(), ["at", "keepWarm"], "the control file's shape the hq-feed mod reads");
  assert.equal(f.setWarm("../evil", true), false);
  assert.equal(fs.readdirSync(path.join(dir, "control")).length, 1);
});

test("a deploy is building from its first pending status until a final one; success is ready, failure failed", () => {
  assert.deepEqual(deployOf([{ state: "pending", at: "2025-01-06T10:00:00Z" }]), { state: "building", startedAt: Date.parse("2025-01-06T10:00:00Z"), endedAt: null });
  assert.deepEqual(deployOf([{ state: "success", at: "2025-01-06T10:05:00Z" }, { state: "pending", at: "2025-01-06T10:00:00Z" }]), { state: "ready", startedAt: Date.parse("2025-01-06T10:00:00Z"), endedAt: Date.parse("2025-01-06T10:05:00Z") });
  assert.equal(deployOf([{ state: "pending", at: "2025-01-06T10:00:00Z" }, { state: "failure", at: "2025-01-06T10:02:00Z" }]).state, "failed");
  assert.equal(deployOf([]), null);
});

test("the deploy wall asks gh once per finished commit, and calls a build slow past twice the usual length", async () => {
  const now = Date.parse("2025-01-06T12:30:00Z");
  const calls = [];
  const statuses = {
    s1: [{ state: "pending", at: "2025-01-06T12:15:00Z" }], // still building after 15 min
    s2: [{ state: "pending", at: "2025-01-06T10:00:00Z" }, { state: "success", at: "2025-01-06T10:05:00Z" }],
  };
  const run = async (args) => {
    calls.push(args);
    if (args[1].includes("/commits?")) return JSON.stringify([{ sha: "aaaaaaa1", subject: "Fix the header", at: "x" }, { sha: "bbbbbbb2", subject: "Add the footer", at: "y" }]);
    const sha = /commits\/(\w+)\/statuses/.exec(args[1])[1];
    return JSON.stringify(statuses[sha === "aaaaaaa1" ? "s1" : "s2"]);
  };
  const d = createDeploys({ repo: "o/r" }, { run });
  await d.poll(now);
  const v = d.view(now);
  assert.deepEqual([v.repo, v.branch, v.provider, v.usual], ["o/r", "main", "vercel", BASE_MS]);
  assert.deepEqual(v.items.map((x) => [x.sha, x.state, x.slow]), [["aaaaaaa1", "building", true], ["bbbbbbb2", "ready", false]]);
  assert.equal(v.items[1].ms, 300e3);
  assert.match(calls[1][3], /select\(\.context == "Vercel"\)/, "Vercel's own status context by default");
  calls.length = 0;
  await d.poll(now + 16e3); // building: polled again after 15 s; the finished one is not asked again
  assert.deepEqual(calls.map((c) => c[1].split("?")[0]), ["repos/o/r/commits", "repos/o/r/commits/aaaaaaa1/statuses"]);
  assert.equal(createDeploys({ repo: "not a repo" }).view(now), null);
  assert.equal(createDeploys(null).view(now), null, "off with no config");
});

test("the deploy wall reads any host's commit status by its context, on the configured branch, with its usual length", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[1].includes("/commits?")) return JSON.stringify([{ sha: "ccccccc3", subject: "Ship it", at: "x" }]);
    return JSON.stringify([{ state: "pending", at: "2025-01-06T12:00:00Z" }, { state: "success", at: "2025-01-06T12:02:00Z" }]);
  };
  const d = createDeploys({ repo: "o/site", branch: "release", provider: "status", context: "netlify/site/deploy", usualMinutes: 2 }, { run });
  await d.poll(Date.parse("2025-01-06T12:30:00Z"));
  assert.match(calls[0][1], /^repos\/o\/site\/commits\?sha=release&/);
  assert.match(calls[1][3], /select\(\.context == "netlify\/site\/deploy"\)/);
  const v = d.view(Date.parse("2025-01-06T12:30:00Z"));
  assert.deepEqual([v.provider, v.usual, v.items[0].state], ["status", 120e3, "ready"]);
});

test("the deploy wall in checks mode reads a GitHub Actions job's check runs: running is building, the latest run decides, skipped is no deploy", async () => {
  assert.deepEqual(deployOfChecks([{ status: "in_progress", conclusion: null, startedAt: "2025-01-06T12:00:00Z" }]), { state: "building", startedAt: Date.parse("2025-01-06T12:00:00Z"), endedAt: null });
  assert.deepEqual(deployOfChecks([{ status: "completed", conclusion: "success", startedAt: "2025-01-06T12:00:00Z", completedAt: "2025-01-06T12:03:00Z" }]), { state: "ready", startedAt: Date.parse("2025-01-06T12:00:00Z"), endedAt: Date.parse("2025-01-06T12:03:00Z") });
  assert.equal(deployOfChecks([{ status: "completed", conclusion: "failure", startedAt: "2025-01-06T12:00:00Z", completedAt: "2025-01-06T12:01:00Z" }]).state, "failed");
  assert.equal(deployOfChecks([{ status: "completed", conclusion: "cancelled", startedAt: "2025-01-06T12:00:00Z" }]).state, "failed");
  assert.equal(deployOfChecks([{ status: "completed", conclusion: "skipped", startedAt: "2025-01-06T12:00:00Z" }]), null);
  // a failed run and its passing re-run: the latest counts
  assert.equal(deployOfChecks([{ status: "completed", conclusion: "success", startedAt: "2025-01-06T12:10:00Z", completedAt: "2025-01-06T12:12:00Z" }, { status: "completed", conclusion: "failure", startedAt: "2025-01-06T12:00:00Z", completedAt: "2025-01-06T12:01:00Z" }]).state, "ready");
  assert.equal(deployOfChecks([]), null);

  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[1].includes("/commits?")) return JSON.stringify([{ sha: "ddddddd4", subject: "Deploy me", at: "x" }]);
    return JSON.stringify([{ status: "queued", conclusion: null, startedAt: "2025-01-06T12:29:00Z", completedAt: null }]);
  };
  const d = createDeploys({ repo: "o/app", provider: "checks", check: "Deploy to production" }, { run });
  await d.poll(Date.parse("2025-01-06T12:30:00Z"));
  assert.equal(calls[1][1], "repos/o/app/commits/ddddddd4/check-runs?check_name=Deploy%20to%20production&per_page=30");
  assert.deepEqual(d.view(Date.parse("2025-01-06T12:30:00Z")).items.map((x) => [x.state, x.ms]), [["building", 60e3]]);
  assert.equal(createDeploys({ repo: "o/app", provider: "checks" }).view(0), null, "checks mode names its check");
});

test("gh failing leaves the last list and says why", async () => {
  const d = createDeploys({ repo: "o/r" }, { run: async () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); } });
  await d.poll(T0);
  assert.equal(d.view(T0).error, "gh is not installed");
  assert.deepEqual(d.view(T0).items, []);
});

test("a session carries its context gauge, failures, checks and keep-warm state, and its desk badge sums them", async () => {
  const root = tmp();
  const proj = path.join(root, "projects", "p1");
  fs.mkdirSync(proj, { recursive: true });
  const t1 = tool("Bash", { command: "npx vitest run", description: "Run the tests" });
  const t2 = tool("Bash", { command: "git push", description: "Push" });
  const t3 = tool("Bash", { command: "git push --force-with-lease", description: "Push again" });
  const t4 = tool("Bash", { command: "gh pr create", description: "Open the PR" });
  const usage = { input_tokens: 10, cache_read_input_tokens: 199990, cache_creation: { ephemeral_1h_input_tokens: 0 } };
  fs.writeFileSync(path.join(proj, A + ".jsonl"), jsonl([
    user({ sec: 0, text: "go" }),
    asst({ sec: 1, content: [t1], usage }), result(2, t1.id, false),
    asst({ sec: 3, content: [t2], usage }), result(4, t2.id, true, "Exit code 1"),
    asst({ sec: 5, content: [t3], usage }), result(6, t3.id, true, "Exit code 1"),
    asst({ sec: 7, content: [t4], usage }), result(8, t4.id, true, "Exit code 1"),
  ]));
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "hq.config.example.json"), "utf8"));
  const feedDir = path.join(root, "hq-feed");
  fs.mkdirSync(feedDir);
  fs.writeFileSync(path.join(feedDir, A + ".json"), JSON.stringify({ v: 1, updatedAt: T0, warm: { on: true, pings: 1, lastPingAt: T0 + 9e3 } }));
  const feed = createFeed(feedDir);
  feed.setWarm(A, true);
  const reg = path.join(root, "registry.json");
  fs.writeFileSync(reg, JSON.stringify({ sessions: {}, claims: [], locks: {}, notes: [] }));
  const hq = createHq({ config, board: createBoard(reg), feed, compactAt: 500000 });
  const NOW = T0 + 20e3;
  await hq.update({ mains: [{ fp: path.join(proj, A + ".jsonl"), sessionId: A, mtimeMs: NOW, project: "p1" }], subMtime: {}, subs: [] }, null, NOW);
  const s = hq.payload().sessions.find((x) => x.id === A);
  assert.deepEqual(s.context, { tokens: 200000, of: 500000, pct: 40 });
  assert.equal(s.failRun, 3);
  assert.deepEqual(s.fails.map((f) => f.label), ["Open the PR", "Push again", "Push"]);
  assert.deepEqual(s.checks.map((k) => [k.label, k.ok]), [["Run the tests", true]]);
  assert.equal(s.warm.canWarm, true);
  assert.equal(s.warm.on, true);
  assert.equal(s.cache.pingedAt, T0 + 9e3);
  const desk = hq.payload().floor.sessions.find((x) => x.id === A);
  assert.equal(desk.badge.ctx, 40);
  assert.equal(desk.badge.failing, true);
  assert.equal(desk.badge.check, "pass");
  assert.equal(desk.badge.cache, "warm");
  assert.equal(desk.badge.warm, true);
  assert.equal(hq.setDeploys({ items: [] }), true);
  assert.deepEqual(hq.payload().deploys, { items: [] });
});
