// The Queue panel's reader (lib/queue.js): the gate's claims and waiters as the hooks read them, the locks, sessions,
// requests and batches as coord.js reads them, and never a write to the coordination folder.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createQueue, queueView, gateHolders, gateWaiters, ciState, reviewState } = require("../lib/queue");

const NOW = 1_700_000_000_000;
const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const C = "cccccccc-0000-0000-0000-000000000003";
const min = 60e3;
const reg = () => ({
  sessions: {
    [A]: { id: A, name: "alpha", task: "build the panel >/dev/null 2>&1", lastSeen: NOW - 2 * min },
    [B]: { id: B, name: "beta", task: "fix a bug", lastSeen: NOW - 5 * 3600e3 },
    [C]: { id: C, name: "gamma", lastSeen: NOW - 3 * 3600e3, endedAt: NOW - 3600e3 },
  },
  claims: [{ session: A, path: "a" }, { session: A, path: "b" }, { session: B, path: "c" }],
  locks: { merge: { session: A, at: NOW - 3 * min }, "db-migration": { session: C, at: NOW - 2 * min }, "prod-deploy": { session: B, at: NOW - 25 * min } },
  requests: [
    { id: "req-000001", state: "open", from: A, to: B, path: "src/x.ts", at: NOW - 20 * min },
    { id: "req-000002", state: "open", from: B, to: A, path: "src/y.ts", at: NOW - 2 * min },
    { id: "req-000003", state: "done", from: B, to: A, path: "src/z.ts", at: NOW - 2 * min },
    { id: "bad", state: "open", from: B, to: A, path: "src/w.ts", at: NOW },
  ],
});
const REQ = ["build"]; // the config's queue.requiredChecks in these tests
const view = (over = {}) => queueView({ reg: reg(), holders: [], waiters: [], cpu: 20, batches: [], openPrs: {}, reviewed: () => "none", now: NOW, requiredChecks: REQ, ...over });

function folder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-queue-"));
  fs.mkdirSync(path.join(dir, "heavy-claims"));
  fs.mkdirSync(path.join(dir, "batches"));
  fs.mkdirSync(path.join(dir, "reviews"));
  return dir;
}
const claim = (dir, name, c) => fs.writeFileSync(path.join(dir, "heavy-claims", name), JSON.stringify(c));

test("gate: a claim in its first 30 s holds, a finished or expired one does not, and nothing is removed", () => {
  const dir = folder();
  claim(dir, "1.json", { session: A, command: "bunx vitest run", marker: "vitest", started: NOW - 10e3, until: NOW + 120e3 });
  claim(dir, "2.json", { session: B, command: "tsc", marker: "tsc", started: NOW - 200e3, until: NOW - 1 });
  claim(dir, "3.json", { session: B, command: "x", started: NOW }); // bad shape
  const h = gateHolders(dir, NOW, null, null);
  assert.deepEqual(h.map((x) => x.session), [A]);
  assert.equal(h[0].starting, true);
  assert.deepEqual(fs.readdirSync(path.join(dir, "heavy-claims")).sort(), ["1.json", "2.json", "3.json"]);
});

test("gate: past its start a claim holds only while its process runs, and holds when the process list is unknown", () => {
  const dir = folder();
  claim(dir, "1.json", { session: A, command: "bunx vitest run", marker: "vitest", started: NOW - 60e3, until: NOW + 120e3 });
  const alive = (marker, procs) => procs.some((p) => p.includes(marker));
  assert.equal(gateHolders(dir, NOW, ["node vitest.mjs run"], alive).length, 1);
  assert.equal(gateHolders(dir, NOW, ["node server.js"], alive).length, 0);
  assert.equal(gateHolders(dir, NOW, null, alive).length, 1);
});

