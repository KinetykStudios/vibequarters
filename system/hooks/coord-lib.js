// vibequarters :: session coordination, shared state + git helpers.
// Used by coord-guard.js (PreToolUse), coord-session.js (SessionStart/SessionEnd) and coord.js (CLI).
// Timings come from vibequarters.config.json (coordination.*); VIBEQUARTERS_COORD_DIR moves the registry folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('./vibequarters-config').load().coordination;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

const DIR = process.env.VIBEQUARTERS_COORD_DIR || path.join(os.homedir(), '.claude', 'coordination');
const REG = path.join(DIR, 'registry.json');
const LOCKDIR = path.join(DIR, 'registry.lock');
const HANDOFFS = path.join(DIR, 'handoffs'); // <request id>.patch files written by a handoff
const GATES = path.join(DIR, 'GATE-RECORDS.md'); // every merge's gate record, appended, never trimmed
const LIVE_MS = num(C.liveHours, 72) * 3600e3; // a session unseen this long no longer counts as live
const LOCK_TTL_MS = num(C.lockMinutes, 20) * 60e3; // migration / deploy / merge locks
const GC_MS = num(C.gcDays, 14) * 24 * 3600e3; // forget sessions unseen this long
const REQ_GC_MS = num(C.requestGcDays, 7) * 24 * 3600e3; // forget requests (and their patch files) this old
const HANDOFF_MIN = num(C.forceHandoffMinutes, 15); // no answer this long: the requester may force-handoff
const CLEAR_GRACE_MS = 60e3; // coord-session.js hands an ended session to its /clear successor within this window
const WIN = process.platform === 'win32';

// VIBEQUARTERS_HOOK_PROFILE=1: ms since process start at each mark, written to stderr on exit.
const marks = [];
function mark(label) {
  if (process.env.VIBEQUARTERS_HOOK_PROFILE !== '1') return;
  if (!marks.length) process.on('exit', () => process.stderr.write(`profile ${marks.map(([l, t]) => `${l} ${t.toFixed(1)}`).join(' | ')}\n`));
  marks.push([label, performance.now()]);
}

