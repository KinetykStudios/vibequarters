// lib/hear.js: one phrase of the owner's voice, as a WAV, turned into words by whisper.cpp on this computer, for a
// browser that has no speech recognition behind it. The audio stays here: a temp folder that goes when the run ends.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { hear } = require("../lib/hear");

const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(40)]);

const EXE = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
// a whisper.cpp folder (assistant.whisperDir) with the program and the model in it; `home` is that folder
function installed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hear-test-"));
  fs.writeFileSync(path.join(dir, EXE), "");
  fs.writeFileSync(path.join(dir, "ggml-base.en.bin"), "");
  return { home: dir, dir };
}

test("hear: what is not a WAV is refused and nothing runs", async () => {
  const { home } = installed();
  let ran = 0;
  const r = await hear({ wav: Buffer.from("not audio at all, and long enough to pass a size check for sure, yes"), whisperDir: home, env: {}, run: () => ran++ });
  assert.deepEqual(r, { ok: false, status: 400, error: "not a WAV" });
  assert.equal(ran, 0);
});

test("hear: with no whisper.cpp folder set, hearing is off and nothing runs", async () => {
  let ran = 0;
  const r = await hear({ wav: WAV, env: {}, run: () => ran++ });
  assert.deepEqual(r, { ok: false, status: 503, error: "hearing off: no whisper.cpp folder set" });
  assert.equal(ran, 0);
});

test("hear: the VIBEQUARTERS_WHISPER_DIR environment variable names the folder when the config does not", async () => {
  const { dir } = installed();
  let exe = null;
  const r = await hear({ wav: WAV, env: { VIBEQUARTERS_WHISPER_DIR: dir }, run: (e, a, o, done) => { exe = e; done(null, "hi"); } });
  assert.deepEqual(r, { ok: true, text: "hi" });
  assert.equal(exe, path.join(dir, EXE));
});

test("hear: with whisper.cpp not installed it says so and nothing runs", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hear-test-"));
  let ran = 0;
  const r = await hear({ wav: WAV, whisperDir: home, env: {}, run: () => ran++ });
  assert.deepEqual(r, { ok: false, status: 503, error: "hearing off: whisper.cpp is not installed" });
  assert.equal(ran, 0);
});

test("hear: runs whisper on the phrase, returns only the spoken words, and the audio is gone afterward", async () => {
  const { home, dir } = installed();
  let seen = null;
  const r = await hear({
    wav: WAV,
    whisperDir: home, env: {},
    run: (exe, args, opts, done) => {
      const file = args[args.indexOf("-f") + 1];
      seen = { exe, args, file, bytes: fs.readFileSync(file), hidden: opts.windowsHide };
      done(null, " [BLANK_AUDIO]\n Hello there. (wind blowing)\n Run the tests.\n");
    },
  });
  assert.deepEqual(r, { ok: true, text: "Hello there. Run the tests." });
  assert.equal(seen.exe, path.join(dir, EXE));
  assert.equal(seen.args[seen.args.indexOf("-m") + 1], path.join(dir, "ggml-base.en.bin"));
  assert.equal(seen.args[seen.args.indexOf("-l") + 1], "en");
  assert.equal(seen.args[seen.args.indexOf("-bs") + 1], "1", "its first best guess, since the owner is waiting");
  assert.ok(seen.bytes.equals(WAV), "the phrase's own bytes");
  assert.equal(seen.hidden, true, "no window pops up");
  assert.equal(fs.existsSync(seen.file), false, "the temp audio is gone");
  assert.equal(fs.existsSync(path.dirname(seen.file)), false, "its folder too");
});

test("hear: nothing but sound marks is empty words, not an error", async () => {
  const { home } = installed();
  const r = await hear({ wav: WAV, whisperDir: home, env: {}, run: (e, a, o, done) => done(null, " [BLANK_AUDIO]\n") });
  assert.deepEqual(r, { ok: true, text: "" });
});

