// vibequarters :: session coordination, shell writes into another live session's worktree.
// A command is parsed only when its text names a live peer's folder (any spelling, or the folder's name), holds
// a `..`, or has a remove / move word; then each segment is checked for a redirect, a write command, a remove or
// move of a folder holding that worktree, or a cd into it followed by anything that is not a read. Used by coord-guard.js.
'use strict';
const path = require('path');
const L = require('./coord-lib');

const WRITE_ANY = new Set(['rm', 'rmdir', 'rd', 'touch', 'mkdir', 'md', 'mv', 'tee', 'tee-object', 'truncate', 'chmod',
  'unlink', 'new-item', 'ni', 'remove-item', 'ri', 'del', 'erase', 'rename-item', 'rni', 'ren', 'move-item', 'mi', 'move',
  'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc']);
const WRITE_LAST = new Set(['cp', 'install', 'rsync', 'ln', 'copy-item', 'copy', 'cpi']); // only the destination writes
const READ_ONLY = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'rg', 'ls', 'dir', 'wc',
  'diff', 'stat', 'file', 'pwd', 'echo', 'printf', 'git', 'get-content', 'gc', 'type', 'get-childitem', 'gci',
  'select-string', 'sls', 'test-path', 'resolve-path', 'get-item', 'gi', // git: coord-guard.js judges mutating git itself
  'sort', 'uniq', 'cut', 'tr', 'jq', 'basename', 'dirname', 'realpath', 'du', 'tree', 'which', 'select-object', 'select',
  'where-object', 'where', 'sort-object', 'measure-object', 'format-table', 'ft', 'format-list', 'fl', 'out-string',
  'write-output', 'get-location']); // pure filters; awk, xargs and ForEach-Object stay out: they can write
// Removing or moving a folder also takes every worktree under it, so these are checked for that too.
const DESTROY = new Set(['rm', 'rmdir', 'rd', 'mv', 'move', 'remove-item', 'ri', 'del', 'erase', 'move-item', 'mi']);
const DESTROY_WORD = new RegExp(`(?:^|[\\s;&|(){}!])(?:${[...DESTROY].join('|')})(?:\\.exe)?(?=$|[\\s;&|)}])`);
const MOVE = /^(mv|move|move-item|mi)$/; // the destination only receives: moving into a folder never takes it along
// coord-guard.js's GIT_MUTATE subcommands plus apply: after a cd into a peer, it cannot see where these run
const GIT_WRITE = /^(checkout|switch|rebase|reset|stash|merge|pull|commit|restore|clean|cherry-pick|revert|am|add|rm|mv|apply)$/;
const CD = /^(cd|pushd|chdir|set-location|sl|push-location)$/;
const BACK = /^(popd|pop-location)$/;
const KEYWORD = /^(if|then|do|else|elif|while|until|fi|done|esac)$/;
const SINK = /^(\/dev\/null|\$null|nul)$/i;

// Lowercased ways a command can name this folder: C:/x, C:\x, /c/x (Git Bash), and its bare name.
function spellings(top) {
  const n = L.norm(top);
  const out = [n, n.replace(/\//g, '\\'), path.basename(n)];
  const m = /^([a-zA-Z]):(\/.*)$/.exec(n);
  if (m) out.push(`/${m[1].toLowerCase()}${m[2]}`);
  return out.map((s) => s.toLowerCase());
}

// `..` too: from a worktree nested inside a peer's checkout, a relative path reaches the peer without naming it.
// A remove / move word too: removing a folder that holds a peer's worktree names neither.
function mentionsPeer(cmd, peers) {
  const low = cmd.toLowerCase();
  return low.includes('..') || DESTROY_WORD.test(low) || peers.some((p) => p.spell.some((s) => low.includes(s)));
}

function words(seg) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) {
    const bare = m[3] === undefined ? null : m[3].replace(/[)}]+$/, ''); // `rm x)` closes a group: the word is x
    if (bare === null) out.push(m[1] !== undefined ? m[1] : m[2]);
    else if (bare) out.push(bare);
  }
  return out;
}

// The git subcommand past global options (-c and -C take a value), or '' when -C sends git elsewhere: coord-guard.js judges that.
function gitSub(w) {
  let i = 1;
  while (w[i] && w[i].startsWith('-')) {
    if (w[i] === '-C') return '';
    i += w[i] === '-c' ? 2 : 1;
  }
  return String(w[i] || '').toLowerCase();
}

