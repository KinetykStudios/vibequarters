// A screenshot file a figure's transcript names (a Playwright screenshot call's result), checked before HQ
// serves it. The name is resolved against the user's home and then the session's folder; a file is kept only when
// - its path as written, and then its real path (links and junctions followed), is under <home>/AppData/Local/Temp/claude/,
//   Claude Code's own temp folder on macOS or Linux (tempRoots) or the session's folder (not when that folder is a drive's root);
// - it ends in .png, .jpg or .jpeg (the name and the real path both);
// - its first bytes are a real PNG or JPEG header, which gives its type;
// - it is at most 4 MB and was written at or after the session's first row.
// checkShot runs again on every serve, on the bytes it serves, so a file changed after its id was issued is refused then.
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_BYTES = 4 * 1024 * 1024;
const EXT = /\.(png|jpe?g)$/i;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function typeOf(b) {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG)) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};
// strictly below the folder (path.relative ignores case on Windows)
const below = (child, parent) => {
  const rel = path.relative(parent, child);
  return !!rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
};
// The file's type, and with `whole` its bytes, or null: opened once, so the size, time and header are the opened file's.
function readShot(fp, since, whole) {
  let fd;
  try {
    fd = fs.openSync(fp, "r");
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size < 8 || st.size > MAX_BYTES || st.mtimeMs < since) return null;
    const buf = Buffer.alloc(whole ? st.size : 8);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, n);
      if (!got) break;
      n += got;
    }
    const type = n === buf.length ? typeOf(buf) : null;
    return type ? (whole ? { type, body: buf } : { type }) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}
// Where Claude Code keeps its temporary files on macOS and Linux: claude-<uid> in /tmp (on macOS a link to /private/tmp),
// or in the system's own temp folder
function tempRoots(platform = process.platform, uid = process.getuid ? process.getuid() : null, tmp = os.tmpdir()) {
  if (platform === "win32" || uid === null) return [];
  return [...new Set(["/tmp", "/private/tmp", tmp])].map((d) => path.posix.join(d, "claude-" + uid));
}
const TEMP = tempRoots();
// { path, type } (and `body` with whole) for a screenshot the checks keep, else null. `since` is the session's first
// row (ms); with none there is no screenshot.
// A drive's root (C:\, or a share's \\host\share\): a session that cd'd there would make the whole drive a root.
const driveRoot = (p) => { const r = path.resolve(p); return path.parse(r).root === r; };
function checkShot(rel, { home = null, cwd = null, since = null, temp = TEMP } = {}, whole = false) {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || !EXT.test(rel) || typeof since !== "number" || !Number.isFinite(since)) return null;
  const ok = (p) => typeof p === "string" && p.length > 0;
  // the roots as written; the session's folder is one unless it is a drive's root
  const named = [ok(home) ? path.join(home, "AppData", "Local", "Temp", "claude") : null, ...temp, ok(cwd) && !driveRoot(cwd) ? cwd : null].filter(Boolean).map((r) => path.resolve(r));
  let roots = null;
  for (const base of [home, cwd]) {
    if (!ok(base)) continue;
    const lex = path.resolve(base, rel);
    // a name not under a root as written is refused before any file system call: a UNC name never makes
    // the server reach its host. Its real path is checked again below, links and junctions followed.
    if (!named.some((r) => below(lex, r))) continue;
    if (!roots) roots = named.map(real).filter(Boolean);
    const fp = real(lex);
    if (!fp || !EXT.test(fp) || !roots.some((r) => below(fp, r))) continue;
    const got = readShot(fp, since, whole);
    if (got) return { path: fp, ...got };
  }
  return null;
}

module.exports = { checkShot, tempRoots, MAX_BYTES };