const norm = (p) => path.resolve(String(p)).replace(/\\/g, '/');
const key = (p) => (WIN ? norm(p).toLowerCase() : norm(p));
const same = (a, b) => (WIN ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
const CLI = `node "${norm(path.join(__dirname, 'coord.js'))}"`; // wherever the system is installed

// Git Bash / PowerShell spellings -> a real path. /c/x is a drive to Git Bash only; elsewhere it is a folder of its own.
function fromShellPath(p, cwd) {
  let s = String(p).trim().replace(/^["']|["']$/g, '');
  s = s.replace(/^(\$env:USERPROFILE|\$USERPROFILE|\$HOME|~)(?=$|[\\/])/i, os.homedir());
  const m = WIN && /^\/([a-zA-Z])(\/.*)?$/.exec(s);
  if (m) s = `${m[1].toUpperCase()}:${m[2] || '/'}`;
  return norm(path.isAbsolute(s) ? s : path.join(cwd || process.cwd(), s));
}

const Q = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|]+)`;
const GIT_OPTS = String.raw`(?:\s+-[cC]\s+${Q}|\s+-[pP](?=\s)|\s+--(?:git-dir|work-tree|namespace|exec-path|config-env)\s+\S+|\s+--[\w-]+(?:=\S+)?)*`;

// The folder a shell command acts on: git -C <dir>, else a leading cd / Set-Location, else the session cwd.
function targetDir(cmd, cwd) {
  let m = new RegExp(String.raw`\bgit\s+-C\s+(${Q})`, 'i').exec(cmd);
  if (!m) m = new RegExp(String.raw`(?:^|[;&|\n(]\s*)(?:cd|pushd|Set-Location|sl)\s+(?:-Path\s+)?(${Q})`, 'i').exec(cmd);
  return m ? fromShellPath(m[1], cwd) : cwd;
}

// The command with what only looks like a command blanked, same length so offsets still line up: quoted strings (a commit
// message, a grep pattern), comments, heredoc bodies and line continuations, all in one left-to-right pass so an apostrophe
// in a comment opens no string. A string some program is told to run (bash -c "...", node -e "...") stays, and so does a
// substitution inside double quotes, which really runs.
const RUNS_STRING = /(?:\b(?:bash|sh|zsh|dash|powershell|pwsh|cmd|node|bun|deno|python[\d.]*|ruby|perl)(?:\.exe)?(?:\s+[-/]\S+(?:\s+[a-z]\w*)?)*?\s+(?:-\w*c|-command|\/c|-e|--eval)|\b(?:eval|iex|invoke-expression))\s*$/i;
const SUBSTITUTION = /\$\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)|`[^`]*`/g;
const blank = (s) => s.replace(/[^\n]/g, ' ');
function runnable(cmd) {
  return String(cmd).replace(/[\\`]\r?\n|(?<![^\s;&|(])#[^\n]*|<<-?\s*(["']?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s*(?:\n|$))|\\[\s\S]|"(?:[^"\\]|\\[\s\S])*"|'[^']*'/g, (m, _q, tag, at, all) => {
    if (tag || m[0] === '#' || /^[\\`]\r?\n$/.test(m)) return blank(m);
    if (m[0] === '\\' || RUNS_STRING.test(all.slice(0, at))) return m;
    if (m[0] === "'") return `'${blank(m.slice(1, -1))}'`;
    const inner = m.slice(1, -1);
    let out = '';
    let last = 0;
    for (const s of inner.matchAll(SUBSTITUTION)) {
      out += blank(inner.slice(last, s.index)) + runnable(s[0]);
      last = s.index + s[0].length;
    }
    return `"${out}${blank(inner.slice(last))}"`;
  });
}

// The offset just after the ) closing a $( whose body starts at j. A heredoc body is skipped whole and a quoted string
// hides its parentheses, so a --body "$(cat <<'EOF' ... EOF)" ends where the shell ends it.
function afterSubstitution(text, j) {
  let depth = 1;
  while (j < text.length && depth > 0) {
    const h = text[j] === '<' && /^<<-?[ \t]*(["']?)(\w+)\1[^\n]*\n/.exec(text.slice(j));
    if (h) {
      const from = j + h[0].length - 1;
      const end = new RegExp(String.raw`\n[ \t]*${h[2]}[ \t]*(?=\r?\n|$)`).exec(text.slice(from));
      j = end ? from + end.index + end[0].length : text.length;
    } else if (text[j] === "'") {
      const e = text.indexOf("'", j + 1);
      j = e < 0 ? text.length : e + 1;
    } else if (text[j] === '"') {
      j++;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j += 2;
        else if (text.startsWith('$(', j)) j = afterSubstitution(text, j + 2);
        else j++;
      }
      j++;
    } else {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') depth--;
      j++;
    }
  }
  return j;
}

// The words of one shell command, up to its first unquoted ; & | ) or newline, as Git Bash reads them: quotes removed and
// joined to the word around them, \" and \' and PowerShell's `" a literal quote, a # that starts a word a comment, a $( ... )
// one piece of its word. Any other backslash stays, for a Windows path. A line ending in a Git Bash \ or a PowerShell `
// continues on the next. literal: text a session typed as coord.js args, where a # or ) is only a character.
function tokens(s, literal = false) {
  const out = [];
  const text = String(s).replace(/[\\`]\r?\n/g, ' ');
  const n = text.length;
  let i = 0;
  const endsCommand = literal ? /[;&|\n]/ : /[;&|\n)]/;
  const endsWord = literal ? /[\s;&|]/ : /[\s;&|)]/;
  while (i < n && !endsCommand.test(text[i])) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (!literal && text[i] === '#') { while (i < n && text[i] !== '\n') i++; continue; }
    let w = '';
    while (i < n && !endsWord.test(text[i])) {
      const c = text[i];
      if (c === "'") {
        const e = text.indexOf("'", i + 1);
        if (e >= 0) w += text.slice(i + 1, e);
        i = e >= 0 ? e + 1 : i + 1; // an unclosed quote is no quote
      } else if (c === '"') {
        const open = i;
        let inner = '';
        i++;
        while (i < n && text[i] !== '"') {
          if ((text[i] === '\\' && /["\\$`]/.test(text[i + 1] || '')) || (text[i] === '`' && text[i + 1] === '"')) { inner += text[i + 1]; i += 2; }
          else if (text.startsWith('$(', i)) { const e = afterSubstitution(text, i + 2); inner += text.slice(i, e); i = e; }
          else inner += text[i++];
        }
        if (i < n) { w += inner; i++; }
        else { // no close once \" is an escape: PowerShell's "C:\dir\", else an unclosed quote
          const e = text.indexOf('"', open + 1);
          if (e >= 0) w += text.slice(open + 1, e);
          i = e >= 0 ? e + 1 : open + 1;
        }
      } else if (c === '\\' && /["']/.test(text[i + 1] || '')) { w += text[i + 1]; i += 2; }
      else if (text.startsWith('$(', i)) { const e = afterSubstitution(text, i + 2); w += text.slice(i, e); i = e; }
      else w += text[i++];
    }
    out.push(w);
  }
  return out;
}