test("waiters: denied in the last 5 min and not let in since", () => {
  const iso = (t) => new Date(t).toISOString();
  const log = [
    `${iso(NOW - 2 * min)} deny heavy cpu 84% aaaaaaaa (`,
    `${iso(NOW - 3 * min)} deny heavy cpu 90% bbbbbbbb (`,
    `${iso(NOW - 1 * min)} take fg cpu 40% bbbbbbbb vitest bunx vitest run`,
    `${iso(NOW - 12 * min)} deny heavy cpu 99% cccccccc (`, // older than the longest foreground hold
    `${iso(NOW - 8 * min)} deny heavy cpu 90% dddddddd (`,
    `${iso(NOW - min)} fix cd aaaaaaaa cd x && y`,
  ].join("\n");
  assert.deepEqual(gateWaiters(log, NOW), [{ id8: "aaaaaaaa", at: NOW - 2 * min, cpu: 84 }, { id8: "dddddddd", at: NOW - 8 * min, cpu: 90 }]);
});

test("view: a denial over 5 min old still waits while the gate stays shut, and not once it is free", () => {
  const waiters = [{ id8: "aaaaaaaa", at: NOW - 8 * min, cpu: 90 }];
  assert.deepEqual(view({ waiters, cpu: 85 }).gate.waiting.map((w) => w.session), ["alpha"]);
  assert.deepEqual(view({ waiters, cpu: 20 }).gate.waiting, []);
});

test("view: the gate says busy, too busy, or free, and names who waits", () => {
  const holder = { session: A, marker: "vitest", started: NOW - 3 * min, background: false, starting: false };
  const busy = view({ holders: [holder], waiters: [{ id8: "bbbbbbbb", at: NOW - min, cpu: 80 }], cpu: 80 });
  assert.equal(busy.gate.state, "busy");
  assert.deepEqual(busy.gate.holder, { job: "Running tests", session: "alpha", since: NOW - 3 * min, background: false, starting: false });
  assert.deepEqual(busy.gate.waiting, [{ session: "beta", at: NOW - min, cpu: 80 }]);
  assert.equal(view({ cpu: 80 }).gate.state, "cpu");
  assert.equal(view({ cpu: 74.4 }).gate.state, "free");
  assert.equal(view({ cpu: null }).gate.state, "measuring"); // no figure yet is never "free"
});

test("view: a request to a closed owner is flagged at once", () => {
  const r = reg();
  r.requests.push({ id: "req-000004", state: "open", from: A, to: C, path: "src/q.ts", at: NOW - min });
  const q = Object.fromEntries(view({ reg: r }).requests.map((x) => [x.id, [x.ownerClosed, x.overdue]]));
  assert.deepEqual(q, { "req-000001": [false, true], "req-000002": [false, false], "req-000004": [true, false] });
});

