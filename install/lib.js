// What install.js, uninstall.js, verify.js and doctor.js share: the packs, where things go, and the settings.json edits.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const MIN_CLAUDE = '2.1.287';
const MIN_NODE = 22;
const MANIFEST = 'install-manifest.json'; // in the system folder: everything the installer wrote
const PLUGIN_DIRS = 'CLAUDE_CODE_PLUGIN_DIRS';

const slash = (p) => String(p).replace(/\\/g, '/');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readBytes = (f) => { try { return fs.readFileSync(f); } catch (_e) { return null; } };

// ---------- packs ----------

const SH = 'Bash|PowerShell';
const EDIT = 'Edit|Write|MultiEdit';
const ACTS = '^(?!(Read|Grep|Glob)$).*';
// A hook row: [event, matcher (null = every call), file under the hooks folder, extra entry fields]
const PACKS = [
  {
    id: 'core', title: 'Core guards and continuity',
    what: 'blocks catastrophic commands, catches secrets and risky shell habits, stops runaway loops, keeps a resume point and recalls saved memory',
    hooks: [
      ['PreToolUse', `${SH}|Monitor`, 'guard-bash.js'],
      ['PreToolUse', `${EDIT}|Bash|PowerShell|Monitor`, 'guard-config.js'],
      ['PreToolUse', SH, 'guard-skillspector.js'],
      ['PreToolUse', 'Bash|PowerShell|Monitor', 'guard-shell-hygiene.js', { timeout: 30 }],
      ['PreToolUse', 'Edit|Write|MultiEdit|Bash|PowerShell', 'guard-comment-stripper.js'],
      ['PreToolUse', ACTS, 'guard-halt.js'],
      ['PreToolUse', 'Bash|PowerShell|Monitor|Edit|Write|MultiEdit|NotebookEdit|mcp__.*', 'guard-deny-catastrophic.js', { timeout: 90 }],
      ['PreToolUse', ACTS, 'guard-runaway.js'],
      ['PostToolBatch', SH, 'guard-shell-hygiene.js', { timeout: 30 }],
      ['PermissionDenied', SH, 'guard-shell-hygiene.js', { timeout: 30 }],
      ['PostToolUse', ACTS, 'loop-action-ledger.js'],
      ['Stop', null, 'loop-honesty-gate.js'],
      ['Stop', null, 'loop-spot.js', { timeout: 15, statusMessage: 'Saving spot...' }],
      ['PreCompact', null, 'loop-spot.js', { timeout: 15, statusMessage: 'Saving spot before compact...' }],
      ['PostCompact', null, 'loop-spot.js', { timeout: 15, statusMessage: 'Restoring spot...' }],
      ['SessionStart', null, 'loop-spot.js', { timeout: 15, statusMessage: 'Restoring spot...' }],
      ['UserPromptSubmit', null, 'loop-recall.js', { timeout: 10 }],
    ],
    commands: ['plan', 'execute'],
  },
  {
    id: 'coordination', title: 'Session coordination',
    what: 'several sessions on one machine share a board, own the files they edit, and take turns on merges, migrations and deploys',
    hooks: [
      ['PreToolUse', null, 'coord-guard.js', { timeout: 30 }],
      ['PostToolUse', SH, 'coord-guard.js', { timeout: 30 }],
      ['PostToolUseFailure', SH, 'coord-guard.js', { timeout: 30 }],
      ['PostToolBatch', SH, 'coord-guard.js', { timeout: 30 }],
      ['PermissionDenied', SH, 'coord-guard.js', { timeout: 30 }],
      ['SessionStart', null, 'coord-session.js', { timeout: 15, statusMessage: 'Joining session coordination...' }],
      ['SessionEnd', null, 'coord-session.js', { timeout: 15 }],
    ],
  },
  {
    id: 'merge-gate', title: 'Merge gate and /land',
    what: 'a merge into a live branch needs a fresh reviewer subagent to have passed its exact head; /land does it step by step (needs the gh CLI)',
    needs: ['coordination', 'core'],
    commands: ['land'],
  },
  {
    id: 'learning-loop', title: 'Learning loop',
    what: 'each project keeps its own lessons; /evolve distills a session into them, and they load at the next start',
    hooks: [
      ['SessionStart', null, 'loop-session-start.js', { statusMessage: 'Loading project lessons...' }],
      ['Stop', null, 'loop-session-stop.js'],
    ],
    commands: ['evolve', 'loop-init', 'loop-until', 'heartbeat'],
  },
  {
    id: 'app', title: 'VibeQuarters app hooks',
    what: 'starts the VibeQuarters app with Claude Code, opens its page, sends permission prompts there, and delivers messages typed there (answering needs "control": true in hq.config.json, which Full writes)',
    app: [
      ['SessionStart', null, 'launch.js'],
      ['PermissionRequest', '*', 'bridge/hq-bridge.js', { timeout: 900 }],
      ['PreToolUse', 'AskUserQuestion', 'bridge/hq-bridge.js', { timeout: 900 }],
      ['Stop', null, 'bridge/hq-inbox.js', { timeout: 86400, asyncRewake: true, shell: true }],
    ],
  },
  {
    id: 'companions', title: 'App companions',
    what: 'agent switches, the guard that keeps agents from answering for you, spend warnings, the plan usage line and keep-warm',
    hooks: [
      ['PreToolUse', null, 'guard-hq-answers.js'],
      ['PreToolUse', 'Agent|Task', 'hq-agent-switch.js'],
      ['SessionStart', 'startup|resume', 'usage-meter.js', { timeout: 10 }],
      ['UserPromptSubmit', null, 'usage-meter.js', { timeout: 10 }],
    ],
    mods: ['usage-line', 'hq-feed'],
  },
  {
    id: 'notify', title: 'Attention ping',
    what: 'a sound when a session waits for you, silenced with /mute',
    notify: true,
    commands: ['mute', 'unmute'],
  },
  {
    id: 'statusline', title: 'Status line',
    what: 'model, folder, git branch, session cost and a context warning under the prompt (an existing status line is replaced only when you say yes)',
    statusLine: true,
  },
  {
    id: 'windows', title: 'Windows shell checks', os: 'win32',
    what: 'denies a heredoc that Git Bash would corrupt (the Windows path checks of the core pack turn on by themselves)',
    hooks: [['PreToolUse', SH, 'guard-heredoc-backslash.js']],
  },
  {
    id: 'style', title: 'Style rules',
    what: 'no em dashes, no AI attribution in commits and pull requests, and a short Status / Next steps close on every reply',
    hooks: [
      ['PreToolUse', SH, 'guard-no-ai-attribution.js'],
      ['PreToolUse', 'Edit|Write|MultiEdit|Bash|PowerShell', 'guard-em-dash.js'],
      ['Stop', null, 'loop-reply-check.js'],
      ['UserPromptSubmit', null, 'loop-reply-check.js', { timeout: 10 }],
    ],
    replyShape: true,
  },
  {
    id: 'supabase', title: 'Supabase edge deploys',
    what: 'an edge function deploy ships exactly what is in your checkout, keeps a snapshot of the live one, and is probed after',
    hooks: [
      ['PreToolUse', 'mcp__.*__deploy_edge_function', 'guard-edge-deploy.js'],
      ['PostToolUse', 'mcp__.*__(?:get_edge_function|deploy_edge_function)', 'guard-edge-deploy.js', { timeout: 45 }],
    ],
  },
  {
    id: 'skills', title: 'Bundled skills',
    what: 'vibesec (secure-coding reference, Apache-2.0)',
    skills: ['vibesec'],
  },
];
const PRESETS = ['full', 'custom'];
const APPROVALS = [
  { id: 'ask-all', title: 'Ask me everything' },
  { id: 'safe-reads', title: 'Approve safe reads' },
  { id: 'routine', title: 'Approve routine coding work (recommended)' },
  { id: 'routine-judge', title: 'Routine plus an AI judge for the rest' },
];
// Official-marketplace plugins that work well with the rules; printed, never installed.
const PLUGINS = ['superpowers', 'pr-review-toolkit', 'frontend-design'];

