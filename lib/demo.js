// Demo mode (node server.js --demo): a throwaway .demo folder in the app folder with six made-up Claude Code
// sessions, three running subagents and a stand-in for the approval bridge, so the whole page can be tried with no Claude
// Code and no setup. lib/demo-panels.js adds the panels' data. Nothing here reads the real ~/.claude: the server is
// pointed at the demo folder through a generated settings file, exactly as `--settings` would. Each demo start replaces
// the folder, and a clean exit removes it.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { hashOf } = require("../bridge/hq-bridge");
const panels = require("./demo-panels");

const DEMO_PORT = 7790;
const MODEL = "claude-sonnet-4-5";
const STEP_MS = 5000; // how often the working sessions take a new step
const ASK_AGAIN_MS = 20e3; // after an answer, how long until the demo session asks the next thing

const id = () => crypto.randomUUID();
const hex = (n) => crypto.randomBytes(n).toString("hex");
let seq = 0;
const iso = (t = Date.now()) => new Date(t).toISOString();
let ctx = 60000; // the context the working session has used, so the gauge moves
function asst(content, { stop = "tool_use", sidechain = false, t } = {}) {
  ctx = ctx < 130000 ? ctx + 400 : 60000; // past this the demo session compacted
  return {
    type: "assistant", timestamp: iso(t), isSidechain: sidechain,
    message: { id: "msg_demo_" + ++seq, model: MODEL, role: "assistant", stop_reason: stop, usage: { input_tokens: 12, output_tokens: 180, cache_read_input_tokens: ctx, cache_creation_input_tokens: 900 }, content },
  };
}
const user = (text, extra = {}, t) => ({ type: "user", timestamp: iso(t), message: { role: "user", content: text }, ...extra });
const tool = (name, input) => ({ type: "tool_use", id: "toolu_demo_" + ++seq, name, input });
const result = (useId, content = "ok", sidechain = false) => ({ type: "user", timestamp: iso(), isSidechain: sidechain, message: { role: "user", content: [{ type: "tool_result", tool_use_id: useId, content }] } });
const text = (t) => ({ type: "text", text: t });
const line = (row) => JSON.stringify(row) + "\n";

// The steps a working session cycles through, one each STEP_MS
const STEPS = [
  () => tool("Read", { file_path: "/demo/webapp/src/forms/signup.ts" }),
  () => tool("Grep", { pattern: "validateEmail", path: "/demo/webapp/src" }),
  () => tool("Edit", { file_path: "/demo/webapp/src/forms/signup.ts", old_string: "if (!email) return false", new_string: "if (!isEmail(email)) return false" }),
  () => tool("Bash", { command: "npm test -- signup", description: "Run the signup tests" }),
  () => tool("Read", { file_path: "/demo/webapp/src/forms/password.ts" }),
];
const SUB_STEPS = [
  () => tool("Glob", { pattern: "src/**/*.ts" }),
  () => tool("Grep", { pattern: "validate", path: "src" }),
  () => tool("Read", { file_path: "/demo/webapp/src/forms/address.ts" }),
];

// Three more working sessions, so the office has people in it: each goes through its own steps
const MORE = [
  {
    key: "d", project: "mobile-app", branch: "perf/photo-list", title: "Speed up the photo list", says: "The photo list stutters while scrolling. Make it smooth.",
    sub: { type: "Plan", description: "Plan the list rewrite" },
    steps: [
      () => tool("Read", { file_path: "/demo/mobile-app/src/photos/list.tsx" }),
      () => tool("Bash", { command: "npm run bench -- photos", description: "Measure the scroll" }),
      () => tool("Edit", { file_path: "/demo/mobile-app/src/photos/list.tsx", old_string: "<List", new_string: "<WindowedList" }),
    ],
  },
  {
    key: "e", project: "design-kit", branch: "feat/dark-theme", title: "Add a dark theme", says: "Give every component a dark theme.",
    steps: [
      () => tool("Glob", { pattern: "src/components/*.css" }),
      () => tool("Edit", { file_path: "/demo/design-kit/src/components/button.css", old_string: "color: #111", new_string: "color: var(--text)" }),
      () => tool("Read", { file_path: "/demo/design-kit/src/tokens.css" }),
    ],
  },
  {
    key: "f", project: "data-jobs", branch: "fix/import-retry", title: "Retry failed imports", says: "Imports that time out should retry three times.",
    steps: [
      () => tool("Grep", { pattern: "runImport", path: "/demo/data-jobs/src" }),
      () => tool("Edit", { file_path: "/demo/data-jobs/src/import.ts", old_string: "await run()", new_string: "await retry(run, 3)" }),
      () => tool("Bash", { command: "npm test -- import", description: "Run the import tests" }),
    ],
  },
];

