#!/usr/bin/env node
// vibequarters :: PreToolUse(Bash|PowerShell)
// Denies a commit, tag or GitHub post that carries Claude attribution: a
// "Co-Authored-By: Claude" trailer, a noreply@anthropic.com address, or a
// "Generated with Claude Code" line. An optional style rule: no AI self-branding.
// A rule in prose alone does not hold. `attribution` in settings.json removes the harness's own lines;
// this catches every other source (plugin templates, skills, habit).
// Searching for the strings is not writing them, so only write commands are
// checked. FAILS OPEN on its own bug. VIBEQUARTERS_GUARD=off disables it.
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./shell-hygiene-lib.js');

function allow() { process.exit(0); } // no stdout + exit 0 => tool proceeds

// The arguments of each `gh pr merge` the command runs, from the parsed shell words, so quoted
// text is never read as a flag or a command: a `;` in a --subject, "PR merge" in a PR title and
// a note quoting the command are only text.
function merges(cmd, shell, depth = 0) {
  const out = [];
  for (const words of lib.parse(cmd, shell)) {
    const r = lib.resolve(words);
    if (!r) continue;
    const vs = r.rest.map((x) => x.v);
    if ((r.first === 'bash' || r.first === 'sh') && depth < 3) { // bash -c "<a merge>"
      const c = vs.findIndex((v) => /^-[a-z]*c[a-z]*$/.test(v));
      if (c >= 0 && vs[c + 1] !== undefined) out.push(...merges(vs[c + 1], 'Bash', depth + 1));
      continue;
    }
    if (r.first !== 'gh') continue;
    let i = 0;
    while (i < vs.length && vs[i].startsWith('-')) i += /^(-R|--repo)$/.test(vs[i]) ? 2 : 1;
    if (vs[i] === 'pr' && vs[i + 1] === 'merge') out.push(vs.slice(i + 2));
  }
  return out;
}

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

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') allow();

  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  if (!cmd.trim()) allow();

  // Global flags may sit between the tool and its verb (`git -C <dir> commit`).
  const WRITES = /\bgit\b[^|;&\n]*?\s(commit|commit-tree|tag|notes|merge)\b|\bgh\b[^|;&\n]*?\s(pr|issue|release)\s+(create|edit|comment|merge|review)\b|\bgh\s+api\b/i;
  if (!WRITES.test(cmd)) allow();

  // Without a body of its own, a merge lets GitHub copy every commit message into main,
  // trailers included. So a merge must squash and pass --body or --body-file, which is read below.
  for (const args of merges(cmd, input.tool_name === 'PowerShell' ? 'PowerShell' : 'Bash')) {
    const squash = args.some((a) => a === '--squash' || a === '-s');
    const body = args.some((a) => ['--body', '-b', '--body-file', '-F'].includes(a) || /^--body(-file)?=/.test(a));
    if (!squash || !body) deny('Merge with --squash and your own --body (or --body-file): otherwise GitHub copies every commit message into main, trailers included.');
  }

  // The message can also come from a file: git -F/--file, gh -F/--body-file.
  let text = cmd;
  for (const m of cmd.matchAll(/(?:^|\s)(?:-F|--file|--body-file)(?:=|\s+)("[^"]+"|'[^']+'|\S+)/g)) {
    const p = path.resolve(input.cwd || process.cwd(), m[1].replace(/^["']|["']$/g, ''));
    try { text += '\n' + fs.readFileSync(p, 'utf8'); } catch (_) { /* not a readable file */ }
  }

  if (/generated with \[?claude code|co-authored-by:\s*claude|noreply@anthropic\.com/i.test(text)) {
    deny('No AI attribution (style rule): remove the "Co-Authored-By: Claude" / noreply@anthropic.com trailer and any "Generated with Claude Code" line, then run the command again.');
  }
  allow();
} catch (_) {
  allow();
}