const RECOMMENDED = 'routine'; // the approvals preset Full takes when nobody is asked

const sameDir = (a, b) => { const k = (d) => (process.platform === 'win32' ? path.resolve(d).toLowerCase() : path.resolve(d)); return k(a) === k(b); };

// True when a command line runs and exits 0 (its output is thrown away)
const runs = (cmd) => spawnSync(cmd, { shell: true, stdio: 'ignore', timeout: 20000, windowsHide: true }).status === 0;

const packById = (id) => PACKS.find((p) => p.id === id);
const fitsOs = (p, platform = process.platform) => !p.os || p.os === platform;
const fullPacks = (platform = process.platform) => PACKS.filter((p) => fitsOs(p, platform)).map((p) => p.id);

// The chosen packs plus what they need, in pack order; throws on an unknown id.
function resolvePacks(ids, platform = process.platform) {
  const want = new Set();
  const add = (id) => {
    const p = packById(id);
    if (!p) throw new Error(`unknown pack "${id}" (packs: ${PACKS.map((x) => x.id).join(', ')})`);
    if (!fitsOs(p, platform) || want.has(id)) return;
    want.add(id);
    for (const n of p.needs || []) add(n);
  };
  for (const id of ids) add(id);
  return PACKS.filter((p) => want.has(p.id)).map((p) => p.id);
}

