---
name: heartbeat
description: Short, read-only status check of the project. Looks at recent errors, project-defined checks, waiting signals, unsaved work and advisor warnings, and lists what needs attention. Use when the user asks what needs attention, or on a schedule the user sets up.
argument-hint: "[optional: one item to check]"
allowed-tools: Read, Glob, Grep, Bash, Skill, Agent
model: opus
---

# /heartbeat

Check the items below, or only `$ARGUMENTS` if it names one. Everything here is read-only. Report what you find and
change nothing.

| Item | Where to look |
|---|---|
| Errors in production | Hosting and database logs that a connected CLI or MCP server can read |
| Project checks | The section titled "Heartbeat" in the project's `CLAUDE.md`, if it has one |
| Waiting signals | `.pending-evolve` and `INBOX.md` in the loop folder; suggest `/evolve` if there are any |
| Unsaved work | `git status --porcelain` and commits that have not been pushed |
| Warnings | Security or performance advisors of connected tools, and entries in `MISTAKES.md` without a working guard |
| Ledger size | Ledgers close to their limit, or not updated for a long time |

## Limits

Do not commit, push, deploy, send, publish, pay or change access as part of this command. Describe the action and leave
it to the user. Use subagents only if a log is too long to read directly.

## Report

One line for each item: fine, or what needs attention and where. End with at most one recommended action. If all items
are fine, two or three lines are enough.

## Running it regularly

Schedule this only if the user asks. A schedule inside a session ends with the session and expires after seven days; a
permanent one needs the operating system's scheduler, which the user sets up or approves.
