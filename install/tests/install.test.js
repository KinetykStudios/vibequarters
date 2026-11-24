// The installer, uninstaller, verifier and doctor, driven as a user drives them, in a throwaway home folder.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('../lib');

const INSTALL = path.join(__dirname, '..', 'install.js');

function box(t, settings, who = 'home') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vibequarters-install-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const home = path.join(root, who), app = path.join(root, 'app');
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(path.join(app, 'bridge'), { recursive: true });
  for (const f of ['server.js', 'launch.js', 'bridge/hq-bridge.js', 'bridge/hq-inbox.js']) fs.writeFileSync(path.join(app, f), '// app\n');
  fs.copyFileSync(path.join(L.REPO, 'hq.config.example.json'), path.join(app, 'hq.config.example.json'));
  const b = { root, home, app, claude, settings: path.join(claude, 'settings.json'), sys: path.join(claude, 'vibequarters'), config: path.join(claude, 'vibequarters.config.json') };
  if (settings !== undefined) fs.writeFileSync(b.settings, settings);
  return b;
}
function node(file, args, opt = {}) {
  const env = { ...process.env, ...opt.env };
  for (const k of ['VIBEQUARTERS_CONFIG', 'VIBEQUARTERS_GUARD', 'VIBEQUARTERS_HALT']) if (!(opt.env && k in opt.env)) delete env[k];
  const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', input: opt.input || '', env });
  return { code: r.status, out: r.stdout + r.stderr };
}
const install = (b, args, opt) => node(INSTALL, ['--home', b.home, '--app-dir', b.app, '--skip-version-check', ...args], opt);
const tool = (b, name, args = []) => node(path.join(b.sys, 'install', `${name}.js`), ['--home', b.home, ...args]);
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const entries = (s) => Object.entries(s.hooks || {}).flatMap(([e, l]) => l.flatMap((g) => g.hooks.map((h) => [e, JSON.stringify(h)])));
const snapshot = (d) => Object.fromEntries(fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).map((f) => [L.slash(f), fs.readFileSync(path.join(d, f)).toString('base64')]));

// Settings a user already has: their own formatting, hooks, a status line and env values
const USER = '{\r\n\t"model": "opus",\r\n\t"env": { "MY_VAR": "1" },\r\n\t"statusLine": { "type": "command", "command": "mine.sh" },\r\n\t"permissions": { "allow": ["Bash(ls)"] },\r\n\t"hooks": {\r\n\t\t"Stop": [{ "hooks": [{ "type": "command", "command": "echo mine" }] }],\r\n\t\t"PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node", "args": ["/mine/guard.js"] }] }]\r\n\t}\r\n}';

test('Full into an empty home: every pack, verify and doctor pass, and uninstall leaves no settings', (t) => {
  const b = box(t);
  const r = install(b, ['--yes', '--preset', 'full', '--approvals', 'routine']);
  assert.strictEqual(r.code, 0, r.out);
  const m = json(path.join(b.sys, L.MANIFEST));
  assert.deepStrictEqual(m.packs, L.fullPacks());
  const s = json(b.settings);
  assert.ok(s.statusLine.command.includes('statusline.js'));
  assert.strictEqual(s.env[L.PLUGIN_DIRS].split(L.sep()).length, 2);
  assert.deepStrictEqual(Object.keys(json(b.config)).sort(), ['appDir', 'loop', 'systemDir']);
  assert.deepStrictEqual(json(path.join(b.app, 'approvals-choice.json')).preset, 'routine');
  assert.match(fs.readFileSync(path.join(b.claude, 'vibequarters.salt'), 'utf8').trim(), /^[0-9a-f]{48}$/);
  assert.strictEqual(fs.readFileSync(path.join(b.claude, 'CLAUDE.md'), 'utf8'), '@~/.claude/vibequarters/rules/RULES.md\n');
  assert.match(fs.readFileSync(path.join(b.sys, 'rules', 'RULES.md'), 'utf8'), /\n@REPLY-SHAPE\.md\n$/);
  assert.ok(fs.existsSync(path.join(b.sys, 'lib', 'pricing.js')));
  assert.ok(fs.existsSync(path.join(b.claude, 'commands', 'land.md')));
  assert.ok(fs.existsSync(path.join(b.claude, 'skills', 'vibesec', 'LICENSE')));
  assert.ok(!fs.existsSync(path.join(b.sys, 'hooks', 'tests')), 'the tests stay in the clone');

  const v = tool(b, 'verify');
  assert.strictEqual(v.code, 0, v.out);
  assert.match(v.out, /Every check passed/);
  const d = tool(b, 'doctor');
  assert.match(d.out, new RegExp(`${m.settings.added.groups.length} hook entries in settings\\.json`));
  assert.doesNotMatch(d.out, /PROBLEM {2}(?!Claude Code)/);

  // Negative control of verify: one hook that no longer answers is reported
  const guard = path.join(b.sys, 'hooks', 'guard-bash.js');
  const was = fs.readFileSync(guard);
  fs.writeFileSync(guard, 'process.exit(0);\n');
  const broken = tool(b, 'verify');
  assert.strictEqual(broken.code, 1);
  assert.match(broken.out, /FAIL {2}PreToolUse guard-bash\.js: answered allow, not ask/);
  fs.writeFileSync(guard, was);

  const u = tool(b, 'uninstall');
  assert.strictEqual(u.code, 0, u.out);
  assert.ok(!fs.existsSync(b.settings) && !fs.existsSync(b.config) && !fs.existsSync(path.join(b.claude, 'CLAUDE.md')), u.out);
  assert.ok(!fs.existsSync(b.sys), 'the system folder is gone');
  assert.ok(!fs.existsSync(path.join(b.claude, 'commands')) && !fs.existsSync(path.join(b.claude, 'skills')));
  assert.match(u.out, /vibequarters\.salt/);
});

