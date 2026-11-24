// Weekly usage audit: the plan week that just ended against the one before, read-only, no model calls.
// Run it by hand or from a weekly scheduler after the plan's reset: node weekly-usage-audit.js [week-end ISO]
// Writes ~/.claude/vibequarters-usage/usage-audit/<week end>.md. Without a week end it needs the usage-line mod's
// ~/.claude/vibequarters-usage/plan-usage.json to know when the plan week resets.
const fs = require("fs"), path = require("path"), os = require("os"), readline = require("readline");
const HOME = os.homedir();
// The price table: the app's pricing.js when appDir names the app, else the copy the installer puts in <systemDir>/lib.
function pricingFile() {
  let appDir = "";
  try { const P = require("../hooks/vibequarters-config"); appDir = P.expand(P.load().appDir); } catch (_e) { appDir = ""; }
  const app = appDir ? path.join(appDir, "pricing.js") : "";
  return app && fs.existsSync(app) ? app : path.join(__dirname, "..", "lib", "pricing.js");
}
const { costForUsage } = require(pricingFile());
const USAGE = path.join(HOME, ".claude", "vibequarters-usage");
const ROOT = path.join(HOME, ".claude", "projects");
const WEEK = 7 * 24 * 3600e3;

// The latest reset at or before now, from the plan meter the usage-line mod saves.
function weekEnd() {
  if (process.argv[2]) return Date.parse(process.argv[2]);
  const r = Date.parse(JSON.parse(fs.readFileSync(path.join(USAGE, "plan-usage.json"), "utf8")).resetsAt);
  let e = r; while (e > Date.now()) e -= WEEK;
  return e;
}
const E = weekEnd(), B0 = E - 2 * WEEK, A0 = E - WEEK;
const week = (ts) => (ts >= A0 && ts < E ? "now" : ts >= B0 && ts < A0 ? "before" : null);

function walk(d, acc) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".jsonl") && fs.statSync(p).mtimeMs >= B0) acc.push(p);
  }
  return acc;
}
const W = () => ({ cost: 0, main: 0, sub: 0, opus: 0, review: 0, idle: 0, compacts: 0, calls: 0, sessions: new Set() });
const R = { now: W(), before: W() };
const sessions = new Map(); // sid -> { first prompt, cost this week }
const seen = new Set();

async function scan(file) {
  const rel = path.relative(ROOT, file).split(path.sep);
  const isSub = rel.includes("subagents");
  const sid = isSub ? rel[1] : path.basename(file, ".jsonl");
  const S = sessions.get(sid) || { prompt: "", now: 0 };
  sessions.set(sid, S);
  let meta = {};
  if (isSub) try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch (_e) {}
  const review = isSub && /review|verify|audit|check|critic|adversar|validate/i.test(meta.description || "");
  let lastTs = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.includes('"type":"assistant"') && line.includes('"usage"')) {
      let o; try { o = JSON.parse(line); } catch (_e) { continue; }
      const m = o.message, ts = Date.parse(o.timestamp || ""), k = week(ts);
      if (!m || !m.usage || !k || m.model === "<synthetic>") continue;
      const key = (m.id || "") + "|" + (o.requestId || "");
      if (seen.has(key)) continue; seen.add(key);
      const c = costForUsage(m.model, m.usage).cost || 0, X = R[k];
      X.cost += c; X.calls++; X.sessions.add(sid); X[isSub ? "sub" : "main"] += c;
      if (/opus/.test(m.model)) X.opus += c;
      if (review) X.review += c;
      const cw = m.usage.cache_creation_input_tokens || 0;
      if (!isSub && lastTs && cw > 30e3 && ts - lastTs > 60 * 60e3) X.idle += costForUsage(m.model, { cache_creation_input_tokens: cw, cache_creation: m.usage.cache_creation }).cost;
      lastTs = ts;
      if (k === "now") S.now += c;
    } else if (!isSub && line.includes('"compact_boundary"')) {
      const mm = /"timestamp":"([^"]+)"/.exec(line), k = mm && week(Date.parse(mm[1]));
      if (k) R[k].compacts++;
    } else if (!isSub && !S.prompt && line.includes('"type":"user"') && line.length < 300000) {
      let o; try { o = JSON.parse(line); } catch (_e) { continue; }
      if (o.isMeta || o.isCompactSummary || !o.message) continue;
      const c = o.message.content;
      const txt = (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text").map((b) => b.text).join(" ") : "").trim();
      if (txt && !/^(<task-notification>|<local-command|Caveat:|\[Request interrupted)/.test(txt)) S.prompt = txt.replace(/\s+/g, " ").slice(0, 80);
    }
  }
}

const $ = (n) => "$" + Math.round(n).toLocaleString("en-US");
const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "-");
const change = (a, b) => (b ? (a >= b ? "+" : "") + Math.round((100 * (a - b)) / b) + "%" : "-");

(async () => {
  const files = walk(ROOT, []);
  files.sort((a, b) => (a.includes("subagents") ? 1 : 0) - (b.includes("subagents") ? 1 : 0)); // first prompts before subagents
  for (const f of files) await scan(f);
  const [a, b] = [R.now, R.before];
  const rows = [
    ["Total (API-equivalent)", a.cost, b.cost, $],
    ["Per day", a.cost / 7, b.cost / 7, $],
    ["Main threads", a.main, b.main, $],
    ["Subagents", a.sub, b.sub, $],
    ["Review subagents", a.review, b.review, $],
    ["Idle-wake rebuilds (60+ min gap)", a.idle, b.idle, $],
    ["Opus share", a.opus, b.opus, (v, t) => pct(v, t)],
    ["Compactions", a.compacts, b.compacts, String],
    ["Sessions", a.sessions.size, b.sessions.size, String],
  ];
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  let md = `# Claude usage, week ending ${day(E)}\n\nWeek ${day(A0)} to ${day(E)} against the week before. Calculated from local transcripts with API list prices. Plan limits are not measured in dollars.\n\n| | This week | Week before | Change |\n|---|---|---|---|\n`;
  for (const [label, x, y, f] of rows) {
    const isShare = label === "Opus share";
    md += `| ${label} | ${isShare ? f(x, a.cost) : f(x)} | ${isShare ? f(y, b.cost) : f(y)} | ${isShare ? "" : change(x, y)} |\n`;
  }
  const flags = rows.filter(([l, x, y]) => l !== "Opus share" && l !== "Per day" && y > 0 && x > y * 1.25 && x >= a.cost * 0.03);
  md += `\n## Worth a look\n\n${flags.length ? flags.map(([l, x, y]) => `- ${l} grew ${change(x, y)} (${typeof x === "number" && l.match(/Compactions|Sessions/) ? x : $(x)}).`).join("\n") : "- Nothing grew more than 25% week over week."}\n`;
  const top = [...sessions.entries()].filter(([, s]) => s.now > 0).sort((x, y) => y[1].now - x[1].now).slice(0, 5);
  md += `\n## Top sessions this week\n\n| Session | Cost | First ask |\n|---|---|---|\n${top.map(([id, s]) => `| ${id.slice(0, 8)} | ${$(s.now)} | ${s.prompt.replace(/\|/g, "/")} |`).join("\n")}\n`;
  const dir = path.join(USAGE, "usage-audit");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${day(E)}.md`);
  fs.writeFileSync(out, md);
  console.log(out, $(a.cost), "vs", $(b.cost));
})();
