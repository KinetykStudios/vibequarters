// Tests for guard-no-ai-attribution.js, the no-AI-attribution backstop.
// Run: node --test system/hooks/tests/guard-no-ai-attribution.test.js
// Drives the hook exactly as Claude Code does: a PreToolUse payload on stdin,
// the decision read off stdout. Empty stdout plus exit 0 means ALLOW.
'use strict';
require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'guard-no-ai-attribution.js');
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>';

function decide(command, cwd) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `guard must always exit 0, got ${r.status}: ${r.stderr}`);
  const out = (r.stdout || '').trim();
  if (!out) return 'allow';
  return JSON.parse(out).hookSpecificOutput.permissionDecision;
}

test('denies a commit carrying the Claude co-author trailer', () => {
  assert.strictEqual(decide(`git commit -m "Fix copy\n\n${TRAILER}"`), 'deny');
});

test('denies a commit with global flags before the verb', () => {
  assert.strictEqual(decide(`git -C /c/Users/dev/wt-x commit --allow-empty -m "first" -m "${TRAILER}"`), 'deny');
  assert.strictEqual(decide(`gh -R owner/repo pr create --title t --body "${TRAILER}"`), 'deny');
});

test('denies the heredoc commit form', () => {
  assert.strictEqual(decide(`git commit -m "$(cat <<'EOF'\nFix copy\n\n${TRAILER}\nEOF\n)"`), 'deny');
});

test('denies a PowerShell here-string commit', () => {
  assert.strictEqual(decide(`git commit -m @'\nFix copy\n\n${TRAILER}\n'@`), 'deny');
});

test('denies a PR body with the Generated with Claude Code line', () => {
  assert.strictEqual(decide('gh pr create --title t --body "Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"'), 'deny');
});

test('denies a message read from a file, relative to the payload cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-attr-'));
  fs.writeFileSync(path.join(dir, 'msg.txt'), `Fix copy\n\n${TRAILER}\n`);
  assert.strictEqual(decide('git commit -F msg.txt', dir), 'deny');
  assert.strictEqual(decide('gh pr edit 7 --body-file msg.txt', dir), 'deny');
  fs.writeFileSync(path.join(dir, 'clean.txt'), 'Fix copy\n');
  assert.strictEqual(decide('gh pr edit 7 --body-file clean.txt', dir), 'allow');
});

test('denies a PR merge that lets GitHub write the merge message', () => {
  // With no body of its own, a squash copies every commit message, trailers included, into main.
  assert.strictEqual(decide('gh pr merge 8 --squash --match-head-commit abc123'), 'deny');
  assert.strictEqual(decide('gh -R owner/repo pr merge 8 --merge --body "Clean"'), 'deny');
  assert.strictEqual(decide('gh pr merge 8 --rebase --body "Clean"'), 'deny');
  assert.strictEqual(decide('git switch -b x; gh pr merge 8 --squash'), 'deny');
});

test('allows a squash merge that carries its own clean body, and reads that body', () => {
  assert.strictEqual(decide('gh pr merge 8 --squash --match-head-commit abc123 --body "Clean summary"'), 'allow');
  assert.strictEqual(decide('gh -R owner/repo pr merge 8 -s -b "Clean summary"'), 'allow');
  assert.strictEqual(decide(`gh pr merge 8 --squash --body "Summary\n\n${TRAILER}"`), 'deny');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-attr-merge-'));
  fs.writeFileSync(path.join(dir, 'clean.txt'), 'Clean summary\n');
  fs.writeFileSync(path.join(dir, 'dirty.txt'), `Summary\n\n${TRAILER}\n`);
  assert.strictEqual(decide('gh pr merge 8 --squash --body-file clean.txt', dir), 'allow');
  assert.strictEqual(decide('gh pr merge 8 --squash --body-file dirty.txt', dir), 'deny');
});

test('reads a merge by its parsed words, so quoted text is never taken for flags or commands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-attr-quote-'));
  fs.writeFileSync(path.join(dir, 'clean.txt'), 'Clean summary\n');
  assert.strictEqual(decide('gh pr merge 5 --squash --subject "free the lock; deny a bare jq (#5)" --body-file clean.txt', dir), 'allow');
  assert.strictEqual(decide('gh pr create --title "free the lock once a PR merge returns" --body "Summary"'), 'allow');
  assert.strictEqual(decide('node "C:/x/coord.js" note "a foreground gh pr merge now frees the lock"'), 'allow');
  // and a flag named only inside quoted text is not a flag
  assert.strictEqual(decide('gh pr merge 5 --squash --subject "see --body x"'), 'deny');
  assert.strictEqual(decide('bash -c "gh pr merge 5 --squash"'), 'deny');
  assert.strictEqual(decide('gh --repo=owner/repo pr merge 5 --squash --body=Clean'), 'allow');
});

test('allows a clean commit and a clean PR', () => {
  assert.strictEqual(decide('git commit -m "Fix pricing copy"'), 'allow');
  assert.strictEqual(decide('gh pr create --title "Fix copy" --body "Summary"'), 'allow');
});

test('allows searching for the strings, which is not writing them', () => {
  assert.strictEqual(decide('git log --format=%B | grep -ciE "co-authored-by: claude|noreply@anthropic"'), 'allow');
  assert.strictEqual(decide('rg "Generated with Claude Code" .'), 'allow');
});

test('fails open on a malformed payload', () => {
  const r = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual((r.stdout || '').trim(), '');
});
