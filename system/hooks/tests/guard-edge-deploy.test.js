// Tests for guard-edge-deploy.js, the "deploy exactly the checkout" guard.
// Run: node --test system/hooks/tests/guard-edge-deploy.test.js
// Drives the hook as Claude Code does: a payload on stdin, the decision off stdout.
'use strict';
require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'guard-edge-deploy.js');
const DEPLOY = 'mcp__plugin_supabase_supabase__deploy_edge_function';
const GET = 'mcp__plugin_supabase_supabase__get_edge_function';

function run(payload, env) {
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.strictEqual(r.status, 0, `guard must always exit 0, got ${r.status}: ${r.stderr}`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

// A checkout with fn/index.ts -> ../_shared/a.ts -> ./b.ts, written with CRLF like a Windows worktree.
function checkout() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-guard-'));
  const root = path.join(cwd, 'supabase', 'functions');
  fs.mkdirSync(path.join(root, 'fn'), { recursive: true });
  fs.mkdirSync(path.join(root, '_shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fn', 'index.ts'), 'import { a } from "../_shared/a.ts";\r\nDeno.serve(() => new Response(a));\r\n');
  fs.writeFileSync(path.join(root, '_shared', 'a.ts'), 'export { b as a } from "./b.ts";\r\n');
  fs.writeFileSync(path.join(root, '_shared', 'b.ts'), 'export const b = "value one";\r\n');
  return cwd;
}

const deploy = (cwd, files) => run({
  hook_event_name: 'PreToolUse', tool_name: DEPLOY, cwd,
  tool_input: { project_id: 'p', name: 'fn', verify_jwt: false, entrypoint_path: 'fn/index.ts', files },
});

test('fills @disk from the checkout and closes the import tree, LF only', () => {
  const o = deploy(checkout(), [{ name: 'fn/index.ts', content: '@disk' }]);
  assert.strictEqual(o.permissionDecision, undefined, 'must leave the decision to the normal permission flow');
  const files = o.updatedInput.files;
  assert.deepStrictEqual(files.map((f) => f.name), ['_shared/a.ts', '_shared/b.ts', 'fn/index.ts']);
  assert.ok(files.every((f) => !f.content.includes('\r') && f.content !== '@disk'));
  assert.strictEqual(o.updatedInput.verify_jwt, false, 'must keep verify_jwt as sent');
});

test('accepts real content that matches the checkout', () => {
  const o = deploy(checkout(), [{ name: 'fn/index.ts', content: 'import { a } from "../_shared/a.ts";\nDeno.serve(() => new Response(a));\n' }]);
  assert.strictEqual(o.updatedInput.files.length, 3);
});

test('denies content that differs from the checkout, naming the line', () => {
  const o = deploy(checkout(), [{ name: 'fn/index.ts', content: '@disk' }, { name: '_shared/b.ts', content: 'export const b = "value two";' }]);
  assert.strictEqual(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /_shared\/b\.ts differs from the checkout at line 1/);
});

test('denies a file or an import that is not in the checkout', () => {
  const cwd = checkout();
  assert.strictEqual(deploy(cwd, [{ name: 'fn/nope.ts', content: '@disk' }]).permissionDecision, 'deny');
  fs.unlinkSync(path.join(cwd, 'supabase', 'functions', '_shared', 'b.ts'));
  assert.match(deploy(cwd, [{ name: 'fn/index.ts', content: '@disk' }]).permissionDecisionReason, /imports _shared\/b\.ts/);
});

test('stays silent outside a Supabase checkout and on other tools', () => {
  assert.strictEqual(deploy(os.tmpdir(), [{ name: 'fn/index.ts', content: '@disk' }]), null);
  assert.strictEqual(run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: checkout(), tool_input: { command: 'ls' } }), null);
});

