// HQ's hook bridge. Claude Code runs it for PermissionRequest (every tool) and for PreToolUse on AskUserQuestion. While
// HQ runs with control on and an HQ page is open, it writes the request into HQ's decisions folder and waits for the
// owner's answer from the page, whether the page is focused or not (that decides only HQ's notifications): permissions,
// Risky ones too, plan approvals and questions of every shape. With HQ down, control off or no HQ page open, and on any
// failure, it prints nothing, so the normal prompt shows unchanged. It stands down (prints nothing) when HQ stops,
// control goes off, the request is swept, or the chat's transcript shows the call answered in VS Code: a result for
// this call, or a prompt the owner typed. At the cap, or once no HQ page is open, it rewrites its request in place as a
// notice HQ shows but cannot answer, and prints nothing, so VS Code asks. It never prints updatedPermissions, and it
// prints an answer only for an answer file whose id, session and tool match its own request and whose hash is the one
// it computed from its own stdin, so an answer for a rewritten request file never counts. Nor does an answer file the
// running HQ did not write: before it acts on one it asks HQ over its local port whether HQ wrote exactly that answer,
// and only a yes counts. It asks only once it has found that the process listening on that port is the pid in HQ's port
// file, running node with the server.js beside this bridge, a lookup it begins as it writes the request, so it is done
// by the time the owner answers, and that counts for 10 minutes at most, only while the port file still names that same
// HQ, still running, and netstat finds it alone on the port at the answer; a port it finds is not HQ's is never asked,
// and it logs one line HQ alerts on; a lookup or check that cannot tell in time logs another, which HQ shows as not
// confirmed in time. Its files are removed in every case but the notice. Before it prints an answer it acts on, it logs
// one line to HQ's answers log, so HQ can tell an answer it did not write.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const cp = require("child_process"); // cp.execFile is looked up at each call, so a test can stand in for the lookup
const { newCursor, readNew } = require("../lib/tail");
const { riskOf } = require("../lib/describe");
const { takeMark } = require("../lib/askmark");

const MAX_INPUT = 4000; // characters of JSON the request file keeps of the tool input
const TAIL = 1024 * 1024; // the stand-down reads a transcript from its last megabyte, never the whole file
const CHUNK = 256 * 1024;
const SESSION = /^[\w-]{1,64}$/;
const AGENT = /^a[0-9a-f]{16}$/; // a subagent's id (for example "a0f1e2d3c4b5a6978"): subagents/agent-<id>.jsonl
const SUB_FILE = /^agent-a[0-9a-f]{16}\.jsonl$/;
const SUB_MAX = 8; // subagent files the no-agent_id fallback reads at most, newest first
const SUB_RECENT = 60e3; // a subagent file written this recently when the ask starts is read from then on
const NOTE_MAX = 500; // Ask for changes: the owner's note, in characters
const VERIFY_MS = 2000; // the check with HQ: no answer by then is a no
const LOOKUP_MS = 15e3; // the lookup of the process on HQ's port; PowerShell alone can take seconds to start
const SERVER = path.join(__dirname, "..", "server.js"); // the HQ server the lookup must find running
// An HQ page reports every 20 s, focused or not, and a hidden tab's timers may run only once a minute: a page whose last
// report is older than OPEN_MS is gone. A closed tab reports so at once, and counts as gone GRACE_MS later, so a reload,
// whose new page reports as it loads, moves nothing.
const OPEN_MS = 90e3;
const GRACE_MS = 5e3;
const POWERSHELL = path.join(process.env.SystemRoot || "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const NETSTAT = path.join(process.env.SystemRoot || "C:/Windows", "System32", "NETSTAT.EXE");
const PRIME_TTL = 10 * 60e3; // a lookup begun ahead counts this long at most; then the next answer or send looks up again
// Rows Claude Code writes as user rows that the owner did not type (task notifications are plain user rows, not meta)
const NOTICE = /^\s*<(task-notification|system-reminder)\b/;
// The prompt HQ does not answer through PermissionRequest: a question (its PreToolUse is the one HQ answers)
const NOT_HERE = new Set(["AskUserQuestion"]);
const ALLOW = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
const DENY = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "The user denied this from VibeQuarters." } } };

