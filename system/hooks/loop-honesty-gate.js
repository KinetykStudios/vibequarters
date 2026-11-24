#!/usr/bin/env node
// vibequarters learning-loop :: Stop (advisory honesty check)
// Reads the last assistant message. If it claims success ("fixed", "tests pass", "deployed") and mentions no
// evidence such as a test result, an exit code, a request or a deploy address, the session gets a reminder to
// check before claiming. It never blocks. FAILS OPEN. Kill switch: VIBEQUARTERS_GUARD=off.
'use strict';

const fs = require('fs');

function quiet() { process.exit(0); }

function remind(reason) {
  // Stop hooks can inject context for the next turn via additionalContext.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason },
  }));
  process.exit(0);
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') quiet();

  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  // Try common shapes for the last assistant message; if we can't find text, stay quiet.
  let text = '';
  if (typeof input.last_assistant_message === 'string') text = input.last_assistant_message;
  else if (typeof input.transcript === 'string') text = input.transcript.slice(-4000);
  else if (input.messages && Array.isArray(input.messages)) {
    const last = [...input.messages].reverse().find((m) => m && m.role === 'assistant');
    if (last) text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
  }
  if (!text) quiet();

  const CLAIM = /\b(it's done|all done|fully done|fixed it|now fixed|is fixed|tests? pass|passing|verified live|deployed (it|to prod|live)|shipped (it|to prod)|works now|confirmed working)\b/i;
  if (!CLAIM.test(text)) quiet();

  // Evidence signals: did the same turn reference a real verification artifact?
  const EVIDENCE = /(exit code|exit 0|tests? (passed|green)|curl |https?:\/\/|deployment|runtime logs|wc -c|tsc|playwright|✓|verified (with|via|by)|status 200|HTTP\/)/i;
  if (EVIDENCE.test(text)) quiet(); // claim is backed by evidence, fine

  remind(
    'EVIDENCE CHECK: the last message claims success but shows no evidence for it (no test result, exit code, ' +
    'request output, deploy address or log line). Run the check and show its output, or point to where it was ' +
    'already shown.'
  );
} catch (_e) {
  process.exit(0); // FAIL OPEN
}