test("clean only when line 1 names the head and the last line is a clean verdict, as the land gate reads it", () => {
  const dir = folder();
  const f = (name, body) => { const p = path.join(dir, "reviews", name); fs.writeFileSync(p, body); return p; };
  const head = "a".repeat(40);
  const line1 = `PR #1 head ${head}, agent x, session y`;
  assert.equal(reviewState(path.join(dir, "reviews", "missing.txt"), head), "none");
  assert.equal(reviewState(f("ok.txt", `${line1}\nAll good.\n**VERDICT: CLEAN - 0 Critical, 0 Important, 3 Minor**\n\n---\n`), head), "clean");
  assert.equal(reviewState(f("bad.txt", `${line1}\nVERDICT: NOT CLEAN - 1 Important\n`), head), "problems");
  // clean words the gate cannot use: text after the verdict, or another head on line 1
  assert.equal(reviewState(f("after.txt", `${line1}\nVERDICT: CLEAN - 0 Critical, 0 Important, 0 Minor\nI1 fixed: a getter.\n`), head), "unproven");
  assert.equal(reviewState(f("other.txt", `PR #1 head ${"b".repeat(40)}\nVERDICT: CLEAN - 0 Critical, 0 Important, 0 Minor\n`), head), "unproven");
  // a verdict quoted in code is never the reviewer's own, as in review-proof.js verdictOf
  const CLEAN = "VERDICT: CLEAN - 0 Critical, 0 Important, 0 Minor";
  assert.equal(reviewState(f("fenced.txt", `${line1}\nVERDICT: NOT CLEAN - 1 Important\n\`\`\`\n${CLEAN}\n\`\`\`\n`), head), "problems");
  assert.equal(reviewState(f("fenced2.txt", `${line1}\nNotes.\n~~~\n${CLEAN}\n`), head), "problems"); // no verdict of its own
  assert.equal(reviewState(f("indented.txt", `${line1}\nNotes.\n    ${CLEAN}\n`), head), "problems");
  assert.equal(reviewState(f("tilde-after.txt", `${line1}\n${CLEAN}\n~~~\n`), head), "unproven");
  assert.equal(reviewState(f("spaced-rule.txt", `${line1}\n${CLEAN}\n- - -\n`), head), "unproven"); // verdictOf refuses it too
  assert.equal(reviewState(f("rule.txt", `${line1}\n${CLEAN}\n---\n`), head), "clean");
  assert.equal(reviewState(f("old.txt", `${line1}\nVERDICT: 0 Critical, 0 Important, 4 Minor (second review)\n`), head), "unproven");
  assert.equal(reviewState(f("oldbad.txt", `${line1}\nVERDICT: 0 Critical, 1 Important, 7 Minor (second review)\n`), head), "problems");
  assert.equal(reviewState(f("late.txt", `${line1}\nVERDICT: CLEAN - 0 Critical, 0 Important, 0 Minor\nVERDICT: NOT CLEAN - 1 Important\n`), head), "problems");
  assert.equal(reviewState(f("plain.txt", "review"), head), "problems");
});

test("view: locks block only while their holder is live and under 20 min, like coord-lib lockHolder", () => {
  const l = Object.fromEntries(view().locks.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(l), ["merge", "db-migration", "edge-deploy", "prod-deploy"]);
  assert.equal(l.merge.holder, "alpha");
  assert.equal(l.merge.stale, false);
  assert.equal(l["db-migration"].stale, true); // gamma closed
  assert.equal(l["edge-deploy"].holder, null);
  assert.equal(l["prod-deploy"].stale, true); // 25 min old
});

test("view: sessions live (72 h) first, closed in the last day after, with claimed file counts", () => {
  const s = view().sessions;
  assert.deepEqual(s.map((x) => [x.name, x.live, x.files]), [["alpha", true, 2], ["beta", true, 1], ["gamma", false, 0]]);
  assert.equal(s[0].task, "build the panel");
  const old = reg();
  old.sessions[C].endedAt = NOW - 25 * 3600e3;
  assert.equal(view({ reg: old }).sessions.length, 2);
});

test("view: open requests only, oldest first, flagged after 15 min", () => {
  assert.deepEqual(view().requests.map((r) => [r.id, r.from, r.to, r.overdue]), [["req-000001", "alpha", "beta", true], ["req-000002", "beta", "alpha", false]]);
});

test("view: in flight = newest open batch PR per member, with a member still open; the rest count as leftovers", () => {
  const batches = [
    { id: "3", repo: "o/Repo", batchPr: 14, members: [{ pr: 10, head: "h10", title: "Ten" }] },
    { id: "2", repo: "o/Repo", batchPr: 12, members: [{ pr: 10, head: "old", title: "Ten" }, { pr: 11, head: "h11", title: "Eleven" }] }, // replaced by 14
    { id: "1", repo: "o/Repo", batchPr: 9, members: [{ pr: 5, head: "h5", title: "Merged" }] }, // its member is no longer open
    { id: "0", repo: "o/Repo", batchPr: 8, members: [{ pr: 11, head: "h11", title: "Eleven" }] }, // batch PR closed
  ];
  const pr = (n, rollup = []) => [n, { number: n, statusCheckRollup: rollup }];
  const openPrs = { "o/Repo": new Map([pr(14, [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }]), pr(12), pr(9), pr(10), pr(11)]) };
  const v = view({ batches, openPrs, reviewed: (repo, n, head) => (repo === "o/Repo" && n === 10 && head === "h10" ? "clean" : "none") });
  assert.deepEqual(v.batches, [{ id: "3", repo: "Repo", batchPr: 14, ci: "passed", otherFailed: 0, rebuild: null, landing: null, members: [{ pr: 10, title: "Ten", moved: false, review: "clean" }] }]);
  assert.equal(v.leftoverBatches, 2);
  assert.equal(view({ batches, openPrs: null }).batches, null);
});

