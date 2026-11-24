// The Queue panel's data: who holds the heavy-job gate and who waits on it, the coordination locks, the sessions,
// the open requests and the batches in flight. Read-only by design: it reads the coordination folder (registry.json,
// heavy-claims/, shell-hygiene.log, batches/, reviews/) and never writes, renames or removes anything there.
// The rules mirror the system pack's hooks that own those files (coord-lib.js and shell-hygiene-lib.js in
// <systemDir>/hooks), so the panel says what `coord.js` and `heavy-gate.cjs status` say. Without the system pack the
// folder is simply empty and so is the panel.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const LIVE_MS = 72 * 3600e3; // coord-lib LIVE_MS: a session unseen this long is no longer live
const LOCK_TTL_MS = 20 * 60e3; // coord-lib LOCK_TTL_MS: an older lock blocks nobody
const REQUEST_OVERDUE_MS = 15 * 60e3; // after this the requester may force-handoff
const CLOSED_SHOWN_MS = 24 * 3600e3; // closed sessions stay listed this long
const WAIT_MS = 5 * 60e3; // a session denied by the gate this recently, and not let in since, still waits
const CPU_WINDOW_READS = 6; // a CPU figure averages at most this many read intervals (60 s), else it is re-measured
const START_MAX_CPU = 75; // shell-hygiene-lib START_MAX_CPU
const GRACE_MS = 30e3, CLOCK_SLACK_MS = 60e3, FG_SPAN_MS = 660e3, BG_SPAN_MS = 30 * 60e3; // shell-hygiene-lib claim rules
// the system pack's standard locks, always listed; any other lock name in the registry is listed after them
const LOCK_NAMES = ["merge", "db-migration", "edge-deploy", "prod-deploy"];
const REQ_ID = /^req-[0-9a-f]{6}$/;
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/; // owner/name, the only shape ever passed to gh
const LOG_TAIL = 64 * 1024;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

// The heavy-job claims as the gate reads them (readClaims + alive), without its clean-up: a dead claim is
// skipped here, never removed. `procs` is the running command lines, or null when unknown (then a claim holds
// until its own end, as in the gate). `markerAlive` is the gate's own matcher when the hooks are installed.
function gateHolders(dir, now, procs, markerAlive) {
  const out = [];
  for (const f of list(path.join(dir, "heavy-claims")).filter((n) => n.endsWith(".json"))) {
    const c = readJson(path.join(dir, "heavy-claims", f));
    if (!c || typeof c.started !== "number" || typeof c.until !== "number" || typeof c.command !== "string") continue;
    if (c.started > now + CLOCK_SLACK_MS || c.until - c.started > (c.background ? BG_SPAN_MS : FG_SPAN_MS) + CLOCK_SLACK_MS) continue;
    if (now >= c.until) continue;
    const starting = now - c.started < GRACE_MS;
    if (!starting && procs && markerAlive && !markerAlive(c.marker, procs)) continue;
    out.push({ ...c, starting });
  }
  return out.sort((a, b) => a.started - b.started);
}

// Who the gate turned away lately and has not let in since, from the gate's own log lines:
//   <iso> deny heavy cpu <n>% <session8> <command>     <iso> take <fg|bg> cpu <n>% <session8> <marker> <command>
function gateWaiters(logText, now) {
  const last = new Map();
  for (const line of String(logText).split("\n")) {
    const m = /^(\S+) (deny heavy|take (?:fg|bg)) cpu (\d+)% ([0-9a-f]{8}) /.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at)) continue;
    last.set(m[4], { at, denied: m[2] === "deny heavy", cpu: Number(m[3]) });
  }
  return [...last].filter(([, v]) => v.denied && now - v.at <= FG_SPAN_MS).map(([id8, v]) => ({ id8, at: v.at, cpu: v.cpu }));
}

