#!/usr/bin/env node
// vibequarters :: PreToolUse(Bash)
// Windows only (Git for Windows' bash): denies heredocs with a backslash in the body.
// There a backslash does not reliably survive the trip into a heredoc, quoted delimiter or
// not: a doubled one can arrive single and a typed \uXXXX as its character, so `/\\/g` reaches
// the file as `/\/g`, a SyntaxError. The Write tool writes bytes exactly, so the way out is
// always to write the file with it and then run the file. On macOS and Linux it allows
// everything. FAILS OPEN on its own bug. VIBEQUARTERS_GUARD=off disables it.
'use strict';
const fs = require('fs');

function allow() { process.exit(0); } // no stdout + exit 0 => tool proceeds

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// The body of every heredoc in the command, in order. `<<<` is a here-string, not a
// heredoc, and `1<<2` is a shift: a delimiter starts with a letter or an underscore.
function heredocBodies(cmd) {
  const lines = cmd.split('\n');
  const bodies = [];
  for (let i = 0; i < lines.length; i++) {
    let next = i + 1;
    for (const m of lines[i].matchAll(/(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/g)) {
      let end = next;
      while (end < lines.length && (m[1] ? lines[end].replace(/^\t+/, '') : lines[end]).replace(/\r$/, '') !== m[3]) end++;
      bodies.push(lines.slice(next, end).join('\n'));
      next = end + 1;
    }
    i = next - 1;
  }
  return bodies;
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') allow();
  // Git for Windows only; VIBEQUARTERS_TEST_PLATFORM stands in for the platform in the tests.
  if ((process.env.VIBEQUARTERS_TEST_PLATFORM || process.platform) !== 'win32') allow();

  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  if (input.tool_name !== 'Bash') allow();
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  if (!cmd.includes('<<') || !cmd.includes('\\')) allow();

  if (heredocBodies(cmd).some((body) => body.includes('\\'))) {
    deny('A heredoc body in this command holds a backslash, and in the bash of Git for Windows a backslash does not survive a heredoc, quoted delimiter or not (a doubled one arrives single, a typed \\uXXXX arrives as its character). Write the file with the Write tool, then run it; build a computed backslash with String.fromCharCode(92) or chr(92).');
  }
  allow();
} catch (_) {
  allow();
}