// A plain read of one shell command that only ; & | or a newline ends: words, each quoted run its own word, and runs, the
// words as the command spaces them, so "$L"/a is one run of two words and a lone comma ends a run, so PowerShell's
// "a","b" is two. read: the text it covered.
function plainRead(s) {
  const words = [];
  const runs = [];
  const text = String(s).replace(/[\\`]\r?\n/g, ' ');
  const re = /"([^"]*)"|'([^']*)'|([^\s;&|"']+)|([;&|\n])/g;
  let m;
  let end = -1;
  let stop = text.length;
  let last = '';
  while ((m = re.exec(text))) {
    if (m[4]) { stop = m.index; break; }
    const w = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    // a comma ends a run on either side, quoted or not: "a",b,"c" is three
    if (m.index === end && !last.endsWith(',') && !(m[0].startsWith(',') && m[0] !== ',')) runs[runs.length - 1] += w;
    else runs.push(w);
    words.push(w);
    end = m.index + m[0].length;
    last = m[0];
  }
  return { words, runs, read: text.slice(0, stop) };
}

// The words of a guard that denies: tokens reads a command as the shell does, but a read that starts inside a string or at a
// ) can lose the real target, so these also take every word of the plain read. Reading too many here is safe; reading
// fewer is a hole. tokens reads only as far as the plain read did: past it, a PowerShell "dist\" would make the next
// command's quoted text look like targets.
function denyWords(s) {
  const { words, read } = plainRead(s);
  return [...words, ...tokens(read).filter((w) => !words.includes(w))];
}

// A gh pr merge, wherever -R sits. The one matcher every guard shares, run on unquoteWords text, whose quoted gh, quoted
// gh.exe path and quoted single word have lost their quotes at the same length. runnable keeps a blanked string's quotes,
// so a value here may be a quoted run.
const MERGE_VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]*)`;
const MERGE_FLAGS = String.raw`(?:\s+(?:(?:-R|--repo)(?:\s+${MERGE_VALUE})?|-[^\s;&|="']*(?:=?${MERGE_VALUE})?))*`;
const MERGE_SRC = String.raw`\bgh(?:\.exe)?${MERGE_FLAGS}\s+pr${MERGE_FLAGS}\s+merge\b`;
const unquoteWords = (cmd) => String(cmd).replace(/(?<![^\s;&|(])(["'])((?:[^"'\n]*[\\/])?gh(?:\.exe)?|[\w./\\:@=-]+)\1(?![^\s;&|)])/gi, (_m, _q, w) => ` ${w} `);

// Unquoted ; & | and newlines, as Git Bash (\ escapes) and PowerShell (` escapes) each read the quoting, so neither
// shell's rules can hide one. The & and | of a redirect (2>&1, &>, >|) are not separators.
const SPLIT = [
  /\\[\s\S]|"(?:[^"\\]|\\[\s\S])*"|'[^']*'|((?<![<>])&(?!>)|(?<!>)\||[;\n])/g,
  /`[\s\S]|"(?:[^"`]|`[\s\S])*"|'[^']*'|((?<![<>])&(?!>)|(?<!>)\||[;\n])/g,
];
// Offsets where a command starts: 0, and right after each separator either shell sees.
function commandStarts(cmd) {
  const at = new Set([0]);
  for (const re of SPLIT) for (const m of cmd.matchAll(re)) if (m[1]) at.add(m.index + 1);
  return [...at];
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// A repo's name as a key: the lowercase owner/repo of a GitHub name, '' for anything else (a folder's name has no slash).
const slugKey = (name) => (/^[^/\s]+\/[^/\s]+$/.test(String(name || '')) ? String(name).toLowerCase() : '');

// load() keeps only the fields below; anything else in the file is dropped on the next write.
function empty() { return { sessions: {}, claims: [], locks: {}, notes: [], requests: [], landTabs: {} }; }

function load() {
  try {
    mark('load>');
    const r = JSON.parse(fs.readFileSync(REG, 'utf8'));
    mark('load<');
    // a hand-edited or corrupt entry must never break every session's writes; the id names its patch file, so it
    // must be exactly what request() generates
    const requests = Array.isArray(r.requests)
      ? r.requests.filter((q) => q && typeof q === 'object' && typeof q.id === 'string' && /^req-[0-9a-f]{6}$/.test(q.id)) : [];
    // "<owner/repo>#<pr>" -> when a fixer session's /land tab for it was opened (coord-land.js fixerShip)
    const landTabs = r.landTabs && typeof r.landTabs === 'object' && !Array.isArray(r.landTabs) ? r.landTabs : {};
    return { sessions: r.sessions || {}, claims: r.claims || [], locks: r.locks || {}, notes: r.notes || [], requests, landTabs };
  } catch (_e) {
    return empty();
  }
}

// Serialized read-modify-write across every session on the machine.
function update(fn) {
  fs.mkdirSync(DIR, { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(LOCKDIR); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(LOCKDIR).mtimeMs > 10e3) { fs.rmdirSync(LOCKDIR); continue; }
      } catch (_e) { /* raced with the holder releasing it */ }
      if (Date.now() - t0 > 4e3) throw new Error('coordination registry lock timeout');
      sleep(25);
    }
  }
  try {
    mark('locked');
    const reg = load();
    const result = fn(reg);
    mark('fn');
    gc(reg);
    mark('gc');
    const tmp = `${REG}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 1));
    mark('written');
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, REG); break; } catch (e) { if (i > 20) throw e; sleep(20); }
    }
    mark('saved');
    try { fs.writeFileSync(path.join(DIR, 'BOARD.md'), render(reg)); } catch (_e) { /* board is cosmetic */ }
    mark('board');
    return result;
  } finally {
    try { fs.rmdirSync(LOCKDIR); } catch (_e) { /* already gone */ }
  }
}