// The live peer whose worktree sits under target, so removing or moving target takes it along, or null.
// A glob counts from its first wild part, matched against the peer's folder at that depth.
function under(target, dir, peers) {
  const parts = L.key(L.fromShellPath(target, dir)).split('/');
  const g = parts.findIndex((s) => /[*?]/.test(s));
  const base = (g < 0 ? parts : parts.slice(0, g)).join('/').replace(/\/+$/, '');
  const wild = g < 0 ? '' : parts[g].replace(/[.+^$()|[\]{}\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const glob = g < 0 ? null : new RegExp(`^${wild}$`);
  return peers.find((p) => p.k.startsWith(`${base}/`) && (!glob || glob.test(p.k.slice(base.length + 1).split('/')[0]))) || null;
}

// The peer whose worktree holds p (resolved against dir), or null. findRepo decides, so a worktree nested
// inside a peer's checkout counts as its own folder, not the peer's.
function owner(p, dir, peers) {
  const r = L.findRepo(L.fromShellPath(p, dir));
  return r ? peers.find((x) => x.k === L.key(r.top)) || null : null;
}

// find(path, dir, peers, head, ctx) names who a written path belongs to (head: the writing command, null for a
// redirect; ctx.here: path is the folder the command runs in; ctx.words: the segment's words), holds(path, dir, peers)
// who a removed or moved folder takes along; guard-deny-catastrophic.js passes its own pair.
function peerWrite(cmd, cwd, peers, find = owner, holds = under) {
  let dir = cwd;
  // `>|` is a redirect, not a pipe
  for (const seg of cmd.split(/\|\||&&|[;\n]|(?<!>)\|/).map((s) => s.trim()).filter(Boolean)) {
    const w = words(seg);
    // the command itself: past `(`, `{`, `!`, shell keywords and VAR=value prefixes
    while (w.length) {
      w[0] = w[0].replace(/^[({!]+/, '');
      if (w[0] && !KEYWORD.test(w[0].toLowerCase()) && !/^[A-Za-z_]\w*=/.test(w[0])) break;
      w.shift();
    }
    const head = String(w[0] || '').toLowerCase().replace(/\.exe$/, '');
    const args = w.slice(1).filter((a) => !/^-/.test(a));
    if (CD.test(head)) {
      if (args[0]) dir = L.fromShellPath(args[0], dir);
      continue;
    }
    if (BACK.test(head)) {
      dir = cwd;
      continue;
    }
    const sedInPlace = head === 'sed' && w.some((a) => /^-[a-zA-Z]*i/.test(a) || /^--in-place(=|$)/.test(a));
    // read commands that still write here: sort -o, tree -o, uniq IN OUT, and git that changes the folder
    const writesAnyway = (head === 'sort' && w.some((a) => /^-[a-zA-Z]*o|^--output(=|$)/.test(a)))
      || (head === 'tree' && w.some((a) => /^-[a-zA-Z]*o/.test(a))) || (head === 'uniq' && args.length > 1)
      || (head === 'git' && GIT_WRITE.test(gitSub(w)));
    const readOnly = !head || (head === 'sed' && !sedInPlace) || (READ_ONLY.has(head) && !writesAnyway);
    const here = find('.', dir, peers, head, { here: true, words: w });
    if (here && !readOnly) return { peer: here.name, target: L.norm(dir), why: `runs ${head} inside it` };
    for (const m of seg.matchAll(/\d?>[>|]?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g)) {
      const target = m[1].replace(/^["']|["']$/g, '');
      if (target.startsWith('&') || SINK.test(target)) continue;
      const hit = find(target, dir, peers, null, { words: w });
      if (hit) return { peer: hit.name, target: L.fromShellPath(target, dir), why: 'redirects output into it' };
    }
    const findWrites = head === 'find' && w.some((a) => /^-(delete|exec|execdir|ok)$/.test(a));
    const d = w.findIndex((a) => a.toLowerCase() === '-destination');
    const last = d >= 0 && w[d + 1] ? [w[d + 1]] : args.slice(-1);
    const targets = WRITE_ANY.has(head) || sedInPlace || findWrites ? args : WRITE_LAST.has(head) ? last : [];
    const dest = MOVE.test(head) ? last[0] : undefined;
    for (const a of targets) {
      const hit = find(a, dir, peers, head, { words: w });
      if (hit) return { peer: hit.name, target: L.fromShellPath(a, dir), why: `${head} writes into it` };
      const held = DESTROY.has(head) && a !== dest && holds(a, dir, peers);
      if (held) return { peer: held.name, target: held.top, why: `${head} takes ${L.fromShellPath(a, dir)} with everything in it` };
    }
  }
  return null;
}

module.exports = { spellings, mentionsPeer, peerWrite };
