#!/usr/bin/env node
// vibequarters :: PreToolUse (ALL tools)
// The VibeQuarters app's approvals are the user's click, never an agent's. The live app (its state folder is appStateDir,
// else appDir, in vibequarters.config.json) answers a chat's permission prompt from its page; any program running as the
// user could otherwise answer for them by writing into its decisions folder or calling its answer routes. The app also
// sends a chat a message the user typed, which the chat reads as theirs; an agent sending one would speak for them. This hook
// DENIES, with no override but the global kill switch, an agent tool call that reaches that path directly:
//   1. a file write, or a shell command, naming the live decisions folder, inbox folder, presence file or answers log, and
//      a write (from a file tool or a shell) of the saved approvals preset, approval-levels.json, an installed preset file
//      or the agent switches (protected-files.js);
//   2. a shell command, file write, web fetch or MCP call naming an answer route or the token (/api/answer,
//      /api/presence, /api/send, the assistant's /api/readback, /api/window, /api/assistant, /api/say, /api/tts, the
//      page's /api/approvals, /api/agents, /api/warm, and hq-token) together with the live HQ (its port, or the state folder's .runtime.json that holds it);
//   3. an agent-driven browser (an MCP browser tool, or a shell command starting Playwright, Puppeteer, CDP or a
//      headless browser) pointed at the live HQ's address;
//   4. a shell command that runs the HQ assistant's MCP server (node, bun, deno, npx and the like with hqa-mcp or
//      hqa-mcp.js in its argv) or names its token (HQ_ASSISTANT_TOKEN, x-hq-assistant-token). The assistant's own Claude
//      process reaches it through MCP, so no shell command has a reason to; no exception. Editing, committing
//      and testing that server stay allowed: the token is the real lock, and it lives only in HQ's memory and the
//      assistant's env.
// A shell command is a Bash, PowerShell or Monitor call's command. A route is read both as written and with its %2e,
// ./ and seg/../ collapsed, as curl sends it, and its backslashes as slashes, as Node's fetch reads them.
// HQ's own source and its tests are not blocked: they run their own servers on port 0 and name no live path. A program
// that hides the path (built strings, a script written earlier) can still slip past; this stops the direct ways.
// FAILS OPEN on its own bugs.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./vibequarters-config');
const { canon, isProtected, shellWrite } = require('./protected-files');

function allow() { process.exit(0); }

function deny(what, hint) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `vibequarters [DENY]: this call ${what}. VibeQuarters approvals are the user's click only; no agent answers, marks ` +
        `presence or reads the token for them. Leave the request for the user in VibeQuarters or in Claude Code.` +
        (hint ? ` ${hint}` : ''),
    },
  }));
  process.exit(0);
}
// The way out for a command that only mentions a name, as guard-deny-catastrophic.js says it
const TEXT_ROUTE = 'If the words only appear in text (a commit message, a PR body, a search), put that text in a file with Write and pass the file.';

// The tools that never act; everything else is checked. Agent, SendMessage and the like carry instructions, not actions.
const SKIP = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'ToolSearch', 'WebSearch', 'TaskOutput', 'BashOutput',
  'Agent', 'Task', 'SendMessage', 'ListAgents', 'AskUserQuestion', 'Skill', 'TaskStop', 'ReadNotifications',
]);
const SHELL = new Set(['Bash', 'PowerShell', 'Monitor']); // a Monitor watcher runs its command in a shell too
const FILE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// The app's state folder ('' when the app is not installed) and the name a command would spell it by.
const APP_STATE = P.appState();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STATE_NAME = APP_STATE ? escapeRe(path.basename(APP_STATE)) : '';
const STATE = new RegExp(String.raw`\.hq-presence\.json|answers\.log\.jsonl|approve-window\.json` +
  (STATE_NAME ? String.raw`|(?:^|[\\/\s"'])${STATE_NAME}[\\/]+(?:decisions|inbox)\b` : ''), 'i');