function gc(reg) {
  const now = Date.now();
  for (const [id, s] of Object.entries(reg.sessions)) if (now - (s.lastSeen || 0) > GC_MS) delete reg.sessions[id];
  // one disk check per worktree, not per claim, since many claims share one worktree
  const there = new Map();
  const exists = (p) => { if (!there.has(p)) there.set(p, fs.existsSync(p)); return there.get(p); };
  reg.claims = reg.claims.filter((c) => reg.sessions[c.session] && exists(c.worktree));
  for (const [n, l] of Object.entries(reg.locks)) {
    const s = reg.sessions[l.session];
    if (!s || s.endedAt || now - l.at > LOCK_TTL_MS) delete reg.locks[n];
  }
  reg.notes = reg.notes.slice(-30);
  reg.requests = reg.requests.filter((q) => {
    if (now - (Number(q.at) || 0) <= REQ_GC_MS) return true;
    // the record is untrusted: unlink only a file directly inside the handoffs folder, where writePatch puts them
    if (typeof q.patch === 'string' && key(path.dirname(q.patch)) === key(HANDOFFS)) {
      try { fs.unlinkSync(q.patch); } catch (_e) { /* already gone */ }
    }
    return false;
  });
  for (const q of reg.requests) {
    const from = reg.sessions[q.from];
    if (q.state === 'open' && (!from || (from.endedAt && now - from.endedAt > CLEAR_GRACE_MS))) {
      Object.assign(q, { state: 'withdrawn', answeredAt: now, told: true, autoWithdrawn: true });
    }
  }
}

