#!/usr/bin/env node
// vibequarters :: PreToolUse(Edit|Write|MultiEdit|Bash|PowerShell)
//
// Asks before a common bug: stripping comments out of JavaScript or
// TypeScript with a regex. A lazy /\/\*[\s\S]*?\*\//g pairs a bare /* inside a STRING
// with a closer thousands of characters later and silently eats everything between,
// while every downstream total still looks plausible.
//
// Anchoring the regex does not help, because no regex can strip comments from a language that
// also has strings, template literals and regex literals. The only correct answer
// is a single-pass scanner that tracks those states.
//
// This is an ASK, not a hard deny: there are legitimate uses of a lazy [\s\S]*?
// that have nothing to do with comments, and a false positive should cost one
// keystroke, not a blocked session. FAILS OPEN. Kill switch: VIBEQUARTERS_GUARD=off.
'use strict';

function allow() { process.exit(0); }

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') allow();

  const input = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}');
  const ti = input.tool_input || {};

  // Same collection shape as guard-em-dash.js: a shell heredoc writes a file
  // just as easily as Write does.
  const candidates = [];
  if (typeof ti.content === 'string') candidates.push(ti.content);
  if (typeof ti.new_string === 'string') candidates.push(ti.new_string);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) {
      if (e && typeof e.new_string === 'string') candidates.push(e.new_string);
    }
  }
  if (typeof ti.command === 'string') {
    const WRITES = /<<-?\s*['"]?\w+|>>?\s*\S|\bsed\s+-[a-z]*i|\b(Set|Add)-Content\b|\bOut-File\b|\btee\b|\bWriteAllText\b|\bnode\s+-e\b|\bbun\s+-e\b/i;
    if (WRITES.test(ti.command)) candidates.push(ti.command);
  }

  const text = candidates.join('\n');
  if (!text) allow();

  // The signature: an escaped /* and an escaped */ close together on one line,
  // with a lazy any-character run between them. That is the block-comment
  // stripper idiom and essentially nothing else. Both the [\s\S] and [^] forms,
  // and the dotall-flag form, are covered.
  //
  // Deliberately NOT flagged: a line-comment strip (//.*$), which is far more
  // often something else entirely, and a bare [\s\S]*? with no comment markers.
  const BLOCK_STRIPPER = /\\\/\\\*[\s\S]{0,12}?(\[\\s\\S\]|\[\^\]|\.)\*\?[\s\S]{0,12}?\\\*\\\//;

  // The same idiom written against an already-unescaped source, e.g. a string
  // passed to new RegExp("/\\*[\\s\\S]*?\\*/").
  const BLOCK_STRIPPER_STR = /\/\\\\\*[\s\S]{0,16}?\*\?[\s\S]{0,16}?\\\\\*\//;

  const hit = BLOCK_STRIPPER.test(text) || BLOCK_STRIPPER_STR.test(text);
  if (!hit) allow();

  const reason =
        'vibequarters: this writes a regex that strips /* */ block comments. ' +
        'That pattern corrupts source silently: a bare ' +
        '/* inside a string pairs with a closer far below it, and everything between is deleted. No regex can strip comments ' +
        'from a language with strings, template literals and regex literals. ' +
        'Write a single-pass scanner that tracks code / line / block / "" / \'\' / `` state, ' +
        'open a comment only at line start or after whitespace, and diff the FULL result set ' +
        'against the old tool as a negative control. ' +
        'If this is not a comment stripper, approve and carry on. ' +
        'Set VIBEQUARTERS_GUARD=off to disable.';
  try { require('./hq-ask-mark.js').markAsk(input, 'guard-comment-stripper.js', reason); } catch (_e) { /* the ask still prints */ }
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
