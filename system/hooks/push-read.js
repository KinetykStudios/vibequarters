// push-read :: shared helper, not a hook
// What a git push in a command does, from the command's own words: quotes and escapes off, options in any order and
// shortened as git takes them, through -c aliases, wrappers (sudo, xargs) and the text a shell is told to run. Used by
// guard-deny-catastrophic.js. It reads what the command spells out: not a script file, a variable's value, or an alias
// that a config file already holds.
'use strict';
const { parse } = require('./shell-hygiene-lib');

// Commands that only read, print or record the words given to them
const DATA = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'cat', 'head', 'tail', 'ls', 'wc', 'pwd', 'git', 'gh', 'write-output', 'write-host', 'select-string']);
// Commands that run text given to them: with one in the line, even printed words may run (echo "..." | sh)
const RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh', 'eval', 'iex', 'invoke-expression', 'xargs', 'parallel', 'ssh', 'wsl', 'source']);
const GIT_RUNS = new Set(['submodule', 'bisect', 'rebase', 'filter-branch']);
const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
const PUSHES = new Set(['push', 'send-pack', 'http-push']);
const BOTH = ['Bash', 'PowerShell']; // text inside a command may be for either shell
const MAX_DEPTH = 5;
const MAX_TEXTS = 300; // nested texts read for one command

const nameOf = (w) => w.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
const statements = (text, shells) => shells.flatMap((shell) => parse(text, shell)).map((ws) => ws.filter((w) => !w.redir)).filter((ws) => ws.length);

// 'force', 'delete' (of a ref ctx.isProtected names) or null, from the words after push
function pushProblem(args, ctx) {
  // a long option or a start of its name, as git takes it: --forc, --dele, --mirr
  const long = (full) => args.some((a) => a.startsWith('--') && a.length > 2 && full.startsWith(a.split('=')[0]));
  const short = (letter) => args.some((a) => new RegExp(`^-[vqnudf46]*${letter}`).test(a));
  const refs = args.filter((a) => !a.startsWith('-'));
  if (['--force', '--force-with-lease', '--force-if-includes', '--mirror'].some(long) || short('f') || refs.some((r) => r.startsWith('+'))) return 'force';
  const gone = long('--delete') || short('d') ? refs : refs.filter((r) => r.startsWith(':'));
  return gone.some((r) => ctx.isProtected(r.replace(/^:?(?:(?:refs\/)?heads\/)?/, ''))) ? 'delete' : null;
}

// The words after git, with the aliases set so far
function gitProblem(words, ctx, aliases, depth) {
  if (depth > MAX_DEPTH) return 'force';
  const known = { ...aliases };
  let forced = false;
  let i = 0;
  for (; i < words.length && words[i].startsWith('-'); i += GIT_VALUE.has(words[i]) ? 2 : 1) {
    if (words[i] !== '-c') continue;
    const [, key, value = 'true'] = /^([^=]*)(?:=([^]*))?$/.exec(words[i + 1] || '');
    const name = key.toLowerCase();
    if (name.startsWith('alias.')) known[name.slice(6)] = value;
    else if (/^remote\..*\.push$/.test(name)) forced = forced || value.startsWith('+');
    else if (/^remote\..*\.mirror$/.test(name)) forced = forced || !/^(?:false|no|off|0)?$/i.test(value);
  }
  const sub = (words[i] || '').toLowerCase();
  const rest = words.slice(i + 1);
  if (PUSHES.has(sub)) return forced ? 'force' : pushProblem(rest, ctx);
  if (sub === 'config') {
    const k = rest.findIndex((w) => /^alias\./i.test(w));
    return k >= 0 && rest[k + 1] ? aliasProblem(rest[k + 1], [], ctx, known, depth) : null;
  }
  return Object.hasOwn(known, sub) ? aliasProblem(known[sub], rest, ctx, known, depth) : null;
}

function aliasProblem(value, rest, ctx, aliases, depth) {
  if (value.startsWith('!')) return readText(`${value.slice(1)} ${rest.join(' ')}`, BOTH, ctx, depth + 1);
  const words = (statements(value, ['Bash'])[0] || []).map((w) => w.v);
  return gitProblem([...words, ...rest], ctx, aliases, depth + 1);
}

// One command's words
function partProblem(words, runs, ctx, depth) {
  const v = words.map((w) => w.v);
  let from = 0;
  while (from < v.length && /^[A-Za-z_]\w*=/.test(v[from])) from++;
  const head = nameOf(v[from] || '');
  const gitRuns = head === 'git' && v.some((w) => GIT_RUNS.has(w));
  const data = DATA.has(head) && !gitRuns;
  for (let i = from; i < v.length && (i === from || !data); i++) {
    const name = nameOf(v[i]);
    const git = name === 'git' || nameOf(words[i].dq) === 'git' || /^\$\{?\w+\}?$/.test(v[i]) ? v.slice(i + 1) // "$GIT" may be git
      : /^git-(?:push|send-pack|http-push)$/.test(name) ? [name.slice(4), ...v.slice(i + 1)] : null;
    const found = git && gitProblem(git, ctx, {}, depth);
    if (found) return found;
  }
  if (data && !runs) return null;
  for (const w of words.slice(from + 1)) {
    const found = w.quoted && /[\s;|&`(]/.test(w.v) ? readText(w.v, BOTH, ctx, depth + 1) : null;
    if (found) return found;
  }
  return null;
}

function readText(text, shells, ctx, depth) {
  const key = shells.length + text;
  if (depth > MAX_DEPTH || ctx.seen.has(key) || ctx.seen.size >= MAX_TEXTS) return null;
  ctx.seen.add(key);
  const cmd = text.replace(/\$\{?IFS\}?/g, ' ');
  const texts = [cmd];
  if (cmd.includes('^') && /\bcmd\b/i.test(cmd)) texts.push(cmd.replace(/\^/g, '')); // cmd.exe's escape
  // what $( ) and backticks hold runs even inside double quotes, and so does a heredoc that a shell reads
  for (const m of cmd.matchAll(shells[0] === 'PowerShell' ? /\$\(/g : /\$\(|`/g)) texts.push(cmd.slice(m.index + m[0].length));
  for (const m of cmd.matchAll(/\b(?:sh|bash|zsh|dash|ksh)\b[^\n]*<<-?\s*\\?["']?\w[^\n]*\n/g)) texts.push(cmd.slice(m.index + m[0].length));
  for (const t of texts.slice(0, MAX_TEXTS)) {
    const parts = statements(t, shells);
    const runs = parts.some((p) => p.some((w) => RUNNERS.has(nameOf(w.v))));
    for (const p of parts) {
      const found = partProblem(p, runs, ctx, depth);
      if (found) return found;
    }
  }
  return null;
}

// 'force', 'delete' or null for the first git push in a command that rewrites a branch, or deletes one isProtected names
function pushIn(command, shell, isProtected) {
  const cmd = String(command);
  if (!/push|send-pack/i.test(cmd.replace(/["'`\\^]/g, ''))) return null;
  return readText(cmd, [shell === 'PowerShell' ? 'PowerShell' : 'Bash'], { isProtected, seen: new Set() }, 0);
}

module.exports = { pushIn };
