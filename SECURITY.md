# Security

## What VibeQuarters can do on your machine

VibeQuarters is a local dashboard. Read this before you turn on its optional features.

- **Read only by default.** With no config, the server listens on `127.0.0.1` only, answers `GET` requests only, and reads your Claude Code transcripts under `~/.claude/projects`. It writes its own state files (port file, parse cache, and the lock and log of `launch.js`) inside its own folder, and, when the system pack's usage-line mod is installed, the plan line's account list (`~/.claude/vibequarters-usage/accounts.json`: salted keys, reset times and percentages). It sends nothing over the network by default; [the guide](docs/guide.md#what-leaves-your-computer) lists every feature that does once you turn it on.
- **Control mode (`"control": true`) can answer permission prompts.** When you register the bridge hooks and turn control on, a click in the page can allow a tool call that a Claude Code session asked about. You are responsible for what you approve. The software is provided AS IS, with no warranty (see [LICENSE](LICENSE)).
- **Approve windows** let the server approve some requests for you for a limited time. They exist only with control and the assistant on, and only after you confirm the assistant's read-back. Inside a window the "routine" list is approved without a check: the short read-only one in `approval-levels.json`, or the one of the choice you made in the approvals chooser. The never-auto list in `approval-levels.json` (deletes, force pushes, hard resets, skipped hooks, deploys, publishing, money tools) is never approved, whichever choice you made. Its words are matched anywhere in a call; `lib/never-approve.js` also reads the command itself, so a delete, force push, branch delete, hard reset, deploy, publish or pull request merge in another flag order, behind `git -C`, shortened, quoted or wrapped (`sudo`, `bash -c`, `xargs`, `npx`) waits for you too. A script file that does the same is not read, so it is a guard against mistakes, not a sandbox. Everything else waits for you, unless you set `"judge": true` or pick the choice with the AI judge, which asks an AI judge running on your own Claude login.
- **The assistant** (optional, off by default) runs the `claude` command line on your own login, in your home folder, in Claude Code's default permission mode. Every step that Claude Code would ask you about comes to the page as a card that waits for your yes.

## Built-in protections

- The server binds to `127.0.0.1`, refuses requests whose `Host` is not a local address (DNS rebinding), and forbids framing.
- Write routes need a random token that is made new on every start and served only inside the page, plus a same-origin `Origin` header.
- The bridge acts on an answer only after it confirms, over the local port, that the running server wrote exactly that answer. On Windows it also checks that the process on the port is this install's `server.js`; on other systems that check cannot run, so the bridge stands aside at once, Claude Code asks in its own prompt, and the page says that answering is not available.
- What looks like a secret in a transcript (keys, tokens, `.env` lines) is cut before the text reaches the page, best effort.
- Keys (for example `ELEVENLABS_API_KEY`) come only from environment variables. Your `hq.config.json` is git-ignored.

## Every outbound call

There is no telemetry, no update check and no account, and nothing is downloaded when you install or run it. This is the whole list; each row happens only after you turn it on or run the command.

| What | Contacts | When |
| --- | --- | --- |
| Deploy wall, queue, batches | GitHub, through your own `gh` | `deploys` or `queue.repos` in the config |
| Assistant, its drafter, AI judge | Claude, through your own `claude` command | `assistant` or `judge` turned on |
| Keep-warm ping (mod `hq-feed`) | Claude, through the session's own login: a short message at most every `hqFeed.pingAtMinutes` while a chat is idle, up to `hqFeed.maxPings` | Off until you switch it on for a chat |
| Spoken replies | `api.elevenlabs.io`, with your key | `assistant.voiceId` and `ELEVENLABS_API_KEY` set |
| Talk button | Your browser's speech recognition, or a local whisper.cpp | Pressing Talk |
| Merge, push and deploy gates, `/land`, `merge-batch.js` | GitHub and your git remote, through your own `gh` and `git` | A merge, push or deploy command in a session |
| Edge function check | Your own Supabase project | Right after a deploy you ran (`supabase` pack) |
| `tools/vendor-three.cjs` | `registry.npmjs.org` | Only when a maintainer runs it by hand |

## Every place it writes

| Where | What | Written by |
| --- | --- | --- |
| The app's folder | `hq.config.json` (installer only), `.launch.lock` and `.server.log` (`launch.js`), `.demo` (`npm run demo`) | App, installer |
| The app's state folder: the app's folder, unless a settings file (`server.js --settings`) names another | `.runtime.json` (the port file), `.filecache.v4.json` (the parse cache). With control on: `decisions/` (requests and answers), `inbox/` (messages to sessions), `answers.log.jsonl` (the answers log), `.hq-presence.json`, `approve-window.json` and its `.off` marker, `approvals-choice.json`, `assistant/` (`mcp.json`, `sessions.json`, `usage.jsonl`) | App, bridge; the approvals choice also by the installer |
| `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, `~/.claude/vibequarters.config.json` | Hook entries; one import line, if you say yes; the settings. Before the installer changes one that exists, a copy goes beside it (`<name>.vibequarters-backup-<date>`); `uninstall.js` takes the entries, the line and the settings file out | Installer, uninstaller |
| `~/.claude/vibequarters`, `~/.claude/commands`, `~/.claude/skills` | The installed system, with the record of the install and what the settings held before it (`before/`). A file of it that you edited is kept as `<name>.edited-<date>` | Installer |
| `~/.claude/vibequarters.salt` | The random salt that hides the account id in the usage history | Installer (`companions`) |
| `~/.claude/coordination` | The session board, claims, handoffs, gate records, batches, review records | `coordination`, `merge-gate` |
| `~/.claude/coordination/heavy-claims`, `~/.claude/coordination/shell-hygiene.log` | Which heavy job runs (secrets in the command cut), and a log of the shell checks' decisions | `core` |
| `<land.worktreeRoot>/wt-land-<repo>-<pr>` and `wt-batch-<pr>` (your home folder unless you change it) | Git worktrees `/land` has Claude make, kept until you remove them | `merge-gate` |
| `~/.claude/projects/<project>/memory/loop` | Resume point, lessons, action and recall logs. The action log holds the first 160 characters of each command or path; what looks like a secret is masked, best effort | `core`, `learning-loop` |
| `~/.claude/hq-feed` | Agent switches and keep-warm switches (app); what each chat reports (`companions`); `hook-asks/`, a note of why a guard asked you (`core`, `coordination`, `style`) | App, hooks |
| `~/.claude/vibequarters-usage` | The account list (app); usage percentages (`companions`); `usage-audit/`, the weekly report when you run `weekly-usage-audit.js` | App, `companions` |
| `~/.claude/HALT`, `~/.claude/ping-muted`, `~/.claude/ping.lock` | The kill switch and the sound switch, made when you use them; which ping series is running | You, `notify` |
| `~/.claude/cache` | Small state of the spend warnings and the reply check | `companions`, `style` |
| `~/.claude/logs`, `~/.claude/edge-snapshots` (`edgeDeploy.snapshotDir`) | The edge deploy log, and the copy of a live edge function taken before a deploy | `supabase` |
| The system's temp folder | Short-lived files: a phrase being transcribed, a git index, `verify.js`'s throwaway home | App, hooks, installer |

## Check a release

Each release lists the SHA-256 of its archive in `SHA256SUMS`. Compare it with `Get-FileHash <file>` on Windows or `shasum -a 256 <file>` elsewhere. The code is plain JavaScript and TypeScript with no build step and no npm dependencies, so what you read is what runs.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use the repository's private vulnerability reporting ("Report a vulnerability" under the Security tab). Include the version, your platform, and the steps to reproduce.
