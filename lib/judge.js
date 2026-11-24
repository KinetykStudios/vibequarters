// The approve window's judge. One claude -p Sonnet run with no tools and no session decides, for a batch of
// permissions the levels sent to it (lib/levels.js), which to approve; the rules are assistant/judge.md. The child
// never sees a CLAUDE* or ANTHROPIC* variable, so it runs on the signed-in account. Every failure leaves the items for
// the owner, and a verdict counts only for an id it was given.
"use strict";
const fs = require("fs");
const path = require("path");

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const SPACED_DASH = new RegExp(` [${EM}${EN}] `, "g");
const ANY_DASH = new RegExp(`[${EM}${EN}]`, "g");
const HIDDEN_ENV = /^(CLAUDE|ANTHROPIC)/i;
const CALL_MAX = 1500;
const WHY_MAX = 200;

const argsFor = (rulesFile) => ["-p", "--safe-mode", "--tools", "", "--model", "sonnet", "--output-format", "json", "--no-session-persistence", "--append-system-prompt-file", rulesFile];
const childEnv = (env) => Object.fromEntries(Object.entries(env || {}).filter(([k]) => !HIDDEN_ENV.test(k)));
const str = (v) => (typeof v === "string" ? v : "");
const clean = (t) => t.replace(SPACED_DASH, ", ").replace(ANY_DASH, "-").replace(/\s+/g, " ").trim().slice(0, WHY_MAX);

// What the judge reads of one open request (its call, cut) and its card in the payload (who, where, HQ's own chip)
function itemOf(req, card, task) {
  const input = req.toolInput && typeof req.toolInput === "object" ? req.toolInput : {};
  const call = typeof input.command === "string" ? input.command : JSON.stringify(input);
  const risk = card && card.risk;
  return {
    id: req.id,
    hash: req.hash,
    session: str(card && card.sessionName),
    task: str(task),
    folder: str(card && card.folder),
    tool: str(req.toolName),
    call: call.slice(0, CALL_MAX),
    hookReason: req.hookAsk ? str(req.hookAsk.reason) : "",
    hqRisk: risk && risk.label ? risk.label + (risk.reason ? ": " + risk.reason : "") : "",
  };
}

// The verdicts in the child's JSON answer: its result text holds a list of { id, approve, why }. A given item with no
// verdict is left, approve counts only when it is exactly true, and null means the answer was no list at all.
function verdictsOf(stdout, items) {
  let j;
  try {
    j = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!j || typeof j.result !== "string" || j.is_error === true) return null;
  const a = j.result.indexOf("[");
  const b = j.result.lastIndexOf("]");
  if (a < 0 || b < a) return null;
  let list;
  try {
    list = JSON.parse(j.result.slice(a, b + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const said = new Map();
  for (const v of list) if (v && typeof v.id === "string" && !said.has(v.id)) said.set(v.id, v);
  const verdicts = items.map((it) => {
    const v = said.get(it.id);
    if (!v) return { id: it.id, hash: it.hash, approve: false, why: "the check gave no answer for it" };
    return { id: it.id, hash: it.hash, approve: v.approve === true, why: clean(str(v.why)) };
  });
  return { verdicts, costUsd: Number.isFinite(j.total_cost_usd) ? j.total_cost_usd : null };
}

async function logUsage(stateDir, at, costUsd, items) {
  try {
    const dir = path.join(stateDir, "assistant");
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.appendFile(path.join(dir, "usage.jsonl"), JSON.stringify({ at: new Date(at).toISOString(), costUsd, model: "sonnet", kind: "judge", items }) + "\n");
  } catch {}
}

let judging = false;

// { ok: true, verdicts } or { ok: false, error }; never throws, and no error carries the child's output
function judgeItems(items, { spawn, claude = "claude", rulesFile, stateDir, env = process.env, now = Date.now, timeoutMs = 90e3 }) {
  if (!items.length) return Promise.resolve({ ok: true, verdicts: [] });
  if (judging) return Promise.resolve({ ok: false, error: "busy" });
  judging = true;
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      judging = false;
      clearTimeout(timer);
      resolve(r);
    };
    try {
      child = spawn(claude, argsFor(rulesFile), { windowsHide: true, env: childEnv(env) });
    } catch {
      return finish({ ok: false, error: "the check could not start" });
    }
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
    child.stderr.on("data", () => {});
    child.on("error", () => finish({ ok: false, error: "the check could not start" }));
    child.on("close", async (code) => {
      if (settled) return;
      const got = code === 0 ? verdictsOf(Buffer.concat(chunks).toString("utf8"), items) : null;
      if (!got) return finish({ ok: false, error: "the check failed" });
      clearTimeout(timer);
      await logUsage(stateDir, now(), got.costUsd, items.length);
      finish({ ok: true, verdicts: got.verdicts });
    });
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ ok: false, error: "the check took too long" });
    }, timeoutMs);
    child.stdin.on("error", () => {});
    const sent = items.map(({ hash, ...rest }) => rest);
    child.stdin.end(JSON.stringify({ items: sent }) + "\n");
  });
}

module.exports = { judgeItems, itemOf };
