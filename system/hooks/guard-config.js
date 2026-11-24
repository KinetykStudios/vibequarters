#!/usr/bin/env node
// vibequarters :: PreToolUse(Edit|Write|MultiEdit|Bash|PowerShell|Monitor)
// Asks for confirmation before editing a linter/formatter quality-gate config, so the
// agent fixes the flagged CODE instead of silently weakening the gate to make a check pass, and before an edit or a shell
// command changes Claude Code's own settings, vibequarters.config.json, the app's hq.config.json or an installed hook
// (protected-files.js), since each can turn these guards off or raise what is approved.
// FAILS OPEN. Escape hatch: VIBEQUARTERS_GUARD=off.
'use strict';

function allow() { process.exit(0); }

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') allow();

  const input = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}');
  const ti = input.tool_input || {};
  const ask = (reason) => {
    try { require('./hq-ask-mark.js').markAsk(input, 'guard-config.js', reason); } catch (_e) { /* the ask still prints */ }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
    }));
    process.exit(0);
  };
  const guards = (what) => ask(`vibequarters: this call changes ${what}, which can turn guards off or raise what is approved ` +
    'without you. Approve it only if you asked for this change. Set VIBEQUARTERS_GUARD=off to disable.');
  const fp = String(ti.file_path || '').replace(/\\/g, '/');
  if (!fp) {
    const hit = ti.command ? require('./protected-files').shellWrite(ti.command, String(input.cwd || process.cwd()), 'ask') : null;
    if (hit) guards(hit.target);
    allow();
  }
  const base = (fp.split('/').pop() || '').toLowerCase();

  // Linter/formatter quality-gate configs. Deliberately EXCLUDES pyproject.toml and
  // tsconfig.json (mixed/legitimate metadata that's routinely edited).
  const GATE = [
    /^\.eslintrc(\..*)?$/, /^eslint\.config\.(js|cjs|mjs|ts)$/,
    /^\.prettierrc(\..*)?$/, /^prettier\.config\.(js|cjs|mjs)$/,
    /^biome\.jsonc?$/,
    /^\.stylelintrc(\..*)?$/, /^stylelint\.config\.(js|cjs|mjs)$/,
    /^\.markdownlint(rc)?(\..*)?$/, /^\.markdownlintignore$/,
    /^ruff\.toml$/, /^\.ruff\.toml$/,
    /^\.editorconfig$/,
  ];

  if (GATE.some((re) => re.test(base))) {
    ask(`vibequarters: you're editing a quality-gate config (${base}). Confirm you intend to change ` +
      `the rules, not just to make a failing check pass. Fixing the flagged code is usually the right move. ` +
      `Set VIBEQUARTERS_GUARD=off to disable.`);
  }

  if (require('./protected-files').isProtected(fp, 'ask')) guards(fp);
  allow();
} catch (_e) {
  process.exit(0); // FAIL OPEN
}
