// Tests for guard-shell-hygiene.js (inline scripts, Git Bash paths, the heavy-job gate)
// and the heavy-gate.cjs tool beside it.
// Run: node --test system/hooks/tests/guard-shell-hygiene.test.js
// Drives the hook as Claude Code does: a payload on stdin, the decision off stdout.
'use strict';
require('./helpers/config');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'guard-shell-hygiene.js');
const GATE = path.join(__dirname, '..', 'heavy-gate.cjs');
const lib = require(path.join(__dirname, '..', 'shell-hygiene-lib.js'));
const BS = String.fromCharCode(92); // one backslash, built so no layer can eat it
const BT = String.fromCharCode(96); // one backtick
const VITEST_PROC = 'node "C:/x/node_modules/vitest/vitest.mjs" run';
const PLAYWRIGHT_PROC = 'node "C:/x/node_modules/@playwright/test/cli.js" test';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-'));
}

// The environment every hook or gate run gets: a private gate folder, a pinned CPU reading,
// and a pinned process list (nothing running unless a test says so).
function env(dir, opts = {}) {
  const e = { ...process.env, VIBEQUARTERS_HEAVY_DIR: dir, VIBEQUARTERS_HEAVY_CPU: String(opts.cpu ?? 20), VIBEQUARTERS_HEAVY_PROCS: opts.procs === 'fail' ? 'fail' : JSON.stringify(opts.procs || []), VIBEQUARTERS_HEAVY_WAIT_MS: '0' };
  delete e.VIBEQUARTERS_GUARD;
  delete e.VIBEQUARTERS_HYGIENE;
  delete e.VIBEQUARTERS_HYGIENE_SKIP;
  return Object.assign(e, opts.env || {});
}

function payload(command, opts, dir) {
  return JSON.stringify({
    hook_event_name: opts.event || 'PreToolUse',
    session_id: opts.session || 'sess-a',
    tool_use_id: opts.id || 'toolu_a',
    tool_name: opts.tool || 'Bash',
    cwd: opts.cwd || dir,
    tool_input: { command, ...(opts.input || {}) },
  });
}

function decode(out, dir) {
  out = (out || '').trim();
  if (!out) return { decision: 'allow', reason: '', dir };
  const o = JSON.parse(out).hookSpecificOutput;
  // A rewrite carries updatedInput and no decision: the permission system then runs as usual.
  return { decision: o.permissionDecision || 'allow', reason: o.permissionDecisionReason || '', input: o.updatedInput, note: o.additionalContext, dir };
}

// Runs the hook. Returns { decision, reason, input (a rewritten tool_input, if any), note, dir }.
function run(command, opts = {}) {
  const dir = opts.dir || tempDir();
  const r = spawnSync(process.execPath, [GUARD], { input: opts.raw ?? payload(command, opts, dir), encoding: 'utf8', env: env(dir, opts) });
  assert.strictEqual(r.status, 0, `guard must always exit 0, got ${r.status}: ${r.stderr}`);
  return decode(r.stdout, dir);
}

const claimsDir = (dir) => path.join(dir, 'heavy-claims');
function claims(dir) {
  try {
    return fs.readdirSync(claimsDir(dir)).map((f) => JSON.parse(fs.readFileSync(path.join(claimsDir(dir), f), 'utf8')));
  } catch (_e) { return []; }
}
function plantClaim(dir, rec = {}) {
  const started = rec.started ?? Date.now();
  const c = { id: 'toolu_other', session: 'sess-b', command: 'npx playwright test', marker: 'playwright', background: false, started, until: started + 600000, ...rec };
  fs.mkdirSync(claimsDir(dir), { recursive: true });
  fs.writeFileSync(path.join(claimsDir(dir), `${c.started}-${c.id}.json`), JSON.stringify(c));
  return c;
}
const PAST_GRACE = () => Date.now() - 5 * 60000;

// ---------- inline scripts ----------

test('denies an inline node script over 5 lines, allows one of 5', () => {
  const six = `node -e '${['a', 'b', 'c', 'd', 'e', 'f'].map((v) => `const ${v} = 1;`).join('\n')}'`;
  const five = `node -e '${['a', 'b', 'c', 'd', 'e'].map((v) => `const ${v} = 1;`).join('\n')}'`;
  const r = run(six);
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /6-line inline node script/);
  assert.match(r.reason, /Write tool/);
  assert.strictEqual(run(five).decision, 'allow');
});

test('covers bun -e, node --eval/-p/--print/--eval=, python -c and deno eval', () => {
  const body = 'x\nx\nx\nx\nx\nx';
  for (const cmd of [`bun -e '${body}'`, `node --eval '${body}'`, `node -p '${body}'`, `node --print '${body}'`, `node --eval='${body}'`, `python -c '${body}'`, `python3 -c '${body}'`, `deno eval '${body}'`]) {
    assert.strictEqual(run(cmd).decision, 'deny', cmd);
  }
});

test('denies a double-quoted inline script holding what Bash rewrites: a backtick, a $NAME, a doubled backslash', () => {
  assert.strictEqual(run('node -e "console.log(`${process.pid}`)"'.replace(/`/g, BT)).decision, 'deny');
  assert.strictEqual(run('node -e "const x = $HOME"').decision, 'deny');
  assert.strictEqual(run('node -e "const x = ${HOME}"').decision, 'deny');
  assert.strictEqual(run('node -e "const x = $(pwd)"').decision, 'deny');
  assert.strictEqual(run(`node -e "console.log('x${BS}${BS}y')"`).decision, 'deny');
  const r = run('node -e "const a = `x`"'.replace(/`/g, BT));
  assert.match(r.reason, /double-quoted/);
});

test('allows short inline scripts the shell passes through untouched', () => {
  assert.strictEqual(run(`node -e "console.log(require('os').cpus().length)"`).decision, 'allow');
  assert.strictEqual(run(`node -e 'console.log("$HOME ${BS}n")'`).decision, 'allow');
  assert.strictEqual(run('node -p "1+1"').decision, 'allow');
  // a lone backslash escape, a $ that names nothing, and deliberate shell escapes arrive intact
  assert.strictEqual(run(`node -e "console.log('a${BS}nb'.split('${BS}n'))"`).decision, 'allow');
  assert.strictEqual(run(`node -e "s.replace(/${BS}u001b${BS}[[0-9;]*m/g, '')"`).decision, 'allow');
  assert.strictEqual(run('node -e "console.log(/x$/.test(s))"').decision, 'allow');
  assert.strictEqual(run(`node -e "console.log('${BS}$HOME', 'q${BS}"q')"`).decision, 'allow');
});

test('PowerShell: denies an inline script holding a double quote (5.1 strips it) or a double-quoted $', () => {
  const ps = { tool: 'PowerShell' };
  const r = run(`node -e 'console.log("hi")'`, ps);
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /PowerShell 5\.1/);
  assert.strictEqual(run('node -e "console.log($x)"', ps).decision, 'deny');
  assert.strictEqual(run(`node -e 'console.log(1)'`, ps).decision, 'allow');
  // a backslash is an ordinary character in PowerShell
  assert.strictEqual(run(`node -e "console.log('a${BS}b')"`, ps).decision, 'allow');
});

test('finds the inline script in a later statement, and ignores -e on other tools', () => {
  assert.strictEqual(run('cd /x && node -e "a$b"').decision, 'deny');
  assert.strictEqual(run('grep -e "a$" file.txt').decision, 'allow');
  assert.strictEqual(run('sed -n -e "1,$p" file.txt').decision, 'allow');
  assert.strictEqual(run('git commit -m "node -e $x"').decision, 'allow');
  assert.strictEqual(run('echo "node -e \'$x\'"').decision, 'allow');
});

test('does not read a heredoc body as commands', () => {
  assert.strictEqual(run(`cat > /tmp/note.txt <<'EOF'\nnode -e "a$b"\nnpx playwright test\nEOF\necho done`, { cpu: 99 }).decision, 'allow');
  assert.strictEqual(run(`cat <<${BS}EOF > /tmp/notes.txt\nnode -e "x=$HOME"\nEOF`).decision, 'allow', 'a backslash-quoted delimiter');
});

