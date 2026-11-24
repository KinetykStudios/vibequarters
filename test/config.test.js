const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfig, validateConfig, PRODUCT_NAME } = require("../config");
const EXAMPLE = path.join(__dirname, "..", "hq.config.example.json");
const example = () => JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));

test("the shipped example config is valid", () => {
  assert.deepEqual(validateConfig(example()), []);
});

test("the words the page shows name the product, never HQ or the owner", () => {
  const dir = path.join(__dirname, "..", "public");
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 20);
  for (const f of files)
    fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).forEach((l, i) => {
      const words = l.replace(/(^|\s)\/\/ .*/, "").match(/(["'`])[^"'`]*\b(HQ|the owner)\b[^"'`]*\1/g) || [];
      assert.deepEqual(words.filter((w) => !/X-HQ-Token|^'HQ'$/.test(w)), [], `${f}:${i + 1}`); // the header's name; the sign on the floor
    });
});

test("six departments fit; a seventh is rejected with a clear message", () => {
  const c = example();
  for (const name of ["Legal", "Design", "Ops"]) c.departments.push({ name, color: "#ffffff" });
  assert.deepEqual(validateConfig(c), []);
  c.departments.push({ name: "Press", color: "#eeeeee" });
  assert.match(validateConfig(c).join(" "), /at most 6 departments fit the floor \(got 7\)/);
});

test("a sixth agent in one department is rejected", () => {
  const c = example();
  for (let i = 0; i < 4; i++) c.agents.push({ id: "x" + i, name: "X", dept: "Builders", agentTypes: [], hangout: "window" + i });
  assert.match(validateConfig(c).join(" "), /department "Builders" has 6 agents; its room holds 5 desks/);
});

test("duplicate ids, unknown departments and shared hangouts are rejected", () => {
  const c = example();
  c.agents[1].id = c.agents[0].id;
  c.agents[2].dept = "Nowhere";
  c.agents[3].hangout = c.agents[0].hangout;
  const msg = validateConfig(c).join(" ");
  assert.match(msg, /duplicate agent id/);
  assert.match(msg, /unknown department "Nowhere"/);
  assert.match(msg, /share the hangout/);
});

test("an agent may name the live sessions and the heartbeat file that give it work", () => {
  const c = example();
  c.agents[0].sessions = ["docs-fixer", "docs-*"];
  c.agents[0].heartbeat = "heartbeat/fixer.json";
  c.agents[1].heartbeat = "C:/elsewhere/scout.json"; // a heartbeat alone, no sessions
  assert.deepEqual(validateConfig(c), []);
});

test("sessions that are not a list of names, or a heartbeat that is not a path, is one line each", () => {
  for (const [key, bad, line] of [
    ["sessions", "docs-fixer", /^agent "builder" sessions must be a list of names$/],
    ["sessions", ["docs-fixer", 7], /^agent "builder" sessions must be a list of names$/],
    ["sessions", null, /^agent "builder" sessions must be a list of names$/],
    ["heartbeat", 7, /^agent "builder" heartbeat must be a file path$/],
    ["heartbeat", ["a.json"], /^agent "builder" heartbeat must be a file path$/],
    ["heartbeat", "", /^agent "builder" heartbeat must be a file path$/],
  ]) {
    const c = example();
    c.agents[0][key] = bad;
    const errs = validateConfig(c);
    assert.equal(errs.length, 1, `${key} = ${JSON.stringify(bad)}: ${errs.join("; ")}`);
    assert.match(errs[0], line);
  }
});

test("a relative heartbeat path resolves against the config file's folder; an absolute one stays", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-cfg-"));
  const c = example();
  c.agents[0].heartbeat = "beats/fixer.json";
  const abs = path.resolve(os.tmpdir(), "elsewhere", "scout.json");
  c.agents[1].heartbeat = abs;
  const named = path.join(dir, "demo.config.json");
  fs.writeFileSync(named, JSON.stringify(c));
  const loaded = loadConfig(os.tmpdir(), named); // the app folder is not the config's folder
  assert.equal(loaded.agents[0].heartbeat, path.join(dir, "beats", "fixer.json"));
  assert.equal(loaded.agents[1].heartbeat, abs);
  assert.equal(loaded.agents[2].heartbeat, undefined);
});

test("loadConfig prefers hq.config.json and falls back to the example; the app name defaults to the product name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-"));
  fs.copyFileSync(EXAMPLE, path.join(dir, "hq.config.example.json"));
  assert.equal(loadConfig(dir).appName, PRODUCT_NAME);
  fs.writeFileSync(path.join(dir, "hq.config.json"), JSON.stringify({ ...example(), appName: "Mine" }));
  assert.equal(loadConfig(dir).appName, "Mine");
});

test("a broken config names the file and the problem", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-"));
  fs.writeFileSync(path.join(dir, "hq.config.json"), JSON.stringify({ ...example(), departments: [] }));
  assert.throws(() => loadConfig(dir), /hq\.config\.json: .*at least one department/);
});

test("a named config file is the only one read: a missing one is an error, never a fallback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-cfg-"));
  fs.writeFileSync(path.join(dir, "hq.config.json"), JSON.stringify({ ...example(), appName: "Owner HQ" }));
  const named = path.join(dir, "demo.config.json");
  fs.writeFileSync(named, JSON.stringify({ ...example(), appName: "Demo" }));
  assert.equal(loadConfig(dir, named).appName, "Demo");
  assert.throws(() => loadConfig(dir, path.join(dir, "missing.json")), /ENOENT/);
  assert.equal(loadConfig(dir).appName, "Owner HQ"); // no file named: the default
});

test("control is true or false when given", () => {
  for (const control of [true, false, undefined]) assert.deepEqual(validateConfig({ ...example(), control }), [], String(control));
  for (const control of ["yes", 1, null]) assert.deepEqual(validateConfig({ ...example(), control }), ["control must be true or false"], String(control));
});

test("assistant is optional; given, it is an object whose voice, model, openers, Claude path and whisper folder are text when present", () => {
  const ok = [undefined, {}, { voiceId: "v1", ttsModel: "eleven_flash_v2_5", stripOpeners: ["Sure thing"], claude: "C:/bin/claude.exe", whisperDir: "C:/whisper" }];
  for (const assistant of ok) assert.deepEqual(validateConfig({ ...example(), assistant }), [], JSON.stringify(assistant));
  const MSG = 'assistant must be { "voiceId", "ttsModel", "claude", "whisperDir": text, "stripOpeners": a list of text }, each optional';
  for (const assistant of [null, true, [], { voiceId: 1 }, { ttsModel: "" }, { stripOpeners: "Sure thing" }, { stripOpeners: [1] }, { claude: 5 }, { whisperDir: 3 }, { other: "x" }])
    assert.deepEqual(validateConfig({ ...example(), assistant }), [MSG], JSON.stringify(assistant));
});

test("deploys is off unless set; given, it names a repo and a provider the wall can read", () => {
  const ok = [
    undefined,
    { repo: "acme/web" },
    { repo: "acme/web", branch: "release", provider: "vercel" },
    { repo: "acme/web", provider: "status", context: "netlify/acme/deploy-preview" },
    { repo: "acme/web", provider: "checks", check: "deploy", usualMinutes: 3 },
  ];
  for (const deploys of ok) assert.deepEqual(validateConfig({ ...example(), deploys }), [], JSON.stringify(deploys));
  const bad = [null, "acme/web", {}, { repo: "acme" }, { repo: "acme/web", provider: "heroku" }, { repo: "acme/web", provider: "checks" }, { repo: "acme/web", provider: "status", context: 'a"b' }, { repo: "acme/web", branch: "a b" }];
  for (const deploys of bad) assert.match(validateConfig({ ...example(), deploys }).join(" "), /^deploys must be/, JSON.stringify(deploys));
});

test("queue, systemDir and accountLabels are optional and checked when given", () => {
  const good = { queue: { repos: ["acme/web"], requiredChecks: ["build", "test"], mainBranch: "main" }, systemDir: "~/.claude/vibequarters", accountLabels: { k1aaaaaaaaaa: "Work", "k2-bbbbbbbb_c": "Personal" } };
  assert.deepEqual(validateConfig({ ...example(), ...good }), []);
  const cases = [
    [{ queue: { repos: ["acme"] } }, /^queue must be/],
    [{ queue: { requiredChecks: [""] } }, /^queue must be/],
    [{ queue: { other: 1 } }, /^queue must be/],
    [{ systemDir: "" }, /^systemDir must be a folder path$/],
    [{ systemDir: 3 }, /^systemDir must be a folder path$/],
    [{ accountLabels: { k1aaaaaaaaaa: "" } }, /^accountLabels must map/],
    [{ accountLabels: { "a b": "Work" } }, /^accountLabels must map/],
    [{ accountLabels: ["Work"] }, /^accountLabels must map/],
  ];
  for (const [extra, re] of cases) assert.match(validateConfig({ ...example(), ...extra }).join(" "), re, JSON.stringify(extra));
});
