// Tests for guard-heredoc-backslash.js, the "a backslash never rides a heredoc" guard.
// Run: node --test system/hooks/tests/guard-heredoc-backslash.test.js
// Drives the hook as Claude Code does: a payload on stdin, the decision off stdout.
'use strict';
require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'guard-heredoc-backslash.js');
const BS = String.fromCharCode(92); // one backslash, built so no layer can eat it

function decide(command, toolName = 'Bash') {
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: toolName, tool_input: { command } }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `guard must always exit 0, got ${r.status}: ${r.stderr}`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
}

test('denies a quoted heredoc writing a script that holds a backslash', () => {
  assert.strictEqual(decide(`cat > fix.mjs <<'EOF'\nconst s = p.replace(/${BS}${BS}/g, "/");\nEOF`), 'deny');
});

test('denies unquoted and <<- heredocs, and one fed straight to an interpreter', () => {
  assert.strictEqual(decide(`python - <<PY\nprint("a${BS}nb")\nPY`), 'deny');
  assert.strictEqual(decide(`node <<-"JS"\n\tconsole.log("${BS}u00e9")\n\tJS`), 'deny');
});

test('finds the backslash in the second heredoc on a line', () => {
  assert.strictEqual(decide(`cat <<ONE <<TWO\nplain\nONE\nC:${BS}Users\nTWO`), 'deny');
});

test('allows heredocs without a backslash, and backslashes outside any heredoc body', () => {
  assert.strictEqual(decide(`cat > notes.md <<'EOF'\nplain text\nEOF`), 'allow');
  assert.strictEqual(decide(`grep -n "a${BS}|b" file.txt`), 'allow');
  assert.strictEqual(decide(`cat <<'EOF' > "C:${BS}tmp${BS}x.txt"\nplain\nEOF`), 'allow');
});

test('ignores here-strings, shifts and other tools', () => {
  assert.strictEqual(decide(`cat <<< "a${BS}b"`), 'allow');
  assert.strictEqual(decide(`echo $((1<<2)) "${BS}n"`), 'allow');
  assert.strictEqual(decide(`cat > x <<'EOF'\n${BS}\nEOF`, 'PowerShell'), 'allow');
});

test('fails open on a malformed payload', () => {
  const r = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual((r.stdout || '').trim(), '');
});