// The standard commit form: a heredoc inside $( ) inside double quotes. Its message holds a
// stray double quote, apostrophes and command-looking lines, all of which are only text.
test('reads a commit message passed as "$(cat <<EOF ... EOF)" as one argument, never as commands', () => {
  const a = `git commit -m "$(cat <<'EOF'\nShow the 3" label\nnode -e "$x" is gone from the docs\nEOF\n)"`;
  const b = `git commit -m "$(cat <<'EOF'\nSay "it's on" in the menu\nThat's tested.\nnpx playwright test e2e/a.spec.ts passes\nEOF\n)"`;
  for (const cmd of [a, b]) {
    const r = run(cmd, { cpu: 99 });
    assert.strictEqual(r.decision, 'allow', cmd);
    assert.strictEqual(claims(r.dir).length, 0, cmd);
    assert.strictEqual(lib.heavyReason(cmd, 'Bash', os.tmpdir()), null, cmd);
  }
  // the parser picks up again after the message: a real problem in the next statement is caught
  assert.strictEqual(run(`${b} && node -e "a$b"`).decision, 'deny');
  assert.strictEqual(lib.parse(b, 'Bash').length, 1);
});

test('PowerShell: a <# ... #> block comment is a comment', () => {
  const cmd = `<#\nnode -e "console.log($x)"\nnpx playwright test\n#>\nWrite-Output done`;
  assert.strictEqual(run(cmd, { tool: 'PowerShell', cpu: 99 }).decision, 'allow');
});

test('a long run of spaces in an inline script stays fast', () => {
  const t = Date.now();
  lib.inlineProblem(`node -e 'a${' '.repeat(50000)}b'`, 'Bash');
  lib.inlineProblem(`node -e @'\na${' '.repeat(50000)}b\n'@`, 'PowerShell');
  assert.ok(Date.now() - t < 200, `took ${Date.now() - t} ms`);
});

// ---------- Git Bash paths handed to Windows programs ----------

test('denies a Git Bash path that reaches a Windows program unconverted', () => {
  for (const cmd of [`node -e 'require("fs").readFileSync("/c/Users/x")'`, 'node check.mjs dist:/c/Users/x', `node a.mjs '{"p":"/c/Users/x"}'`, `node -e 'require("fs").writeFileSync("/tmp/x", "")'`, `MSYS2_ARG_CONV_EXCL='*' node /c/Users/x.js`, `export MSYS_NO_PATHCONV=1; npx tsx /c/Users/a.ts`, 'python3 x.py --paths=a,/c/Users/b']) {
    const r = run(cmd);
    assert.strictEqual(r.decision, 'deny', cmd);
    assert.match(r.reason, /C:\//, cmd);
  }
  assert.strictEqual(run('node /c/Users/x.js', { tool: 'PowerShell' }).decision, 'deny');
});

test('allows the Git Bash paths that are converted on the way in', () => {
  for (const cmd of ['node /c/Users/dev/x.js', 'npx tsx "/c/Users/a.ts"', 'node a.mjs --out=/c/Users/x', 'bun scripts/a.mjs /tmp/x.json', 'node a.mjs OUT=/c/Users/x']) {
    assert.strictEqual(run(cmd).decision, 'allow', cmd);
  }
});

test('allows Git Bash paths outside a Windows-program statement, and look-alikes', () => {
  assert.strictEqual(run('ls /c/Users/x; node C:/Users/x.js').decision, 'allow');
  assert.strictEqual(run('cat /c/Users/x | grep y').decision, 'allow');
  assert.strictEqual(run(`node -e 'console.log("a".replace(/a/g, "b"))'`).decision, 'allow');
  assert.strictEqual(run('wc -c /c/Users/a /c/Users/b').decision, 'allow');
  // a drive path, or a tmp folder inside a Windows path, is not a Git Bash path
  assert.strictEqual(run('node C:/tmp/x.js').decision, 'allow');
  assert.strictEqual(run('node C:/Users/x/app/tmp/y.js').decision, 'allow');
  // only programs that cannot read Git Bash paths are checked
  assert.strictEqual(run('grep -n "dist:/c/Users/x" notes.txt').decision, 'allow');
  assert.strictEqual(run('echo "see /tmp/x and dist:/c/Users/y"').decision, 'allow');
  // a path inside a $( ) or backtick command is read by the shell's own program
  assert.strictEqual(run('bunx vitest run $(cat /tmp/changed.txt | tr a b) > /tmp/out.log').decision, 'allow');
  assert.strictEqual(run('node a.mjs "$(cat /tmp/x)"').decision, 'allow');
  assert.strictEqual(run('node a.mjs $(</tmp/files.txt)').decision, 'allow');
});

test('a sentence passed to a script is text, but an inline script is still code', () => {
  assert.strictEqual(run('node scripts/notify.mjs "Report written to /tmp/report.html"').decision, 'allow');
  assert.strictEqual(run('node scripts/post.mjs --message "see /c/Users/dev/notes"').decision, 'allow');
  // the bug this check exists for: a path inside node -e code, even beside other words
  assert.strictEqual(run(`node -e 'require("fs").readFileSync("/tmp/a.txt", "utf8")'`).decision, 'deny');
});

test('an inline flag after a script file belongs to the script', () => {
  assert.strictEqual(run('node script.mjs -p "a$b"').decision, 'allow');
});

// ---------- heavy-job detection (pure) ----------

test('heavyReason flags full suites, browser runs, builds, video encodes and smoke scripts', () => {
  const heavy = [
    'npx playwright test e2e/a.spec.ts',
    'bunx vitest run',
    'npx vitest',
    'npx vitest list',
    'CI=1 node ./node_modules/vitest/vitest.mjs run',
    'node node_modules/vitest/vitest.mjs run --reporter dot',
    'bunx tsc --noEmit -p tsconfig.app.json',
    'npx tsc -b',
    'vite build',
    'npx vite build --mode development',
    'ffmpeg -i a.mp4 b.mp4',
    'node scripts/smoke-test.mjs',
    'node C:/tmp/mutate-all.cjs repo src test m.json',
    'cd /x && npm test',
    'vercel build',
    'bun test',
    'npx vercel@latest build',
    'npx -y vitest@3 run',
    'npx playwright@1.48.0 test',
    'npx vitest run --testTimeout 20000',
    'bash -c "npx vitest run"',
    'bash -lc "npx vitest run"',
    "sh -c 'bunx tsc --noEmit'",
  ];
  for (const cmd of heavy) assert.ok(lib.heavyReason(cmd, 'Bash', os.tmpdir()), cmd);
});

test('heavyReason leaves targeted runs, quick looks and look-alikes alone', () => {
  const light = [
    'npx vitest run src/a.test.ts',
    'CI=1 node ./node_modules/vitest/vitest.mjs run tests/x.test.ts src/y.test.tsx',
    'bunx vitest related src/a.ts',
    'bunx vitest run --config vitest.config.ts src/a.test.ts',
    // a bare word after run is a file-name filter, and --changed runs only what changed
    'npx vitest run billing',
    'bunx vitest run useAuth',
    'bunx vitest run --changed',
    'bunx vitest --changed origin/main',
    'bun test billing',
    'bunx tsc --noEmit --skipLibCheck --strict --module esnext api/a.ts tests/b.test.ts',
    'npx tsc --version',
    'npx tsc --init',
    'npx tsc --showConfig -p tsconfig.app.json',
    'npx playwright test --list',
    'npx playwright test --help',
    'ffmpeg -version',
    'node --check scripts/mutate-all.cjs',
    'git commit -m "bun run build and npx playwright test"',
    'echo "vitest run"',
    'grep -n "vite build" package.json',
    'node "C:/Users/dev/.claude/hooks/heavy-gate.cjs" status',
    'while ! node heavy-gate.cjs status; do sleep 30; done',
    'npx prettier --check src/a.ts',
    'npx playwright install chromium',
    // a $VAR or $( ) argument holds a file list
    'FILES=$(grep -rl x tests); bunx vitest run $FILES',
    'node ./node_modules/vitest/vitest.mjs run --silent $FILES',
    'bunx vitest related --run $FILES',
    'bunx vitest run $(git diff --name-only)',
    'bunx tsc --noEmit $CHANGED',
    // a lookup is not a run
    'command -v tsc',
    'command -V vitest',
    'bash -c "npx vitest run src/a.test.ts"',
  ];
  for (const cmd of light) assert.strictEqual(lib.heavyReason(cmd, 'Bash', os.tmpdir()), null, cmd);
});

test('heavyReason reads package.json scripts, following cd, and honors passed file args', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', browser: 'bunx playwright test', 'test:visual': 'bunx playwright test --config p.ts', build: 'tsc --noEmit && vite build', 'build:docs': 'node scripts/docs.mjs', lint: 'node scripts/lint.mjs', 'test:all': 'bun run build && bun run test:run', 'test:run': 'vitest run' } }));
  assert.ok(lib.heavyReason('bun run test', 'Bash', dir));
  assert.ok(lib.heavyReason('npm test', 'Bash', dir));
  assert.ok(lib.heavyReason('bun run test:visual', 'Bash', dir));
  assert.ok(lib.heavyReason('bun run build', 'Bash', dir));
  assert.ok(lib.heavyReason('bun run test:all', 'Bash', dir));
  assert.ok(lib.heavyReason(`cd "${dir.replace(/\\/g, '/')}" && bun run browser`, 'Bash', os.tmpdir()));
  const msysDir = dir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
  assert.ok(lib.heavyReason(`cd ${msysDir} && bun run browser`, 'Bash', os.tmpdir()));
  assert.strictEqual(lib.heavyReason('bun run browser', 'Bash', os.tmpdir()), null);
  assert.strictEqual(lib.heavyReason('bun run test src/a.test.ts', 'Bash', dir), null);
  assert.strictEqual(lib.heavyReason('bun run build:docs', 'Bash', dir), null);
  assert.strictEqual(lib.heavyReason('bun run lint', 'Bash', dir), null);
  assert.ok(lib.heavyReason('bun --filter web run build', 'Bash', dir), 'a --filter value is not the script name');
  assert.strictEqual(lib.heavyReason('bun build ./src/index.ts --outdir dist', 'Bash', dir), null, "bun's own bundler, not the build script");
  // no package.json: judged by the script name alone
  const bare = tempDir();
  assert.ok(lib.heavyReason('bun run build', 'Bash', bare));
  assert.strictEqual(lib.heavyJob('bun run build', 'Bash', bare).marker, 'run:build|any');
  assert.strictEqual(lib.heavyReason('bun run lint', 'Bash', bare), null);
  assert.strictEqual(lib.heavyReason('bun run test $FILES', 'Bash', bare), null);
  // a package.json without the script: the command fails fast, it does not run long
  const other = tempDir();
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
  assert.strictEqual(lib.heavyReason('bun run build', 'Bash', other), null);
  // a folder flag points the package manager at another package.json
  fs.mkdirSync(path.join(other, 'app'));
  fs.writeFileSync(path.join(other, 'app', 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
  for (const cmd of ['npm --prefix app run build', 'npm --prefix=app run build', 'bun --cwd app run build', 'pnpm -C app build']) assert.ok(lib.heavyReason(cmd, 'Bash', other), cmd);
  // a script that runs itself ends, it does not recurse forever
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ scripts: { loop: 'bun run loop' } }));
  assert.strictEqual(lib.heavyReason('bun run loop', 'Bash', other), null);
});

