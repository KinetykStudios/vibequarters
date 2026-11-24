---
name: evolve
description: Update the project's learning ledgers from recent sessions. Reads the captured signals, keeps the lessons that will matter again, merges or removes outdated entries, keeps each file within its size limit and suggests which lessons should become checks. Use at the end of a longer session, when the session-start notice says signals are waiting, or when the user asks to save what was learned.
argument-hint: "[optional project path; default is the current project]"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, TodoWrite, Agent
model: opus
---

# /evolve

The Stop hook records short signals in `INBOX.md` after sessions with real activity. This command reads those signals,
works out which of them contain lessons, and edits the ledgers that later sessions load.

Project to update: `$ARGUMENTS`. If it is empty, use the current project.

A run should leave the ledgers more useful without making them longer: look for something to remove every time, and
include the removals in the report.

## Step 0: find the folder

The folder name is the project path with each character other than a letter or digit replaced by a dash. Hooks use the
same rule.

```bash
TARGET="${ARG:-$(pwd -W 2>/dev/null || pwd)}"
KEY=$(printf '%s' "$TARGET" | sed 's/[^a-zA-Z0-9]/-/g')
LOOP="$HOME/.claude/projects/$KEY/memory/loop"
ls -la "$LOOP"
```

If the folder has no `LEARNING-LOG.md`, the project has no ledgers. Stop and suggest `/loop-init`. Do not create files
and do not use a different project's folder.

| File | Limit in bytes | Contents |
|---|---|---|
| `LEARNING-LOG.md` | 8192 | Index loaded in every session: top rules, pointers, recent sessions, run log |
| `PREFERENCES.md` | 12288 | How the user likes work done in this project |
| `PATTERNS.md` | 12288 | Approaches that have worked here |
| `MISTAKES.md` | 12288 | Errors with their cause and the check that prevents them |
| `EFFICIENCY.md` | 8192 | Ways to save tokens, time or money |

`INBOX.md` and `.pending-evolve` are read and then reset. The hooks own `ACTION-LEDGER.jsonl` and `RUNSTATE.json`; leave
both alone.

## Step 1: wait for other runs, then copy the files

Another session might be updating the same ledgers. Wait until no ledger and no backup has changed for three minutes.
Use `run_in_background` for this call and continue once it ends. Shell variables do not carry between calls, so set `LOOP`
again in each one:

```bash
LOOP="<the folder from step 0>"
[ -d "$LOOP" ] || { echo "no ledger folder: $LOOP"; exit 1; }
quiet() { local f; f=$(find "$LOOP" -maxdepth 1 -mmin -3 \( -name 'LEARNING-LOG.md*' -o -name 'PREFERENCES.md*' -o -name 'PATTERNS.md*' -o -name 'MISTAKES.md*' -o -name 'EFFICIENCY.md*' \)) && [ -z "$f" ]; }
until quiet; do echo "ledgers in $LOOP changed recently, waiting"; sleep 30; done; echo "no recent changes"
```

Then copy the five files. The time stamp keeps each run's copies separate:

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
for f in LEARNING-LOG PREFERENCES PATTERNS MISTAKES EFFICIENCY; do
  [ -f "$LOOP/$f.md" ] && cp -n "$LOOP/$f.md" "$LOOP/$f.md.bak-$STAMP"
done
echo "STAMP=$STAMP"; ls -la "$LOOP"/*.bak-"$STAMP"
```

Write down the stamp. Should any later step fail, put these copies back and say so.

## Step 2: collect candidates

Open the five ledgers first, so that new entries can be merged into old ones. Then look at:

- `INBOX.md`, which names the sessions worth examining. Its lines are counts, not lessons.
- This conversation: what the user corrected, what succeeded, what failed, what proved untrue.
- `git log --oneline -20` in the project, for what was released.

## Step 3: choose and write

Keep a candidate only if knowing it would alter a later decision. Discard one-time details and anything the code or
`CLAUDE.md` already states. Discard anything you cannot put as a definite rule; do not guess at one.

| Kind of lesson | File |
|---|---|
| A preference or correction from the user | `PREFERENCES.md` |
| A technique that works in this code base | `PATTERNS.md` |
| An error, its cause and a `Guard:` line | `MISTAKES.md` |
| A saving | `EFFICIENCY.md` |
| Something every session needs | `LEARNING-LOG.md`, under Top rules |

For each one, add an entry, improve an existing entry that covers it, or remove an entry that is now wrong, replaced or
enforced elsewhere. Count each kind of edit. Copy the file's own format and order.

## Step 4: suggest checks

If a lesson keeps returning (three times or more), or ignoring it would be destructive, suggest an automatic check: a
hook, a line in the project's `CLAUDE.md`, or a test or lint rule. Describe the check and where it belongs. Make the
change only after the user agrees, since `guard-config.js` protects that configuration. Once a check exists, remove the
ledger entry it makes unnecessary.

## Step 5: fit the limits

```bash
wc -c "$LOOP"/LEARNING-LOG.md "$LOOP"/PREFERENCES.md "$LOOP"/PATTERNS.md \
      "$LOOP"/MISTAKES.md "$LOOP"/EFFICIENCY.md
```

Shorten a file that is too large by merging entries, tightening sentences, moving detail from `LEARNING-LOG.md` to the
ledger it belongs in, or removing entries that no longer apply. Do not simply cut off the end. If only real content is
left and the file is still too large, name the entry you would drop and ask. Measure again afterwards.

## Step 6: update the index

In `LEARNING-LOG.md`:

- Keep Top rules to the few that every session needs.
- Under Recent sessions, add an entry for what was released and confirmed, and keep about three.
- Under Run log, add a line on top: date, lessons kept, what was removed and why, one improvement for the next run, and
  the counts (`added`, `merged`, `removed`, `checks added`, total bytes of the five files as measured).

If little was learned or nothing was removed, the line says so.

## Step 7: reset the inputs

After the ledgers are written and measured:

- Empty `INBOX.md` down to the header that the Stop hook writes.
- Remove `.pending-evolve`, and run `touch "${LOOP:?}/.last-evolve"`. For 20 hours after that the hook records signals
  without asking for another run.
- Once step 8 passes, remove the copies made in step 1 with `rm "${LOOP:?}"/*.md.bak-<stamp>`, using the stamp you wrote
  down. The `:?` makes the command fail if the variable is empty. Copies from other runs stay.

If the run did not complete, leave `.pending-evolve` in place.

## Step 8: check and report

```bash
wc -c "$LOOP"/*.md
ls -la "$LOOP"
```

Confirm that all five files are within their limits, `INBOX.md` is empty, the flag is gone and this run's copies are
gone. Report briefly what was added and where, what was merged, what was removed with the reason, which checks you
suggest, and the counts.

## Automatic runs

If `.pending-evolve` contains the word `AUTORUN`, `loop.autoEvolve` is on in the configuration and no question is needed:
run at the next break between tasks, for example during a build. Step 4 still needs the user's agreement. Without that
word, mention the waiting signals and let the user decide.
