// Tests for hq-agent-switch.js: an agent the user switched off in HQ cannot start as a subagent.
// Run: node --test system/hooks/tests/hq-agent-switch.test.js
//
// HQ (VibeQuarters, Agent switches) writes ~/.claude/hq-feed/agents-off.json as { v: 1, at, off: [{ id, name, agentTypes }] }.
// Each deny below is a subagent type an off agent lists; each allow is a file the hook cannot trust,
// which must let every call through.
//
// Sandboxed by overriding USERPROFILE/HOME, because os.homedir() is how the hook finds the file.
'use strict';
require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hq-agent-switch.js');
const homes = [];
test.after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

const ENGINEER = { id: 'engineer', name: 'Engineer', agentTypes: ['general-purpose', 'Plan'] };
const DOCS = { id: 'docs', name: 'Docs Guide', agentTypes: ['docs-*', 'docs-tools:*'] };
const SETUP = { id: 'setup', name: 'Setup Guide', agentTypes: ['Explore', 'setup-helper'] };
const ASK = { description: 'find the thing', prompt: 'Find where X is defined.' };

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'hqswitch-'));
  homes.push(h);
  return h;
}

// Writes h/.claude/hq-feed/agents-off.json: an object as JSON, a string as is.
function offFile(h, body) {
  const dir = path.join(h, '.claude', 'hq-feed');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents-off.json'), typeof body === 'string' ? body : JSON.stringify(body));
}
// The shape HQ itself writes (lib/switches.js).
const written = (...off) => ({ v: 1, at: '2030-01-01T00:00:00.000Z', off });