test('bun, pnpm and yarn run a tool from node_modules/.bin when no script has its name', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
  for (const cmd of ['bun tsc --noEmit', 'bun vite build', 'bun vitest run', 'bun playwright test', 'bun run tsc --noEmit', 'bun run vitest run', 'pnpm vitest run', 'yarn tsc --noEmit']) assert.ok(lib.heavyReason(cmd, 'Bash', dir), cmd);
  assert.strictEqual(lib.heavyJob('bun tsc --noEmit', 'Bash', dir).marker, 'tsc');
  // npm never falls back to a tool, bun's own commands come first, and a targeted run stays light
  for (const cmd of ['npm run tsc', 'npm vitest run', 'bun build ./src/index.ts', 'bun install', 'bun lint', 'bun run lint', 'bun vitest run src/a.test.ts']) assert.strictEqual(lib.heavyReason(cmd, 'Bash', dir), null, cmd);
});

test('a package script holds the gate for its whole run, its pre-script and later steps included', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { prebuild: 'node scripts/prepare.mjs', build: 'tsc -p tsconfig.app.json --noEmit && vite build', test: 'vitest run' } }));
  const { marker } = lib.heavyJob('bun run build', 'Bash', dir);
  assert.strictEqual(lib.markerAlive(marker, ['C:/Users/x/bun.exe run build']), true);
  assert.strictEqual(lib.markerAlive(marker, ['"C:/Users/x/bun.exe" run build']), true);
  assert.strictEqual(lib.markerAlive(marker, ['node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" run build']), true);
  assert.strictEqual(lib.markerAlive(marker, ['node "C:/x/node_modules/typescript/bin/tsc" -p tsconfig.app.json --noEmit']), true);
  assert.strictEqual(lib.markerAlive(marker, ['C:/Users/x/bun.exe run lint']), false);
  assert.strictEqual(lib.markerAlive(marker, ['C:/Users/x/bun.exe run build:sitemap']), false);
  assert.strictEqual(lib.markerAlive(lib.heavyJob('pnpm build', 'Bash', dir).marker, ['node "C:/x/pnpm/bin/pnpm.cjs" build']), true);
  assert.strictEqual(lib.markerAlive(lib.heavyJob('npm test', 'Bash', dir).marker, ['node "C:/x/npm/bin/npm-cli.js" test']), true);
  // through the hook: past start-up, only the build's own process is left, and it still holds
  const gateDir = tempDir();
  plantClaim(gateDir, { command: 'bun run build', marker, started: PAST_GRACE() });
  assert.strictEqual(run('npx vitest run', { dir: gateDir, procs: ['C:/Users/x/bun.exe run build', 'node "C:/x/node_modules/vite/bin/vite.js" build'] }).decision, 'deny');
});

test('heavyJob names the process each heavy job runs as, through package scripts too', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', browser: 'bunx playwright test' } }));
  assert.strictEqual(lib.heavyJob('bun run test', 'Bash', dir).marker, 'run:test|vitest');
  assert.strictEqual(lib.heavyJob('bun run browser', 'Bash', dir).marker, 'run:browser|playwright');
  assert.strictEqual(lib.heavyJob('bunx tsc --noEmit -p tsconfig.app.json', 'Bash', dir).marker, 'tsc');
  assert.strictEqual(lib.heavyJob('node scripts/smoke-test.mjs', 'Bash', dir).marker, 'script:smoke-test.mjs');
  assert.strictEqual(lib.heavyJob('ls', 'Bash', dir), null);
});

test('markerAlive finds the heavy tool process and ignores long-running look-alikes', () => {
  const procs = [
    'C:/Users/x/bun.exe x vitest run src/lib/a.test.ts',
    'node "C:/Users/x/node_modules/typescript/lib/tsserver.js" --useInferredProjectPerProjectRoot',
    'node C:/Users/x/AppData/Local/npm-cache/_npx/1/node_modules/@playwright/mcp/cli.js --headless',
    'node "C:/x/node_modules/vite/bin/vite.js" --host',
    'node "C:/x/node_modules/typescript/bin/tsc" -p tsconfig.app.json --noEmit',
  ];
  assert.strictEqual(lib.markerAlive('vitest', procs), true);
  assert.strictEqual(lib.markerAlive('tsc', procs), true);
  assert.strictEqual(lib.markerAlive('tsc', procs.filter((p) => !/bin.tsc/.test(p))), false, 'tsserver is not tsc');
  assert.strictEqual(lib.markerAlive('tsc', ['node build.js -p tsconfig.app.json']), false, 'a tsconfig argument is not tsc');
  // a package script judged by its name alone could be any heavy tool
  assert.strictEqual(lib.markerAlive('any', [VITEST_PROC]), true);
  assert.strictEqual(lib.markerAlive('any', ['node scripts/other.mjs']), false);
  assert.strictEqual(lib.markerAlive('playwright', procs), false, 'the Playwright MCP is not a test run');
  assert.strictEqual(lib.markerAlive('playwright', [PLAYWRIGHT_PROC]), true);
  assert.strictEqual(lib.markerAlive('vite', procs), false, 'a dev server is not a build');
  assert.strictEqual(lib.markerAlive('vite', ['node "C:/x/node_modules/vite/bin/vite.js" build']), true);
  assert.strictEqual(lib.markerAlive('script:smoke-test.mjs', ['node scripts/smoke-test.mjs --x']), true);
  assert.strictEqual(lib.markerAlive('script:smoke-test.mjs', ['node scripts/other.mjs']), false);
  // a search or a commit naming the tool is not the tool running
  assert.strictEqual(lib.markerAlive('vitest', ['C:/tools/rg.exe -n vitest src']), false);
  assert.strictEqual(lib.markerAlive('tsc', ['grep -rn "tsc" src']), false);
  assert.strictEqual(lib.markerAlive('any', ['"C:/Program Files/Git/cmd/git.exe" commit -m "fix: npx vitest run"']), false);
});

