// The four approval presets, loaded and judged by the VibeQuarters app's own level code.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadLevels, levelOf } = require('../../lib/levels');
const L = require('../lib');

const DIR = path.join(L.REPO, 'system', 'presets', 'approvals');
const file = (id) => path.join(DIR, `${id}.json`);
const level = (id, toolName, toolInput, extra) => levelOf(loadLevels(file(id)), { toolName, toolInput, ...extra });
const bash = (id, command, extra) => level(id, 'Bash', { command }, extra);

test('there is one preset file for each choice the installer offers', () => {
  assert.deepStrictEqual(fs.readdirSync(DIR).sort(), L.APPROVALS.map((a) => `${a.id}.json`).sort());
  for (const { id } of L.APPROVALS) {
    const j = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    assert.strictEqual(j.preset, id);
    assert.strictEqual(j.judge, id === 'routine-judge');
    assert.ok(j.title && j.readMe);
    assert.ok(loadLevels(file(id)), id);
  }
});

test('the never-auto list is identical in all four, and holds at least the app\'s own', () => {
  const yours = L.APPROVALS.map(({ id }) => JSON.parse(fs.readFileSync(file(id), 'utf8')).yours);
  for (const y of yours) assert.deepStrictEqual(y, yours[0]);
  const own = loadLevels(path.join(L.REPO, 'approval-levels.json')).yours;
  for (const k of ['tools', 'hookPhrases', 'words']) for (const w of own[k]) assert.ok(yours[0][k].includes(w), `${k}: ${w}`);
});

test('deletes, force pushes, hard resets, skipped hooks, deploys, publishing, money and guard switches wait for the user in every preset', () => {
  for (const { id } of L.APPROVALS) {
    for (const c of ['rm -rf build', 'git push --force origin x', 'git push -f', 'git reset --hard HEAD~1', 'git commit --no-verify -m x', 'git clean -fd', 'vercel deploy --prod', 'npm publish', 'VIBEQUARTERS_GUARD=off git status', 'psql -c "drop table users"']) {
      assert.strictEqual(bash(id, c), 'yours', `${id}: ${c}`);
    }
    assert.strictEqual(level(id, 'mcp__pay__send_money', { amount: 1 }), 'yours');
    assert.strictEqual(bash(id, 'git status', { hookAsk: { hook: 'guard-deny-catastrophic.js', reason: 'x' } }), 'yours');
    assert.strictEqual(bash(id, 'git status', { hookAsk: { hook: 'other.js', reason: 'Only the user can approve it.' } }), 'yours');
  }
});

const MONEY = [
  'mcp__stripe__stripe_api_write', 'mcp__stripe__atlas_company_formation', 'mcp__stripe__manage_stripe_accounts',
  'mcp__stripe__send_money', 'mcp__stripe__transfer_money', 'mcp__stripe__setup_recipient',
  'mcp__plugin_vercel_vercel__buy_domain',
];

test('every money tool waits for the user in every preset, by name and under any other server prefix', () => {
  for (const { id } of L.APPROVALS) {
    const yours = JSON.parse(fs.readFileSync(file(id), 'utf8')).yours;
    for (const tool of MONEY) {
      assert.ok(yours.tools.includes(tool), `${id} names ${tool}`);
      assert.strictEqual(level(id, tool, {}), 'yours', `${id}: ${tool}`);
      const other = tool.replace(/^mcp__.*__/, 'mcp__another_server__');
      assert.strictEqual(level(id, other, {}), 'yours', `${id}: ${other}`);
    }
    // Positive control: a read is routine wherever reads are approved, and an ordinary tool is never "yours"
    const read = level(id, 'Read', { file_path: 'a.js' });
    assert.strictEqual(read, id === 'ask-all' ? 'judge' : 'routine', `${id}: Read`);
    assert.strictEqual(level(id, 'mcp__stripe__search_stripe_documentation', {}), 'judge', `${id}: a docs search`);
  }
});

test('a web fetch is no safe read, and a fetch or a pull request edit is routine in no preset', () => {
  assert.strictEqual(level('safe-reads', 'WebFetch', { url: 'https://example.com/?q=x' }), 'judge');
  assert.strictEqual(level('safe-reads', 'WebSearch', { query: 'x' }), 'routine', 'control');
  for (const { id } of L.APPROVALS) {
    for (const c of ['git fetch origin +main:main', 'git fetch origin main:main', 'git fetch -f', 'git fetch --prune', 'git fetch -p origin', 'gh pr edit 5 --base x', 'gh pr edit 5 --body x']) {
      assert.notStrictEqual(bash(id, c), 'routine', `${id}: ${c}`);
    }
  }
});

test('the words catch a delete, a force push, a hard reset, a deploy or a publish behind options, shortened or in another tool', () => {
  const YOURS = [
    'git -C repo reset --hard', 'git push origin +main', 'git push origin :feature', 'git push --forc', 'git push origin -f', 'git push --dele origin x',
    'git -C r clean -fdx', 'rm --recursive x', 'rm -v -rf x', 'rm x -r -fo', 'find . -delete', 'rd /s /q x', 'del notes.txt', 'unlink notes.txt',
    'python -c "import shutil; shutil.rmtree(1)"', 'ri -Recurse -Force x', 'vercel --prod', 'npm pub', 'docker push me/app', 'gh release create v1',
    'gh pr merge 5', 'git push heroku main', 'pulumi up', 'supabase db push', 'twine upload dist/x', 'aws s3 sync a b --delete', 'aws s3 rm s3://b/x',
  ];
  const ORDINARY = ['git push origin main', 'git push origin HEAD:main', 'rm notes.txt', 'npm run build', 'node build.js', 'echo model data', 'git show HEAD:README.md', 'git reset --soft HEAD~1', 'npm install left-pad', 'aws s3 ls'];
  for (const { id } of L.APPROVALS) {
    for (const c of YOURS) assert.strictEqual(bash(id, c), 'yours', `${id}: ${c}`);
    for (const c of ORDINARY) assert.notStrictEqual(bash(id, c), 'yours', `${id}: ${c}`);
    assert.strictEqual(level(id, 'mcp__db__query', { sql: 'DELETE/**/FROM users' }), 'yours', id);
  }
});

test('what each preset approves grows from nothing to reads to routine work', () => {
  const rows = [
    ['git status', false, true, true], ['cat README.md', false, true, true], ['git add .', false, false, true],
    ['git commit -m x', false, false, true], ['npm test', false, false, true], ['node build.js', false, false, false],
  ];
  for (const [c, ask, reads, routine] of rows) {
    assert.strictEqual(bash('ask-all', c) === 'routine', ask, `ask-all ${c}`);
    assert.strictEqual(bash('safe-reads', c) === 'routine', reads, `safe-reads ${c}`);
    assert.strictEqual(bash('routine', c) === 'routine', routine, `routine ${c}`);
    assert.strictEqual(bash('routine-judge', c) === 'routine', routine, `routine-judge ${c}`);
  }
  assert.strictEqual(level('ask-all', 'Read', { file_path: 'a.js' }), 'judge');
  assert.strictEqual(level('safe-reads', 'Read', { file_path: 'a.js' }), 'routine');
  assert.notStrictEqual(level('safe-reads', 'Read', { file_path: '.env' }), 'routine');
});
