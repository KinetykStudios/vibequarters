// The screenshots a desk screen shows. The server learns a file only from a figure's own transcript (a
// screenshot call's result) and keeps it only when its real path is under <home>/AppData/Local/Temp/claude/ or the
// session's folder, it ends in .png, .jpg or .jpeg, its first bytes are a real PNG or JPEG header, it is at most 4 MB and
// it was written at or after the session's first row. It is served by an opaque id, the newest per figure, at most 16.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkShot, tempRoots } = require("../lib/shots");
const { createHq } = require("../lib/hq");
const { at, asst, tool, jsonl } = require("./helpers");

const roots = [];
test.after(async () => {
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
// a name as a transcript on this system writes it
const named = (rel) => rel.split("/").join(path.sep);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR fixture bytes")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF fixture bytes")]);
const SINCE = Date.now() - 60e3;
// a fake home with its Temp/claude folder, a session folder, and a folder outside both
function place() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hq-shots-"));
  roots.push(root);
  const home = path.join(root, "home"), temp = path.join(home, "AppData", "Local", "Temp", "claude"), cwd = path.join(root, "work", "shop"), out = path.join(home, "Documents");
  for (const d of [temp, cwd, out]) fs.mkdirSync(d, { recursive: true });
  const put = (p, bytes = PNG) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p; };
  return { root, home, temp, cwd, out, put, opts: { home, cwd, since: SINCE } };
}

test("a real PNG or JPEG under the home's Temp/claude folder or the session's folder is kept, named relative to either", () => {
  const w = place();
  w.put(path.join(w.temp, "C--work", "page-1.png"));
  w.put(path.join(w.cwd, "shots", "home.jpeg"), JPEG);
  const a = checkShot(named("AppData/Local/Temp/claude/C--work/page-1.png"), w.opts);
  assert.deepEqual([a.type, a.path], ["image/png", fs.realpathSync.native(path.join(w.temp, "C--work", "page-1.png"))]);
  assert.equal(checkShot("shots/home.jpeg", w.opts).type, "image/jpeg", "relative to the session's folder");
  assert.equal(checkShot(path.join(w.cwd, "shots", "home.jpeg"), w.opts).type, "image/jpeg", "or written out whole");
  assert.equal(checkShot("AppData/Local/Temp/claude/C--work/page-1.png", w.opts, true).body.equals(PNG), true, "read whole to serve");
});

test("on macOS and Linux Claude Code's own temp folder is a place too, and only the user's own", () => {
  assert.deepEqual(tempRoots("linux", 1000, "/tmp"), ["/tmp/claude-1000", "/private/tmp/claude-1000"]);
  assert.deepEqual(tempRoots("darwin", 501, "/var/folders/x/T"), ["/tmp/claude-501", "/private/tmp/claude-501", "/var/folders/x/T/claude-501"]);
  assert.deepEqual(tempRoots("win32", null, "C:\\Temp"), []);
  assert.deepEqual(tempRoots("linux", null, "/tmp"), []);
  const w = place(), mine = path.join(w.root, "tmp", "claude-1000"), other = path.join(w.root, "tmp", "claude-1001");
  w.put(path.join(mine, "work", "page.png"));
  w.put(path.join(other, "page.png"));
  const opts = { ...w.opts, temp: [mine] };
  assert.equal(checkShot(path.join(mine, "work", "page.png"), opts).type, "image/png");
  assert.equal(checkShot(path.relative(w.cwd, path.join(mine, "work", "page.png")), opts).type, "image/png", "relative to the session's folder");
  assert.equal(checkShot(path.join(other, "page.png"), opts), null);
  assert.equal(checkShot(path.join(mine, "work", "page.png"), { ...opts, temp: [] }), null, "control: not a place without it");
});