function tail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Plain words for what a heavy job is, from its claim's marker (shell-hygiene-lib MARKERS, script:, run:).
function jobWords(marker) {
  const m = String(marker || "any").split("|")[0];
  if (/^(vitest|bun-test|playwright)$/.test(m)) return "Running tests";
  if (m === "tsc") return "Checking the code";
  if (m === "vite" || m === "vercel") return "Building the site";
  if (m === "ffmpeg") return "Rendering a video";
  if (m === "git-commit") return "Saving a commit";
  if (m.startsWith("run:")) return `Running "${m.slice(4)}"`;
  if (m.startsWith("script:")) return "Running a script";
  return "A heavy job";
}

const LOCK_WORDS = { merge: "Merging", "db-migration": "Changing the database", "edge-deploy": "Deploying server functions", "prod-deploy": "Deploying the live site" };

// A member PR's review, as the land gate reads its file (review-proof.js proveOne): "clean" when line 1 names this
// head and the last line is a CLEAN verdict with 0 Critical and 0 Important; "unproven" when its last VERDICT line is
// clean but the gate cannot use it (head not named on line 1, or text after the verdict, as in older reviews);
// "problems" for any other review; "none" when there is no file. Like the gate's verdictOf, a verdict quoted in
// code (inside a fence, indented 4 spaces or a tab, or on a fence line) or followed by anything but blank lines
// and rules is never the reviewer's own.
const CLEAN_LINE = /^VERDICT\s*:\s*CLEAN\s*[-:]\s*0 Critical\s*,\s*0 Important\s*,\s*\d+ Minors?\.?$/i; // review-proof.js CLEAN_LINE
const bare = (l) => l.replace(/[*`]/g, "").trim();
function inCode(raws, at) {
  if (/^ {0,3}\t| {4}/.test(raws[at].match(/^\s*/)[0])) return true; // indented code
  let fence = null; // CommonMark fences, as review-proof.js reads them
  for (let i = 0; i < at; i++) {
    const f = raws[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null; }
    else if (f && !(f[1][0] === "`" && f[2].includes("`"))) fence = f[1];
  }
  return fence !== null;
}
function reviewState(file, head) {
  let body;
  try { body = fs.readFileSync(file, "utf8"); } catch { return "none"; }
  const lines = body.split(/\r?\n/);
  const named = (/\bhead ([0-9a-f]{7,40})\b/i.exec(lines[0] || "") || [])[1];
  const raws = lines.slice(1);
  const at = raws.map((r) => /^VERDICT\s*:/i.test(bare(r))).lastIndexOf(true);
  const verdict = at < 0 ? "" : bare(raws[at]);
  // after the verdict only blank lines and rules, read raw and bare, as verdictOf reads them
  const after = raws.slice(at + 1);
  const own = at >= 0 && !/^\s*(```|~~~)/.test(raws[at]) && !inCode(raws, at) &&
    after.every((r) => /^[\s\-=_*]*$/.test(r)) && after.map(bare).filter(Boolean).every((l) => /^[-=_~]+$/.test(l));
  if (named && named.toLowerCase() === String(head).toLowerCase() && own && CLEAN_LINE.test(verdict)) return "clean";
  // which words to show: the reviewer's own last verdict, skipping any quoted in code
  let mine = "";
  for (let i = raws.length - 1; i >= 0 && !mine; i--) if (/^VERDICT\s*:/i.test(bare(raws[i])) && !/^\s*(```|~~~)/.test(raws[i]) && !inCode(raws, i)) mine = bare(raws[i]);
  const noBlockers = /\b0 Critical\b/i.test(mine) && /\b0 Important\b/i.test(mine) && !/NOT CLEAN/i.test(mine); // older wordings too
  return noBlockers ? "unproven" : "problems";
}

// A batch PR's CI in one word, from the checks merge-batch.js requires before it lands a batch (config
// queue.requiredChecks, the same names the system pack's merge gate is given): passed, failed, running, skipped, or
// none when a required check is not on the PR. Other checks (a preview deploy) never decide it; their failures are
// counted apart. With no required checks configured, every check on the PR counts as required.
const FAILED = /^(FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE)$/;
const checkName = (c) => String(c.name || c.context || "");
const checkWord = (c) => String(c.conclusion || c.state || "").toUpperCase();
function oneState(c) {
  const w = checkWord(c);
  if (FAILED.test(w)) return "failed";
  if (w === "SUCCESS") return "passed";
  if ((c.status && String(c.status).toUpperCase() !== "COMPLETED") || /^(|PENDING|EXPECTED|QUEUED|IN_PROGRESS|WAITING|REQUESTED|STALE)$/.test(w)) return "running"; // gh buckets STALE as pending
  return "skipped"; // SKIPPED, NEUTRAL: done but not a pass, so merge-batch refuses it
}
const ORDER = ["failed", "none", "running", "skipped", "passed"]; // the worst word of the required checks wins
function ciState(rollup, required = null) {
  const checks = Array.isArray(rollup) ? rollup : [];
  // a re-run leaves the older run in the rollup; like `gh pr checks` (merge-batch), only the latest run counts
  const runs = latest(checks);
  const names = required && required.length ? required : [...runs.keys()];
  if (!names.length) return "none";
  const words = names.map((n) => (runs.has(n) ? oneState(runs.get(n)) : "none"));
  return ORDER.find((w) => words.includes(w));
}
const otherFailures = (rollup, required = null) => (required && required.length ? [...latest(Array.isArray(rollup) ? rollup : [])].filter(([n, c]) => !required.includes(n) && FAILED.test(checkWord(c))).length : 0);
// The latest run of each check by name, newest start first as gh dedupes them; a run still going reports
// completedAt as year 1, so start time decides, and a missing or year-1 date counts as unknown (0).
function latest(checks) {
  const when = (c) => { const t = Date.parse(c.startedAt || c.createdAt || ""); return Number.isFinite(t) && t > 0 ? t : 0; };
  const out = new Map();
  for (const c of [...checks].sort((a, b) => when(b) - when(a))) if (!out.has(checkName(c))) out.set(checkName(c), c);
  return out;
}

// The snapshot from what was read: pure, so the tests drive it with fixed inputs.
// `requiredChecks` is the config's list (or null: every check counts); `liveCheck` says whether a claim past its start is
// checked against the running processes: "on", "no-hooks" (the system pack's shell-hygiene-lib.js is not installed) or
// "unavailable" (the process list is read on Windows only); without it a claim holds until its own end, as in the gate.
function queueView({ reg, holders, waiters, cpu, batches, openPrs, mainSha = {}, reviewed, now, requiredChecks = null, liveCheck = "on" }) {
  const sessions = (reg && reg.sessions) || {};
  const label = (id) => (sessions[id] && sessions[id].name) || String(id || "").slice(0, 8);
  const byId8 = (id8) => Object.values(sessions).find((s) => String(s.id).startsWith(id8));
  const isLive = (s) => Boolean(s && !s.endedAt && now - (s.lastSeen || 0) < LIVE_MS);
  const claims = (reg && reg.claims) || [];
  const count = new Map();
  for (const c of claims) count.set(c.session, (count.get(c.session) || 0) + 1);

  const holder = holders[0] || null;
  const gate = {
    cpu: cpu == null ? null : Math.round(cpu),
    startMax: START_MAX_CPU,
    holder: holder && { job: jobWords(holder.marker), session: label(holder.session), since: holder.started, background: !!holder.background, starting: holder.starting },
    others: holders.length - (holder ? 1 : 0),
    liveCheck,
  };
  // with no CPU figure yet and no holder the gate's answer is unknown, never "free"
  gate.state = holder ? "busy" : gate.cpu == null ? "measuring" : gate.cpu >= START_MAX_CPU ? "cpu" : "free";
  // A denied session keeps waiting while the gate stays shut (its wait loop logs nothing), up to the longest a
  // foreground job can hold it; once the gate is free, only a denial in the last 5 min still counts.
  gate.waiting = waiters
    .filter((w) => now - w.at <= WAIT_MS || (gate.state !== "free" && now - w.at <= FG_SPAN_MS))
    .map((w) => { const s = byId8(w.id8); return { session: s ? s.name : w.id8, at: w.at, cpu: w.cpu }; })
    .sort((a, b) => a.at - b.at);

  const extra = Object.keys((reg && reg.locks) || {}).filter((n) => !LOCK_NAMES.includes(n) && /^[\w.-]{1,40}$/.test(n)).sort();
  const locks = [...LOCK_NAMES, ...extra].map((name) => {
    const l = reg && reg.locks && reg.locks[name];
    if (!l) return { name, words: LOCK_WORDS[name] || name, holder: null };
    const blocks = isLive(sessions[l.session]) && now - l.at <= LOCK_TTL_MS;
    return { name, words: LOCK_WORDS[name] || name, holder: label(l.session), since: l.at, stale: !blocks };
  });

  const shownSessions = Object.values(sessions)
    .filter((s) => s && s.id && (isLive(s) || (s.endedAt && now - s.endedAt <= CLOSED_SHOWN_MS)))
    .map((s) => ({ name: s.name || String(s.id).slice(0, 8), task: String(s.task || "").replace(/\s*>\s*\/dev\/null[\s\S]*$/, "").trim(), lastSeen: s.lastSeen || null, files: count.get(s.id) || 0, live: isLive(s) }))
    .sort((a, b) => (b.live - a.live) || ((b.lastSeen || 0) - (a.lastSeen || 0)));

  const requests = ((reg && reg.requests) || [])
    .filter((q) => q && REQ_ID.test(q.id) && q.state === "open")
    // force-handoff is allowed after 15 min, or at once when the owner has closed (coord-requests.js)
    .map((q) => ({ id: q.id, from: label(q.from), to: label(q.to), path: String(q.path || ""), at: q.at, ownerClosed: !isLive(sessions[q.to]), overdue: now - (q.at || now) > REQUEST_OVERDUE_MS }))
    .sort((a, b) => a.at - b.at);

  // In flight = its batch PR is open on GitHub, a member PR is still open, and no newer open batch carries one of its
  // members (a rebuilt batch replaces the old one, whose PR often stays open). The rest are counted as leftovers.
  // With GitHub unknown nothing is guessed; a repo GitHub cannot read hides only its own batches (counted apart).
  // A batch merge-batch.js planLand would refuse to land ("rebuild the batch") says why: its batch PR moved off the
  // tested head, main moved off its base, or a member PR moved off its tested head.
  let inFlight = null, leftover = 0, unread = 0;
  if (openPrs) {
    inFlight = [];
    const taken = new Set();
    // a count, but the page says only "some": old abandoned records make the number meaningless
    unread = batches.filter((b) => b.batchPr && !openPrs[b.repo]).length;
    const open = batches
      .filter((b) => b.batchPr && openPrs[b.repo] && openPrs[b.repo].has(b.batchPr))
      .sort((a, b) => String(b.id).localeCompare(String(a.id)));
    for (const b of open) {
      const prs = openPrs[b.repo];
      const members = b.members || [];
      const key = (m) => `${b.repo}#${m.pr}`;
      const stillOpen = members.filter((m) => prs.has(m.pr)).length;
      // with no member open it is done or replaced (a stopped batch's members often land later in a newer batch;
      // merge-batch verify tells the user directly when every member landed but main does not match)
      if (!stillOpen || members.some((m) => taken.has(key(m)))) { leftover++; continue; }
      for (const m of members) taken.add(key(m));
      const bp = prs.get(b.batchPr);
      const moved = (m) => Boolean(prs.has(m.pr) && prs.get(m.pr).headRefOid && prs.get(m.pr).headRefOid !== m.head);
      // planLand's refusals hold only before landing starts; once a batch is landing, each merged member moves main
      // on purpose. A batch that stopped before any member left the open list must be rebuilt (merge-batch.js
      // verify); one stopped later may need the rest landed in order or a rebuild, which only verify's words tell.
      const nothingLanded = b.state === "partial" && stillOpen === members.length;
      const landing = !nothingLanded && (b.state === "landing" || b.state === "partial")
        ? { merged: members.length - stillOpen, total: members.length, partial: b.state === "partial", moved: members.some(moved) } : null;
      const rebuild = landing ? null
        : nothingLanded ? "nothing"
        : bp.headRefOid && b.head && bp.headRefOid !== b.head ? "batch"
        : mainSha[b.repo] && b.base && mainSha[b.repo] !== b.base ? "main"
        : members.some(moved) ? "member" : null;
      inFlight.push({
        id: b.id, repo: String(b.repo).split("/").pop(), batchPr: b.batchPr, ci: ciState(bp.statusCheckRollup, requiredChecks), otherFailed: otherFailures(bp.statusCheckRollup, requiredChecks), rebuild, landing,
        members: members.map((m) => ({ pr: m.pr, title: String(m.title || ""), moved: moved(m), review: reviewed(b.repo, m.pr, m.head) })),
      });
    }
  }

  return { at: now, gate, locks, sessions: shownSessions, requests, batches: inFlight, leftoverBatches: leftover, unreadBatches: unread };
}

