#!/usr/bin/env node
// vibequarters :: PreToolUse + PostToolUse on the Supabase MCP edge-function tools.
// PreToolUse(deploy_edge_function): a deploy ships exactly the files in this checkout.
//   A file sent with content "@disk" is filled from <cwd>/<edgeDeploy.functionsDir>/<name>, and
//   every relative import the tree reaches is added from disk, so
//   files: [{ name: "<fn>/index.ts", content: "@disk" }] deploys the whole closed tree.
//   A file sent with real content must match the checkout (line endings aside) or the
//   call is denied. Why: retyped source can differ from the checkout in ways the
//   bundler does not notice. Only updatedInput is
//   returned, so the normal permission flow still decides whether the deploy runs.
//   "@disk" reaching the bundler unreplaced is a syntax error, so a miss fails safe.
// PostToolUse(get_edge_function): saves the deployed files under
//   <edgeDeploy.snapshotDir>/<slug>/<time>/ and replaces the output with a short
//   summary, so diffing prod against main before an overwrite costs no context. An
//   answer too large to show is read from the file that Claude Code stored.
// PostToolUse(deploy_edge_function): an ACTIVE status does not prove the function starts. The bundler skips V8's early
//   errors, so a module that cannot start still deploys as ACTIVE and answers 503
//   BOOT_ERROR. 10s after an ACTIVE deploy (a new version is usually served within 8s) it sends the function a CORS preflight, which only a
//   booted function's own OPTIONS branch answers 2xx; a failure blocks with status and
//   body; its Origin header is edgeDeploy.origin. An entrypoint without an
//   OPTIONS branch is left alone, because a webhook or cron job would RUN on the request; its boot is reported unproven.
//   EDGE_PROBE_BASE and EDGE_PROBE_DELAY_MS exist for the tests.
// FAILS OPEN on its own bug. VIBEQUARTERS_GUARD=off disables it.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./vibequarters-config');
const ED = P.load().edgeDeploy;

const MARK = '@disk';
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const LOG = path.join(os.homedir(), '.claude', 'logs', 'edge-deploy-guard.log');
const PREFLIGHT_RE = /\bmethod\s*===?\s*['"]OPTIONS['"]/;
const PREFLIGHT_HEADERS = { Origin: String(ED.origin || 'http://localhost:3000'), 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' };
const PROBE_DELAY_MS = Number(process.env.EDGE_PROBE_DELAY_MS || 10000);

const lf = (s) => s.replace(/\r\n/g, '\n');
// True when name resolves strictly inside base: no `..` climb, no absolute or drive path.
const inside = (base, name) => path.resolve(base, String(name)).startsWith(path.resolve(base) + path.sep);
const same = (a, b) => lf(a).replace(/\s+$/, '') === lf(b).replace(/\s+$/, '');

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch (_) { /* logging never blocks */ }
}

function emit(hookSpecificOutput) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
  process.exit(0);
}

function deny(reason) {
  log(`DENY ${reason}`);
  emit({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason });
}

function firstDiff(a, b) {
  const x = lf(a).split('\n');
  const y = lf(b).split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `line ${i + 1}: checkout has ${JSON.stringify((y[i] || '').slice(0, 80))}, call has ${JSON.stringify((x[i] || '').slice(0, 80))}`;
  }
  return 'trailing whitespace only';
}

// An MCP result arrives as content blocks whose text is JSON; find the [{name, content}] list
// in it, with the object that holds it (its scalar fields are the function's metadata).
function findFiles(x, parent) {
  if (typeof x === 'string') {
    for (const s of [x, x.slice(x.indexOf('{'), x.lastIndexOf('}') + 1), x.slice(x.indexOf('['), x.lastIndexOf(']') + 1)]) {
      try { const r = findFiles(JSON.parse(s), null); if (r) return r; } catch (_) { /* not JSON */ }
    }
    return null;
  }
  if (Array.isArray(x) && x.length && x.every((o) => o && typeof o.name === 'string' && typeof o.content === 'string')) return { files: x, meta: parent || {} };
  if (x && typeof x === 'object') {
    for (const v of Object.values(x)) { const r = findFiles(v, Array.isArray(x) ? parent : x); if (r) return r; }
  }
  return null;
}