// { top: worktree root, common: key of the shared .git dir } or null outside a repo.
function findRepo(p) {
  let dir = norm(p);
  for (;;) {
    let st = null;
    try { st = fs.statSync(dir); } catch (_e) { /* not created yet */ }
    if (st && st.isDirectory()) break;
    const up = norm(path.dirname(dir));
    if (up === dir) return null;
    dir = up;
  }
  for (;;) {
    const dotgit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch (_e) { /* keep walking */ }
    if (st) {
      if (st.isDirectory()) return { top: dir, common: key(dotgit) };
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotgit, 'utf8'));
      if (!m) return null;
      const gitdir = path.resolve(dir, m[1].trim());
      let cd = '';
      try { cd = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim(); } catch (_e) { /* not a linked worktree */ }
      return { top: dir, common: key(cd ? path.resolve(gitdir, cd) : gitdir) };
    }
    const up = norm(path.dirname(dir));
    if (up === dir) return null;
    dir = up;
  }
}

const rel = (top, abs) => path.relative(top, abs).replace(/\\/g, '/');
const repoName = (common) => (slugKey(common) === common ? common : path.basename(path.dirname(common)));

function git(cwd, args) {
  try {
    mark(`git ${args[0]}>`);
    const out = execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, windowsHide: true,
    });
    return { code: 0, out: out.trimEnd() }; // leading spaces are meaningful in porcelain status
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : -1, out: String(e.stdout || '').trim() };
  } finally {
    mark('git<');
  }
}

const urlSlug = (url) => {
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url || '');
  return m ? m[1] : '';
};

// The GitHub owner/repo of a checkout's origin, or '' when origin is not on GitHub. cwd: a worktree or its .git folder.
function githubSlug(cwd) {
  return urlSlug(git(cwd, ['remote', 'get-url', 'origin']).out);
}

// gh's flags whose value is the next word, or the rest of a short flag's word: -R o/r, -Ro/r, -sR o/r, -sb text.
const GH_LONG_VALUE = new Set(['--repo', '--subject', '--body', '--body-file', '--author-email', '--match-head-commit']);
const GH_SHORT_VALUE = 'RtbFA';

// What a gh pr merge says, from its words, past every flag's value, so body text is never read as anything: pr, the first
// word after merge that is no flag ('' none), repo, the last -R (null none, '' written empty), admin and auto, and
// matchHead, the last --match-head-commit (undefined none).
function mergeArgs(t) {
  const out = { pr: '', repo: null, admin: false, auto: false };
  let merged = false;
  for (let k = 0; k < t.length; k++) {
    const a = t[k];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a : a.slice(0, eq);
      if (GH_LONG_VALUE.has(name)) {
        const v = eq < 0 ? String(t[++k] || '') : a.slice(eq + 1);
        if (name === '--repo') out.repo = v;
      else if (name === '--match-head-commit') out.matchHead = v;
      } else if (name === '--admin') out.admin = true;
      else if (name === '--auto') out.auto = true;
    } else if (a.length > 1 && a[0] === '-') {
      for (let j = 1; j < a.length; j++) {
        if (!GH_SHORT_VALUE.includes(a[j])) continue;
        const rest = a.slice(j + 1);
        const v = rest ? rest.replace(/^=/, '') : String(t[++k] || '');
        if (a[j] === 'R') out.repo = v;
        break;
      }
    } else if (merged) {
      if (!out.pr) out.pr = a;
    } else if (/^merge$/i.test(a)) merged = true;
  }
  return out;
}

