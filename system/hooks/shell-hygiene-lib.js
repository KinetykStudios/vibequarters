// Shared by guard-shell-hygiene.js (PreToolUse on Bash and PowerShell) and heavy-gate.cjs beside
// it. The checks:
//   inline  an inline script (node -e and kin) over 5 lines, or one the shell rewrites first
//   msys    (Windows only) a Git Bash path (/c/..., /tmp/...) that reaches a Windows program unconverted
//   cwd     a `cd` that shares its command, and output redirected to a relative path
//   token   an access token (hygiene.tokenPatterns) typed into a command
//   gitpath (Windows only) a git <ref>:<path> that Git Bash rewrites into a path list (origin/main:.github/x)
//   jq      jq on a machine without it (it fails silently inside pipes and watchers)
//   heavy   heavy local jobs take turns and start below a CPU limit, so the machine stays usable
// The limits come from vibequarters.config.json (hygiene.*).
// The shell parsing is approximate on purpose: it errs toward allowing, and the hook fails open.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const HYG = require('./vibequarters-config').load().hygiene;
// msys and gitpath are Git for Windows problems; VIBEQUARTERS_TEST_PLATFORM stands in for the platform in the tests.
const isWindows = () => (process.env.VIBEQUARTERS_TEST_PLATFORM || process.platform) === 'win32';

// ---------- shell parsing ----------