test("view: a batch merge-batch would refuse says it needs a rebuild, and why (planLand's three checks)", () => {
  const base = "b".repeat(40), head = "c".repeat(40), m1 = "1".repeat(40);
  const batch = { id: "1", repo: "o/R", batchPr: 5, base, head, members: [{ pr: 4, head: m1, title: "Four" }] };
  const prs = (bpHead, memberHead) => ({ "o/R": new Map([[5, { headRefOid: bpHead, statusCheckRollup: [] }], [4, { headRefOid: memberHead }]]) });
  const one = (openPrs, mainSha) => view({ batches: [batch], openPrs, mainSha }).batches[0];
  assert.equal(one(prs(head, m1), { "o/R": base }).rebuild, null); // nothing moved: it can land
  assert.equal(one(prs("d".repeat(40), m1), { "o/R": base }).rebuild, "batch");
  assert.equal(one(prs(head, m1), { "o/R": "e".repeat(40) }).rebuild, "main"); // main moved on
  const moved = one(prs(head, "2".repeat(40)), { "o/R": base });
  assert.deepEqual([moved.rebuild, moved.members[0].moved], ["member", true]); // a new commit on the member
  assert.equal(one(prs(head, m1), {}).rebuild, null); // main unknown: no rebuild claimed on its account
});

test("view: a batch partway through landing shows its progress, never a rebuild (merge-batch verify: land the rest in order)", () => {
  const base = "b".repeat(40), head = "c".repeat(40);
  const members = [{ pr: 4, head: "1".repeat(40) }, { pr: 6, head: "3".repeat(40) }];
  const openPrs = { "o/R": new Map([[5, { headRefOid: head, statusCheckRollup: [] }], [6, { headRefOid: "3".repeat(40) }]]) }; // #4 merged
  const at = (state) => view({ batches: [{ id: "1", repo: "o/R", batchPr: 5, base, head, state, members }], openPrs, mainSha: { "o/R": "e".repeat(40) } }).batches[0];
  assert.deepEqual([at("landing").rebuild, at("landing").landing], [null, { merged: 1, total: 2, partial: false, moved: false }]);
  assert.deepEqual([at("partial").rebuild, at("partial").landing.partial], [null, true]);
  assert.deepEqual([at("opened").rebuild, at("opened").landing], ["main", null]); // before landing: main moving does need a rebuild
  // stopped before any member landed: merge-batch verify says rebuild the batch
  const allOpen = new Map([...openPrs["o/R"], [4, { headRefOid: "1".repeat(40) }]]);
  const none = view({ batches: [{ id: "1", repo: "o/R", batchPr: 5, base, head, state: "partial", members }], openPrs: { "o/R": allOpen } }).batches[0];
  assert.deepEqual([none.rebuild, none.landing], ["nothing", null]);
  // stopped partway long ago, every member merged since, its batch PR still open: a leftover
  const noneOpen = view({ batches: [{ id: "1", repo: "o/R", batchPr: 5, base, head, state: "partial", members }], openPrs: { "o/R": new Map([[5, openPrs["o/R"].get(5)]]) } });
  assert.deepEqual([noneOpen.leftoverBatches, noneOpen.batches], [1, []]);
  // a member not landed yet that changed its head cannot land as planned
  const movedOpen = new Map([...openPrs["o/R"], [6, { headRefOid: "9".repeat(40) }]]);
  assert.equal(view({ batches: [{ id: "1", repo: "o/R", batchPr: 5, base, head, state: "landing", members }], openPrs: { "o/R": movedOpen } }).batches[0].landing.moved, true);
});

