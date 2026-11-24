// Folds a session transcript's rows into what the board shows: title, status, current action, and a short timeline.
// Shell commands are never kept: only their description is.
const MIN = 60 * 1000;
const TOOL_MAX = 30 * 60 * 1000; // a tool call with no result after this long is treated as dead
const STALE = 2 * 60 * 60 * 1000; // nothing for this long reads as idle, whatever the last row says
const MAX_EVENTS = 30;
const MAX_TIMES = 600; // tool call times kept for the sparkline
const MAX_MARKS = 64; // assistant rows kept for telling a new message from the calling one

// promptAt: the newest user row that is not only call results and not a meta row such as an injected skill body (a
// typed prompt, or the interrupt notice).
// marks: the newest assistant rows as { at, mid }, mid being the message id they belong to (null when absent).
// results: the ids of the newest calls that got their result, at most MAX_MARKS (a question's notice ends on its own).
function newSession(id) {
  return { id, title: null, customTitle: null, cwd: null, branch: null, firstAt: null, lastAt: null, toolCount: 0, lastToolAt: null, toolTimes: [], events: [], last: null, promptAt: null, marks: [], results: [], calls: [], fails: [], checks: [], failRun: 0 };
}

const MAX_FAILS = 10;
const MAX_CHECKS = 6;
// A test, type check, lint or build run: its exit code is a check the chat passed or failed.
const CHECK = /\b(vitest|jest|playwright test|node --test|bun test|(?:npm|pnpm|yarn|bun) (?:run )?(?:test|lint|build|typecheck|check)\b|tsc\b|eslint|vite build|next build|pytest|cargo test)/i;
function checkOf(b) {
  if (!b || (b.name !== "Bash" && b.name !== "PowerShell") || !b.input || typeof b.input.command !== "string") return null;
  const m = CHECK.exec(b.input.command);
  return m ? clip(b.input.description || m[1], 60) : null;
}

const VERB = { Read: "Reading", Edit: "Editing", MultiEdit: "Editing", Write: "Writing", NotebookEdit: "Editing" };
const SAY = {
  Bash: "Running a command", PowerShell: "Running PowerShell", Grep: "Searching code", Glob: "Finding files",
  WebSearch: "Searching the web", TodoWrite: "Updating the plan", AskUserQuestion: "Asking you a question", ExitPlanMode: "Presenting a plan",
};
const clip = (s, n = 80) => {
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
};
const base = (p) => String(p).split(/[\\/]/).pop();

// A short label for one tool call.
function actionOf(b) {
  const i = (b && b.input) || {};
  const name = (b && b.name) || "tool";
  const file = i.file_path || i.notebook_path;
  if (VERB[name] && file) return `${VERB[name]} ${base(file)}`;
  if ((name === "Bash" || name === "PowerShell") && i.description) return clip(i.description);
  if (name === "WebFetch") {
    try {
      return `Reading ${new URL(i.url).host}`;
    } catch {
      return "Reading a web page";
    }
  }
  if ((name === "Agent" || name === "Task") && i.description) return clip(`Delegating: ${i.description}`);
  if (name === "Skill" && i.skill) return clip(`Using ${i.skill}`);
  if (name.startsWith("mcp__")) return `Using ${name.split("__")[1]}`;
  return SAY[name] || VERB[name] || `Using ${name}`;
}

