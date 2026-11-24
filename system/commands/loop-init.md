---
name: loop-init
description: Create the learning ledgers for the current project so the session hooks have something to load and update. Run it once in each project that should have them. Running it again changes nothing that already exists.
allowed-tools: Read, Edit, Write, Bash
model: opus
---

# /loop-init

Creates the ledger folder of the current project. `/evolve`, `/loop-until` and `/heartbeat` are available everywhere and
need no setup.

1. Work out the folder: `~/.claude/projects/<key>/memory/loop/`, with `<key>` being the working directory in which every
   character that is not a letter or digit becomes `-`. Create the folder if it is missing.

2. Create each of these files unless it is already there:

   | File | Limit | Sections |
   |---|---|---|
   | `LEARNING-LOG.md` | 8 KB | `## Top rules`, `## Recent sessions`, `## Run log` |
   | `PREFERENCES.md` | 12 KB | `## Entries` |
   | `PATTERNS.md` | 12 KB | `## Entries` |
   | `MISTAKES.md` | 12 KB | `## Entries` |
   | `EFFICIENCY.md` | 8 KB | `## Entries` |

   Start every file with its name as a `#` heading and a line giving its limit, for example
   `Limit: 12 KB, maintained by /evolve.` `loop-spot.js` owns `SPOT.md` in the same folder; do not create or change it.

3. Look for `loop-session-start.js` and `loop-session-stop.js` in `~/.claude/settings.json`. The installer's learning
   pack adds both for all projects, and then there is nothing to do here, because a second registration would run them
   twice. If they are missing, add them to the project's `.claude/settings.local.json`. Save a copy of that file first,
   append to its lists, and parse the result as JSON afterwards.
   - `SessionStart`: `node "<home>/.claude/vibequarters/hooks/loop-session-start.js"`
   - `Stop`: `node "<home>/.claude/vibequarters/hooks/loop-session-stop.js"`

   Write the home folder as an absolute path with forward slashes. If `systemDir` is set in
   `~/.claude/vibequarters.config.json`, use that folder in place of `.claude/vibequarters`.

4. Report which files exist now and their sizes, whether the hooks are registered, and that other hooks are as they
   were. Never remove or loosen a hook.
