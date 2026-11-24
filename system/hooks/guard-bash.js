#!/usr/bin/env node
// vibequarters :: PreToolUse(Bash)
// Forces a confirmation prompt before genuinely destructive shell commands, even in
// auto mode. Backstops section 3 of RULES.md. FAILS OPEN: never blocks real work on its own bug.
// Escape hatch: set VIBEQUARTERS_GUARD=off to disable entirely.
'use strict';

function allow() { process.exit(0); } // no stdout + exit 0 => tool proceeds

let input = {};
function ask(reason) {
  try { require('./hq-ask-mark.js').markAsk(input, 'guard-bash.js', reason); } catch (_e) { /* the ask still prints */ }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}
// A refusal that names its fix: the session rewrites the command and runs it, and nobody is asked. A deny never
// reaches HQ, so it leaves no ask mark.
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

// True when the FINAL top-level statement is an echo or printf that expands $?, as in
// `cmd; echo "exit=$?"`. That echo's own status (0) becomes the whole command's exit
// code, so a real failure before it is reported as success. Aware of quotes, comments,
// heredoc bodies, $( ), ( ) and backticks, so a $? written into a file or handed to
// another program does not count, and only the last statement at the top level matters.
function endsInEchoOfExitStatus(cmd) {
  const stmts = [{ first: -1, refs: false }]; // first = index of the statement's first word
  const stack = ['top']; // top | paren ( $( or ( ) | bt (backtick) | dq (double quote)
  const heredocs = []; // { delim, strip } bodies that start after the next newline
  const n = cmd.length;
  const wordStart = (k) => k === 0 || /[\s;&|()]/.test(cmd[k - 1]);
  const next = () => stmts.push({ first: -1, refs: false });
  let i = 0;
  while (i < n) {
    const c = cmd[i];
    const ctx = stack[stack.length - 1];
    const cur = stmts[stmts.length - 1];
    if (ctx === 'top' && cur.first < 0 && !/[\s;&|]/.test(c) && !(c === '#' && wordStart(i))) cur.first = i;
    if (cmd.startsWith('$?', i) || cmd.startsWith('${?}', i)) { cur.refs = true; i += 2; continue; }
    if (ctx === 'dq') {
      if (c === '\\') i += 2;
      else if (c === '"') { stack.pop(); i++; }
      else if (c === '`') { stack.push('bt'); i++; }
      else if (cmd.startsWith('$(', i)) { stack.push('paren'); i += 2; }
      else i++;
      continue;
    }
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const e = cmd.indexOf("'", i + 1); i = e < 0 ? n : e + 1; continue; }
    if (cmd.startsWith("$'", i)) { i += 2; while (i < n && cmd[i] !== "'") i += cmd[i] === '\\' ? 2 : 1; i++; continue; }
    if (c === '"') { stack.push('dq'); i++; continue; }
    if (c === '`') { if (ctx === 'bt') stack.pop(); else stack.push('bt'); i++; continue; }
    if (c === '(') { stack.push('paren'); i++; continue; } // also opens $( and $((
    if (c === ')') { if (ctx === 'paren') stack.pop(); i++; continue; }
    if (c === '#' && wordStart(i)) { const e = cmd.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '<' && cmd[i - 1] !== '<') {
      const re = /<<(?!<)(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/y;
      re.lastIndex = i;
      const m = re.exec(cmd);
      if (m) { heredocs.push({ delim: m[3], strip: m[1] === '-' }); i += m[0].length; continue; }
    }
    if (c === '\n') {
      let p = i + 1;
      for (const hd of heredocs.splice(0)) {
        while (p < n) {
          const e = cmd.indexOf('\n', p);
          const line = cmd.slice(p, e < 0 ? n : e).replace(/\r$/, '');
          p = e < 0 ? n : e + 1;
          if ((hd.strip ? line.replace(/^\t+/, '') : line) === hd.delim) break;
        }
      }
      if (ctx === 'top') next();
      i = p; continue;
    }
    if (ctx === 'top') {
      if (c === ';') { next(); i++; continue; }
      if (c === '&') {
        if (cmd[i + 1] === '&') { next(); i += 2; continue; }
        if (!(cmd[i + 1] === '>' || cmd[i - 1] === '>' || cmd[i - 1] === '<')) next(); // &>, >&, <& are redirects
        i++; continue;
      }
      if (c === '|') {
        if (cmd[i + 1] === '|') { next(); i += 2; continue; }
        i += cmd[i + 1] === '&' ? 2 : 1; continue; // a pipe stays inside one statement
      }
    }
    i++;
  }
  const last = stmts.filter((s) => s.first >= 0).pop();
  return !!last && last.refs && /^(?:echo|printf)(?![^\s;&|<>)])/.test(cmd.slice(last.first));
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') allow();

  input = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}');
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  if (!cmd.trim()) allow();

  // Build/cache dirs that are safe to nuke without asking.
  const SAFE = /(node_modules|\.next|\.nuxt|\bdist\b|\bbuild\b|\bout\b|\.turbo|\.cache|coverage|__pycache__|\.pytest_cache|\.vercel|\btarget\b|\.svelte-kit|\.parcel-cache|\btmp\b|\btemp\b)/i;
  // Precious dirs that must never be recursively deleted without confirmation.
  const PRECIOUS = /(\bsrc\b|\bsupabase\b|\bpublic\b|\bscripts\b|\btests?\b|\bdocs\b|\bapp\b|\bcomponents\b|\blib\b|\.git\b|migrations)/i;

  const checks = [
    { kind: 'recursive delete (rm -rf)',
      re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b/i,
      isDelete: true },
    { kind: 'recursive force delete (Remove-Item -Recurse -Force)',
      re: /remove-item[^\n|;&]*-recurse[^\n|;&]*-force|remove-item[^\n|;&]*-force[^\n|;&]*-recurse|\bri\b[^\n|;&]*-recurse[^\n|;&]*-force/i,
      isDelete: true },
    { kind: 'git force-push (rewrites remote history)',
      re: /git\s+push\b/i,
      test: () => /(--force\b|\s-f\b)/i.test(cmd) && !/--force-with-lease/i.test(cmd) },
    { kind: 'git reset --hard (discards uncommitted work)',
      re: /git\s+reset\s+(--hard|--keep\s+--hard|--hard\b)/i },
    { kind: 'git clean -f (deletes untracked files)',
      re: /git\s+clean\s+-[a-z]*f/i },
    // Any pathspec, not just the bare dot: `git checkout -- <file>` discards that
    // file's uncommitted work just as the whole-tree form does.
    { kind: 'git discard of local changes',
      re: /git\s+checkout\s+--\s+\S|git\s+restore\s+(--\w+\s+)*\S|git\s+(checkout|restore)\s+(--\s+)?\.\s*$/i },
    // `git checkout <ref> -- .` stages every file of <ref>, which then looks like
    // intended work in the diff. A named path is fine, so only the `.` pathspec asks.
    { kind: 'git checkout of a whole tree from a ref (stages every file, not just yours)',
      re: /git\s+checkout\s+(?!-)\S+\s+--\s+\.\/?(?=\s|$)/i },
    // Without `--failed`, `gh run rerun` replaces the results of jobs that already passed.
    { kind: 'gh run rerun without --failed (discards jobs that already passed)',
      re: /gh\s+run\s+rerun\b/i,
      test: () => !/--failed\b/i.test(cmd) },
    { kind: 'SQL DROP (irreversible)',
      re: /\bdrop\s+(table|database|schema)\b/i },
    { kind: 'SQL TRUNCATE (wipes table data)',
      re: /\btruncate\s+(table\s+)?["'`\w]/i },
    { kind: 'supabase db reset (wipes database)',
      re: /supabase\s+db\s+reset\b/i },
    { kind: 'disk-level / fork-bomb command',
      re: /\b(mkfs\b|dd\s+if=|:\s*\(\)\s*\{|format\s+[a-z]:)/i },
  ];

  for (const ck of checks) {
    if (!ck.re.test(cmd)) continue;
    if (ck.test && !ck.test()) continue;
    // Recursive deletes scoped purely to build/cache dirs (and not touching precious dirs) are fine,
    // but only this clause is skipped: the rest of the command still meets every later check.
    if (ck.isDelete && SAFE.test(cmd) && !PRECIOUS.test(cmd)) continue;
    ask(
      `vibequarters: this looks like a ${ck.kind}. Confirm before running it ` +
      `(or set VIBEQUARTERS_GUARD=off to disable this guard).\nCommand: ` +
      (cmd.length > 300 ? cmd.slice(0, 300) + '...' : cmd)
    );
  }

  // Runs after the destructive checks so their reasons keep priority, and for Bash only, since the scanner
  // reads bash syntax. A trailing `echo "exit=$?"` makes a failed command exit 0. It denies instead of asking:
  // the fix is mechanical, and approving it would only run the masked command.
  if (input.tool_name === 'Bash' && endsInEchoOfExitStatus(cmd)) {
    deny('vibequarters [DENY]: the last statement echoes $?, so the command exits with the echo\'s 0 and a real failure before it is reported as success. Run it again with the code captured and propagated: cmd; rc=$?; echo "exit=$rc"; exit $rc');
  }

  allow();
} catch (_e) {
  // FAIL OPEN, a guard bug must never block legitimate work.
  process.exit(0);
}