test("ci: an optional check that failed and then passed on a re-run is not counted as failed", () => {
  const v = (conclusion, t) => ({ context: "preview", state: conclusion, startedAt: t });
  const BUILD = { name: "build", status: "COMPLETED", conclusion: "SUCCESS" };
  const out = view({ batches: [{ id: "1", repo: "o/R", batchPr: 5, members: [{ pr: 4 }] }], openPrs: { "o/R": new Map([[5, { statusCheckRollup: [BUILD, v("FAILURE", "2025-02-12T12:00:00Z"), v("SUCCESS", "2025-02-12T12:10:00Z")] }], [4, {}]]) } });
  assert.equal(out.batches[0].otherFailed, 0);
});

test("reader: a GitHub list that stops refreshing is not trusted past 3 minutes, and one unreadable repo hides only its own batches", () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, "batches", "1.json"), JSON.stringify({ id: "1", repo: "o/Good", batchPr: 12, state: "opened", members: [{ pr: 10, head: "h", title: "T" }] }));
  fs.writeFileSync(path.join(dir, "batches", "2.json"), JSON.stringify({ id: "2", repo: "o/Bad", batchPr: 22, state: "opened", members: [{ pr: 20, head: "h", title: "T" }] }));
  let goodOk = true;
  const run = (cmd, args, opts, cb) => {
    const repo = args.includes("-R") ? args[args.indexOf("-R") + 1] : args[1]; // pr list -R <repo>, or api repos/<repo>/...
    if (/o\/Bad/.test(repo)) return cb(new Error("no access"));
    if (args[0] === "api") return cb(null, "");
    return goodOk ? cb(null, JSON.stringify([{ number: 12, statusCheckRollup: [] }, { number: 10 }])) : cb(new Error("auth expired"));
  };
  const q = createQueue({ dir, hooksDir: null, run });
  const first = q.read(NOW);
  assert.deepEqual([first.github, first.batches.map((b) => b.batchPr), first.unreadBatches], ["ok", [12], 1]);
  goodOk = false;
  assert.equal(q.read(NOW + 61e3).batches.length, 1); // one failed refresh: the list is still fresh enough
  const late = q.read(NOW + 4 * 60e3);
  assert.deepEqual([late.batches, late.github], [null, "unreadable"]);
});

