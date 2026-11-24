// The plan meter and the accounts strip's data (lib/accounts.js): the usage-line mod's last reading
// (vibequarters-usage/plan-usage.json) lands on its account's row in vibequarters-usage/accounts.json, keyed by the salted hash
// the mod writes; a passed reset rolls forward a week; the next account to reset is picked; labels come from the config;
// no email or account id is ever stored or shown.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { planOf, rollForward, upsert, nextOf, accountsOf, WEEK } = require("../lib/accounts");

const NOW = Date.parse("2025-01-15T12:00:00.000Z");
const K1 = "k1aaaaaaaaaaaaaaaaaaaaaa"; // salted hashes as the mod writes them: opaque text
const K2 = "k2bbbbbbbbbbbbbbbbbbbbbb";
const K3 = "k3cccccccccccccccccccccc";
const seed = () => [
  { accountKey: K1, resetsAt: "2025-01-16T10:00:00.000Z", lastSeenPct: 30, seenAt: "2025-01-09T10:00:00.000Z" },
  { accountKey: K2, resetsAt: "2025-01-17T10:00:00.000Z", lastSeenPct: 12, seenAt: "2025-01-13T12:00:00.000Z" },
  { accountKey: K3, resetsAt: "2025-01-20T10:00:00.000Z" },
];
const roots = [];
test.after(async () => {
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
function tmp(rows = seed()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-accounts-"));
  roots.push(dir);
  const files = { file: path.join(dir, "vibequarters-usage", "accounts.json"), planFile: path.join(dir, "vibequarters-usage", "plan-usage.json") };
  fs.mkdirSync(path.dirname(files.file));
  if (rows) fs.writeFileSync(files.file, JSON.stringify({ v: 1, accounts: rows }));
  return files;
}
const reading = (o) => JSON.stringify({ v: 1, accountKey: K3, seven_day: 82.4, five_hour: 33.6, resetsAt: "2025-01-20T10:00:00.000Z", at: NOW, ...o });

test("the plan meter's reading: the weekly and 5-hour figures rounded, the reset as a time, the account's key", () => {
  const f = tmp(null);
  assert.equal(planOf(f.planFile), null, "no file yet");
  fs.writeFileSync(f.planFile, reading());
  assert.deepEqual(planOf(f.planFile), { pct: 82, fiveHour: 34, resetsAt: Date.parse("2025-01-20T10:00:00.000Z"), at: NOW, accountKey: K3 });
  fs.writeFileSync(f.planFile, reading({ five_hour: undefined, resetsAt: Date.parse("2025-01-20T10:00:00.000Z"), accountKey: "bad key!" }));
  assert.deepEqual(planOf(f.planFile), { pct: 82, fiveHour: null, resetsAt: Date.parse("2025-01-20T10:00:00.000Z"), at: NOW, accountKey: null }, "a reset in ms works too; a key of another shape is dropped");
  fs.writeFileSync(f.planFile, reading({ seven_day: "82" }));
  assert.equal(planOf(f.planFile), null, "no weekly figure, no meter");
  fs.writeFileSync(f.planFile, "{half");
  assert.equal(planOf(f.planFile), null);
});

test("a reset in the past rolls forward whole weeks to the first one after now; a future one stays", () => {
  const t = Date.parse("2025-01-16T10:00:00.000Z");
  assert.equal(rollForward(t, NOW), t);
  assert.equal(rollForward(t, t), t + WEEK); // the reset moment itself has passed
  assert.equal(rollForward(t - 3 * WEEK, NOW), t);
  assert.equal(rollForward(NaN, NOW), null);
});

test("a reading lands on the row with its key, keeps the row's other fields, and reports a change", () => {
  const rows = seed();
  rows[2].note = "kept";
  const r = upsert(rows, { key: K3, resetsAt: Date.parse("2025-01-20T10:00:00.000Z"), pct: 82, at: NOW });
  assert.equal(r.changed, true);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[2], { accountKey: K3, resetsAt: "2025-01-20T10:00:00.000Z", note: "kept", lastSeenPct: 82, seenAt: "2025-01-15T12:00:00.000Z" });
  assert.equal(upsert(r.rows, { key: K3, resetsAt: Date.parse("2025-01-20T10:00:00.000Z"), pct: 82, at: NOW }).changed, false);
  const n = upsert(seed(), { key: "k4dddddddd", resetsAt: NOW + 1000, pct: 1, at: NOW });
  assert.deepEqual([n.rows.length, n.rows[3].accountKey], [4, "k4dddddddd"], "an account not seen before gets a new row at the end");
});

test("next = the soonest reset after now among the accounts not signed in", () => {
  const rows = seed().map((r) => ({ ...r, resetsAt: Date.parse(r.resetsAt) }));
  assert.equal(nextOf(rows, K3, NOW), 0);
  assert.equal(nextOf(rows, K1, NOW), 1);
  assert.equal(nextOf([rows[2]], K3, NOW), -1); // only the signed-in one
});

test("accountsOf: the reading is saved once, rows roll forward, current and next are marked, labels come from the config", () => {
  const f = tmp();
  fs.writeFileSync(f.planFile, reading());
  const later = NOW + 864e5; // Thursday 12:00Z: the first account's Thursday 10:00Z reset has passed, the second's Friday one has not
  const v = accountsOf({ ...f, labels: { [K3]: "Work", [K1]: "Personal" }, now: later });
  const saved = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(saved.v, 1);
  assert.equal(saved.accounts[2].lastSeenPct, 82);
  assert.equal(saved.accounts[0].resetsAt, "2025-01-16T10:00:00.000Z"); // the file keeps the reading; only the view rolls
  assert.deepEqual(
    v.rows.map((r) => [r.label, new Date(r.resetsAt).toISOString(), r.current, r.next]),
    [
      ["Personal", "2025-01-23T10:00:00.000Z", false, false],
      ["Account 1", "2025-01-17T10:00:00.000Z", false, true],
      ["Work", "2025-01-20T10:00:00.000Z", true, false],
    ],
  );
  assert.ok(v.rows.every((r) => !("accountKey" in r) && !("email" in r)), "the page gets labels, never keys or emails");
  const mtime = fs.statSync(f.file).mtimeMs;
  accountsOf({ ...f, now: later }); // nothing new: no write
  assert.equal(fs.statSync(f.file).mtimeMs, mtime);
});

test("accountsOf: the first reading makes the file; no reading and no file gives null; a sealed copy writes nothing", () => {
  const f = tmp(null);
  assert.equal(accountsOf({ ...f, now: NOW }), null);
  fs.writeFileSync(f.planFile, reading());
  const sealed = accountsOf({ ...f, now: NOW, record: false });
  assert.deepEqual(sealed.rows.map((r) => [r.label, r.current]), [["Account 1", true]]);
  assert.equal(fs.existsSync(f.file), false, "record: false writes nothing");
  accountsOf({ ...f, now: NOW });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), { v: 1, accounts: [{ accountKey: K3, resetsAt: "2025-01-20T10:00:00.000Z", lastSeenPct: 82, seenAt: "2025-01-15T12:00:00.000Z" }] });
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)).sort(), ["accounts.json", "plan-usage.json"], "no temp file is left");
});

test("accountsOf: a reading with no key is never guessed onto a row; a missing plan still shows the rows, none current", () => {
  const f = tmp();
  fs.writeFileSync(f.planFile, reading({ accountKey: undefined, seven_day: 40 }));
  const v = accountsOf({ ...f, now: NOW });
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).accounts.some((r) => r.lastSeenPct === 40), false);
  assert.equal(v.rows.filter((r) => r.current).length, 0);
  fs.unlinkSync(f.planFile);
  const w = accountsOf({ ...f, now: NOW });
  assert.equal(w.rows.length, 3);
  assert.equal(w.rows.filter((r) => r.next).length, 1);
  // a row of another shape (an old file holding something else) is skipped, never shown
  fs.writeFileSync(f.file, JSON.stringify({ v: 1, accounts: [{ accountKey: K1, resetsAt: "2025-01-16T10:00:00.000Z" }, { email: "x" }, null] }));
  assert.equal(accountsOf({ ...f, now: NOW }).rows.length, 1);
});