// What the third session asks, in turn: a permission, a question, another permission
const ASKS = [
  { event: "PermissionRequest", toolName: "Bash", toolInput: { command: "npm run lint", description: "Lint the upload module" } },
  {
    event: "PreToolUse", toolName: "AskUserQuestion",
    toolInput: { questions: [{ question: "The upload test is flaky because of a fixed timeout. Which fix do you want?", header: "Fix", multiSelect: false, options: [{ label: "Use fake timers", description: "Fast and stable" }, { label: "Raise the timeout", description: "Smallest change" }] }] },
  },
  { event: "PermissionRequest", toolName: "Edit", toolInput: { file_path: "/demo/api-server/test/upload.test.js", old_string: "setTimeout(done, 500)", new_string: "vi.advanceTimersByTime(500)" } },
];

// A month of past work, two chats a day, so the spend and action charts have a line to draw
const PAST_PROJECTS = ["webapp", "api-server", "mobile-app", "docs-site", "design-kit", "data-jobs"];
function pastWork(proj, now) {
  for (let day = 1; day <= 30; day++) {
    for (let k = 0; k < 2; k++) {
      const n = day * 2 + k;
      const end = now - day * 864e5 + (k ? 18 : 6) * 36e5 - (day === 1 ? 3 * 36e5 : 0);
      const rows = [];
      const steps = 10 + ((n * 7) % 13);
      for (let i = steps; i > 0; i--) {
        const call = [() => tool("Read", { file_path: "/demo/a.ts" }), () => tool("Edit", { file_path: "/demo/a.ts", old_string: "a", new_string: "b" }), () => tool("Bash", { command: "npm test" }), () => tool("Grep", { pattern: "a" })][(i + n) % 4]();
        const row = asst([call], { t: end - i * 20 * 60e3 });
        row.message.usage = { input_tokens: 20, output_tokens: 3000 + ((n * i * 977) % 9000), cache_read_input_tokens: 60000 + ((n * 4241) % 50000), cache_creation_input_tokens: 4000 };
        rows.push(row);
      }
      const fp = path.join(proj(PAST_PROJECTS[n % PAST_PROJECTS.length]), `past-${n}.jsonl`);
      fs.writeFileSync(fp, rows.map(line).join(""));
      fs.utimesSync(fp, new Date(end), new Date(end));
    }
  }
}