test('a home folder with a space and an apostrophe: verify registers a session, and a guard that cannot is reported', (t) => {
  const b = box(t, undefined, "Jane O'Neil");
  const r = install(b, ['--yes', '--preset', 'full']);
  assert.strictEqual(r.code, 0, r.out);
  // the command the install names, as a session runs it
  const env = { ...process.env, HOME: b.home, USERPROFILE: b.home, VIBEQUARTERS_CONFIG: b.config };
  for (const k of ['VIBEQUARTERS_GUARD', 'VIBEQUARTERS_HALT', 'VIBEQUARTERS_COORD_DIR']) delete env[k];
  const command = `node "${L.slash(b.sys)}/hooks/coord.js" register --name jane --task x`;
  const guard = path.join(b.sys, 'hooks', 'coord-guard.js');
  const g = spawnSync(process.execPath, [guard], { encoding: 'utf8', env, cwd: b.home, input: JSON.stringify({ session_id: 's-1', cwd: b.home, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }) });
  assert.strictEqual(g.status, 0, g.stderr);
  assert.strictEqual(json(path.join(b.claude, 'coordination', 'registry.json')).sessions['s-1'].name, 'jane');
  const v = tool(b, 'verify');
  assert.strictEqual(v.code, 0, v.out);

  fs.writeFileSync(guard, fs.readFileSync(guard, 'utf8').replace(/^const COORD_AT = .*$/m, 'const COORD_AT = /^never$/;'));
  const broken = tool(b, 'verify');
  assert.strictEqual(broken.code, 1);
  assert.match(broken.out, /FAIL {2}PreToolUse coord-guard\.js: did not do what it must/);
});

test('settings a user already has come back byte for byte, and nothing of theirs changes while installed', (t) => {
  const b = box(t, USER);
  fs.writeFileSync(path.join(b.claude, 'CLAUDE.md'), '# my rules\r\nno newline at the end');
  fs.mkdirSync(path.join(b.claude, 'commands'));
  fs.writeFileSync(path.join(b.claude, 'commands', 'plan.md'), 'my own /plan');
  fs.writeFileSync(b.config, '{"notify":{"count":2}}');
  const before = snapshot(b.home);

  const r = install(b, ['--yes', '--preset', 'full']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /you already have a \/plan command; yours stays/);
  const s = json(b.settings), mine = JSON.parse(USER);
  for (const e of entries(mine)) assert.ok(entries(s).some((x) => x[0] === e[0] && x[1] === e[1]), `${e} stays`);
  assert.deepStrictEqual(s.hooks.Stop[0], mine.hooks.Stop[0], 'the user\'s hooks stay first');
  assert.deepStrictEqual(s.hooks.PreToolUse[0], mine.hooks.PreToolUse[0]);
  assert.deepStrictEqual(s.statusLine, mine.statusLine, '--yes never replaces a status line');
  assert.deepStrictEqual(s.permissions, mine.permissions);
  assert.strictEqual(s.env.MY_VAR, '1');
  const text = fs.readFileSync(b.settings, 'utf8');
  assert.ok(text.includes('\r\n\t"model"') && !/[^\r]\n/.test(text) && !text.endsWith('\n'), 'their indent, newlines and ending are kept');
  assert.strictEqual(json(b.config).notify.count, 2);
  assert.strictEqual(fs.readFileSync(path.join(b.claude, 'commands', 'plan.md'), 'utf8'), 'my own /plan');
  const backups = fs.readdirSync(b.claude).filter((f) => f.startsWith('settings.json.vibequarters-backup-'));
  assert.strictEqual(backups.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(b.claude, backups[0]), 'utf8'), USER);
  assert.strictEqual(json(path.join(b.app, 'approvals-choice.json')).preset, 'routine', 'Full picks the recommended preset');

  assert.strictEqual(tool(b, 'uninstall').code, 0);
  const after = Object.fromEntries(Object.entries(snapshot(b.home)).filter(([f]) => !/vibequarters-backup|vibequarters\.salt/.test(f)));
  assert.deepStrictEqual(after, before);
});

