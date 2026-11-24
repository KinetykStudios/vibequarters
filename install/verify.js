#!/usr/bin/env node
// Runs every installed VibeQuarters hook, exactly as settings.json registers it, on a real payload and checks the answer.
//
//   node "$HOME/.claude/vibequarters/install/verify.js" [--home <dir>] [--dir <system folder>]
//
// Each check has a negative control: a payload the same hook must let through. The checker is checked too: a hook that
// answers nothing must fail it. Everything runs in a throwaway home folder, so your board, memory and app are not
// touched; the app's own hooks (which would reach a running app) are only checked to load. Exit 0 = every check passed.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./lib');

const SID = '00000000-0000-4000-8000-000000000001';
const PORT = 18747; // the port the throwaway app folder says its app is on; nothing listens there
const pre = (tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input });
const bash = (command) => pre('Bash', { command });
const write = (file_path, content) => pre('Write', { file_path, content });
const stop = (last_assistant_message) => ({ hook_event_name: 'Stop', last_assistant_message });
const deployFn = (content) => pre('mcp__supabase__deploy_edge_function', { name: 'fn', entrypoint_path: 'fn/index.ts', files: [{ name: 'fn/index.ts', content }] });
// A secret-shaped string, put together here so no whole one sits in this file
const FAKE_TOKEN = ['gh', 'p_', 'A1b2'.repeat(9)].join('');
const DASH = String.fromCharCode(0x2014);
const STRIPPER = ['src.replace(/', '\\/\\*', '[\\s\\S]*?', '\\*\\/', '/g, "")'].join('');

const put = (dir, name, text) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
const memory = (home, work) => path.join(home, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), 'memory', 'loop');
const runState = (recent) => (h, w) => put(memory(h, w), 'RUNSTATE.json', JSON.stringify({ actions: 9, recent }));
// True once `f` exists (up to 10 s: a background process writes it)
function waitFor(f) {
  const idle = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) Atomics.wait(idle, 0, 0, 100);
  return fs.existsSync(f);
}
const registryFile = (h) => path.join(h, '.claude', 'coordination', 'registry.json');
const registered = (h) => fs.existsSync(registryFile(h)) && /"name":\s*"verify"/.test(fs.readFileSync(registryFile(h), 'utf8'));
const replyNote = (h) => path.join(h, '.claude', 'cache', 'reply-check', `${SID}.txt`);