function foldSession(s, row) {
  if (row.type === "ai-title" && row.aiTitle) {
    s.title = row.aiTitle;
    return s;
  }
  // a name the owner gave the chat in VS Code wins over the one Claude Code made up, as VS Code shows it
  if (row.type === "custom-title" && typeof row.customTitle === "string" && row.customTitle.trim()) {
    s.customTitle = row.customTitle;
    return s;
  }
  if (row.isSidechain || (row.type !== "user" && row.type !== "assistant")) return s;
  const at = Date.parse(row.timestamp);
  if (!Number.isFinite(at)) return s;
  if (row.cwd) s.cwd = row.cwd;
  if (row.gitBranch) s.branch = row.gitBranch;
  if (s.firstAt == null) s.firstAt = at;
  s.lastAt = at;
  const content = row.message && Array.isArray(row.message.content) ? row.message.content : [];
  if (row.type === "user") {
    const raw = row.message && row.message.content;
    const onlyResults = Array.isArray(raw) && raw.every((b) => b && b.type === "tool_result");
    if (!onlyResults && !row.isMeta && (s.promptAt == null || at > s.promptAt)) s.promptAt = at;
    for (const b of content) {
      if (!b || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      s.results.push(b.tool_use_id);
      if (s.results.length > MAX_MARKS) s.results.shift();
      // a failed call (a refused one, or a command that exited non-zero) and the run of failures it extends
      const call = s.calls.find((c) => c.id === b.tool_use_id);
      const bad = b.is_error === true;
      if (bad) {
        s.fails.push({ at, label: call ? call.label : "A tool call" });
        if (s.fails.length > MAX_FAILS) s.fails.shift();
        s.failRun++;
      } else s.failRun = 0;
      if (call && call.check) {
        s.checks.push({ at, label: call.check, ok: !bad });
        if (s.checks.length > MAX_CHECKS) s.checks.shift();
      }
    }
  } else {
    s.marks.push({ at, mid: row.message && typeof row.message.id === "string" ? row.message.id : null });
    if (s.marks.length > MAX_MARKS) s.marks.shift();
  }
  let asks = false;
  if (row.type === "assistant")
    for (const b of content) {
      if (!b || b.type !== "tool_use") continue;
      s.toolCount++;
      s.lastToolAt = at;
      s.toolTimes.push(at);
      if (s.toolTimes.length > MAX_TIMES) s.toolTimes.shift();
      if (b.name === "AskUserQuestion") asks = true;
      const label = actionOf(b);
      s.events.push({ at, tool: b.name, label });
      if (s.events.length > MAX_EVENTS) s.events.shift();
      if (typeof b.id === "string") {
        s.calls.push({ id: b.id, label, check: checkOf(b) });
        if (s.calls.length > MAX_MARKS) s.calls.shift();
      }
    }
  s.last = { type: row.type, at, stop: (row.message && row.message.stop_reason) || null, asks };
  return s;
}

function statusOf(s, now) {
  const L = s.last;
  if (!L || now - L.at > STALE) return "idle";
  if (L.type === "assistant" && (L.asks || L.stop === "end_turn")) return "needs-you";
  if (L.type === "assistant" && L.stop === "tool_use" && now - L.at <= TOOL_MAX) return "working"; // a tool is still running
  if (s.lastToolAt != null && now - s.lastToolAt <= MIN) return "working";
  if (now - L.at <= MIN) return "thinking";
  return "idle";
}

// Actions per `width` ms over the last n of them, oldest first; the newest bucket ends at now.
function sparkOf(s, now, n = 30, width = MIN) {
  const out = new Array(n).fill(0);
  for (const t of s.toolTimes) {
    const k = Math.floor((now - t) / width);
    if (k >= 0 && k < n) out[n - 1 - k]++;
  }
  return out;
}

module.exports = { newSession, foldSession, statusOf, actionOf, sparkOf, clip, checkOf };

// ---------- What a figure's monitors show ----------
// The newest step of a transcript (a tool call, or a reply's text) as its screen draws it: the call's input, then its
// result once that lands. Raw text is kept (at most RAW characters of each), and cut and capped only when a screen is
// built (screenOf), so a long first read never pays for screens nobody looks at. SCREEN_STEPS steps keep their inputs:
// the pages that list steps need the newest 10, which is this one constant.
const { cutSecrets, screenLines, screenRows, secretFile, configFile, barOf, barLine } = require("./describe");
const SCREEN_STEPS = 1;
const SCREEN = { width: 160, lines: 30, bytes: 4096, out: 20, steps: 6, files: 8, label: 80, file: 60 };
const RAW = 16384; // characters of an input or a result kept to build a screen from
const EDIT_RAW = 4096, EDITS_KEPT = 10; // of each old and new text of an edit, and of a MultiEdit's edits
const TOOLS_KEPT = 64; // the newest tool call ids, so a result names its call (a screenshot is learned only from a screenshot call)
const PLAYWRIGHT = /^mcp__[A-Za-z0-9_-]{0,64}playwright[A-Za-z0-9_-]{0,64}__browser_([a-z_]{1,64})$/i;
const BROWSER_VERBS = new Set(["navigate", "snapshot", "click", "type"]);
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const PAGE_URL = /^- Page URL: (.+)$/m, PAGE_TITLE = /^- Page Title: (.+)$/m;
// an inline snapshot: its heading and fence found by a line-anchored regex, its end by indexOf (a lazy
// match to the closing fence would scan the rest of the text again from every unclosed heading)
const SNAP_HEAD = /^### Snapshot\r?\n```yaml\r?\n/m;
const snapshotText = (out) => {
  const h = SNAP_HEAD.exec(out);
  if (!h) return null;
  const from = h.index + h[0].length;
  let end = out.indexOf("\n```", from);
  if (end < 0) return null;
  if (out[end - 1] === "\r") end--;
  return out.slice(from, end);
};
// a Playwright error's text: its "### Error" section, to the next section (the real format)
const ERROR_HEAD = /^### Error\r?\n/m;
const errorText = (out) => {
  const h = ERROR_HEAD.exec(out);
  if (!h) return null;
  const from = h.index + h[0].length, end = out.indexOf("\n### ", from);
  return out.slice(from, end < 0 ? out.length : end);
};
const SHOT_LINK = /^- \[Screenshot of [^\]\n]{0,256}\]\(([^)\n]{1,1024})\)/m;
const LINKS = /^Links: (\[.*\])$/m;
const ELLIPSIS = String.fromCharCode(0x2026);
const first = (s, n = RAW) => (typeof s === "string" ? s.slice(0, n) : "");
// the newest RAW characters; when that cuts into a line, the cut line goes, or its first 256 characters when it is over
// 1 KB (the kept part could start inside a secret's name, sword":"... with its value)
const last = (s) => {
  if (typeof s !== "string") return "";
  if (s.length <= RAW || s[s.length - RAW - 1] === "\n") return s.slice(-RAW);
  const t = s.slice(-RAW), nl = t.indexOf("\n");
  return nl >= 0 && nl <= 1024 ? t.slice(nl + 1) : t.slice(256);
};
// Whether last() keeps a long line's end (its first 256 characters dropped). A secret's name can straddle that cut, so
// the screen draws the kept fragment as a bar.
const cutsLine = (s) => {
  if (typeof s !== "string" || s.length <= RAW || s[s.length - RAW - 1] === "\n") return false;
  const nl = s.slice(-RAW).indexOf("\n");
  return !(nl >= 0 && nl <= 1024);
};
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x && x.type === "text" && typeof x.text === "string").map((x) => x.text).join("\n") : "");