const rm = (fp) => {
  try {
    fs.unlinkSync(fp);
  } catch {}
};
function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // there, but another user's
  }
}
// HQ runs with control on: its port file says so and its process is alive.
function hqUp(dir) {
  const rt = readJson(path.join(dir, ".runtime.json"));
  return !!rt && rt.control === true && alive(rt.pid);
}
// An HQ page is open: the page's last report is at most openMs old, and is not a closed tab's report older than graceMs.
// A report from the future is a broken clock.
function pageOpen(dir, now = Date.now(), openMs = OPEN_MS, graceMs = GRACE_MS) {
  const p = readJson(path.join(dir, ".hq-presence.json"));
  if (!p || typeof p.at !== "number" || p.at - now > 5e3) return false;
  const age = now - p.at;
  return age <= openMs && (p.open !== false || age < graceMs);
}
// A question call HQ can answer: 1 to 4 questions, each with its own text (not blank; the answers are keyed by it), a
// pick flag that is true, false or left out, and 2 or more options with distinct labels that are not blank (an answer
// names its options by label).
function asks(input) {
  const qs = input && input.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) return false;
  const texts = new Set();
  for (const q of qs) {
    if (!q || typeof q !== "object" || typeof q.question !== "string" || !q.question.trim() || texts.has(q.question)) return false;
    if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") return false;
    if (!Array.isArray(q.options) || q.options.length < 2) return false;
    const labels = q.options.map((o) => (o && typeof o.label === "string" && o.label.trim() ? o.label : null));
    if (!labels.every(Boolean) || new Set(labels).size !== labels.length) return false;
    texts.add(q.question);
  }
  return true;
}
// One question with one pick: the only shape one click answers, by its option's place. Every other shape is answered
// by its picks.
const oneClick = (input) => input.questions.length === 1 && input.questions[0].multiSelect !== true;
// "permission", "plan" (ExitPlanMode), "question", or null for anything the bridge leaves alone.
function handles(d) {
  if (!d || typeof d !== "object" || typeof d.session_id !== "string" || !SESSION.test(d.session_id)) return null;
  if (typeof d.transcript_path !== "string" || !d.transcript_path || typeof d.tool_name !== "string" || !d.tool_name) return null;
  if (!d.tool_input || typeof d.tool_input !== "object" || Array.isArray(d.tool_input)) return null;
  if (d.hook_event_name === "PermissionRequest") return NOT_HERE.has(d.tool_name) ? null : d.tool_name === "ExitPlanMode" ? "plan" : "permission";
  if (d.hook_event_name === "PreToolUse" && d.tool_name === "AskUserQuestion" && typeof d.tool_use_id === "string" && asks(d.tool_input)) return "question";
  return null;
}
// The choices an answer may carry: for a permission, Allow once, Deny or Ask for changes (a deny with the owner's note);
// for a plan, Approve or Keep planning (a deny with the owner's note); for a question, an option by its place (one
// question with one pick) or "picks" (any other shape). Nothing hands a prompt back to VS Code.
const offered = (kind, d) =>
  kind === "permission" ? ["allow", "deny", "revise"]
  : kind === "plan" ? ["allow", "revise"]
  : oneClick(d.tool_input) ? d.tool_input.questions[0].options.map((_, k) => "opt:" + k) : ["picks"];
// Picks that fit the questions: one list for each question, of option places in order with none twice and each in
// range, at least one, and exactly one for a question with one pick. The server checks the same before it writes them.
const picksFit = (qs, picks) =>
  Array.isArray(picks) && picks.length === qs.length &&
  picks.every((p, i) => Array.isArray(p) && p.length >= 1 && (qs[i].multiSelect === true || p.length === 1) &&
    p.every((k, j) => Number.isInteger(k) && k >= 0 && k < qs[i].options.length && (j === 0 || k > p[j - 1])));