// file -> checks: { event, setup(home, work), payload(work, systemDir), want, control, controlSetup, controlWant }. want is
// a permission decision, or a function of (stdout, home, work) that returns true.
const CHECKS = {
  'guard-bash.js': [{ event: 'PreToolUse', payload: () => bash('gh run rerun 1'), want: 'ask', control: () => bash('gh run list') }],
  'guard-config.js': [{ event: 'PreToolUse', payload: (w) => write(path.join(w, '.eslintrc.json'), '{}'), want: 'ask', control: (w) => write(path.join(w, 'app.js'), '1') },
    { event: 'PreToolUse', payload: (w) => bash(`cp x.json "${L.slash(path.dirname(w))}/.claude/settings.json"`), want: 'ask', control: (w) => bash(`cp "${L.slash(path.dirname(w))}/.claude/settings.json" x.json`) }],
  'guard-skillspector.js': [{ event: 'PreToolUse', payload: () => bash('claude mcp add demo -- node server.js'), want: 'ask', control: () => bash('claude mcp list') }],
  'guard-shell-hygiene.js': [{ event: 'PreToolUse', payload: () => bash(`curl -H "Authorization: Bearer ${FAKE_TOKEN}" https://api.example.com`), want: 'deny', control: () => bash('git status') }],
  'guard-comment-stripper.js': [{ event: 'PreToolUse', payload: (w) => write(path.join(w, 'a.js'), STRIPPER), want: 'ask', control: (w) => write(path.join(w, 'a.js'), 'const a = 1; // ok') }],
  'guard-halt.js': [{ event: 'PreToolUse', setup: (h) => put(path.join(h, '.claude'), 'HALT', 'stop'), payload: () => bash('echo hi'), want: 'deny', control: () => bash('echo hi'), controlSetup: (h) => fs.unlinkSync(path.join(h, '.claude', 'HALT')) }],
  'guard-deny-catastrophic.js': [{ event: 'PreToolUse', payload: () => bash('git push --force origin main'), want: 'deny', control: () => bash('git status') }],
  'guard-runaway.js': [{ event: 'PreToolUse', setup: runState(Array(6).fill('Bash:same')), payload: () => bash('echo hi'), want: 'ask', control: () => bash('echo hi'), controlSetup: runState(['a', 'b']) }],
  'guard-heredoc-backslash.js': [{ event: 'PreToolUse', payload: () => bash(`cat > a.txt <<EOF\na${'\\'}b\nEOF`), want: 'deny', control: () => bash('cat > a.txt <<EOF\nab\nEOF') }],
  'guard-no-ai-attribution.js': [{ event: 'PreToolUse', payload: () => bash(`git commit -m "x\n\n${['Co-Authored', 'By: Claude'].join('-')}"`), want: 'deny', control: () => bash('git commit -m "x"') }],
  'guard-em-dash.js': [{ event: 'PreToolUse', payload: (w) => write(path.join(w, 'a.md'), `a ${DASH} b`), want: 'ask', control: (w) => write(path.join(w, 'a.md'), 'a - b') }],
  'guard-hq-answers.js': [{ event: 'PreToolUse', setup: (h) => put(path.join(h, 'app'), '.runtime.json', JSON.stringify({ port: PORT })), payload: () => bash(`curl -d "{}" http://127.0.0.1:${PORT}/api/answer`), want: 'deny', control: () => bash(`curl http://127.0.0.1:${PORT}/api/stats`) }],
  'hq-agent-switch.js': [{ event: 'PreToolUse', setup: (h) => put(path.join(h, '.claude', 'hq-feed'), 'agents-off.json', JSON.stringify({ v: 1, off: [{ id: 'x', name: 'X', agentTypes: ['Plan'] }] })), payload: () => pre('Task', { subagent_type: 'Plan', prompt: 'x' }), want: 'deny', control: () => pre('Task', { subagent_type: 'Explore', prompt: 'x' }) }],
  'coord-guard.js': [{ event: 'PreToolUse', payload: (_w, dir) => bash(`node "${L.slash(dir)}/hooks/coord.js" force-release a.txt`), want: 'ask', control: () => bash('git status') },
    ...['Jane Doe', "Jane O'Neil"].map((who) => ({ event: 'PreToolUse', payload: () => bash(`node "C:/Users/${who}/.claude/vibequarters/hooks/coord.js" register --name verify --task probe`), want: (_o, h) => registered(h), control: () => bash('git status'), controlSetup: (h) => fs.unlinkSync(registryFile(h)) }))],
  'coord-session.js': [{ event: 'SessionStart', payload: () => ({ hook_event_name: 'SessionStart', source: 'startup' }), want: (out) => /SESSION COORDINATION/.test(out) }],
  'loop-honesty-gate.js': [{ event: 'Stop', payload: () => stop('All done, it is fixed.'), want: (out) => /EVIDENCE CHECK/.test(out), control: () => stop('Looking at it.') }],
  'loop-reply-check.js': [{ event: 'Stop', payload: () => stop('No status here.'), want: (_o, h) => fs.existsSync(replyNote(h)), control: () => stop("Built it.\n\nStatus: all done.") }],
  'loop-action-ledger.js': [{ event: 'PostToolUse', setup: (h, w) => fs.mkdirSync(memory(h, w), { recursive: true }), payload: () => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_response: {} }), want: (_o, h, w) => fs.existsSync(path.join(memory(h, w), 'RUNSTATE.json')) }],
  'loop-spot.js': [{ event: 'SessionStart', setup: (h, w) => put(memory(h, w), 'SPOT.md', '# Resume point (loop-spot.js)\n\nthe spot text\n'), payload: () => ({ hook_event_name: 'SessionStart', source: 'compact' }), want: (out) => /the spot text/.test(out), control: () => ({ hook_event_name: 'SessionStart', source: 'compact' }), controlSetup: (h, w) => fs.unlinkSync(path.join(memory(h, w), 'SPOT.md')) }],
  // notify.js pings in the background; VIBEQUARTERS_NOTIFY_LOG turns its sound into a line in pings.txt.
  'notify.js': ['Stop', 'Notification'].map((event) => ({ event, payload: () => ({ hook_event_name: event }), want: (_o, h) => waitFor(path.join(h, 'pings.txt')) })),
  'guard-edge-deploy.js': [{ event: 'PreToolUse', setup: (_h, w) => put(path.join(w, 'supabase', 'functions', 'fn'), 'index.ts', 'one\n'), payload: () => deployFn('two\n'), want: 'deny', control: () => deployFn('one\n') }],
};