function newScreens() {
  return { steps: [], tools: new Map(), page: null, snapshot: null, shot: null, files: [], ver: 0, built: new Map() };
}
function kindOf(name) {
  if (EDITS.has(name)) return "edit";
  if (name === "Bash" || name === "PowerShell") return "shell";
  if (name === "Read") return "read";
  if (name === "Grep" || name === "Glob") return "search";
  if (name === "WebFetch") return "browser";
  if (name === "WebSearch") return "web";
  const m = PLAYWRIGHT.exec(name);
  if (m && m[1] === "take_screenshot") return "shot";
  return m && BROWSER_VERBS.has(m[1]) ? "browser" : "other";
}
// A step from a tool call: its kind and the part of its input its screen shows.
function stepOf(b, at, v) {
  const i = b.input && typeof b.input === "object" ? b.input : {};
  const st = { id: b.id, at, tool: b.name, kind: kindOf(b.name), done: false, error: false, result: "" };
  const pair = (o, n) => [first(o, EDIT_RAW), first(n, EDIT_RAW)];
  if (st.kind === "edit") {
    st.file = String(i.file_path || i.notebook_path || "");
    st.edits = b.name === "MultiEdit" ? (Array.isArray(i.edits) ? i.edits : []).slice(0, EDITS_KEPT).map((e) => pair(e && e.old_string, e && e.new_string))
      : b.name === "Write" ? [pair("", i.content)] : b.name === "NotebookEdit" ? [pair("", i.new_source)] : [pair(i.old_string, i.new_string)];
  } else if (st.kind === "read") st.file = String(i.file_path || "");
  else if (st.kind === "shell") st.input = first(i.command);
  else if (st.kind === "search") { st.input = first(i.pattern); st.path = first(i.path); }
  else if (st.kind === "web") st.input = first(i.query);
  else if (st.kind === "browser" || st.kind === "shot") {
    const named = typeof i.url === "string" && i.url;
    st.url = first(named ? i.url : v.page ? v.page.url : "");
    st.title = !named && v.page ? v.page.title : null;
  } else st.label = actionOf(b);
  return st;
}
function pushStep(v, st) {
  v.steps.push(st);
  if (v.steps.length > SCREEN_STEPS) v.steps.shift();
}
// The files the figure touched, newest first: an edit marks a file edited for good, a read alone does not.
function touch(v, name, i) {
  const p = i && (i.file_path || i.notebook_path);
  if (typeof p !== "string" || !p || !(EDITS.has(name) || name === "Read")) return;
  const was = v.files.find((f) => f.path === p);
  v.files = [{ path: p, name: base(p), edit: name !== "Read" || !!(was && was.edit) }, ...v.files.filter((f) => f !== was)].slice(0, SCREEN.files);
}
// A Playwright result: the page it shows (its Page section, written when the page changed), the snapshot's text when it
// is inline, and a screenshot call's file, a path relative to the user's home or the chat's folder.
function learnPage(v, verb, out, at) {
  const u = PAGE_URL.exec(out);
  if (u) {
    const t = PAGE_TITLE.exec(out);
    v.page = { url: first(u[1].trim()), title: t ? first(t[1].trim()) : null };
  }
  const s = snapshotText(out);
  if (s != null && v.page) v.snapshot = { url: v.page.url, text: first(s) };
  if (verb === "take_screenshot") {
    const m = SHOT_LINK.exec(out);
    if (m) v.shot = { rel: m[1].trim(), url: v.page ? v.page.url : null, at };
  }
}
function foldScreen(v, row) {
  if (row.isSidechain || (row.type !== "user" && row.type !== "assistant")) return v;
  const at = Date.parse(row.timestamp);
  if (!Number.isFinite(at)) return v;
  v.ver = (v.ver || 0) + 1; // a row of the figure's own: its built screens are stale (screenOf)
  const content = row.message && Array.isArray(row.message.content) ? row.message.content : [];
  for (const b of content) {
    if (!b) continue;
    if (row.type === "assistant" && b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      pushStep(v, { id: null, at, tool: null, kind: "reply", done: true, error: false, result: first(b.text) });
    } else if (row.type === "assistant" && b.type === "tool_use" && typeof b.name === "string") {
      v.tools.set(b.id, b.name);
      if (v.tools.size > TOOLS_KEPT) v.tools.delete(v.tools.keys().next().value);
      touch(v, b.name, b.input);
      pushStep(v, stepOf(b, at, v));
    } else if (row.type === "user" && b.type === "tool_result") {
      const name = v.tools.get(b.tool_use_id), out = textOf(b.content), m = name ? PLAYWRIGHT.exec(name) : null;
      if (m) learnPage(v, m[1], out, at);
      const st = v.steps.find((x) => x.id && x.id === b.tool_use_id);
      if (!st) continue;
      st.done = true;
      st.error = b.is_error === true;
      st.result = st.kind === "shell" ? last(out) : first(out);
      if (st.kind === "shell") st.fragment = cutsLine(out);
      if ((st.kind === "browser" || st.kind === "shot") && m && v.page) Object.assign(st, { url: v.page.url, title: v.page.title });
    }
  }
  return v;
}