// The owner's note for Ask for changes: one line of plain text, 1 to 500 characters (code points), no surrounding spaces,
// no control character (C0, DEL or C1) and no Unicode line or paragraph separator
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const plainNote = (n) => typeof n === "string" && n.length > 0 && n === n.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(n) && ![...SEPARATORS].some((c) => n.includes(c)) && [...n].length <= NOTE_MAX;
// A question's answers are keyed by each question's text: the one label picked, or the labels picked in the options'
// order joined by a comma and a space (as the Claude Code extension's own question form joins them).
function decisionOf(kind, d, choice, note, picks) {
  if (kind !== "question") {
    const ask = kind === "plan" ? "The user asks you to keep planning, from VibeQuarters: " : "The user asks for a change, from VibeQuarters: ";
    if (choice === "revise") return plainNote(note) ? { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: ask + note } } } : null;
    return choice === "allow" ? ALLOW : choice === "deny" && kind === "permission" ? DENY : null;
  }
  const qs = d.tool_input.questions;
  let answers;
  if (choice === "picks") {
    if (!picksFit(qs, picks)) return null;
    answers = Object.fromEntries(qs.map((q, i) => [q.question, picks[i].map((k) => q.options[k].label).join(", ")]));
  } else answers = { [qs[0].question]: qs[0].options[Number(choice.slice(4))].label };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...d.tool_input, answers } } };
}
// A stable text of a value (keys sorted), to tell the asked call's tool_use in the transcript by its input.
const canon = (v) =>
  Array.isArray(v) ? "[" + v.map(canon).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
  : JSON.stringify(v) ?? "null";
// The call exactly as the request file keeps it, as sha256 hex: the tool, the kept input, whether it was cut, the folder
// it runs in and the agent that asks (the chip reads the folder and the card names the agent), and a notice's mark and
// a risky mark and a hook's ask when it has them (a request with none hashes as it always did). `r` is a request; its
// other fields do not count. The bridge keeps its own in memory; the server shows a request only when the file's hash
// matches the file's call, and an answer carries the hash of the item it answered.
const hashOf = (r) => crypto.createHash("sha256").update(canon({ tool_name: r.toolName, tool_input: r.toolInput, trimmed: r.trimmed === true, cwd: r.cwd ?? null, agent_id: r.agentId ?? null, agent_type: r.agentType ?? null, ...(r.notice !== undefined ? { notice: r.notice } : {}), ...(r.risky !== undefined ? { risky: r.risky } : {}), ...(r.hookAsk !== undefined ? { hook_ask: r.hookAsk } : {}) })).digest("hex");
// The tool input as the request file keeps it: at most max characters of JSON, the longest string cut first (by code
// points, so no emoji is split) and ending in an ellipsis; an input with no string to cut is dropped whole.
function trimInput(input, max = MAX_INPUT) {
  const v = JSON.parse(JSON.stringify(input));
  let trimmed = false;
  for (let i = 0; i < 200 && JSON.stringify(v).length > max; i++) {
    let best = null;
    const walk = (o) => {
      for (const k of Object.keys(o)) {
        const x = o[k];
        if (typeof x === "string") {
          if (!best || x.length > best.o[best.k].length) best = { o, k };
        } else if (x && typeof x === "object") walk(x);
      }
    };
    walk(v);
    if (!best) break;
    const chars = [...best.o[best.k]];
    if (chars.length <= 1) break;
    const over = JSON.stringify(v).length - max;
    best.o[best.k] = chars.slice(0, Math.max(0, chars.length - over - 1)).join("") + "…";
    trimmed = true;
  }
  return JSON.stringify(v).length > max ? { input: {}, trimmed: true } : { input: v, trimmed };
}