test('snapshots a deployed function from an MCP text block and summarizes it', () => {
  const cwd = checkout();
  const text = JSON.stringify({ slug: 'fn', files: [
    { name: 'source/index.ts', content: 'import { a } from "../_shared/a.ts";\nDeno.serve(() => new Response(a));\n' },
    { name: 'source/../_shared/b.ts', content: 'export const b = "old";\n' },
    { name: '/tmp/user_fn_ref_id_1/source/supabase/functions/_shared/a.ts', content: 'export { b as a } from "./b.ts";\n' },
  ] });
  const o = run({ hook_event_name: 'PostToolUse', tool_name: GET, cwd, tool_input: { project_id: 'p', function_slug: 'fn' }, tool_response: [{ type: 'text', text }] });
  assert.match(o.updatedToolOutput, /meta: slug=fn/);
  assert.match(o.updatedToolOutput, /fn\/index\.ts: identical to checkout/);
  assert.match(o.updatedToolOutput, /_shared\/b\.ts: DIFFERS from checkout/);
  assert.match(o.updatedToolOutput, /\n_shared\/a\.ts: identical to checkout/);
  const dir = o.updatedToolOutput.match(/saved to (.+)\n/)[1];
  assert.strictEqual(fs.readFileSync(path.join(dir, '_shared', 'b.ts'), 'utf8'), 'export const b = "old";\n');
});

test('never reads a deploy file or an import from outside supabase/functions', () => {
  const cwd = checkout();
  fs.writeFileSync(path.join(cwd, 'secret.ts'), 'export const key = "not for prod";\n');
  const named = deploy(cwd, [{ name: '../../secret.ts', content: '@disk' }]);
  assert.strictEqual(named.permissionDecision, 'deny');
  assert.match(named.permissionDecisionReason, /\.\.\/\.\.\/secret\.ts is outside/);
  fs.writeFileSync(path.join(cwd, 'supabase', 'functions', 'fn', 'index.ts'), 'import { key } from "../../../secret.ts";\nDeno.serve(() => new Response(key));\n');
  const imported = deploy(cwd, [{ name: 'fn/index.ts', content: '@disk' }]);
  assert.strictEqual(imported.permissionDecision, 'deny');
  assert.match(imported.permissionDecisionReason, /imports \.\.\/\.\.\/secret\.ts, which is outside/);
});

// Every file under the sandbox home that is not in the snapshot store or the log.
function strays(h) {
  const keep = [path.join(h, '.claude', 'edge-snapshots') + path.sep, path.join(h, '.claude', 'logs') + path.sep];
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (!keep.some((k) => p.startsWith(k))) out.push(path.relative(h, p)); } };
  walk(h);
  return out;
}

test('a snapshot never writes outside its own folder, whatever the names or the slug say', () => {
  const cwd = checkout();
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-home-'));
  const get = (slug, files) => run({ hook_event_name: 'PostToolUse', tool_name: GET, cwd, tool_input: { project_id: 'p', function_slug: slug },
    tool_response: [{ type: 'text', text: JSON.stringify({ slug, files }) }] }, { USERPROFILE: h, HOME: h });
  const abs = process.platform === 'win32' ? 'C:/escape-abs.txt' : '/escape-abs.txt';
  const named = get('fn', [
    { name: 'source/....//....//....//escape.txt', content: 'x' },
    { name: abs, content: 'x' },
    { name: 'source/index.ts', content: 'ok' },
  ]);
  assert.ok(named.updatedToolOutput.includes(`${abs}: skipped, the name leaves the snapshot folder`), named.updatedToolOutput);
  get('../../slug-escape', [{ name: 'source/index.ts', content: 'ok' }]);
  assert.deepStrictEqual(strays(h), []);
});

// An answer too big for the context, as Claude Code hands it over: an error naming the saved file.
const tooBig = (file) => `Error: result (100,000 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${file}.\nFormat: Plain text (one line, no newlines)`;

test('an answer saved to a file for being too big is snapshotted from that file', () => {
  const cwd = checkout();
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-home-'));
  const saved = path.join(h, '.claude', 'projects', 'C--x', 'sess', 'tool-results', 'mcp-plugin_supabase_supabase-get_edge_function-1700000000000.txt');
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  fs.writeFileSync(saved, JSON.stringify({ slug: 'fn', version: 5, files: [{ name: 'fn/index.ts', content: 'import { a } from "../_shared/a.ts";\nDeno.serve(() => new Response(a));\n' }] }));
  const o = run({ hook_event_name: 'PostToolUse', tool_name: GET, cwd, tool_input: { project_id: 'p', function_slug: 'fn' }, tool_response: tooBig(saved) }, { USERPROFILE: h, HOME: h });
  assert.match(o.updatedToolOutput, /Deployed source of fn \(1 files\) saved to /);
  assert.match(o.updatedToolOutput, /fn\/index\.ts: identical to checkout/);
  const dir = o.updatedToolOutput.match(/saved to (.+)\n/)[1];
  assert.ok(fs.existsSync(path.join(dir, 'fn', 'index.ts')), 'the deployed file is on disk');
});