test("ci: only the check merge-batch requires decides the word; an optional failure is counted apart", () => {
  const BUILD = (status, conclusion) => ({ __typename: "CheckRun", name: "build", status, conclusion });
  const previewFailed = { __typename: "StatusContext", context: "preview", state: "FAILURE" };
  assert.equal(ciState([], REQ), "none");
  assert.equal(ciState([previewFailed], REQ), "none"); // no required check: nothing guessed
  assert.equal(ciState([BUILD("COMPLETED", "SUCCESS"), previewFailed], REQ), "passed"); // merge-batch lands it
  assert.equal(ciState([BUILD("IN_PROGRESS", ""), { name: "e2e", status: "COMPLETED", conclusion: "FAILURE" }], REQ), "running");
  assert.equal(ciState([BUILD("COMPLETED", "FAILURE")], REQ), "failed");
  assert.equal(ciState([BUILD("COMPLETED", "SKIPPED")], REQ), "skipped");
  assert.equal(ciState([{ context: "build", state: "PENDING" }], REQ), "running");
  // a failed run and its passing re-run: the latest run counts, as in `gh pr checks`
  const run = (conclusion, t) => ({ name: "build", status: "COMPLETED", conclusion, startedAt: t, completedAt: t });
  assert.equal(ciState([run("FAILURE", "2025-02-12T12:00:00Z"), run("SUCCESS", "2025-02-12T12:20:00Z")], REQ), "passed");
  assert.equal(ciState([run("SUCCESS", "2025-02-12T12:20:00Z"), run("FAILURE", "2025-02-12T12:00:00Z")], REQ), "passed");
  // a re-run still going reports completedAt as year 1: it is the latest, so the word is running
  const going = { name: "build", status: "IN_PROGRESS", conclusion: "", startedAt: "2025-02-12T12:30:00Z", completedAt: "0001-01-01T00:00:00Z" };
  assert.equal(ciState([run("FAILURE", "2025-02-12T12:00:00Z"), going], REQ), "running");
  assert.equal(ciState([run("SUCCESS", "2025-02-12T12:00:00Z"), going], REQ), "running");
  const v = view({
    batches: [{ id: "1", repo: "o/R", batchPr: 5, members: [{ pr: 4, head: "h" }] }],
    openPrs: { "o/R": new Map([[5, { statusCheckRollup: [BUILD("COMPLETED", "SUCCESS"), previewFailed] }], [4, {}]]) },
  });
  assert.deepEqual([v.batches[0].ci, v.batches[0].otherFailed], ["passed", 1]);
});

test("reader: a process list taken when no job ran never hides a job that started after it", () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify(reg()));
  const scans = [];
  const run = (cmd, args, opts, cb) => { if (cmd === "powershell.exe") scans.push(cb); };
  const alive = (marker, procs) => procs.some((p) => p.includes(marker));
  const q = createQueue({ dir, hooksDir: null, github: false, run, markerAlive: alive, platform: "win32" });
  const t0 = NOW;
  const at = (s) => t0 + s * 1000;
  const file = (n) => path.join(dir, "heavy-claims", n);
  claim(dir, "a.json", { session: A, command: "tsc", marker: "tsc", started: at(-60), until: at(600) });
  assert.equal(q.read(at(0)).gate.state === "busy", true); // no list yet: the claim holds
  scans.shift()(null, "node server.js\n"); // job A has ended
  assert.equal(q.read(at(11)).gate.holder, null); // a fresh list without it: A is gone
  scans.shift()(null, "node server.js\n");
  fs.unlinkSync(file("a.json"));
  claim(dir, "b.json", { session: B, command: "bunx vitest run", marker: "vitest", started: at(15), until: at(700) });
  assert.equal(q.read(at(22)).gate.holder.starting, true);
  // B is past its start; the last list (from 11 s) is over two reads old, so it is not trusted, and a scan is asked
  const late = q.read(at(55));
  assert.equal(late.gate.state, "busy");
  assert.equal(late.gate.holder.session, "beta");
  assert.equal(scans.length, 1);
  scans.shift()(null, "node vitest.mjs run\n");
  assert.equal(q.read(at(66)).gate.holder.session, "beta"); // a fresh list that shows it: still busy
  scans.shift()(null, "node server.js\n");
  assert.equal(q.read(at(77)).gate.holder, null); // a fresh list without it: free, as heavy-gate.cjs says
});

test("reader: CPU after a long gap shows as being measured, not as a stale average", () => {
  let idle = 0, total = 0;
  const cpus = () => [{ times: { user: total - idle, nice: 0, sys: 0, idle, irq: 0 } }];
  const q = createQueue({ dir: folder(), hooksDir: null, github: false, cpus, run: () => {} });
  assert.equal(q.read(NOW).gate.cpu, null); // first read: no sample yet
  idle += 50; total += 100;
  assert.equal(q.read(NOW + 10e3).gate.cpu, 50);
  idle += 10; total += 100;
  assert.equal(q.read(NOW + 30001).gate.cpu, 90); // a read 20 s and a few ms later (timer jitter) still has a figure
  idle += 10; total += 100;
  assert.equal(q.read(NOW + 10 * 60e3).gate.cpu, null); // ten minutes since the last read
});