// An answer too big for the context arrives as an error naming the file Claude Code saved it to
// ("... Output has been saved to <path>/tool-results/mcp-...-get_edge_function-<n>.txt."), and
// that file holds the whole JSON answer.
// Only a file in a tool-results folder under ~/.claude/projects is read. Returns its text or null.
function persistedAnswer(x) {
  const texts = [];
  const walk = (v) => { if (typeof v === 'string') texts.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(x);
  const projects = path.join(os.homedir(), '.claude', 'projects') + path.sep;
  for (const t of texts) {
    const m = /saved to ([^\n]+?\.txt)\.?(?:\s|$)/.exec(t);
    if (!m) continue;
    const file = path.resolve(m[1]);
    const ok = file.toLowerCase().startsWith(projects.toLowerCase()) && path.basename(path.dirname(file)) === 'tool-results';
    if (ok && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  return null;
}

// The deploy result is content blocks whose text is the function's JSON: {status, version, ...}.
function findDeployed(x) {
  if (typeof x === 'string') {
    try { return findDeployed(JSON.parse(x)); } catch (_) { return null; }
  }
  if (x && typeof x === 'object') {
    if (typeof x.status === 'string' && x.version !== undefined) return x;
    for (const v of Object.values(x)) { const r = findDeployed(v); if (r) return r; }
  }
  return null;
}

// ok: true = booted, false = cannot start, null = not proven either way.
async function probeBoot(input, root) {
  const ti = input.tool_input || {};
  const name = String(ti.name || '');
  const deployed = findDeployed(input.tool_response);
  if (!deployed || deployed.status !== 'ACTIVE') {
    return { ok: null, text: `BOOT UNVERIFIED: the deploy result shows no ACTIVE version, so nothing new was probed: ${JSON.stringify(input.tool_response).slice(0, 200)}` };
  }
  const fn = `${name} v${deployed.version}`;
  const entry = String(ti.entrypoint_path || '');
  const entryPath = path.join(root, entry);
  if (!PREFLIGHT_RE.test(fs.existsSync(entryPath) ? fs.readFileSync(entryPath, 'utf8') : '')) {
    return { ok: null, text: `BOOT UNPROVEN: ${fn} has no OPTIONS branch in ${entry}, so a probe would run it. Check function_logs for "boot error" after its next run.` };
  }
  const ref = String(ti.project_id || '');
  if (!/^[a-z0-9]{20}$/.test(ref) || !/^[\w-]+$/.test(name)) {
    return { ok: null, text: `BOOT UNVERIFIED: ${fn}: no probe URL can be built from project_id "${ref}".` };
  }
  await new Promise((r) => setTimeout(r, PROBE_DELAY_MS));
  const url = `${process.env.EDGE_PROBE_BASE || `https://${ref}.supabase.co`}/functions/v1/${name}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'OPTIONS', headers: PREFLIGHT_HEADERS, signal: AbortSignal.timeout(15000) });
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
    const at = `${fn}: OPTIONS ${url} -> ${res.status} in ${Date.now() - t0}ms, ${PROBE_DELAY_MS / 1000}s after the deploy`;
    if (res.ok) return { ok: true, text: `BOOT OK: ${at}` };
    return { ok: false, text: `BOOT FAILED: ${at}: ${body}. The deploy is ACTIVE but the function cannot start: fix it or roll back now.` };
  } catch (e) {
    return { ok: null, text: `BOOT UNVERIFIED: ${fn}: the probe failed (${e && e.message}); send it an OPTIONS by hand before calling it live.` };
  }
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') process.exit(0);
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const tool = String(input.tool_name || '');
  const root = path.join(input.cwd || process.cwd(), String(ED.functionsDir || 'supabase/functions'));
  if (!fs.existsSync(root)) process.exit(0);

  if (input.hook_event_name === 'PreToolUse' && /deploy_edge_function$/.test(tool)) {
    const ti = input.tool_input || {};
    const files = new Map();
    for (const f of ti.files || []) {
      if (!inside(root, f.name)) deny(`${f.name} is outside ${root}. Deploy only files under ${ED.functionsDir || 'supabase/functions'}.`);
      const disk = path.join(root, f.name);
      if (!fs.existsSync(disk)) deny(`${f.name} is not in this checkout (${root}). Deploy only files that exist there.`);
      const text = fs.readFileSync(disk, 'utf8');
      if (f.content !== MARK && !same(f.content, text)) deny(`${f.name} differs from the checkout at ${firstDiff(f.content, text)}. Send content "@disk" to use the checkout's file.`);
      files.set(f.name, lf(text));
    }
    const queue = [...files.keys()];
    while (queue.length) {
      const name = queue.pop();
      for (const m of files.get(name).matchAll(IMPORT_RE)) {
        const dep = path.posix.normalize(path.posix.join(path.posix.dirname(name), m[1] || m[2]));
        if (files.has(dep)) continue;
        if (!inside(root, dep)) deny(`${name} imports ${dep}, which is outside ${root}.`);
        const disk = path.join(root, dep);
        if (!fs.existsSync(disk)) deny(`${name} imports ${dep}, which is not in this checkout.`);
        files.set(dep, lf(fs.readFileSync(disk, 'utf8')));
        queue.push(dep);
      }
    }
    if (!files.has(ti.entrypoint_path)) deny(`entrypoint_path ${ti.entrypoint_path} is not among the files.`);
    const names = [...files.keys()].sort();
    const bytes = names.reduce((n, k) => n + Buffer.byteLength(files.get(k)), 0);
    log(`FILL ${ti.name} verify_jwt=${ti.verify_jwt} entry=${ti.entrypoint_path} files=${names.length} bytes=${bytes} from ${root} [${names.join(', ')}]`);
    emit({ hookEventName: 'PreToolUse', updatedInput: { ...ti, files: names.map((name) => ({ name, content: files.get(name) })) } });
  }

  if (input.hook_event_name === 'PostToolUse' && /get_edge_function$/.test(tool)) {
    const asked = String((input.tool_input || {}).function_slug || '');
    const slug = /^[\w-]+$/.test(asked) ? asked : 'unknown';
    let found = findFiles(input.tool_response, null);
    if (!found) {
      const saved = persistedAnswer(input.tool_response);
      found = saved && findFiles(saved, null);
    }
    const files = found && found.files;
    if (!files) {
      log(`SNAPSHOT ${slug}: no file list found in tool_response ${JSON.stringify(input.tool_response).slice(0, 300)}`);
      process.exit(0);
    }
    const dir = path.join(P.expand(ED.snapshotDir) || path.join(os.homedir(), '.claude', 'edge-snapshots'), slug, new Date().toISOString().replace(/[:.]/g, '-'));
    const lines = [];
    for (const f of files) {
      // Prod names files like /tmp/user_fn_<ref>_<id>_<v>/source/supabase/functions/<fn>/index.ts.
      let n = f.name.replace(/\\/g, '/').replace(/^file:\/\/\/?/, '');
      const k = n.lastIndexOf('functions/');
      if (k >= 0) n = n.slice(k + 10);
      else n = n.slice(n.lastIndexOf('/source/') >= 0 ? n.lastIndexOf('/source/') + 8 : 0).replace(/^source\//, '');
      const mapped = [path.posix.normalize(n), path.posix.normalize(`${slug}/${n}`)].find((c) => !c.startsWith('..') && fs.existsSync(path.join(root, c)));
      // The strip is cosmetic (`....//` survives it as `../`); the containment check is the guard.
      const save = mapped || n.replace(/\.\.\//g, '');
      if (!save || !inside(dir, save)) { lines.push(`${f.name}: skipped, the name leaves the snapshot folder`); continue; }
      const dest = path.resolve(dir, save);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.content);
      lines.push(`${save}: ${!mapped ? 'not in checkout' : same(f.content, fs.readFileSync(path.join(root, mapped), 'utf8')) ? 'identical to checkout' : 'DIFFERS from checkout'}`);
    }
    const meta = Object.entries(found.meta).filter(([, v]) => v === null || typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(' ');
    const summary = `Deployed source of ${slug} (${files.length} files) saved to ${dir}\n${meta ? `meta: ${meta}\n` : ''}${lines.join('\n')}`;
    log(`SNAPSHOT ${summary.replace(/\n/g, ' | ')}`);
    emit({ hookEventName: 'PostToolUse', updatedToolOutput: summary, additionalContext: summary });
  }

  // Let the process end by itself here: exiting right after a fetch on Windows can abort on a socket still closing
  // (libuv UV_HANDLE_CLOSING assertion), which loses the output. The loop drains instead.
  if (input.hook_event_name === 'PostToolUse' && /deploy_edge_function$/.test(tool)) {
    probeBoot(input, root).then((r) => {
      log(`PROBE ${r.text}`);
      process.stdout.write(JSON.stringify(r.ok === false
        ? { decision: 'block', reason: r.text, systemMessage: r.text }
        : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: r.text } }));
    }).catch((e) => log(`hook error (failing open): ${e && e.message}`));
  } else {
    process.exit(0);
  }
} catch (e) {
  log(`hook error (failing open): ${e && e.message}`);
  process.exit(0);
}
