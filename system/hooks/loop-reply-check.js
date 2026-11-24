#!/usr/bin/env node
// vibequarters learning-loop :: Stop + UserPromptSubmit (advisory check of the closing lines described in REPLY-SHAPE.md)
// On Stop it reads the last reply. If the closing lines are not ones the VibeQuarters app can show (its lib/chat.js reads
// them), a note is saved for the session; the next UserPromptSubmit adds the note once and deletes it. Stop prints
// nothing, because output there can start another model turn. Advisory: it never blocks. FAILS OPEN.
// Kill switch: VIBEQUARTERS_GUARD=off.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = process.env.REPLY_CHECK_STATE || path.join(os.homedir(), '.claude', 'cache', 'reply-check');
const MAX_STEPS = 3;
const WINDOW = 8000; // code points at the end of a reply the app reads its closing lines from (lib/chat.js)

// The same line shapes the app's chat window reads (lib/chat.js), so a line this passes is a line the app can show
const NEXT_BOLD = /^\s*(?:#{1,6}\s*)?\*\*Next steps(?::\*\*|\*\*:?)\s*$/i;
const NEXT_HEAD = /^\s*#{1,6}\s*Next steps:?\s*$/i;
const ITEM = /^\s*\d+[.)]\s+(.+)$/;
const STATUS = /^\s*(?:\*\*)?Status(?::(?:\*\*)?|\*\*:)\s*(.+)$/i;
const FENCE = /^\s*(?:```|~~~)/;

const ALL_DONE = /^all done\b/i;
const WAITING = /\bwaiting on you\b/i;
const RUNNING = /^still running\b/i;
// A step that sends the user back into the body, which the app shows without it: "see above", "listed above", "the 5 checks", or
// a step that ends on above, below or listed. "Approve the draft" is not one
const POINTS_BACK = /\b(?:see (?:above|below)|(?:listed|shown|named) (?:above|below)|the (?:\d+|two|three|four|five|six) (?:checks|items|things|steps|options))\b|\b(?:above|below|listed)\W*$/i;

// The reply's last WINDOW code points, the partial line the window starts inside dropped as the app drops it, then the
// lines outside code fences
function bodyLines(text) {
  const cps = [...text.slice(-WINDOW * 2)]; // a code point is at most 2 UTF-16 units, so a huge reply is never spread whole
  let s = cps.slice(-WINDOW).join('');
  if (text.length > WINDOW * 2 || cps.length > WINDOW) {
    const nl = s.indexOf('\n');
    s = nl < 0 ? '' : s.slice(nl + 1);
  }
  let fenced = false;
  return s.split(/\r?\n/).filter((line) => {
    if (FENCE.test(line)) { fenced = !fenced; return false; }
    return !fenced;
  });
}

// Only what the reply's own lines prove. Length is not checked, because the hook does not know what was asked for.
function issuesOf(text) {
  const lines = bodyLines(text);
  const statusLine = lines.filter((l) => STATUS.test(l)).pop();
  const status = statusLine ? STATUS.exec(statusLine)[1].trim() : null;
  const head = lines.findLastIndex((l) => NEXT_BOLD.test(l) || NEXT_HEAD.test(l));
  const steps = [];
  if (head >= 0) {
    let i = head + 1;
    while (i < lines.length && !lines[i].trim()) i++;
    for (let m; i < lines.length && (m = ITEM.exec(lines[i])); i++) steps.push(m[1]);
  }

  const issues = [];
  if (!status) issues.push('no Status line, and every reply closes with one');
  if (status && !ALL_DONE.test(status) && !WAITING.test(status) && !RUNNING.test(status)) {
    issues.push("the Status line is not one of the three shapes (all done / waiting on you: X / still running: X)");
  }
  if (head >= 0 && status && ALL_DONE.test(status)) issues.push("it says all done and still lists Next steps");
  else if (head >= 0 && !(status && WAITING.test(status))) issues.push('it lists Next steps with no waiting-on-you status, so they look optional');
  if (status && WAITING.test(status) && head < 0) issues.push('it waits on the user with no Next steps block (the bold **Next steps** line or a # heading) saying what to do');
  if (steps.length > MAX_STEPS) issues.push(`${steps.length} steps, the most is ${MAX_STEPS}`);
  const back = steps.find((s) => POINTS_BACK.test(s));
  if (back) issues.push(`a step points back into the body, and the app shows it without the body: "${back.slice(0, 80)}"`);
  return issues;
}

function onStop(input, file) {
  if (input.stop_hook_active === true) return;
  const text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  if (!text.trim()) return;
  const issues = issuesOf(text);
  if (!issues.length) { fs.rmSync(file, { force: true }); return; } // the newest reply is clean, so an older note is stale
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, `REPLY CHECK (REPLY-SHAPE.md): the closing lines of your last reply need a fix: ${issues.join('; ')}. Use the right form in this reply; no need to mention the last one.`);
  fs.renameSync(tmp, file);
}

function onPrompt(file) {
  let note;
  try { note = fs.readFileSync(file, 'utf8'); } catch (_e) { return; }
  fs.rmSync(file, { force: true });
  if (!note.trim()) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } }));
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() !== 'off') {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const id = String(input.session_id || '');
    if (/^[0-9a-f-]{8,64}$/i.test(id)) {
      const file = path.join(STATE_DIR, id + '.txt');
      if (input.hook_event_name === 'Stop') onStop(input, file);
      else if (input.hook_event_name === 'UserPromptSubmit') onPrompt(file);
    }
  }
} catch (_e) {
  // FAIL OPEN
}
process.exit(0);
