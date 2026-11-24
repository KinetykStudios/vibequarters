// The demo's made-up data (lib/demo.js, lib/demo-panels.js): every restored panel has something to show, it is written
// only inside the demo folder, and nothing it reads asks GitHub or the real process list.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const demo = require("../lib/demo");
const panels = require("../lib/demo-panels");
const { validateConfig } = require("../config");
const { createBoard, boardView } = require("../lib/board");
const { createQueue } = require("../lib/queue");
const { createDeploys } = require("../lib/deploys");
const { createFeed } = require("../lib/feed");
const { createSwitches, createEnforcement } = require("../lib/switches");
const { planOf, accountsOf } = require("../lib/accounts");
const { createApprovals } = require("../lib/approvals");
const { levelOf } = require("../lib/levels");

const ROOT = path.join(__dirname, "..");
const LEVELS = path.join(ROOT, "approval-levels.json");
const roots = [];
test.after(async () => {
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
function app() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-demo-"));
  roots.push(appDir);
  for (const f of ["hq.config.example.json", "approval-levels.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(appDir, f));
  const { settings, root } = demo.prepare({ appDir });
  const s = JSON.parse(fs.readFileSync(settings, "utf8"));
  const config = JSON.parse(fs.readFileSync(s.configPath, "utf8"));
  return { appDir, root, s, config, data: s.dataDir, state: s.stateDir };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const registry = (data) => path.join(data, "coordination", "registry.json");

test("the demo folder holds everything, with a valid config and nothing written beside it", () => {
  const { appDir, root, s, config } = app();
  assert.deepEqual(validateConfig(config), []);
  assert.deepEqual(fs.readdirSync(appDir).sort(), [".demo", "approval-levels.json", "hq.config.example.json"]);
  for (const k of ["dataDir", "stateDir", "configPath", "homeDir"]) assert.ok(path.resolve(s[k]).startsWith(path.resolve(root)), k);
  assert.equal(config.control, true);
  assert.equal(config.judge, false);
  assert.equal(config.assistant, undefined, "the assistant stays off");
});

test("the board shows claims, a lock, notes and an open request of the demo's own sessions", () => {
  const { data } = app();
  const snap = createBoard(registry(data)).read();
  const v = boardView(snap, Object.keys(snap.sessions));
  assert.equal(v.claims.length, 4);
  assert.deepEqual(v.locks.map((l) => [l.name, l.sessionName]), [["merge", "docs-site-2"]]);
  assert.equal(v.notes.length, 2);
  assert.equal(snap.sessions[v.claims[0].session].name, "webapp-1");
  assert.deepEqual(Object.values(snap.sessions).map((s) => s.name), ["webapp-1", "docs-site-2", "api-server-3", "mobile-app-4", "design-kit-5", "data-jobs-6"]);
  assert.equal(fs.readdirSync(path.join(data, "projects")).length, 6);
});

test("the demo has a month of past work for the charts, none of it recent enough to show as a chat", () => {
  const { data } = app();
  const old = fs.readdirSync(path.join(data, "projects")).flatMap((d) => fs.readdirSync(path.join(data, "projects", d)).filter((f) => f.startsWith("past-")).map((f) => fs.statSync(path.join(data, "projects", d, f)).mtimeMs));
  assert.equal(old.length, 60);
  assert.ok(old.every((m) => m < Date.now() - 3 * 36e5));
  assert.ok(Math.min(...old) > Date.now() - 32 * 864e5);
});

test("the Queue shows a busy gate, a waiting session, the lock, a request and a batch, with no gh run", async () => {
  const { data, config } = app();
  let now = Date.now();
  const q = createQueue({ dir: path.join(data, "coordination"), repos: config.queue.repos, requiredChecks: config.queue.requiredChecks, ...demo.queueOptions });
  q.read(now);
  await sleep(50); // the made-up answers arrive on the next turn
  const v = q.read((now += 11e3));
  assert.equal(v.present, true);
  assert.equal(v.github, "ok");
  assert.equal(v.gate.state, "busy");
  assert.deepEqual([v.gate.holder.job, v.gate.holder.session], ["Running tests", "webapp-1"]);
  assert.deepEqual(v.gate.waiting.map((w) => w.session), ["api-server-3"]);
  assert.equal(v.locks.find((l) => l.name === "merge").holder, "docs-site-2");
  assert.equal(v.requests.length, 1);
  assert.equal(v.batches.length, 1);
  assert.deepEqual(v.batches[0].members.map((m) => m.review), ["clean", "clean", "none"]);
  assert.deepEqual([v.batches[0].ci, v.batches[0].rebuild], ["running", null]);
});

test("the deploy wall shows a build under way, finished ones and a failed one, with no gh run", async () => {
  const { config } = app();
  let now = 1700000000000;
  const d = createDeploys(config.deploys, { run: panels.deploysRunAt(() => now) });
  await d.poll(now);
  const states = () => d.view(now).items.map((x) => x.state);
  assert.deepEqual(states(), ["building", "ready", "ready", "failed", "ready"]);
  assert.equal(d.view(now).error, null);
  assert.equal(new Set(d.view(now).items.map((x) => x.sha)).size, 5);
  now += 3 * 60e3;
  await d.poll(now);
  assert.equal(states()[0], "ready", "the build finishes while the demo runs");
});

test("keep-warm follows the page's switch, and every session has a report", () => {
  const { data } = app();
  const snap = createBoard(registry(data)).read();
  const [a, b, c] = Object.keys(snap.sessions);
  const feed = createFeed(path.join(data, "hq-feed"));
  feed.read();
  assert.deepEqual([a, b, c].map((id) => feed.get(id).warm.on), [true, false, false]);
  feed.setWarm(b, true);
  panels.tick({ data, ids: { a, b, c } });
  assert.equal(feed.get(Object.keys(snap.sessions)[5]).warm.on, false);
  feed.read();
  assert.equal(feed.get(b).warm.on, true);
  assert.equal(feed.get(b).warm.pings, 1);
});

test("the switches read as enforced with one agent off, the plan line has two made-up accounts, and the chooser opens", () => {
  const { data, state, config, root } = app();
  const file = path.join(data, "hq-feed", "agents-off.json");
  assert.deepEqual([...createSwitches({ file, agents: config.agents }).offIds()], ["guide"]);
  assert.equal(createEnforcement(path.join(data, "settings.json"))(), true);
  const planFile = path.join(data, "vibequarters-usage", "plan-usage.json");
  assert.deepEqual([planOf(planFile).pct, planOf(planFile).fiveHour], [46, 22]);
  const acc = accountsOf({ file: path.join(data, "vibequarters-usage", "accounts.json"), planFile, labels: config.accountLabels });
  assert.deepEqual(acc.rows.map((r) => [r.label, r.current, r.next]), [["Work", true, false], ["Personal", false, true]]);
  const ap = createApprovals({ stateDir: state, systemDir: config.systemDir, levelsFile: LEVELS });
  assert.equal(ap.view().chosen, null, "the chooser opens on first run");
  assert.ok(ap.view().presets.every((p) => p.installed));
  ap.choose({ preset: "routine" });
  const bash = (command) => ({ toolName: "Bash", toolInput: { command } });
  assert.equal(levelOf(ap.current().levels, bash("npm test")), "routine");
  assert.equal(levelOf(ap.current().levels, bash("git push --force")), "yours");
  assert.ok(path.resolve(config.systemDir).startsWith(path.resolve(root)));
});
