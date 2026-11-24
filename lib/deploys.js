// The deploy wall: production deploys of one GitHub repository, read through the gh CLI the user is already signed into,
// so VibeQuarters holds no token of its own. Which signal counts as a deploy comes from the config (`deploys`):
//   provider "vercel" (the default): the commit statuses Vercel posts on each commit of the deploy branch, context
//     "Vercel" (pending when its build starts, success, failure or error when it ends);
//   provider "status": the same, for any host that posts commit statuses, under the context the config names;
//   provider "checks": a GitHub Actions job (or any check run) by name, as a check run on each commit.
// Off (null) when the config has no `deploys`. A finished deploy is never asked about again.
const { execFile } = require("child_process");

const BASE_MS = 5 * 60e3; // a production build's usual length until three finished ones say otherwise
const SLOW = 2; // a build running past this many usual lengths is called slow
const FAST_MS = 15e3; // poll this often while a build runs
const IDLE_MS = 60e3; // and this often otherwise
const COMMITS = 5;
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const BRANCH = /^[\w./-]{1,100}$/;
const NAME = /^[^\u0000-\u001f"\\]{1,100}$/; // a status context or check name: one line, no quote or backslash for the jq filter
const PROVIDERS = new Set(["vercel", "status", "checks"]);

function gh(args) {
  return new Promise((resolve, reject) =>
    execFile("gh", args, { timeout: 20e3, windowsHide: true, maxBuffer: 1 << 20 }, (e, out) => (e ? reject(e) : resolve(out))));
}

// The deploy one commit's statuses describe: started at its first pending, ended at its last final status.
function deployOf(statuses) {
  const l = statuses.filter((s) => s && typeof s.state === "string" && Number.isFinite(Date.parse(s.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!l.length) return null;
  const pend = l.find((s) => s.state === "pending");
  const end = l[l.length - 1];
  const state = end.state === "pending" ? "building" : end.state === "success" ? "ready" : "failed";
  return { state, startedAt: Date.parse((pend || end).at), endedAt: state === "building" ? null : Date.parse(end.at) };
}

// The deploy one commit's check runs of the named job describe: the latest run decides. Queued or running is building;
// success is ready; skipped or neutral is no deploy at all; anything else (failure, cancelled, timed out) failed.
function deployOfChecks(runs) {
  const l = runs.filter((r) => r && typeof r.status === "string" && Number.isFinite(Date.parse(r.startedAt))).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  if (!l.length) return null;
  const r = l[l.length - 1];
  const startedAt = Date.parse(r.startedAt);
  if (r.status !== "completed") return { state: "building", startedAt, endedAt: null };
  if (r.conclusion === "skipped" || r.conclusion === "neutral") return null;
  const endedAt = Number.isFinite(Date.parse(r.completedAt)) ? Date.parse(r.completedAt) : startedAt;
  return { state: r.conclusion === "success" ? "ready" : "failed", startedAt, endedAt };
}

// The config's deploy wall, checked: { repo, branch, provider, context, check, usualMs } or null when it is not usable
function deploySource(c) {
  if (!c || typeof c !== "object") return null;
  const provider = c.provider === undefined ? "vercel" : c.provider;
  const branch = c.branch === undefined ? "main" : c.branch;
  if (typeof c.repo !== "string" || !REPO.test(c.repo) || typeof branch !== "string" || !BRANCH.test(branch) || !PROVIDERS.has(provider)) return null;
  const context = c.context === undefined ? (provider === "checks" ? null : "Vercel") : c.context;
  if (provider !== "checks" && !(typeof context === "string" && NAME.test(context))) return null;
  if (provider === "checks" && !(typeof c.check === "string" && NAME.test(c.check))) return null;
  const usualMs = Number.isFinite(c.usualMinutes) && c.usualMinutes > 0 ? c.usualMinutes * 60e3 : BASE_MS;
  return { repo: c.repo, branch, provider, context: provider === "checks" ? null : context, check: provider === "checks" ? c.check : null, usualMs };
}

function createDeploys(config, { run = gh } = {}) {
  const src = deploySource(config);
  const done = new Map(); // sha -> its finished deploy
  let list = [];
  let error = null;
  let nextAt = 0;
  let busy = false;

  async function deployFor(sha) {
    if (src.provider === "checks") {
      const runs = JSON.parse(await run(["api", `repos/${src.repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(src.check)}&per_page=30`, "--jq", "[.check_runs[] | {status: .status, conclusion: .conclusion, startedAt: .started_at, completedAt: .completed_at}]"]));
      return deployOfChecks(Array.isArray(runs) ? runs : []);
    }
    const st = JSON.parse(await run(["api", `repos/${src.repo}/commits/${sha}/statuses?per_page=30`, "--jq", `[.[] | select(.context == "${src.context}") | {state: .state, at: .created_at}]`]));
    return deployOf(Array.isArray(st) ? st : []);
  }

  async function poll(now = Date.now()) {
    if (!src || busy || now < nextAt) return false;
    busy = true;
    try {
      const commits = JSON.parse(await run(["api", `repos/${src.repo}/commits?sha=${encodeURIComponent(src.branch)}&per_page=${COMMITS}`, "--jq", "[.[] | {sha: .sha, subject: (.commit.message | split(\"\\n\") | .[0]), at: .commit.committer.date}]"]));
      const out = [];
      for (const c of commits) {
        if (!c || typeof c.sha !== "string" || !/^[0-9a-f]{7,40}$/.test(c.sha)) continue;
        let d = done.get(c.sha);
        if (!d) {
          d = await deployFor(c.sha);
          if (d && d.state !== "building") done.set(c.sha, d);
        }
        if (d) out.push({ sha: c.sha.slice(0, 9), subject: String(c.subject || "").slice(0, 120), ...d });
      }
      list = out;
      error = null;
      nextAt = now + (out.some((d) => d.state === "building") ? FAST_MS : IDLE_MS);
      return true;
    } catch (e) {
      error = (e && (e.code === "ENOENT" ? "gh is not installed" : String(e.message || e).split("\n")[0].slice(0, 160))) || "gh failed";
      nextAt = now + IDLE_MS;
      return true;
    } finally {
      busy = false;
    }
  }

  // The list as the page shows it: each build's length so far, the usual length from the last finished ones, and
  // whether a running one is past twice that.
  function view(now = Date.now()) {
    if (!src) return null;
    const lens = [...done.values()].filter((d) => d.state === "ready").map((d) => d.endedAt - d.startedAt).sort((a, b) => a - b);
    const usual = lens.length >= 3 ? lens[Math.floor(lens.length / 2)] : src.usualMs;
    return {
      repo: src.repo, branch: src.branch, provider: src.provider, usual, error,
      items: list.map((d) => {
        const ms = (d.endedAt || now) - d.startedAt;
        return { ...d, ms, slow: d.state === "building" && ms > SLOW * usual };
      }),
    };
  }

  return { poll, view, on: !!src };
}

module.exports = { createDeploys, deployOf, deployOfChecks, deploySource, BASE_MS };
