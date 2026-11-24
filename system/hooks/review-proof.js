// review-proof.js: proves a fresh reviewer subagent (on mergeGate.reviewerModel, default Opus) passed this exact PR head.
//
// Before a session merges its PR it starts a reviewer subagent with reviewPrompt(), and writeVerdict() saves the verdict
// under ~/.claude/coordination/reviews (see reviewFile):
//   line 1: ... head <head>, agent <agentId>, session <sessionId>[, delta over <full 40-hex sha>] ...
//   below line 1: the reviewer's last message (or SubagentHandback message) from its transcript, ending on its VERDICT
//   line (formats: CLEAN_LINE and reviewPrompt below)
// proveReview() does not trust that file alone: it reads the reviewer's own transcript under the merging session, and
// for a delta review it proves the base review's reviewer the same way, down the chain.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./vibequarters-config');

// The model a reviewer must run on, as a pattern ('' accepts any), and its name for messages.
function reviewerModel() {
  const want = String(P.load().mergeGate.reviewerModel ?? 'opus');
  return { re: want ? P.regex(want, 'i') || /opus/i : /./, name: want || 'any model' };
}

const SAFE_ID = /^[\w-]+$/;
// Claude Code names every session by a UUID; any other name is a folder a tab could have planted under projects/<key>.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The whole line, end anchored, so nothing ("..., 1 Important") can follow the Minor count. Matched on the line with
// markdown bold and backticks stripped, any case, a hyphen or colon after CLEAN, Minor or Minors.
const CLEAN_LINE = /^VERDICT\s*:\s*CLEAN\s*[-:]\s*0 Critical\s*,\s*0 Important\s*,\s*\d+ Minors?\.?$/i;
const bare = (l) => l.replace(/[*`]/g, '').trim();

// The verdict of a message: its last VERDICT line (earlier ones may quote an old review), with only formatting such
// as a rule after it. Null when there is none, when any other text follows it, or when it sits in a code block
// (fenced, or indented 4 spaces or a tab): a code block is a quote, never the reviewer's own verdict.
// Fences follow CommonMark: ``` or ~~~ opens, only the same character at least as long closes, and a backtick
// line with another backtick after its opener (```npm test```) is inline code, not a fence.
function verdictOf(text) {
  let fence = null;
  const lines = [];
  const raws = String(text || '').split(/\r?\n/);
  // After the reviewer's own verdict only blank lines and rules may follow, read RAW (bare() strips backticks), so a
  // closing fence after a quoted verdict, list item or not, always denies. This closes the class, not one shape.
  const lastV = raws.map((r) => /^VERDICT\s*:/i.test(bare(r))).lastIndexOf(true);
  if (lastV < 0 || /^\s*(```|~~~)/.test(raws[lastV]) || raws.slice(lastV + 1).some((r) => !/^[\s\-=_*]*$/.test(r))) return null;
  for (const raw of raws) {
    const f = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      else if (bare(raw)) lines.push({ l: bare(raw), code: true });
      continue;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = f[1]; continue; }
    const l = bare(raw);
    if (l) lines.push({ l, code: /^ {0,3}\t| {4}/.test(raw.match(/^\s*/)[0]) });
  }
  const at = lines.map(({ l }) => /^VERDICT\s*:/i.test(l)).lastIndexOf(true);
  if (at < 0 || lines[at].code || lines.slice(at + 1).some(({ l }) => !/^[-=_~]+$/.test(l))) return null;
  return lines[at].l;
}
const MAX_DELTA_DEPTH = 10;

const field = (line, re) => (line.match(re) || [])[1];
const HEAD_FIELD = /\bhead ([0-9a-f]{7,40})\b/i;
const AGENT_FIELD = /\bagent (\S+?)(?=[,;\s]|$)/;
const SESSION_FIELD = /\bsession (\S+?)(?=[,;\s]|$)/;
const DELTA_FIELD = /\bdelta over (\S+?)(?=[,;\s]|$)/i;

// The first line of every reviewPrompt().
function openingLine({ repo, pr, head, deltaOver }) {
  return deltaOver
    ? `Delta review of ${repo} PR #${pr} at head ${head}, over the earlier reviewed head ${deltaOver}.`
    : `Full review of ${repo} PR #${pr} at head ${head}.`;
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_e) { return null; } };

// The text of a message's content: a string, or its text blocks joined; null when it holds no text.
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return texts.length ? texts.join('\n') : null;
}

// The final report a subagent hands back: the message of a SubagentHandback call, null when the content holds none.
function handbackOf(content) {
  if (!Array.isArray(content)) return null;
  const b = content.find((x) => x && x.type === 'tool_use' && x.name === 'SubagentHandback' && x.input && typeof x.input.message === 'string');
  return b ? b.input.message : null;
}

// From a subagent transcript: the first user message (its brief), the last assistant text (a SubagentHandback message
// counts, since a subagent here ends on that call), every model its assistant lines ran on, and `steered`: what, if
// anything, reached it after the brief besides tool results and harness notes. A parent's SendMessage lands as an
// isMeta line with origin.kind "coordinator", or, while the reviewer runs, as a queued_command attachment line with
// that origin; a compaction as a non-meta isCompactSummary line.
function readTranscript(file) {
  let firstUser = null;
  let lastAssistant = null;
  let steered = null;
  const models = new Set();
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try { line = JSON.parse(raw); } catch (_e) { continue; }
    const message = (line && line.message) || {};
    if (line.type === 'assistant') {
      if (message.model && message.model !== '<synthetic>') models.add(message.model);
      const text = handbackOf(message.content) ?? textOf(message.content);
      if (text !== null) lastAssistant = text;
    } else if (line.type === 'user') {
      const text = textOf(message.content);
      if (firstUser === null) {
        if (text !== null) firstUser = text;
      } else if (line.origin && line.origin.kind === 'coordinator') {
        steered = steered || 'a message from its parent session';
      } else if (line.isMeta !== true && text) {
        steered = steered || (line.isCompactSummary ? 'a compaction summary' : 'a later user message');
      }
    } else if (line.type === 'attachment' && line.attachment && line.attachment.type === 'queued_command' &&
      line.attachment.origin && line.attachment.origin.kind === 'coordinator') {
      steered = steered || 'a message from its parent session';
    }
  }
  return { firstUser, lastAssistant, steered, models: [...models] };
}

// <home>/.claude/projects/<key>/<sessionId>/subagents/agent-<agentId>.meta.json, found by reading projects one level
// deep (a recursive scan of projects can take minutes).
function findAgent(home, sessionId, agentId) {
  const projects = path.join(home, '.claude', 'projects');
  let keys;
  try { keys = fs.readdirSync(projects); } catch (_e) { return null; }
  for (const key of keys) {
    const base = path.join(projects, key, sessionId, 'subagents', `agent-${agentId}`);
    if (fs.existsSync(`${base}.meta.json`)) return { meta: `${base}.meta.json`, jsonl: `${base}.jsonl` };
  }
  return null;
}

const reviewFile = (home, repo, pr, head) => path.join(home, '.claude', 'coordination', 'reviews', `${repo}-${pr}-${head}.txt`);

// Proves the review of `head` in <reviews>/<repo>-<pr>-<head>.txt. `clean` (the head being merged) also demands a
// CLEAN verdict in the file and as the reviewer's own last line; a delta's base review (clean false) must only be a
// real review, and its reviewer is looked up in the session its own line 1 names. `seen` holds the heads already
// walked, so a delta cycle stops on its first repeat.
function proveOne({ repo, pr, head, base, sessionId, home, clean, depth, seen }) {
  const short = head.slice(0, 9);
  const deny = (reason) => ({ ok: false, reason });

  // 1. The verdict file for this head, CLEAN with 0 Critical and 0 Important.
  const file = reviewFile(home, repo, pr, head);
  let body;
  try { body = fs.readFileSync(file, 'utf8'); } catch (_e) { return deny(`no review for head ${short}; delta review it`); }
  const lines = body.split(/\r?\n/);
  const line1 = lines[0] || '';
  const named = field(line1, HEAD_FIELD);
  if (!named || named.toLowerCase() !== head.toLowerCase()) {
    return deny(`the review file for head ${short} names head ${named || 'none'} on line 1`);
  }
  if (clean) {
    // Only the last VERDICT line counts: a delta reviewer may quote the earlier review's VERDICT line above it.
    const verdict = verdictOf(lines.slice(1).join('\n'));
    if (!verdict) return deny(`the review for head ${short} has no VERDICT line as its last line`);
    if (!CLEAN_LINE.test(verdict)) return deny(`the review for head ${short} is not clean: ${verdict}`);
  }

  // 2. The reviewer: a finished, non-fork subagent of the session, on the configured model.
  const named1 = field(line1, SESSION_FIELD);
  if (named1 && !SESSION_ID.test(named1)) return deny(`the review for head ${short} names session ${named1} on line 1, which is not a UUID`);
  const sid = sessionId || named1;
  if (!sid || !SESSION_ID.test(sid)) return deny(`the review for head ${short} names no valid session id on line 1`);
  const agentId = field(line1, AGENT_FIELD);
  if (!agentId || !SAFE_ID.test(agentId)) return deny(`the review for head ${short} names no valid agent id on line 1`);
  const found = findAgent(home, sid, agentId);
  if (!found) return deny(`reviewer agent ${agentId} is not a subagent of session ${sid}`);
  const meta = readJson(found.meta);
  if (!meta) return deny(`reviewer agent ${agentId} has an unreadable meta file`);
  // A fork carries the parent's context, and a custom agent type its own system prompt the transcript cannot show.
  if (meta.agentType !== 'general-purpose') {
    return deny(`reviewer agent ${agentId} is a ${meta.agentType || 'unknown'} agent, not a fresh general-purpose reviewer`);
  }
  if (meta.finished !== true) return deny(`reviewer agent ${agentId} has not finished`);
  const want = reviewerModel();
  const model = meta.pickedEffortModel || meta.model || '';
  if (!want.re.test(model)) return deny(`reviewer agent ${agentId} ran on ${model || 'an unknown model'}, not ${want.name}`);
  let t;
  try { t = readTranscript(found.jsonl); } catch (_e) { return deny(`reviewer agent ${agentId} has no readable transcript`); }
  // The meta alone is not enough: the model a subagent asked for and the one it ran on can differ.
  const notWanted = t.models.find((m) => !want.re.test(m));
  if (!t.models.length || notWanted) return deny(`reviewer agent ${agentId} ran on ${notWanted || 'no recorded model'}, not ${want.name}`);

  // 3. Its whole brief is exactly reviewPrompt() rebuilt here from this repo, PR, head, the PR's base ref and line 1's
  // scope, never from the brief itself: a delta brief needs the file to declare the same full delta sha and names that
  // base's own verdict file as the prior review; a full brief forbids a delta.
  const deltaOver = field(line1, DELTA_FIELD) || null;
  if (deltaOver && !/^[0-9a-f]{40}$/i.test(deltaOver)) return deny(`delta over ${deltaOver} is not a full 40-character sha`);
  const expected = reviewPrompt({ repo, pr, head, base, deltaOver, priorFile: deltaOver ? reviewFile(home, repo, pr, deltaOver) : undefined });
  if ((t.firstUser || '').trimEnd() !== expected.trimEnd()) {
    return deny(`reviewer agent ${agentId}'s brief is not the exact ${deltaOver ? `delta (over ${deltaOver.slice(0, 9)})` : 'full'} review brief for ${repo} PR #${pr} head ${short} against ${base}`);
  }
  if (t.steered) return deny(`reviewer agent ${agentId} received ${t.steered} after its brief`);

  // 4. Its own last VERDICT line is a CLEAN verdict.
  if (clean) {
    const v = verdictOf(t.lastAssistant);
    if (!v || !CLEAN_LINE.test(v)) {
      const lastLine = v || (t.lastAssistant || '').split(/\r?\n/).map(bare).filter(Boolean).pop();
      return deny(`reviewer agent ${agentId}'s last line is not a CLEAN verdict: ${lastLine || 'none'}`);
    }
  }
  // The file's text below line 1 is the reviewer's own last message, so the findings a delta re-confirms are real.
  const own = (t.lastAssistant || '').replace(/\r\n/g, '\n').trimEnd();
  if (!own || lines.slice(1).join('\n').trimEnd() !== own) {
    return deny(`the review file for head ${short} does not hold reviewer agent ${agentId}'s last message below line 1`);
  }

  // 5. A delta review needs a proven review of the head it builds on (any verdict), down the chain.
  if (deltaOver) {
    const want = deltaOver.toLowerCase();
    if (want === head.toLowerCase() || seen.has(want)) return deny(`delta over ${deltaOver} is a cycle: that head is already in this review chain`);
    if (depth >= MAX_DELTA_DEPTH) return deny(`delta chain from head ${short} is deeper than ${MAX_DELTA_DEPTH}`);
    if (!fs.existsSync(reviewFile(home, repo, pr, deltaOver))) return deny(`delta over ${deltaOver}, but there is no review of PR #${pr} at ${deltaOver}`);
    const r = proveOne({ repo, pr, head: deltaOver, base, sessionId: null, home, clean: false, depth: depth + 1, seen: new Set([...seen, head.toLowerCase()]) });
    if (!r.ok) return deny(`delta over ${deltaOver}, but its base review is not proven: ${r.reason}`);
  }

  return { ok: true, file, agentId };
}

// base: the PR's base ref as the reviewer was briefed with it, e.g. "origin/main".
function proveReview({ repo, pr, head, sessionId, base = 'origin/main', home = os.homedir() }) {
  try {
    if (!/^[0-9a-f]{40}$/i.test(String(head))) return { ok: false, reason: `head ${head} is not a 40-character sha` };
    if (!SAFE_ID.test(String(repo)) || !/^\d+$/.test(String(pr))) return { ok: false, reason: `bad repo or PR number (${repo}, ${pr})` };
    if (!SESSION_ID.test(String(sessionId))) return { ok: false, reason: `session id ${sessionId} is not a UUID` };
    if (typeof base !== 'string' || !/^\S+$/.test(base)) return { ok: false, reason: `bad base ref ${base}` };
    return proveOne({
      repo: String(repo), pr: String(pr), head: String(head), base, sessionId: String(sessionId), home, clean: true, depth: 0, seen: new Set(),
    });
  } catch (e) {
    return { ok: false, reason: `review proof failed: ${e && e.message}` };
  }
}

// Writes the verdict file for head from the reviewer's own transcript: line 1 as proveOne parses it, then the
// reviewer's last message (the text proveOne compares). The tab never copies the message itself, since the hand-back
// reaches it indented and framed by the harness. Writes a NOT CLEAN review too (a delta's base); proveReview judges.
// Returns { ok: true, file } or { ok: false, reason }; never throws.
function writeVerdict({ home = os.homedir(), repo, pr, head, sessionId, agentId, deltaOver }) {
  try {
    if (!/^[0-9a-f]{40}$/i.test(String(head))) return { ok: false, reason: `head ${head} is not a 40-character sha` };
    if (!SAFE_ID.test(String(repo)) || !/^\d+$/.test(String(pr))) return { ok: false, reason: `bad repo or PR number (${repo}, ${pr})` };
    if (!SESSION_ID.test(String(sessionId))) return { ok: false, reason: `session id ${sessionId} is not a UUID` };
    if (!SAFE_ID.test(String(agentId))) return { ok: false, reason: `agent id ${agentId} is not a plain id` };
    if (deltaOver && !/^[0-9a-f]{40}$/i.test(String(deltaOver))) return { ok: false, reason: `delta over ${deltaOver} is not a full 40-character sha` };
    const found = findAgent(home, String(sessionId), String(agentId));
    if (!found) return { ok: false, reason: `reviewer agent ${agentId} is not a subagent of session ${sessionId}` };
    const own = (readTranscript(found.jsonl).lastAssistant || '').replace(/\r\n/g, '\n').trimEnd();
    if (!own) return { ok: false, reason: `reviewer agent ${agentId} has no last message yet` };
    const file = reviewFile(home, String(repo), String(pr), String(head));
    const line1 = `PR #${pr} head ${head}, agent ${agentId}, session ${sessionId}${deltaOver ? `, delta over ${deltaOver}` : ''}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${line1}\n${own}\n`);
    return { ok: true, file };
  } catch (e) {
    return { ok: false, reason: `could not write the verdict file: ${e && e.message}` };
  }
}