// --- the stand-down: the transcript's tail, then only what it gains ---
function tailOf(fp) {
  let size = 0;
  try {
    size = fs.statSync(fp).size;
  } catch {}
  const pos = Math.max(0, size - TAIL);
  return { fp, cursor: { ...newCursor(), pos }, skip: pos > 0 }; // a read from the middle drops its first, partial line
}
// The rows the file gained, parsed; null when it was replaced or truncated (the caller starts over).
function rowsOf(f) {
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const r = readNew(f.fp, f.cursor, CHUNK);
    if (r.reset) return null;
    f.cursor = r.cursor;
    let lines = r.lines;
    if (f.skip && lines.length) {
      lines = lines.slice(1);
      f.skip = false;
    }
    for (const l of lines) {
      try {
        rows.push(JSON.parse(l));
      } catch {}
    }
    if (!r.more) break;
  }
  return rows;
}
// A prompt the owner typed: text that is not a tool result, a task notification or a system reminder.
function typed(row) {
  const c = row.message && row.message.content;
  if (typeof c === "string") return !NOTICE.test(c);
  if (!Array.isArray(c) || c.some((b) => b && b.type === "tool_result")) return false;
  return c.some((b) => b && b.type === "text" && typeof b.text === "string" && !NOTICE.test(b.text));
}
// One file the stand-down reads: its tail, the calls in it that match, and the results it held before and after the ask.
// `sub`: a subagent's file, where no row is a prompt the owner typed.
const fileWatch = (fp, sub) => ({ f: tailOf(fp), sub, uses: [], before: new Set(), after: new Set(), typed: false });
function scanRow(T, W, row, baseline) {
  const content = row && row.message && Array.isArray(row.message.content) ? row.message.content : null;
  if (row && row.type === "assistant" && content)
    for (const b of content) if (b && b.type === "tool_use" && b.name === T.name && canon(b.input) === T.want) W.uses.push(b.id);
  if (row && row.type === "user") {
    if (content) for (const b of content) if (b && b.type === "tool_result") (baseline ? W.before : W.after).add(b.tool_use_id);
    if (!baseline && !W.sub && !row.isMeta && !row.isSidechain && typed(row)) W.typed = true;
  }
}
function feed(T, W, baseline) {
  let rows = rowsOf(W.f);
  if (rows === null) {
    W.f = tailOf(W.f.fp); // replaced or rewritten: what it holds now is the new baseline
    rows = rowsOf(W.f) || [];
    baseline = true;
  }
  for (const row of rows) scanRow(T, W, row, baseline);
}
// The session's subagent files written at or after `since`, newest first, at most SUB_MAX: <session>/subagents next to
// the transcript.
function subFiles(d, since) {
  const dir = path.join(path.dirname(d.transcript_path), d.session_id, "subagents");
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => SUB_FILE.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const m = fs.statSync(path.join(dir, n)).mtimeMs;
      if (m >= since) out.push({ fp: path.join(dir, n), m });
    } catch {}
  }
  return out.sort((a, b) => b.m - a.m).slice(0, SUB_MAX).map((x) => x.fp);
}
// What the bridge watches: the asking chat's own file (a subagent's own file when the request names it by agent_id),
// matched on the untrimmed input (the hook's tool_input equals the transcript's tool_use input). A request with no
// agent_id (the main chat's) also reads the session's subagent files written in the last minute, as they stand now, and
// any that is written after the ask: a call there may be a subagent's whose request came without one.
function openTail(d, kind, agentId) {
  const own = agentId ? path.join(path.dirname(d.transcript_path), d.session_id, "subagents", `agent-${agentId}.jsonl`) : d.transcript_path;
  const T = { name: d.tool_name, want: canon(d.tool_input), useId: kind === "question" ? d.tool_use_id : null, files: [fileWatch(own, !!agentId)], d: agentId ? null : d, since: Date.now() };
  if (T.d) for (const fp of subFiles(d, T.since - SUB_RECENT)) T.files.push(fileWatch(fp, true));
  for (const W of T.files) feed(T, W, true);
  return T;
}
// Answered in VS Code: a prompt the owner typed (main chat only), a result for the question's own id, or, for a
// permission (whose hook input has no tool_use_id), a result for the newest unanswered tool_use with this name and input,
// in any file it reads. A subagent file first seen after the ask is read from its tail with nothing before: at worst an
// older identical call there ends the wait, which prints nothing and leaves the normal prompt.
function answeredElsewhere(T) {
  if (T.d)
    for (const fp of subFiles(T.d, T.since))
      if (T.files.length <= SUB_MAX && !T.files.some((W) => W.f.fp === fp)) T.files.push(fileWatch(fp, true));
  for (const W of T.files) {
    feed(T, W, false);
    if (W.typed) return true;
    if (T.useId) {
      if (W.before.has(T.useId) || W.after.has(T.useId)) return true;
      continue;
    }
    const open = W.uses.filter((id) => !W.before.has(id));
    const cand = open[open.length - 1];
    if (cand && W.after.has(cand)) return true;
  }
  return false;
}
// The owner's answer for this request, or undefined. `req` is the bridge's own copy in memory, never the file. An answer
// that names another request, session or tool, carries another hash (an answer for a rewritten request file) or a choice
// this request does not offer, a revise without a plain one-line note, picks that do not fit the questions `qs`, or that
// is not JSON, is removed and never acted on. A file that cannot be read (not there yet, or held open by another
// process) is kept and read again on the next check.
function answerOf(fp, req, choices, qs) {
  let raw;
  try {
    raw = fs.readFileSync(fp, "utf8");
  } catch {
    return undefined;
  }
  let a = null;
  try {
    a = JSON.parse(raw);
  } catch {}
  if (a && a.id === req.id && a.sessionId === req.sessionId && a.toolName === req.toolName && a.hash === req.hash && typeof a.choice === "string" && choices.includes(a.choice) && (a.choice !== "revise" || plainNote(a.note)) && (a.choice !== "picks" || picksFit(qs, a.picks))) return a;
  rm(fp);
  return undefined;
}

