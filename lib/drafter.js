// The drafter: turns the owner's idea into one complete prompt for a Claude Code session. One claude -p run per draft
// with no tools, no session kept and the rules in assistant/draft.md appended to its system prompt. The child never
// sees a CLAUDE* or ANTHROPIC* variable, so it runs on the signed-in account and never on an API key. Its answer is
// cleaned of em and en dashes before anyone sees it, and each draft's cost goes to a usage log.
"use strict";
const fs = require("fs");
const path = require("path");

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
// A dash with a space on each side reads as a pause, so it becomes a comma; any other one joins words, so a hyphen.
const SPACED_DASH = new RegExp(` [${EM}${EN}] `, "g");
const ANY_DASH = new RegExp(`[${EM}${EN}]`, "g");
const IDEA_MAX = 2000;
const REPLY_MAX = 1500;
const TEXT_MAX = 1800;
// Windows reads env names without case, so a lowercase anthropic_api_key would still reach the CLI.
const HIDDEN_ENV = /^(CLAUDE|ANTHROPIC)/i;

const argsFor = (rulesFile) => ["-p", "--safe-mode", "--tools", "", "--model", "opus", "--output-format", "json", "--no-session-persistence", "--append-system-prompt-file", rulesFile];
const childEnv = (env) => Object.fromEntries(Object.entries(env || {}).filter(([k]) => !HIDDEN_ENV.test(k)));
const str = (v) => (typeof v === "string" ? v : "");

// What the drafter reads on stdin: the idea, where the prompt goes, and the chat's task and last reply when it has them.
function inputOf({ idea, target, context }) {
  const parts = [`The owner's idea:\n${str(idea).slice(0, IDEA_MAX)}`, `Target: ${target === "new" ? "new session" : str(target)}`];
  const task = str(context && context.task);
  const lastReply = str(context && context.lastReply).slice(0, REPLY_MAX);
  if (task) parts.push(`The target's current task:\n${task}`);
  if (lastReply) parts.push(`The target's last reply:\n${lastReply}`);
  return parts.join("\n\n") + "\n";
}

const cleanText = (t) => t.replace(SPACED_DASH, ", ").replace(ANY_DASH, "-").trim().slice(0, TEXT_MAX);

// The draft from the CLI's JSON, or null. An error result or an empty one is no draft, so its words are never sent to a
// chat.
function draftOf(stdout) {
  let j;
  try {
    j = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!j || typeof j.result !== "string" || j.is_error === true) return null;
  const text = cleanText(j.result);
  return text ? { text, costUsd: Number.isFinite(j.total_cost_usd) ? j.total_cost_usd : null } : null;
}

// One line per draft for the usage meter. A failed write only loses that line; the draft itself still counts.
async function logUsage(stateDir, at, costUsd) {
  try {
    const dir = path.join(stateDir, "assistant");
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.appendFile(path.join(dir, "usage.jsonl"), JSON.stringify({ at: new Date(at).toISOString(), costUsd, model: "opus" }) + "\n");
  } catch {}
}

// One draft at a time: each is its own Opus process, and several at once can overload a computer
let drafting = false;

// Never throws. Every error is a fixed short sentence, never the child's output, which could hold the idea or a secret.
function draftPrompt({ idea, target, context }, { spawn, claude = "claude", rulesFile, stateDir, env = process.env, now = Date.now, timeoutMs = 120e3 }) {
  if (drafting) return Promise.resolve({ ok: false, error: "another prompt is being written; draft this one when it is done" });
  drafting = true;
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      drafting = false;
      clearTimeout(timer);
      resolve(r);
    };
    try {
      child = spawn(claude, argsFor(rulesFile), { windowsHide: true, env: childEnv(env) });
    } catch {
      return finish({ ok: false, error: "could not start the drafter" });
    }
    const chunks = [];
    // Bytes are kept whole until the end, so a character split across two chunks still decodes.
    child.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
    // Drained and dropped: a full stderr pipe would stall the child, and its text is never shown.
    child.stderr.on("data", () => {});
    child.on("error", () => finish({ ok: false, error: "could not start the drafter" }));
    child.on("close", async (code) => {
      if (settled) return;
      const draft = code === 0 ? draftOf(Buffer.concat(chunks).toString("utf8")) : null;
      if (!draft) return finish({ ok: false, error: "the drafter failed" });
      clearTimeout(timer);
      await logUsage(stateDir, now(), draft.costUsd);
      finish({ ok: true, ...draft });
    });
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ ok: false, error: "the drafter took too long" });
    }, timeoutMs);
    // A child that dies before reading its stdin makes the write fail with EPIPE; the close above already reports it.
    child.stdin.on("error", () => {});
    child.stdin.end(inputOf({ idea, target, context }));
  });
}

module.exports = { draftPrompt };