// The fixed reviewer brief /land sends a fresh reviewer subagent. The verdict rule is the last line on purpose.
// proveReview compares a reviewer's brief to this byte for byte, so it must stay deterministic: no dates, no random text.
function reviewPrompt({ repo, pr, head, base, deltaOver, priorFile }) {
  const missing = Object.entries({ repo, pr, head, base, ...(deltaOver ? { priorFile } : {}) })
    .filter(([, v]) => v === undefined || v === null || v === '').map(([k]) => k);
  if (missing.length) throw new Error(`reviewPrompt needs ${missing.join(', ')}`);
  const scope = deltaOver
    ? [
      openingLine({ repo, pr, head, deltaOver }),
      `Review the change from ${deltaOver} to ${head} (git diff ${deltaOver} ${head}) in this checkout.`,
      `Read the earlier review at ${priorFile}. Confirm every Critical and Important finding in it is fixed at ${head};`,
      'any that is not fixed is still a finding at its old severity. Also review the new lines for new issues.',
      `For context, the full PR is the diff from ${base} to ${head} (git diff ${base}...${head}).`,
    ]
    : [
      openingLine({ repo, pr, head }),
      `Review the whole diff from ${base} to ${head} (git diff ${base}...${head}) in this checkout.`,
    ];
  return [
    ...scope,
    'Look for correctness bugs, security holes, data loss, broken tests and anything that would harm the live product.',
    'Read the code itself; do not trust commit messages or PR text. Do not edit, commit, push or merge anything.',
    'Rank each finding Critical, Important or Minor, with file and line.',
    'Write no em or en dashes.',
    'Your last line must be exactly VERDICT: CLEAN - 0 Critical, 0 Important, N Minor (N your Minor count) when there is no Critical or Important finding, or else VERDICT: NOT CLEAN - <counts and the findings in one line>.',
  ].join('\n');
}

