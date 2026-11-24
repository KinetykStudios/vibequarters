// vibequarters :: shared settings, not a hook
// Every hook reads its tunable values here: ~/.claude/vibequarters.config.json (VIBEQUARTERS_CONFIG names another file) laid
// over the defaults below, key by key. A plain object merges into its default; a list or a value replaces it. A missing,
// unreadable or broken file means the defaults. NEVER THROWS: a hook that cannot read its settings runs on the defaults.
// system/config/vibequarters.config.example.json documents every key.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Commands and MCP tools that take a coordination lock. One row per trigger: `shell` is a regular expression matched
// against the runnable part of a shell command, `tool` one matched against an MCP tool name. `deployGate: true` also runs
// the production deploy gate (guard-deny-catastrophic.js) and the stale-deploy check (coord-guard.js) on a shell match;
// `watchPaths` are folders whose uncommitted changes block that deploy. The `merge` lock is always taken by
// `gh pr merge` (built in, since the merge gate reads its arguments) and needs no row.
const LOCKS = [
  { lock: 'db-migration', shell: String.raw`\bsupabase\s+(?:db\s+push|migration\s+up)\b`, tool: String.raw`__apply_migration$` },
  { lock: 'edge-deploy', shell: String.raw`\bsupabase\s+functions\s+deploy\b`, tool: String.raw`__deploy_edge_function$`, deployGate: true, watchPaths: ['supabase/functions'] },
  { lock: 'prod-deploy', shell: String.raw`\bvercel\b[^;&|\n]*\s(?:--prod\b|--target[= ]production\b)`, deployGate: true },
  { lock: 'prod-deploy', tool: String.raw`__deploy_to_vercel$` },
  { lock: 'prod-deploy', shell: String.raw`\bnetlify\s+deploy\b[^;&|\n]*\s--prod\b`, deployGate: true },
  { lock: 'prod-deploy', shell: String.raw`\bfly(?:ctl)?\s+deploy\b`, deployGate: true },
];