// ---------- paths ----------

function paths(opts = {}) {
  const home = path.resolve(opts.home || os.homedir());
  const claude = path.join(home, '.claude');
  const config = path.join(claude, 'vibequarters.config.json');
  let systemDir = opts.dir ? path.resolve(opts.dir) : null;
  if (!systemDir) {
    try {
      const s = JSON.parse(fs.readFileSync(config, 'utf8')).systemDir;
      if (typeof s === 'string' && s) systemDir = path.resolve(s.replace(/^~(?=$|[\\/])/, home));
    } catch (_e) { /* no config yet */ }
  }
  systemDir = systemDir || path.join(claude, 'vibequarters');
  return {
    home, claude, config, systemDir,
    settings: path.join(claude, 'settings.json'),
    claudeMd: path.join(claude, 'CLAUDE.md'),
    salt: path.join(claude, 'vibequarters.salt'),
    usage: path.join(claude, 'vibequarters-usage'),
    manifest: path.join(systemDir, MANIFEST),
    settingsBefore: path.join(systemDir, 'before', 'settings.json'), // what these two held before the install
    configBefore: path.join(systemDir, 'before', 'vibequarters.config.json'),
  };
}
// A path under the home folder written with ~, so a config or import line names no user folder.
function tilde(p, home) {
  const rel = path.relative(home, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${slash(rel)}` : slash(p);
}

// ---------- hook entries ----------

// Every { event, group } the chosen packs add to settings.json. Absolute forward-slash args, so no shell expands them.
function hookGroups(packIds, { systemDir, appDir }) {
  const out = [];
  for (const id of packIds) {
    const p = packById(id);
    for (const [event, matcher, file, extra] of p.hooks || []) out.push(group(event, matcher, `${slash(systemDir)}/hooks/${file}`, [], extra));
    for (const [event, matcher, file, extra] of appDir ? p.app || [] : []) out.push(group(event, matcher, `${slash(appDir)}/${file}`, [], extra));
    if (p.notify) {
      const f = `${slash(systemDir)}/notify/notify.js`;
      out.push(group('Stop', null, f, ['ping'], { timeout: 10 }));
      out.push(group('Notification', null, f, ['ping'], { timeout: 10 }));
      out.push(group('UserPromptSubmit', null, f, ['clear'], { timeout: 10 }));
    }
  }
  return out;
}
function group(event, matcher, file, args, extra = {}) {
  const { shell, ...fields } = extra;
  // asyncRewake hooks are written as one command line; the quoted path holds in every shell.
  const entry = shell ? { type: 'command', command: `node "${file}"`, ...fields } : { type: 'command', command: 'node', args: [file, ...args], ...fields };
  return { event, group: { ...(matcher === null ? {} : { matcher }), hooks: [entry] } };
}

// ---------- settings.json ----------

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Parsed settings with how they were written (indent, newline, BOM), so a rewrite keeps the user's formatting.
function parseSettings(bytes) {
  if (bytes === null) return { json: {}, style: { indent: 2, eol: '\n', bom: false, end: '\n' } };
  const raw = bytes.toString('utf8');
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  const json = text.trim() ? JSON.parse(text) : {};
  if (!isPlain(json)) throw new Error('settings.json does not hold a JSON object');
  if (json.hooks !== undefined && !isPlain(json.hooks)) throw new Error('settings.json "hooks" is not an object');
  if (json.env !== undefined && !isPlain(json.env)) throw new Error('settings.json "env" is not an object');
  for (const [k, v] of Object.entries(json.hooks || {})) if (!Array.isArray(v)) throw new Error(`settings.json "hooks.${k}" is not a list`);
  const ind = /\n([ \t]+)"/.exec(text);
  return { json, style: { indent: ind ? ind[1] : 2, eol: text.includes('\r\n') ? '\r\n' : '\n', bom, end: /\n$/.test(text) ? '\n' : '' } };
}
function printSettings(json, style) {
  let t = JSON.stringify(json, null, style.indent) + style.end;
  if (style.eol === '\r\n') t = t.replace(/\r?\n/g, '\r\n');
  return Buffer.from((style.bom ? String.fromCharCode(0xfeff) : '') + t, 'utf8');
}

// True when the user's group already runs the same file on the same matcher, however its command is written.
function runsSame(have, g) {
  if (!isPlain(have) || !Array.isArray(have.hooks) || (have.matcher || '*') !== (g.matcher || '*')) return false;
  const texts = (h) => (h ? [h.command, ...(Array.isArray(h.args) ? h.args : [])].filter((s) => typeof s === 'string').map((s) => slash(s).toLowerCase()) : []);
  const file = texts(g.hooks[0]).map((s) => s.replace(/^node "(.*)"$/, '$1')).find((s) => s.includes('/'));
  return have.hooks.some((h) => texts(h).some((s) => s === file || s.split(/["'\s]+/).includes(file) || s.includes(`"${file}"`)));
}

const sep = (platform = process.platform) => (platform === 'win32' ? ';' : ':');

// The settings with VibeQuarters' entries added, and exactly what was added (for uninstall). Never removes, reorders or
// changes anything the user has; a hook entry the user already has is not added again.
function addTo(json, { groups, pluginDirs, statusLine }) {
  const next = structuredClone(json);
  const added = { groups: [], createdHooks: false, createdEvents: [], pluginDirs: [], createdEnv: false, createdPluginDirs: false, statusLine: null };
  if (groups.length && next.hooks === undefined) { next.hooks = {}; added.createdHooks = true; }
  for (const { event, group: g } of groups) {
    if (next.hooks[event] === undefined) { next.hooks[event] = []; added.createdEvents.push(event); }
    if (next.hooks[event].some((x) => runsSame(x, g))) continue;
    next.hooks[event].push(g);
    added.groups.push({ event, group: g });
  }
  if (pluginDirs.length) {
    if (next.env === undefined) { next.env = {}; added.createdEnv = true; }
    const cur = typeof next.env[PLUGIN_DIRS] === 'string' ? next.env[PLUGIN_DIRS] : null;
    const have = cur ? cur.split(sep()).filter(Boolean) : [];
    if (cur === null) added.createdPluginDirs = true;
    for (const d of pluginDirs) if (!have.some((x) => slash(x) === slash(d))) { have.push(slash(d)); added.pluginDirs.push(slash(d)); }
    next.env[PLUGIN_DIRS] = have.join(sep());
  }
  if (statusLine && !equal(next.statusLine, statusLine)) {
    added.statusLine = { before: next.statusLine === undefined ? null : next.statusLine, after: statusLine };
    next.statusLine = statusLine;
  }
  return { next, added };
}

// The settings with only VibeQuarters' entries taken out: the entries `added` records, plus (for a settings file edited
// since) any hook that runs a file under the system folder.
function removeFrom(json, added, systemDir) {
  const next = structuredClone(json);
  const root = `${slash(systemDir)}/`.toLowerCase();
  const runsOurs = (h) => [h && h.command, ...((h && Array.isArray(h.args) && h.args) || [])].some((s) => typeof s === 'string' && slash(s).toLowerCase().includes(root));
  const ours = added.groups.map(({ event, group: g }) => [event, g.hooks[0]]);
  for (const [event, list] of Object.entries(next.hooks || {})) {
    const out = [];
    for (const g of list) {
      if (!isPlain(g) || !Array.isArray(g.hooks)) { out.push(g); continue; }
      const hooks = g.hooks.filter((h) => !runsOurs(h) && !ours.some(([e, o]) => e === event && equal(o, h)));
      if (hooks.length === g.hooks.length) out.push(g);
      else if (hooks.length) out.push({ ...g, hooks });
    }
    if (out.length !== list.length || out.some((g, i) => g !== list[i])) next.hooks[event] = out;
    if (!out.length && added.createdEvents.includes(event)) delete next.hooks[event];
  }
  if (added.createdHooks && isPlain(next.hooks) && !Object.keys(next.hooks).length) delete next.hooks;
  if (isPlain(next.env) && typeof next.env[PLUGIN_DIRS] === 'string') {
    const mine = new Set(added.pluginDirs.map((d) => d.toLowerCase()));
    const kept = next.env[PLUGIN_DIRS].split(sep()).filter((d) => d && !mine.has(slash(d).toLowerCase()) && !slash(d).toLowerCase().startsWith(root));
    if (!kept.length && added.createdPluginDirs) delete next.env[PLUGIN_DIRS];
    else next.env[PLUGIN_DIRS] = kept.join(sep());
    if (added.createdEnv && !Object.keys(next.env).length) delete next.env;
  }
  if (added.statusLine && equal(next.statusLine, added.statusLine.after)) {
    if (added.statusLine.before === null) delete next.statusLine;
    else next.statusLine = added.statusLine.before;
  }
  return next;
}

// ---------- safe writes ----------

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
// The file a write lands on: a symlinked settings.json (a dotfiles folder) keeps its link.
const landsOn = (f) => { try { return fs.realpathSync(f); } catch (_e) { return f; } };

// Writes `bytes` to `file` the careful way: refuse when it no longer holds `expected` (null = it must not exist), keep a
// dated backup, write a temp file beside it, rename, read it back; on a bad read put the old bytes back. Returns the
// backup path (null when there was no file).
function writeGuarded(file, bytes, expected, { backup = true } = {}) {
  const target = landsOn(file);
  const now = readBytes(target);
  if ((now === null) !== (expected === null) || (now && !now.equals(expected))) throw new Error(`${file} changed while the installer was running; nothing was written to it. Run it again.`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let bak = null;
  if (now && backup) {
    bak = `${target}.vibequarters-backup-${stamp()}`;
    for (let i = 2; fs.existsSync(bak); i++) bak = `${target}.vibequarters-backup-${stamp()}-${i}`;
    fs.writeFileSync(bak, now);
  }
  const tmp = `${target}.vibequarters-tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, bytes, now ? { mode: fs.statSync(target).mode } : {});
    fs.renameSync(tmp, target);
    const back = readBytes(target);
    if (!back || !back.equals(bytes)) throw new Error(`${file} does not read back as written`);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* renamed or never made */ }
    if (now) { const cur = readBytes(target); if (!cur || !cur.equals(now)) fs.writeFileSync(target, now); }
    throw e;
  }
  return bak;
}