test('negative control: a named file outside a tool-results folder is never read', () => {
  const cwd = checkout();
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-home-'));
  const outside = path.join(h, 'secret.txt');
  fs.writeFileSync(outside, JSON.stringify({ slug: 'fn', files: [{ name: 'fn/index.ts', content: 'x' }] }));
  const o = run({ hook_event_name: 'PostToolUse', tool_name: GET, cwd, tool_input: { project_id: 'p', function_slug: 'fn' }, tool_response: tooBig(outside) }, { USERPROFILE: h, HOME: h });
  assert.strictEqual(o, null, 'no snapshot, the output left as it was');
  assert.ok(!fs.existsSync(path.join(h, '.claude', 'edge-snapshots')));
});

// The post-deploy boot probe sends a preflight 10s after the deploy; these point it at a
// local server with no delay. Async, because spawnSync would stall the server.
function runAsync(payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GUARD], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`guard must always exit 0, got ${code}`));
      resolve(out.trim() ? JSON.parse(out) : null);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function edge(status, body) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) };
}

// fn/index.ts with the CORS branch every browser-called function has.
function preflightCheckout() {
  const cwd = checkout();
  fs.writeFileSync(path.join(cwd, 'supabase', 'functions', 'fn', 'index.ts'),
    'Deno.serve((req) => {\n  if (req.method === "OPTIONS") return new Response(null, { status: 204 });\n  return new Response("ran");\n});\n');
  return cwd;
}

const deployed = (cwd, base, response) => runAsync({
  hook_event_name: 'PostToolUse', tool_name: DEPLOY, cwd,
  tool_input: { project_id: 'abcdefghijklmnopqrst', name: 'fn', verify_jwt: true, entrypoint_path: 'fn/index.ts', files: [{ name: 'fn/index.ts', content: '@disk' }] },
  tool_response: response || [{ type: 'text', text: JSON.stringify({ slug: 'fn', status: 'ACTIVE', version: 2 }) }],
}, { EDGE_PROBE_BASE: base, EDGE_PROBE_DELAY_MS: '0' });

test('after a deploy, a preflight answered 2xx reports BOOT OK with the version', async () => {
  const e = await edge(204, '');
  try {
    const o = await deployed(preflightCheckout(), e.base);
    assert.deepStrictEqual(e.hits, ['OPTIONS /functions/v1/fn']);
    assert.strictEqual(o.decision, undefined);
    assert.match(o.hookSpecificOutput.additionalContext, /^BOOT OK: fn v2: OPTIONS .* -> 204/);
  } finally { await e.close(); }
});

test('a function that cannot start blocks with the status and the body', async () => {
  const e = await edge(503, '{"code":"BOOT_ERROR","message":"Function failed to start (please check logs)"}');
  try {
    const o = await deployed(preflightCheckout(), e.base);
    assert.strictEqual(o.decision, 'block');
    assert.match(o.reason, /^BOOT FAILED: fn v2: OPTIONS .* -> 503 .*BOOT_ERROR/);
  } finally { await e.close(); }
});

test('never probes an entrypoint without an OPTIONS branch: the request would run it', async () => {
  const e = await edge(204, '');
  try {
    const o = await deployed(checkout(), e.base);
    assert.deepStrictEqual(e.hits, []);
    assert.match(o.hookSpecificOutput.additionalContext, /^BOOT UNPROVEN: fn v2/);
  } finally { await e.close(); }
});

test('reports UNVERIFIED, never OK, when the deploy did not land or the probe cannot connect', async () => {
  const e = await edge(204, '');
  try {
    const failed = await deployed(preflightCheckout(), e.base, [{ type: 'text', text: 'Failed to deploy: bundling error' }]);
    assert.deepStrictEqual(e.hits, []);
    assert.match(failed.hookSpecificOutput.additionalContext, /^BOOT UNVERIFIED/);
  } finally { await e.close(); }
  const down = await deployed(preflightCheckout(), 'http://127.0.0.1:9');
  assert.match(down.hookSpecificOutput.additionalContext, /^BOOT UNVERIFIED: fn v2/);
});

test('fails open on a malformed payload', () => {
  const r = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual((r.stdout || '').trim(), '');
});
