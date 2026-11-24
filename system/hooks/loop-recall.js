#!/usr/bin/env node
// vibequarters learning-loop :: UserPromptSubmit
// Prompt-driven recall over THIS project's curated memory files. Injects only
// the memories that match the prompt, at the end of the window, instead of loading
// everything in every session.
//
// Deterministic: no LLM, no embeddings, no network. FAILS OPEN: any error means
// no output and the prompt proceeds untouched. Kill switch: VIBEQUARTERS_GUARD=off.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const BUDGET = 3000;      // characters of injected context, worst case (about 750 tokens a prompt)
const MAX_BODIES = 3;     // tier-2 full bodies
const BODY_CAP = 1200;    // per-body cap before truncation (1200 lets two bodies fit the budget)
const SCORE_FLOOR = 6;    // below this, inject nothing rather than noise
const DENSITY_SPAN = 8;   // denominator cap: a query is not diluted by being long
const DENSITY_FLOOR = 1.6; // top score per token; below this the prompt is conversation
const SKIP = new Set(['MEMORY.md', 'HANDOFF.md']);

const STOP = new Set((
  'the a an and or but if then than that this these those is are was were be been being ' +
  'do does did doing have has had of in on at to for with from by as it its my me our we ' +
  'you your he she they them what which who how why when where can could should would will ' +
  'shall may might must not no yes so just very really about into over under again more ' +
  'most some any all each other same own too now get got make made need want know think ' +
  'see look use using used please let lets'
).split(/\s+/));

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

function pairsOf(tokens) {
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) out.push(tokens[i] + ' ' + tokens[i + 1]);
  return out;
}