test("reader: a sealed copy asks GitHub nothing", () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, "batches", "1.json"), JSON.stringify({ id: "1", repo: "o/Repo", batchPr: 12, state: "opened", members: [] }));
  const calls = [];
  const v = createQueue({ dir, hooksDir: null, github: false, run: (cmd) => calls.push(cmd) }).read(NOW);
  assert.deepEqual([calls, v.batches, v.github], [[], null, "off"]);
});

test("reader: reads the folder, asks GitHub in the background, caches 10 s, and leaves every file as it was", () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify(reg()));
  fs.writeFileSync(path.join(dir, "batches", "1.json"), JSON.stringify({ id: "1", repo: "o/Repo", batchPr: 12, state: "opened", members: [{ pr: 10, head: "h", title: "T" }] }));
  fs.writeFileSync(path.join(dir, "batches", "0.json"), JSON.stringify({ id: "0", repo: "o/Repo", batchPr: 8, state: "landed", members: [] }));
  fs.writeFileSync(path.join(dir, "reviews", "Repo-10-h.txt"), "PR #10 head h\nVERDICT: NOT CLEAN - 1 Important\n");
  claim(dir, "1.json", { session: A, command: "tsc", marker: "tsc", started: NOW - 200e3, until: NOW - 1 });
  const snap = () => fs.readdirSync(dir, { recursive: true }).sort().map((f) => { const p = path.join(dir, f); return fs.statSync(p).isFile() ? `${f}:${fs.readFileSync(p, "utf8")}` : f; });
  const before = snap();
  const calls = [];
  const run = (cmd, args, opts, cb) => { calls.push([cmd, ...args].join(" ")); cb(null, JSON.stringify([{ number: 12, statusCheckRollup: [] }, { number: 10 }])); };
  const q = createQueue({ dir, hooksDir: path.join(dir, "no-hooks"), run });
  const first = q.read(NOW);
  assert.equal(first.github, "ok"); // the fake answers at once, so the first read already has it
  assert.deepEqual(first.batches.map((b) => [b.batchPr, b.members[0].review]), [[12, "problems"]]); // a review file is not a clean review
  assert.equal(first.sessions.length, 3);
  assert.equal(q.read(NOW + 5e3), first); // cached
  assert.notEqual(q.read(NOW + 11e3), first);
  assert.equal(calls.filter((c) => c.startsWith("gh pr list -R o/Repo")).length, 1); // GitHub at most once a minute
  assert.deepEqual(snap(), before);
});

test("reader: a missing folder is an empty queue, not an error", () => {
  const q = createQueue({ dir: path.join(os.tmpdir(), "hq-queue-nope-" + process.pid), run: () => {} });
  const v = q.read(NOW);
  assert.deepEqual([v.sessions, v.requests, v.batches, v.gate.state], [[], [], [], "measuring"]); // first read: no CPU figure yet
  assert.equal(v.present, false, "the page hides the panel");
  assert.equal(createQueue({ dir: folder(), run: () => {} }).read(NOW).present, true);
});

test("config: with no required checks every check counts, the worst word wins, and nothing is counted apart", () => {
  const c = (name, conclusion) => ({ name, status: "COMPLETED", conclusion });
  assert.equal(ciState([], null), "none");
  assert.equal(ciState([c("lint", "SUCCESS"), c("unit", "SUCCESS")], null), "passed");
  assert.equal(ciState([c("lint", "SUCCESS"), c("unit", "FAILURE")], null), "failed");
  assert.equal(ciState([c("lint", "SUCCESS"), { name: "unit", status: "IN_PROGRESS" }], null), "running");
  // with two required checks, one missing from the PR reads as none until it appears
  assert.equal(ciState([c("lint", "SUCCESS")], ["lint", "unit"]), "none");
  const v = view({ requiredChecks: null, batches: [{ id: "1", repo: "o/R", batchPr: 5, members: [{ pr: 4 }] }], openPrs: { "o/R": new Map([[5, { statusCheckRollup: [c("a", "SUCCESS"), c("b", "FAILURE")] }], [4, {}]]) } });
  assert.deepEqual([v.batches[0].ci, v.batches[0].otherFailed], ["failed", 0]);
});

