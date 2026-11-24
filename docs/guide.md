# The full guide

Everything the [README](../README.md) leaves out: what it is, every pack and setting, the panels, the safety defaults.

## What it is, and what it is not

It is:

- A read-only view of the Claude Code transcripts already on your disk (`~/.claude/projects`), served on `127.0.0.1` only.
- An optional way to answer permission prompts from the page, through a hook you register yourself.
- An optional voice assistant that runs on your own Claude login through the `claude` command line.

It is not:

- A hosted service. There is no account and no telemetry, and VibeQuarters makes no outbound request unless you turn on a feature that needs one. See [What leaves your computer](#what-leaves-your-computer).
- A replacement for Claude Code's own permission system. When VibeQuarters is not running, or anything fails, Claude Code shows its normal prompt.
- An official Anthropic product. See [Not affiliated with Anthropic](#not-affiliated-with-anthropic).

## Requirements

- **Node.js 22 or newer.** There are no npm dependencies to install.
- **Claude Code**, signed in, with at least one session on this computer (or use the demo).
- A current desktop browser with WebGL for the 3D office view.
- **Windows, macOS or Linux.** Windows support is the most complete; CI runs the test suite on all three. Answering prompts, sending messages and opening a new session from the page work only on Windows so far: the first two depend on a Windows-only safety check (see [Answering prompts](#answering-prompts-from-the-page)), the last on the Windows `code` command.

## Install the full system

VibeQuarters is two things: the app (the page, below) and the system, a set of hooks, mods, commands and rules for Claude Code that keep several sessions on one computer working as a team. Either works without the other.

Needs **Claude Code 2.1.287 or newer**, Node.js 22 or newer, and git. The merge gate also needs the GitHub CLI (`gh`). Run these in your clone ([Install](#install) below):

```sh
node install/install.js --dry-run   # shows what would change, writes nothing
node install/install.js             # asks what to turn on
```

Or without questions: `node install/install.js --yes --preset full`, or `--yes --preset custom --packs core,coordination --approvals routine`.

| Pack | What you get |
| --- | --- |
| `core` | Guards that block catastrophic commands (a force push to any branch, mass deletes, a production deploy that no test has passed), catch secrets and risky shell habits, and stop runaway loops; a resume point that survives compacting; saved memory recalled when a prompt needs it; a kill switch (`~/.claude/HALT`); `/plan` and `/execute`. |
| `coordination` | Sessions share a board (`coord.js`): each owns the files it edits, asks the owner for a change instead of overwriting it, and takes turns on merges, migrations and deploys. |
| `merge-gate` | A merge into a live branch needs a fresh reviewer subagent to have passed its exact head; `/land` does the steps; `merge-batch.js` lands several pull requests as one tested batch. |
| `learning-loop` | Each project keeps its own lessons, loaded at the next start; `/evolve` distills a session into them. |
| `app` | Starts the VibeQuarters app with Claude Code and opens its page, sends permission prompts there and delivers messages typed there. |
| `companions` | The app's agent switches, the guard that keeps agents from answering for you, spend warnings, and two mods: `usage-line` (the plan line: your plan's usage, under the prompt) and `hq-feed` (the keep-warm feed). |
| `notify` | A sound when a session waits for you (repeated on Windows, where it stays quiet while your terminal or editor has the focus; once on macOS and Linux; `notify.count` changes that); `/mute` and `/unmute`. |
| `statusline` | Model, folder, branch, cost and a context warning under the prompt. |
| `windows` | Git Bash heredoc check (Windows only). |
| `style` | No em dashes, no AI attribution in commits and pull requests, a short Status / Next steps close on every reply. |
| `supabase` | Edge function deploys ship exactly your checkout, snapshot the live version, and are probed after. |
| `skills` | One bundled skill: `vibesec`. |

**Full** turns on every pack that fits your system. When the app folder has no `hq.config.json`, Full also writes one from the example with `"control": true` (answering from the page) and `"assistant": {}` (the assistant, on your own Claude login). It registers `launch.js`, so the page opens by itself. It also picks the recommended answer to the question below, unless the page already has one (`--approvals none` leaves it out). After `node install/install.js --yes --preset full`, restarting Claude Code is the only step everything needs; the installer ends with one list of what else applies (`gh auth login` for `/land` when you are not logged in, `/loop-init` once in each project that should keep lessons). Nothing is approved for you until you open an approve window, and an `hq.config.json` you already have is never changed (`--app-config no` leaves it out). **Custom** asks about each pack and the config. Run the installer again at any time to change packs or update (`--yes` alone keeps the packs you have).

**How much may the page approve for you?** The installer asks, and the page lets you change it. It acts only inside an approve window, which you open by asking the page's assistant for one and confirming its read-back; until then every prompt waits for your click:

1. *Ask me everything*
2. *Approve safe reads*
3. *Approve routine coding work* (recommended): reads, staging and committing, reading pull requests and runs, tests and lint
4. *Routine plus an AI judge for the rest*

Deletes, force pushes, hard resets, skipped commit hooks, deploys, publishing and money wait for you in all four, when the command itself says so: a script file that does the same is not read.

**What it touches.** Files go to `~/.claude/vibequarters`; commands and skills to `~/.claude` (one of yours with the same name stays). Hook entries are added to `~/.claude/settings.json` after a dated backup; nothing of yours is removed, reordered or changed, a status line you have is replaced only if you say yes, and the write is refused if the file changed meanwhile. One import line is added to `~/.claude/CLAUDE.md` if you say yes. Settings live in `~/.claude/vibequarters.config.json`; every key is documented in `system/config/vibequarters.config.example.json`, and `system/config/settings.recommended.json` holds permission rules you may want to copy yourself. Nothing is downloaded, and there is no telemetry.

```sh
node "$HOME/.claude/vibequarters/install/verify.js"      # runs every installed hook on a test payload
node "$HOME/.claude/vibequarters/install/doctor.js"      # versions, packs, what is on
node "$HOME/.claude/vibequarters/install/uninstall.js"   # takes it all out again
```

These work in bash, zsh and PowerShell; in `cmd`, write `%USERPROFILE%` for `$HOME`.

Uninstalling puts `settings.json` back byte for byte when nothing else changed it, and otherwise takes out only its own entries. An `hq.config.json` the installer wrote goes too, unless you edited it. Your data (the coordination board, memory, usage history) stays. `VIBEQUARTERS_GUARD=off` in the environment turns every guard off for a session.

**Stricter than you may expect.** A force push is denied, on any branch, when the command itself spells it out: quoted, escaped, with a shortened option, as a `+` refspec, behind `sudo` or `bash -c`, or through an alias given with `git -c`. So is deleting `main`, `master` or a `release/` branch on the remote (`mergeGate.protectedBranches`). Not read: a script file, code in another language, a variable's value, an alias or `push` setting already in git's config or environment. A production deploy from a folder that is not a git repository is denied; a merge, a push to the default branch or a deploy is denied while GitHub cannot say which checks the branch requires. An output redirect to a relative path (`npm run build > build.log`) is denied, since a session's folder moves: use an absolute path, or turn that check off with `"VIBEQUARTERS_HYGIENE_SKIP": "cwd"` under `"env"` in `~/.claude/settings.json`. A heavy job (a test suite, build or type check) is denied while the processor is above `hygiene.heavyMaxCpu` percent or another one is running. A command that writes `settings.json`, `vibequarters.config.json`, `hq.config.json` or an installed hook asks you first, and one that writes the approvals choice, the approval lists or the agent switches is denied.

More: [how coordination works](../system/docs/session-coordination.md), [how memory works](../system/docs/memory.md).

**Network.** The hooks call out only on a command you or Claude run: the merge and deploy gates read pull requests and checks with your own `gh`, `merge-batch.js` fetches from your own git remote, and the Supabase pack probes a function right after you deploy it. Spend warnings talk to the app on `127.0.0.1`.

## Install

```sh
git clone https://github.com/KinetykStudios/vibequarters
cd vibequarters
```

There is no `npm install` step: the app has no dependencies, and the one library the page uses (Three.js) is vendored in `vendor/three`.

## Start

```sh
npm start
```

Then open the address it prints, normally <http://127.0.0.1:4747/>. If that port is busy it takes the next free one. To pick the starting port, set `VIBEQUARTERS_PORT`:

```sh
VIBEQUARTERS_PORT=7800 npm start          # macOS and Linux
$env:VIBEQUARTERS_PORT="7800"; npm start  # Windows PowerShell
```

With no config file it starts read-only, using `hq.config.example.json` for the office layout, and reads `~/.claude` under your home folder.

### Start it with Claude Code (optional)

`launch.js` starts the server if it is not running and opens the page once. The installer's `app` pack registers it. To do it by hand, so that it runs whenever a Claude Code session starts, add a `SessionStart` hook to your Claude Code settings (`~/.claude/settings.json`), with the path to your copy:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /path/to/vibequarters/launch.js" }] }
    ]
  }
}
```

## Demo mode

```sh
npm run demo
```

Demo mode starts the server against a throwaway `.demo` folder inside the app folder, with six made-up sessions, three running subagents, and a stand-in for the approval bridge that asks a permission, then a question, then another permission. Control mode is on, so on Windows you can answer them from the page. Every panel has made-up data too: the coordination board with file claims and a lock, the Queue with a batch, the deploy wall, keep-warm, the agent switches, a plan line with two accounts, and the approvals chooser. It never reads your real `~/.claude`, and it asks GitHub nothing. The demo uses port 7790 unless `VIBEQUARTERS_PORT` is set, and it replaces the `.demo` folder each time it starts.

## Configure

Copy the example and edit the copy:

```sh
cp hq.config.example.json hq.config.json
```

`hq.config.json` is git-ignored. When it exists, the server reads it instead of the example. The keys:

| Key | What it does |
| --- | --- |
| `appName` | The name in the page title and header. Defaults to "VibeQuarters". |
| `planUsd` | Your monthly Claude plan price in US dollars, used to compare against API-equivalent spend. |
| `control` | `true` turns on answering from the page (see below). Default `false`: the server is read-only. |
| `judge` | `true` lets an approve window ask an AI judge about requests that are neither routine nor yours. Default `false`. |
| `owner`, `departments`, `agents`, `sessionAvatars` | The 3D office: your figure, the rooms, which subagent types sit at which desk, and the looks for live sessions. `avatar.model` picks a person (the names are in `public/floor/people.js`); without one, each figure gets a person nobody already in the room wears while one is free. A modeled figure's `look` text becomes that person's. The colors and hair are for the built-in figure, which shows when a model does not load. |
| `assistant` | Optional. Turns on the voice assistant (see below). Leave it out to keep the assistant off. |
| `systemDir` | Where the system pack is installed (its hooks and approval presets). Default `~/.claude/vibequarters`. |
| `deploys` | Optional. Turns on the deploy wall (see [Panels](#panels)). Leave it out to keep it off. |
| `queue` | Optional. `repos` (a list of `owner/name`), `requiredChecks` (check names a batch needs) and `mainBranch` for the Queue panel's GitHub side. With no `repos`, GitHub is never asked. |
| `accountLabels` | Optional. Names for the accounts in the plan line, as `{ "<account key>": "Work" }`. |

Keys and secrets never go in the config file. They come from environment variables only:

| Variable | Used for |
| --- | --- |
| `VIBEQUARTERS_PORT` | The first port to try. |
| `ELEVENLABS_API_KEY` | The assistant's spoken voice (optional). |
| `VIBEQUARTERS_WHISPER_DIR` | A folder holding a local [whisper.cpp](https://github.com/ggml-org/whisper.cpp) build (`whisper-cli` and `ggml-base.en.bin`) for speech input (optional; `assistant.whisperDir` in the config works too). |

### Panels

Each panel shows only when there is something behind it. Most of them read files the system pack writes; the app works without the pack, and those panels stay hidden or say what is missing.

| Panel | What it shows | Where it reads from |
| --- | --- | --- |
| Board | Which session claimed which files, conflicts, locks and notes | `~/.claude/coordination/registry.json` |
| Queue | The heavy-job gate, locks, sessions, open requests, and batches of pull requests with their checks and reviews | `~/.claude/coordination`, and GitHub through the `gh` command for the repositories in `queue.repos` |
| Deploy wall | Recent deploys of one branch: building, live or failed, and how long each took | GitHub through the `gh` command, for the repository in `deploys` |
| Keep-warm | A switch per session that keeps its prompt cache warm | `~/.claude/hq-feed`, written by the system pack's mod in each session |
| Agent switches | Turns a subagent type off, so Claude Code refuses to start it | `~/.claude/hq-feed/agents-off.json`, enforced by the system pack's hook; the panel says so when the hook is not installed |
| Plan line | How much of the weekly and five-hour plan limits is used, and when each account resets | `~/.claude/vibequarters-usage`, written by the system pack's usage-line mod. It holds a salted key per account, never an email or an account id |

The deploy wall and the Queue's GitHub side use the [GitHub CLI](https://cli.github.com/) you are already signed in to, so VibeQuarters holds no token. Example:

```json
{
  "deploys": { "repo": "owner/name", "branch": "main", "provider": "vercel" },
  "queue": { "repos": ["owner/name"], "requiredChecks": ["build", "test"], "mainBranch": "main" },
  "accountLabels": { "<account key>": "Work" }
}
```

`provider` is `vercel` (the commit status Vercel posts), `status` (any commit status, named by `context`) or `checks` (a GitHub Actions job, named by `check`). The account keys are in `~/.claude/vibequarters-usage/accounts.json`; without a label, accounts show as "Account 1", "Account 2" and so on.

The Queue's check that a heavy job is still running is Windows only. Elsewhere the panel says it is not available and shows a job until its own time limit.

### Answering prompts from the page

The installer does steps 1 and 2 for you. By hand:

1. Set `"control": true` in `hq.config.json` and restart the server.
2. Register the bridge as hooks in `~/.claude/settings.json`, with the path to your copy:

```json
{
  "hooks": {
    "PermissionRequest": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node", "args": ["/path/to/vibequarters/bridge/hq-bridge.js"], "timeout": 900 }] }
    ],
    "PreToolUse": [
      { "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node", "args": ["/path/to/vibequarters/bridge/hq-bridge.js"], "timeout": 900 }] }
    ]
  }
}
```

3. Keep a VibeQuarters page open. While it is open, prompts show up in the page's "Needs you" list. When no page is open, the server is down, or anything fails, the bridge prints nothing and Claude Code asks you in the usual place.

Before the bridge acts on an answer it checks with the running server that the server wrote exactly that answer. On Windows it also confirms that the process on the server's port is this copy's `server.js`, using PowerShell and `netstat`. That second check is Windows only, so on other systems the bridge stands aside at once, Claude Code asks you in its own window, and the page says that answering is not available.

Optional: to type a message to a session from the page and have it delivered when the session's reply ends, also register the inbox as a `Stop` hook:

```json
{ "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/vibequarters/bridge/hq-inbox.js", "timeout": 86400, "asyncRewake": true }] }] }
```

### How much VibeQuarters approves for you

The first time you open the page with control on, it asks "How much should VibeQuarters approve for you?" You can change the answer any time from **Approvals** in the header.

| Choice | What it means |
| --- | --- |
| Ask me everything | Nothing is approved for you. Every permission prompt waits for your click. |
| Approve safe reads | Reading and searching files and looking at git history go through. |
| Approve routine coding work (recommended) | Everyday steps such as tests, lint and commits go through. File edits and anything risky ask you. |
| Routine plus an AI judge for the rest | The same, and a quick AI check on your own Claude login looks at what is left. Anything risky or unclear still asks you. |

Whatever you pick works only inside an approve window that you open. Deletes, force pushes, hard resets, skipped commit hooks, deploys, publishing and money tools ask you, when the command itself says so: that list comes from `approval-levels.json`, every choice carries it, and neither the page nor a model can edit it. The lists behind the choices come with the system pack (`<systemDir>/presets/approvals`). Without the pack, the app's own short read-only list is used, and "Ask me everything" still approves nothing.

### The assistant (optional)

Add an `assistant` object to `hq.config.json` (it can be empty: `"assistant": {}`) with control on, and restart. The assistant runs the `claude` command line on your own Claude login, in your home folder, in Claude Code's default permission mode, so every step Claude Code would ask about comes to the page as a card that waits for your yes. Its optional keys are `claude` (the path to the `claude` executable when it is not found on its own), `voiceId` and `ttsModel` (an ElevenLabs voice, with `ELEVENLABS_API_KEY` set), `whisperDir` (speech input), and `stripOpeners` (words it never speaks at the start of a reply).

## Safety defaults

- **Read-only until you say otherwise.** No config means `GET` requests only, on `127.0.0.1`, and no way to answer anything.
- **The page asks for everything.** With control on, nothing is approved unless you click, or open an approve window.
- **Approve windows** exist only with the assistant on, and are off until you ask the assistant for one (for a set number of minutes) and confirm its read-back. Inside a window:
  - a **routine** list is approved at once. Until you pick a choice in the approvals chooser, it is a short list of read-only tools and commands (`Read`, `Grep`, `git status`, `git diff`, `ls` and the like);
  - a **never-auto** list waits for you, when the command itself says so: deletes, force pushes, hard resets, skipped commit hooks, deploys, publishing, and money tools;
  - everything else waits for you too, unless you set `"judge": true` (or pick the choice with the AI judge), which asks an AI judge running on your own Claude login. The judge's rules (`assistant/judge.md`) leave anything risky or unclear for you.
- The app's own lists live in `approval-levels.json`. Edit them yourself; the assistant is told never to change that file, and the never-auto list should never be edited by a model.
- What looks like a secret in a transcript (keys, tokens, `.env` lines) is cut before the text reaches the page, best effort.

See [SECURITY.md](../SECURITY.md) for the details and how to report a problem.

### What leaves your computer

By default, nothing. The server listens on `127.0.0.1`, and the page loads every script, style and font from it. These features make outbound requests, each only after you turn it on:

| Feature | What it contacts | Turned on by |
| --- | --- | --- |
| Deploy wall | GitHub, through `gh` | `deploys` in the config |
| Queue, batches | GitHub, through `gh` | `queue.repos` in the config |
| Assistant and its prompt drafter | Claude, through your own `claude` command | `control` and `assistant` in the config |
| AI judge | Claude, through your own `claude` command | `judge` in the config, or the choice with the judge, inside an approve window |
| Keep-warm ping | Claude, through the session's own login | Its switch, for each chat |
| Spoken replies | ElevenLabs | `assistant.voiceId` and `ELEVENLABS_API_KEY` |
| Talk button | Speech recognition built into your browser, which may use the browser maker's servers, or a local whisper.cpp build in a browser where that does not work | Pressing Talk |

The app never reads or shows an email address or an account id.

## Tests

```sh
npm test
```

This runs the app's tests and the system's (`system/` and `install/`) one file at a time. The two mods have their own: `claude plugin test system/mods/usage-line` and `claude plugin test system/mods/hq-feed`. Some tests start the real server in a child process on a free port, and the few that need Windows itself (its process lookup, its paths) are skipped elsewhere.

## Not affiliated with Anthropic

VibeQuarters is an independent open-source project. It is not made, endorsed or supported by Anthropic. "Claude" and "Claude Code" are used only to describe the software it works with.