// An answer as HQ keeps the ones it wrote and as the bridge asks about it: the request, the hash of the call shown,
// the choice, and the note or the picks it carries, as one stable text.
const answerKey = (a) => canon({ id: a.id, hash: a.hash, choice: a.choice, ...(a.choice === "revise" ? { note: a.note } : {}), ...(a.choice === "picks" ? { picks: a.picks } : {}) });
// Whether the running HQ wrote exactly this answer, asked over its port with no Origin (server.js /api/verify), with
// whose request it is for HQ's alert. Only a 200 that says {"wrote":true} is a yes, and only one that says
// {"wrote":false} a no; a refused or slow request, or any other reply, is null: HQ could not say.
function wroteIt(port, a, req) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ id: a.id, hash: a.hash, choice: a.choice, ...(a.choice === "revise" ? { note: a.note } : {}), ...(a.choice === "picks" ? { picks: a.picks } : {}), sessionId: req.sessionId, toolName: req.toolName });
    const headers = { Host: "127.0.0.1:" + port, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    const r = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/verify", headers, timeout: VERIFY_MS }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (text.length < 64) text += c;
      });
      res.on("end", () => resolve(res.statusCode !== 200 ? null : text === '{"wrote":true}' ? true : text === '{"wrote":false}' ? false : null));
      res.on("error", () => resolve(null));
    });
    r.on("timeout", () => r.destroy());
    r.on("error", () => resolve(null));
    r.end(body);
  });
}

