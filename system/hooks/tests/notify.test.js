// notify.js: the attention ping. VIBEQUARTERS_NOTIFY_LOG turns each sound into a line in a file.
'use strict';
const C = require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const NOTIFY = path.join(__dirname, '..', '..', 'notify', 'notify.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function box(t, notify, platform) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibequarters-notify-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  fs.mkdirSync(path.join(home, '.claude'));
  const log = path.join(home, 'pings.txt');
  const env = { ...process.env, HOME: home, USERPROFILE: home, VIBEQUARTERS_NOTIFY_LOG: log, VIBEQUARTERS_CONFIG: C.write({ notify }), ...(platform ? { VIBEQUARTERS_TEST_PLATFORM: platform } : {}) };
  return {
    home, log,
    lock: path.join(home, '.claude', 'ping.lock'),
    run: (cmd) => { const r = spawnSync(process.execPath, [NOTIFY, cmd], { encoding: 'utf8', env, input: '{}' }); assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); },
    pings: () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').length; } catch (_e) { return 0; } },
    async until(n, ms = 10000) { for (const end = Date.now() + ms; Date.now() < end && this.pings() < n;) await wait(50); return this.pings(); },
  };
}

test('ping sounds notify.count times and then stops by itself', async (t) => {
  const b = box(t, { intervalSeconds: 0.1, count: 3 });
  b.run('ping');
  assert.strictEqual(await b.until(3), 3);
  await wait(500);
  assert.strictEqual(b.pings(), 3);
  assert.ok(!fs.existsSync(b.lock));
});

// Only Windows can stay quiet while you are at the terminal, so elsewhere a repeat would ring while you type.
test('with no count set, five pings on Windows and one elsewhere; a count you set is kept', async (t) => {
  for (const [platform, notify, want] of [['win32', { intervalSeconds: 0.1 }, 5], ['darwin', { intervalSeconds: 0.1 }, 1], ['linux', { intervalSeconds: 0.1 }, 1], ['linux', { intervalSeconds: 0.1, count: 3 }, 3]]) {
    const b = box(t, notify, platform);
    b.run('ping');
    assert.strictEqual(await b.until(want), want, platform);
    await wait(700);
    assert.strictEqual(b.pings(), want, platform);
  }
});

test('clear stops a running series', async (t) => {
  const b = box(t, { intervalSeconds: 1, count: 20 });
  b.run('ping');
  assert.ok(await b.until(1) >= 1, 'control: it was pinging');
  b.run('clear');
  const n = b.pings();
  await wait(2500);
  assert.ok(b.pings() <= n + 1);
});

test('a second ping replaces the first, so one series runs', async (t) => {
  const b = box(t, { intervalSeconds: 1, count: 2 });
  b.run('ping');
  const first = fs.readFileSync(b.lock, 'utf8');
  b.run('ping');
  assert.notStrictEqual(fs.readFileSync(b.lock, 'utf8'), first);
  await wait(4000);
  assert.ok(b.pings() >= 2 && b.pings() <= 3, `${b.pings()} pings`);
});

test('muted: no ping at all', async (t) => {
  const b = box(t, { intervalSeconds: 0.1, count: 3 });
  fs.writeFileSync(path.join(b.home, '.claude', 'ping-muted'), '');
  b.run('ping');
  await wait(700);
  assert.strictEqual(b.pings(), 0);
  assert.ok(!fs.existsSync(b.lock));
});

test('an unknown word or a broken config never fails the session', (t) => {
  const b = box(t, { intervalSeconds: 'x', count: -4 });
  b.run('nonsense');
  b.run('clear');
});