// Builds the demo folder and returns { settings, root }; start() then keeps it moving once the server listens.
function prepare({ appDir }) {
  const root = path.join(appDir, ".demo");
  fs.rmSync(root, { recursive: true, force: true }); // the last demo's leftovers, if it was killed
  fs.mkdirSync(root);
  const data = path.join(root, "data");
  const state = path.join(root, "state");
  fs.mkdirSync(state, { recursive: true });
  // the context size the gauge measures against, as Claude Code's own settings name it
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "settings.json"), JSON.stringify({ autoCompactWindow: 200000, hooks: panels.switchHook() }));
  const config = JSON.parse(fs.readFileSync(path.join(appDir, "hq.config.example.json"), "utf8"));
  Object.assign(config, panels.panelConfig(root));
  config.control = true; // answering from the page is the point of the demo; the judge and the assistant stay off
  const configPath = path.join(root, "demo.config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const port = Number(process.env.VIBEQUARTERS_PORT) || DEMO_PORT;
  const settings = path.join(root, "demo.settings.json");
  fs.writeFileSync(settings, JSON.stringify({ dataDir: data, stateDir: state, configPath, port, homeDir: root }));

  const proj = (name) => {
    const d = path.join(data, "projects", name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const now = Date.now();
  // 1: working on signup validation, with an Explore subagent and a general-purpose one running
  const A = id();
  const pa = proj("webapp");
  const fa = path.join(pa, A + ".jsonl");
  const exploreCall = tool("Agent", { description: "Find every form validator", subagent_type: "Explore", prompt: "List the validators in src/forms.", run_in_background: true });
  const builderCall = tool("Agent", { description: "Write the validation tests", subagent_type: "general-purpose", prompt: "Write tests for the new validators.", run_in_background: true });
  fs.writeFileSync(fa, [
    { type: "ai-title", aiTitle: "Add signup form validation", sessionId: A },
    user("Add validation to the signup form and cover it with tests.", { cwd: "/demo/webapp", gitBranch: "feat/signup-validation" }, now - 240e3),
    asst([exploreCall], { t: now - 200e3 }),
    result(exploreCall.id, "Async agent launched"),
    asst([builderCall], { t: now - 190e3 }),
    result(builderCall.id, "Async agent launched"),
    asst([STEPS[0]()]),
  ].map(line).join(""));
  const subDir = path.join(pa, A, "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  const subs = [
    { name: "agent-a" + hex(8), meta: { agentType: "Explore", description: "Find every form validator", toolUseId: exploreCall.id } },
    { name: "agent-a" + hex(8), meta: { agentType: "general-purpose", description: "Write the validation tests", toolUseId: builderCall.id } },
  ].map((s) => {
    const fp = path.join(subDir, s.name + ".jsonl");
    fs.writeFileSync(path.join(subDir, s.name + ".meta.json"), JSON.stringify(s.meta));
    fs.writeFileSync(fp, line(user("Start.", { isSidechain: true }, now - 180e3)) + line(asst([SUB_STEPS[0]()], { sidechain: true })));
    return fp;
  });

  // 2: its turn ended, waiting for the user's reply
  const B = id();
  const fb = path.join(proj("docs-site"), B + ".jsonl");
  fs.writeFileSync(fb, [
    { type: "ai-title", aiTitle: "Rewrite the install guide", sessionId: B },
    user("Rewrite the install guide for the new CLI.", { cwd: "/demo/docs-site", gitBranch: "docs/install" }, now - 600e3),
    asst([tool("Read", { file_path: "/demo/docs-site/install.md" })], { t: now - 560e3 }),
    asst([text("The new install guide is drafted in install.md. Want me to also update the README's quick start?")], { stop: "end_turn", t: now - 90e3 }),
  ].map(line).join(""));

  // 3: fixing a flaky test; asks for permissions and a question through the stand-in bridge
  const C = id();
  const fc = path.join(proj("api-server"), C + ".jsonl");
  fs.writeFileSync(fc, [
    { type: "ai-title", aiTitle: "Fix the flaky upload test", sessionId: C },
    user("The upload test fails about one run in ten. Find out why and fix it.", { cwd: "/demo/api-server", gitBranch: "fix/flaky-upload" }, now - 300e3),
    asst([tool("Read", { file_path: "/demo/api-server/test/upload.test.js" })], { t: now - 280e3 }),
  ].map(line).join(""));

  // 4 to 6: more work under way, the first with a Plan subagent
  const more = MORE.map((m, i) => {
    const sid = id(), dir = proj(m.project), fp = path.join(dir, sid + ".jsonl");
    const call = m.sub && tool("Agent", { description: m.sub.description, subagent_type: m.sub.type, prompt: m.says, run_in_background: true });
    fs.writeFileSync(fp, [
      { type: "ai-title", aiTitle: m.title, sessionId: sid },
      user(m.says, { cwd: "/demo/" + m.project, gitBranch: m.branch }, now - (400 + 90 * i) * 1e3),
      ...(call ? [asst([call], { t: now - 120e3 }), result(call.id, "Async agent launched")] : []),
      asst([m.steps[0]()]),
    ].map(line).join(""));
    if (call) {
      const name = "agent-a" + hex(8), sub = path.join(dir, sid, "subagents");
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, name + ".meta.json"), JSON.stringify({ agentType: m.sub.type, description: m.sub.description, toolUseId: call.id }));
      const sfp = path.join(sub, name + ".jsonl");
      fs.writeFileSync(sfp, line(user("Start.", { isSidechain: true }, now - 110e3)) + line(asst([SUB_STEPS[1]()], { sidechain: true })));
      subs.push(sfp);
    }
    return { key: m.key, id: sid, fp, steps: m.steps };
  });

  const ids = { a: A, b: B, c: C, ...Object.fromEntries(more.map((m) => [m.key, m.id])) };
  pastWork(proj, now);
  panels.prepare({ appDir, root, data, ids, now });
  world = { root, data, state, fa, fb, fc, subs, C, ids, more };
  return { settings, root };
}