// A Windows command line split into its arguments as the C runtime splits it: spaces and tabs between arguments, double
// quotes group, 2n backslashes before a quote are n and the quote groups, 2n+1 are n and a literal quote, and any other
// backslash is itself.
function argvOf(cmd) {
  const BS = "\\";
  const out = [];
  let cur = "", open = false, quoted = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === BS) {
      let n = 0;
      for (; cmd[i] === BS; i++) n++;
      if (cmd[i] === '"') {
        cur += BS.repeat(n >> 1) + (n % 2 ? '"' : "");
        if (n % 2 === 0) quoted = !quoted;
      } else {
        cur += BS.repeat(n);
        i--;
      }
      open = true;
    } else if (c === '"') {
      quoted = !quoted;
      open = true;
    } else if ((c === " " || c === "\t") && !quoted) {
      if (open) out.push(cur);
      cur = "";
      open = false;
    } else {
      cur += c;
      open = true;
    }
  }
  if (open) out.push(cur);
  return out;
}
// The file a path names once links are followed, lower case (Windows paths compare without case); null when it is not
// there.
function realFile(p) {
  try {
    return fs.realpathSync.native(p).toLowerCase();
  } catch {
    return null;
  }
}
// Whether the lookup found this bridge's HQ: every listener on the port (one at least) is the pid HQ's port file
// names, its executable is node, and its command line is exactly what launch.js and bin/start.js (npm start) spawn, that
// executable then the server.js beside this bridge, each by its full path, with nothing else but at most one settings file
// (--settings and a full path, as a second copy runs). HQ's state folder, from that file or the default with none, must be this
// bridge's own, so a second, genuine copy run for another folder is not its HQ. A node flag before the script, which
// could load other code first, any other argument, or a settings file HQ would refuse, is a no.
function hqProcess(o, pid, dir) {
  if (!o || typeof o !== "object" || !Array.isArray(o.owners) || !o.owners.length || !o.owners.every((x) => x === pid)) return false;
  if (typeof o.exe !== "string" || path.win32.basename(o.exe).toLowerCase() !== "node.exe" || typeof o.cmd !== "string") return false;
  const argv = argvOf(o.cmd);
  if (!(argv.length === 2 || (argv.length === 4 && argv[2] === "--settings"))) return false;
  if (!argv.every((a, i) => i === 2 || /^[A-Za-z]:[\\/]/.test(a))) return false;
  const exe = realFile(o.exe), server = realFile(SERVER);
  if (exe === null || realFile(argv[0]) !== exe || server === null || realFile(argv[1]) !== server) return false;
  let state;
  try {
    state = require("../lib/instance").loadInstance(argv[3] || null, { appDir: path.dirname(SERVER), home: os.homedir() }).stateDir;
  } catch {
    return false;
  }
  const own = realFile(dir);
  return own !== null && realFile(state) === own;
}
// The lookup, with PowerShell's own commands and nothing installed: the pids listening on the port and the
// executable and command line of the pid HQ's port file names, judged by hqProcess for this bridge's state folder. The
// port and pid are whole numbers checked before they reach the script. What the lookup prints is judged yes or no; a
// lookup that fails, runs out of time or prints no JSON is null: it could not tell.
function isHq(rt, dir) {
  return new Promise((resolve) => {
    const script = `$ErrorActionPreference='Stop'; $o = @(Get-NetTCPConnection -LocalPort ${rt.port} -State Listen | ForEach-Object { $_.OwningProcess }); $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${rt.pid}'; [pscustomobject]@{ owners = $o; exe = $p.ExecutablePath; cmd = $p.CommandLine } | ConvertTo-Json -Compress`;
    try {
      cp.execFile(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: LOOKUP_MS, windowsHide: true }, (err, out) => {
        if (err) return resolve(null);
        let o;
        try {
          o = JSON.parse(String(out).trim());
        } catch {
          return resolve(null);
        }
        resolve(hqProcess(o, rt.pid, dir));
      });
    } catch {
      resolve(null);
    }
  });
}
// The lookup is Windows only (PowerShell and netstat). Anywhere else no answer could ever be confirmed, so the bridge and
// the waiter (hq-inbox.js) stand aside at once and Claude Code asks, and the page says so (server.js).
const canConfirm = (platform = process.platform) => platform === "win32";
const fitRt = (rt) => !!rt && Number.isInteger(rt.pid) && rt.pid > 0 && Number.isInteger(rt.port) && rt.port > 0 && rt.port <= 65535;
const sameHq = (a, b) => !!a && !!b && a.pid === b.pid && a.port === b.port && a.startedAt === b.startedAt;
// The lookup begun ahead of the answer, while the owner reads (it takes seconds under load), for the port file as it is
// now; null when that names no pid and port
function primeHq(dir) {
  const rt = readJson(path.join(dir, ".runtime.json"));
  return fitRt(rt) ? { rt, at: Date.now(), hq: isHq(rt, dir) } : null;
}
// The pids listening on this TCP port now, from netstat (quick even under load, where the full lookup takes seconds),
// or null when it cannot tell: it fails, or lists none
function listeners(port) {
  return new Promise((resolve) => {
    try {
      cp.execFile(NETSTAT, ["-ano"], { timeout: LOOKUP_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve(null);
        const pids = new Set();
        for (const line of String(out).split(/\r?\n/)) {
          const f = line.trim().split(/\s+/);
          if (f.length === 5 && /^TCP/i.test(f[0]) && f[3] === "LISTENING" && f[1].slice(f[1].lastIndexOf(":") + 1) === String(port)) pids.add(Number(f[4]));
        }
        resolve(pids.size ? [...pids] : null);
      });
    } catch {
      resolve(null);
    }
  });
}
// The lookup for this port file: the one begun ahead, when it found the real HQ less than PRIME_TTL ago, the port file
// still names that same HQ (pid, port and start), its pid still runs, and netstat finds that pid alone listening on the
// port now (no other process has bound it since); else the full lookup now. A no, or a lookup that could not tell, is
// never reused, so it is always asked again.
async function lookupFor(rt, dir, primed) {
  if (primed && sameHq(primed.rt, rt) && Date.now() - primed.at <= PRIME_TTL && alive(rt.pid) && (await primed.hq) === true) {
    const now = await listeners(rt.port);
    if (now && now.length === 1 && now[0] === rt.pid) return true;
  }
  return isHq(rt, dir);
}
// An answer file counts only through the real HQ: the port file names a pid and a port, the lookup finds HQ's server
// there, and HQ says it wrote exactly that answer. A port it finds is not HQ's is never asked, and the bridge
// logs one line, with no command, note or label, that HQ alerts on as written outside HQ (unconfirmed). A lookup or a
// check that could not tell logs a line HQ alerts on as not confirmed in time (unchecked). HQ's own no logs nothing: HQ
// alerts on it itself. The port is the one the lookup confirmed, never read again.
async function checkAnswer(dir, a, req, primed = null) {
  const rt = readJson(path.join(dir, ".runtime.json"));
  const hq = fitRt(rt) && (await lookupFor(rt, dir, primed)); // true, false, or null when the lookup could not tell
  if (hq === true) {
    const wrote = await wroteIt(rt.port, a, req);
    if (wrote !== null) return wrote;
  }
  try {
    fs.appendFileSync(path.join(dir, "answers.log.jsonl"), JSON.stringify({ at: new Date().toISOString(), id: req.id, sessionId: req.sessionId, tool: req.toolName, choice: a.choice, source: hq === false ? "unconfirmed" : "unchecked" }) + "\n");
  } catch {}
  return false;
}