test("view: a lock name beyond the four standard ones is listed after them, in its own words", () => {
  const r = reg();
  r.locks["release-notes"] = { session: A, at: NOW - min };
  r.locks["bad name!"] = { session: A, at: NOW - min };
  const l = view({ reg: r }).locks;
  assert.deepEqual(l.map((x) => x.name), ["merge", "db-migration", "edge-deploy", "prod-deploy", "release-notes"]);
  assert.deepEqual([l[4].words, l[4].holder, l[4].stale], ["release-notes", "alpha", false]);
});

test("reader: the live check is on with the system pack's matcher on Windows, says no-hooks without it, and is unavailable elsewhere", () => {
  const dir = folder();
  const hooks = path.join(dir, "hooks");
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, "shell-hygiene-lib.js"), "module.exports = { markerAlive: (m, procs) => procs.some((p) => p.includes(m)) };");
  const opts = { dir, github: false, run: () => {} };
  assert.equal(createQueue({ ...opts, hooksDir: hooks, platform: "win32" }).read(NOW).gate.liveCheck, "on");
  assert.equal(createQueue({ ...opts, hooksDir: path.join(dir, "missing"), platform: "win32" }).read(NOW).gate.liveCheck, "no-hooks");
  assert.equal(createQueue({ ...opts, hooksDir: null, platform: "win32" }).read(NOW).gate.liveCheck, "no-hooks");
  for (const platform of ["darwin", "linux"]) {
    const calls = [];
    const q = createQueue({ ...opts, hooksDir: hooks, platform, run: (cmd) => calls.push(cmd) });
    claim(dir, "x.json", { session: A, command: "tsc", marker: "tsc", started: NOW - 60e3, until: NOW + 120e3 });
    const v = q.read(NOW);
    assert.equal(v.gate.liveCheck, "unavailable");
    assert.equal(v.gate.state, "busy"); // the claim holds until its own end, as in the gate
    assert.deepEqual(calls, [], "no process list is asked for off Windows");
    fs.unlinkSync(path.join(dir, "heavy-claims", "x.json"));
  }
});

test("reader: only the configured repos are asked about, on the configured branch, and a repo of any other shape never reaches gh", () => {
  const dir = folder();
  const b = (id, repo) => fs.writeFileSync(path.join(dir, "batches", id + ".json"), JSON.stringify({ id, repo, batchPr: 12, state: "opened", members: [{ pr: 10, head: "h", title: "T" }] }));
  b("1", "o/Mine");
  b("2", "o/Other");
  b("3", "--help");
  const calls = [];
  const run = (cmd, args, opts, cb) => { calls.push(args.join(" ")); cb(null, args[0] === "api" ? "" : "[]"); };
  createQueue({ dir, run, repos: ["o/Mine", "--help"], mainBranch: "trunk" }).read(NOW);
  assert.deepEqual(calls.sort(), ["api repos/o/Mine/git/ref/heads/trunk --jq .object.sha", "pr list -R o/Mine --state open --limit 1000 --json number,headRefOid,statusCheckRollup"]);
  calls.length = 0;
  createQueue({ dir, run }).read(NOW);
  assert.deepEqual(calls.filter((c) => c.startsWith("pr list")).map((c) => c.split(" ")[3]).sort(), ["o/Mine", "o/Other"]);
  assert.ok(calls.every((c) => !c.includes("--help")), "a repo that is not owner/name is never passed on");
  assert.ok(calls.some((c) => c.includes("heads/main")), "main by default");
});