test('--replace-statusline swaps the status line and uninstall puts the old one back', (t) => {
  const b = box(t, USER);
  assert.strictEqual(install(b, ['--yes', '--preset', 'custom', '--packs', 'statusline', '--replace-statusline']).code, 0);
  assert.match(json(b.settings).statusLine.command, /vibequarters\/statusline\/statusline\.js/);
  fs.writeFileSync(b.settings, fs.readFileSync(b.settings, 'utf8').replace('"opus"', '"sonnet"')); // edited since
  assert.strictEqual(tool(b, 'uninstall').code, 0);
  assert.deepStrictEqual(json(b.settings), { ...JSON.parse(USER), model: 'sonnet' });
});

test('settings edited after the install keep the edit, and only VibeQuarters\'s entries come out', (t) => {
  const b = box(t, USER);
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 0);
  const s = json(b.settings);
  s.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo later' }] });
  s.hooks.PreToolUse.find((g) => JSON.stringify(g).includes('guard-bash')).hooks.push({ type: 'command', command: 'echo joined' });
  s.env[L.PLUGIN_DIRS] += `${L.sep()}/my/mod`;
  s.env.ADDED = '2';
  fs.writeFileSync(b.settings, JSON.stringify(s));
  fs.appendFileSync(path.join(b.sys, 'hooks', 'guard-bash.js'), '// mine\n');
  const c = json(b.config); c.notify = { count: 9 }; fs.writeFileSync(b.config, JSON.stringify(c));
  const u = tool(b, 'uninstall');
  assert.strictEqual(u.code, 0, u.out);
  const want = JSON.parse(USER);
  want.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo later' }] });
  want.hooks.PreToolUse.push({ matcher: 'Bash|PowerShell|Monitor', hooks: [{ type: 'command', command: 'echo joined' }] });
  want.env[L.PLUGIN_DIRS] = '/my/mod';
  want.env.ADDED = '2';
  assert.deepStrictEqual(json(b.settings), want);
  assert.match(u.out, /guard-bash\.js \(you edited it\)/);
  assert.strictEqual(json(b.config).notify.count, 9);
  assert.ok(!fs.existsSync(path.join(b.sys, 'hooks', 'guard-config.js')));
});

test('running it again changes packs, adds nothing twice, and uninstall still restores the original', (t) => {
  const b = box(t, USER);
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 0);
  const first = fs.readFileSync(b.settings);
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 0);
  assert.deepStrictEqual(fs.readFileSync(b.settings), first, 'the same choice gives the same file');
  assert.strictEqual(install(b, ['--yes', '--preset', 'custom', '--packs', 'core', '--no-rules']).code, 0);
  const s = json(b.settings);
  assert.ok(!JSON.stringify(s).includes('coord-guard'));
  assert.ok(JSON.stringify(s).includes('guard-deny-catastrophic'));
  assert.strictEqual(s.env[L.PLUGIN_DIRS], undefined);
  const kept = fs.readFileSync(b.settings);
  assert.strictEqual(install(b, ['--yes', '--no-rules']).code, 0);
  assert.deepStrictEqual(fs.readFileSync(b.settings), kept, '--yes alone keeps the packs');
  assert.strictEqual(json(b.config).mergeGate.requireReview, false, 'no merge-gate pack: no review needed');
  assert.ok(!fs.existsSync(path.join(b.claude, 'commands', 'land.md')), 'a dropped pack takes its commands along');
  assert.ok(!fs.existsSync(path.join(b.claude, 'CLAUDE.md')) || !fs.readFileSync(path.join(b.claude, 'CLAUDE.md'), 'utf8').includes('RULES.md'));
  assert.strictEqual(tool(b, 'uninstall').code, 0);
  assert.strictEqual(fs.readFileSync(b.settings, 'utf8'), USER);
});