const agentOf = (d) => (typeof d.agent_id === "string" && AGENT.test(d.agent_id) ? d.agent_id : null);
// The request as the bridge writes it, sealed with its hash. A permission whose full call HQ's rating calls Risky is
// marked risky: true, so HQ asks for the second click even when the cut copy it keeps reads milder. `extra` makes it a
// notice at the cap: notice: true, when it moved, its first askedAt, and the pid of the process that ran the hook (the
// asking chat's Claude), so the notice lasts as long as that chat.
function requestFor(d, kind, id, extra = {}) {
  const agentId = agentOf(d);
  const { input, trimmed } = trimInput(d.tool_input);
  const cwd = typeof d.cwd === "string" ? d.cwd : null;
  const req = {
    v: 1, id, pid: process.pid, askedAt: Date.now(), event: kind === "question" ? "PreToolUse" : "PermissionRequest",
    sessionId: d.session_id, transcriptPath: d.transcript_path, agentId,
    agentType: agentId && typeof d.agent_type === "string" ? d.agent_type.slice(0, 64) : null,
    toolName: d.tool_name.slice(0, 128), toolInput: input, trimmed,
    toolUseId: kind === "question" ? d.tool_use_id : null, cwd,
    ...(kind === "permission" && riskOf(d.tool_name, d.tool_input, false, cwd).level === "high" ? { risky: true } : {}),
    ...extra,
  };
  req.hash = hashOf(req);
  return req;
}

const MOVED = Symbol("moved"); // the wait passed the cap, or no HQ page is open: the prompt moves to VS Code