const ROUTE = /\/api\/(answer|presence|send|readback|window|assistant|say|tts|approvals|agents|warm)\b|\bx-hq-token\b|\bhq-token\b/i;
// An interpreter, then the server's file, with or without its .js, in the same command (a `;`, `&`, `|` or new line
// ends it), the name not running on into a longer name. After a test runner word (`node --test `, `bun test `,
// `npx vitest `, ending at a space) only a path-shaped name (`bin/hqa-mcp`, `hqa-mcp.js`) counts, since --test runs
// that file as main; so `git add bin/hqa-mcp.js && node --test ...`, a test file or glob (`test/hqa-mcp*.test.js`) and
// a runner's name filter (`bun test hqa-mcp`) pass.
const RUNS_ASSISTANT = /\b(node|nodejs|bun|bunx|deno|npx|tsx|ts-node)(\.exe)?\b(?:(?!\s+(--test|test|vitest|jest|mocha)(?=\s))[^;&|\n]*\bhqa-mcp(\.js)?|[^;&|\n]*(?:[\\/]hqa-mcp(\.js)?|\bhqa-mcp\.js))(?![\w.*?\[{-])/i;
// A URL path as curl sends it: %2e read as a dot and a backslash as a slash, then each /./ dropped and each /seg/../
// folded away, until none is left
function collapse(s) {
  s = s.replace(/%2e/gi, '.').replace(/\\/g, '/');
  for (let prev; prev !== s;) {
    prev = s;
    s = s.replace(/\/\.(?=\/)/g, '').replace(/\/(?!\.\.\/)[^/\s'"?#&|;<>()$`{}]+\/\.\.(?=\/)/g, ''); // a segment stops at shell syntax
  }
  return s;
}
const ASSISTANT_TOKEN = /\bHQ_ASSISTANT_TOKEN\b|\bx-hq-assistant-token\b/i;
const DRIVER = /\bplaywright\b|\bpuppeteer\b|--headless\b|remote-debugging|connectOverCDP|chrome-remote-interface/i;
const BROWSER_TOOL = /^mcp__.*(playwright|chrome|browser|devtools|puppeteer)/i;

function livePorts() {
  const ports = new Set([4747]); // the app's default port
  try {
    const rt = JSON.parse(fs.readFileSync(path.join(APP_STATE, '.runtime.json'), 'utf8'));
    if (Number.isInteger(rt.port) && rt.port > 0) ports.add(rt.port);
  } catch (_e) {}
  return [...ports];
}

try {
  if (String(process.env.VIBEQUARTERS_GUARD || '').toLowerCase() === 'off') allow();
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const tool = String(input.tool_name || '');
  if (!tool || SKIP.has(tool)) allow();
  const ti = input.tool_input || {};
  const isShell = SHELL.has(tool);
  const isFile = FILE.has(tool);
  if (!isShell && !isFile && tool !== 'WebFetch' && !tool.startsWith('mcp__')) allow();

  const text = isShell ? String(ti.command || '') : JSON.stringify(ti);
  const home = os.homedir();
  const ports = APP_STATE ? livePorts() : [4747];
  // The PORT decides, not the host: 127.1, 0.0.0.0, [::ffff:127.0.0.1], 2130706433 and the machine name all reach HQ,
  // and a URL parser reads :04747 as 4747.
  const address = new RegExp(`:0*(${ports.join('|')})(?!\\d)`);
  const live = new RegExp(`${address.source}` + (STATE_NAME ? `|${STATE_NAME}[\\\\/]+\\.runtime\\.json` : ''), 'i');

  // 1. The live state: a file tool writing there, or any shell command naming it.
  if (isFile) {
    const target = canon(String(ti.file_path || ti.notebook_path || ''));
    const dash = APP_STATE ? canon(APP_STATE) : null;
    const windows = [canon(path.join(home, '.claude', 'hq-feed', 'approve-window.json'))];
    if (dash) windows.push(dash + '/approve-window.json');
    const inState = dash && (target === dash + '/.hq-presence.json' || target === dash + '/answers.log.jsonl' || target.startsWith(dash + '/decisions/') || target.startsWith(dash + '/inbox/'));
    if (inState || windows.includes(target)) {
      deny('writes into the live VibeQuarters decisions folder, inbox folder, presence file, answers log or saved approve window');
    }
  }
  if (isShell && STATE.test(text)) deny("names the live VibeQuarters decisions folder, inbox folder, presence file, answers log or saved approve window");

  const approvalFile = (how) => deny(`${how}, a file that decides what is approved without the user`, 'The user changes it: the approvals preset and the agent switches on the VibeQuarters page, the lists by hand.');
  if (isFile && isProtected(String(ti.file_path || ti.notebook_path || ''), 'deny')) approvalFile('writes ' + String(ti.file_path || ti.notebook_path));
  if (isShell) {
    let hit = null;
    try { hit = shellWrite(text, String(input.cwd || process.cwd()), 'deny'); } catch (_e) { /* a parser bug never skips the checks below */ }
    if (hit) approvalFile(`writes ${hit.target}`);
  }

  // 2. An answer route or the token, aimed at the live HQ.
  if ((ROUTE.test(text) || ROUTE.test(collapse(text))) && live.test(text)) deny("calls the live VibeQuarters app's answer, presence, send or assistant routes, or reads its token");

  // 3. An agent-driven browser at the live HQ.
  if (BROWSER_TOOL.test(tool) && address.test(text)) deny('points an agent-driven browser at the live VibeQuarters app');
  if (isShell && DRIVER.test(text) && address.test(text)) deny('starts an agent-driven browser at the live VibeQuarters app');

  // 4. The assistant's tool run, or its token named, from a shell.
  if (isShell && (RUNS_ASSISTANT.test(text) || ASSISTANT_TOKEN.test(text))) deny("starts the VibeQuarters assistant's MCP server or mentions its token", TEXT_ROUTE);

  allow();
} catch (_e) {
  allow();
}