test("a path outside both places is refused, however it is written", () => {
  const w = place();
  w.put(path.join(w.out, "private.png"));
  w.put(path.join(w.root, "elsewhere.png"));
  for (const rel of ["Documents/private.png", "..\\elsewhere.png", "../elsewhere.png", "AppData/Local/Temp/claude/../../../../Documents/private.png", path.join(w.root, "elsewhere.png")])
    assert.equal(checkShot(rel, w.opts), null, rel);
  assert.equal(checkShot("Documents/private.png", { ...w.opts, cwd: null }), null, "no session folder: only Temp/claude");
});

// A name that is not under a root as written is refused before any file system call, so a UNC name never makes the
// server reach its host. A spy on realpath and open records every call.
test("a name not under a root as written is refused before any file system call: a UNC name never reaches its host", () => {
  const w = place();
  w.put(path.join(w.root, "elsewhere.png"));
  const calls = [], rp = fs.realpathSync.native, open = fs.openSync;
  fs.realpathSync.native = (p, ...a) => { calls.push("realpath " + p); return rp(p, ...a); };
  fs.openSync = (p, ...a) => { calls.push("open " + p); return open(p, ...a); };
  try {
    // elsewhere a backslash is an ordinary character of a file name, so such a name is one in the session's folder
    const names = path.sep === "\\" ? ["\\\\host\\share\\a.png", "\\\\?\\UNC\\host\\share\\a.png", "..\\elsewhere.png"] : ["../elsewhere.png"];
    for (const rel of [...names, "//host/share/a.png", path.join(w.root, "elsewhere.png")])
      assert.equal(checkShot(rel, w.opts), null, rel);
    assert.deepEqual(calls, [], "no realpath or open for a name outside both places");
    assert.equal(checkShot("AppData/Local/Temp/claude/none.png", w.opts), null);
    assert.ok(calls.length > 0, "control: the spy sees the calls a name under a root makes");
  } finally {
    fs.realpathSync.native = rp;
    fs.openSync = open;
  }
});

// A session that cd'd to a drive's root does not make the whole drive a root; the home's Temp/claude still is, and a
// home as the session's folder stays a root.
test("a session folder that is a drive's root is no root; the home's Temp/claude still is, and so is the home as the session's folder", () => {
  const w = place();
  const drive = path.parse(w.root).root, outside = w.put(path.join(w.out, "private.png"));
  w.put(path.join(w.temp, "ok.png"));
  assert.equal(checkShot(outside, { ...w.opts, cwd: drive }), null, "cwd " + drive);
  assert.equal(checkShot("AppData/Local/Temp/claude/ok.png", { ...w.opts, cwd: drive }).type, "image/png", "the home's Temp/claude");
  assert.equal(checkShot(outside, { ...w.opts, cwd: w.home }).type, "image/png", "control: the home as the session's folder");
});

test("a link that escapes is refused: its real path is outside both places", () => {
  const w = place();
  w.put(path.join(w.out, "secret", "private.png"));
  fs.symlinkSync(path.join(w.out, "secret"), path.join(w.temp, "door"), "junction");
  assert.equal(checkShot("AppData/Local/Temp/claude/door/private.png", w.opts), null);
  let file = false;
  try {
    fs.symlinkSync(path.join(w.out, "secret", "private.png"), path.join(w.cwd, "link.png"), "file");
    file = true;
  } catch {} // a file link needs a privilege this machine may not grant; the junction above is the check that always runs
  if (file) assert.equal(checkShot("link.png", w.opts), null, "a file link");
  // control: a junction that stays inside is followed
  fs.mkdirSync(path.join(w.temp, "real"));
  w.put(path.join(w.temp, "real", "ok.png"));
  fs.symlinkSync(path.join(w.temp, "real"), path.join(w.temp, "alias"), "junction");
  assert.equal(checkShot("AppData/Local/Temp/claude/alias/ok.png", w.opts).type, "image/png");
});

