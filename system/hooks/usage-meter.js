#!/usr/bin/env node
// vibequarters usage meter :: SessionStart + UserPromptSubmit
// Shows what a session has used so far, so a weekly plan limit does not come as a surprise.
//
// SessionStart (startup, resume): one line with the last 7 days' spend, read from the VibeQuarters
// app's own index over 127.0.0.1 (/api/stats), so nothing is parsed twice. No app, no line.
// UserPromptSubmit: follows THIS session's transcript and its subagents, reading only what
// was appended since the last prompt, and says so once each time the session passes
// another $150 or another 8 compactions, and once when it wakes after 60+ minutes idle
// holding a 250k+ context (the usage.* values in vibequarters.config.json).
//
// `node usage-meter.js --cost [session-id]` prints what a session (the current one unless an id is given) has used,
// without touching the meter's state.
//
// Dollars are API list prices (the app's pricing.js), a yardstick only: how the plan meter
// weighs tokens is not published. FAILS OPEN: any error means no output and the prompt
// proceeds untouched. Kill switch: VIBEQUARTERS_GUARD=off.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const P = require('./vibequarters-config');

const HOME = os.homedir();
const CFG = P.load();
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const STATE_DIR = process.env.USAGE_METER_STATE || path.join(HOME, '.claude', 'cache', 'usage-meter');
const RUNTIME = process.env.USAGE_METER_RUNTIME || (P.appState() ? path.join(P.appState(), '.runtime.json') : '');
const PROJECTS = process.env.USAGE_METER_PROJECTS || path.join(HOME, '.claude', 'projects');
// The price table: the app's pricing.js when appDir names the app, else the copy the installer puts in <systemDir>/lib.
// Neither there: the meter stays silent.
function pricingFile() {
  const app = P.expand(CFG.appDir) ? path.join(P.expand(CFG.appDir), 'pricing.js') : '';
  if (app && fs.existsSync(app)) return app;
  return path.join(__dirname, '..', 'lib', 'pricing.js');
}
const PRICING = process.env.USAGE_METER_PRICING || pricingFile();
const BUDGET = Number(process.env.USAGE_METER_BUDGET) || 128 * 1024 * 1024; // bytes read per prompt; a larger transcript catches up over several prompts
const CHUNK = Number(process.env.USAGE_METER_CHUNK) || 8 * 1024 * 1024; // read in slices so a catch-up never holds more than this in memory
const COST_STEP = num(CFG.usage.stepUsd, 150);
const COMPACT_STEP = num(CFG.usage.compactions, 8);
const IDLE_MS = num(CFG.usage.idleMinutes, 60) * 60e3; // past the 1 h cache lifetime the next call rewrites the whole context
const BIG_CTX = num(CFG.usage.contextTokens, 250e3);

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const hm = (ms) => {
  const m = Math.floor(ms / 60e3);
  return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm';
};

function emit(event, text) {
  process.stdout.write(JSON.stringify({
    systemMessage: text,
    hookSpecificOutput: { hookEventName: event, additionalContext: '[usage-meter] ' + text },
  }));
}

function getJson(url, ms) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: ms }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (_e) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// The dashboard flags `building` during every periodic refresh while the last good stats
// stay in the payload, so the slots decide, not the flag.
async function weekLine() {
  const rt = JSON.parse(fs.readFileSync(RUNTIME, 'utf8'));
  const s = await getJson('http://127.0.0.1:' + Number(rt.port) + '/api/stats', 1500);
  if (!s || !s.activity || !Array.isArray(s.activity.slots)) return null;
  const week = s.activity.slots.reduce((a, x) => a + (Number(x.cost) || 0), 0);
  // A rolling window in API-equivalent dollars, never a percentage of a plan limit it cannot see (the usage-line mod
  // shows that).
  return 'Usage, last 7 days: about ' + money(week) + ' API-equivalent (today ' + money(Number(s.today) || 0) + ').';
}

// Reads what was appended to fp since f.off, at most `room` bytes, slice by slice, each
// ending on a line break so no line is half-parsed. A single line longer than a whole
// slice is skipped rather than stalled on. Returns [bytes consumed, bytes still unread].
function follow(fp, f, room, onLine) {
  let size;
  try { size = fs.statSync(fp).size; } catch (_e) { return [0, 0]; }
  if (size < f.off) Object.assign(f, { off: 0, cost: 0, ids: [] }); // rewritten in place: start over
  let used = 0;
  const fd = fs.openSync(fp, 'r');
  try {
    while (used < room && f.off < size) {
      const want = Math.min(CHUNK, room - used, size - f.off);
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, f.off);
      const end = buf.lastIndexOf(10);
      if (end === -1) {
        if (want < CHUNK) break; // room or file ended mid-line: pick it up next prompt
        f.off += want;
        used += want;
        continue;
      }
      for (const line of buf.toString('utf8', 0, end).split('\n')) onLine(line);
      f.off += end + 1;
      used += end + 1;
    }
  } finally { fs.closeSync(fd); }
  return [used, size - f.off];
}

