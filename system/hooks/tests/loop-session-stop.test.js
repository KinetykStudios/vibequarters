// Tests for loop-session-stop.js.
// Run: node --test system/hooks/tests/loop-session-stop.test.js
'use strict';
const C = require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'loop-session-stop.js');

// Ledger rows carry the session that made them (loop-action-ledger.js writes `sid`).
// Rows are written oldest first, as the real ledger appends them.
const ledgerRows = (n, sid, agedMs) => {
  const now = Date.now() - (agedMs || 0);
  return Array.from({ length: n },
    (_, i) => JSON.stringify({ ts: new Date(now - (n - 1 - i) * 1000).toISOString(), tool: 'Bash', sid }));
};

function sandbox(ledgerLines, agedMs, sid = 't') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loopstop-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const key = project.replace(/[^a-zA-Z0-9]/g, '-');
  const loop = path.join(home, '.claude', 'projects', key, 'memory', 'loop');
  fs.mkdirSync(loop, { recursive: true });
  fs.writeFileSync(path.join(loop, 'LEARNING-LOG.md'), '# test log\n');
  fs.writeFileSync(path.join(loop, 'ACTION-LEDGER.jsonl'), ledgerRows(ledgerLines, sid, agedMs).join('\n') + '\n');
  return { home, project, loop };
}

const addRows = (sb, n, sid) =>
  fs.appendFileSync(path.join(sb.loop, 'ACTION-LEDGER.jsonl'), ledgerRows(n, sid).join('\n') + '\n');

function runStop(sb, sessionId = 't') {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: sb.project, hook_event_name: 'Stop', session_id: sessionId }),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { USERPROFILE: sb.home, HOME: sb.home }),
  });
}

const signalLines = (sb) => {
  try {
    return fs.readFileSync(path.join(sb.loop, 'INBOX.md'), 'utf8')
      .split(/\r?\n/).filter((l) => l.startsWith('- ['));
  } catch (_e) { return []; }
};