// CLAUDE.md without the one line the installer added (and the newline it put before it).
function withoutImport(bytes, rec) {
  const text = bytes.toString('utf8');
  const i = text.lastIndexOf(rec.line);
  if (i === -1 || (i > 0 && text[i - 1] !== '\n')) return bytes;
  const end = /^\r?\n/.exec(text.slice(i + rec.line.length));
  if (!end && i + rec.line.length !== text.length) return bytes;
  let head = text.slice(0, i);
  const tail = text.slice(i + rec.line.length + (end ? end[0].length : 0));
  if (rec.joint && !tail && head.endsWith(rec.joint)) head = head.slice(0, -rec.joint.length);
  return Buffer.from(head + tail, 'utf8');
}

// ---------- files ----------

// Removes `dir` and then its parents while they are empty, up to (not including) a folder in `stops`.
function pruneUp(dir, stops) {
  const stop = new Set(stops.map((d) => path.resolve(d)));
  for (let d = path.resolve(dir); !stop.has(d) && d !== path.dirname(d); d = path.dirname(d)) {
    try { fs.rmdirSync(d); } catch (_e) { return; }
  }
}

// The files the installer copies, as [from, path inside the system folder]. Tests stay in the clone.
function systemFiles(repo = REPO) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!/^(tests|node_modules)$/.test(e.name)) walk(path.join(d, e.name), r); }
      else if (!/\.test\.(js|ts|mjs)$/.test(e.name)) out.push([path.join(d, e.name), r]);
    }
  };
  walk(path.join(repo, 'system'), '');
  if (fs.existsSync(path.join(repo, 'pricing.js'))) out.push([path.join(repo, 'pricing.js'), 'lib/pricing.js']);
  for (const f of ['lib.js', 'uninstall.js', 'verify.js', 'doctor.js']) out.push([path.join(repo, 'install', f), `install/${f}`]);
  return out;
}

