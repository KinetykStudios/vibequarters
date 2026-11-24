// Tests for usage-meter.js, the weekly and per-session usage warnings.
// Run: node --test system/hooks/tests/usage-meter.test.js
// Every warning is checked against a negative control, because a meter that never
// speaks passes any test that only asserts silence.
'use strict';
require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');
const HOOK = path.join(__dirname, '..', 'usage-meter.js');
process.env.USAGE_METER_PRICING = path.join(__dirname, '..', '..', '..', 'pricing.js'); // the app's price table

const SID = '11111111-2222-3333-4444-555555555555';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'usage-meter-'));
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// One assistant line on Opus 5.5: output is $20 per million, so 8M output tokens is $160.
// ctx rides as cache reads at $0.20 per million, so 300k of context costs $0.06.
const asst = (id, o = {}) => JSON.stringify({
  type: 'assistant', timestamp: o.ts || new Date().toISOString(), requestId: 'r' + id,
  message: { id: 'm' + id, model: 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: o.out || 0, cache_read_input_tokens: o.ctx || 0, cache_creation_input_tokens: 0 } },
});
const compact = () => JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: new Date().toISOString() });

function setup(lines, subLines) {
  const dir = tmp();
  const tp = path.join(dir, SID + '.jsonl');
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  if (subLines) {
    const sd = path.join(dir, SID, 'subagents');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'agent-a.jsonl'), subLines.join('\n') + '\n');
  }
  return { dir, tp, state: path.join(dir, 'state'), extra: {} };
}

const prompt = (s, extra = {}) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify(Object.assign({ hook_event_name: 'UserPromptSubmit', session_id: SID, transcript_path: s.tp, prompt: 'hi' }, extra)),
  encoding: 'utf8',
  env: Object.assign({}, process.env, { USAGE_METER_STATE: s.state }, s.extra),
});
const msg = (r) => { const out = r.stdout.trim(); return out ? JSON.parse(out).systemMessage : ''; };

test('session spend', async (t) => {
  await t.test('says so once when the session passes $150', () => {
    const s = setup([asst(1, { out: 8e6 })]);
    const r = prompt(s);
    assert.strictEqual(r.status, 0);
    assert.match(msg(r), /about \$160 API-equivalent/);
    assert.strictEqual(msg(prompt(s)), '');
  });
  await t.test('negative control: $100 says nothing', () => {
    assert.strictEqual(msg(prompt(setup([asst(1, { out: 5e6 })]))), '');
  });
  await t.test('a message written over several lines is counted once', () => {
    assert.strictEqual(msg(prompt(setup([asst(1, { out: 5e6 }), asst(1, { out: 5e6 })]))), '');
  });
  await t.test('subagent spend counts toward the session', () => {
    assert.match(msg(prompt(setup([asst(1, { out: 5e6 })], [asst(2, { out: 3e6 })]))), /about \$160/);
  });
  await t.test('spend appended after the last prompt trips the next step', () => {
    const s = setup([asst(1, { out: 5e6 })]);
    assert.strictEqual(msg(prompt(s)), '');
    fs.appendFileSync(s.tp, asst(2, { out: 3e6 }) + '\n');
    assert.match(msg(prompt(s)), /about \$160/);
  });
  await t.test('a small read budget catches up over prompts and warns once, not at every step', () => {
    const lines = [];
    for (let i = 0; i < 6; i++) lines.push(asst(i, { out: 4e6 })); // 6 x $80 = $480
    const s = setup(lines);
    s.extra = { USAGE_METER_BUDGET: '600' };
    const seen = [];
    for (let i = 0; i < 10; i++) { const m = msg(prompt(s)); if (m) seen.push(m); }
    assert.strictEqual(seen.length, 1);
    assert.match(seen[0], /about \$480/);
  });
  await t.test('a line longer than a whole read slice is skipped and the rest still counts', () => {
    const huge = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } });
    const s = setup([huge, asst(1, { out: 8e6 })]);
    s.extra = { USAGE_METER_CHUNK: '1000' };
    const seen = [];
    for (let i = 0; i < 5; i++) { const m = msg(prompt(s)); if (m) seen.push(m); }
    assert.strictEqual(seen.length, 1);
    assert.match(seen[0], /about \$160/);
  });
});