// Splits a command into statements, each an array of words { v, dq, quoted, redir, out }:
// v is the word with quotes removed, dq the text it held inside double quotes, redir marks
// a redirect target and out an output one (> >> &>). A statement inside ( ) has .sub set.
// Aware of quotes, escapes, comments, $( ) and backticks (also inside double quotes), heredoc
// bodies (Bash, also inside $( )), here-strings and <# #> comments (PowerShell), and the
// statement separators ; && || | & newline.
function parse(cmd, shell) {
  const ps = shell === 'PowerShell';
  const esc = ps ? '`' : '\\';
  const stmts = [];
  const heredocs = [];
  let words = [];
  let w = null;
  let redirNext = false;
  let redirOut = false;
  let depth = 0;
  let unbalanced = false; // a ) with no ( before it, or a ( or $( never closed
  const word = () => (w = w || { v: '', dq: '', quoted: false, redir: false });
  const endWord = () => {
    if (!w) return;
    if (redirNext) { w.redir = true; w.out = redirOut; redirNext = false; }
    words.push(w);
    w = null;
  };
  const endStmt = () => { endWord(); redirNext = false; if (words.length) { words.sub = depth > 0; stmts.push(words); } words = []; };
  const n = cmd.length;
  const heredocAt = (i) => { // a heredoc operator at i: { hd, len }, or null
    if (ps || cmd[i] !== '<' || cmd[i + 1] !== '<' || cmd[i + 2] === '<') return null;
    const re = /<<(-?)[ \t]*\\?(['"]?)([A-Za-z_][\w.-]*)\2/y; // <<EOF, <<'EOF', <<"EOF", <<\EOF
    re.lastIndex = i;
    const m = re.exec(cmd);
    return m ? { hd: { delim: m[3], strip: m[1] === '-' }, len: m[0].length } : null;
  };
  const skipBodies = (i, hds) => { // from the start of a line, past each pending heredoc body
    for (const hd of hds) {
      while (i < n) {
        const e = cmd.indexOf('\n', i);
        const line = cmd.slice(i, e < 0 ? n : e).replace(/\r$/, '');
        i = e < 0 ? n : e + 1;
        if ((hd.strip ? line.replace(/^\t+/, '') : line) === hd.delim) break;
      }
    }
    return i;
  };
  const balanced = (open) => { // index just past the ) that closes the ( at `open`
    let depth = 0;
    let q = null;
    const pending = [];
    for (let j = open; j < n; j++) {
      const c = cmd[j];
      if (q) { if (c === esc && q === '"') j++; else if (c === q) q = null; continue; }
      if (c === '\n' && pending.length) { j = skipBodies(j + 1, pending.splice(0)) - 1; continue; }
      if (c === esc) { j++; continue; }
      const h = heredocAt(j);
      if (h) { pending.push(h.hd); j += h.len - 1; continue; }
      if (c === "'" || c === '"') q = c;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return j + 1;
    }
    return n;
  };
  let i = 0;
  while (i < n) {
    const c = cmd[i];
    if (c === '\n') {
      endStmt();
      i = skipBodies(i + 1, heredocs.splice(0)); // a heredoc body is data, never commands
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    if (c === '#' && !w) { const e = cmd.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (ps && c === '<' && cmd[i + 1] === '#' && !w) { const e = cmd.indexOf('#>', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === esc) {
      if (cmd[i + 1] === '\n') { i += 2; continue; } // line continuation
      word().v += cmd[i + 1] || '';
      i += 2;
      continue;
    }
    if (c === "'") {
      word().quoted = true;
      let j = i + 1;
      while (j < n) {
        if (cmd[j] === "'") { if (ps && cmd[j + 1] === "'") { w.v += "'"; j += 2; continue; } break; }
        w.v += cmd[j++];
      }
      i = j + 1;
      continue;
    }
    if (c === '"') {
      word().quoted = true;
      let j = i + 1;
      while (j < n) {
        const d = cmd[j];
        if (d === '"') { if (ps && cmd[j + 1] === '"') { w.dq += '""'; w.v += '"'; j += 2; continue; } break; }
        if (d === esc && j + 1 < n) { w.dq += d + cmd[j + 1]; w.v += cmd[j + 1]; j += 2; continue; }
        if (d === '$' && cmd[j + 1] === '(') { // a command inside the quotes has its own quoting
          const s = cmd.slice(j, balanced(j + 1));
          w.dq += s;
          w.v += s;
          j += s.length;
          continue;
        }
        w.dq += d;
        w.v += d;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (!ps && c === '$' && cmd[i + 1] === "'") { // ANSI-C quoting
      word().quoted = true;
      let j = i + 2;
      while (j < n && cmd[j] !== "'") { if (cmd[j] === '\\') { w.v += cmd[j + 1] || ''; j += 2; } else w.v += cmd[j++]; }
      i = j + 1;
      continue;
    }
    if (c === '$' && cmd[i + 1] === '(') {
      const e = balanced(i + 1);
      if (e === n && cmd[n - 1] !== ')') unbalanced = true;
      word().v += cmd.slice(i, e);
      i = e;
      continue;
    }
    if (!ps && c === '`') { const e = cmd.indexOf('`', i + 1); const end = e < 0 ? n : e + 1; word().v += cmd.slice(i, end); i = end; continue; }
    if (ps && c === '@' && !w && (cmd[i + 1] === "'" || cmd[i + 1] === '"')) { // here-string
      const q = cmd[i + 1];
      const close = cmd.indexOf(`\n${q}@`, i + 2);
      const end = close < 0 ? n : close;
      word().quoted = true;
      w.v += cmd.slice(i + 2, end).replace(/^\r?\n/, '');
      if (q === '"') w.dq += w.v;
      i = close < 0 ? n : close + 3;
      continue;
    }
    const h = heredocAt(i);
    if (h) { endWord(); heredocs.push(h.hd); i += h.len; continue; }
    if (c === '>' || c === '<') {
      if (w && /^\d+$/.test(w.v) && !w.quoted) w = null; // the fd in 2>
      else endWord();
      let j = i;
      while (j < n && (cmd[j] === '>' || cmd[j] === '<')) j++;
      redirOut = cmd.slice(i, j).includes('>');
      if (cmd[j] === '&') { j++; while (j < n && /\d/.test(cmd[j])) j++; if (/[\s;|]/.test(cmd[j] || ' ')) { i = j; continue; } }
      redirNext = true;
      i = j;
      continue;
    }
    if (c === ';' || c === '|') { endStmt(); i += cmd[i + 1] === c || (c === '|' && cmd[i + 1] === '&') ? 2 : 1; continue; }
    if (c === '&') {
      if (cmd[i + 1] === '>') { endWord(); redirNext = true; redirOut = true; i += cmd[i + 2] === '>' ? 3 : 2; continue; } // &> file
      endStmt();
      i += cmd[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '(' || c === ')') {
      endStmt();
      if (c === ')' && depth === 0) unbalanced = true;
      depth = Math.max(0, depth + (c === '(' ? 1 : -1));
      i++;
      continue;
    }
    word().v += c;
    i++;
  }
  endStmt();
  stmts.unbalanced = unbalanced || depth > 0;
  return stmts;
}

const SKIP = new Set(['env', 'time', 'nice', 'nohup', 'command', 'exec', 'sudo', 'cross-env', 'dotenv', '&', '.', 'call', '!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'timeout', 'xargs']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const INTERPRETERS = new Set(['node', 'bun', 'tsx', 'ts-node', 'deno', 'python', 'python3', 'py']);
const INLINE_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
const NODE_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--cwd']);

function base(p) {
  return String(p).replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

// The program a statement runs: { first, tool, args, rest, script, scriptArgs }. `first` is the
// program as typed, `tool` the one it ends up running (npx playwright -> playwright), `script` a
// file an interpreter runs, `rest` every word after `first`.
function resolve(words) {
  const ws = words.filter((x) => !x.redir);
  let k = 0;
  for (;;) {
    while (k < ws.length && ASSIGN.test(ws[k].v)) k++;
    if (k < ws.length && SKIP.has(base(ws[k].v))) {
      if (base(ws[k].v) === 'command' && ws[k + 1] && /^-[vV]$/.test(ws[k + 1].v)) return null; // a lookup, not a run
      k++;
      while (k < ws.length && /^(-\S*|\d+[smhd]?)$/.test(ws[k].v)) k++;
      continue;
    }
    break;
  }
  if (k >= ws.length) return null;
  const first = base(ws[k].v);
  const rest = ws.slice(k + 1);
  let tool = first;
  let args = rest;
  const shiftTool = () => {
    let j = 0;
    while (j < args.length && args[j].v.startsWith('-')) j++;
    tool = j < args.length ? base(args[j].v).replace(/(.)@[^@]*$/, '$1') : ''; // vitest@3 runs vitest
    args = args.slice(j + 1);
  };
  if (['npx', 'bunx', 'pnpx'].includes(tool)) shiftTool();
  else if (['npm', 'pnpm', 'yarn'].includes(tool) && args[0] && ['exec', 'dlx', 'x'].includes(args[0].v)) { args = args.slice(1); shiftTool(); }
  else if (tool === 'bun' && args[0] && args[0].v === 'x') { args = args.slice(1); shiftTool(); }
  let script = null;
  let scriptArgs = [];
  if (INTERPRETERS.has(tool)) {
    for (let j = 0; j < args.length; j++) {
      const v = args[j].v;
      if (INLINE_FLAGS.has(v) || v === '-c' || v === '--check' || /^--(eval|print)=/.test(v)) break; // code, or only a syntax check
      if (NODE_VALUE_FLAGS.has(v)) { j++; continue; }
      if (v.startsWith('-')) continue;
      if (/[\/\\]|\.[cm]?[jt]sx?$|\.py$/.test(v)) { script = v; scriptArgs = args.slice(j + 1); }
      break;
    }
  }
  return { first, tool, args, rest, script, scriptArgs };
}

// ---------- inline scripts ----------

// The word holding a statement's inline script; `src` is the word it came from.
function payloadOf(r) {
  if (r.tool === 'deno') return r.args[0] && r.args[0].v === 'eval' ? r.args[1] || null : null;
  const py = r.tool === 'python' || r.tool === 'python3' || r.tool === 'py';
  if (!py && !['node', 'bun', 'tsx', 'ts-node'].includes(r.tool)) return null;
  for (let j = 0; j < r.args.length; j++) {
    const a = r.args[j];
    if (py ? a.v === '-c' : INLINE_FLAGS.has(a.v)) return r.args[j + 1] || null;
    if (!py && /^--(eval|print)=/.test(a.v)) return { v: a.v.slice(a.v.indexOf('=') + 1), dq: a.dq, src: a };
    if (NODE_VALUE_FLAGS.has(a.v)) { j++; continue; }
    if (!a.v.startsWith('-')) return null; // a script file: its own flags are not ours
  }
  return null;
}

// What the shell itself rewrites inside double quotes (Git Bash): a backtick (command substitution), a $ that names something ($HOME, ${x}, $(...)), and
// a doubled backslash (\\ arrives as one). A lone \n, \d or \u001b arrives untouched, and \$
// or \" is a deliberate shell escape. PowerShell rewrites a backtick and a $ that names something.
function dqHazards(dq, ps) {
  const found = new Set();
  for (let k = 0; k < dq.length; k++) {
    const c = dq[k];
    const next = dq[k + 1] || '';
    if (!ps && c === '\\') { if (next === '\\') found.add('a doubled backslash'); k++; continue; }
    if (c === '`') { found.add('a backtick'); if (ps) k++; continue; }
    if (c === '$' && (ps ? /[A-Za-z_{(?^$]/ : /[A-Za-z_{(0-9@*#?$!-]/).test(next)) found.add(`a $${next === '(' ? '(...)' : next === '{' ? '{...}' : 'NAME'}`);
  }
  return [...found];
}

// Returns a sentence naming what is wrong with the command's inline script, or null.
function inlineProblem(cmd, shell) {
  const ps = shell === 'PowerShell';
  for (const words of parse(cmd, shell)) {
    const r = resolve(words);
    if (!r) continue;
    const p = payloadOf(r);
    if (!p) continue;
    const lines = p.v.trimEnd().split('\n').length;
    if (lines > (Number(HYG.inlineMaxLines) > 0 ? Number(HYG.inlineMaxLines) : 5)) return { tool: r.tool, why: `this runs a ${lines}-line inline ${r.tool} script`, fix: 'file' };
    const hazards = dqHazards(p.dq, ps);
    if (hazards.length) {
      return { tool: r.tool, why: `the inline ${r.tool} script is double-quoted and holds ${hazards.join(' and ')}, which ${ps ? 'PowerShell' : 'Bash'} rewrites before ${r.tool} sees it`, fix: 'quote' };
    }
    if (ps && p.v.includes('"')) {
      return { tool: r.tool, why: `Windows PowerShell 5.1 strips the double quotes inside an argument it passes to ${r.tool}, so this script reaches ${r.tool} without them`, fix: 'file' };
    }
  }
  return null;
}

// ---------- Git Bash paths ----------

// Programs that get no help from a path written inside a larger string.
const NATIVE = new Set(['node', 'bun', 'deno', 'tsx', 'ts-node', 'npx', 'bunx', 'pnpx', 'npm', 'pnpm', 'yarn', 'python', 'python3', 'py', 'vitest', 'playwright', 'tsc', 'vite', 'prettier', 'eslint', 'supabase', 'vercel']);
const MSYS_PATH = /\/(?:[a-zA-Z]\/(?:Users|ProgramData|Program|Windows)\b|tmp\/)/gi;
const SAFE_PREFIX = /^(?:--?[\w.-]*=?|[A-Za-z_][\w.-]*=)?/; // Git Bash converts a path right after these

// A path must start a token, a quoted string or a list item to count, never sit inside a
// Windows path (C:/x/tmp/y) or a URL.
function startsPath(s, idx) {
  if (idx === 0) return true;
  const p = s[idx - 1];
  if (/[\s'"`=,;(\[{]/.test(p)) return true;
  if (p !== ':') return false;
  const isDrive = idx >= 2 && /[A-Za-z]/.test(s[idx - 2]) && (idx === 2 || !/[A-Za-z0-9_]/.test(s[idx - 3]));
  return !isDrive;
}

// Returns { tool, path } for the first Git Bash path a Windows program would receive as is.
function msysProblem(cmd, shell) {
  if (!isWindows()) return null;
  const ps = shell === 'PowerShell';
  const conversionOff = /MSYS2_ARG_CONV_EXCL|MSYS_NO_PATHCONV/.test(cmd);
  for (const words of parse(cmd, shell)) {
    const r = resolve(words);
    if (!r || !(NATIVE.has(r.first) || NATIVE.has(r.tool))) continue;
    const p = payloadOf(r);
    for (const wd of r.rest) {
      const code = p && (wd === p || wd === p.src);
      // A sentence handed to a script is text, and so is a $( ) or backtick command (the shell's
      // own programs read its paths); inline code is still code.
      if (!code && /\s/.test(wd.v)) continue;
      const text = wd.v;
      MSYS_PATH.lastIndex = 0;
      let m;
      while ((m = MSYS_PATH.exec(text))) {
        if (!startsPath(text, m.index)) continue;
        const converted = !ps && !conversionOff && m.index === SAFE_PREFIX.exec(text)[0].length;
        if (!converted) return { tool: r.first, path: text.slice(m.index).split(/["'\s,;)}\]]/)[0] };
      }
    }
  }
  return null;
}

// ---------- the session folder ----------

// The Bash tool's folder persists between calls (and resets on its own), and it is the folder the
// hooks and the coord board see. A `cd` sharing its command with anything else moves it for every
// later call. `cd <dir>` alone passes, because sessions need it to return to their worktree, and so does a
// `cd` inside ( ), which changes nothing outside.
function cdProblem(cmd, shell) {
  if (shell === 'PowerShell') return null;
  const stmts = parse(cmd, shell);
  if (stmts.length < 2) return null;
  return stmts.some((words) => !words.sub && (resolve(words) || {}).first === 'cd') ? { unbalanced: stmts.unbalanced } : null;
}

// An output redirect to a relative path writes into whatever folder the shell is in. An absolute
// target, a $VAR / $( ) / ~ one, the null device or a closed stream (2>&-) passes. Returns { target } or null.
function redirectProblem(cmd, shell) {
  if (shell === 'PowerShell') return null;
  for (const words of parse(cmd, shell)) {
    const hit = words.find((x) => x.redir && x.out && !/^(?:[\/~$`]|[A-Za-z]:[\/\\]|\\\\)/.test(x.v) && !/^(?:nul|-)$/i.test(x.v));
    if (hit) return { target: hit.v };
  }
  return null;
}

// ---------- access tokens ----------

// A pasted access token typed into a command lands in the transcript and every log that echoes the
// command. The shapes are hygiene.tokenPatterns; the literal is never repeated back.
const TOKENS = (Array.isArray(HYG.tokenPatterns) ? HYG.tokenPatterns : []).map((s) => { try { return new RegExp(s); } catch (_e) { return null; } }).filter(Boolean);
const tokenProblem = (cmd) => TOKENS.some((re) => re.test(cmd));

// ---------- git <ref>:<path> ----------

// Git Bash reads <ref>:<path> as a list of two paths when the ref holds a / and the path starts
// with / or a dot name, so git gets origin\main;.github\x and fails. The
// same path after HEAD or a bare sha, and ./x or ../x, arrive whole.
const GIT_PATH_LIST = /^[^:\s]*\/[^:\s]*:(?:\/|\.(?!\.?\/))/;
function gitPathProblem(cmd, shell) {
  if (!isWindows()) return null;
  if (shell === 'PowerShell' || /MSYS2_ARG_CONV_EXCL|MSYS_NO_PATHCONV/.test(cmd) || process.env.MSYS2_ARG_CONV_EXCL || process.env.MSYS_NO_PATHCONV) return null;
  const stmts = parse(cmd, shell);
  let found = null;
  for (let i = 0; i < stmts.length; i++) {
    const r = resolve(stmts[i]);
    const hits = r && r.first === 'git' ? r.rest.filter((x) => GIT_PATH_LIST.test(x.v)) : [];
    if (!hits.length) continue;
    if (found) { found.stmts++; continue; }
    found = { arg: hits[0].v, first: i === 0, stmts: 1 }; // first: the line's first statement; stmts: how many need it
  }
  return found;
}

// ---------- jq ----------

// When jq is not on the PATH, a jq step exits 127, and inside a pipe, a $( ) or a
// watcher loop nothing says so. Once jq is installed the check stands down by itself.
// VIBEQUARTERS_JQ_PATH stands in for PATH in the tests.
function jqInstalled() {
  const dirs = String(process.env.VIBEQUARTERS_JQ_PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => ['jq.exe', 'jq', 'jq.cmd', 'jq.bat'].some((f) => fs.existsSync(path.join(d, f))));
}

// The commands a word runs inside it, each $( ) and backtick, read from the text the shell
// expands: a bare word or double-quoted text (single quotes are literal).
function substitutions(wd, shell) {
  const s = wd.quoted ? wd.dq : wd.v;
  const out = [];
  for (let i = s.indexOf('$('); i >= 0; i = s.indexOf('$(', i + 2)) {
    let depth = 0;
    let j = i + 1;
    for (; j < s.length; j++) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')' && --depth === 0) break;
    }
    out.push(s.slice(i + 2, j));
  }
  if (shell !== 'PowerShell') for (const m of s.matchAll(/`([^`]*)`/g)) out.push(m[1]);
  return out;
}

const JQ_SCRIPT_MAX = 256 * 1024;

// A shell script the command runs, read and checked the same way; `where` names the script.
function jqScript(p, dir, depth) {
  const file = path.resolve(dir, msysToWin(p));
  let body;
  try {
    if (fs.statSync(file).size > JQ_SCRIPT_MAX) return null;
    body = fs.readFileSync(file, 'utf8');
  } catch (_e) { return null; }
  const hit = jqRun(body, 'Bash', path.dirname(file), depth + 1);
  return hit ? { where: hit.where || path.basename(file) } : null;
}

function jqRun(cmd, shell, dir, depth) {
  if (depth > 3) return null;
  for (const words of parse(cmd, shell)) {
    for (const wd of words) {
      for (const inner of substitutions(wd, shell)) {
        const hit = jqRun(inner, shell, dir, depth + 1);
        if (hit) return hit;
      }
    }
    const r = resolve(words);
    if (!r) continue;
    if (r.first === 'jq' || r.tool === 'jq') return { where: null };
    if (['cd', 'pushd', 'set-location', 'sl'].includes(r.first)) {
      const t = r.rest.find((x) => !x.v.startsWith('-'));
      if (t) dir = path.resolve(dir, msysToWin(t.v));
      continue;
    }
    let hit = null;
    if (['bash', 'sh', 'source'].includes(r.first)) {
      const c = r.rest.findIndex((x) => /^-[a-z]*c[a-z]*$/.test(x.v));
      const file = r.rest.find((x) => !x.v.startsWith('-'));
      if (c >= 0) hit = r.rest[c + 1] ? jqRun(r.rest[c + 1].v, 'Bash', dir, depth + 1) : null;
      else if (file) hit = jqScript(file.v, dir, depth);
    } else if (r.first.endsWith('.sh')) {
      hit = jqScript(words.find((x) => !x.redir && base(x.v) === r.first).v, dir, depth);
    }
    if (hit) return hit;
  }
  return null;
}

// Where a command needs jq on a machine without it, as { where } (null: the command
// itself, else the script holding it), or null. gh's own --jq filter needs no jq.
function jqProblem(cmd, shell, cwd) {
  const hit = jqRun(cmd, shell, cwd || process.cwd(), 0);
  return hit && !jqInstalled() ? hit : null;
}

// ---------- heavy jobs ----------

const VITEST_VALUE_FLAGS = new Set(['--config', '-c', '--root', '-r', '--dir', '--project', '--reporter', '--outputFile', '--pool', '--environment', '--shard', '-t', '--testNamePattern', '--maxWorkers', '--minWorkers', '--mode', '--exclude', '--workspace']);
const VITEST_COMMANDS = new Set(['run', 'watch', 'dev', 'bench', 'list', 'typecheck']);
// A file argument, or a $VAR / $(...) that may hold a list of them, makes a run targeted.
const pathlike = (x) => /[\/\\$]|\.(test|spec)\.|\.[cm]?[jt]sx?$/.test(x);
const helpFlag = (args) => args.some((a) => ['--version', '-v', '--help', '-h'].includes(a));
const job = (why, marker) => ({ why, marker });

function vitestFull(args) {
  if (helpFlag(args) || args.some((a) => a === '--changed' || a.startsWith('--changed='))) return false;
  const pos = [];
  for (let k = 0; k < args.length; k++) {
    if (args[k].startsWith('-')) { if (VITEST_VALUE_FLAGS.has(args[k])) k++; continue; }
    if (/^\d+$/.test(args[k])) continue; // a number is a flag's value (--testTimeout 20000), not a filter
    pos.push(args[k]);
  }
  if (pos.length && VITEST_COMMANDS.has(pos[0])) pos.shift();
  return pos.length === 0; // any file or name filter targets the run
}

function tscFull(args) {
  if (helpFlag(args) || args.some((a) => ['--init', '--showConfig', '--all', '--listFilesOnly', '--clean'].includes(a))) return false;
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '-p' || args[k] === '--project') { k++; continue; }
    if (!args[k].startsWith('-') && /\.[cm]?tsx?$|\$/.test(args[k])) return false;
  }
  return true;
}

// package.json scripts from `dir` or a parent, stopping below the home folder.
function readScripts(dir) {
  const stop = path.resolve(os.homedir());
  let d = path.resolve(dir);
  for (let k = 0; k < 8 && d !== stop; k++) {
    try { return JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).scripts || {}; } catch (_e) { /* keep looking */ }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

const PM_DIR_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd']);
const PM_VALUE_FLAGS = new Set(['--filter', '-F', '--workspace']);
const BUN_OWN = new Set(['build', 'install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'link', 'unlink', 'pm', 'create', 'init', 'upgrade', 'outdated', 'publish', 'patch', 'exec', 'repl', 'audit', 'info', 'why']);

function packageScript(pm, args, dir, depth) {
  let k = 0;
  for (; k < args.length && args[k].startsWith('-'); k++) {
    const eq = /^(--[\w-]+)=(.*)$/.exec(args[k]);
    const flag = eq ? eq[1] : args[k];
    const value = eq ? eq[2] : PM_DIR_FLAGS.has(flag) || PM_VALUE_FLAGS.has(flag) ? args[++k] : null;
    if (PM_DIR_FLAGS.has(flag) && value) dir = path.resolve(dir, msysToWin(value)); // npm --prefix app, pnpm -C app
  }
  let name = args[k];
  if (!name) return null;
  if (name === 'run' || name === 'run-script') name = args[++k];
  else if (pm === 'bun' && name === 'test') return !args.slice(k + 1).some((a) => !a.startsWith('-') && !/^\d+$/.test(a)) ? job('a full bun test run', 'bun-test') : null; // bun's own runner; a word is a filter
  else if (pm === 'bun' && BUN_OWN.has(name)) return null; // bun's own commands win over scripts
  else if (pm === 'npm' && !['test', 't'].includes(name)) return null; // npm install and the other built-ins
  if (!name || depth >= 3) return null;
  if (name === 't') name = 'test';
  const extra = args.slice(k + 1).filter((a) => a !== '--');
  const scripts = readScripts(dir);
  if (scripts && typeof scripts[name] === 'string') {
    const body = [scripts[name], ...extra.map((a) => `'${a.replace(/'/g, '')}'`)].join(' ');
    const inner = heavyJob(body, 'Bash', dir, depth + 1);
    // the package manager's own process lives as long as the script, pre- and post-scripts too
    return inner ? job(`\`${pm} run ${name}\` (${inner.why})`, `run:${name}|${inner.marker}`) : null;
  }
  if (pm !== 'npm') { // bun, pnpm and yarn run node_modules/.bin/<name> when no script has the name
    const bin = heavyOne({ tool: base(name), args: extra.map((v) => ({ v })), script: null }, dir, depth + 1);
    if (bin) return bin;
  }
  if (scripts) return null; // not a script here: the command will fail fast, not run long
  return /^(build|test|e2e|smoke)(:|$)/.test(name) && !extra.some(pathlike) ? job(`\`${pm} run ${name}\``, `run:${name}|any`) : null;
}

// Commits count as heavy when the pre-commit hook type-checks the whole project. With -n or a dry run the
// hook does not run, so they do not.
const GIT_VALUE_FLAGS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
function gitCommit(args, dir) {
  let k = 0;
  for (; k < args.length && args[k].startsWith('-'); k++) {
    if (args[k] === '-C' && args[k + 1]) dir = path.resolve(dir, msysToWin(args[++k]));
    else if (GIT_VALUE_FLAGS.has(args[k])) k++;
  }
  if (args[k] !== 'commit') return null;
  if (args.slice(k + 1).some((a) => ['-n', '--no-verify', '--dry-run', '-h', '--help'].includes(a))) return null;
  for (let d = path.resolve(dir), n = 0; n < 12; n++) {
    if (fs.existsSync(path.join(d, '.git'))) {
      let hook = '';
      try { hook = fs.readFileSync(path.join(d, '.husky', 'pre-commit'), 'utf8'); } catch (_e) { return null; }
      // A comment line naming tsc runs nothing, so it must not make every commit wait on the gate.
      const code = hook.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      return /(^|[\s/])tsc\s/m.test(code) ? job('a commit whose pre-commit hook type-checks the whole project', 'git-commit') : null;
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

function heavyOne(r, dir, depth) {
  let tool = r.tool;
  let args = r.args.map((x) => x.v);
  if (r.script) {
    const sp = r.script.replace(/\\/g, '/').toLowerCase();
    const name = path.posix.basename(sp);
    if (/(^|\/)vitest(\/vitest)?\.mjs$/.test(sp)) tool = 'vitest';
    else if (/playwright[^/]*\/cli\.js$/.test(sp)) tool = 'playwright';
    else if (/(^|\/)tsc(\.js)?$/.test(sp)) tool = 'tsc';
    else if (/(^|\/)vite(\/bin\/vite)?\.js$/.test(sp)) tool = 'vite';
    else return /smoke|mutate|lighthouse/.test(name) ? job(`the script ${name}`, `script:${name}`) : null;
    args = r.scriptArgs.map((x) => x.v);
  }
  switch (tool) {
    case 'playwright': return args.includes('test') && !args.some((a) => ['--list', '--help', '-h', '--version', '-V'].includes(a)) ? job('a Playwright run', 'playwright') : null;
    case 'vitest': return vitestFull(args) ? job('a full vitest run', 'vitest') : null;
    case 'tsc': return tscFull(args) ? job('a whole-project TypeScript check', 'tsc') : null;
    case 'vite': return args[0] === 'build' ? job('a vite build', 'vite') : null;
    case 'vercel': return args[0] === 'build' ? job('a vercel build', 'vercel') : null;
    case 'ffmpeg': return args.includes('-i') ? job('an ffmpeg render', 'ffmpeg') : null;
    case 'npm': case 'pnpm': case 'yarn': case 'bun': return packageScript(tool, args, dir, depth);
    case 'git': return gitCommit(args, dir);
    default: return null;
  }
}

const msysToWin = (p) => !isWindows() ? p : p.replace(/^\/([a-zA-Z])\//, (_m, d) => `${d.toUpperCase()}:/`);

// The heavy local job a command starts (browser runs, full suites, whole-project type checks,
// builds, renders, smoke and mutation scripts) as { why, marker }, or null for anything else.
// `marker` names the process the job runs as, so the gate can tell when it has ended.
function heavyJob(cmd, shell, cwd, depth = 0) {
  let dir = cwd || process.cwd();
  for (const words of parse(cmd, shell)) {
    const r = resolve(words);
    if (!r) continue;
    if (['cd', 'pushd', 'set-location', 'sl'].includes(r.first)) {
      const t = r.rest.find((x) => !x.v.startsWith('-'));
      if (t) dir = path.resolve(dir, msysToWin(t.v));
      continue;
    }
    if (['bash', 'sh'].includes(r.first)) { // bash -c "npx vitest run" runs its string
      const c = r.rest.findIndex((x) => /^-[a-z]*c[a-z]*$/.test(x.v));
      const inner = c >= 0 && r.rest[c + 1] && depth < 3 ? heavyJob(r.rest[c + 1].v, 'Bash', dir, depth + 1) : null;
      if (inner) return inner;
      continue;
    }
    const found = heavyOne(r, dir, depth);
    if (found) return found;
  }
  return null;
}

function heavyReason(cmd, shell, cwd) {
  const found = heavyJob(cmd, shell, cwd);
  return found ? found.why : null;
}

// How each heavy job shows up in a process's command line. They must not match helpers that run all day,
// such as an editor's TypeScript server or a dev server.
const MARKERS = {
  vitest: /vitest[\\/]vitest\.mjs|(^|[\\/\s"'])vitest(\.cmd|\.exe)?["']?(\s|$)/i,
  tsc: /(^|[\\/\s"'])tsc(\.js|\.cmd|\.exe)?(?=["'\s]|$)/i,
  playwright: /playwright[^\s"']*["']?\s+test(?=\s|$)/i,
  vite: /(^|[\\/\s"'])vite(\.js|\.cmd|\.exe)?["']?\s+build(?=\s|$)/i,
  vercel: /vercel[^\s"']*["']?\s+build(?=\s|$)/i,
  ffmpeg: /(^|[\\/\s"'])ffmpeg(\.exe)?["']?(\s|$)/i,
  'bun-test': /(^|[\\/\s"'])bun(\.exe)?["']?\s+test(?=\s|$)/i,
  // how Windows lists it: "<Git folder>\mingw64\bin\git.exe" commit -m ...
  // (markerAlive checks the program is git; this reads the words after it)
  'git-commit': /^\s*(?:"[^"]+"|\S+)\s+(?:-c\s+(?:"[^"]*"|\S+)\s+|-C\s+(?:"[^"]*"|\S+)\s+|--[\w-]+=\S+\s+)*commit(?=\s|$)/i,
};

// A search or a commit that names a tool is not the tool running.
const TEXT_TOOLS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'findstr', 'git', 'ag', 'ack', 'less', 'more', 'cat', 'head', 'tail', 'sed', 'awk']);
const program = (line) => { const m = /^\s*(?:"([^"]+)"|(\S+))/.exec(line); return m ? base(m[1] || m[2]) : ''; };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whether any running command line is the job `marker` names: alternatives split by |, where
// 'any' is any heavy tool, script:<file> a script file and run:<name> a package manager running
// script <name> (`bun run build`, `npm-cli.js" run build`, `pnpm.cjs" build`, `npm-cli.js" test`).
function markerAlive(marker, procs) {
  const live = procs.filter((p) => !TEXT_TOOLS.has(program(p)));
  return String(marker || 'any').split('|').some((m) => {
    if (m === 'git-commit') return procs.some((p) => program(p) === 'git' && MARKERS[m].test(p)); // git is the job here
    let res;
    if (m.startsWith('script:')) res = [new RegExp(`(^|[\\\\/\\s"'])${escapeRe(m.slice(7))}(?=["'\\s]|$)`, 'i')];
    else if (m.startsWith('run:')) res = [new RegExp(`(?:(?:^|[\\s"'])run(?:-script)?|(?:^|[\\\\/\\s"'])(?:npm-cli\\.js|pnpm(?:\\.c?js|\\.exe|\\.cmd)?|yarn(?:\\.c?js|\\.exe|\\.cmd)?)["']?)\\s+["']?${escapeRe(m.slice(4))}["']?(?=\\s|$)`, 'i')];
    else res = MARKERS[m] ? [MARKERS[m]] : Object.values(MARKERS);
    return live.some((p) => res.some((re) => re.test(p)));
  });
}

// The command lines of every running program that is not a shell, or null when they cannot be
// read. Shells are left out because their command lines hold the text of what they run, and a
// grep for "vitest" is not a vitest run. VIBEQUARTERS_HEAVY_PROCS pins the list (a JSON array, or
// "fail"); the tests use it.
function scanProcesses() {
  const pinned = process.env.VIBEQUARTERS_HEAVY_PROCS;
  if (pinned !== undefined) {
    try { const a = JSON.parse(pinned); return Array.isArray(a) ? a.map(String) : null; } catch (_e) { return null; }
  }
  try {
    const opts = { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024 };
    if (process.platform === 'win32') {
      const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.Name -notmatch '^(bash|sh|zsh|dash|powershell|pwsh|cmd|conhost)\\.exe$' } | ForEach-Object { $_.CommandLine -replace '[\\r\\n]+', ' ' }";
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], opts);
      return r.status === 0 && r.stdout ? r.stdout.split(/\r?\n/).filter(Boolean) : null;
    }
    const r = spawnSync('ps', ['-axo', 'args='], opts);
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout.split('\n').filter((l) => l && !/^(\S*\/)?-?(ba|z|da)?sh\b/.test(l.trim()));
  } catch (_e) { return null; }
}

// ---------- the heavy-job gate ----------
// Each heavy job writes a claim file into heavy-claims/. A claim holds the gate while its job is
// starting (GRACE_MS) and then only while a process running that job is up, so a call that never
// ran (another hook denied it), crashed, timed out or finished frees the gate on its own, with
// no reliance on PostToolUse. When the process list cannot be read, a claim holds until its own
// end: the call's timeout plus a minute in the foreground, 30 minutes in the background.
// A job may start only when its claim is the only live one, which two racing jobs cannot both see.

const START_MAX_CPU = Number(HYG.heavyMaxCpu) > 0 ? Number(HYG.heavyMaxCpu) : 75; // a heavy job starts only under this total CPU
const GRACE_MS = 30000; // a claim holds this long whether or not its process is up yet
const CLOCK_SLACK_MS = 60000;
const FG_DEFAULT_MS = 120000; // the Bash tool's default timeout
const FG_MAX_MS = 600000; // and its ceiling
const FG_MARGIN_MS = 60000;
const BG_MAX_MS = 30 * 60000;

const lockDir = () => process.env.VIBEQUARTERS_HEAVY_DIR || path.join(os.homedir(), '.claude', 'coordination');
const claimsDir = () => path.join(lockDir(), 'heavy-claims');
const gatePath = () => path.join(__dirname, 'heavy-gate.cjs').replace(/\\/g, '/');
const maxSpan = (bg) => (bg ? BG_MAX_MS : FG_MAX_MS + FG_MARGIN_MS);

// Total CPU busy percent over a short sample. VIBEQUARTERS_HEAVY_CPU pins it (the tests use it).
function cpuPercent(ms = 1000) {
  const pinned = Number(process.env.VIBEQUARTERS_HEAVY_CPU);
  if (process.env.VIBEQUARTERS_HEAVY_CPU !== undefined && Number.isFinite(pinned)) return Promise.resolve(pinned);
  const times = () => os.cpus().reduce((a, c) => {
    const t = c.times;
    a.idle += t.idle;
    a.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return a;
  }, { idle: 0, total: 0 });
  const a = times();
  return new Promise((resolveCpu) => setTimeout(() => {
    const b = times();
    const total = b.total - a.total;
    resolveCpu(total > 0 ? 100 * (1 - (b.idle - a.idle) / total) : 0);
  }, ms));
}

function readClaims() {
  let names = [];
  try { names = fs.readdirSync(claimsDir()); } catch (_e) { return []; }
  return names.filter((f) => f.endsWith('.json')).map((f) => {
    const file = path.join(claimsDir(), f);
    let c = null;
    try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { /* unreadable: holds nothing */ }
    const ok = c && typeof c.started === 'number' && typeof c.until === 'number' && typeof c.command === 'string';
    return { file, c: ok ? c : null };
  });
}

function unlinkQuiet(file) {
  try { fs.unlinkSync(file); } catch (_e) { /* gone already, or not removable: it holds nothing either way */ }
}

// Lists running programs at most once per decision, and only if a claim needs it.
function lazyScan() {
  let procs;
  return () => (procs === undefined ? (procs = scanProcesses()) : procs);
}

function alive(c, now, scan) {
  if (!c) return false;
  if (c.started > now + CLOCK_SLACK_MS || c.until - c.started > maxSpan(c.background) + CLOCK_SLACK_MS) return false; // a clock set back, or a bad file
  if (now >= c.until) return false;
  if (now - c.started < GRACE_MS) return true;
  const procs = scan();
  return procs === null ? true : markerAlive(c.marker, procs);
}

// The claims that hold the gate now, clearing dead ones on the way. `skip` is the caller's own.
function holders(now = Date.now(), scan = lazyScan(), skip = null) {
  const out = [];
  for (const { file, c } of readClaims()) {
    if (file === skip) continue;
    if (alive(c, now, scan)) out.push(c);
    else unlinkQuiet(file);
  }
  return out;
}

function describe(c, now = Date.now()) {
  const mins = Math.max(0, Math.round((now - c.started) / 60000));
  const cmd = String(c.command || '').split('\n')[0].slice(0, 100);
  return `${c.background ? 'a background' : 'a'} heavy job (\`${cmd}\`, started ${mins} min ago, ${now - c.started < GRACE_MS ? 'starting' : 'still running'})`;
}

// Claims the gate for a heavy job, or says why not: { ok, why, lock }.
function acquire(rec, cpu) {
  if (cpu >= START_MAX_CPU) return { ok: false, why: `total CPU is at ${Math.round(cpu)}% (a heavy job starts only under ${START_MAX_CPU}%)` };
  const now = Date.now();
  const scan = lazyScan();
  const command = redact(rec.command || '').slice(0, 300);
  fs.mkdirSync(claimsDir(), { recursive: true });
  // The same tool call evaluated twice is one claim. Any other call waits, even from this
  // session: a parallel call, or a subagent, carries the same session id.
  for (const { file, c } of readClaims()) if (c && rec.id && c.id === rec.id) unlinkQuiet(file);
  const lock = { id: rec.id || `anon-${now}`, session: rec.session || '', command, marker: rec.marker || 'any', background: !!rec.background, started: now };
  lock.until = now + (rec.background ? Math.min(rec.timeoutMs || BG_MAX_MS, BG_MAX_MS) : Math.min(rec.timeoutMs || FG_DEFAULT_MS, FG_MAX_MS) + FG_MARGIN_MS);
  const name = path.join(claimsDir(), `${now}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  fs.writeFileSync(`${name}.tmp`, JSON.stringify(lock));
  fs.renameSync(`${name}.tmp`, `${name}.json`); // whole or not at all: nobody reads half a claim
  const others = holders(now, scan, `${name}.json`);
  if (others.length) { unlinkQuiet(`${name}.json`); return { ok: false, why: `${describe(others[0], now)} holds the gate` }; }
  return { ok: true, lock };
}

// For heavy-gate.cjs: removes every claim, whoever made it. Returns what it removed.
function forceRelease() {
  const gone = [];
  for (const { file, c } of readClaims()) {
    try { fs.unlinkSync(file); gone.push(c || { command: '(unreadable claim)', started: Date.now() }); } catch (_e) { /* not removable */ }
  }
  return gone;
}

// Ends the claims these tool calls made (guard-shell-hygiene.js, once a call is denied or done).
// Returns what it removed.
function releaseCalls(ids) {
  const want = new Set(ids.filter(Boolean));
  const gone = [];
  if (!want.size) return gone;
  for (const { file, c } of readClaims()) if (c && want.has(c.id)) { unlinkQuiet(file); gone.push(c); }
  return gone;
}

// Secrets in a command never reach the log, a claim file, or the deny another session reads:
// NAME=value prefixes, Bearer/Basic credentials, --token style flags and well-known key shapes.
function redact(s) {
  return String(s)
    .replace(/(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1$2=***')
    .replace(/\b(Bearer|Basic)(\s+)[^\s"']+/gi, '$1$2***')
    .replace(/(--?(?:token|password|passwd|secret|api-?key|auth|key)[= ])("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/\b(?:sk|pk|rk)_(?:live|test)_\w+|\b(?:vcp|ghp|gho|ghs|ghu|github_pat|sbp|xox[abpr])_[\w-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '***');
}

// One line per decision, kept under 256 KB.
function log(line) {
  try {
    fs.mkdirSync(lockDir(), { recursive: true });
    const file = path.join(lockDir(), 'shell-hygiene.log');
    fs.appendFileSync(file, `${new Date().toISOString()} ${redact(line).replace(/\s+/g, ' ').slice(0, 400)}\n`);
    if (fs.statSync(file).size > 262144) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(-131072));
  } catch (_e) { /* logging never blocks */ }
}

// ---------- known pitfalls (a NOTE, never a block) ----------

// Command shapes that fail in a misleading way. An entry is one regex over a single statement's words.
// Add one only when the shape cannot match an innocent command, and key it on the tool that statement
// really runs, since a note shown for nothing gets ignored.
const PITFALLS = [
  {
    tag: 'dash-grep',
    tools: ['grep', 'egrep', 'rg'],
    when: /-[A-Za-z]*P\b|--perl-regexp/,
    also: /\\x\{/,
    note: 'grep -P with a \\x{...} escape can exit 2 in Git Bash ("character value in \\x{} too large"), so the check never runs and its empty output reads like a pass. Search for the character\'s UTF-8 bytes instead (for an em dash: grep -c $\'\\xe2\\x80\\x94\' <file>), and first prove the search finds a line known to hold one.',
  },
  {
    tag: 'vitest-basic',
    tools: ['vitest', 'bun', 'bunx', 'npm', 'npx', 'node'],
    when: /--reporter[= ]basic/,
    note: 'the basic reporter was removed from vitest, so this run stops at ERR_LOAD_URL with no test executed. Leave the reporter at its default.',
  },
  {
    tag: 'node-test-grep',
    tools: ['grep', 'egrep', 'rg'],
    when: /#\s*(tests|pass|fail)\b/,
    note: 'the totals of node --test start with an info sign (U+2139), not with #, so this search finds nothing and looks like a pass. Use grep -E \'(tests|pass|fail) [0-9]+$\' instead.',
  },
];

// The first pitfall a statement of this command trips, or null. Keyed on the program the
// statement actually runs (resolve unwraps npx/bunx), never on the whole payload text.
function pitfallNote(cmd, shell) {
  let stmts;
  try {
    stmts = parse(cmd, shell);
  } catch {
    return null; // FAIL OPEN: a note is never worth a broken call
  }
  for (const words of stmts) {
    const ws = (words || []).filter((w) => !w.redir);
    if (!ws.length) continue;
    const run = resolve(ws); // null for a statement that runs no program: }, FOO=1, command -v x
    if (!run) continue;
    const tool = base(run.tool || '');
    const text = ws.map((w) => w.v).join(' ');
    for (const p of PITFALLS) {
      if (!p.tools.includes(tool)) continue;
      if (!p.when.test(text)) continue;
      if (p.also && !p.also.test(text)) continue;
      return { tag: p.tag, note: p.note };
    }
  }
  return null;
}

module.exports = {
  parse, resolve, inlineProblem, msysProblem, cdProblem, redirectProblem, tokenProblem, gitPathProblem, jqProblem, pitfallNote,
  heavyJob, heavyReason, markerAlive, scanProcesses, cpuPercent, holders, describe, acquire, forceRelease, releaseCalls, log, gatePath,
  START_MAX_CPU, MSYS_PATH,
};