// reviewFile: the verdict file path; /land passes it as a delta's priorFile so the brief matches byte for byte.
module.exports = { proveReview, reviewPrompt, reviewFile, writeVerdict };

// What /land runs: node review-proof.js prompt|write|prove --repo r --pr n --head sha [--base ref] [--session id] [--agent id] [--delta-over sha]
if (require.main === module) {
  const [what, ...rest] = process.argv.slice(2);
  const o = {};
  for (let k = 0; k < rest.length; k += 2) o[String(rest[k]).replace(/^--/, '')] = rest[k + 1];
  const home = os.homedir();
  const at = { repo: o.repo, pr: o.pr, head: o.head };
  const deltaOver = o['delta-over'];
  try {
    if (what === 'prompt') process.stdout.write(reviewPrompt({ ...at, base: o.base, deltaOver, priorFile: deltaOver && reviewFile(home, o.repo, o.pr, deltaOver) }));
    else if (what === 'write' || what === 'prove') {
      const r = what === 'write' ? writeVerdict({ ...at, sessionId: o.session, agentId: o.agent, deltaOver }) : proveReview({ ...at, sessionId: o.session, ...(o.base ? { base: o.base } : {}) });
      console.log(JSON.stringify(r));
      process.exitCode = r.ok ? 0 : 1;
    } else throw new Error('the first word is prompt, write or prove');
  } catch (e) {
    console.error(`review-proof: ${e.message}`);
    process.exitCode = 1;
  }
}
