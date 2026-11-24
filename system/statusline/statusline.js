#!/usr/bin/env node
// VibeQuarters status line: model | dir | git branch | session cost | context warning.
// Reads the Claude Code status JSON on stdin and prints one line.
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let d = {};
  try {
    d = JSON.parse(raw);
  } catch (e) {}
  const cwd = (d.workspace && d.workspace.current_dir) || d.cwd || process.cwd();
  const model = (d.model && (d.model.display_name || d.model.id)) || "Claude";
  let branch = "";
  try {
    branch = require("child_process")
      .execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
      })
      .toString()
      .trim();
  } catch (e) {}
  const dir = String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  const cost =
    d.cost && typeof d.cost.total_cost_usd === "number" ? d.cost.total_cost_usd : null;
  const parts = [model];
  if (dir) parts.push(dir);
  if (branch) parts.push(branch);
  if (cost && cost > 0) parts.push("$" + cost.toFixed(2));
  if (d.exceeds_200k_tokens) parts.push("ctx>200k");
  process.stdout.write(parts.join("  |  "));
});