test("a .png holding text is refused, and so is any other name, whatever the header", () => {
  const w = place();
  w.put(path.join(w.temp, "fake.png"), Buffer.from("AWS_SECRET=abc\nnot a picture"));
  w.put(path.join(w.temp, "page.webp"));
  w.put(path.join(w.temp, "page.png.txt"));
  w.put(path.join(w.temp, "tiny.png"), PNG.subarray(0, 4));
  for (const rel of ["fake.png", "page.webp", "page.png.txt", "tiny.png"]) assert.equal(checkShot("AppData/Local/Temp/claude/" + rel, w.opts), null, rel);
});

test("a 5 MB file is refused; 4 MB is the most", () => {
  const w = place();
  const big = (n) => Buffer.concat([PNG, Buffer.alloc(n - PNG.length)]);
  w.put(path.join(w.temp, "five.png"), big(5 * 1024 * 1024));
  w.put(path.join(w.temp, "four.png"), big(4 * 1024 * 1024));
  assert.equal(checkShot("AppData/Local/Temp/claude/five.png", w.opts), null);
  assert.equal(checkShot("AppData/Local/Temp/claude/four.png", w.opts).type, "image/png");
});

test("an old file, written before the session's first row, is refused", () => {
  const w = place();
  const fp = w.put(path.join(w.temp, "old.png"));
  fs.utimesSync(fp, new Date(SINCE - 5e3), new Date(SINCE - 5e3));
  assert.equal(checkShot("AppData/Local/Temp/claude/old.png", w.opts), null);
  fs.utimesSync(fp, new Date(SINCE + 1), new Date(SINCE + 1));
  assert.equal(checkShot("AppData/Local/Temp/claude/old.png", w.opts).type, "image/png", "right after the first row is in time (utimes rounds to a fraction of a millisecond)");
  assert.equal(checkShot("AppData/Local/Temp/claude/old.png", { ...w.opts, since: null }), null, "no first row, no screenshot");
});

// ---------- the ids: issued for a figure's newest screenshot, served by createHq's screenFile ----------
const NOW = Date.now();
const sec = (t) => Math.round((t - Date.parse(at(0))) / 1000);
const result = (t, id, content) => ({ type: "user", timestamp: at(sec(t)), isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });
const step = (t, name, input) => { const b = tool(name, input); return { b, row: asst({ sec: sec(t), content: [b] }) }; };
const navTo = (t, url) => { const n = step(t, "mcp__playwright__browser_navigate", { url }); return [n.row, result(t + 500, n.b.id, `### Page\n- Page URL: ${url}\n- Page Title: Shop`)]; };
const shotRows = (t, rel) => { const s = step(t, "mcp__playwright__browser_take_screenshot", {}); return [s.row, result(t + 500, s.b.id, `### Result\n- [Screenshot of viewport](${rel})`)]; };
const ID = (n) => "c" + String(n).padStart(7, "0") + "-0000-0000-0000-000000000000";
function hqWorld(w, sessions) {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "hq.config.example.json"), "utf8"));
  const proj = path.join(w.root, "projects");
  fs.mkdirSync(proj, { recursive: true });
  const index = { mains: [], subMtime: {}, subs: [] };
  const write = (id, rows) => {
    const fp = path.join(proj, id + ".jsonl");
    fs.writeFileSync(fp, jsonl(rows.map((r) => ({ ...r, cwd: w.cwd }))));
    if (!index.mains.some((m) => m.sessionId === id)) index.mains.push({ fp, sessionId: id, mtimeMs: NOW, project: "p" });
  };
  for (const [id, rows] of Object.entries(sessions)) write(id, rows);
  const hq = createHq({ config, board: null, home: w.home });
  const floor = async () => { await hq.update(index, null, NOW); return hq.payload().floor; };
  return { hq, write, floor };
}