// ---------- the heavy-job gate (hook) ----------

test('lets a heavy job start on a quiet machine and claims the gate for it', () => {
  const r = run('npx playwright test e2e/a.spec.ts', { cpu: 20, id: 'toolu_1', input: { timeout: 300000 } });
  assert.strictEqual(r.decision, 'allow');
  const [c] = claims(r.dir);
  assert.strictEqual(c.id, 'toolu_1');
  assert.strictEqual(c.session, 'sess-a');
  assert.strictEqual(c.marker, 'playwright');
  assert.strictEqual(c.background, false);
  // the command's own timeout plus a minute: the most a foreground call can hold the gate
  assert.ok(c.until - c.started >= 300000 + 59000 && c.until - c.started <= 300000 + 61000);
});

test('a light command never claims the gate or samples the CPU', () => {
  const r = run('npx vitest run src/a.test.ts', { cpu: 99 });
  assert.strictEqual(r.decision, 'allow');
  assert.strictEqual(claims(r.dir).length, 0);
});

test('denies a heavy job while another one is starting, naming the holder and the wait command', () => {
  const dir = tempDir();
  plantClaim(dir, {});
  const r = run('bunx vitest run', { dir, cpu: 10, id: 'toolu_2' });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /npx playwright test/);
  assert.match(r.reason, /heavy-gate\.cjs" status/);
  assert.deepStrictEqual(claims(dir).map((c) => c.id), ['toolu_other']);
});

test('the gate waits up to VIBEQUARTERS_HEAVY_WAIT_MS for the holder to finish instead of denying at once', () => {
  const dir = tempDir();
  plantClaim(dir, { until: Date.now() + 1500 });
  const t0 = Date.now();
  const r = run('bunx vitest run', { dir, id: 'toolu_wait', env: { VIBEQUARTERS_HEAVY_WAIT_MS: '6000' } });
  assert.strictEqual(r.decision, 'allow');
  assert.ok(Date.now() - t0 >= 1000, 'it waited for the claim to end');
  assert.deepStrictEqual(claims(dir).map((c) => c.id), ['toolu_wait']);
});

test('a holder that outlasts the wait is still denied once the wait runs out', () => {
  const dir = tempDir();
  plantClaim(dir, { until: Date.now() + 60000 });
  const t0 = Date.now();
  const r = run('bunx vitest run', { dir, id: 'toolu_late', env: { VIBEQUARTERS_HEAVY_WAIT_MS: '3000' } });
  const took = Date.now() - t0;
  assert.strictEqual(r.decision, 'deny');
  assert.ok(took >= 2500 && took < 15000, `waited about 3 s, took ${took} ms`);
  assert.deepStrictEqual(claims(dir).map((c) => c.id), ['toolu_other']);
});

test('past its start-up minute, a claim holds only while its job is really running', () => {
  const dir = tempDir();
  plantClaim(dir, { started: PAST_GRACE() });
  assert.strictEqual(run('bunx vitest run', { dir, procs: [PLAYWRIGHT_PROC] }).decision, 'deny');
  // the job is gone (it finished, was killed, or was never run because another hook denied it)
  const r = run('bunx vitest run', { dir, id: 'toolu_new', procs: [VITEST_PROC.replace('vitest', 'other')] });
  assert.strictEqual(r.decision, 'allow');
  assert.deepStrictEqual(claims(dir).map((c) => c.id), ['toolu_new'], 'the dead claim is cleared');
});

test('the same session gets no exemption for a different job: one heavy job at a time', () => {
  const dir = tempDir();
  plantClaim(dir, { session: 'sess-a', id: 'toolu_first' });
  assert.strictEqual(run('bunx vitest run', { dir, id: 'toolu_second' }).decision, 'deny');
});

test('only the same tool call replaces its own claim; the same command from the same session waits', () => {
  const dir = tempDir();
  assert.strictEqual(run('npx playwright test e2e/a.spec.ts', { dir, id: 'toolu_1', input: { timeout: 600000 } }).decision, 'allow');
  // a second call while the first is starting may be a parallel call, or a subagent sharing the session id
  assert.strictEqual(run('npx playwright test e2e/a.spec.ts', { dir, id: 'toolu_2' }).decision, 'deny');
  assert.deepStrictEqual(claims(dir).map((c) => c.id), ['toolu_1']);
  // the same tool call evaluated twice is the same claim
  assert.strictEqual(run('npx playwright test e2e/a.spec.ts', { dir, id: 'toolu_1' }).decision, 'allow');
  assert.strictEqual(claims(dir).length, 1);
});

test('the same command again from the same session waits while the first run is still going', () => {
  const dir = tempDir();
  plantClaim(dir, { session: 'sess-a', command: 'bunx vitest run', marker: 'vitest', started: PAST_GRACE() });
  assert.strictEqual(run('bunx vitest run', { dir, procs: [VITEST_PROC] }).decision, 'deny');
  assert.strictEqual(run('bunx vitest run', { dir, procs: [] }).decision, 'allow');
});

test('denies a heavy job when total CPU is at or over 75%, and claims nothing', () => {
  const r = run('bunx vitest run', { cpu: 75 });
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /75%/);
  assert.strictEqual(claims(r.dir).length, 0);
  assert.strictEqual(run('bunx vitest run', { cpu: 74 }).decision, 'allow');
});

test('ignores an expired claim, a claim from the future, an impossible span and a corrupt file', () => {
  const now = Date.now();
  for (const rec of [{ started: now - 900000, until: now - 1000 }, { started: now + 2 * 3600000, until: now + 3 * 3600000 }, { started: now, until: now + 7 * 86400000 }, { background: true, started: now, until: now + 7 * 86400000 }]) {
    const dir = tempDir();
    plantClaim(dir, rec);
    assert.strictEqual(run('bunx vitest run', { dir, id: 'toolu_new', procs: [PLAYWRIGHT_PROC] }).decision, 'allow', JSON.stringify(rec));
  }
  const dir2 = tempDir();
  fs.mkdirSync(claimsDir(dir2), { recursive: true });
  fs.writeFileSync(path.join(claimsDir(dir2), '1-bad.json'), '{not json');
  assert.strictEqual(run('bunx vitest run', { dir: dir2, id: 'toolu_new2' }).decision, 'allow');
});

test('fails open when the claim folder holds something it cannot read or remove', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(claimsDir(dir), '1-stuck.json'), { recursive: true });
  const g = gate(['status'], dir);
  assert.strictEqual(g.status, 0, g.stdout);
  assert.strictEqual(run('bunx vitest run', { dir }).decision, 'allow');
  assert.strictEqual(run('bunx vitest run', { dir }).decision, 'allow', 'the same call evaluated again');
});

test('when the process list cannot be read, a claim holds until its own end, never longer', () => {
  const dir = tempDir();
  plantClaim(dir, { started: PAST_GRACE(), until: Date.now() + 60000 });
  assert.strictEqual(run('bunx vitest run', { dir, procs: 'fail' }).decision, 'deny');
  const done = tempDir();
  plantClaim(done, { started: PAST_GRACE(), until: Date.now() - 1000 });
  assert.strictEqual(run('bunx vitest run', { dir: done, procs: 'fail' }).decision, 'allow');
});

test('a background job holds while it runs, whatever the CPU, and is capped at 30 minutes', () => {
  const r = run('bunx vitest run', { id: 'toolu_bg', input: { run_in_background: true, timeout: 7200000 } });
  assert.strictEqual(r.decision, 'allow');
  const [c] = claims(r.dir);
  assert.strictEqual(c.background, true);
  assert.ok(c.until - c.started <= 1800000);
  const running = tempDir();
  plantClaim(running, { background: true, marker: 'vitest', command: 'bunx vitest run', started: PAST_GRACE(), until: Date.now() + 1500000 });
  assert.strictEqual(run('bunx tsc --noEmit -p tsconfig.app.json', { dir: running, cpu: 10, procs: [VITEST_PROC] }).decision, 'deny');
  // finished early: unrelated load on the machine does not keep it alive
  assert.strictEqual(run('bunx tsc --noEmit -p tsconfig.app.json', { dir: running, cpu: 45, procs: [] }).decision, 'allow');
});