function readManifest(p) {
  try {
    const m = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
    return m && m.v === 1 ? m : null;
  } catch (_e) { return null; }
}

// While an install runs, the manifest holds what it plans and, under pending, what the version before left, so a file, a
// settings.json or a config at either stage is known as the installer's.
const ourSha = (m, f, hash) => !!m && (m.files[f] === hash || (((m.pending || {}).files || {})[f] || []).includes(hash));
const ourBytes = (m, key, hash) => !!m && (m[key].afterSha === hash || ((m.pending || {})[key] || []).includes(hash));
const ourFiles = (m) => [...new Set([...Object.keys((m && m.files) || {}), ...Object.keys((m && m.pending && m.pending.files) || {})])];
function pendingOf(old) {
  if (!old) return {};
  const files = {};
  for (const f of ourFiles(old)) files[f] = [...new Set([...(((old.pending || {}).files || {})[f] || []), ...(old.files[f] ? [old.files[f]] : [])])];
  const of = (key) => [...new Set([...((old.pending || {})[key] || []), old[key].afterSha])];
  return { files, settings: of('settings'), config: of('config') };
}

// What `claude --version` prints, or null when Claude Code is not on the PATH.
function claudeVersion() {
  const r = spawnSync('claude --version', { shell: true, encoding: 'utf8', timeout: 20000, windowsHide: true });
  return r.status === 0 && /\d+\.\d+\.\d+/.test(r.stdout) ? r.stdout.trim() : null;
}

