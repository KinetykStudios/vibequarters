// Tests for guard-config.js: an edit of a linter's settings, of Claude Code's or VibeQuarters' own settings, or of a hook asks.
// Run: node --test system/hooks/tests/guard-config.test.js
'use strict';
const C = require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'guard-config.js');
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-config-')));
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
const CONFIG = path.join(HOME, '.claude', 'vibequarters.config.json');
fs.mkdirSync(path.join(HOME, '.claude'));
fs.writeFileSync(CONFIG, JSON.stringify({ appDir: '~/hq' }));
void C;

function run(tool, toolInput, env = {}) {
  const e = { ...process.env, HOME, USERPROFILE: HOME, ...env };
  for (const k of ['VIBEQUARTERS_CONFIG', 'VIBEQUARTERS_GUARD']) if (!(k in env)) delete e[k];
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 's', cwd: HOME, tool_name: tool, tool_input: toolInput }), encoding: 'utf8', env: e });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'allow';
}

const FILES = ['.claude/settings.json', '.claude/settings.local.json', '.claude/vibequarters.config.json', 'hq/hq.config.json', '.claude/vibequarters/hooks/guard-bash.js'];

test('an edit of a settings file or an installed hook asks', () => {
  for (const f of FILES) {
    assert.strictEqual(run('Write', { file_path: path.join(HOME, f), content: '{}' }), 'ask', f);
    assert.strictEqual(run('Edit', { file_path: path.join(HOME, f), old_string: 'a', new_string: 'b' }), 'ask', f);
    assert.strictEqual(run('Write', { file_path: path.join(HOME, f.replace('.claude', 'project').replace('hq/', 'other/')), content: '{}' }), 'allow', f);
  }
  const other = path.join(HOME, 'elsewhere.json');
  assert.strictEqual(run('Write', { file_path: other, content: '{}' }, { VIBEQUARTERS_CONFIG: other }), 'ask', 'the settings file VIBEQUARTERS_CONFIG names');
});

test('a shell command that writes one asks, in both shells', () => {
  for (const f of FILES) {
    const dir = path.posix.dirname(f), base = path.posix.basename(f);
    for (const [tool, command] of [
      ['Bash', `cp /tmp/x ~/${f}`], ['Bash', `cp /tmp/x "$HOME/${f}"`], ['Bash', `mv /tmp/x "$HOME"/${f}`], ['Bash', `echo '{}' > ~/${f}`], ['Bash', `sed -i 's/a/b/' ~/${f}`],
      ['Bash', `cd ~/${dir} && cp /tmp/x ${base}`], ['Bash', `rm ~/${f}`], ['Bash', `cp /tmp/${base} ~/${dir}`], ['Bash', `jq . /tmp/x | tee ~/${f}`],
      ['Bash', `node -e "require('fs').writeFileSync(process.env.HOME + '/${f}', '{}')"`], ['Bash', `python - <<'EOF'\nopen('${f}', 'w')\nEOF`],
      ['PowerShell', `Set-Content "$env:USERPROFILE\\${f.replace(/\//g, '\\')}" "{}"`], ['PowerShell', `Copy-Item x.json "${path.join(HOME, f)}"`],
      ['Monitor', `echo x >> ~/${f}`],
    ]) assert.strictEqual(run(tool, { command }), 'ask', command);
  }
  assert.strictEqual(run('Bash', { command: 'rm -rf ~/.claude/vibequarters' }), 'ask', 'a folder that holds the hooks');
});

test('reading them, running them and unrelated work stay allowed', () => {
  for (const f of FILES) {
    for (const command of [`cat ~/${f}`, `cp ~/${f} /tmp/backup`, `grep -n hooks ~/${f}`, `diff ~/${f} /tmp/x`, `ls -la ~/${path.posix.dirname(f)}`]) {
      assert.strictEqual(run('Bash', { command }), 'allow', command);
    }
  }
  for (const command of [
    'node ~/.claude/vibequarters/hooks/coord.js', 'node "$HOME/.claude/vibequarters/hooks/coord.js" register --name a --task "rm old -e files"',
    'node ~/.claude/vibequarters/hooks/usage-meter.js --cost', 'node ~/.claude/vibequarters/install/verify.js', 'git commit -m "edit settings.json"',
    'cp a.txt b.txt', 'echo hi > out.txt', 'node -e "console.log(1)"',
  ]) assert.strictEqual(run('Bash', { command }), 'allow', command);
});

test('a linter config still asks, other files pass, and the kill switch and a broken payload allow', () => {
  assert.strictEqual(run('Write', { file_path: path.join(HOME, '.eslintrc.json'), content: '{}' }), 'ask');
  assert.strictEqual(run('Write', { file_path: path.join(HOME, 'app.js'), content: '1' }), 'allow');
  assert.strictEqual(run('Write', { file_path: path.join(HOME, FILES[0]), content: '{}' }, { VIBEQUARTERS_GUARD: 'off' }), 'allow');
  assert.strictEqual(spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' }).stdout, '');
});

test('every review-proof command /land names runs without a question', () => {
  const land = fs.readFileSync(path.join(__dirname, '..', '..', 'commands', 'land.md'), 'utf8');
  const hooks = path.join(HOME, '.claude', 'vibequarters', 'hooks').replace(/\\/g, '/');
  const sha = 'a'.repeat(40);
  const fill = { '<RP>': `node "${hooks}/review-proof.js"`, '<owner/repo>': 'o/r', '<repo>': 'r', '<n>': '7', '<head>': sha, '<old>': sha, '<base>': 'origin/main', '<session id>': '11111111-2222-4333-8444-555555555555', '<agentId>': 'a1' };
  const cmds = [...land.matchAll(/`((?:<RP>|node -e)[^`]+)`/g)].map((m) => Object.entries(fill).reduce((c, [k, v]) => c.split(k).join(v), m[1])).filter((c) => / /.test(c));
  assert.strictEqual(cmds.length, 5, cmds.join('\n'));
  for (const command of cmds) assert.strictEqual(run('Bash', { command }), 'allow', command);
});

test('a Monitor command that writes one asks too', () => {
  assert.strictEqual(run('Monitor', { command: 'echo x > ~/.claude/settings.json', description: 'x' }), 'ask');
});