let world = null;
// Keeps the demo alive: steps for the working session and its subagents, the waiting session kept on the page, and the
// stand-in bridge that asks, reads the page's answer, and asks again a little later.
function start() {
  if (!world) return;
  const { root, data, state, fa, fb, fc, subs, C, ids, more } = world;
  let step = 1, subStep = 1;
  const tick = setInterval(() => {
    const call = STEPS[step++ % STEPS.length]();
    fs.appendFileSync(fa, line(asst([call])));
    setTimeout(() => { try { fs.appendFileSync(fa, line(result(call.id))); } catch {} }, 1500).unref();
    for (const fp of subs) fs.appendFileSync(fp, line(asst([SUB_STEPS[subStep % SUB_STEPS.length]()], { sidechain: true })));
    subStep++;
    more.forEach((m, i) => setTimeout(() => {
      const c = m.steps[step % m.steps.length]();
      try { fs.appendFileSync(m.fp, line(asst([c])) + line(result(c.id))); } catch {}
    }, 800 * (i + 1)).unref());
    const t = new Date();
    fs.utimesSync(fb, t, t); // the waiting session stays on the page while the demo runs
    fs.utimesSync(fc, t, t);
    try { panels.tick({ data, ids }); } catch {} // a file held by a reader: the next tick writes it
  }, STEP_MS);

  const dir = path.join(state, "decisions");
  fs.mkdirSync(dir, { recursive: true });
  let ask = 0, open = null, nextAt = Date.now() + 3000;
  const bridge = setInterval(() => {
    const now = Date.now();
    if (open) {
      const ans = path.join(dir, open + ".answer.json");
      if (!fs.existsSync(ans)) return;
      for (const f of [ans, path.join(dir, open + ".json")]) fs.rmSync(f, { force: true });
      fs.appendFileSync(fc, line(asst([tool("Bash", { command: "npm test -- upload", description: "Run the upload test" })])));
      open = null;
      nextAt = now + ASK_AGAIN_MS;
      return;
    }
    if (now < nextAt) return;
    const a = ASKS[ask++ % ASKS.length];
    const req = { v: 1, id: hex(16), pid: process.pid, askedAt: now, event: a.event, sessionId: C, transcriptPath: fc, agentId: null, agentType: null, toolName: a.toolName, toolInput: a.toolInput, trimmed: false, toolUseId: a.event === "PreToolUse" ? "toolu_demo_q" + ++seq : null, cwd: "/demo/api-server" };
    req.hash = hashOf(req);
    fs.appendFileSync(fc, line(asst([{ type: "tool_use", id: req.toolUseId || "toolu_demo_" + ++seq, name: a.toolName, input: a.toolInput }])));
    fs.writeFileSync(path.join(dir, req.id + ".json"), JSON.stringify(req));
    open = req.id;
  }, 1000);
  tick.unref();
  bridge.unref();
  const cleanup = () => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
}

module.exports = { prepare, start, DEMO_PORT, queueOptions: panels.queueOptions, deploysRun: panels.deploysRun };
