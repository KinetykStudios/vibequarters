---
name: land
description: "Merge your own pull request safely: an independent reviewer subagent checks its exact head, you fix the findings, seven checks must pass, and the result is confirmed live and recorded. Arguments: <PR#> or <PR#> for <owner/repo>."
---

# /land

The session that wrote a pull request also merges it. Two hooks stand behind this procedure. `guard-deny-catastrophic.js`
blocks a merge into a live branch unless `review-proof.js` can prove a clean review of that head, and the coordination
hooks allow one merge at a time.

Arguments: `$ARGUMENTS`, meaning a PR number, a PR number followed by `for <owner/repo>`, or nothing if the PR does not
exist yet (section 1 creates it).

Keep the session open until the last section. Until then, end replies with
`Status: still running: landing #<n>, <time of the next result>`. The exception is a PR that belongs to a batch another session
is landing. Message that session and ask two things: that the batch contains this PR at this head, and that `proveReview`
succeeds there under that session's id, because the hook accepts only reviewers started by the session that merges. With
two yeses, leave your claims in place and tell the user this session may close.

## Terms

| Written as | Stands for |
|---|---|
| `<CLI>` | The `node ".../coord.js"` command from the session-start notice. Use one Bash call for each `<CLI>` command. |
| `<HOOKS>` | The folder with that `coord.js`, normally `~/.claude/vibequarters/hooks` |
| `<RP>` | `node "<HOOKS>/review-proof.js"` with the folder spelled out, using forward slashes |
| `<MB>` | `<CLI>` with `merge-batch.js` in place of `coord.js` |
| `<CFG>` | `~/.claude/vibequarters.config.json`; the settings used are `land.*` and `mergeGate.*`, with defaults in `vibequarters.config.example.json` |
| `<head>` | The PR's current 40-character commit, read with `gh pr view <n> -R <owner/repo> --json headRefOid --jq .headRefOid` |

Read `<head>` from GitHub when section 2 begins, in each round of section 3 and just before section 4. Use the latest
value in the brief, the verdict file, `proveReview` and `--match-head-commit`.

## 0. Preparation

1. Get this session's name from ListAgents and run `<CLI> register --name <name> --task "LAND #<n> <owner/repo>"`.
2. Run `gh pr view <n> -R <owner/repo> --json url,state,headRefName,headRefOid,baseRefName,title`. Take `<repo>` from the
   `url`, in GitHub's spelling. `<base>` is `origin/<baseRefName>`. If no repository was given, use
   `gh repo view --json nameWithOwner` in the worktree. If there is no PR yet, do this once section 1 has created it.
3. Use a worktree of your own that has the PR's branch, never another session's folder. If you need one, start from the
   clone `<land.cloneRoot>/<repo>` (if it is missing, ask the user for its location):
   `git -C <clone> fetch origin <headRefName>`, then
   `git -C <clone> worktree add -b land-<n> <land.worktreeRoot>/wt-land-<repo>-<n> origin/<headRefName>`.
   Push from it with `git -C <worktree> push origin HEAD:<headRefName>`.
4. Run `cd <worktree>` alone in one Bash call and `pwd` in the next. The reviewer inspects the session's working folder.
   If that is not the worktree, tell the user before you start a review.

## 1. Complete the change and open the PR

Run the checks the repository expects before a push; targeted tests are enough, since CI runs the rest. Prefer one PR.
Decide now how the change will be confirmed in production (the live check) and which similar request must fail or give a
different answer (the control).

If `mergeGate.requirePrDeclaration` is on, the PR body needs one of these lines. `merge-batch.js build` rejects a PR that
has neither and a batch that lacks a part:

- `Ships alone: <what a user gets>` for a PR that is useful without others
- `Update: <name> part <k> of <n>` for a piece of a larger change

Parts of one update are merged as a group when every part is built and reviewed; where approval is needed, ask for all of
them together. In a batch repository the group is one batch, elsewhere merge in order. A part that only prepares for a
later one does not go live alone. A part that already helps users may, under `Ships alone:`, while another part has no PR;
mention it to the user.

Repositories not listed in `mergeGate.batchRepos` need an up-to-date branch before the review:
`gh pr update-branch <n> -R <owner/repo>`, `git -C <worktree> pull --ff-only origin <headRefName>`, then
`gh pr checks <n> -R <owner/repo> --watch` until all checks have finished. Batch repositories skip this, because their
members merge in batch order.

## 2. Independent review

1. Read `<head>`, run `git -C <worktree> fetch origin`, and make sure `git -C <worktree> rev-parse HEAD` is the same
   commit. Push commits that exist only locally and read `<head>` once more. If GitHub is ahead, pull with `--ff-only`.
2. Produce the brief in one Bash call:
   `<RP> prompt --repo <repo> --pr <n> --head <head> --base <base>`
