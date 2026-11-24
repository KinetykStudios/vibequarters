#!/usr/bin/env node
// vibequarters :: PreToolUse(Edit|Write|MultiEdit)
// An optional style rule: no em or en dashes in new text. Warns (permissionDecision: ask) when
// new content contains an em dash (U+2014) or en dash (U+2013), so the agent uses a hyphen,
// comma, colon, or parens instead. FAILS OPEN. Kill switch: VIBEQUARTERS_GUARD=off.
'use strict';

function allow() { process.exit(0); }

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') allow();

  const input = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}');
  const ti = input.tool_input || {};

  // Collect the text this edit/write would introduce. For Write: content. For Edit: new_string.
  // For MultiEdit: every edit's new_string.
  let candidates = [];
  if (typeof ti.content === 'string') candidates.push(ti.content);
  if (typeof ti.new_string === 'string') candidates.push(ti.new_string);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) if (e && typeof e.new_string === 'string') candidates.push(e.new_string);
  }

  // Shell commands write files too (heredocs, sed, Set-Content). Only commands that write
  // are considered: a grep or rg that searches for a dash is not a violation.
  if (typeof ti.command === 'string') {
    const WRITES = /<<-?\s*['"]?\w+|>>?\s*\S|\bsed\s+-[a-z]*i|\b(Set|Add)-Content\b|\bOut-File\b|\btee\b|\bWriteAllText\b/i;
    if (WRITES.test(ti.command)) candidates.push(ti.command);
  }

  const text = candidates.join('\n');
  if (!text) allow();

  // Only care about em/en dashes. Hyphen-minus is fine.
  const EM = /\u2014/; // em dash
  const EN = /\u2013/; // en dash
  if (!EM.test(text) && !EN.test(text)) allow();

  const which = [EM.test(text) ? 'em dash (U+2014)' : null, EN.test(text) ? 'en dash (U+2013)' : null]
    .filter(Boolean).join(' and ');

  const reason =
    `vibequarters: this edit introduces an ${which}. This setup avoids em and en dashes. ` +
    `Replace it with a hyphen, comma, colon, period, or parentheses, then retry. ` +
    `Set VIBEQUARTERS_GUARD=off to disable.`;
  try { require('./hq-ask-mark.js').markAsk(input, 'guard-em-dash.js', reason); } catch (_e) { /* the ask still prints */ }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
} catch (_e) {
  process.exit(0); // FAIL OPEN
}