test('compactions', async (t) => {
  await t.test('says so at 8 compactions', () => {
    assert.match(msg(prompt(setup(Array.from({ length: 8 }, compact)))), /compacted 8 times/);
  });
  await t.test('the word in some other line is not a compaction', () => {
    const fake = JSON.stringify({ type: 'user', toolUseResult: { subtype: 'compact_boundary' } });
    assert.strictEqual(msg(prompt(setup(Array.from({ length: 7 }, compact).concat([fake])))), '');
  });
  await t.test('an assistant line mentioning the word still counts its spend', () => {
    const a = JSON.parse(asst(1, { out: 8e6 }));
    a.note = 'compact_boundary';
    assert.match(msg(prompt(setup([JSON.stringify(a)]))), /about \$160/);
  });
});

test('idle wake', async (t) => {
  await t.test('nudges after 2h idle holding a 300k context', () => {
    assert.match(msg(prompt(setup([asst(1, { ctx: 300e3, ts: ago(2 * 3600e3 + 60e3) })]))), /idle 2h 1m holding a 300k context/);
  });
  await t.test('a small context is not worth a nudge', () => {
    assert.strictEqual(msg(prompt(setup([asst(1, { ctx: 100e3, ts: ago(2 * 3600e3) })]))), '');
  });
  await t.test('a short pause is not a wake', () => {
    assert.strictEqual(msg(prompt(setup([asst(1, { ctx: 300e3, ts: ago(30 * 60e3) })]))), '');
  });
});

test('fails open', async (t) => {
  await t.test('malformed stdin: exit 0, no output', () => {
    const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  });
  await t.test('VIBEQUARTERS_GUARD=off silences it', () => {
    const s = setup([asst(1, { out: 8e6 })]);
    s.extra = { VIBEQUARTERS_GUARD: 'off' };
    assert.strictEqual(msg(prompt(s)), '');
  });
  await t.test('a session id that is not an id writes nothing', () => {
    const s = setup([asst(1, { out: 8e6 })]);
    const r = prompt(s, { session_id: '../../escape' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
    assert.strictEqual(fs.existsSync(s.state), false);
  });
});

test('cost report', async (t) => {
  const root = tmp();
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, SID, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, SID + '.jsonl'), [asst(1, { out: 5e6 }), compact()].join('\n') + '\n');
  fs.writeFileSync(path.join(proj, SID, 'subagents', 'agent-a.jsonl'), asst(2, { out: 3e6 }) + '\n');
  const state = path.join(root, 'state');
  const cost = (args, extra = {}) => spawnSync(process.execPath, [HOOK, '--cost'].concat(args), {
    encoding: 'utf8', env: Object.assign({}, process.env, { USAGE_METER_PROJECTS: root, USAGE_METER_STATE: state }, extra),
  });
  await t.test('totals the main thread and subagents and writes no state', () => {
    const r = cost([SID]);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /about \$160 API-equivalent; subagents: 1, compactions: 1\./);
    assert.strictEqual(fs.existsSync(state), false);
  });
  await t.test('defaults to the calling session', () => {
    assert.match(cost([], { CLAUDE_CODE_SESSION_ID: SID }).stdout, /about \$160/);
  });
  await t.test('negative control: an id with no transcript says so', () => {
    assert.match(cost(['99999999-2222-3333-4444-555555555555']).stdout, /no transcript/);
  });
});

// SessionStart talks to a live server, so the hook must run without blocking this process.
const runAsync = (payload, env) => new Promise((resolve) => {
  const p = spawn(process.execPath, [HOOK], { env: Object.assign({}, process.env, env) });
  let stdout = '';
  p.stdout.on('data', (c) => { stdout += c; });
  p.on('close', (status) => resolve({ status, stdout }));
  p.stdin.end(JSON.stringify(payload));
});

test('week line', async (t) => {
  await t.test('states the 7-day spend from HQ, even mid-refresh', async () => {
    const srv = http.createServer((req, res) => {
      res.end(JSON.stringify({ building: true, today: 56.2, activity: { slots: [{ cost: 1000 }, { cost: 234.5 }] } }));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const rt = path.join(tmp(), 'rt.json');
    fs.writeFileSync(rt, JSON.stringify({ port: srv.address().port }));
    const r = await runAsync({ hook_event_name: 'SessionStart', source: 'startup' }, { USAGE_METER_RUNTIME: rt });
    srv.close();
    assert.strictEqual(r.status, 0);
    assert.match(msg(r), /about \$1,235 API-equivalent \(today \$56\)\./);
  });
  await t.test('no dashboard: exit 0, no output', async () => {
    const r = await runAsync({ hook_event_name: 'SessionStart', source: 'startup' }, { USAGE_METER_RUNTIME: path.join(tmp(), 'missing.json') });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  });
});