test('a hook the user already registered themselves is not added twice and survives uninstall', (t) => {
  const b = box(t);
  const launch = `node "${L.slash(path.join(b.app, 'launch.js'))}"`;
  const mine = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: launch }] }] } };
  fs.writeFileSync(b.settings, JSON.stringify(mine));
  assert.strictEqual(install(b, ['--yes', '--preset', 'custom', '--packs', 'app,core']).code, 0);
  assert.strictEqual(entries(json(b.settings)).filter(([e, h]) => e === 'SessionStart' && h.includes('launch.js')).length, 1);
  fs.writeFileSync(b.settings, JSON.stringify({ ...json(b.settings), model: 'x' }));
  assert.strictEqual(tool(b, 'uninstall').code, 0);
  assert.deepStrictEqual(json(b.settings), { ...mine, model: 'x' });
});

test('--dry-run writes nothing, for install and uninstall', (t) => {
  const b = box(t, USER);
  const before = snapshot(b.root);
  const r = install(b, ['--yes', '--preset', 'full', '--approvals', 'routine', '--dry-run']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Dry run\. This would/);
  assert.deepStrictEqual(snapshot(b.root), before);
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 0);
  const on = snapshot(b.root);
  assert.match(tool(b, 'uninstall', ['--dry-run']).out, /put back .*settings\.json exactly as it was/);
  assert.deepStrictEqual(snapshot(b.root), on);
});

test('what it cannot read or does not own stops it before it writes anything', (t) => {
  const b = box(t, '{ "hooks": { // a comment\n }');
  const before = snapshot(b.root);
  const bad = install(b, ['--yes']);
  assert.strictEqual(bad.code, 1);
  assert.match(bad.out, /settings\.json cannot be read .*nothing was written/);
  fs.writeFileSync(b.settings, '{"hooks":[]}');
  assert.match(install(b, ['--yes']).out, /"hooks" is not an object/);
  fs.writeFileSync(b.settings, '{ "hooks": { // a comment\n }');
  assert.deepStrictEqual(snapshot(b.root), before);
  const c = box(t, '{}');
  fs.mkdirSync(c.sys);
  fs.writeFileSync(path.join(c.sys, 'mine.txt'), 'mine');
  assert.match(install(c, ['--yes']).out, /already holds files the installer did not put there/);
  for (const [args, want] of [[['--packs', 'nope', '--yes'], /unknown pack "nope"/], [['--preset', 'big', '--yes'], /--preset is one of/], [['--approvals', 'all', '--yes'], /--approvals is one of/], [['--bogus'], /unknown argument/], [['--yes', '--preset', 'custom'], /needs --packs/]]) {
    const r = install(box(t, '{}'), args);
    assert.strictEqual(r.code, 1, args.join(' '));
    assert.match(r.out, want);
  }
});

test('the questions: a full answer set installs, and a closed stdin installs nothing', (t) => {
  const b = box(t, USER);
  const before = snapshot(b.root);
  assert.match(install(b, [], { input: '1\n' }).out, /no answer; nothing was installed/);
  assert.match(install(b, [], { input: '1\n3\ny\nn\ny\nn\n' }).out, /Nothing was installed/);
  assert.deepStrictEqual(snapshot(b.root), before);
  // full, the routine preset, set the app up, keep the status line, the rules line, go ahead
  const r = install(b, [], { input: '1\n3\ny\nn\ny\ny\n' });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(json(path.join(b.app, 'approvals-choice.json')).preset, 'routine');
  assert.deepStrictEqual(json(b.settings).statusLine, JSON.parse(USER).statusLine);
});

// A folder where a command file must go stops the copy partway, after the system files.
const block = (b) => { fs.rmSync(path.join(b.claude, 'commands', 'land.md'), { force: true }); fs.mkdirSync(path.join(b.claude, 'commands', 'land.md'), { recursive: true }); };
const unblock = (b) => fs.rmdirSync(path.join(b.claude, 'commands', 'land.md'));
const mineOnly = (b) => Object.fromEntries(Object.entries(snapshot(b.home)).filter(([f]) => !/vibequarters-backup|vibequarters\.salt/.test(f)));