function decisionOf(stdout) {
  if (!stdout.trim()) return 'allow';
  try {
    const o = JSON.parse(stdout);
    return (o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision) || 'allow';
  } catch (_e) { return 'allow'; }
}

// The hook as Claude Code runs it: an args list directly, a command line through the shell.
function runHook(h, payload, env, cwd) {
  const opt = { input: JSON.stringify(payload), encoding: 'utf8', env, cwd, timeout: 60000, windowsHide: true };
  return Array.isArray(h.args) ? spawnSync(h.command === 'node' ? process.execPath : h.command, h.args, opt) : spawnSync(h.command, { ...opt, shell: true });
}

// A throwaway home with the installed config, pointed at an empty app folder inside it
function fresh(config) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vibequarters-verify-')));
  const work = path.join(home, 'work');
  for (const d of [work, path.join(home, '.claude'), path.join(home, 'app')]) fs.mkdirSync(d);
  const conf = path.join(home, '.claude', 'vibequarters.config.json');
  fs.writeFileSync(conf, JSON.stringify({ ...config, appDir: path.join(home, 'app'), appStateDir: '', notify: { intervalSeconds: 0, count: 1 } }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, VIBEQUARTERS_CONFIG: conf, VIBEQUARTERS_NOTIFY_LOG: path.join(home, 'pings.txt') };
  for (const k of ['VIBEQUARTERS_GUARD', 'VIBEQUARTERS_HALT', 'VIBEQUARTERS_COORD_DIR', 'CLAUDE_PROJECT_DIR']) delete env[k];
  return { home, work, env };
}

