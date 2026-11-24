#!/usr/bin/env node
// vibequarters :: PreToolUse(Bash|PowerShell)
// Asks (does NOT block) for a static scan of a new skill / MCP server / plugin BEFORE it is
// installed or enabled, through either the Bash or the PowerShell tool. Backstops the
// "vet-first" rule in RULES.md. The scan command shown is skillspector.scanCommand in
// vibequarters.config.json ('{dir}' marks the folder); with none set it names SkillSpector, a free
// static scanner. FAILS OPEN: never blocks real work on its own bug. Escape hatch: VIBEQUARTERS_GUARD=off.
'use strict';

function allow() { process.exit(0); } // no stdout + exit 0 => tool proceeds

let input = {};
function ask(reason) {
  try { require('./hq-ask-mark.js').markAsk(input, 'guard-skillspector.js', reason); } catch (_e) { /* the ask still prints */ }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') allow();

  input = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}');
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  if (!cmd.trim()) allow();

  // The scan command itself, or any flag mentioning skillspector, must pass through untouched
  // so the reminder never fires on the very act of scanning.
  const scan = String(require('./vibequarters-config').load().skillspector.scanCommand || '');
  const scanner = (scan.trim().split(/\s+/)[0] || '').replace(/^.*[\\/]/, '');
  if (/skillspector/i.test(cmd) || (scanner.length > 2 && cmd.toLowerCase().includes(scanner.toLowerCase()))) allow();
  const how = scan
    ? `run ${scan.replace(/\{dir\}/g, '<dir>')}`
    : 'run a static scanner on it (for example SkillSpector, github.com/NVIDIA/SkillSpector, static mode; set skillspector.scanCommand in vibequarters.config.json to name yours)';

  // Conservative install / enable patterns for skills, MCP servers, and plugins. Each must
  // be specific enough that an unrelated command (a normal `git clone`, a regular `bun add`)
  // does NOT trip it. We require a skill/mcp/plugin signal, not a bare clone or add.
  const checks = [
    { kind: 'Claude plugin install/enable',
      re: /claude\s+plugin\s+(install|enable|add)\b/i },
    { kind: 'Claude MCP server add',
      re: /claude\s+mcp\s+add\b/i },
    { kind: 'skills CLI add (npx skills add)',
      re: /\bnpx\s+(-y\s+|--yes\s+)?skills(@[\w.\-]+)?\s+add\b/i },
    { kind: 'npm/bun/pnpm/yarn install of a skills/MCP package',
      re: /\b(npm\s+(i|install|add)|bun\s+add|pnpm\s+(i|install|add)|yarn\s+add)\b[^\n|;&]*(skill|mcp|@modelcontextprotocol|model-context-protocol)/i },
    { kind: 'uv tool install of an MCP/skill server',
      re: /\buv(x|\s+tool\s+install)\b[^\n|;&]*(skill|mcp|skillspector|model-context-protocol)/i },
    { kind: 'git clone of a repo to be used as a skill/MCP/plugin',
      re: /git\s+clone\b[^\n|;&]*(skill|mcp[-_]?server|mcp\b|plugin|agent[-_]?skill|model-context-protocol)/i },
  ];

  for (const ck of checks) {
    if (!ck.re.test(cmd)) continue;
    ask(
      `vibequarters: this looks like installing/enabling a ${ck.kind}. Per the vet-first rule, ` +
      `scan it BEFORE enabling: download/clone to a local dir without registering it, ${how}, ` +
      `review the report, and only enable if clean. Confirm to proceed (or set VIBEQUARTERS_GUARD=off to disable this guard).\nCommand: ` +
      (cmd.length > 300 ? cmd.slice(0, 300) + '...' : cmd)
    );
  }

  allow();
} catch (_e) {
  // FAIL OPEN: a guard bug must never block legitimate work.
  process.exit(0);
}