// At most n code points (no emoji cut in half); a cut line ends in an ellipsis.
const fit = (s, n = SCREEN.width) => {
  const c = [...String(s)];
  return c.length > n ? c.slice(0, n - 1).join("") + ELLIPSIS : c.join("");
};
const firstLine = (s, rows = screenRows(s)) => {
  const L = rows.map((r) => r.line).filter((l) => l.trim());
  if (!L.length) return "";
  const b = barOf(L[0]); // a hidden first line is its bar alone, from the left
  return b ? barLine(0, b.len) : fit(L[0] + (L.length > 1 ? " " + ELLIPSIS : ""));
};
// A command that prints secrets: one that is a secret line (yq .db.password, gh auth token), or one with a word naming
// a secret file (cat .env, Get-Content .npmrc). Its whole output hides.
const COMMAND_WORDS = /[\s;|&<>()=,]+/, QUOTED = /^["'`]+|["'`]+$/g;
const secretCommand = (cmd, rows = screenRows(cmd)) => typeof cmd === "string" && !!cmd.trim() && (rows.some((r) => r.hidden) || cmd.split(COMMAND_WORDS).some((w) => !!w && secretFile(w.replace(QUOTED, ""))));
// Prose wrapped at the line width on spaces, so a paragraph reads whole instead of being cut.
function wrap(lines) {
  const out = [];
  for (const l of lines) {
    let rest = [...l];
    while (rest.length > SCREEN.width) {
      let k = rest.lastIndexOf(" ", SCREEN.width);
      if (k <= 0) k = SCREEN.width;
      out.push(rest.slice(0, k).join(""));
      rest = rest.slice(rest[k] === " " ? k + 1 : k);
    }
    out.push(rest.join(""));
  }
  return out;
}
// An edit as the editor's diff: up to 2 unchanged lines either side, the removed lines, then the added ones; a change
// too long for the screen keeps at least a third of it for each side. Old and new lines are matched by their text
// before any is hidden, so a changed secret line still shows as removed and added; an unchanged line
// hidden on either side (the value under a password: line only the new text has) shows hidden.
function diffLines(edits, config = false) {
  const out = [], opt = config ? { config: true } : undefined; // a config file's old and new text: a line needs its ancestry
  for (const [o, n] of edits) {
    const A = screenRows(o, opt), B = screenRows(n, opt);
    let p = 0;
    while (p < A.length && p < B.length && A[p].key === B[p].key) p++;
    let q = 0;
    while (q < A.length - p && q < B.length - p && A[A.length - 1 - q].key === B[B.length - 1 - q].key) q++;
    const same = (i, j) => (A[i].hidden || !B[j].hidden ? A[i].line : B[j].line); // the same line, hidden if either side hides it
    const before = A.slice(Math.max(0, p - 2), p).map((r, k) => same(Math.max(0, p - 2) + k, Math.max(0, p - 2) + k));
    const after = A.slice(A.length - q, A.length - q + 2).map((r, k) => same(A.length - q + k, B.length - q + k));
    const gone = A.slice(p, A.length - q).map((r) => r.line), added = B.slice(p, B.length - q).map((r) => r.line);
    const room = Math.max(2, SCREEN.lines - out.length - before.length - after.length);
    const g = gone.length + added.length <= room ? gone.length : Math.min(gone.length, Math.max(room - added.length, Math.floor(room / 3)));
    out.push(...before.map((l) => " " + l), ...gone.slice(0, g).map((l) => "-" + l), ...added.slice(0, room - g).map((l) => "+" + l), ...after.map((l) => " " + l));
    if (out.length >= SCREEN.lines) break;
  }
  return out.slice(0, SCREEN.lines); // a later change's context lines can pass the cap
}
// A web search's result titles (its Links line), else its text.
function titlesOf(text) {
  const m = LINKS.exec(text);
  if (m) {
    try {
      const a = JSON.parse(m[1]);
      if (Array.isArray(a)) return a.map((x) => (x && typeof x.title === "string" ? x.title : "")).filter(Boolean).join("\n");
    } catch {}
  }
  return text;
}
// The screen of the newest step, every string cut and capped: { kind, tool, at, done, error, head, title, lines, shot,
// steps, files } and `secret` for a secrets file. `events` are the figure's session events (the left screen's newest 6
// steps); `shot` is the id the server issued for the screenshot it shows, or null. At most SCREEN.bytes as JSON.
// A built screen is kept on the fold, by screenshot id, until a row is folded in or a newer event arrives:
// HQ asks for every figure's screen on every refresh, and its text is cut once, not on each.
function screenOf(v, events = [], shot = null) {
  if (!v) return null;
  const ev = events.length ? events[events.length - 1] : null, k = String(shot);
  if (!(v.built instanceof Map)) v.built = new Map();
  const had = v.built.get(k);
  if (had && had.ver === v.ver && had.ev === ev && had.n === events.length) return had.sc;
  const sc = buildScreen(v, events, shot);
  if (v.built.size >= 4 && !had) v.built.clear();
  v.built.set(k, { ver: v.ver, ev, n: events.length, sc });
  return sc;
}
function buildScreen(v, events, shot) {
  const st = v && v.steps[v.steps.length - 1];
  if (!st) return null;
  const sc = {
    kind: st.kind, tool: st.tool, at: st.at, done: st.done, error: st.error, head: null, title: null, lines: [], shot: null,
    steps: events.slice(-SCREEN.steps).reverse().map((e) => ({ at: e.at, label: fit(cutSecrets(e.label), SCREEN.label) })),
    files: v.files.map((f) => ({ name: fit(cutSecrets(f.name), SCREEN.file), edit: f.edit })),
  };
  let tail = false; // a terminal over budget keeps its newest lines
  if (st.kind === "edit" || st.kind === "read") {
    sc.head = fit(cutSecrets(base(st.file)), SCREEN.file);
    const config = configFile(st.file);
    if (secretFile(st.file)) sc.secret = true;
    else sc.lines = st.kind === "edit" ? diffLines(st.edits, config) : st.done ? screenLines(st.result, config ? { config: true } : undefined).slice(0, SCREEN.lines) : [];
  } else if (st.kind === "shell") {
    const rows = screenRows(st.input); // the command's rows, cut once for its head and for whether it prints secrets
    sc.head = firstLine(st.input, rows);
    if (st.done) sc.lines = screenLines(st.result, secretCommand(st.input, rows) ? { all: true } : st.fragment ? { fragment: true } : undefined).slice(-SCREEN.out);
    tail = true;
  } else if (st.kind === "search") {
    sc.head = firstLine(st.input);
    sc.title = st.tool;
    if (st.done) sc.lines = screenLines(st.result, st.tool === "Grep" ? { grep: true, grepFile: configFile(st.path), all: !!st.path && secretFile(st.path) } : undefined).slice(0, SCREEN.lines);
  } else if (st.kind === "web") {
    sc.head = firstLine(st.input);
    if (st.done) sc.lines = screenLines(titlesOf(st.result)).slice(0, SCREEN.lines);
  } else if (st.kind === "browser" || st.kind === "shot") {
    sc.head = firstLine(st.url);
    sc.title = st.title ? firstLine(st.title) : null;
    sc.shot = shot;
    const page = st.tool === "WebFetch" ? (st.done ? st.result : "") : v.snapshot && v.snapshot.url === st.url ? v.snapshot.text : "";
    const err = st.done && st.tool !== "WebFetch" ? errorText(st.result) : null; // a Playwright call that failed shows why
    if (err != null) { sc.error = true; sc.lines = wrap(screenLines(err)).slice(0, SCREEN.lines); }
    else if (!shot && page) sc.lines = wrap(screenLines(page)).slice(0, SCREEN.lines);
  } else if (st.kind === "reply") sc.lines = wrap(screenLines(st.result)).slice(0, SCREEN.lines);
  else sc.head = fit(cutSecrets(st.label), SCREEN.label);
  sc.lines = sc.lines.map((l) => fit(l));
  const over = () => Buffer.byteLength(JSON.stringify(sc)) > SCREEN.bytes;
  while (sc.lines.length && over()) tail ? sc.lines.shift() : sc.lines.pop();
  while (sc.steps.length && over()) sc.steps.pop();
  while (sc.files.length && over()) sc.files.pop();
  return sc;
}
// The screenshot the newest step's screen shows, { rel, url, at } as its result named it, or null: a screenshot step's
// own (once its result names the file), or for a browser step the chat's newest one when it was taken on that page.
function shotOf(v) {
  const st = v && v.steps[v.steps.length - 1];
  if (!st || !v.shot || (st.kind !== "shot" && st.kind !== "browser")) return null;
  if (st.kind === "shot") return st.done && v.shot.at >= st.at ? v.shot : null;
  return v.shot.url && v.shot.url === st.url ? v.shot : null;
}
// the result parsers, by name, for the timing test (test/screen-time.test.mjs)
const SCREEN_PARSERS = { playwright: PLAYWRIGHT, pageUrl: PAGE_URL, pageTitle: PAGE_TITLE, snapshot: snapshotText, error: errorText, errorHead: ERROR_HEAD, shotLink: SHOT_LINK, links: LINKS,
  commandWords: COMMAND_WORDS, quoted: QUOTED, secretCommand };
Object.assign(module.exports, { newScreens, foldScreen, screenOf, shotOf, SCREEN_STEPS, SCREEN, SCREEN_PARSERS });