test("a figure's screenshot gets an opaque id its screen carries, and the id serves that file's bytes", async () => {
  const w = place();
  w.put(path.join(w.temp, "s1", "page.png"));
  const { hq, floor } = hqWorld(w, { [ID(1)]: [...navTo(NOW - 9e3, "http://localhost:5173/"), ...shotRows(NOW - 5e3, named("AppData/Local/Temp/claude/s1/page.png"))] });
  const s = (await floor()).sessions[0].screen;
  assert.equal(s.kind, "shot");
  assert.match(s.shot, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(s).includes("page.png") && !JSON.stringify(s).includes("AppData"), "the payload never names the file");
  const got = hq.screenFile(s.shot);
  assert.deepEqual([got.type, got.body.equals(PNG)], ["image/png", true]);
  assert.equal((await floor()).sessions[0].screen.shot, s.shot, "the same screenshot keeps its id across refreshes");
  // checked again when served: a file turned to text since its id was issued serves nothing
  fs.writeFileSync(path.join(w.temp, "s1", "page.png"), "now text");
  assert.equal(hq.screenFile(s.shot), null);
});

test("an id never issued, a malformed one or a path serves nothing", async () => {
  const w = place();
  w.put(path.join(w.temp, "s1", "page.png"));
  const { hq, floor } = hqWorld(w, { [ID(1)]: [...navTo(NOW - 9e3, "http://localhost:5173/"), ...shotRows(NOW - 5e3, named("AppData/Local/Temp/claude/s1/page.png"))] });
  await floor();
  for (const id of ["0".repeat(32), "f".repeat(32), "", "x", null, "AppData/Local/Temp/claude/s1/page.png", path.join(w.temp, "s1", "page.png")]) assert.equal(hq.screenFile(id), null, String(id));
});

test("a refused screenshot gets no id: the screen shows the page's URL and title", async () => {
  const w = place();
  w.put(path.join(w.out, "private.png"));
  const { hq, floor } = hqWorld(w, { [ID(1)]: [...navTo(NOW - 9e3, "http://localhost:5173/"), ...shotRows(NOW - 5e3, named("Documents/private.png"))] });
  const s = (await floor()).sessions[0].screen;
  assert.deepEqual([s.kind, s.shot, s.head, s.title], ["shot", null, "http://localhost:5173/", "Shop"]);
});

test("only the newest screenshot per figure is live: a new one or a step away retires its id", async () => {
  const w = place();
  w.put(path.join(w.temp, "s1", "a.png"));
  w.put(path.join(w.temp, "s1", "b.png"));
  const base = [...navTo(NOW - 20e3, "http://localhost:5173/"), ...shotRows(NOW - 15e3, "AppData/Local/Temp/claude/s1/a.png")];
  const { hq, write, floor } = hqWorld(w, { [ID(1)]: base });
  const a = (await floor()).sessions[0].screen.shot;
  write(ID(1), [...base, ...shotRows(NOW - 9e3, "AppData/Local/Temp/claude/s1/b.png")]);
  const b = (await floor()).sessions[0].screen.shot;
  assert.ok(a && b && a !== b);
  assert.equal(hq.screenFile(a), null, "the older one's id is gone");
  assert.ok(hq.screenFile(b));
  const sh = step(NOW - 4e3, "Bash", { command: "ls" });
  write(ID(1), [...base, ...shotRows(NOW - 9e3, "AppData/Local/Temp/claude/s1/b.png"), sh.row]);
  assert.equal((await floor()).sessions[0].screen.shot, null);
  assert.equal(hq.screenFile(b), null, "a figure that moved on keeps no id");
});

test("at most 16 ids are live at once", async () => {
  const w = place();
  const sessions = {};
  for (let i = 1; i <= 20; i++) {
    w.put(path.join(w.temp, "s" + i, "page.png"));
    sessions[ID(i)] = [...navTo(NOW - 9e3, "http://localhost:5173/" + i), ...shotRows(NOW - 5e3, `AppData/Local/Temp/claude/s${i}/page.png`)];
  }
  const { hq, floor } = hqWorld(w, sessions);
  const ids = (await floor()).sessions.map((s) => s.screen.shot).filter(Boolean);
  assert.equal(ids.length, 16);
  assert.equal(new Set(ids).size, 16);
  for (const id of ids) assert.ok(hq.screenFile(id));
});