test("hear: a failed run says only that it failed, and the audio is gone", async () => {
  const { home } = installed();
  let file = null;
  const r = await hear({
    wav: WAV,
    whisperDir: home, env: {},
    run: (e, args, o, done) => {
      file = args[args.indexOf("-f") + 1];
      done(new Error("secret path C:/somewhere"));
    },
  });
  assert.deepEqual(r, { ok: false, status: 502, error: "hearing failed" });
  assert.equal(fs.existsSync(file), false);
});

// A virus scanner can hold the file for a moment, and Node's remove then throws (EPERM on a held file). Thrown past
// hear, nothing catches it: the server dies, and every phrase after it fails.
test("hear: a voice file Windows keeps locked cannot stop HQ: the owner's words still come back, and the next phrase runs", async () => {
  const { home } = installed();
  const locked = () => Object.assign(new Error("EPERM: operation not permitted, rm"), { code: "EPERM" });
  const realRm = fs.promises.rm, realRmSync = fs.rmSync;
  test.mock.method(fs.promises, "rm", async (p, o) => { await realRm(p, o); throw locked(); }, { times: 1 });
  test.mock.method(fs, "rmSync", (p, o) => { realRmSync(p, o); throw locked(); }, { times: 1 });
  let ran = 0;
  const run = (e, a, o, done) => { ran++; done(null, "hello there"); };
  assert.deepEqual(await hear({ wav: WAV, whisperDir: home, env: {}, run }), { ok: true, text: "hello there" });
  assert.deepEqual(await hear({ wav: WAV, whisperDir: home, env: {}, run }), { ok: true, text: "hello there" });
  assert.equal(ran, 2);
  test.mock.restoreAll();
});

test("hear: no room for the temp folder is a failed read, and the next phrase runs", async () => {
  const { home } = installed();
  test.mock.method(fs, "mkdtempSync", () => { throw new Error("ENOSPC"); }, { times: 1 });
  const run = (e, a, o, done) => done(null, "hello there");
  assert.deepEqual(await hear({ wav: WAV, whisperDir: home, env: {}, run }), { ok: false, status: 502, error: "hearing failed" });
  assert.deepEqual(await hear({ wav: WAV, whisperDir: home, env: {}, run }), { ok: true, text: "hello there" });
  test.mock.restoreAll();
});

test("hear: audio a lock or a dying server left behind goes with the next phrase, and a run under way keeps its own", async () => {
  const { home } = installed();
  const left = (ageMs) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-hear-test-"));
    fs.writeFileSync(path.join(dir, "phrase.wav"), "x");
    const then = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, then, then);
    return dir;
  };
  const old = left(10 * 60e3), fresh = left(5e3);
  // one look at a time: a look already under way may have listed the folder before these were left, so a later phrase
  // takes them
  for (let i = 0; i < 400 && fs.existsSync(old); i++) {
    await hear({ wav: WAV, whisperDir: home, env: {}, run: (e, a, o, done) => done(null, "x") });
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(fs.existsSync(old), false, "nobody's, so it goes");
  assert.equal(fs.existsSync(fresh), true, "it could be another run's");
  fs.rmSync(fresh, { recursive: true, force: true });
});

// A temp folder can hold very many items and be slow to list, which no read may wait for
test("hear: a read does not wait for the look through the temp folder", async () => {
  const { home } = installed();
  let release;
  const held = new Promise((r) => { release = r; });
  const realReaddir = fs.promises.readdir;
  test.mock.method(fs.promises, "readdir", async (...a) => { await held; return realReaddir(...a); });
  const run = (e, a, o, done) => done(null, "hello");
  const reply = await Promise.race([hear({ wav: WAV, whisperDir: home, env: {}, run }), new Promise((r) => setTimeout(() => r("stuck"), 2000))]);
  assert.deepEqual(reply, { ok: true, text: "hello" });
  const next = await Promise.race([hear({ wav: WAV, whisperDir: home, env: {}, run }), new Promise((r) => setTimeout(() => r("stuck"), 2000))]);
  assert.deepEqual(next, { ok: true, text: "hello" }, "and neither does the next one");
  release();
  test.mock.restoreAll();
});

