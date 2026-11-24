#!/usr/bin/env node
// vibequarters :: attention ping (Stop and Notification hooks start it, UserPromptSubmit clears it)
//
//   node notify.js ping    start pinging: a sound every notify.intervalSeconds, notify.count times (unset: five times on
//                          Windows, once elsewhere), in the background
//   node notify.js clear   stop any pinging (the user is back)
//
// One ping series at a time: each `ping` writes a fresh token to ~/.claude/ping.lock and the series stops as soon as the
// lock holds another token or is gone. ~/.claude/ping-muted silences everything (/mute and /unmute).
// Windows runs ping-loop.ps1, which also stays quiet while a terminal or editor window has the focus. macOS uses
// osascript (a notification with a sound), Linux notify-send plus paplay when they are installed.
// NEVER THROWS and never blocks the session: it always exits 0 at once.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CLAUDE = path.join(os.homedir(), '.claude');
const LOCK = path.join(CLAUDE, 'ping.lock');
const MUTED = path.join(CLAUDE, 'ping-muted');
const PLATFORM = process.env.VIBEQUARTERS_TEST_PLATFORM || process.platform;
// Tests point this at a file: each ping then appends a line to it instead of making a sound.
const LOG = process.env.VIBEQUARTERS_NOTIFY_LOG || '';

function settings() {
  let n = {};
  try { n = require('../hooks/vibequarters-config').load().notify || {}; } catch (_e) { n = {}; }
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  // 0 = the platform's own: five where the pings stop while you are at the terminal (Windows), one elsewhere
  return { interval: num(n.intervalSeconds, 30), count: Math.floor(num(n.count, 0)) || (PLATFORM === 'win32' ? 5 : 1) };
}

const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch (_e) { return null; } };

function sound() {
  if (LOG) { fs.appendFileSync(LOG, 'ping\n'); return; }
  const run = (cmd, args) => { try { spawnSync(cmd, args, { stdio: 'ignore', timeout: 10000, windowsHide: true }); } catch (_e) { /* not installed */ } };
  if (PLATFORM === 'darwin') {
    run('osascript', ['-e', 'display notification "A session is waiting for you." with title "Claude Code" sound name "Glass"']);
  } else {
    run('notify-send', ['Claude Code', 'A session is waiting for you.']);
    run('paplay', ['/usr/share/sounds/freedesktop/stereo/complete.oga']);
  }
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function loop(token) {
  const { interval, count } = settings();
  for (let i = 1; i <= count; i++) {
    if (read(LOCK) !== token) return;
    sound();
    if (i < count) await sleep(interval);
  }
  if (read(LOCK) === token) { try { fs.unlinkSync(LOCK); } catch (_e) { /* gone */ } }
}

function ping() {
  if (fs.existsSync(MUTED)) return;
  const { interval, count } = settings();
  if (PLATFORM === 'win32' && !LOG) {
    const ps1 = path.join(__dirname, 'ping-loop.ps1');
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1,
      '-LockFile', LOCK, '-MaxPings', String(count), '-IntervalSeconds', String(interval)],
    { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(CLAUDE, { recursive: true });
  fs.writeFileSync(LOCK, token);
  spawn(process.execPath, [__filename, 'loop', token], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
}

function clear() {
  try { fs.unlinkSync(LOCK); } catch (_e) { /* nothing to clear */ }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'ping') ping();
    else if (cmd === 'clear') clear();
    else if (cmd === 'loop' && arg) await loop(arg);
  } catch (_e) { /* fail open */ }
  process.exit(0);
}

main();