// Claude Code writes one assistant message as several lines that repeat its usage, hence
// the id window. A compaction is a system line; the bare word also turns up inside tool
// output, so only a parsed system line counts.
function lineReader(f, isMain, st, costForUsage) {
  return (line) => {
    const maybeCompact = isMain && line.includes('"compact_boundary"');
    const maybeUsage = line.includes('"type":"assistant"') && line.includes('"usage"');
    if (!maybeCompact && !maybeUsage) return;
    let o;
    try { o = JSON.parse(line); } catch (_e) { return; }
    if (maybeCompact && o.type === 'system' && o.subtype === 'compact_boundary') { st.compacts += 1; return; }
    const m = o.message;
    if (o.type !== 'assistant' || !m || !m.usage || m.model === '<synthetic>') return;
    const id = (m.id || '') + '|' + (o.requestId || '');
    if (f.ids.includes(id)) return;
    f.ids.push(id);
    if (f.ids.length > 20) f.ids.shift();
    f.cost += costForUsage(m.model, m.usage).cost;
    if (isMain) {
      const u = m.usage;
      st.lastTs = Date.parse(o.timestamp) || st.lastTs;
      st.lastCtx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    }
  };
}

function subagentFiles(tp, id) {
  const dir = path.join(path.dirname(tp), id, 'subagents');
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n)); } catch (_e) { return []; }
}

function costReport(id) {
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) return 'usage-meter: no session id';
  const tp = fs.readdirSync(PROJECTS).map((p) => path.join(PROJECTS, p, id + '.jsonl')).find((f) => fs.existsSync(f));
  if (!tp) return 'usage-meter: no transcript for ' + id;
  const { costForUsage } = require(PRICING);
  const st = { compacts: 0 };
  const subs = subagentFiles(tp, id);
  let total = 0;
  for (const fp of [tp].concat(subs)) {
    const f = { off: 0, cost: 0, ids: [] };
    follow(fp, f, Infinity, lineReader(f, fp === tp, st, costForUsage));
    total += f.cost;
  }
  return 'This session so far: about ' + money(total) + ' API-equivalent; subagents: ' + subs.length + ', compactions: ' + st.compacts + '.';
}

function save(file, st) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, file);
}

function sessionLine(input) {
  const id = String(input.session_id || '');
  const tp = String(input.transcript_path || '');
  if (!/^[0-9a-f-]{8,64}$/i.test(id) || !tp.endsWith('.jsonl')) return null;
  const { costForUsage } = require(PRICING);
  const file = path.join(STATE_DIR, id + '.json');
  let st;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) {
    st = { files: {}, compacts: 0, lastTs: 0, lastCtx: 0, warnedCost: 0, warnedCompacts: 0 };
  }

  const subs = subagentFiles(tp, id);
  let room = BUDGET;
  let unread = 0;
  for (const fp of [tp].concat(subs)) {
    const f = st.files[fp] || (st.files[fp] = { off: 0, cost: 0, ids: [] });
    const [used, left] = follow(fp, f, room, lineReader(f, fp === tp, st, costForUsage));
    room -= used;
    unread += left;
  }

  // Judged only once caught up, so a resumed session that takes several prompts to read
  // warns once at its real total instead of once per step on the way there.
  const out = [];
  if (unread === 0) {
    const total = Object.values(st.files).reduce((a, f) => a + f.cost, 0);
    const c = Math.floor(total / COST_STEP);
    const k = Math.floor(st.compacts / COMPACT_STEP);
    const flags = [];
    if (c > st.warnedCost) { st.warnedCost = c; flags.push('has used about ' + money(total) + ' API-equivalent'); }
    if (k > st.warnedCompacts) { st.warnedCompacts = k; flags.push('has compacted ' + st.compacts + ' times, each one dropping detail'); }
    if (flags.length) out.push('This session ' + flags.join(' and ') + '. Consider checkpointing to the ledger and continuing in a fresh session; SPOT carries the state.');
    const idle = Date.now() - st.lastTs;
    if (st.lastTs && idle >= IDLE_MS && st.lastCtx >= BIG_CTX) {
      out.push('This session sat idle ' + hm(idle) + ' holding a ' + Math.round(st.lastCtx / 1000) + 'k context, so this reply reloads all of it. If it will wait again, close it and resume fresh from SPOT.');
    }
  }
  save(file, st);
  return out.join(' ');
}

async function main() {
  if (process.argv[2] === '--cost') {
    if (!PRICING || !fs.existsSync(PRICING)) { process.stdout.write('usage-meter: no price table (set appDir in vibequarters.config.json to the VibeQuarters app folder)\n'); return; }
    process.stdout.write(costReport(process.argv[3] || process.env.CLAUDE_CODE_SESSION_ID || '') + '\n');
    return;
  }
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') return;
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_e) { return; }
  const ev = input.hook_event_name;
  if (!PRICING || !fs.existsSync(PRICING)) return; // no price table: nothing to measure with
  const text = ev === 'SessionStart' ? (RUNTIME ? await weekLine() : null) : ev === 'UserPromptSubmit' ? sessionLine(input) : null;
  if (text) emit(ev, text);
}

if (require.main === module) {
  main().catch(() => {}).finally(() => process.exit(0)); // FAIL OPEN
}

module.exports = { follow, money, hm };
