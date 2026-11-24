---
name: loop-until
description: Repeat work and measurement until a stated condition is true, then report. Use when the user gives a goal with a condition that can be tested and wants it worked on without a check-in after every attempt.
argument-hint: "[goal and the condition that ends it, for example: all links on the docs site return 200]"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, Skill, Agent, Workflow, TodoWrite, WebFetch, WebSearch
model: opus
---

# /loop-until

Goal and end condition: `$ARGUMENTS`

## Before the first attempt

Write both into a scratch file named `GOAL.md`. The condition must be something a command can measure, such as a passing
type check or a list of URLs that all answer. If the user's condition cannot be measured, agree on one that can.

## Each attempt

1. Read `GOAL.md` again and drop any step that does not serve it.
2. Make the change.
3. Measure with the real tool: run the tests, request the page, search the files. Reading your own work over does not
   count as a measurement, and counts come from a program.
4. Stop if the condition is true. Otherwise find out what is still wrong and begin the next attempt.

Do not report between attempts unless you must stop.

## When to stop early

- After ten attempts, or the number the user gave.
- When two attempts in a row bring no measurable progress.
- When a step needs approval: something other people will see, something that cannot be reversed, spending, or a legal
  question. Looping never replaces that approval.
- When a hook refuses or asks. `guard-runaway.js` asks about very long or repetitive runs, the deny hooks block
  destructive commands, and creating `~/.claude/HALT` ends everything. `ACTION-LEDGER.jsonl` keeps a record of actions.

## Afterwards

State whether the condition was met, how many attempts it took, and the last measurement in full. If it was not met, say
where progress ended and what blocks it. Suggest `/evolve` if a lesson is worth keeping.
