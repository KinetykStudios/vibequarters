#!/usr/bin/env node
// vibequarters learning-loop :: SPOT.md, the resume point
//   Stop, PreCompact          write the latest request, the latest reply and the git state
//   PostCompact, SessionStart add that file to the context again
// The file is replaced every turn; lasting lessons are in the ledgers.
// FAILS OPEN: any error -> exit 0, session proceeds normally. Kill switch: VIBEQUARTERS_GUARD=off.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const MAX_USER = 2000;      // characters of the latest request to keep
const MAX_ASSISTANT = 9000; // chars of the last reply to keep
// A shorter reply seen at PreCompact is taken for a fragment of an unfinished turn.
const SUBSTANTIVE_REPLY = 800;
const STALE_DAYS = 7;       // do not re-inject a spot older than this

// Same project-key convention as loop-session-start.js: cwd, non-alphanumerics -> dashes.
function loopDirFor(cwd) {
  const key = String(cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', key, 'memory', 'loop');
}

function clip(s, max) {
  if (!s || s.length <= max) return s || '';
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return s.slice(0, head) + '\n[.. clipped ..]\n' + s.slice(-tail);
}

function gitState(cwd) {
  try {
    const opts = { cwd, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] };
    const branch = execSync('git branch --show-current', opts).toString().trim();
    const porcelain = execSync('git status --porcelain', opts).toString().trim();
    const dirty = porcelain ? porcelain.split('\n').length : 0;
    return 'branch ' + (branch || '(detached)') + ', ' + dirty + ' dirty file(s)';
  } catch (_e) {
    return 'not a git repo';
  }
}

// Harness-injected wrapper tags around user text (reminders, command echoes, IDE context).
// Strip them so the real ask underneath survives; repeat to handle adjacent blocks.
function stripWrappers(txt) {
  let prev;
  do {
    prev = txt;
    txt = txt.replace(/<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, '');
  } while (txt !== prev);
  return txt.trim();
}

// Transcripts can be large and both messages are near the end, so read a tail first and widen it
// only if something is missing. The last step is the whole file.
const TAIL_STEPS = [1 << 20, 8 << 20, Infinity]; // 1 MB, 8 MB, everything

