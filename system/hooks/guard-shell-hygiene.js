#!/usr/bin/env node
// vibequarters :: PreToolUse (Bash, PowerShell; Monitor gets the jq check only), plus
// PostToolBatch and PermissionDenied for the heavy-job gate.
// Each check denies with the fix in the reason, so nothing prompts the user. Two whose fix is plain
// make it instead (updatedInput, no decision, so the permission system still runs on the result):
// a chained cd is wrapped in a subshell, and a leading git <ref>:<.path> call gets MSYS2_ARG_CONV_EXCL='*'.
//   token   an access token (hygiene.tokenPatterns) typed into a command; the deny never repeats it
//   inline  an inline script (node -e, bun -e, python -c, deno eval) over 5 lines, or one whose
//           double quotes hold what the shell rewrites first: it can print ok running other code
//   msys    (Windows only) a Git Bash path (/c/..., /tmp/...) that reaches node and kin unconverted
//   cwd     a `cd` together with other commands, since it changes the folder later calls and hooks run in;
//           also output redirected to a relative path. `cd <dir>` alone passes
//   gitpath (Windows only) a git <ref>:<path> that Git Bash rewrites into a path list (origin/main:.github/x)
//   jq      a bare jq (also inside $( ) and the shell scripts a command runs) while jq is not
//           installed: it exits 127 unseen inside a pipe or a watcher loop
//   heavy   one heavy local job at a time (browser runs, full suites, whole-project tsc, builds,
//           renders, smoke and mutation scripts), started only under 75% total CPU; a job's claim
//           on the gate ends when its process does (see shell-hygiene-lib.js), and at once when its
//           call is denied (by another hook, auto mode or the user) or ends without a background job
// FAILS OPEN: a bug here never blocks real work. Kill switches: VIBEQUARTERS_GUARD=off (every guard),
// VIBEQUARTERS_HYGIENE=off (all of these), VIBEQUARTERS_HYGIENE_SKIP with any of cwd, gitpath, heavy, inline, jq, msys, pitfall, token.
'use strict';
const lib = require('./shell-hygiene-lib.js');

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

// updatedInput replaces the whole tool input, so the other fields ride along unchanged. The note
// reaches Claude with the tool result.
function rewrite(ti, command, notes) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, command }, additionalContext: notes.join(' ') },
  }));
}

// A note reaches the model as context and lets the call run. Only one JSON object may go to stdout, so every note is written after the last deny.
function note(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  }));
}

const short = (cmd) => String(cmd || '').split('\n')[0].slice(0, 120);

// A heavy job's claim ends with its call unless the call left a background job running. A call
// denied by another hook, by auto mode or by the user never ran, yet would hold the gate 30 s or more.
// PostToolBatch lists every call of a batch once all are resolved; PermissionDenied names one.
// PostToolBatch hands a Bash result over as the text the model sees, so a started job reads
// "Command running in background with ID: ..."; the object form (backgroundTaskId) is kept too.
const leftJob = (r) => (r && typeof r === 'object' ? !!r.backgroundTaskId : /running in background with ID/.test(String(r || '')));

function release(input) {
  const calls = input.hook_event_name === 'PermissionDenied' ? [input] : Array.isArray(input.tool_calls) ? input.tool_calls : [];
  const ids = calls.filter((c) => c && !leftJob(c.tool_response)).map((c) => c.tool_use_id);
  for (const c of lib.releaseCalls(ids)) lib.log(`release ${input.hook_event_name} ${String(input.session_id || '').slice(0, 8)} ${short(c.command)}`);
}

