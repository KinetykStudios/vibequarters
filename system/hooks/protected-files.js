// protected-files :: shared helper, not a hook
// The files that decide what is approved without the user, or which guards run. guard-hq-answers.js denies a write to the
// approval ones (the saved preset, the approval lists, the preset files, the agent switches); guard-config.js asks about
// the settings ones (Claude Code's own settings, vibequarters.config.json, the app's hq.config.json, the hooks).
// A shell command counts when one of its commands writes, copies over, moves or removes such a file, or when it runs a
// program given inline (node -e, python -c, bash -c, a heredoc) whose text names one. Reading them is fine.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./vibequarters-config');

// The path the OS will write: drop a \\?\ or \\.\ prefix, drop what Win32 drops from each name (trailing dots and
// spaces, a `::$DATA` or other `:stream` suffix), then realpath the deepest folder that exists, which follows junctions
// and links and expands 8.3 short names.
function canon(p) {
  let s = path.resolve(p.replace(/^[\\/]{2}[?.][\\/]/, ''));
  s = path.resolve(s.split(path.sep).map((c, i) => (i ? c.replace(/:.*$/, '').replace(/[. ]+$/, '') : c)).join(path.sep));
  let rest = '';
  for (let d = s; ;) {
    try { s = path.join(fs.realpathSync.native(d), rest); break; } catch (_e) {}
    const up = path.dirname(d);
    if (up === d) break;
    rest = path.join(path.basename(d), rest);
    d = up;
  }
  return s.replace(/\\/g, '/').toLowerCase();
}

// { deny, ask }: each a list of [path, isFolder]
function lists() {
  const claude = path.join(os.homedir(), '.claude');
  const app = P.expand(P.load().appDir);
  const state = P.appState();
  const systems = [...new Set([P.expand(P.load().systemDir), path.join(__dirname, '..')].filter(Boolean))];
  return {
    deny: [
      [path.join(claude, 'hq-feed', 'agents-off.json'), false],
      ...[...new Set([app, state].filter(Boolean))].flatMap((d) => [[path.join(d, 'approvals-choice.json'), false], [path.join(d, 'approval-levels.json'), false]]),
      ...systems.map((d) => [path.join(d, 'presets', 'approvals'), true]),
    ],
    ask: [
      [path.join(claude, 'settings.json'), false],
      [path.join(claude, 'settings.local.json'), false],
      [P.file(), false],
      ...(app ? [[path.join(app, 'hq.config.json'), false]] : []),
      ...systems.map((d) => [path.join(d, 'hooks'), true]),
    ],
  };
}

const inside = (file, [p, folder]) => { const k = canon(p); return file === k || (folder && file.startsWith(`${k}/`)); };

// True when this file is one of that kind ('deny' or 'ask')
function isProtected(file, kind) {
  const f = canon(file);
  return lists()[kind].some((row) => inside(f, row));
}

// The home folder however a shell spells it, so "$HOME"/.claude and %USERPROFILE%\.claude read as ~/.claude
const HOME = /(["']?)(?:\$\{?HOME\}?|\$env:(?:USERPROFILE|HOME)|\$\{env:USERPROFILE\}|\$USERPROFILE|%USERPROFILE%)\1(?=["']?[\\/])/gi;
const PREFIX = /(^|[;&|(\n]\s*)(?:(?:sudo|command|env|nohup|time)\s+)+/g;
// An interpreter given its program in the command: only its own options stand before -c, -e, - or <<, so a script path
// with such a word among its arguments is not one.
const INLINE = /\b(?:node|nodejs|bun|deno|python[\d.]*|py|ruby|perl|php|bash|sh|zsh|dash|pwsh|powershell|cmd)(?:\.exe)?(?:\s+-[^\s;&|]*(?:\s+(?![-/])\w+)?)*?\s*(?:\s(?:-[a-z]*[cep]|--eval|--print|eval|-command|-encodedcommand|\/c|-)(?=[\s=]|$)|<<)|\b(?:eval|iex|invoke-expression)\s|\|\s*(?:node|bun|deno|python[\d.]*|bash|sh|zsh|pwsh|powershell)(?:\.exe)?\s*(?:$|[;&|\n])/im;
const CARRY = /^(?:cp|copy|copy-item|cpi|mv|move|move-item|mi|install|rsync|ln|ren|rni|rename-item)$/;

// { target, why } when this shell command writes a protected file of that kind, else null
function shellWrite(command, cwd, kind) {
  const rows = lists()[kind].map((row) => [...row, canon(row[0])]);
  const cmd = String(command).replace(HOME, '~').replace(PREFIX, '$1');
  const L = require('./coord-lib');
  const HIT = { name: kind };
  const hits = (p, dir) => { const f = canon(L.fromShellPath(p, dir)); return rows.some(([, folder, k]) => f === k || (folder && f.startsWith(`${k}/`))); };
  const find = (p, dir, _peers, head, ctx = {}) => {
    if (ctx.here) return null; // only what a command names is judged, not the folder it runs in
    if (hits(p, dir)) return HIT;
    // a copy or move into a folder lands under the name it had, or takes the new name a rename gives
    if (head && CARRY.test(head) && (ctx.words || []).slice(1).some((w) => hits(path.join(L.fromShellPath(p, dir), path.basename(w)), dir) || hits(path.join(path.dirname(L.fromShellPath(p, dir)), path.basename(w)), dir))) return HIT;
    return null;
  };
  const holds = (p, dir) => { const f = canon(L.fromShellPath(p, dir)); return rows.some(([, , k]) => k.startsWith(`${f}/`)) ? { name: kind, top: L.norm(L.fromShellPath(p, dir)) } : null; };
  const hit = require('./coord-shell').peerWrite(cmd, cwd, [], find, holds);
  if (hit) return { target: hit.target, why: hit.why };
  if (INLINE.test(cmd)) {
    const flat = cmd.replace(/["'`]/g, '').replace(/[\\/]+/g, '/').toLowerCase();
    const named = rows.find(([p, folder, k]) => {
      const base = path.basename(p).toLowerCase();
      const tail = `${path.basename(path.dirname(p))}/${path.basename(p)}${folder ? '/' : ''}`.toLowerCase();
      return flat.includes(k) || flat.includes(tail) || (base === 'approvals-choice.json' && flat.includes(base));
    });
    if (named) return { target: named[0].replace(/\\/g, '/'), why: 'runs a program whose text names it' };
  }
  return null;
}

module.exports = { canon, isProtected, shellWrite };
