// Tests for loop-spot.js.
// Run: node --test system/hooks/tests/loop-spot.test.js
'use strict';
require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'loop-spot.js');

function sandbox(spotSession, ageMs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loopspot-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const key = project.replace(/[^a-zA-Z0-9]/g, '-');
  const loop = path.join(home, '.claude', 'projects', key, 'memory', 'loop');
  fs.mkdirSync(loop, { recursive: true });
  const lines = [
    '# Resume point (loop-spot.js)',
    '',
    '> Replaced every turn. Where a summary differs, this file is right.',
    '',
    '- when: ' + new Date(Date.now() - (ageMs || 0)).toISOString(),
    '- saved-on: Stop',
    '- cwd: ' + project,
    '- git: not a git repo',
  ];
  if (spotSession) lines.push('- session: ' + spotSession);
  lines.push('', '## Latest request', '', 'add a search box', '',
    '## Latest reply', '', 'plans written', '');
  fs.writeFileSync(path.join(loop, 'SPOT.md'), lines.join('\n'));
  return { home, project };
}

function inject(sb, sessionId, event) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: sb.project, hook_event_name: event || 'SessionStart', session_id: sessionId }),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { USERPROFILE: sb.home, HOME: sb.home }),
  });
  assert.strictEqual(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}

test('loop-spot injection', async (t) => {
  await t.test('its own resume point is injected with the trust line', () => {
    const ctx = inject(sandbox('aaaa-1111'), 'aaaa-1111');
    assert.match(ctx, /this file is right/);
    assert.match(ctx, /add a search box/);
  });

  await t.test('a peer resume point is labeled as the peer\'s and carries no trust line', () => {
    const ctx = inject(sandbox('aaaa-1111'), 'bbbb-2222');
    assert.match(ctx, /another session/i, 'got: ' + ctx.slice(0, 300));
    assert.match(ctx, /aaaa-1111/, 'the label must name the session that wrote it');
    assert.doesNotMatch(ctx, /this file is right/, 'a peer resume point must carry no trust line');
    assert.match(ctx, /add a search box/, 'the content is still shown, only labeled');
  });

  await t.test('the same label applies after a compact', () => {
    const ctx = inject(sandbox('aaaa-1111'), 'bbbb-2222', 'PostCompact');
    assert.doesNotMatch(ctx, /this file is right/);
  });

  await t.test('a spot with no session line counts as its own', () => {
    const ctx = inject(sandbox(null), 'bbbb-2222');
    assert.match(ctx, /this file is right/);
  });

  await t.test('a spot older than 7 days is not injected', () => {
    const ctx = inject(sandbox('aaaa-1111', 8 * 24 * 3600 * 1000), 'aaaa-1111');
    assert.strictEqual(ctx, '');
  });
});