test('two jobs racing for the gate: at most one starts', async () => {
  let rounds = 0;
  let starts = 0;
  for (let r = 0; r < 12; r++) {
    const dir = tempDir();
    plantClaim(dir, { started: Date.now() - 900000, until: Date.now() - 1000 });
    const res = await Promise.all(Array.from({ length: 6 }, (_v, k) => new Promise((done) => {
      const p = spawn(process.execPath, [GUARD], { env: env(dir) });
      let out = '';
      p.stdout.on('data', (b) => { out += b; });
      p.on('close', () => done(decode(out, dir).decision));
      p.stdin.end(payload('bunx vitest run', { session: `s${k}`, id: `t${k}` }, dir));
    })));
    const allowed = res.filter((d) => d === 'allow').length;
    assert.ok(allowed <= 1, `round ${r}: ${allowed} jobs started`);
    starts += allowed;
    rounds++;
  }
  assert.ok(starts > 0, `no job ever started in ${rounds} rounds`);
});

test('ignores PostToolUse: a claim ends when its job does, not when Claude Code says so', () => {
  const dir = tempDir();
  assert.strictEqual(run('bunx vitest run', { dir, id: 'toolu_r' }).decision, 'allow');
  const [before] = claims(dir);
  for (const event of ['PostToolUse', 'PostToolUseFailure']) {
    assert.strictEqual(run('bunx vitest run', { dir, id: 'toolu_r', event, cpu: 99 }).decision, 'allow', event);
  }
  assert.deepStrictEqual(claims(dir), [before], 'the claim is untouched');
});

test('a command denied for its inline script or path claims nothing', () => {
  const r = run(`node -e 'require("/c/Users/x")' && bunx vitest run`);
  assert.strictEqual(r.decision, 'deny');
  assert.strictEqual(claims(r.dir).length, 0);
});

test('logs every deny and every claim taken', () => {
  const r = run('bunx vitest run', { cpu: 90 });
  run('bunx vitest run', { dir: r.dir, cpu: 10 });
  const log = fs.readFileSync(path.join(r.dir, 'shell-hygiene.log'), 'utf8');
  assert.match(log, /deny heavy cpu 90% /);
  assert.match(log, /take fg cpu 10% /, 'the CPU reading survives secret masking');
});

test('keeps secrets out of the log, the claim file and the deny another session reads', () => {
  const dir = tempDir();
  run('DB_PASSWORD=hunterSECRET2 VERCEL_TOKEN=vcp_SECRET123abc npx vercel build --prod --token SECRETtok', { dir });
  run(`curl -H "Authorization: Bearer abcSECRET987" -u sk_${'live'}_SECRET42: x && node -e '${'a;\n'.repeat(6)}'`, { dir });
  const r = run('npx vitest run', { dir, session: 'sess-b', id: 'toolu_b' });
  assert.strictEqual(r.decision, 'deny');
  const seen = [r.reason, JSON.stringify(claims(dir)), fs.readFileSync(path.join(dir, 'shell-hygiene.log'), 'utf8')].join('\n');
  assert.doesNotMatch(seen, /SECRET/);
  assert.match(seen, /DB_PASSWORD=\*\*\* VERCEL_TOKEN=\*\*\* npx vercel build/);
});

// ---------- safety valves ----------

test('fails open on bad input and stays silent for other tools', () => {
  assert.strictEqual(run('', { raw: 'not json' }).decision, 'allow');
  assert.strictEqual(run('node check.mjs dist:/c/Users/x', { tool: 'Read' }).decision, 'allow');
});

test('VIBEQUARTERS_GUARD=off and VIBEQUARTERS_HYGIENE=off turn every check off; VIBEQUARTERS_HYGIENE_SKIP turns off one', () => {
  const embedded = 'node check.mjs dist:/c/Users/x';
  assert.strictEqual(run(embedded, { env: { VIBEQUARTERS_GUARD: 'off' } }).decision, 'allow');
  assert.strictEqual(run(embedded, { env: { VIBEQUARTERS_HYGIENE: 'off' } }).decision, 'allow');
  const skip = run('bunx vitest run', { cpu: 99, env: { VIBEQUARTERS_HYGIENE_SKIP: 'heavy' } });
  assert.strictEqual(skip.decision, 'allow');
  assert.strictEqual(run(embedded, { env: { VIBEQUARTERS_HYGIENE_SKIP: 'heavy' } }).decision, 'deny');
  assert.strictEqual(run(embedded, { env: { VIBEQUARTERS_HYGIENE_SKIP: 'msys' } }).decision, 'allow');
  assert.strictEqual(run('node -e "a$b"', { env: { VIBEQUARTERS_HYGIENE_SKIP: 'inline' } }).decision, 'allow');
});

// ---------- heavy-gate.cjs ----------

function gate(args, dir, cpu = 20, procs = []) {
  return spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8', env: env(dir, { cpu, procs }) });
}

test('heavy-gate status exits 0 only when a heavy job could start now', () => {
  const dir = tempDir();
  const free = gate(['status'], dir, 20);
  assert.strictEqual(free.status, 0);
  assert.match(free.stdout, /free/);
  assert.strictEqual(gate(['status'], dir, 80).status, 1);
  plantClaim(dir, {});
  const held = gate(['status'], dir, 20);
  assert.strictEqual(held.status, 1);
  assert.match(held.stdout, /npx playwright test/);
  // past start-up with its job gone, the claim no longer holds
  const gone = tempDir();
  plantClaim(gone, { started: PAST_GRACE() });
  assert.strictEqual(gate(['status'], gone, 20, [PLAYWRIGHT_PROC]).status, 1);
  assert.strictEqual(gate(['status'], gone, 20, []).status, 0);
  assert.strictEqual(claims(gone).length, 0, 'status clears the dead claim');
});

test('heavy-gate release removes every claim and says what it removed', () => {
  const dir = tempDir();
  plantClaim(dir, {});
  const r = gate(['release'], dir);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /released.*npx playwright test/);
  assert.strictEqual(claims(dir).length, 0);
  assert.match(gate(['release'], dir).stdout, /nothing/);
});

function huskyRepo(hook) {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.husky'));
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: C:/x/.git/worktrees/wt'); // a worktree's .git is a file
  fs.writeFileSync(path.join(dir, '.husky', 'pre-commit'), hook);
  fs.mkdirSync(path.join(dir, 'src'));
  return dir;
}
const TSC_HOOK = '#!/usr/bin/env sh\nbunx lint-staged\nif ! bunx tsc --noEmit -p tsconfig.app.json 2>/tmp/x.log; then echo advisory; fi\n';
const winGit = (bin, rest) => `"C:${BS}Program Files${BS}Git${BS}${bin}${BS}git.exe" ${rest}`;

test('git commit counts as heavy where the pre-commit hook type-checks the project', () => {
  const dir = huskyRepo(TSC_HOOK);
  const unix = dir.replace(/\\/g, '/');
  for (const cmd of [
    'git commit -m "x"',
    'git commit -m "add y" -- a.ts b.ts',
    'git commit --amend --no-edit',
    'cd src && git commit -m x',
  ]) assert.ok(lib.heavyReason(cmd, 'Bash', dir), cmd);
  assert.ok(lib.heavyReason(`git -C "${unix}" commit -m x`, 'Bash', os.tmpdir()), '-C names the repo');
  assert.ok(lib.heavyReason(`cd "${unix}" && git add a.ts && git commit -m x`, 'Bash', os.tmpdir()));
  assert.strictEqual(lib.heavyJob('git commit -m x', 'Bash', dir).marker, 'git-commit');
});

test('git commit is light with no type-check hook or with the hook skipped, like every other git command', () => {
  const dir = huskyRepo(TSC_HOOK);
  for (const cmd of ['git commit --no-verify -m x', 'git commit -n -m x', 'git commit --dry-run', 'git commit -h', 'git status', 'git log --grep commit', 'git commit-tree HEAD^{tree}', 'git show commit', 'git stash push -m commit', 'rg "git commit"', 'echo git commit']) assert.strictEqual(lib.heavyReason(cmd, 'Bash', dir), null, cmd);
  const plain = huskyRepo('#!/usr/bin/env sh\nbunx lint-staged\n');
  assert.strictEqual(lib.heavyReason('git commit -m x', 'Bash', plain), null, 'no tsc in the hook');
  assert.strictEqual(lib.heavyReason('git commit -m x', 'Bash', tempDir()), null, 'no repo, no hook');
});