function run(h, tool, toolInput, extraEnv = {}, raw) {
  const env = { ...process.env, USERPROFILE: h, HOME: h, ...extraEnv };
  if (!('VIBEQUARTERS_GUARD' in extraEnv)) delete env.VIBEQUARTERS_GUARD;
  const r = spawnSync(process.execPath, [HOOK], { input: raw ?? JSON.stringify({ tool_name: tool, tool_input: toolInput }), env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr, '');
  if (!r.stdout.trim()) return { decision: 'allow', reason: '' };
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.strictEqual(out.hookEventName, 'PreToolUse');
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
}
const decide = (...a) => run(...a).decision;

test('an Agent call whose type an off agent lists is denied, naming the agent', () => {
  const h = home();
  offFile(h, { ...written(SETUP), extra: { anything: true } });
  const r = run(h, 'Agent', { subagent_type: 'Explore', ...ASK });
  assert.strictEqual(r.decision, 'deny');
  assert.ok(r.reason.includes('Setup Guide'), r.reason);
  assert.ok(r.reason.includes('switched'), r.reason);
  assert.ok(r.reason.includes('a Explore subagent'), r.reason);
  // only the switched-off work is barred; other work goes on
  assert.ok(r.reason.includes('Do not start the same work as a different subagent type; anything else may go on.'), r.reason);
  assert.strictEqual(decide(h, 'Agent', { subagent_type: 'setup-helper', ...ASK }), 'deny');
  assert.strictEqual(decide(h, 'Agent', { subagent_type: 'Plan', ...ASK }), 'allow', 'a type no off agent lists');
});

test('a prefix pattern matches its types, and the bare prefix does not', () => {
  const h = home();
  offFile(h, written(DOCS));
  assert.strictEqual(decide(h, 'Agent', { subagent_type: 'docs-writer', ...ASK }), 'deny');
  assert.strictEqual(decide(h, 'Agent', { subagent_type: 'docs', ...ASK }), 'allow');
  assert.strictEqual(decide(h, 'Agent', { subagent_type: 'docs-tools:write', ...ASK }), 'deny');
});

test('a missing or blank subagent_type counts as general-purpose', () => {
  const h = home();
  offFile(h, written(ENGINEER));
  const r = run(h, 'Agent', {});
  assert.strictEqual(r.decision, 'deny');
  assert.ok(r.reason.includes('a general-purpose subagent'), r.reason);
  assert.strictEqual(decide(h, 'Agent', { subagent_type: ' ', ...ASK }), 'deny');
  assert.strictEqual(decide(h, 'Agent', { subagent_type: ' Plan ', ...ASK }), 'deny', 'the type is trimmed');
  const other = home();
  offFile(other, written(DOCS));
  assert.strictEqual(decide(other, 'Agent', {}), 'allow');
  assert.strictEqual(decide(other, 'Agent', { subagent_type: ' ', ...ASK }), 'allow');
});

test('a missing, unreadable, non-JSON, other-version or list-less file lets every call through', () => {
  const call = { subagent_type: 'Explore', ...ASK };
  assert.strictEqual(decide(home(), 'Agent', call), 'allow', 'no file');
  const folder = home();
  fs.mkdirSync(path.join(folder, '.claude', 'hq-feed', 'agents-off.json'), { recursive: true });
  assert.strictEqual(decide(folder, 'Agent', call), 'allow', 'a folder where the file should be');
  const rows = [
    ['', 'an empty file'],
    ['{"v":1,"off":[{"name":"Setup Guide","agentTypes":["Expl', 'a half-written file'],
    ['not json', 'not JSON'],
    ['null', 'JSON null'],
    ['[]', 'a JSON list'],
    [{ ...written(SETUP), v: 2 }, 'another version'],
    [{ ...written(SETUP), v: '1' }, 'the version as a string'],
    [{ v: 1, at: 'x' }, 'no off list'],
    [{ v: 1, off: { setup: SETUP } }, 'an off that is not a list'],
  ];
  for (const [body, why] of rows) {
    const h = home();
    offFile(h, body);
    assert.strictEqual(decide(h, 'Agent', call), 'allow', why);
  }
});

test('a bad entry is skipped and a good one beside it still applies', () => {
  const h = home();
  offFile(h, written(
    null,
    'setup',
    { id: 'a', agentTypes: ['Explore'] },
    { id: 'b', name: 7, agentTypes: ['Explore'] },
    { id: 'c', name: 'No list', agentTypes: 'Explore' },
    { id: 'd', name: 'Odd list', agentTypes: [7, null, 'Explore'] },
    SETUP,
  ));
  const r = run(h, 'Agent', { subagent_type: 'Explore', ...ASK });
  assert.strictEqual(r.decision, 'deny');
  assert.ok(r.reason.includes('Setup Guide'), r.reason);
  assert.ok(!r.reason.includes('Odd list'), r.reason);
});

test('a file over 64 KB lets every call through', () => {
  const call = { subagent_type: 'Explore', ...ASK };
  const json = JSON.stringify(written(SETUP));
  const atLimit = home();
  offFile(atLimit, json + ' '.repeat(65536 - json.length));
  assert.strictEqual(fs.statSync(path.join(atLimit, '.claude', 'hq-feed', 'agents-off.json')).size, 65536);
  assert.strictEqual(decide(atLimit, 'Agent', call), 'deny', 'exactly 64 KB is still read');
  const over = home();
  offFile(over, json + ' '.repeat(65537 - json.length));
  assert.strictEqual(decide(over, 'Agent', call), 'allow', 'one byte over');
});

test('the Task tool name is checked too; any other tool passes', () => {
  const h = home();
  offFile(h, written(SETUP));
  const call = { subagent_type: 'Explore', ...ASK };
  assert.strictEqual(decide(h, 'Task', call), 'deny');
  for (const tool of ['Bash', 'SendMessage', 'Skill', 'agent', 'mcp__x__Agent', '']) assert.strictEqual(decide(h, tool, call), 'allow', tool);
  assert.strictEqual(decide(h, 'Agent', null, {}, 'not json'), 'allow', 'a broken event');
});

test('VIBEQUARTERS_GUARD=off lets an off agent\'s type through', () => {
  const h = home();
  offFile(h, written(SETUP));
  assert.strictEqual(decide(h, 'Agent', { subagent_type: 'Explore', ...ASK }, { VIBEQUARTERS_GUARD: 'off' }), 'allow');
  assert.strictEqual(decide(h, 'Agent', { subagent_type: 'Explore', ...ASK }, { VIBEQUARTERS_GUARD: 'OFF' }), 'allow');
});

test('an empty off list lets everything through', () => {
  const h = home();
  offFile(h, written());
  for (const subagent_type of [undefined, 'general-purpose', 'Explore', 'docs-writer', 'Plan']) {
    assert.strictEqual(decide(h, 'Agent', { subagent_type, ...ASK }), 'allow', String(subagent_type));
  }
});
