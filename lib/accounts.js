// The plan meter and the accounts strip under it. The system pack's usage-line mod writes the signed-in account's last
// plan reading to <dataDir>/vibequarters-usage/plan-usage.json:
//   { v: 1, accountKey, seven_day, five_hour, resetsAt, at }
// where accountKey is a salted hash of the account id (the salt is made per install), never an email or the id itself.
// VibeQuarters keeps one row per account it has seen in <dataDir>/vibequarters-usage/accounts.json:
//   { v: 1, accounts: [{ accountKey, resetsAt, lastSeenPct, seenAt }] }
// and saves each reading onto its row, so the strip can show every account's weekly reset, which one is signed in now
// (the account of the latest reading) and which resets next. The names shown are the labels the user sets in the
// config (accountLabels: { "<accountKey>": "Work" }); an account without one is "Account 1", "Account 2", in the order
// first seen. Nothing here reads ~/.claude.json, and no email or account id is ever stored or shown.
// A reset comes every seven days at one fixed time, so one already past is shown a week later until the next reading.
const fs = require("fs");
const path = require("path");

const WEEK = 7 * 864e5;
const KEY = /^[A-Za-z0-9_-]{6,128}$/;
const FILE_MAX = 256 * 1024;

function readJson(file) {
  try {
    if (fs.statSync(file).size > FILE_MAX) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
const timeOf = (t) => (typeof t === "number" ? t : Date.parse(t));
const pctOf = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(100, Math.round(x))) : null);

// The weekly plan limit's last reading for the plan meter: { pct, fiveHour, resetsAt, at, accountKey }, or null when
// the file is missing, not v1-shaped or holds no weekly figure
function planOf(planFile) {
  const j = readJson(planFile);
  if (!j || typeof j !== "object" || !Number.isFinite(j.seven_day)) return null;
  const resetsAt = timeOf(j.resetsAt);
  const at = timeOf(j.at);
  return {
    pct: pctOf(j.seven_day),
    fiveHour: pctOf(j.five_hour),
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    at: Number.isFinite(at) ? at : null,
    accountKey: typeof j.accountKey === "string" && KEY.test(j.accountKey) ? j.accountKey : null,
  };
}

// The first reset after now, in whole weeks from t; null when t is not a time
function rollForward(t, now) {
  if (!Number.isFinite(t)) return null;
  return t > now ? t : t + Math.floor((now - t) / WEEK + 1) * WEEK;
}

// One reading { key, resetsAt, pct, at } onto its row (by key; else a new row at the end); the row's other fields stay.
// changed is false when the row already says the same, so the caller writes only on news.
function upsert(rows, reading) {
  const i = rows.findIndex((r) => r.accountKey === reading.key);
  const old = i < 0 ? {} : rows[i];
  const row = { ...old, accountKey: reading.key, resetsAt: new Date(reading.resetsAt).toISOString(), lastSeenPct: reading.pct, seenAt: new Date(reading.at).toISOString() };
  const changed = ["accountKey", "resetsAt", "lastSeenPct", "seenAt"].some((k) => old[k] !== row[k]);
  if (!changed) return { rows, changed };
  const out = rows.slice();
  if (i < 0) out.push(row);
  else out[i] = row;
  return { rows: out, changed };
}

// The index of the soonest reset after now among the accounts other than the signed-in one; rows carry ms times
function nextOf(rows, current, now) {
  let best = -1;
  rows.forEach((r, i) => {
    if (r.accountKey !== current && r.resetsAt > now && (best < 0 || r.resetsAt < rows[best].resetsAt)) best = i;
  });
  return best;
}

// Written with temp plus rename, so a reader never sees half a file; a failure leaves the last good file
function save(file, data) {
  const tmp = file + ".tmp" + process.pid;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

// The strip's view: { rows: [{ label, resetsAt (ms, rolled forward), lastSeenPct, seenAt, current, next }] } in the order
// the accounts were first seen; null with no account known. Saves the plan reading onto its row first (and makes the
// file on the first reading), unless `record` is false (a sealed copy writes nothing).
function accountsOf({ file, planFile, labels = {}, now = Date.now(), record = true }) {
  const saved = readJson(file);
  let rows = saved && Array.isArray(saved.accounts) ? saved.accounts.filter((r) => r && typeof r.accountKey === "string" && KEY.test(r.accountKey)) : [];
  const plan = planOf(planFile);
  if (plan && plan.accountKey && Number.isFinite(plan.resetsAt)) {
    const r = upsert(rows, { key: plan.accountKey, resetsAt: plan.resetsAt, pct: plan.pct, at: plan.at || now });
    if (r.changed) {
      rows = r.rows;
      if (record) save(file, { v: 1, accounts: rows }); // unsaved, the next read tries again; the strip still shows it
    }
  }
  if (!rows.length) return null;
  const current = plan ? plan.accountKey : null;
  const view = rows.map((r) => ({ accountKey: r.accountKey, resetsAt: rollForward(Date.parse(r.resetsAt), now), lastSeenPct: Number.isFinite(r.lastSeenPct) ? r.lastSeenPct : null, seenAt: r.seenAt || null }));
  const next = nextOf(view, current, now);
  let n = 0;
  return {
    rows: view.map((r, i) => {
      const own = labels && typeof labels[r.accountKey] === "string" ? labels[r.accountKey] : null;
      return { label: own || `Account ${++n}`, resetsAt: r.resetsAt, lastSeenPct: r.lastSeenPct, seenAt: r.seenAt, current: !!current && r.accountKey === current, next: i === next };
    }),
  };
}

module.exports = { WEEK, KEY, planOf, rollForward, upsert, nextOf, accountsOf };