test("hear: a read the page took back while it waited never runs, and the next one goes", async () => {
  const { home } = installed();
  const dones = [];
  const run = (e, a, o, done) => dones.push(done);
  const first = hear({ wav: WAV, whisperDir: home, env: {}, run });
  const gone = new AbortController();
  const taken = hear({ wav: WAV, whisperDir: home, env: {}, run, signal: gone.signal });
  const third = hear({ wav: WAV, whisperDir: home, env: {}, run });
  await new Promise((r) => setImmediate(r));
  gone.abort();
  dones[0](null, "first");
  await first;
  assert.deepEqual(await taken, { ok: false, status: 502, error: "hearing failed" });
  await new Promise((r) => setImmediate(r));
  assert.equal(dones.length, 2, "only the first and the third ran");
  dones[1](null, "third");
  assert.deepEqual(await third, { ok: true, text: "third" });
});

test("hear: a read the page took back while it runs stops its run, its audio goes, and the next one goes at once", async () => {
  const { home } = installed();
  let file = null;
  const dones = [];
  const gone = new AbortController();
  const run = (e, a, o, done) => {
    if (!file) {
      file = a[a.indexOf("-f") + 1];
      o.signal.addEventListener("abort", () => done(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })));
    }
    dones.push(done);
  };
  const taken = hear({ wav: WAV, whisperDir: home, env: {}, run, signal: gone.signal });
  const next = hear({ wav: WAV, whisperDir: home, env: {}, run });
  await new Promise((r) => setImmediate(r));
  assert.equal(dones.length, 1, "the next one waits");
  gone.abort();
  assert.deepEqual(await taken, { ok: false, status: 502, error: "hearing failed" });
  assert.equal(fs.existsSync(file), false, "its audio is gone");
  await new Promise((r) => setImmediate(r));
  assert.equal(dones.length, 2, "the next one runs now");
  dones[1](null, "the whole phrase");
  assert.deepEqual(await next, { ok: true, text: "the whole phrase" });
});

// On a busy machine a read at normal priority waits behind the other sessions' work
test("hear: a read runs above normal priority, since the owner is waiting and the other sessions' work is not", async () => {
  const { home } = installed();
  const set = test.mock.method(os, "setPriority", () => {});
  const r = await hear({ wav: WAV, whisperDir: home, env: {}, run: (e, a, o, done) => { setImmediate(() => done(null, "hello")); return { pid: 4242 }; } });
  assert.deepEqual(r, { ok: true, text: "hello" });
  assert.deepEqual(set.mock.calls.map((c) => c.arguments), [[4242, os.constants.priority.PRIORITY_ABOVE_NORMAL]]);
  test.mock.restoreAll();
});

test("hear: a priority that cannot be set costs nothing: the owner's words still come back", async () => {
  const { home } = installed();
  test.mock.method(os, "setPriority", () => { throw new Error("ESRCH"); });
  const r = await hear({ wav: WAV, whisperDir: home, env: {}, run: (e, a, o, done) => { setImmediate(() => done(null, "hello")); return { pid: 4242 }; } });
  assert.deepEqual(r, { ok: true, text: "hello" });
  test.mock.restoreAll();
});

test("hear: one run at a time, in the order they came", async () => {
  const { home } = installed();
  const order = [];
  const dones = [];
  const run = (e, a, o, done) => {
    order.push("start");
    dones.push(done);
  };
  const first = hear({ wav: WAV, whisperDir: home, env: {}, run });
  const second = hear({ wav: WAV, whisperDir: home, env: {}, run });
  await new Promise((r) => setImmediate(r));
  assert.equal(order.length, 1, "the second waits for the first");
  dones[0](null, "first");
  assert.deepEqual(await first, { ok: true, text: "first" });
  await new Promise((r) => setImmediate(r));
  assert.equal(order.length, 2);
  dones[1](null, "second");
  assert.deepEqual(await second, { ok: true, text: "second" });
});