test('a commit holds the gate while its git process runs, never on a look-alike', () => {
  const real = winGit('mingw64' + BS + 'bin', 'commit -m "add b" -- src/b.ts');
  assert.strictEqual(lib.markerAlive('git-commit', [real]), true, 'a git.exe command line counts as git');
  assert.strictEqual(lib.markerAlive('git-commit', [winGit('cmd', 'commit -m x')]), true);
  assert.strictEqual(lib.markerAlive('git-commit', ['git.exe log --grep commit', winGit('cmd', 'commit-tree abc'), 'rg.exe "git commit"', 'node x.js git commit']), false);
});

test('a second commit waits while the first one runs', () => {
  const dir = tempDir();
  const repo = huskyRepo(TSC_HOOK);
  plantClaim(dir, { command: 'git commit -m first', marker: 'git-commit', started: PAST_GRACE() });
  const r = run('git commit -m second', { dir, cwd: repo, procs: [winGit('cmd', 'commit -m first')] });
  assert.strictEqual(r.decision, 'deny', JSON.stringify(r));
  const free = tempDir();
  assert.strictEqual(run('git commit -m second', { dir: free, cwd: repo }).decision, 'allow', 'nothing running: it starts');
});

test('the deny names a gate command that exists beside the hook', () => {
  const dir = tempDir();
  plantClaim(dir, {});
  const r = run('bunx vitest run', { dir });
  const m = r.reason.match(/until node "([^"]+)" status/);
  assert.ok(m, r.reason);
  assert.ok(fs.existsSync(m[1]), m[1]);
});

// ---------- jq ----------

function jqEnv(present) {
  const d = tempDir();
  if (present) fs.writeFileSync(path.join(d, 'jq.exe'), '');
  return { VIBEQUARTERS_JQ_PATH: d };
}

test('a bare jq is denied while jq is not installed, and the reason gives the gh --jq fix', () => {
  for (const cmd of [
    'gh api repos/x/y | jq .name',
    'curl -s https://x.test/a | jq -r .a',
    'x=$(gh pr view 1 --json state | jq -r .state); echo $x',
    'echo "state: $(gh pr view 1 --json state | jq -r .state)"',
    `s=${BT}gh pr view 1 --json state | jq .state${BT}`,
    'jq . file.json',
    'echo {} | xargs jq .',
    'bash -c "gh api x | jq .y"',
  ]) {
    const r = run(cmd, { env: jqEnv(false) });
    assert.strictEqual(r.decision, 'deny', cmd);
    assert.match(r.reason, /--jq/, cmd);
  }
  assert.strictEqual(run('gh api x | jq .name', { tool: 'PowerShell', env: jqEnv(false) }).decision, 'deny', 'PowerShell');
});

test('gh --jq, jq as text, a jq lookup and a script being written stay allowed', () => {
  for (const cmd of [
    "gh pr view 1 --json state --jq '.state'",
    `gh api x --jq '.[] | select(.name=="jq")'`,
    'grep -c jq notes.txt',
    'echo "pipe it to jq"',
    "echo '$(jq .x)'",
    'command -v jq',
    'which jq',
    "cat > /tmp/w.sh <<'EOF'\ncurl x | jq .y\nEOF",
  ]) assert.strictEqual(run(cmd, { env: jqEnv(false) }).decision, 'allow', cmd);
});

test('a bare jq is allowed once jq is installed, or with VIBEQUARTERS_HYGIENE_SKIP=jq', () => {
  assert.strictEqual(run('gh api x | jq .name', { env: jqEnv(true) }).decision, 'allow');
  assert.strictEqual(run('gh api x | jq .name', { env: { ...jqEnv(false), VIBEQUARTERS_HYGIENE_SKIP: 'jq' } }).decision, 'allow');
});

test('a script that pipes to jq is denied by name; a clean or missing script runs', () => {
  const d = tempDir();
  fs.writeFileSync(path.join(d, 'watch.sh'), 'while true; do\n  s=$(gh pr view "$1" --json state | jq -r .state)\n  sleep 30\ndone\n');
  fs.writeFileSync(path.join(d, 'clean.sh'), 'gh pr view "$1" --json state --jq .state\n');
  const fwd = d.split(BS).join('/');
  const r = run(`bash "${fwd}/watch.sh" 7`, { env: jqEnv(false) });
  assert.strictEqual(r.decision, 'deny', JSON.stringify(r));
  assert.match(r.reason, /watch\.sh/);
  assert.strictEqual(run('bash watch.sh 7', { cwd: d, env: jqEnv(false) }).decision, 'deny', 'relative to cwd');
  assert.strictEqual(run(`bash "${fwd}/clean.sh" 7`, { env: jqEnv(false) }).decision, 'allow');
  assert.strictEqual(run('bash missing.sh', { cwd: d, env: jqEnv(false) }).decision, 'allow', 'no file, no verdict');
});

test('a Monitor command gets the jq check and no other', () => {
  assert.strictEqual(run('gh api x | jq .name', { tool: 'Monitor', env: jqEnv(false) }).decision, 'deny');
  const dir = tempDir();
  plantClaim(dir, {});
  assert.strictEqual(run('bunx vitest run', { tool: 'Monitor', dir, env: jqEnv(false) }).decision, 'allow', 'no heavy gate on a Monitor');
  assert.strictEqual(run("gh pr checks 1 --json name --jq '.[].name'", { tool: 'Monitor', env: jqEnv(false) }).decision, 'allow');
});

// ---------- the session folder ----------

test('a cd followed by more commands is put in parentheses, (cd <dir> && ...)', () => {
  for (const cmd of [
    'cd C:/Users/x/wt-a && git status',
    'cd /c/Users/x; npm run lint',
    'git status && cd C:/Users/x',
    'cd C:/Users/x\nls',
    '{ cd C:/Users/x; ls; }',
    '[ -d C:/x ] && cd C:/x',
    'cd C:/x && git log # a trailing comment',
  ]) {
    const r = run(cmd, { input: { timeout: 5000, description: 'd' } });
    assert.strictEqual(r.decision, 'allow', cmd);
    assert.ok(r.input, `a rewrite for ${cmd}`);
    assert.strictEqual(r.input.command, `(\n${cmd}\n)`, cmd);
    assert.strictEqual(r.input.timeout, 5000, 'the rest of the tool input is kept');
    assert.strictEqual(r.input.description, 'd');
    assert.match(r.note, /subshell/, 'Claude is told its folder did not move');
    assert.strictEqual(run(r.input.command).input, undefined, 'the rewritten command passes untouched');
  }
});

test('a chained cd whose parentheses do not balance is denied, not wrapped: bash would reject part of it', () => {
  for (const cmd of ['cd C:/x && echo a)', 'cd C:/x && (ls', 'cd C:/x && ls) && (pwd', 'cd C:/x && echo $(pwd']) {
    const r = run(cmd);
    assert.strictEqual(r.decision, 'deny', cmd);
    assert.strictEqual(r.input, undefined, cmd);
    assert.match(r.reason, /chained with other commands/, cmd);
  }
  for (const cmd of ['cd C:/x && echo "a)"', "cd C:/x && echo 'a('", 'cd C:/x && echo a\\)']) {
    assert.strictEqual(run(cmd).input.command, `(\n${cmd}\n)`, `quoted or escaped parens balance: ${cmd}`);
  }
});

test('a lone cd, a cd inside a subshell or $( ), and cd as text stay allowed', () => {
  for (const cmd of [
    'cd C:/Users/x/wt-a',
    'cd "/c/Users/x y"',
    'cd C:/x # back to my worktree',
    '(cd C:/x && make) && ls',
    'echo "$(cd C:/x && pwd)"',
    'git -C C:/x status && ls',
    'echo cd x && ls',
  ]) assert.strictEqual(run(cmd).decision, 'allow', cmd);
  assert.strictEqual(run('cd C:/x; git status', { tool: 'PowerShell' }).decision, 'allow', 'PowerShell is out of scope');
});