3. Start the reviewer with the Agent tool: `subagent_type: "general-purpose"`, `model:` from `mergeGate.reviewerModel`
   (`opus` unless set), `run_in_background: true`, and a `prompt` that is exactly the output of the previous step with
   nothing added. The hook builds the brief again, compares every byte, and checks the model.
4. Do not send the reviewer any message. Start a new reviewer if this one was messaged, was compacted or survived a
   restart of Claude Code. Do not use `/clear` before the merge, because the session id would change and the hook would
   no longer find the reviewer.
5. After it ends, look up the session id with `ls ~/.claude/projects/*/*/subagents/agent-<agentId>.meta.json`. It is the
   name of the folder that contains `subagents`.
6. Let `review-proof.js` store the result. It takes the reviewer's final message from the transcript and saves it as
   `~/.claude/coordination/reviews/<repo>-<n>-<head>.txt`. A file typed by hand will not match the transcript. One call:
   `<RP> write --repo <repo> --pr <n> --head <head> --session <session id> --agent <agentId>`
   The answer has `"ok":true` and the file name, or `"ok":false` and a reason. Verdicts that are not clean are stored
   too, since section 3 builds on them.

## 3. Repair and review again

Fix all Critical and Important findings in this session, run the pre-push checks, push, and repeat the comparison from
section 2 step 1. The next review covers only the difference. `<old>` is the 40-character commit after `head ` in the
first line of the newest verdict file.

Brief: `<RP> prompt --repo <repo> --pr <n> --head <head> --base <base> --delta-over <old>`

Verdict: `<RP> write --repo <repo> --pr <n> --head <head> --session <session id> --agent <agentId> --delta-over <old>`

The rules of section 2 apply to this reviewer as well. Earlier verdict files stay, because the hook follows the chain.
Repeat until the final line is `VERDICT: CLEAN - 0 Critical, 0 Important, <n> Minor`. If five rounds do not get there,
stop and tell the user. Every push, whatever its purpose, creates a head that needs a further review of the difference.
The last `VERDICT:` line in a message is the one that counts.

## 4. Seven checks

A merge without asking the user needs all seven, each with evidence. Read `<head>` again; if it differs from the newest
clean verdict, return to section 3. In batch repositories the batch PR supplies checks 1 and 2. Elsewhere, do this after
the last `update-branch`.

1. **CI.** Every required check passed at this head. Required means the repository's entry in
   `mergeGate.requiredChecks`, otherwise the branch protection contexts
   (`gh api repos/<owner/repo>/branches/<baseRefName> --jq '.protection.required_status_checks.contexts'`), otherwise
   every check. For a batch, this covers the batch PR at its tested head and each member's own required checks. A check
   that is pending, skipped or neutral when it usually runs does not pass. Evidence: `gh pr checks <n>` and run links.
   If the repository has no checks, the hook asks the user; note that in the record.
2. **Preview.** If `land.deployCheck` names a provider, its preview is ready and the live check and the control behave
   as intended there. If the change is visible, also take screenshots of each changed screen at widths 390 and 1440 and
   describe alignment, spacing and overflow. A build that succeeds is not a substitute. Say so if no physical device was
   used. Without previews, record "no preview" and do the live check in section 7.
3. **Nothing separate is pending.** The PR needs no migration, no function or production deploy and no deletion.
   `gh api repos/<owner/repo>/pulls/<n>/files --paginate --jq '.[] | select(.status=="removed") | .filename'` has to
   print nothing (`gh pr view` shows no more than 100 files).
4. **No sensitive path.** `gh pr diff <n> --name-only` has none of these, and doubtful cases count as sensitive: login
   and sessions, access policies, billing and payouts, personal data, secrets and `.env*`, `.github/**`, `.claude/**`,
   quality checks and their settings, deploy settings such as `vercel.json`, `netlify.toml` or `fly.toml`, migrations,
   server functions with keys, dependency changes in `package.json`, lockfiles. In a repository made of agent
   configuration, every file is sensitive.
5. **Same head.** The head about to merge is the one in the first line of a clean verdict file.
6. **Proof.** This prints `"ok":true`:
   `<RP> prove --repo <repo> --pr <n> --head <head> --session <session id> --base <base>`
   Otherwise the printed reason is what the hook will say; solve it in section 2 or 3.
7. **Merge command.** Squash with a body file, no AI attribution in the title or text, and neither `--auto` nor
   `--admin`.

Checks 1, 2, 5, 6 and 7 are yours to correct; if you cannot, ask the user. For check 3 or 4 go to section 5.

Post the record (last section) with `<CLI> note "<record>"` before merging. An automatic approver may read it. If a merge
is refused anyway, ask the user.

## 5. Asking the user

