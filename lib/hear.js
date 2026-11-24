// Speech into words on this computer, for a browser whose own speech recognition never fires (public/hear.js).
// One phrase comes as a WAV and a local whisper.cpp build reads it: the folder named by assistant.whisperDir in the
// config, or the VIBEQUARTERS_WHISPER_DIR environment variable, holding whisper-cli (whisper-cli.exe on Windows) and the
// ggml-base.en.bin model. With neither set, hearing is off. The audio stays here, in a temp folder that goes when the run
// ends, and neither it nor the words reach a log.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const RUN_MS = 60000; // a busy machine can be slow
// The first best guess, not a search for better ones, since the user is waiting: whisper's default search takes longer
// and rarely changes a short phrase. Never add -ac (a shorter audio context): it is faster but can repeat the last
// words on a loop.
const SPEED = ["-t", "8", "-bs", "1", "-bo", "1", "-nf"];

const isWav = (b) => b.length >= 44 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WAVE";

// whisper writes what is not speech in brackets or parentheses: [BLANK_AUDIO], (wind blowing)
const spoken = (out) => String(out).replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();

// A virus scanner can hold a new file for a moment, and a remove then throws (EPERM). That never costs the user their
// words or stops the server: what stays goes with a later phrase.
const rm = (dir) => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});

// No run lasts this long, so a folder this old is nobody's: a held file's, or a server's that died in the middle of a
// run. One look at a time, and no read waits for it: a busy temp folder is slow to list.
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  const root = os.tmpdir();
  for (const name of await fs.promises.readdir(root).catch(() => [])) {
    if (!name.startsWith("hq-hear-")) continue;
    const dir = path.join(root, name);
    const made = await fs.promises.stat(dir).catch(() => null);
    if (made && Date.now() - made.mtimeMs > 2 * RUN_MS) await rm(dir);
  }
  sweeping = false;
}

const FAILED = { ok: false, status: 502, error: "hearing failed" };

// The user is waiting and the other sessions' work is not, so on a busy machine the read runs above normal priority. Not
// allowed or already gone: it runs as it is.
function hurry(child) {
  if (!child || !child.pid) return;
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch {}
}

async function once({ wav, exe, model, run, signal }) {
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hq-hear-"));
    const file = path.join(tmp, "phrase.wav");
    fs.writeFileSync(file, wav);
    const args = ["-m", model, "-f", file, "-l", "en", "-nt", "-np", ...SPEED];
    const out = await new Promise((ok, fail) => hurry(run(exe, args, { timeout: RUN_MS, windowsHide: true, signal }, (e, stdout) => (e ? fail(e) : ok(stdout)))));
    return { ok: true, text: spoken(out) };
  } catch {
    return FAILED;
  } finally {
    if (tmp) await rm(tmp);
    sweep();
  }
}

// One run at a time, in the order they came, so a phrase and its interim copies never pile onto the CPU
let last = Promise.resolve();

// { ok: true, text } with the spoken words, empty when there were none, or { ok: false, status, error } for the route to send.
// signal: the page took this read back, so it never runs, or its run stops, and the next one goes at once.
function hear({ wav, whisperDir, env = process.env, run = execFile, signal }) {
  if (!isWav(wav)) return Promise.resolve({ ok: false, status: 400, error: "not a WAV" });
  const dir = whisperDir || env.VIBEQUARTERS_WHISPER_DIR;
  if (!dir) return Promise.resolve({ ok: false, status: 503, error: "hearing off: no whisper.cpp folder set" });
  const exe = path.join(dir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"), model = path.join(dir, "ggml-base.en.bin");
  if (!fs.existsSync(exe) || !fs.existsSync(model)) return Promise.resolve({ ok: false, status: 503, error: "hearing off: whisper.cpp is not installed" });
  last = last.then(() => (signal && signal.aborted ? FAILED : once({ wav, exe, model, run, signal })));
  return last;
}

module.exports = { hear };