test('an output redirect to a relative path is denied, naming the target', () => {
  for (const [cmd, target] of [
    ['echo x > out.txt', 'out.txt'],
    ['ls >> logs/a.log', 'logs/a.log'],
    ['node C:/x/a.js 2> err.txt', 'err.txt'],
    ["cat > ./notes.md <<'EOF'\nhi\nEOF", './notes.md'],
    ['npm run lint &> run.log', 'run.log'],
    ['(echo x > "y z.txt")', 'y z.txt'],
  ]) {
    const r = run(cmd);
    assert.strictEqual(r.decision, 'deny', cmd);
    assert.ok(r.reason.includes(`writes to ${target},`), r.reason);
    assert.match(r.reason, /absolute path/);
    assert.match(r.reason, /The user can turn this check off: "VIBEQUARTERS_HYGIENE_SKIP": "cwd" under "env" in ~\/\.claude\/settings\.json/);
  }
});

test('absolute, variable and null-device redirects, input redirects and quoted text stay allowed', () => {
  for (const cmd of [
    'ls > /dev/null 2>&1',
    'ls 2>/dev/null',
    'echo x >&2',
    'node x.js 2>&-',
    'echo x > C:/Users/x/out.txt',
    'echo x > "C:/Users/x y/out.txt"',
    'echo x > "$S/out.txt"',
    'echo x > $(pwd)/out.txt',
    'echo x >> ~/notes.txt',
    'echo x > /tmp/out.txt',
    'echo x > NUL',
    'wc -l < input.txt',
    'cat <<< "hello"',
    'echo "a > b.txt"',
  ]) assert.strictEqual(run(cmd).decision, 'allow', cmd);
  assert.strictEqual(run('ls > out.txt', { tool: 'PowerShell' }).decision, 'allow', 'PowerShell is out of scope');
});

test('a denied redirect claims nothing at the heavy gate', () => {
  const r = run('bunx vitest run > out.txt');
  assert.strictEqual(r.decision, 'deny');
  assert.strictEqual(claims(r.dir).length, 0);
});

test('an sbp_ token, an inline script, a path, a redirect, jq and the heavy gate still deny, cd or no cd', () => {
  for (const [cmd, why, opts] of [
    [`cd C:/x && curl -H "Authorization: Bearer ${SBP}" https://api.supabase.com`, /access-token/],
    [`cd C:/x && node -e "a$b"`, /inline script/],
    ['cd C:/x && node check.mjs dist:/c/Users/x', /Git Bash path/],
    ['cd C:/x && echo x > out.txt', /relative to the shell/],
    ['cd C:/x && gh api x | jq .a', /jq/, { env: jqEnv(false) }],
    ['cd C:/x && bunx vitest run', /heavy-job gate/, { cpu: 90 }],
    ['git fetch && git show origin/main:.github/x', /MSYS2_ARG_CONV_EXCL/, { env: NO_EXCL }],
  ]) {
    const r = run(cmd, opts);
    assert.strictEqual(r.decision, 'deny', cmd);
    assert.match(r.reason, why, cmd);
    assert.strictEqual(r.input, undefined, 'a deny rewrites nothing');
  }
});

// ---------- Supabase tokens ----------

const SBP = `sbp_${'0123456789abcdef'.repeat(2)}01234567`; // the 40-hex shape of a real token, made up

test('a Supabase access token in a Bash or PowerShell command is denied and never repeated', () => {
  const dir = tempDir();
  for (const [cmd, tool] of [
    [`curl -H "Authorization: Bearer ${SBP}" https://api.supabase.com/v1/projects`, 'Bash'],
    [`SUPABASE_ACCESS_TOKEN=${SBP} supabase projects list`, 'Bash'],
    [`supabase login --token sbp_v0_${SBP.slice(4)}`, 'Bash'],
    [`$env:SUPABASE_ACCESS_TOKEN = '${SBP}'; supabase projects list`, 'PowerShell'],
  ]) {
    const r = run(cmd, { dir, tool });
    assert.strictEqual(r.decision, 'deny', cmd);
    assert.match(r.reason, /~\/\.supabase\/access-token/);
    assert.ok(!r.reason.includes(SBP.slice(4)), 'the deny never repeats the token');
  }
  assert.ok(!fs.readFileSync(path.join(dir, 'shell-hygiene.log'), 'utf8').includes(SBP.slice(4)), 'nor does the log');
});

test('a token-free command, the token file and the bare prefix stay allowed', () => {
  for (const cmd of [
    'curl -H "Authorization: Bearer $(cat ~/.supabase/access-token)" https://api.supabase.com/v1/projects',
    'grep -c sbp_ C:/x/notes.md',
    'echo sbp_short',
  ]) assert.strictEqual(run(cmd).decision, 'allow', cmd);
});

// ---------- git <ref>:<path> ----------

const NO_EXCL = { MSYS2_ARG_CONV_EXCL: '', MSYS_NO_PATHCONV: '' };

test("git <ref>:<path> is run with path conversion off", () => {
  for (const cmd of [
    'git show origin/main:.github/workflows/ci.yml',
    'git -C C:/x show origin/main:.husky/pre-push',
    'git show origin/feat/a:.env | head -5',
  ]) {
    const r = run(cmd, { env: NO_EXCL, input: { description: 'd' } });
    assert.strictEqual(r.decision, 'allow', cmd);
    assert.ok(r.input, `a rewrite for ${cmd}`);
    assert.strictEqual(r.input.command, `MSYS2_ARG_CONV_EXCL='*' ${cmd}`, cmd);
    assert.strictEqual(r.input.description, 'd', 'the rest of the tool input is kept');
    assert.strictEqual(run(r.input.command, { env: NO_EXCL }).input, undefined, 'the rewritten command passes untouched');
  }
});

test('a git ref:path the prefix cannot fix plainly is still denied with the fix', () => {
  for (const cmd of [
    'git cat-file -p origin/main:/src/a.ts', // the leading / has to go too
    'git fetch && git show origin/main:.github/x', // a prefix on the line would reach git fetch only
    'ls && git show origin/main:.env',
    'git -C /c/Users/x show origin/main:.github/y', // the prefix would stop /c/Users/x converting too
    'git show origin/main:.github/x && git show origin/main:.env', // the prefix reaches the first git call only
    'git show origin/main:.github/x; git diff origin/main:.env HEAD:.env',
  ]) {
    const r = run(cmd, { env: NO_EXCL });
    assert.strictEqual(r.decision, 'deny', cmd);
    assert.match(r.reason, /MSYS2_ARG_CONV_EXCL='\*' git show/);
  }
});

test('ref:path forms that arrive whole, or with conversion off, stay allowed', () => {
  for (const cmd of [
    'git show origin/main:src/a.ts',
    'git show origin/main:supabase/functions/_shared/x.ts',
    'git show HEAD:.github/workflows/ci.yml',
    'git show abc1234:.github/workflows/ci.yml',
    'git show origin/main:./.github/workflows/ci.yml',
    'git show origin/main:../x',
    "MSYS2_ARG_CONV_EXCL='*' git show origin/main:.github/workflows/ci.yml",
    "export MSYS2_ARG_CONV_EXCL='*'; git show origin/main:.github/workflows/ci.yml",
    'echo origin/main:.github/x',
  ]) assert.strictEqual(run(cmd, { env: NO_EXCL }).decision, 'allow', cmd);
  assert.strictEqual(run('git show origin/main:.github/x', { tool: 'PowerShell', env: NO_EXCL }).decision, 'allow', 'PowerShell converts nothing');
  assert.strictEqual(run('git show origin/main:.github/x', { env: { MSYS2_ARG_CONV_EXCL: '*' } }).decision, 'allow', 'set for the whole session');
});

test('VIBEQUARTERS_HYGIENE_SKIP turns off cwd, token and gitpath one by one', () => {
  assert.deepStrictEqual(run('cd C:/x && ls', { env: { VIBEQUARTERS_HYGIENE_SKIP: 'cwd' } }).input, undefined);
  assert.strictEqual(run('echo x > out.txt', { env: { VIBEQUARTERS_HYGIENE_SKIP: 'cwd' } }).decision, 'allow');
  assert.strictEqual(run(`echo ${SBP}`, { env: { VIBEQUARTERS_HYGIENE_SKIP: 'token' } }).decision, 'allow');
  assert.strictEqual(run('git show origin/main:.env', { env: { ...NO_EXCL, VIBEQUARTERS_HYGIENE_SKIP: 'gitpath' } }).input, undefined);
  assert.strictEqual(run('cd C:/x && ls', { env: { VIBEQUARTERS_HYGIENE_SKIP: 'token,gitpath' } }).input.command, '(\ncd C:/x && ls\n)', 'the others stay on');
});

