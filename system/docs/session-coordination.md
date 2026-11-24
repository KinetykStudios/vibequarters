# Session coordination

Any number of Claude Code sessions on one machine work the same repositories like a team: they know about each other, each file has one editor at a time, each worktree one session, migrations, deploys and merges run one after another, and a change to somebody else's file is requested from its owner. Hooks enforce it.

## Limits
- One machine only. Cloud sessions and sessions on other computers do not share the disk, so they are not covered.
- Edit tools are checked per file before the edit. Files changed by shell commands (sed, code generators, scripts) are caught at `git push`, `gh pr create` and `gh pr merge`.
- Two tasks that need the same file still take turns. The rule makes that a conversation before the edit instead of a merge conflict after it.
- Fails open: an error inside the hook lets the tool run. `VIBEQUARTERS_GUARD=off` turns it off.
- The shell-write check reads the command's text. It does not see what a program writes, `$(...)`, `bash -c`, `xargs`, or pipeline input. Repository files those miss are still caught at push.
- A `coord.js` command must be the only command in its call; chained with anything but a read it is denied.

## State
`~/.claude/coordination/registry.json`, and `BOARD.md` rendered from it. Writes take a folder lock and replace the file atomically.
- session: `{ id, name, task, cwd, top, registeredAt, lastSeen, endedAt? }`
- claim: `{ repo, path, session, worktree, at, heldUntil? }`; `repo` is the git common dir, so every worktree of one repository shares claims, and `path` is relative to it
- request: `{ id, repo, path, from, to, change, at, state }`, state `open | done | handed | withdrawn | resolved`; patches in `handoffs/<id>.patch`
- lock: `{ name, session, at }`, one row per lock name in the config's `locks` table plus `merge`
- note: free text from `coord.js note`

## Definitions (times from `coordination.*` in the config)
- live session: registered, not ended, seen in the last `liveHours`
- active claim: the file is dirty in the owner's worktree, or differs from the remote default branch while the owner's own committed change is not on it yet; any doubt counts as active. A merged, reverted or shipped file releases itself, and so does a missing worktree.
- occupied worktree: a live session's folder, or one where it holds an active claim

## What `coord-guard.js` does on each tool call
1. Records that the session is alive.
2. Runs `coord.js` commands with the session's real id. Overriding another session (`force-release`, `end-session`, `force-handoff`) asks the user, except when everyone overridden is closed with nothing unpushed.
3. A file edit in a git repository: denied for an unregistered session, in a worktree another live session uses, or on a file another session owns (with the request steps); otherwise the file is claimed.
4. A shell command that writes into, removes or moves another live session's worktree: denied.
5. Mutating git (`checkout`, `reset`, `merge`, `commit` and the like) in an occupied worktree: denied.
6. Before a push, and before a pull request is opened or merged, the branch's files are checked against other sessions' claims.
7. `gh pr merge` takes the `merge` lock and needs a head that is up to date with its base.
8. Commands and MCP tools in the `locks` table take their lock. A shell deploy from a worktree without the remote default branch is denied, since it would ship older code over newer.

## Session lifecycle (`coord-session.js`)
- Start, resume, clear and compact print the rules, the handoff steps and the live board. A `/clear` hands the ended session's record and claims to the new id.
- End marks the session closed and frees its locks. Its claims stay only while its unmerged work does.
- Registering a name that exists takes over that record's claims; when it still holds any, the user is asked first.

## Asking for a file
1. `coord.js request "<path>" "<the change and why>"`, then SendMessage the owner the same change. Carry on with other work.
2. The owner sees `COORD REQUEST <id>` beside its tool results. It makes the change and runs `done <id>`, or runs `handoff <id>`, which saves its unfinished change as a patch, moves the claim for a while, and says how to drop the file from its branch.
3. The requester is told once: `done` (it ships with the owner's pull request), `handed` (apply the printed patch first), or `resolved` (update from the default branch).
4. No answer for `forceHandoffMinutes`, or a closed owner: `force-handoff <id>` asks the user. Merges, deploys, migrations and deletes a peer asks for still need the user.

## Tests
`system/hooks/tests/coord.test.js` and `coord-merges.test.js`: throwaway repositories with worktrees, a temporary registry, two made-up session ids, and a negative control for every rule.