async function run(raw, { dir, tick = 1000, cap = 600e3, openMs = OPEN_MS, graceMs = GRACE_MS, platform = process.platform } = {}) {
  if (!canConfirm(platform)) return "";
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return "";
  }
  const kind = handles(d);
  const open = () => pageOpen(dir, Date.now(), openMs, graceMs);
  if (!kind || !dir || !hqUp(dir) || !open()) return "";
  const folder = path.join(dir, "decisions");
  const id = crypto.randomBytes(16).toString("hex");
  const reqFp = path.join(folder, id + ".json"), ansFp = path.join(folder, id + ".answer.json"), tmpFp = reqFp + ".tmp";
  let watcher = null, timer = null, moved = false;
  try {
    const T = openTail(d, kind, agentOf(d));
    // a safety hook that asked for this call left a mark (lib/askmark.js): the request carries it, so HQ leaves it to
    // the owner
    const hook = kind === "permission" ? takeMark(os.homedir(), d.session_id, d.tool_name, d.tool_input, Date.now()) : null;
    const hookAsk = hook ? { hookAsk: hook } : {};
    // the bridge's own copy, kept in memory: its hash is what an answer must carry, whatever the file says later
    const req = requestFor(d, kind, id, hookAsk);
    const toolName = req.toolName;
    const choices = offered(kind, d);
    const qs = kind === "question" ? d.tool_input.questions : null;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(tmpFp, JSON.stringify(req));
    fs.renameSync(tmpFp, reqFp);
    const primed = primeHq(dir); // looked up now, while the owner reads, so the answer acts at once
    // the answer first, so an answer that lands with a stand-down or the cap still counts; then every reason to stop
    // waiting; the cap and a closed page last, since a request that is gone is no notice. An answer counts only once the
    // real HQ says it wrote it (checkAnswer); while that runs no other check does, and one that does not count is
    // removed, so the owner can still answer
    let asking = false;
    const got = await new Promise((resolve) => {
      const check = () => {
        if (asking) return;
        try {
          const a = answerOf(ansFp, req, choices, qs);
          if (a !== undefined) {
            asking = true;
            return void checkAnswer(dir, a, req, primed).then((yes) => {
              asking = false;
              if (yes) return resolve(a);
              rm(ansFp);
            });
          }
          if (answeredElsewhere(T) || !hqUp(dir) || !fs.existsSync(reqFp)) return resolve(null);
          if (Date.now() - req.askedAt >= cap || !open()) resolve(MOVED);
        } catch {
          resolve(null); // a check that throws ends the wait silently, never the process
        }
      };
      try {
        watcher = fs.watch(folder, check);
        watcher.on("error", () => {});
      } catch {}
      timer = setInterval(check, tick);
      check();
    });
    // at the cap, or with no HQ page open, the request becomes a notice in place: the same id and call, sealed with its
    // mark under a new hash, so HQ shows where the prompt went and no answer for the request it was can reach it; VS
    // Code asks
    if (got === MOVED) {
      const n = requestFor(d, kind, id, { ...hookAsk, askedAt: req.askedAt, pid: process.ppid, notice: true, movedAt: Date.now() });
      fs.writeFileSync(tmpFp, JSON.stringify(n));
      fs.renameSync(tmpFp, reqFp);
      moved = true;
      return "";
    }
    const out = got == null ? null : decisionOf(kind, d, got.choice, got.note, got.picks);
    // the line HQ reads to tell an answer it did not write: never the command, a file's contents or the note; a line
    // that cannot be written is swallowed, and the decision still prints
    if (out) {
      try {
        fs.appendFileSync(path.join(dir, "answers.log.jsonl"), JSON.stringify({ at: new Date().toISOString(), id, sessionId: d.session_id, tool: toolName, choice: got.choice, source: "bridge" }) + "\n");
      } catch {}
    }
    return out ? JSON.stringify(out) : "";
  } catch {
    return "";
  } finally {
    clearInterval(timer);
    if (watcher) watcher.close();
    for (const fp of moved ? [ansFp, tmpFp] : [reqFp, ansFp, tmpFp]) rm(fp);
  }
}

if (require.main === module) {
  let dir = null;
  try {
    const i = process.argv.indexOf("--state");
    dir = i > 0 ? path.resolve(process.argv[i + 1]) : require("../lib/instance").loadInstance(null, { appDir: path.join(__dirname, ".."), home: os.homedir() }).stateDir;
  } catch {}
  let raw = "";
  process.stdin.on("error", () => process.exit(0)); // a failed input stream prints nothing, so the normal prompt shows
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", async () => {
    let out = "";
    try {
      out = await run(raw, { dir });
    } catch {}
    if (out) process.stdout.write(out + "\n", () => process.exit(0));
    else process.exit(0);
  });
}

module.exports = { run, handles, offered, decisionOf, picksFit, answerKey, argvOf, canConfirm, hqProcess, isHq, primeHq, lookupFor, listeners, fitRt, sameHq, alive, readJson, PRIME_TTL, plainNote, canon, hashOf, trimInput, openTail, answeredElsewhere, hqUp, ALLOW, DENY, NOTE_MAX };