// null when the hook answers as it must, else why not
function oneCheck(c, h, config, systemDir) {
  const sb = fresh(config);
  try {
    const go = (payload) => {
      const r = runHook(h, { session_id: SID, cwd: sb.work, transcript_path: path.join(sb.home, 'none.jsonl'), tool_use_id: 'toolu_verify', ...payload }, sb.env, sb.work);
      if (r.error) throw r.error;
      return r;
    };
    const meets = (want, r) => (typeof want === 'function' ? want(r.stdout || '', sb.home, sb.work) : decisionOf(r.stdout || '') === want);
    if (c.setup) c.setup(sb.home, sb.work);
    const r = go(c.payload(sb.work, systemDir));
    if (r.status !== 0) return `exited ${r.status}: ${(r.stderr || '').trim().slice(0, 200)}`;
    if (!meets(c.want, r)) return typeof c.want === 'string' ? `answered ${decisionOf(r.stdout || '')}, not ${c.want}` : 'did not do what it must';
    if (c.control) {
      if (c.controlSetup) c.controlSetup(sb.home, sb.work);
      const k = go(c.control(sb.work, systemDir));
      if (k.status !== 0) return `exited ${k.status} on the control`;
      if (typeof c.want === 'string' ? decisionOf(k.stdout || '') !== 'allow' : meets(c.want, k)) return `stopped a payload it must let through (${decisionOf(k.stdout || '')})`;
    }
    return null;
  } catch (e) {
    return e.message;
  } finally {
    try { fs.rmSync(sb.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_e) { /* a background process still holds it; the system clears its temp folder */ }
  }
}

const under = (f, dir) => !!dir && L.slash(f).toLowerCase().startsWith(`${L.slash(dir)}/`.toLowerCase());
const fileOf = (h, ...dirs) => [...(Array.isArray(h.args) ? h.args : []), ...String(h.command || '').split('"')].find((s) => dirs.some((d) => under(s, d)));

function main(argv) {
  const args = L.parseArgs(argv, { home: 'value', dir: 'value' });
  const here = path.resolve(__dirname, '..');
  const p = L.paths({ home: args.home, dir: args.dir || (fs.existsSync(path.join(here, L.MANIFEST)) ? here : undefined) });
  const m = L.readManifest(p);
  if (!m) throw new Error(`no VibeQuarters install found in ${p.systemDir} (name the system folder with --dir)`);
  const settings = L.parseSettings(L.readBytes(p.settings)).json;
  let config = {};
  try { config = JSON.parse(fs.readFileSync(p.config, 'utf8')); } catch (_e) { /* the defaults */ }
  let failed = 0;
  const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${text}`); };

  // Every hook settings.json runs out of the system folder or the app folder, and what the packs say must be there
  const installed = [];
  for (const [event, list] of Object.entries(settings.hooks || {})) for (const g of list) for (const h of (g && g.hooks) || []) {
    const file = fileOf(h, p.systemDir, m.appDir);
    if (file) installed.push({ event, h, file });
  }
  for (const { event, group } of L.hookGroups(m.packs, { systemDir: p.systemDir, appDir: m.appDir })) {
    const file = fileOf(group.hooks[0], p.systemDir, m.appDir);
    if (!installed.some((x) => x.event === event && L.slash(x.file).toLowerCase() === file.toLowerCase())) line(false, `${event} ${path.basename(file)} is not in settings.json`);
  }

  const noop = path.join(os.tmpdir(), `vibequarters-verify-noop-${process.pid}.js`);
  fs.writeFileSync(noop, 'process.exit(0);\n');
  line(oneCheck(CHECKS['guard-deny-catastrophic.js'][0], { command: 'node', args: [noop] }, config, p.systemDir) !== null, 'negative control: a hook that answers nothing fails its check');
  fs.unlinkSync(noop);

  const tested = new Set();
  for (const { event, h, file } of installed) {
    const name = path.basename(file);
    const label = `${event} ${name}${Array.isArray(h.args) && h.args.length > 1 ? ` ${h.args.slice(1).join(' ')}` : ''}`;
    if (!fs.existsSync(file)) { line(false, `${label}: the file is missing`); continue; }
    if (!under(file, p.systemDir)) {
      line(spawnSync(process.execPath, ['--check', file], { windowsHide: true }).status === 0, `${label}: loads (not run, it talks to the app)`);
      continue;
    }
    const checks = (CHECKS[name] || []).filter((c) => c.event === event);
    if (checks.length) {
      if (tested.has(label)) continue;
      tested.add(label);
      for (const c of checks) {
        const why = oneCheck(c, h, config, p.systemDir);
        line(!why, `${label}: ${why || (c.control ? `${typeof c.want === 'string' ? c.want : 'acts'}, and lets the control through` : 'acts')}`);
      }
      continue;
    }
    const payload = { hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'git status' }, tool_response: {}, prompt: 'hello there', source: 'startup', trigger: 'auto', reason: 'other', last_assistant_message: 'Looking at it.', tool_calls: [] };
    const why = oneCheck({ payload: () => payload, want: () => true }, h, config, p.systemDir);
    line(!why, `${label}: ${why || 'runs clean'}`);
  }

  const dirs = String((settings.env || {})[L.PLUGIN_DIRS] || '').split(L.sep()).filter(Boolean);
  for (const id of m.packs) for (const mod of L.packById(id).mods || []) {
    const d = dirs.find((x) => L.slash(x).toLowerCase() === `${L.slash(p.systemDir)}/mods/${mod}`.toLowerCase());
    let ok = !!d;
    try { JSON.parse(fs.readFileSync(path.join(d, '.claude-plugin', 'plugin.json'), 'utf8')); } catch (_e) { ok = false; }
    line(ok, `mod ${mod}: registered, with its plugin.json`);
  }
  console.log(failed ? `\n${failed} check(s) failed.` : '\nEvery check passed.');
  return failed ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`verify: ${e.message}`); process.exitCode = 1; }
}
module.exports = { main };