// ---------- the heavy-job gate frees a denied call ----------

const batch = (calls, session = 'sess-a') => JSON.stringify({ hook_event_name: 'PostToolBatch', session_id: session, tool_calls: calls });
const HOOK_DENY = 'PreToolUse:Bash hook error: denied by another guard';
const BG_STARTED = 'Command running in background with ID: b1a2b3c4d. Output is being written to: C:\\Users\\x\\tasks\\b1a2b3c4d.output. You will be notified when it completes';

test('a heavy call another hook denied frees the gate as soon as its batch resolves', () => {
  const dir = tempDir();
  // the process list cannot be read, so without the release the claim would hold until its own end
  assert.strictEqual(run('bunx vitest run', { dir, id: 'toolu_d', procs: 'fail' }).decision, 'allow');
  assert.strictEqual(run('npx playwright test', { dir, id: 'toolu_next', procs: 'fail' }).decision, 'deny', 'the claim holds the gate');
  run('', { dir, procs: 'fail', raw: batch([{ tool_name: 'Bash', tool_use_id: 'toolu_d', tool_input: { command: 'bunx vitest run' }, tool_response: HOOK_DENY }]) });
  assert.strictEqual(claims(dir).length, 0, 'the denied call holds nothing');
  assert.match(fs.readFileSync(path.join(dir, 'shell-hygiene.log'), 'utf8'), /release PostToolBatch sess-a bunx vitest run/);
  assert.strictEqual(run('npx playwright test', { dir, id: 'toolu_next', procs: 'fail' }).decision, 'allow');
});

test('an auto-mode deny (PermissionDenied) frees its claim; a finished foreground call frees its claim', () => {
  const dir = tempDir();
  run('bunx vitest run', { dir, id: 'toolu_p', procs: 'fail' });
  run('', { dir, procs: 'fail', raw: JSON.stringify({ hook_event_name: 'PermissionDenied', session_id: 'sess-a', tool_name: 'Bash', tool_use_id: 'toolu_p', tool_input: { command: 'bunx vitest run' }, reason: 'auto mode' }) });
  assert.strictEqual(claims(dir).length, 0);
  run('bunx vitest run', { dir, id: 'toolu_f', procs: 'fail' });
  run('', { dir, procs: 'fail', raw: batch([{ tool_name: 'Bash', tool_use_id: 'toolu_f', tool_response: 'ok' }]) });
  assert.strictEqual(claims(dir).length, 0);
  run('bunx vitest run', { dir, id: 'toolu_bgd', procs: 'fail', input: { run_in_background: true } });
  run('', { dir, procs: 'fail', raw: batch([{ tool_name: 'Bash', tool_use_id: 'toolu_bgd', tool_input: { command: 'bunx vitest run', run_in_background: true }, tool_response: HOOK_DENY }]) });
  assert.strictEqual(claims(dir).length, 0, 'a denied background call never ran either');
});

test('negative controls: a running background job and other calls keep their claims', () => {
  const dir = tempDir();
  run('bunx vitest run', { dir, id: 'toolu_bg', procs: 'fail', input: { run_in_background: true } });
  run('npx playwright test', { dir, id: 'toolu_x', procs: 'fail', cpu: 10 }); // denied by the gate itself: no claim
  run('', { dir, procs: 'fail', raw: batch([
    { tool_name: 'Bash', tool_use_id: 'toolu_bg', tool_input: { command: 'bunx vitest run', run_in_background: true }, tool_response: BG_STARTED },
    { tool_name: 'Read', tool_use_id: 'toolu_other_call', tool_response: 'file text' },
  ]) });
  assert.deepStrictEqual(claims(dir).map((c) => c.id), ['toolu_bg'], 'the background job still holds the gate');
  run('', { dir, procs: 'fail', raw: batch([{ tool_name: 'Bash', tool_use_id: 'toolu_bg', tool_response: { stdout: '', stderr: '', backgroundTaskId: 'b123' } }]) });
  assert.deepStrictEqual(claims(dir).map((c) => c.id), ['toolu_bg'], 'the object form of a started job keeps it too');
  run('', { dir, procs: 'fail', raw: batch([]) });
  run('', { dir, procs: 'fail', raw: JSON.stringify({ hook_event_name: 'PostToolBatch' }) });
  assert.deepStrictEqual(claims(dir).map((c) => c.id), ['toolu_bg'], 'an empty or odd batch changes nothing');
});

// ---------- known pitfalls (a note, never a block) ----------

const DASH_GREP = `grep -P '${BS}x{2014}' C:/x/a.md`;

test('pitfallNote names the three known pitfalls', () => {
  assert.strictEqual(lib.pitfallNote(DASH_GREP, 'Bash').tag, 'dash-grep');
  assert.strictEqual(lib.pitfallNote(`grep -cP '[${BS}x{2013}]' C:/x/a.md`, 'Bash').tag, 'dash-grep', 'a -P inside a flag cluster');
  assert.strictEqual(lib.pitfallNote('bunx vitest run --reporter=basic', 'Bash').tag, 'vitest-basic');
  assert.strictEqual(lib.pitfallNote('node --test tests/a.test.js | grep "# tests"', 'Bash').tag, 'node-test-grep');
});

test('pitfallNote leaves the working forms and look-alikes alone', () => {
  for (const cmd of [
    'grep -P "foo" C:/x/a.md',
    `grep -E "${BS}x41" C:/x/a.md`,
    'bunx vitest run',
    'bunx vitest run --reporter=dot',
    "node --test tests/a.test.js | grep -E '(tests|pass|fail) [0-9]+$'",
    `echo grep -P ${BS}x{2014}`,
  ]) assert.strictEqual(lib.pitfallNote(cmd, 'Bash'), null, cmd);
});

test('pitfallNote reads past statements that run no program: a brace, an assignment, command -v', () => {
  for (const cmd of ['{ ls; }', 'FOO=1', 'command -v jq']) assert.strictEqual(lib.pitfallNote(cmd, 'Bash'), null, cmd);
  assert.strictEqual(lib.pitfallNote(`{ ${DASH_GREP}; }`, 'Bash').tag, 'dash-grep', 'a pitfall inside a brace group');
  assert.strictEqual(lib.pitfallNote(`FOO=1; ${DASH_GREP}`, 'Bash').tag, 'dash-grep', 'a pitfall after an assignment');
  for (const cmd of ['cd C:/x && command -v jq', 'cd C:/x && FOO=1']) {
    assert.strictEqual(run(cmd).input.command, `(\n${cmd}\n)`, `the pitfall check never costs the cd rewrite: ${cmd}`);
  }
});

test('a known pitfall runs with a note and no rewrite', () => {
  const r = run(DASH_GREP);
  assert.strictEqual(r.decision, 'allow');
  assert.strictEqual(r.input, undefined, 'the command is not changed');
  assert.match(r.note, /known pitfall, not a block/);
  assert.match(r.note, /VIBEQUARTERS_HYGIENE_SKIP=pitfall/);
});

test('a pitfall in a rewritten command joins the rewrite: one JSON object carries both notes', () => {
  const cmd = `cd C:/x && ${DASH_GREP}`;
  const r = run(cmd); // decode parses stdout as one JSON object, so two objects would throw here
  assert.strictEqual(r.input.command, `(\n${cmd}\n)`);
  assert.match(r.note, /subshell/);
  assert.match(r.note, /known pitfall, not a block/);
});

test('a deny still wins over a pitfall note, and VIBEQUARTERS_HYGIENE_SKIP=pitfall turns the note off', () => {
  const d = run(`${DASH_GREP} > out.txt`);
  assert.strictEqual(d.decision, 'deny');
  assert.match(d.reason, /redirect/);
  assert.strictEqual(run(DASH_GREP, { env: { VIBEQUARTERS_HYGIENE_SKIP: 'pitfall' } }).note, undefined);
  assert.strictEqual(run(`cd C:/x && ${DASH_GREP}`, { env: { VIBEQUARTERS_HYGIENE_SKIP: 'pitfall' } }).note.includes('known pitfall'), false);
});
