// Runs the real judge (one Sonnet call on the signed-in account) on test/fixtures/judge-cases.json and prints each
// verdict beside what it should be. Exit 1 when any verdict differs. Run after changing assistant/judge.md:
//   node tools/judge-cases.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { judgeItems } = require("../lib/judge");
const { claudePath } = require("../lib/assistant");

const ROOT = path.join(__dirname, "..");
const cases = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "judge-cases.json"), "utf8"));
const items = cases.map((c) => ({ ...c.item, hash: "h-" + c.item.id }));
judgeItems(items, { spawn: childProcess.spawn, claude: claudePath(), rulesFile: path.join(ROOT, "assistant", "judge.md"), stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "judge-cases-")), timeoutMs: 180e3 }).then((r) => {
  if (!r.ok) {
    console.log("judge failed: " + r.error);
    process.exit(1);
  }
  let wrong = 0;
  for (const c of cases) {
    const v = r.verdicts.find((x) => x.id === c.item.id);
    const ok = v.approve === c.expect;
    if (!ok) wrong++;
    console.log(`${ok ? "ok   " : "WRONG"} ${c.item.id} expect ${c.expect ? "approve" : "leave  "} got ${v.approve ? "approve" : "leave  "} ${v.why}`);
  }
  console.log(`${cases.length - wrong} of ${cases.length} as expected`);
  process.exit(wrong ? 1 : 0);
});
