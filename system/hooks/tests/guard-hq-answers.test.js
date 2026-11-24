// Tests for guard-hq-answers.js.
// Run: node --test system/hooks/tests/guard-hq-answers.test.js
'use strict';
const C = require('./helpers/config');
const CONFIG = C.write({ appDir: '~/.claude/hq' }); // the app's folder, under each test's private home
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'guard-hq-answers.js');
const homes = [];
test.after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

function home(port) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'hqguard-'));
  homes.push(h);
  if (port) {
    fs.mkdirSync(path.join(h, '.claude', 'hq'), { recursive: true });
    fs.writeFileSync(path.join(h, '.claude', 'hq', '.runtime.json'), JSON.stringify({ port, pid: 1 }));
  }
  return h;
}

function run(h, tool, toolInput, extraEnv = {}, raw) {
  const env = { ...process.env, VIBEQUARTERS_CONFIG: CONFIG, USERPROFILE: h, HOME: h, ...extraEnv };
  if (!('VIBEQUARTERS_GUARD' in extraEnv)) delete env.VIBEQUARTERS_GUARD;
  const r = spawnSync(process.execPath, [HOOK], { input: raw ?? JSON.stringify({ tool_name: tool, tool_input: toolInput }), env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return 'allow';
  return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
}

test('the direct ways to answer for the user are denied', () => {
  const h = home();
  const dash = path.join(h, '.claude', 'hq');
  const rows = [
    ['Bash', { command: 'curl -X POST http://127.0.0.1:4747/api/answer -d "{}"' }, 'a POST to the answer route'],
    ['PowerShell', { command: 'Invoke-WebRequest -Method Post http://localhost:4747/api/presence' }, 'a presence POST'],
    ['Bash', { command: 'curl http://127.0.0.1:4747/ | grep hq-token' }, 'scraping the token'],
    ['Write', { file_path: 'C:/tmp/x.cjs', content: 'fetch("http://127.0.0.1:4747/api/answer", { method: "POST" })' }, 'a script that answers'],
    ['Write', { file_path: 'C:/tmp/y.cjs', content: 'const rt = require(home + "/.claude/hq/.runtime.json"); post("/api/answer")' }, 'a script that finds the port'],
    ['Edit', { file_path: 'C:/tmp/z.cjs', old_string: 'a', new_string: 'headers: { "X-HQ-Token": t }, url: "http://[::1]:4747/"' }, 'an edit adding the token header'],
    ['Write', { file_path: path.join(dash, 'decisions', '0123456789abcdef0123456789abcdef.answer.json'), content: '{}' }, 'an answer file written directly'],
    ['Write', { file_path: path.join(dash, '.hq-presence.json'), content: '{"focused":true}' }, 'the presence file written directly'],
    ['Edit', { file_path: path.join(dash, 'answers.log.jsonl'), old_string: 'a', new_string: 'b' }, 'the answers log edited'],
    ['Bash', { command: 'echo {} > ~/.claude/hq/decisions/x.answer.json' }, 'a shell write into the folder'],
    ['PowerShell', { command: 'Set-Content "$env:USERPROFILE\\.claude\\hq\\.hq-presence.json" "{}"' }, 'a shell write of presence'],
    ['WebFetch', { url: 'http://127.0.0.1:4747/api/answer', prompt: 'x' }, 'a web fetch of the route'],
    ['mcp__playwright__browser_navigate', { url: 'http://127.0.0.1:4747/' }, 'an agent browser opening HQ'],
    ['mcp__chrome-devtools__new_page', { url: 'http://localhost:4747' }, 'a devtools page on HQ'],
    ['Bash', { command: 'npx playwright open http://127.0.0.1:4747/' }, 'a shell-started browser at HQ'],
    ['Bash', { command: 'msedge --headless --remote-debugging-port=9222 http://localhost:4747/' }, 'a headless browser at HQ'],
    ['Bash', { command: 'curl -X POST http://127.0.0.1:4747/api/send -d "{}"' }, 'a message sent as the user'],
    ['Write', { file_path: path.join(dash, 'inbox', '77777777-8888-4999-8aaa-bbbbbbbbbbbb.msg'), content: '{}' }, 'a message file written directly'],
    ['Bash', { command: 'echo {} > ~/.claude/hq/inbox/x.msg' }, 'a shell write into the inbox'],
  ];
  for (const [tool, input, why] of rows) assert.strictEqual(run(h, tool, input), 'deny', why);
});

test('the port in the live .runtime.json counts as HQ, as well as 4747', () => {
  const h = home(7764);
  assert.strictEqual(run(h, 'Bash', { command: 'curl -X POST http://127.0.0.1:7764/api/answer' }), 'deny');
  assert.strictEqual(run(h, 'Bash', { command: 'curl -X POST http://127.0.0.1:4747/api/answer' }), 'deny');
  assert.strictEqual(run(h, 'Bash', { command: 'curl -X POST http://127.0.0.1:51234/api/answer' }), 'allow', "a test server's port is not HQ");
});

test('any spelling of the loopback host still reaches HQ, so the port decides', () => {
  const h = home();
  const rows = [
    'curl -X POST http://127.1:4747/api/answer',
    'curl -X POST http://0.0.0.0:4747/api/answer',
    'curl -X POST "http://[::ffff:127.0.0.1]:4747/api/answer"',
    'curl -X POST http://LOCALHOST.:4747/api/send',
    'curl -X POST http://2130706433:4747/api/answer',
    'curl -X POST http://127.0.0.2:4747/api/presence',
  ];
  for (const command of rows) assert.strictEqual(run(h, 'Bash', { command }), 'deny', command);
  assert.strictEqual(run(h, 'mcp__playwright__browser_navigate', { url: 'http://127.1:4747/' }), 'deny', 'a browser on a short-form host');
});

test('a file write cannot reach the live state through a junction or a \\\\?\\ path', () => {
  const h = home();
  const dash = path.join(h, '.claude', 'hq');
  fs.mkdirSync(path.join(dash, 'decisions'), { recursive: true });
  const link = path.join(h, 'dash-link');
  fs.symlinkSync(dash, link, 'junction');
  assert.strictEqual(run(h, 'Write', { file_path: path.join(link, 'decisions', 'a.answer.json'), content: '{}' }), 'deny', 'through a junction');
  assert.strictEqual(run(h, 'Write', { file_path: '\\\\?\\' + path.join(dash, 'decisions', 'b.answer.json'), content: '{}' }), 'deny', 'through a \\\\?\\ prefix');
  assert.strictEqual(run(h, 'Write', { file_path: path.join(h, 'elsewhere', 'decisions', 'c.json'), content: '{}' }), 'allow', 'a decisions folder that is not HQ');
});

// The sandbox's own runtime port (7764) stands in for HQ's here, so these calls name no live address.
test('a port written with leading zeros is the same port', () => {
  const h = home(7764);
  assert.strictEqual(run(h, 'Bash', { command: 'curl -X POST http://127.0.0.1:07764/api/answer' }), 'deny', 'one leading zero');
  assert.strictEqual(run(h, 'Bash', { command: 'curl -X POST http://localhost:0007764/api/send' }), 'deny', 'several leading zeros');
  assert.strictEqual(run(h, 'mcp__playwright__browser_navigate', { url: 'http://127.0.0.1:07764/' }), 'deny', 'a browser on a zero-padded port');
  assert.strictEqual(run(h, 'Bash', { command: 'curl -X POST http://127.0.0.1:17764/api/answer' }), 'allow', 'a port that only ends in the HQ digits');
});

test('a file write cannot reach the live state through the names Windows rewrites', () => {
  const h = home();
  const dash = path.join(h, '.claude', 'hq');
  const rows = [
    [path.join(dash, 'answers.log.jsonl.'), 'a trailing dot'],
    [path.join(dash, 'answers.log.jsonl '), 'a trailing space'],
    [path.join(dash, 'answers.log.jsonl. . '), 'trailing dots and spaces'],
    [path.join(dash, '.hq-presence.json::$DATA'), 'the default data stream'],
    [path.join(dash, 'decisions.', 'a.answer.json'), 'a trailing dot on the folder'],
    [path.join(dash, 'inbox ', 'x.msg'), 'a trailing space on the folder'],
    [path.join(h, '.claude.', 'hq', 'decisions', 'b.answer.json'), 'a trailing dot higher up'],
  ];
  for (const [file_path, why] of rows) assert.strictEqual(run(h, 'Write', { file_path, content: '{}' }), 'deny', why);
  assert.strictEqual(run(h, 'Write', { file_path: path.join(dash, 'answers.log.jsonl.bak'), content: '{}' }), 'allow', 'a different file beside the log');
});

// What the approval files hold is the user's choice, so an agent writing one would widen its own approvals.
const APPROVAL_FILES = (h) => [
  path.join(h, '.claude', 'hq', 'approvals-choice.json'), path.join(h, '.claude', 'hq', 'approval-levels.json'),
  path.join(h, '.claude', 'vibequarters', 'presets', 'approvals', 'ask-all.json'), path.join(h, '.claude', 'hq-feed', 'agents-off.json'),
];
test('a write to the saved preset, the approval lists, a preset file or the agent switches is denied', () => {
  const h = home();
  for (const f of APPROVAL_FILES(h)) {
    const s = f.replace(/\\/g, '/');
    const tilde = s.replace(h.replace(/\\/g, '/'), '~');
    const dollar = tilde.replace(/^~/, '"$HOME"');
    assert.strictEqual(run(h, 'Write', { file_path: f, content: '{}' }), 'deny', f);
    assert.strictEqual(run(h, 'Edit', { file_path: f, old_string: 'a', new_string: 'b' }), 'deny', f);
    for (const [tool, command] of [
      ['Bash', `cp loose.json "${s}"`], ['Bash', `cp loose.json ${tilde}`], ['Bash', `mv -f loose.json ${dollar}`],
      ['Bash', `echo '{}' > ${tilde}`], ['Bash', `cat x | tee ${tilde}`], ['Bash', `sed -i s/a/b/ ${tilde}`], ['Bash', `rm ${tilde}`],
      ['Bash', `sudo cp loose.json ${tilde}`], ['Bash', `cd ${path.posix.dirname(tilde)} && cp /tmp/l.json ${path.posix.basename(tilde)}`],
      ['Bash', `cp /tmp/${path.posix.basename(tilde)} ${path.posix.dirname(tilde)}/`], ['Bash', `rm -rf ${path.posix.dirname(tilde)}`],
      ['Bash', `node -e "require('fs').writeFileSync('${s}', '{}')"`], ['Bash', `python3 -c "open('${tilde}', 'w')"`],
      ['Bash', `bash -lc 'cp /tmp/x ${tilde}'`],
      ['PowerShell', `Copy-Item loose.json -Destination "${f}"`], ['PowerShell', `Set-Content "${f.replace(h, '$env:USERPROFILE')}" '{}'`],
      ['Monitor', `echo {} > ${tilde}`],
    ]) assert.strictEqual(run(h, tool, { command }), 'deny', command);
  }
});

test('reading the approval files, and the same names elsewhere, stay allowed', () => {
  const h = home();
  for (const f of APPROVAL_FILES(h)) {
    const tilde = f.replace(/\\/g, '/').replace(h.replace(/\\/g, '/'), '~');
    const base = path.posix.basename(tilde);
    for (const command of [`cat ${tilde}`, `cp ${tilde} /tmp/copy.json`, `jq . ${tilde}`, `diff ${tilde} /tmp/other.json`, `git add src/${base}`, `cp a.json /tmp/src/${base}`]) {
      assert.strictEqual(run(h, 'Bash', { command }), 'allow', command);
    }
    assert.strictEqual(run(h, 'Read', { file_path: f }), 'allow');
    assert.strictEqual(run(h, 'Write', { file_path: path.join(h, 'src', base), content: '{}' }), 'allow', base);
  }
  assert.strictEqual(run(h, 'Bash', { command: 'node ~/.claude/vibequarters/hooks/coord.js register --name a --task "presets/approvals/ -e cp"' }), 'allow');
});

test('the approvals, agents and warm routes are denied too', () => {
  const h = home(7764);
  for (const route of ['approvals', 'agents', 'warm']) {
    assert.strictEqual(run(h, 'Bash', { command: `curl -X POST http://127.0.0.1:7764/api/${route} -d "{}"` }), 'deny', route);
    assert.strictEqual(run(h, 'Bash', { command: `curl -X POST http://127.0.0.1:51234/api/${route} -d "{}"` }), 'allow', `${route} of a test server`);
  }
  assert.strictEqual(run(h, 'Bash', { command: 'curl http://127.0.0.1:7764/api/stats' }), 'allow');
});

test('building, testing and opening HQ stay allowed', () => {
  const h = home();
  const rows = [
    ['Bash', { command: 'node --test test/*.test.js test/*.test.mjs' }, 'the suite'],
    ['Bash', { command: 'node --check server.js' }, 'a syntax check'],
    ['Bash', { command: 'curl -I http://127.0.0.1:4747/' }, 'a status check'],
    ['PowerShell', { command: 'Start-Process "http://127.0.0.1:4747/"' }, "opening HQ in the user's own browser"],
    ['Write', { file_path: 'C:/Users/x/src/public/control.js', content: 'export const post = (p, b) => fetch(p, { method: "POST", headers: { "X-HQ-Token": token() } }); post("/api/answer", {})' }, 'the page source'],
    ['Edit', { file_path: 'C:/Users/x/src/test/control-server.test.js', old_string: 'a', new_string: 'request(s, "/api/answer", { Origin: `http://127.0.0.1:${s.port}` }); JSON.parse(fs.readFileSync(path.join(state, ".runtime.json")))' }, 'a test against its own port-0 server'],
    ['Read', { file_path: 'C:/Users/x/.claude/hq/decisions/a.json' }, 'reading a request'],
    ['Grep', { pattern: 'hq-token', path: 'C:/Users/x/.claude/hq' }, 'searching the code'],
    ['Agent', { prompt: 'Never POST to http://127.0.0.1:4747/api/answer; never touch the decisions folder.' }, 'instructions to a subagent'],
    ['mcp__playwright__browser_navigate', { url: 'http://127.0.0.1:51234/' }, "an agent browser on a test server's port"],
    ['Bash', { command: 'git -C ~/.claude/hq log --oneline -1' }, 'reading the app folder'],
    ['Write', { file_path: 'C:/Users/x/src/lib/inbox.js', content: 'const dir = path.join(stateDir, "inbox"); post("/api/send")' }, 'the inbox source'],
  ];
  for (const [tool, input, why] of rows) assert.strictEqual(run(h, tool, input), 'allow', why);
});

test('the kill switch and a broken input both allow', () => {
  const h = home();
  assert.strictEqual(run(h, 'Bash', { command: 'curl -X POST http://127.0.0.1:4747/api/answer' }, { VIBEQUARTERS_GUARD: 'off' }), 'allow');
  assert.strictEqual(run(h, 'Bash', null, {}, 'not json'), 'allow');
});