const mergeSelector = (t) => mergeArgs(t).pr;

function baseRef(cwd) {
  const h = git(cwd, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (h.code === 0 && h.out && h.out !== 'origin/HEAD') return h.out;
  for (const r of ['origin/main', 'origin/master']) if (git(cwd, ['rev-parse', '--verify', '-q', r]).code === 0) return r;
  return null;
}

// Porcelain status lines -> repo-relative paths.
function statusPaths(out) {
  return out.split('\n').filter(Boolean).map((l) => {
    let p = l.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    return p.replace(/^"|"$/g, '');
  });
}

// True when the owner's own committed change to c.path is already on base (shipped, for example by a squash
// merge), proven by reverse-applying that change onto base's copy of the file in a throwaway index.
// Any error or doubt returns false, which keeps the claim active.
function ownEditShipped(c, base) {
  const fork = git(c.worktree, ['merge-base', 'HEAD', base]);
  if (fork.code !== 0 || !fork.out) return false;
  const opts = { cwd: c.worktree, encoding: 'utf8', timeout: 8000, windowsHide: true };
  let own;
  try {
    // execFileSync, not git(): git() trims the trailing newline, which corrupts a patch. No textconv or external diff
    // driver: the proof must use the real bytes
    own = execFileSync('git', ['diff', '--binary', '--no-textconv', '--no-ext-diff', fork.out, 'HEAD', '--', c.path], { ...opts, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_e) { return false; }
  if (!own) return true; // the owner never committed a change to it
  const m = /^(\d+) blob ([0-9a-f]+)\t/.exec(git(c.worktree, ['ls-tree', base, '--', c.path]).out);
  if (!m) return false;
  const index = path.join(os.tmpdir(), `coord-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `${m[1]},${m[2]},${c.path}`], { ...opts, env, stdio: 'ignore' });
    execFileSync('git', ['apply', '--cached', '--reverse', '--check'], { ...opts, env, input: own, stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch (_e) {
    return false;
  } finally {
    try { fs.unlinkSync(index); } catch (_e) { /* never created */ }
  }
}

// A claim is active while the owner's worktree still holds an unshipped change to the file: dirty, or
// different from the shipped branch without its own committed change being on that branch already.
function claimActive(c) {
  if (!fs.existsSync(c.worktree)) return false;
  if (c.heldUntil && Date.now() < c.heldUntil) return true; // handed over: the requester's while it applies the patch
  const st = git(c.worktree, ['status', '--porcelain', '--', c.path]);
  if (st.code !== 0) return false;
  if (st.out) return true;
  const base = baseRef(c.worktree);
  if (!base) return false;
  if (git(c.worktree, ['diff', '--quiet', '--no-textconv', '--no-ext-diff', base, '--', c.path]).code !== 1) return false;
  return !ownEditShipped(c, base);
}

const isLive = (s, now = Date.now()) => Boolean(s && !s.endedAt && now - (s.lastSeen || 0) < LIVE_MS);
const label = (reg, id) => (reg.sessions[id] && reg.sessions[id].name) || String(id).slice(0, 8);

// null when session id is closed (SessionEnd fired, or unseen for the live window) and each of its claim worktrees is clean with
// every commit on a remote-tracking branch: then its claims stop blocking. Otherwise why not: it is live, or what is
// unpushed. A git failure counts as unpushed. Runs git, so never under the registry lock.
function closedUnsafe(reg, id, now = Date.now()) {
  if (isLive(reg.sessions[id], now)) return `"${label(reg, id)}" is live`;
  for (const w of new Set(reg.claims.filter((c) => c.session === id).map((c) => c.worktree))) {
    if (!fs.existsSync(w)) continue; // gone: nothing left to lose, and its claims are inactive already
    const st = git(w, ['status', '--porcelain']);
    if (st.code !== 0) return `${w} could not be read`;
    if (st.out) return `${w} has uncommitted changes`;
    const ahead = git(w, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
    if (ahead.code !== 0) return `${w} could not be read`;
    if (ahead.out !== '0') return `${w} has ${ahead.out} commit(s) on no remote branch`;
  }
  return null;
}

// Another live session working in this worktree (its cwd, or unmerged edits it made there).
function occupier(reg, top, me) {
  const k = key(top);
  const now = Date.now();
  for (const s of Object.values(reg.sessions)) {
    if (s.id === me || !isLive(s, now) || !s.cwd) continue;
    const r = findRepo(s.cwd);
    if (r && key(r.top) === k) return { session: s, why: 'it is working in that folder' };
  }
  for (const c of reg.claims) {
    if (c.session === me || key(c.worktree) !== k || !isLive(reg.sessions[c.session], now)) continue;
    if (claimActive(c)) return { session: reg.sessions[c.session], why: `it has unmerged edits to ${c.path} there` };
  }
  return null;
}

// True when the pusher at `top` and the owner of claim c have not both changed path_: the pusher committed nothing
// to it that the owner lacks, or the owner (with no uncommitted change to it) committed nothing the pusher lacks.
// That is a branch carrying another session's committed work, for example after merging its branch.
function noDivergence(c, top, path_) {
  const head = (cwd) => git(cwd, ['rev-parse', 'HEAD']);
  const last = (cwd) => git(cwd, ['log', '-1', '--format=%H', 'HEAD', '--', path_]);
  const dirty = (cwd) => { const r = git(cwd, ['status', '--porcelain', '--', path_]); return r.code !== 0 || Boolean(r.out); };
  const has = (commit, tip) => git(top, ['merge-base', '--is-ancestor', commit, tip]).code === 0;
  const ph = head(top), oh = head(c.worktree), p = last(top), o = last(c.worktree);
  if ([ph, oh, p, o].some((r) => r.code !== 0) || !ph.out || !oh.out) return false;
  if (!dirty(top) && p.out && has(p.out, oh.out)) return true;
  return !dirty(c.worktree) && Boolean(o.out) && has(o.out, ph.out);
}

// Another session's active claim on path_, or null. The inactive claims it walks past go into `stale` when given,
// so addClaim can drop exactly those without running git under the registry lock. With carrierTop (a push), a claim
// the pushing branch does not diverge from is passed over.
function conflictingClaim(reg, common, path_, me, stale, carrierTop) {
  const safe = {}; // session id -> closed with nothing unpushed, judged once per call
  for (const c of reg.claims) {
    if (c.session === me || c.repo !== common || !same(c.path, path_)) continue;
    if (claimActive(c)) {
      if (carrierTop && noDivergence(c, carrierTop, path_)) continue;
      if (!(c.session in safe)) safe[c.session] = !closedUnsafe(reg, c.session);
      if (!safe[c.session]) return { claim: c, session: reg.sessions[c.session] };
    }
    if (stale) stale.push(c);
  }
  return null;
}

// Runs under the registry lock, so it never runs git: it replaces this session's own claim on path_ and drops only the
// claims in `stale` (judged inactive before the lock). A claim that appeared since then is kept.
function addClaim(reg, repo, path_, me, stale = []) {
  const mine = reg.claims.find((c) => c.repo === repo.common && same(c.path, path_) && c.session === me);
  const judged = (c) => stale.some((s) => s.repo === c.repo && s.path === c.path && s.session === c.session && s.at === c.at);
  reg.claims = reg.claims.filter((c) => !(c.repo === repo.common && same(c.path, path_) && (c.session === me || judged(c))));
  const claim = { repo: repo.common, path: path_, session: me, worktree: norm(repo.top), at: Date.now() };
  if (mine && mine.heldUntil) claim.heldUntil = mine.heldUntil; // re-claiming must not end the hold early
  reg.claims.push(claim);
}

function lockHolder(reg, name, me) {
  const l = reg.locks[name];
  if (!l || l.session === me || Date.now() - l.at > LOCK_TTL_MS) return null;
  const s = reg.sessions[l.session];
  return isLive(s) ? { lock: l, session: s } : null;
}

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60e3);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// The board lists what someone can act on now: live sessions, a count per claim owner, locks, requests.
function render(reg) {
  const now = Date.now();
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const all = Object.values(reg.sessions);
  const sessions = all.filter((s) => isLive(s, now)).sort((a, b) => b.lastSeen - a.lastSeen);
  const lines = [
    '# Session board',
    '',
    `Generated by the coord hooks, ${new Date(now).toISOString()}. Do not edit by hand: use \`${CLI} <command>\`.`,
    '',
    '## Sessions',
    '| name | task | folder | last seen | state |',
    '|---|---|---|---|---|',
  ];
  for (const s of sessions) {
    lines.push(`| ${s.name} | ${String(s.task || '').replace(/\|/g, '/')} | ${s.cwd || ''} | ${ago(s.lastSeen)} | live |`);
  }
  const hidden = all.length - sessions.length;
  if (hidden) lines.push('', `${plural(hidden, 'closed or quiet session')} not shown.`);
  lines.push('', '## Claimed files (each releases itself once the file matches the shipped branch)');
  const byOwner = {};
  for (const c of reg.claims) {
    const who = `${label(reg, c.session)} in ${repoName(c.repo)}`;
    byOwner[who] = (byOwner[who] || 0) + 1;
  }
  const owners = Object.entries(byOwner);
  if (!owners.length) lines.push('- none');
  for (const [who, n] of owners) lines.push(`- ${who}: ${plural(n, 'file')}`);
  lines.push('', '## Locks');
  const locks = Object.entries(reg.locks);
  if (!locks.length) lines.push('- none');
  for (const [n, l] of locks) lines.push(`- ${n}: ${label(reg, l.session)} since ${ago(l.at)}`);
  lines.push('', `Every gate record, kept for good: ${norm(GATES)}`);
  lines.push('', `## Requests (the owner answers done or handoff; after ${HANDOFF_MIN} minutes the requester may force-handoff, the user approves)`);
  const reqs = reg.requests.filter((q) => q.state === 'open' || now - (q.answeredAt || q.at) < 24 * 3600e3);
  if (!reqs.length) lines.push('- none');
  for (const q of reqs) {
    lines.push(`- ${q.id} ${q.state}: ${label(reg, q.from)} -> ${label(reg, q.to)}, ${q.path} (${repoName(String(q.repo))}), ${ago(q.at)}: ${String(q.change).replace(/\s+/g, ' ')}`);
  }
  lines.push('', '## Notes');
  if (!reg.notes.length) lines.push('- none');
  for (const n of reg.notes) lines.push(`- ${new Date(n.at).toISOString().slice(0, 16)} ${n.by}: ${n.text}`);
  return `${lines.join('\n')}\n`;
}

// A session's requests follow its record to a new id (/clear handover, re-registering a name). A request that
// was withdrawn only because its requester closed opens again for the successor.
function moveRequests(r, fromId, toId) {
  for (const q of r.requests) {
    if (q.from === fromId) {
      q.from = toId;
      if (q.state === 'withdrawn' && q.autoWithdrawn) {
        Object.assign(q, { state: 'open', shown: 0 });
        for (const k of ['autoWithdrawn', 'answeredAt', 'told', 'lastShown']) delete q[k];
      }
    }
    if (q.to === fromId) q.to = toId;
  }
}

module.exports = {
  DIR, CLI, HANDOFFS, GATES, mark, LOCK_TTL_MS, HANDOFF_MIN, CLEAR_GRACE_MS, Q, GIT_OPTS, norm, key, same, fromShellPath, targetDir, runnable, tokens, plainRead, denyWords, commandStarts, load, update, findRepo, rel, repoName, git, baseRef,
  statusPaths, claimActive, isLive, closedUnsafe, label, occupier, conflictingClaim, addClaim, lockHolder, ago, render, moveRequests,
  slugKey, urlSlug, githubSlug, mergeArgs, mergeSelector, MERGE_SRC, unquoteWords,
};