test('an install that stops partway is taken back by uninstall, and settings.json was never touched', (t) => {
  const b = box(t, USER);
  fs.writeFileSync(b.config, '{"notify":{"count":2}}');
  const before = mineOnly(b);
  block(b);
  const r = install(b, ['--yes', '--preset', 'full']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /stopped partway.*run it again.*uninstall\.js/is);
  assert.strictEqual(fs.readFileSync(b.settings, 'utf8'), USER);
  assert.ok(fs.existsSync(path.join(b.sys, 'hooks', 'guard-bash.js')), 'control: it did stop partway');
  const u = node(path.join(__dirname, '..', 'uninstall.js'), ['--home', b.home]);
  assert.strictEqual(u.code, 0, u.out);
  unblock(b);
  fs.rmdirSync(path.join(b.claude, 'commands'));
  assert.deepStrictEqual(mineOnly(b), before);
  assert.ok(!fs.existsSync(b.sys), 'the system folder is gone');
});

test('an install that stopped partway finishes when it is run again, and uninstall still restores byte for byte', (t) => {
  const b = box(t, USER);
  const before = mineOnly(b);
  block(b);
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 1);
  unblock(b);
  const r = install(b, ['--yes', '--preset', 'full']);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!json(path.join(b.sys, L.MANIFEST)).pending);
  assert.strictEqual(tool(b, 'verify').code, 0);
  assert.strictEqual(tool(b, 'uninstall').code, 0);
  assert.deepStrictEqual(mineOnly(b), before);
});

test('an update that stops partway still knows the files of the version before', (t) => {
  const b = box(t, USER);
  const before = mineOnly(b);
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 0);
  // an earlier version: a command with other words, a file this version no longer has, and the settings it left
  const manifest = path.join(b.sys, L.MANIFEST);
  const m = json(manifest);
  for (const [f, text] of [[path.join(b.claude, 'commands', 'evolve.md'), 'the version before'], [path.join(b.sys, 'hooks', 'gone.js'), '// dropped since']]) {
    fs.writeFileSync(f, text);
    m.files[L.slash(f)] = L.sha(Buffer.from(text));
  }
  fs.writeFileSync(manifest, JSON.stringify(m));
  block(b);
  assert.strictEqual(install(b, ['--yes', '--preset', 'custom', '--packs', 'merge-gate,learning-loop']).code, 1);
  assert.strictEqual(fs.readFileSync(path.join(b.claude, 'commands', 'evolve.md'), 'utf8'), 'the version before', 'control: it stopped before this one');
  unblock(b);
  const u = tool(b, 'uninstall');
  assert.strictEqual(u.code, 0, u.out);
  assert.doesNotMatch(u.out, /you edited it/);
  assert.deepStrictEqual(mineOnly(b), before);
});

const appConfig = (b) => path.join(b.app, 'hq.config.json');

test('Full sets the app up: the example config with control and the assistant on, and a restart is all that is left', (t) => {
  const b = box(t);
  const r = install(b, ['--yes', '--preset', 'full']);
  assert.strictEqual(r.code, 0, r.out);
  const example = json(path.join(L.REPO, 'hq.config.example.json'));
  const c = json(appConfig(b));
  assert.deepStrictEqual(c, { ...example, control: true, assistant: {} });
  assert.deepStrictEqual(require(path.join(L.REPO, 'config.js')).validateConfig(c), [], 'the app accepts it');
  assert.match(r.out, /turn on answering from the page and the assistant: .*hq\.config\.json/);
  assert.match(r.out, /Still to do:\n {2}1\. Restart your Claude Code sessions\./);
  assert.doesNotMatch(r.out, /"control": true/, 'nothing left to do by hand');
  assert.ok(JSON.stringify(json(b.settings).hooks.SessionStart).includes('/launch.js'), 'the page opens by itself');
  assert.match(tool(b, 'doctor').out, /answering from the page is on/);

  // running it again keeps the record, so uninstall still knows the file is the installer's
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 0);
  assert.deepStrictEqual(json(appConfig(b)), c);
  assert.strictEqual(install(b, ['--yes', '--preset', 'custom', '--packs', 'core']).code, 0);
  const u = tool(b, 'uninstall');
  assert.strictEqual(u.code, 0, u.out);
  assert.ok(!fs.existsSync(appConfig(b)), 'unchanged: it goes with the uninstall');
});