Use this for a miss of check 3 or 4. Ask once, with the list of sensitive files, migrations, deploys and deletions and
the reviewer's remarks on each. A yes is valid for that head alone. Migrations and deploys then run one after another in
the necessary order, each with its own yes. Until the answer arrives:
`Status: still running: landing #<n>; waiting on you: <the decision>`.

## 6. Merge

The coordination hooks take the merge lock for a `gh pr merge` call and release it afterwards. If another session has
it, wait. Force-pushing is not an option.

### Batch repositories (`mergeGate.batchRepos`)

A batch can hold a single PR. The hooks refuse a merge outside a passing batch or out of its order. Issue every printed
command as a separate Bash call. The batch needs a clean worktree:
`git -C <clone> worktree add --detach <land.worktreeRoot>/wt-batch-<n> origin/main`.

1. `<MB> build --repo <owner/repo> --prs <n> --dir <clean worktree>`. Entries under `dropped` conflict; resolve them on
   their own branch, push, review the difference and build again. If another batch is being tested, wait as long as the
   message says.
2. Run the commands listed under `next`: push `batch/<id>`, create a draft PR, and `<MB> opened --id <id> --batch-pr <b>`
   with its number. That draft only runs CI and the preview; it never becomes ready and is never merged.
3. `gh pr checks <b> -R <owner/repo> --watch`. After a failure, repair the member's branch, push, review the difference
   and build again.
4. Do section 4 for the batch, and section 5 if check 3 or 4 fails.
5. Save a short summary for each PR as `<n>.md` in one folder, for example
   `~/.claude/coordination/batches/<id>-bodies/`, without co-author or "generated with" lines. Run
   `<MB> plan-land --id <id> --bodies <folder>`. It declines when main or a member has moved or the batch is not passing;
   build again in that case.
6. `<CLI> note "<record>"`.
7. Run the printed merges in order without updating branches in between. Members before the last carry `[batch-part]`,
   which `system/templates/vercel-ignore-build.mjs` uses to skip their builds. The last has `Batch-Head: <sha>` and
   triggers the production build. The hooks accept only body files made by `plan-land`.
8. `<MB> verify --id <id>` must show `"landed": "N/N"` and `"treeMatch": true`. If it does not, stop, tell the user and
   prepare a revert for their approval. A batch that ended partway leaves production older than main; the command then
   prints `PRODUCTION IS BEHIND MAIN` with a `recovery` line. Finish the remaining merges. If that is impossible, wait
   for the checks on the newest main commit, get the user's approval, and deploy from a worktree at `origin/main`.

### Other repositories

1. The branch is up to date and `gh pr checks <n> -R <owner/repo> --watch` is all green. The hook enforces this, refuses
   `--admin` and `--auto`, and asks the user if a repository has no checks or the PR removes more files than
   `massDelete.fileLimit`.
2. Section 4 passed, or the user approved in section 5.
3. `<CLI> note "<record>"`.
4. `gh pr merge <n> -R <owner/repo> --match-head-commit <head> --squash --body-file <file> --subject "<title> (#<n>)"`
   with the value read before section 4. The body file is a short summary in your own words.

## 7. Confirm and close

1. Wait for the production deploy. With `land.deployCheck` set to `vercel`, read the status called `land.deployContext`
   from `gh api repos/<owner/repo>/commits/<sha>/status`. With `github`, read
   `gh api repos/<owner/repo>/deployments?sha=<sha>` and the newest entry of its `statuses_url`. With `none`, skip this.
   For agent configuration, going live usually means copying files; compare them byte for byte.
2. Run the live check and the control in production. If the live check fails, tell the user immediately and have a
   revert PR ready for their approval.
3. `<CLI> landed <n> --gate "<record>, merge <merge sha>; live check <output>; control <output>"`, one PR per call, from
   your worktree. This is kept in `~/.claude/coordination/GATE-RECORDS.md`.
4. `<CLI> unlock <lock>` for each lock the board still shows for this session, then
   `<CLI> task "DONE: landed #<n>; tab can close"`. Leave worktrees for the user to remove.
5. Tell the user what works now, the live check's output and the merge commit, and end with
   `Status: all done.`

## Record format

A single line without double quotes. `<head>` is the full commit:

`land gate, PR #<n> at <head>: 7 of 7. ci <run URL> | preview <URL>, live check and control ok | nothing pending, <k> files removed | high-risk paths: none | review matches this head | proof <reviews file> | squash, body from file`

For a batch, put `batch <id>, PR #<b> at <sha>` after the count.

`7 of 7` is only for a full pass. If the user accepted a miss, give the true count and append
`asked the user: check <k> missed (<why>); their yes <time>`. Leave out the batch part when there is no batch, and append
`verify N/N, tree match` after one.