const DEFAULTS = {
  // Where the installer copied the system (hooks, commands, rules). The VibeQuarters app reads this key too.
  systemDir: '~/.claude/vibequarters',
  // The VibeQuarters app's folder and the folder it keeps its runtime files in ('' = the app folder). Empty when the app
  // is not installed: the hooks that read it then do nothing.
  appDir: '',
  appStateDir: '',
  coordination: {
    liveHours: 72, // a session unseen this long no longer counts as live
    lockMinutes: 20, // migration, deploy and merge locks expire after this
    gcDays: 14, // sessions unseen this long are forgotten
    requestGcDays: 7, // requests (and their patch files) this old are forgotten
    forceHandoffMinutes: 15, // an unanswered request may be force-handed after this
    // Sessions named <fixerPrefix> or <fixerPrefix>-<anything> cannot merge: `coord.js ship` opens one fresh /land tab
    // per PR for them instead. '' turns the feature off.
    fixerPrefix: '',
    // How a fixer's /land tab opens: 'vscode' (the `code` CLI with a vscode://anthropic.claude-code/open URL) or 'none'.
    landTabOpener: 'vscode',
  },
  locks: LOCKS,
  mergeGate: {
    // "owner/repo": ["check name", ...]: the CI checks that prove a repo's tests. A repo not listed falls back to its
    // branch protection's required checks (readBranchProtection), else it has none and a merge or deploy asks the user.
    requiredChecks: {},
    readBranchProtection: true,
    // "owner/repo" entries whose PRs reach the default branch only inside a tested batch (merge-batch.js).
    batchRepos: [],
    // For a batch of several PRs on a Vercel project, main's vercel.json must skip [batch-part] commits
    // (system/templates/vercel-ignore-build.mjs). 'vercel' checks for it; 'none' skips the check.
    batchIgnoreCheck: 'vercel',
    // When true, merge-batch.js build refuses a PR whose body lacks a "Ships alone: ..." or
    // "Update: <name> part <k> of <n>" line, and a batch missing a part of an update.
    requirePrDeclaration: false,
    // A merge into a live branch needs a clean fresh review of its exact head (/land step 2). The installer sets this to
    // false when the merge-gate pack is not chosen; the CI, --admin/--auto and mass-delete checks stay on either way.
    requireReview: true,
    // The model the fresh reviewer subagent must have run on (matched as a regular expression, any case). '' accepts any.
    reviewerModel: 'opus',
    liveBranches: ['main', 'master'], // a PR into one of these is going live
    protectedBranches: ['main', 'master', 'release/*'], // deleting one of these on the remote is denied
    ghBudgetMs: 40000, // every GitHub read of one guard call shares this budget
  },
  massDelete: {
    fileLimit: 10,
    projectDirs: ['src', 'supabase', 'public', 'scripts', 'test', 'tests', 'docs', 'migrations', '.git'],
  },
  hygiene: {
    // Shapes of secrets that must never be typed into a command (regular expressions).
    tokenPatterns: [
      String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}`,
      String.raw`\bgithub_pat_[A-Za-z0-9_]{40,}`,
      String.raw`\bsbp_(?:v0_)?[A-Za-z0-9]{32,}`,
      String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}`,
      String.raw`\bsk_live_[A-Za-z0-9]{20,}`,
      String.raw`\bAKIA[0-9A-Z]{16}\b`,
    ],
    heavyMaxCpu: 75, // a heavy job starts only under this total CPU percent
    inlineMaxLines: 5,
  },
  usage: {
    stepUsd: 150, // say so each time a session passes another multiple of this (API-equivalent dollars)
    compactions: 8, // and each time it compacts this many more times
    idleMinutes: 60, // and when it wakes after this long idle
    contextTokens: 250000, // holding at least this much context
  },
  loop: {
    // A project folder whose learning loop the loop hooks fall back to when the session's own project has none. '' = none.
    defaultProject: '',
    // true: a session that leaves lessons behind has the next one run /evolve by itself at a quiet moment. false: it only
    // says so. The installer asks.
    autoEvolve: false,
  },
  skillspector: {
    // The command that statically scans a skill, MCP server or plugin folder, shown in the reminder; '{dir}' is the folder.
    scanCommand: '',
  },
  edgeDeploy: {
    origin: 'http://localhost:3000', // the Origin header of the boot probe's CORS preflight
    functionsDir: 'supabase/functions',
    snapshotDir: '~/.claude/edge-snapshots',
  },
  notify: {
    intervalSeconds: 30,
    count: 0, // 0: five pings on Windows (quiet while a terminal has the focus), one on macOS and Linux
  },
  // The two below are read by the mods (system/mods), not by the hooks.
  usageLine: { warnFrom: 50 }, // percent of the plan week used before the line says when it runs out
  hqFeed: {
    cacheMinutes: 60, // how long the prompt cache lives
    pingAtMinutes: 50, // an idle chat's cache this old gets a keep-warm ping (only while its switch is on)
    tickSeconds: 120, // how often the switch and the cache's age are checked
    maxPings: 24, // then it stops by itself
    brakeModel: 'opus', // subagents on a model matching this (a regular expression) count toward the spend brake
    brakeFree: 3, // that many of them a turn starts before the brake asks
    pingText: 'Keep-alive ping from VibeQuarters to hold the prompt cache. Reply with the single word: ok',
  },
  land: {
    // Where /land puts its worktrees: <worktreeRoot>/wt-land-<repo>-<pr>. A clone of the repo is looked for under
    // cloneRoot/<repo> first.
    cloneRoot: '~',
    worktreeRoot: '~',
    // Optional live check after a merge: 'none', 'vercel' (the commit status named deployContext), or 'github' (a
    // deployment status).
    deployCheck: 'none',
    deployContext: 'Vercel',
  },
};

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Objects merge key by key. A value of another kind where the default is an object or a list keeps the default, so a
// null cannot crash the guard that reads it.
function merge(base, over) {
  if (!isPlain(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (isPlain(base[k])) out[k] = merge(base[k], v);
    else if (Array.isArray(v) || !Array.isArray(base[k])) out[k] = v;
  }
  return out;
}

const file = () => process.env.VIBEQUARTERS_CONFIG || path.join(os.homedir(), '.claude', 'vibequarters.config.json');

let cache = { file: null, mtimeMs: -1, value: null };
// The settings, read again only when the file's time changed.
function load() {
  const f = file();
  let st = null;
  try { st = fs.statSync(f); } catch (_e) { /* no file: the defaults */ }
  const mtimeMs = st ? st.mtimeMs : -1;
  if (cache.value && cache.file === f && cache.mtimeMs === mtimeMs) return cache.value;
  let user = {};
  if (st) {
    try { user = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_e) { user = {}; }
  }
  cache = { file: f, mtimeMs, value: merge(DEFAULTS, user) };
  return cache.value;
}

// A path from the settings with a leading ~ made the home folder; '' stays ''.
function expand(p) {
  const s = String(p || '');
  if (!s) return '';
  return path.resolve(s.replace(/^~(?=$|[\\/])/, os.homedir()));
}

// A regular expression from a settings string, or null when it does not compile.
function regex(src, flags = 'i') {
  try { return src ? new RegExp(String(src), flags) : null; } catch (_e) { return null; }
}

// The lock rows, each with its expressions compiled; a row that does not compile is skipped.
function lockRows() {
  const rows = Array.isArray(load().locks) ? load().locks : LOCKS;
  return rows.filter((r) => r && typeof r.lock === 'string' && /^[\w-]+$/.test(r.lock)).map((r) => ({
    lock: r.lock,
    shell: regex(r.shell),
    tool: regex(r.tool),
    deployGate: r.deployGate === true,
    watchPaths: Array.isArray(r.watchPaths) ? r.watchPaths.filter((p) => typeof p === 'string' && p) : [],
  }));
}

// True when a branch name matches one of the patterns (a trailing /* matches anything below that prefix).
function branchIn(name, patterns) {
  const n = String(name || '');
  return (Array.isArray(patterns) ? patterns : []).some((p) => {
    const s = String(p);
    return s.endsWith('/*') ? n.startsWith(s.slice(0, -1)) && n.length > s.length - 1 : n === s;
  });
}

// The app's runtime folder, or '' when the app is not installed.
function appState() {
  const c = load();
  return expand(c.appStateDir) || expand(c.appDir);
}

module.exports = { DEFAULTS, load, expand, regex, lockRows, branchIn, appState, file };