// A gh that says whether it is logged in
function fakeGh(b, loggedIn) {
  const dir = path.join(b.root, `gh-${loggedIn}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'gh.cmd'), `@if "%1"=="auth" exit /b ${loggedIn ? 0 : 1}\r\n@exit /b 0\r\n`);
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\n[ "$1" = auth ] && exit ${loggedIn ? 0 : 1}\nexit 0\n`, { mode: 0o755 });
  return { env: { PATH: dir + path.delimiter + process.env.PATH } };
}

test('one list of what is still to do: the restart, gh login when it is missing, /loop-init, and how approvals work', (t) => {
  const b = box(t);
  const out = install(b, ['--yes', '--preset', 'full'], fakeGh(b, false)).out;
  const list = out.slice(out.indexOf('Still to do:'), out.indexOf('Optional:'));
  assert.strictEqual(out.split('Still to do:').length, 2, 'one list');
  assert.match(list, /1\. Restart your Claude Code sessions\. The VibeQuarters page opens with the first one\./);
  assert.match(list, /2\. .*gh auth login/);
  assert.match(list, /3\. .*\/loop-init/);
  assert.match(out, /Approve routine coding work .*acts only inside an approve window.*the page's assistant/s);
  assert.doesNotMatch(install(b, ['--yes', '--preset', 'full'], fakeGh(b, true)).out, /gh auth login/, 'logged in');

  const c = box(t);
  const core = install(c, ['--yes', '--preset', 'custom', '--packs', 'core'], fakeGh(c, false)).out;
  assert.match(core, /Still to do:\n {2}1\. Restart your Claude Code sessions\.\n/);
  assert.doesNotMatch(core, /gh auth login|\/loop-init|approve window/, 'only what the chosen packs need');
});

test('--yes --preset full picks the recommended approvals preset, and leaves a choice already made alone', (t) => {
  const b = box(t);
  const choice = path.join(b.app, 'approvals-choice.json');
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 0);
  assert.strictEqual(json(choice).preset, 'routine');
  fs.writeFileSync(choice, '{"v":1,"preset":"ask-all","at":1}');
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 0);
  assert.strictEqual(json(choice).preset, 'ask-all', 'the page\'s choice stays');
  assert.match(tool(b, 'uninstall').out, /approvals-choice\.json \(what the page may approve\)/, 'the record survives a second run');
  for (const args of [['--preset', 'full', '--approvals', 'none'], ['--preset', 'custom', '--packs', 'app']]) {
    const c = box(t);
    assert.strictEqual(install(c, ['--yes', ...args]).code, 0);
    assert.ok(!fs.existsSync(path.join(c.app, 'approvals-choice.json')), args.join(' '));
  }
});

test('an app config edited since the install stays after uninstall', (t) => {
  const b = box(t);
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 0);
  const c = json(appConfig(b));
  c.planUsd = 20;
  fs.writeFileSync(appConfig(b), JSON.stringify(c));
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 0, 'a second run leaves the edit alone');
  const u = tool(b, 'uninstall');
  assert.deepStrictEqual(json(appConfig(b)), c);
  assert.match(u.out, /hq\.config\.json \(you edited it\)/);
});

test('an app config that was there before is never changed or removed', (t) => {
  const b = box(t);
  fs.writeFileSync(appConfig(b), '{ "mine": 1 }');
  for (const args of [['--preset', 'full'], ['--preset', 'full', '--app-config', 'yes']]) {
    const r = install(b, ['--yes', ...args]);
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(fs.readFileSync(appConfig(b), 'utf8'), '{ "mine": 1 }');
    assert.match(r.out, /hq\.config\.json in .* stays as it is/);
  }
  assert.strictEqual(tool(b, 'uninstall').code, 0);
  assert.strictEqual(fs.readFileSync(appConfig(b), 'utf8'), '{ "mine": 1 }');
});