// The reader HQ's server polls: cached for `everyMs`; CPU is the busy share since the last read, the process
// list (only while a claim is past its start) and GitHub's open pull requests are fetched in the background
// and used from the next read on, so a read never blocks the server. A process list older than two reads is
// unknown, so a claim then holds until its own end, as in the gate. `hooksDir` is the system pack's hooks folder
// (<systemDir>/hooks), whose shell-hygiene-lib.js gives the gate's own process matcher; null, or a folder without that
// file, loads no hook code. `github: false` asks GitHub nothing (a sealed copy). The process list is read with
// PowerShell on Windows only; elsewhere the panel says that check is not available. Config (queue): `repos`, when
// given, the only repositories GitHub is asked about (other batches are left out); `requiredChecks`, the check names a
// batch needs to land; `mainBranch`, the branch a batch lands on (default "main").
const BRANCH = /^[\w./-]{1,100}$/;
function createQueue({ dir, hooksDir = null, github = true, everyMs = 10e3, ghEveryMs = 60e3, run = execFile, cpus = () => os.cpus(), markerAlive = null, platform = process.platform, repos: onlyRepos = null, requiredChecks = null, mainBranch = "main" } = {}) {
  if (!markerAlive && hooksDir) try { markerAlive = require(path.join(hooksDir, "shell-hygiene-lib.js")).markerAlive || null; } catch {}
  if (typeof markerAlive !== "function") markerAlive = null;
  const liveCheck = platform !== "win32" ? "unavailable" : markerAlive ? "on" : "no-hooks";
  const branch = typeof mainBranch === "string" && BRANCH.test(mainBranch) ? mainBranch : "main";
  const times = () => cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });
  let sample = times(), sampleAt = null, cpu = null, cached = null, cachedAt = 0;
  let procs = null, procsFor = 0, procsAt = -Infinity, procsBusy = false;
  const prs = {}; // repo -> { map, at, busy, done }

  function scanProcs(now) {
    if (procsBusy || now - procsAt < everyMs || platform !== "win32") return;
    procsBusy = true;
    procsAt = now;
    const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.Name -notmatch '^(bash|sh|zsh|dash|powershell|pwsh|cmd|conhost)\\.exe$' } | ForEach-Object { $_.CommandLine -replace '[\\r\\n]+', ' ' }";
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 10e3, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      procsBusy = false;
      procsFor = now; // the list is as old as the read that asked for it
      procs = err || !out ? null : String(out).split(/\r?\n/).filter(Boolean);
    });
  }

  // Per repo, at most once per ghEveryMs: its open PRs (number, head, checks) and main's tip, the two things
  // merge-batch.js checks before it lands a batch. A list is trusted for 3 x ghEveryMs after its last success,
  // so a gh that starts failing (expired login) turns the panel to "could not be read", never frozen words.
  function fetchPrs(repo, now) {
    const p = (prs[repo] = prs[repo] || { map: null, okAt: -Infinity, main: null, at: -Infinity, busy: 0, done: false });
    if (p.busy || now - p.at < ghEveryMs) return;
    p.busy = 2;
    p.at = now; // asked from the time of asking
    const opts = { windowsHide: true, timeout: 30e3, maxBuffer: 32 * 1024 * 1024 };
    run("gh", ["pr", "list", "-R", repo, "--state", "open", "--limit", "1000", "--json", "number,headRefOid,statusCheckRollup"], opts, (err, out) => {
      p.busy--;
      p.done = true;
      try {
        if (err) throw err;
        p.map = new Map(JSON.parse(out).map((x) => [x.number, x]));
        p.okAt = now;
      } catch {} // the last good list stays until it is too old to trust
    });
    run("gh", ["api", `repos/${repo}/git/ref/heads/${branch}`, "--jq", ".object.sha"], opts, (err, out) => {
      p.busy--;
      const sha = String(out || "").trim();
      p.main = !err && /^[0-9a-f]{40}$/.test(sha) ? sha : null; // unknown main: no rebuild is claimed on its account
    });
  }
  const usable = (r, now) => prs[r] && prs[r].map && now - prs[r].okAt <= 3 * ghEveryMs;

  function read(now = Date.now()) {
    if (cached && now - cachedAt < everyMs) return cached;
    // CPU over the time since the last read; after a long gap (the Dashboard hidden, a fresh start) that is no
    // recent figure, so it shows as being measured until the next read
    const next = times();
    const total = next.total - sample.total;
    cpu = sampleAt != null && now - sampleAt <= CPU_WINDOW_READS * everyMs && total > 0 ? 100 * (1 - (next.idle - sample.idle) / total) : null;
    sample = next;
    sampleAt = now;

    const reg = readJson(path.join(dir, "registry.json"));
    // the scan is asked for by every claim past its start, judged before any process list, so a list taken
    // when no job ran can never hide a job that started after it
    if (gateHolders(dir, now, null, null).some((h) => !h.starting)) scanProcs(now);
    const fresh = procs && now - procsFor <= 2 * everyMs ? procs : null;
    const holders = gateHolders(dir, now, fresh, markerAlive);
    const waiters = gateWaiters(tail(path.join(dir, "shell-hygiene.log"), LOG_TAIL), now);

    const batches = list(path.join(dir, "batches")).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(dir, "batches", f))).filter((b) => b && b.id && typeof b.repo === "string" && REPO.test(b.repo) && b.state !== "landed" && Array.isArray(b.members) && (!onlyRepos || onlyRepos.includes(b.repo)));
    const repos = [...new Set(batches.map((b) => b.repo))];
    if (github) for (const r of repos) fetchPrs(r, now);
    const readable = github ? repos.filter((r) => usable(r, now)) : [];
    const openPrs = github && (readable.length || !repos.length) ? Object.fromEntries(readable.map((r) => [r, prs[r].map])) : null;
    const mainSha = Object.fromEntries(readable.filter((r) => prs[r].main).map((r) => [r, prs[r].main]));
    const reviewed = (repo, pr, head) => reviewState(path.join(dir, "reviews", `${String(repo).split("/").pop()}-${pr}-${head}.txt`), head);

    cached = queueView({ reg, holders, waiters, cpu, batches, openPrs, mainSha, reviewed, now, requiredChecks, liveCheck });
    cached.present = fs.existsSync(dir); // no coordination folder at all: the page hides the panel
    cached.github = !github ? "off" : repos.length && !openPrs ? (repos.some((r) => prs[r] && prs[r].done) ? "unreadable" : "loading") : "ok";
    cachedAt = now;
    return cached;
  }
  return { read };
}

module.exports = { createQueue, queueView, gateHolders, gateWaiters, ciState, jobWords, reviewState };