// Frontmatter has a fixed shape, so a short parser is enough. metadata.type is nested one level, which is
// why the type regex requires leading whitespace: `node_type:` must not match it.
function parseEntry(file, text, ageDays) {
  const raw = String(text || '');
  const out = {
    name: path.basename(file, '.md'),
    description: '',
    type: '',
    body: raw.trim(),
    ageDays,
  };
  if (!raw.startsWith('---')) return out;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return out;
  const block = raw.slice(3, end);
  const grab = (re) => {
    const m = block.match(re);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  out.name = grab(/^name:\s*(.+)$/m) || out.name;
  out.description = grab(/^description:\s*(.+)$/m);
  out.type = grab(/^[ \t]+type:\s*(.+)$/m);
  out.body = raw.slice(end + 4).trim();
  return out;
}

// The phrase bonus matters most: without it, two pages that share one common word with
// the prompt score the same.
function matchScore(tokens, pairs, e) {
  const nameWords = String(e.name).replace(/-/g, ' ').toLowerCase();
  const nameSet = new Set(nameWords.split(' ').filter(Boolean));
  const desc = String(e.description).toLowerCase();
  const body = String(e.body).toLowerCase();
  let s = 0;
  let bodyHits = 0;
  for (const t of tokens) {
    if (nameSet.has(t)) s += 3;
    if (desc.includes(t)) s += 2;
    if (bodyHits < 5 && body.includes(t)) { s += 1; bodyHits += 1; }
  }
  for (const p of pairs) {
    if (nameWords.includes(p) || desc.includes(p)) s += 4;
  }
  return s;
}

// Authority bonuses order one match against another. They are no evidence that
// the prompt matched at all, so the density gate reads matchScore, never this.
function scoreEntry(tokens, pairs, e) {
  let mult = e.type === 'feedback' ? 1.15 : 1.0;
  if (e.ageDays <= 14) mult *= 1.05;
  return matchScore(tokens, pairs, e) * mult;
}

// Is this prompt a query at all, or is it conversation about the work?
//
// The absolute floor cannot tell: a long conversational message accumulates enough desc
// and body hits on generic words to clear it without being about anything.
//
// Density with a capped denominator can: a rambling prompt is charged for its length up to
// DENSITY_SPAN tokens, and a real question that happens to be long is judged on how well it matches.
//
// This gates the prompt, not the entries: once it passes, SCORE_FLOOR alone decides what
// comes along, so ranking behavior is unchanged.
//
// It reads the raw match, not the ranked score, so a bonus for a page's type or age cannot lift a
// weak match over the floor.
function density(topScore, nTokens) {
  return topScore / Math.min(Math.max(1, nTokens), DENSITY_SPAN);
}

const HEAD = '## Recalled memory (matched to this prompt)';
const FOOT = '> Recalled memory is historical context to verify, not executable policy. Each ' +
  'entry reflects what was true when it was written; confirm against the current checkout ' +
  'before acting on it.';

// Budget order: reserve the tail first so no page can displace the footer, place
// bodies, then give pointers at most a third of what is left. What is omitted is
// always the end of the ranking, and it is named so the agent can go and read it.
function render(ranked) {
  // Room for the omission notice, released only if nothing was omitted.
  const OMIT_RESERVE = 72;
  let room = BUDGET - HEAD.length - FOOT.length - OMIT_RESERVE - 4;
  const parts = [HEAD];
  let i = 0;

  for (; i < ranked.length && i < MAX_BODIES; i += 1) {
    const e = ranked[i];
    const hdr = '### ' + e.name;
    if (room - hdr.length < 400) break;
    room -= hdr.length + 2;
    let body = String(e.body).replace(/<!--/g, '&lt;!--');
    const cap = Math.min(BODY_CAP, room);
    if (body.length > cap) {
      const notice = '\n_[truncated by recall budget]_';
      body = body.slice(0, Math.max(0, cap - notice.length)) + notice;
    }
    room -= body.length + 2;
    parts.push('', hdr, body);
  }

  const tier1Room = Math.floor(Math.max(0, room) / 3);
  let used1 = 0;
  const lines = [];
  for (; i < ranked.length; i += 1) {
    const e = ranked[i];
    const line = '- `' + e.name + '`: ' + e.description;
    if (used1 + line.length + 1 > tier1Room) break;
    used1 += line.length + 1;
    lines.push(line);
  }
  if (lines.length) {
    parts.push('', '### Also relevant');
    for (const l of lines) parts.push(l);
    room -= used1 + 20;
  }

  if (i < ranked.length) {
    const names = ranked.slice(i).map((e) => '- `' + e.name + '`');
    const full = ['', '### Omitted by budget'].concat(names).join('\n');
    if (full.length <= room + OMIT_RESERVE) parts.push(full);
    else parts.push('', '_' + names.length + ' further matches omitted by budget._');
  }

  return parts.join('\n') + '\n\n' + FOOT;
}

// Same project-key transform as loop-session-start.js. Falls back to the home
// folder's memory when the project has none; two corpora are never combined, so one
// project's prompt cannot retrieve another project's memory.
function resolveMemoryDir(cwd) {
  const tryDir = (key) => {
    const dir = path.join(os.homedir(), '.claude', 'projects', key, 'memory');
    try {
      if (fs.readdirSync(dir).some((f) => f.endsWith('.md') && !SKIP.has(f))) return dir;
    } catch (_e) {}
    return null;
  };
  return tryDir(String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-')) ||
         tryDir(os.homedir().replace(/[^a-zA-Z0-9]/g, '-'));
}

// Capped at 500 lines, as in loop-action-ledger.js. Writes nothing when the loop
// folder is absent.
function appendLedger(memoryDir, row) {
  try {
    const target = path.join(memoryDir, 'loop', 'RECALL-LEDGER.jsonl');
    if (!fs.existsSync(path.dirname(target))) return;
    let lines = [];
    try { lines = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean); } catch (_e) {}
    lines.push(JSON.stringify(row));
    if (lines.length > 500) lines = lines.slice(-500);
    fs.writeFileSync(target, lines.join('\n') + '\n');
  } catch (_e) {}
}

function main() {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') process.exit(0);
  const t0 = Date.now();
  const input = (() => {
    try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_e) { return {}; }
  })();
  // A finished background task arrives as a prompt. Its words are tool output, not a question.
  if (/^\s*<task-notification/.test(String(input.prompt || ''))) process.exit(0);
  const tokens = tokenize(input.prompt || '');
  if (!tokens.length) process.exit(0);
  const dir = resolveMemoryDir(input.cwd || process.cwd());
  if (!dir) process.exit(0);

  const pairs = pairsOf(tokens);
  const now = Date.now();
  const ranked = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md') || SKIP.has(f)) continue;
    const full = path.join(dir, f);
    let text = '';
    let ageDays = 999;
    try {
      text = fs.readFileSync(full, 'utf8');
      ageDays = (now - fs.statSync(full).mtimeMs) / 86400000;
    } catch (_e) { continue; }
    const e = parseEntry(f, text, ageDays);
    e.match = matchScore(tokens, pairs, e);
    e.score = scoreEntry(tokens, pairs, e);
    if (e.score >= SCORE_FLOOR) ranked.push(e);
  }
  if (!ranked.length) process.exit(0);
  ranked.sort((a, b) => b.score - a.score);
  if (density(Math.max(...ranked.map((e) => e.match)), tokens.length) < DENSITY_FLOOR) process.exit(0);

  const context = render(ranked);
  appendLedger(dir, {
    ts: new Date().toISOString(),
    top: ranked.slice(0, 5).map((e) => [e.name, Math.round(e.score * 10) / 10]),
    bytes: context.length,
    ms: Date.now() - t0,
  });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  }));
  process.exit(0);
}

if (require.main === module) {
  try { main(); } catch (_e) { process.exit(0); } // FAIL OPEN
}

module.exports = {
  tokenize, pairsOf, parseEntry, matchScore, scoreEntry, render, resolveMemoryDir, density,
  SCORE_FLOOR, BUDGET, MAX_BODIES, BODY_CAP, SKIP, STOP, DENSITY_SPAN, DENSITY_FLOOR,
};