test('no app config without the app pack, without a yes, in a dry run, or with no example to start from', (t) => {
  const cases = [
    [['--yes', '--preset', 'custom', '--packs', 'core'], {}],
    [['--yes', '--preset', 'custom', '--packs', 'app'], {}],
    [['--yes', '--preset', 'full', '--app-config', 'no'], {}],
    [['--yes', '--preset', 'full', '--dry-run'], {}],
    [[], { input: '1\n3\nn\ny\ny\n' }],
  ];
  for (const [args, opt] of cases) {
    const b = box(t);
    const r = install(b, args, opt);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(!fs.existsSync(appConfig(b)), args.join(' ') || 'answered no');
  }
  const on = box(t);
  assert.strictEqual(install(on, ['--yes', '--preset', 'custom', '--packs', 'app', '--app-config', 'yes']).code, 0);
  assert.strictEqual(json(appConfig(on)).control, true, 'control: a yes with the app pack writes it');
  const bare = box(t);
  fs.unlinkSync(path.join(bare.app, 'hq.config.example.json'));
  const r = install(bare, ['--yes', '--preset', 'full']);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!fs.existsSync(appConfig(bare)));
  assert.match(r.out, /no hq\.config\.example\.json/);
  assert.match(install(box(t), ['--yes', '--app-config', 'maybe']).out, /--app-config is yes or no/);
});

test('a system folder of its own is named in the app config', (t) => {
  const b = box(t);
  const dir = path.join(b.home, 'sys');
  assert.strictEqual(install(b, ['--yes', '--preset', 'full', '--dir', dir]).code, 0);
  assert.strictEqual(json(appConfig(b)).systemDir, '~/sys');
});

test('the core pack asks before a shell command or an edit changes the settings or a hook', (t) => {
  const b = box(t);
  assert.strictEqual(install(b, ['--yes', '--preset', 'custom', '--packs', 'core']).code, 0);
  const matchers = json(b.settings).hooks.PreToolUse.filter((g) => JSON.stringify(g).includes('guard-config.js')).map((g) => g.matcher);
  for (const tool of ['Bash', 'PowerShell', 'Monitor', 'Edit', 'Write', 'MultiEdit']) assert.ok(matchers.some((m) => m.split('|').includes(tool)), tool);
});

test('a second system folder is refused while the first is installed, and fine after it is taken out', (t) => {
  const b = box(t, USER);
  const dir = path.join(b.home, 'elsewhere');
  assert.strictEqual(install(b, ['--yes', '--preset', 'custom', '--packs', 'core']).code, 0);
  const on = snapshot(b.root);
  for (const extra of [[], ['--dry-run']]) {
    const r = install(b, ['--yes', '--preset', 'custom', '--packs', 'core', '--dir', dir, ...extra]);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /already installed in .*vibequarters/);
    assert.match(r.out, /uninstall\.js/);
    assert.match(r.out, /without --dir/);
  }
  assert.deepStrictEqual(snapshot(b.root), on, 'nothing was written');
  assert.strictEqual(install(b, ['--yes', '--preset', 'custom', '--packs', 'core', '--dir', b.sys]).code, 0, 'the same folder is an update');
  assert.strictEqual(tool(b, 'uninstall').code, 0);
  assert.strictEqual(install(b, ['--yes', '--preset', 'custom', '--packs', 'core', '--dir', dir]).code, 0);
});

test('uninstall lists every backup it and the installer left, and the salt', (t) => {
  const b = box(t, USER);
  fs.writeFileSync(path.join(b.claude, 'CLAUDE.md'), '# mine\n');
  fs.writeFileSync(b.config, '{"notify":{"count":2}}');
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 0);
  const plan = path.join(b.claude, 'commands', 'plan.md');
  fs.writeFileSync(plan, 'my words');
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 0, 'an edited command is kept beside the new one');
  const out = tool(b, 'uninstall').out;
  const left = out.slice(out.indexOf('Left in place'));
  const files = fs.readdirSync(b.claude, { recursive: true }).map((f) => path.join(b.claude, f)).filter((f) => /\.(vibequarters-backup|edited)-/.test(f));
  assert.ok(['settings.json.vibequarters-backup', 'CLAUDE.md.vibequarters-backup', 'plan.md.edited'].every((n) => files.some((f) => f.includes(n))), files.join());
  for (const f of files) assert.ok(left.includes(f), f);
  assert.match(left, /vibequarters\.salt \(the salt/);
});

test('packs: what one needs comes along, another system\'s pack is left out, every hook file exists', () => {
  assert.deepStrictEqual(L.resolvePacks(['merge-gate']), ['core', 'coordination', 'merge-gate']);
  assert.deepStrictEqual(L.resolvePacks(['windows'], 'linux'), []);
  assert.ok(!L.fullPacks('linux').includes('windows') && L.fullPacks('win32').includes('windows'));
  for (const { group } of L.hookGroups(L.fullPacks('win32'), { systemDir: path.join(L.REPO, 'system'), appDir: L.REPO })) {
    const f = (group.hooks[0].args || [group.hooks[0].command.split('"')[1]])[0];
    assert.ok(fs.existsSync(f), f);
  }
  for (const p of L.PACKS) for (const c of p.commands || []) assert.ok(fs.existsSync(path.join(L.REPO, 'system', 'commands', `${c}.md`)), c);
});