function readTail(p, bytes) {
  const size = fs.statSync(p).size;
  if (!isFinite(bytes) || bytes >= size) return fs.readFileSync(p, 'utf8');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(bytes);
    fs.readSync(fd, buf, 0, bytes, size - bytes);
    const text = buf.toString('utf8');
    // The first line is almost certainly a JSON object cut in half; drop it rather than
    // feeding a truncated line to JSON.parse on every scan.
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(nl + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

// Walk the transcript backwards for the last real user ask and last assistant text.
function lastMessages(transcriptPath) {
  let out = { user: '', assistant: '' };
  if (!transcriptPath) return out;
  let size = 0;
  try { size = fs.statSync(transcriptPath).size; } catch (_e) { return out; }
  for (const step of TAIL_STEPS) {
    let raw = '';
    try { raw = readTail(transcriptPath, step); } catch (_e) { return out; }
    out = scanBackwards(raw);
    // Found both, or we just read the entire file and this is as good as it gets.
    if ((out.user && out.assistant) || step >= size) break;
  }
  return out;
}

function scanBackwards(raw) {
  const out = { user: '', assistant: '' };
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && !(out.user && out.assistant); i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch (_e) { continue; }
    if (!e || e.isMeta || !e.message || !e.message.content) continue;
    if (!out.assistant && e.type === 'assistant') {
      const blocks = Array.isArray(e.message.content) ? e.message.content : [];
      const txt = blocks.filter(function (b) { return b && b.type === 'text' && b.text; })
        .map(function (b) { return b.text; }).join('\n').trim();
      if (txt) out.assistant = txt;
    } else if (!out.user && e.type === 'user') {
      let txt = '';
      const c = e.message.content;
      if (typeof c === 'string') txt = c;
      else if (Array.isArray(c)) {
        txt = c.filter(function (b) { return b && b.type === 'text' && b.text; })
          .map(function (b) { return b.text; }).join('\n');
      }
      txt = stripWrappers((txt || '').trim());
      // Skip tool results, leftover tag junk, caveats, and interrupt markers.
      if (txt && txt[0] !== '<' && !/^Caveat:/.test(txt) &&
          !/^\[Request interrupted/.test(txt)) out.user = txt;
    }
  }
  return out;
}

function writeSpot(input, event) {
  const cwd = input.cwd || process.cwd();
  const dir = loopDirFor(cwd);
  const msgs = lastMessages(input.transcript_path);
  if (!msgs.user && !msgs.assistant) return; // nothing worth saving
  fs.mkdirSync(dir, { recursive: true });
  const savedOn = event + (input.trigger ? ' (' + input.trigger + ')' : '');
  const spotPath = path.join(dir, 'SPOT.md');

  // An automatic compaction can happen in the middle of a turn, when the last reply is only a short
  // fragment. PreCompact then keeps the longer reply already saved for the same session.
  let assistant = msgs.assistant;
  let kept = false;
  if (event === 'PreCompact' && (assistant || '').length < SUBSTANTIVE_REPLY) {
    try {
      const prev = fs.readFileSync(spotPath, 'utf8');
      const sameSession = prev.includes('- session: ' + (input.session_id || '\u0000'));
      const m = /## Latest reply\n\n([\s\S]*)$/.exec(prev);
      const prevReply = m ? m[1].trim() : '';
      if (sameSession && prevReply.length >= SUBSTANTIVE_REPLY && prevReply.length > (assistant || '').length) {
        assistant = prevReply;
        kept = true;
      }
    } catch (_e) { /* no prior SPOT: write what we have */ }
  }
  const md = [
    '# Resume point (loop-spot.js)',
    '',
    '> Replaced every turn. Where a summary differs, this file is right.',
    '',
    '- when: ' + new Date().toISOString(),
    '- saved-on: ' + savedOn + (kept ? ' (earlier full reply kept)' : ''),
    '- cwd: ' + cwd,
    '- git: ' + gitState(cwd),
    '- session: ' + (input.session_id || 'unknown'),
    '',
    '## Latest request',
    '',
    clip(msgs.user, MAX_USER) || '(none captured)',
    '',
    '## Latest reply',
    '',
    clip(assistant, MAX_ASSISTANT) || '(none captured)',
    '',
  ].join('\n');
  fs.writeFileSync(spotPath, md, 'utf8');
}

function injectSpot(input, event) {
  const cwd = input.cwd || process.cwd();
  const spotPath = path.join(loopDirFor(cwd), 'SPOT.md');
  let spot = '';
  try { spot = fs.readFileSync(spotPath, 'utf8'); } catch (_e) { return; }
  if (!spot.trim()) return;
  // Skip stale spots so an old project does not boot with weeks-old state.
  const m = spot.match(/^- when: (.+)$/m);
  if (m) {
    const age = Date.now() - Date.parse(m[1]);
    if (isFinite(age) && age > STALE_DAYS * 24 * 3600 * 1000) return;
  }
  // Sessions in one folder share the file, so it may hold another session's state. That is shown with a
  // label and without the line that says the file is right.
  const owner = ((spot.match(/^- session: (.+)$/m) || [])[1] || '').trim();
  const foreign = Boolean(owner && owner !== 'unknown' && input.session_id && owner !== input.session_id);
  const header = foreign ? [
    '## Resume point of another session (' + owner + ')',
    '',
    'SPOT.md is shared by all sessions in this folder, and a different session wrote it last.',
    'It can be your own conversation from before a /clear; use it if the request in it is yours.',
  ] : [
    '## Resume point',
    '',
    'Saved by loop-spot.js when the last turn ended: the latest request and reply, word for word.',
    'Continue from here. Where a summary differs, this file is right.',
  ];
  const body = foreign
    ? spot.trim().replace(/^> .*this file is right.*$/m, '> (written by another session)')
    : spot.trim();
  const ctx = header.concat(['', body]).join('\n');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: ctx },
  }));
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') process.exit(0);
  const input = (function () {
    try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_e) { return {}; }
  })();
  const event = input.hook_event_name || '';
  if (event === 'Stop' || event === 'PreCompact') writeSpot(input, event);
  else if (event === 'SessionStart' || event === 'PostCompact') injectSpot(input, event);
  process.exit(0);
} catch (_e) {
  process.exit(0); // FAIL OPEN
}