async function main() {
  const off = (v) => String(process.env[v] || '').toLowerCase() === 'off';
  if (off('VIBEQUARTERS_GUARD') || off('VIBEQUARTERS_HYGIENE')) return;
  const input = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}');
  const event = input.hook_event_name || 'PreToolUse';
  if (event === 'PostToolBatch' || event === 'PermissionDenied') return void release(input);
  if (event !== 'PreToolUse') return;
  const shell = input.tool_name;
  if (shell !== 'Bash' && shell !== 'PowerShell' && shell !== 'Monitor') return;
  const ti = input.tool_input || {};
  const original = String(ti.command || '');
  let cmd = original;
  const notes = [];
  if (!cmd.trim()) return;
  const session = String(input.session_id || '');
  const skip = new Set(String(process.env.VIBEQUARTERS_HYGIENE_SKIP || '').toLowerCase().split(/[\s,]+/));
  const jq = () => {
    if (skip.has('jq')) return false;
    const j = lib.jqProblem(cmd, shell === 'PowerShell' ? shell : 'Bash', input.cwd);
    if (!j) return false;
    lib.log(`deny jq ${session.slice(0, 8)} ${short(cmd)}`);
    deny(`vibequarters (shell hygiene): ${j.where ? `the script ${j.where} runs` : 'this runs'} a bare jq, and jq is not installed on this machine, so that step exits 127; inside a pipe, a $( ) or a watcher loop nothing says so. Use gh's own filter instead, gh ... --jq '<filter>' (the same jq language, no jq needed), or parse the JSON in a node script. (VIBEQUARTERS_HYGIENE_SKIP=jq turns this check off.)`);
    return true;
  };
  if (shell === 'Monitor') return void jq();

  if (!skip.has('token') && lib.tokenProblem(cmd)) {
    lib.log(`deny token ${session.slice(0, 8)}`);
    return deny('vibequarters (shell hygiene): this command holds what looks like an access token as text, so the token lands in the transcript, the shell history and every log that echoes the command. Keep it in a file or an environment variable the tool reads by itself (for the Supabase CLI, ~/.supabase/access-token; for gh, gh auth login), and never put it in argv or an env prefix. (VIBEQUARTERS_HYGIENE_SKIP=token turns this check off.)');
  }

  if (!skip.has('inline')) {
    const p = lib.inlineProblem(cmd, shell);
    if (p) {
      lib.log(`deny inline ${session.slice(0, 8)} ${short(cmd)}`);
      const fix = p.fix === 'quote'
        ? 'Put it in single quotes, or write it to a file with the Write tool and run that file.'
        : 'Write it to a file with the Write tool (your scratchpad is a good place), then run that file.';
      return deny(`vibequarters (shell hygiene): ${p.why}. An inline script is at the mercy of shell quoting and can print ok while running something else. ${fix} (VIBEQUARTERS_HYGIENE_SKIP=inline turns this check off.)`);
    }
  }

  if (!skip.has('msys')) {
    const m = lib.msysProblem(cmd, shell);
    if (m) {
      lib.log(`deny msys ${session.slice(0, 8)} ${short(cmd)}`);
      return deny(`vibequarters (shell hygiene): ${m.tool} gets the Git Bash path ${m.path} unconverted (Git Bash only converts a path that starts its own argument, and never under PowerShell or with MSYS2_ARG_CONV_EXCL set). Windows programs read /c/x as C:/c/x, so the step quietly finds nothing. Write the Windows form instead, for example C:/x/... (forward slashes work). (VIBEQUARTERS_HYGIENE_SKIP=msys turns this check off.)`);
    }
  }

  if (!skip.has('cwd')) {
    const cd = lib.cdProblem(cmd, shell);
    if (cd && cd.unbalanced) { // inside ( ) a stray ) ends the subshell early, and bash rejects the rest after part ran
      lib.log(`deny cd ${session.slice(0, 8)} ${short(cmd)}`);
      return deny('vibequarters (shell hygiene): a `cd` chained with other commands moves this session\'s folder for every later call, and that folder is the one the hooks and the coord board see. Its parentheses do not balance, so it cannot be run safely inside a subshell either. Run the same thing without the cd: `git -C <dir> ...` for git, absolute paths for files, or the cd inside a subshell, `(cd <dir> && ...)`, which moves nothing. A lone `cd <dir>` as its own call is still fine: it is how you move back to your worktree. (VIBEQUARTERS_HYGIENE_SKIP=cwd turns this check off.)');
    }
    if (cd) {
      lib.log(`fix cd ${session.slice(0, 8)} ${short(cmd)}`);
      cmd = `(\n${cmd}\n)`; // own lines, so a trailing comment or a heredoc end cannot swallow the )
      notes.push('vibequarters (shell hygiene) ran this command inside a subshell, ( ... ), because it chains a `cd`: this shell\'s folder did not move, so later calls still run where they did before (a chained cd would move the folder the hooks and the coord board see). Use `git -C <dir>` or absolute paths, or a lone `cd <dir>` as its own call to move. (VIBEQUARTERS_HYGIENE_SKIP=cwd turns this off.)');
    }
    const r = lib.redirectProblem(cmd, shell);
    if (r) {
      lib.log(`deny redirect ${session.slice(0, 8)} ${short(cmd)}`);
      return deny(`vibequarters (shell hygiene): the redirect writes to ${r.target.slice(0, 120)}, a path relative to the shell's folder, which persists and resets between calls, so the file can land in another folder. Write the absolute path instead (on Windows, forward slashes work), or a $VAR that holds one. (The user can turn this check off: "VIBEQUARTERS_HYGIENE_SKIP": "cwd" under "env" in ~/.claude/settings.json.)`);
    }
  }

  if (!skip.has('gitpath')) {
    const g = lib.gitPathProblem(cmd, shell);
    // A prefix on the line reaches its first command only, so a second git call needing it gets the deny, and a
    // leading / needs dropping by hand. It would also stop any other Git Bash path on the line converting
    // (git -C /c/Users/x), so such a line gets the deny and its fix.
    const otherPath = g && new RegExp(lib.MSYS_PATH.source, 'i').test(cmd.replace(g.arg, ''));
    if (g && g.first && g.stmts === 1 && /^\s*git\s/.test(cmd) && /:\./.test(g.arg) && !otherPath) {
      lib.log(`fix gitpath ${session.slice(0, 8)} ${short(cmd)}`);
      cmd = `MSYS2_ARG_CONV_EXCL='*' ${cmd}`;
      notes.push(`vibequarters (shell hygiene) put MSYS2_ARG_CONV_EXCL='*' in front of this git command, so Git Bash hands ${g.arg.slice(0, 120)} to git whole instead of as a list of two paths. (VIBEQUARTERS_HYGIENE_SKIP=gitpath turns this off.)`);
    } else if (g) {
      lib.log(`deny gitpath ${session.slice(0, 8)} ${short(cmd)}`);
      return deny(`vibequarters (shell hygiene): Git Bash rewrites ${g.arg.slice(0, 120)} before git sees it. A ref holding a / followed by a path that starts with / or a dot name (.github, .env) reads as a list of two paths, so git gets origin\\main;... and fails with "invalid object name". Put MSYS2_ARG_CONV_EXCL='*' in front of the git command (MSYS2_ARG_CONV_EXCL='*' git show ...), and drop any leading / from the path, since git paths start at the repo top. (VIBEQUARTERS_HYGIENE_SKIP=gitpath turns this check off.)`);
    }
  }

  if (jq()) return; // before the heavy gate, so a denied command never holds a claim

  if (!skip.has('heavy')) {
    const job = lib.heavyJob(cmd, shell, input.cwd);
    if (job) {
      const rec = { id: input.tool_use_id, session, command: cmd, marker: job.marker, background: ti.run_in_background === true, timeoutMs: Number(ti.timeout) || 0 };
      let cpu = await lib.cpuPercent();
      let res = lib.acquire(rec, cpu);
      // A busy gate is usually free within seconds: wait here (default 20 s, kept under the 30 s hook timeout)
      // before denying, which saves a denied call and a retry loop.
      const wait = Number(process.env.VIBEQUARTERS_HEAVY_WAIT_MS ?? 20000);
      const giveUp = Date.now() + Math.min(Number.isFinite(wait) ? Math.max(wait, 0) : 20000, 25000);
      while (!res.ok && Date.now() < giveUp) {
        await new Promise((r) => setTimeout(r, 1000));
        cpu = await lib.cpuPercent(); // samples 1 s, so one try about every 2 s
        res = lib.acquire(rec, cpu);
      }
      if (!res.ok) {
        lib.log(`deny heavy cpu ${Math.round(cpu)}% ${session.slice(0, 8)} ${short(cmd)}`); // not cpu=N: secret masking hides every NAME=value
        return deny(`vibequarters (heavy-job gate): ${job.why} is a heavy local job, and ${res.why}. Heavy jobs take turns and need total CPU below ${lib.START_MAX_CPU}%. To wait, start \`until node "${lib.gatePath()}" status; do sleep 20; done\` with run_in_background (or watch it with Monitor), and run this command again once it exits. The gate opens when the other job's process ends. Do not divide or rename a job to avoid the gate. (The user can turn this check off with VIBEQUARTERS_HYGIENE_SKIP=heavy.)`);
      }
      lib.log(`take ${res.lock.background ? 'bg' : 'fg'} cpu ${Math.round(cpu)}% ${session.slice(0, 8)} ${job.marker} ${short(cmd)}`);
    }
  }

  // Last, so a note never competes with a deny for the one JSON object stdout carries. Read off
  // the command as typed; a rewrite carries the note beside its own.
  if (!skip.has('pitfall')) {
    const p = lib.pitfallNote(original, shell);
    if (p) {
      lib.log(`note ${p.tag} ${session.slice(0, 8)} ${short(cmd)}`);
      const text = `vibequarters (known pitfall, not a block, this call still runs): ${p.note} (VIBEQUARTERS_HYGIENE_SKIP=pitfall turns this note off.)`;
      if (cmd === original) return void note(text);
      notes.push(text);
    }
  }

  if (cmd !== original) rewrite(ti, cmd, notes);
}

main().catch(() => { /* FAIL OPEN: a guard bug must never block legitimate work */ });