test('mod folders are appended to an existing plugin folder list with the system\'s separator', () => {
  for (const platform of ['win32', 'linux']) assert.strictEqual(L.sep(platform), platform === 'win32' ? ';' : ':');
  const { next, added } = L.addTo({ env: { [L.PLUGIN_DIRS]: '/mine' } }, { groups: [], pluginDirs: ['/sys/mods/a'], statusLine: null });
  assert.strictEqual(next.env[L.PLUGIN_DIRS], `/mine${L.sep()}/sys/mods/a`);
  assert.deepStrictEqual(L.removeFrom(next, added, '/sys'), { env: { [L.PLUGIN_DIRS]: '/mine' } });
});

test('a file that changed under the installer is refused, and a symlinked settings.json keeps its link', (t) => {
  const b = box(t, 'now');
  assert.throws(() => L.writeGuarded(b.settings, Buffer.from('new'), Buffer.from('earlier')), /changed while the installer was running/);
  assert.throws(() => L.writeGuarded(b.settings, Buffer.from('new'), null), /changed while the installer was running/);
  assert.strictEqual(fs.readFileSync(b.settings, 'utf8'), 'now');
  const bak = L.writeGuarded(b.settings, Buffer.from('new'), Buffer.from('now'));
  assert.strictEqual(fs.readFileSync(bak, 'utf8'), 'now');
  const real = path.join(b.root, 'dotfiles.json');
  fs.writeFileSync(real, 'a');
  const link = path.join(b.root, 'link.json');
  try { fs.symlinkSync(real, link); } catch (_e) { return; } // Windows without the symlink right
  L.writeGuarded(link, Buffer.from('b'), Buffer.from('a'));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(real, 'utf8'), 'b');
});

test('versions, and settings with a BOM or no content', () => {
  assert.strictEqual(L.versionOk('2.1.287 (Claude Code)'), true);
  assert.strictEqual(L.versionOk('2.1.286 (Claude Code)'), false);
  assert.strictEqual(L.versionOk('3.0.0'), true);
  assert.strictEqual(L.versionOk('unknown'), null);
  const bom = Buffer.from(`${String.fromCharCode(0xfeff)}{\n  "a": 1\n}\n`, 'utf8');
  const p = L.parseSettings(bom);
  assert.deepStrictEqual(L.printSettings(p.json, p.style), bom);
  assert.deepStrictEqual(L.parseSettings(Buffer.from('')).json, {});
});

test('the installed config never turns a hook\'s defaults off by accident', (t) => {
  const b = box(t);
  assert.strictEqual(install(b, ['--yes', '--preset', 'custom', '--packs', 'core,merge-gate,learning-loop', '--auto-evolve', 'yes']).code, 0);
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).load()))', path.join(b.sys, 'hooks', 'vibequarters-config.js')], { encoding: 'utf8', env: { ...process.env, VIBEQUARTERS_CONFIG: b.config } });
  const c = JSON.parse(r.stdout);
  assert.strictEqual(c.mergeGate.requireReview, true);
  assert.strictEqual(c.loop.autoEvolve, true);
  assert.ok(c.locks.length > 4);
});

test('an install cut off before settings.json was written is taken back by uninstall', (t) => {
  const b = box(t, USER);
  assert.strictEqual(install(b, ['--yes', '--preset', 'full']).code, 0);
  fs.writeFileSync(b.settings, USER);
  const u = tool(b, 'uninstall');
  assert.match(u.out, /nothing of VibeQuarters' is in/);
  assert.strictEqual(fs.readFileSync(b.settings, 'utf8'), USER);
  assert.ok(!fs.existsSync(b.sys));
});

test('a Monitor command, which runs in a shell, passes the same core guards', () => {
  const core = L.packById('core').hooks;
  for (const f of ['guard-bash.js', 'guard-deny-catastrophic.js', 'guard-config.js', 'guard-shell-hygiene.js']) assert.ok(core.some(([e, m, h]) => e === 'PreToolUse' && h === f && m.split('|').includes('Monitor')), f);
});
