// Loads hq.config.json (the only place identity lives), falling back to the neutral example.
// The floor has room for 6 departments of 5 desks, so anything beyond that is an error.
const fs = require("fs");
const path = require("path");
const { deploySource } = require("./lib/deploys");
const { KEY } = require("./lib/accounts");
// The product's name, in this one place: the page title and header use it unless a config sets appName.
const PRODUCT_NAME = "VibeQuarters";
const MAX_DEPTS = 6;
const MAX_PER_DEPT = 5;

const TEXT_KEYS = ["voiceId", "ttsModel", "claude", "whisperDir"];
const validAssistant = (a) =>
  !!a && typeof a === "object" && !Array.isArray(a) &&
  Object.keys(a).every((k) => TEXT_KEYS.includes(k) || k === "stripOpeners") &&
  TEXT_KEYS.every((k) => a[k] === undefined || (typeof a[k] === "string" && a[k] !== "")) &&
  (a.stripOpeners === undefined || (Array.isArray(a.stripOpeners) && a.stripOpeners.every((s) => typeof s === "string")));

const isList = (v, ok) => Array.isArray(v) && v.every(ok);
const validQueue = (q) =>
  !!q && typeof q === "object" && !Array.isArray(q) &&
  Object.keys(q).every((k) => ["repos", "requiredChecks", "mainBranch"].includes(k)) &&
  (q.repos === undefined || isList(q.repos, (r) => typeof r === "string" && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(r))) &&
  (q.requiredChecks === undefined || isList(q.requiredChecks, (r) => typeof r === "string" && r.length > 0 && r.length <= 100)) &&
  (q.mainBranch === undefined || (typeof q.mainBranch === "string" && /^[\w./-]{1,100}$/.test(q.mainBranch)));
const validLabels = (l) =>
  !!l && typeof l === "object" && !Array.isArray(l) &&
  Object.entries(l).every(([k, v]) => KEY.test(k) && typeof v === "string" && v.trim().length > 0 && v.length <= 40);

function validateConfig(c) {
  if (!c || typeof c !== "object") return ["the config is not a JSON object"];
  const errs = [];
  if (c.appName !== undefined && !(typeof c.appName === "string" && c.appName.trim())) errs.push("appName must be text when set");
  if (typeof c.planUsd !== "number" || c.planUsd < 0) errs.push("planUsd must be a number");
  const depts = Array.isArray(c.departments) ? c.departments : [];
  if (!depts.length) errs.push("departments must list at least one department");
  if (depts.length > MAX_DEPTS) errs.push(`at most ${MAX_DEPTS} departments fit the floor (got ${depts.length})`);
  const names = new Set(depts.map((d) => d.name));
  if (names.size !== depts.length) errs.push("department names must be unique");
  const ids = new Set();
  const hangouts = new Map();
  const per = {};
  for (const a of Array.isArray(c.agents) ? c.agents : []) {
    if (!a.id) { errs.push("every agent needs an id"); continue; }
    if (ids.has(a.id)) errs.push(`duplicate agent id "${a.id}"`);
    ids.add(a.id);
    if (!names.has(a.dept)) errs.push(`agent "${a.id}" names unknown department "${a.dept}"`);
    per[a.dept] = (per[a.dept] || 0) + 1;
    if (a.hangout && hangouts.has(a.hangout)) errs.push(`agents "${hangouts.get(a.hangout)}" and "${a.id}" share the hangout "${a.hangout}"`);
    if (a.hangout) hangouts.set(a.hangout, a.id);
    // work that is not a subagent: live sessions by name (exact, or a trailing *), and a heartbeat file
    if (a.sessions !== undefined && !(Array.isArray(a.sessions) && a.sessions.every((p) => typeof p === "string"))) errs.push(`agent "${a.id}" sessions must be a list of names`);
    if (a.heartbeat !== undefined && !(typeof a.heartbeat === "string" && a.heartbeat)) errs.push(`agent "${a.id}" heartbeat must be a file path`);
  }
  for (const d in per) if (per[d] > MAX_PER_DEPT) errs.push(`department "${d}" has ${per[d]} agents; its room holds ${MAX_PER_DEPT} desks`);
  if (!Array.isArray(c.sessionAvatars) || !c.sessionAvatars.length) errs.push("sessionAvatars must list at least one look");
  // HQ answers what a chat asks only with control on; off or absent, it stays read-only
  if (c.control !== undefined && typeof c.control !== "boolean") errs.push("control must be true or false");
  // the AI judge for an approve window's middle tier (lib/judge.js, the owner's own Claude login); off unless true
  if (c.judge !== undefined && typeof c.judge !== "boolean") errs.push("judge must be true or false");
  // the HQ assistant (on only with control on and this key): its ElevenLabs voice and model, the openers its spoken text
  // drops, the Claude CLI to run when it is not the npm install's, and the local whisper.cpp folder for hearing
  if (c.assistant !== undefined && !validAssistant(c.assistant))
    errs.push('assistant must be { "voiceId", "ttsModel", "claude", "whisperDir": text, "stripOpeners": a list of text }, each optional');
  // where the system pack is installed (its hooks and approval presets); default ~/.claude/vibequarters
  if (c.systemDir !== undefined && !(typeof c.systemDir === "string" && c.systemDir.trim())) errs.push("systemDir must be a folder path");
  // the deploy wall (lib/deploys.js): off unless set
  if (c.deploys !== undefined && !deploySource(c.deploys))
    errs.push('deploys must be { "repo": "owner/name", "branch": "main", "provider": "vercel" | "status" | "checks", "context": the status name (status), "check": the check name (checks), "usualMinutes": a number }, branch, provider, context and usualMinutes optional');
  // the Queue panel's GitHub side (lib/queue.js)
  if (c.queue !== undefined && !validQueue(c.queue))
    errs.push('queue must be { "repos": a list of "owner/name", "requiredChecks": a list of check names, "mainBranch": text }, each optional');
  // the accounts strip's names (lib/accounts.js): the usage-line mod's account key -> a short label
  if (c.accountLabels !== undefined && !validLabels(c.accountLabels))
    errs.push("accountLabels must map each account key the usage-line mod writes to a label of 1 to 40 characters");
  return errs;
}

// With a named file (a copy's own config), exactly that file is read: no fallback to the owner's.
// A relative heartbeat path resolves against the config file's own folder.
function loadConfig(dir = __dirname, file = null) {
  const own = path.join(dir, "hq.config.json");
  if (!file) file = fs.existsSync(own) ? own : path.join(dir, "hq.config.example.json");
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  const errs = validateConfig(c);
  if (errs.length) throw new Error(`${path.basename(file)}: ${errs.join("; ")}`);
  for (const a of c.agents || []) if (a.heartbeat) a.heartbeat = path.resolve(path.dirname(file), a.heartbeat);
  if (!c.appName) c.appName = PRODUCT_NAME;
  return c;
}

module.exports = { loadConfig, validateConfig, MAX_DEPTS, MAX_PER_DEPT, PRODUCT_NAME };