// "2.1.287 (Claude Code)" at or above the minimum: true, false, or null when it cannot be read
function versionOk(text, min = MIN_CLAUDE) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  if (!m) return null;
  const a = m.slice(1).map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// --flag value, --flag=value and bare --flag, or an error naming what is not known
function parseArgs(argv, known) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m || !(m[1] in known)) throw new Error(`unknown argument ${argv[i]} (known: ${Object.keys(known).map((k) => `--${k}`).join(', ')})`);
    if (known[m[1]] === 'flag') { out[m[1]] = m[2] === undefined ? true : m[2] !== 'false'; continue; }
    const v = m[2] !== undefined ? m[2] : argv[++i];
    if (v === undefined || (m[2] === undefined && v.startsWith('--'))) throw new Error(`--${m[1]} needs a value`);
    out[m[1]] = v;
  }
  return out;
}

module.exports = {
  REPO, MIN_CLAUDE, MIN_NODE, MANIFEST, PLUGIN_DIRS, PACKS, PRESETS, APPROVALS, RECOMMENDED, PLUGINS, sameDir, runs, slash, sha, readBytes, packById,
  fitsOs, fullPacks, resolvePacks, paths, tilde, hookGroups, parseSettings, printSettings, addTo, removeFrom, stamp,
  writeGuarded, withoutImport, pruneUp, systemFiles, readManifest, ourSha, ourBytes, ourFiles, pendingOf, landsOn, claudeVersion, versionOk, parseArgs, equal, isPlain, sep,
};