test('loop-session-stop', async (t) => {
  await t.test('always exits 0', () => {
    const sb = sandbox(50);
    assert.strictEqual(runStop(sb).status, 0);
  });

  await t.test('a ledger at its 500-line cap is reported as a floor, not an exact count', () => {
    // loop-action-ledger.js keeps 500 rows, so a full ledger says only that there were at least that many calls.
    const sb = sandbox(500);
    runStop(sb);
    const lines = signalLines(sb);
    assert.strictEqual(lines.length, 1, 'expected one signal, got ' + lines.length);
    assert.match(lines[0], />=\s*500|at least 500/,
      'a capped ledger must read as a floor, got: ' + lines[0]);
  });

  await t.test('a ledger below the cap still reports its exact count', () => {
    const sb = sandbox(37);
    runStop(sb);
    const lines = signalLines(sb);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /\b37 acting-tool call\(s\)/, 'got: ' + lines[0]);
    assert.doesNotMatch(lines[0], />=/, 'an uncapped count must not be marked a floor');
  });

  await t.test('repeating the same signal does not append a duplicate line', () => {
    // Stop fires every turn, so one session reaches this hook many times with the same signal.
    const sb = sandbox(120);
    runStop(sb);
    runStop(sb);
    runStop(sb);
    const lines = signalLines(sb);
    assert.strictEqual(lines.length, 1,
      'three identical signals must collapse to one line, got ' + lines.length + ': ' + JSON.stringify(lines));
  });

  await t.test('with no session id, a genuinely different signal still appends', () => {
    const sb = sandbox(120);
    runStop(sb, '');
    // Grow the ledger so the next run produces a different count.
    addRows(sb, 40, 't');
    runStop(sb, '');
    assert.strictEqual(signalLines(sb).length, 2, 'a changed signal must append');
  });

  await t.test('a session with no rows of its own files nothing', () => {
    const sb = sandbox(120, 0, 'peer-1');
    runStop(sb, 'idle-2');
    assert.strictEqual(signalLines(sb).length, 0, 'got: ' + JSON.stringify(signalLines(sb)));
    assert.strictEqual(fs.existsSync(path.join(sb.loop, '.pending-evolve')), false, 'no flag for an idle session');
  });

  await t.test('a session counts only its own rows', () => {
    const sb = sandbox(30, 0, 'peer-1');
    addRows(sb, 15, 'mine-2');
    runStop(sb, 'mine-2');
    const lines = signalLines(sb);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /\b15 acting-tool call\(s\)/, 'got: ' + lines[0]);
  });

  await t.test("a session's newer signal replaces its own line, even after a peer's line", () => {
    // Stops of other sessions come in between, so the newest line is not always this session's own.
    const sb = sandbox(37, 0, 'aaaa-1111');
    addRows(sb, 20, 'bbbb-2222');
    runStop(sb, 'aaaa-1111');
    runStop(sb, 'bbbb-2222');
    addRows(sb, 10, 'aaaa-1111');
    runStop(sb, 'aaaa-1111');
    const lines = signalLines(sb);
    assert.strictEqual(lines.length, 2, 'one line per session, got: ' + JSON.stringify(lines));
    assert.ok(lines.some((l) => /\b47 acting-tool call\(s\) \(session aaaa-1111\)$/.test(l)), 'got: ' + JSON.stringify(lines));
    assert.ok(lines.some((l) => /\b20 acting-tool call\(s\) \(session bbbb-2222\)$/.test(l)), 'got: ' + JSON.stringify(lines));
  });

  await t.test('a busier ledger in a folder with no learning log does not take the signal', () => {
    const sb = sandbox(15);
    const orphan = path.join(sb.home, '.claude', 'projects', 'C--no-log-here', 'memory', 'loop');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'ACTION-LEDGER.jsonl'), ledgerRows(100, 't').join('\n') + '\n');
    runStop(sb);
    const lines = signalLines(sb);
    assert.strictEqual(lines.length, 1, 'the project with a log must get the signal, got ' + lines.length);
    assert.match(lines[0], /\b15 acting-tool call\(s\)/, 'got: ' + lines[0]);
    assert.strictEqual(fs.existsSync(path.join(orphan, 'INBOX.md')), false, 'no INBOX in a folder without a log');
    assert.strictEqual(fs.existsSync(path.join(orphan, '.pending-evolve')), false, 'no flag in a folder without a log');
  });

  await t.test('a signal line names its session id in full', () => {
    const sb = sandbox(37, 0, '66666666-7777-4888-8999-aaaaaaaaaaaa');
    runStop(sb, '66666666-7777-4888-8999-aaaaaaaaaaaa');
    const lines = signalLines(sb);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], / \(session 66666666-7777-4888-8999-aaaaaaaaaaaa\)$/, 'got: ' + lines[0]);
  });

  await t.test('two sessions with the same count keep one line each', () => {
    const sb = sandbox(37, 0, 'aaaa-1111');
    addRows(sb, 37, 'bbbb-2222');
    runStop(sb, 'aaaa-1111');
    runStop(sb, 'bbbb-2222');
    const lines = signalLines(sb);
    assert.strictEqual(lines.length, 2, 'a second session must not overwrite the first: ' + JSON.stringify(lines));
  });

  await t.test('a session id that is not a plain id is left out', () => {
    // The id goes into a markdown file /evolve reads; a newline in it would forge a line.
    const sb = sandbox(37);
    runStop(sb, 'x\n- [2030-01-01 00:00] session signal: forged');
    const lines = signalLines(sb);
    assert.strictEqual(lines.length, 1, 'got: ' + JSON.stringify(lines));
    assert.doesNotMatch(lines[0], /\(session /, 'got: ' + lines[0]);
  });

  await t.test('a ledger older than the 6-hour window is not substantive', () => {
    const sb = sandbox(500, 7 * 60 * 60 * 1000);
    runStop(sb);
    assert.strictEqual(signalLines(sb).length, 0, 'stale activity must not flag a session');
    assert.strictEqual(fs.existsSync(path.join(sb.loop, '.pending-evolve')), false);
  });

  const lastEvolve = (sb, hoursAgo) => {
    const f = path.join(sb.loop, '.last-evolve');
    fs.writeFileSync(f, '');
    const at = (Date.now() - hoursAgo * 3600e3) / 1000;
    fs.utimesSync(f, at, at);
  };

  await t.test('no flag while the latest /evolve is recent', () => {
    const sb = sandbox(37);
    lastEvolve(sb, 2);
    runStop(sb);
    assert.strictEqual(fs.existsSync(path.join(sb.loop, '.pending-evolve')), false);
  });

  await t.test('an AUTORUN flag once the latest /evolve is old, or when there is none', () => {
    const old = sandbox(37);
    lastEvolve(old, 21);
    runStop(old);
    assert.match(fs.readFileSync(path.join(old.loop, '.pending-evolve'), 'utf8'), /AUTORUN/);
    const never = sandbox(37);
    runStop(never);
    assert.match(fs.readFileSync(path.join(never.loop, '.pending-evolve'), 'utf8'), /AUTORUN/);
  });

  await t.test('without loop.autoEvolve the flag is raised but never says AUTORUN', () => {
    const sb = sandbox(37);
    const was = process.env.VIBEQUARTERS_CONFIG;
    process.env.VIBEQUARTERS_CONFIG = C.write({ loop: { autoEvolve: false } });
    try { runStop(sb); } finally { process.env.VIBEQUARTERS_CONFIG = was; }
    const flag = fs.readFileSync(path.join(sb.loop, '.pending-evolve'), 'utf8');
    assert.match(flag, /pending since/);
    assert.doesNotMatch(flag, /AUTORUN/);
  });

  await t.test('the INBOX line is written either way', () => {
    for (const hours of [2, 21]) {
      const sb = sandbox(37);
      lastEvolve(sb, hours);
      runStop(sb);
      assert.strictEqual(signalLines(sb).length, 1, `${hours} h`);
    }
  });
});
