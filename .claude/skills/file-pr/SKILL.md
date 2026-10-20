---
name: file-pr
description: File a pull request. Use when the user asks to file, open, or create a PR
---

# File PR

Before filing, check whether a PR for this branch already exists. Review the diff locally against a fresh `origin/main` to make sure its contents match the goal.

Look for opportunities to squash commits so that the commit history is easy to read, and only includes changes that made it into the final diff.

Once the branch is up-to-date with origin/main and squashed, Run integration/e2e tests locally before filing the PR. If there are easily fixable issues, fix them before refiling. If there are issues that you cannot resolve easily yourself, bail out and ask for help.

The test runs are long and main keeps moving. Fetch `origin/main` again right before `gh pr create` or a push, and rebase if it moved.

In a worktree session, run each git and gh command as its own Bash call, with literal arguments. The worktree guard refuses `&&` chains containing git and any `$(...)`, such as `gh pr list --head "$(git branch --show-current)"`: read the branch name first, then pass it.

## After filing

Watch the PR's CI until every check has finished: run `gh pr checks <number> --watch` as a background job and wait
for its notification. A filed PR is not done while its checks are running or failing.

When a check fails, read the failing job's log (`gh run view <run id> --log-failed`) and treat the failure as a bug,
including one that looks unrelated to the diff. Fix it on the branch, push, and watch again. A failure that looks
like a flake follows the Flakes rules in CLAUDE.md: search the issues, and file one if none covers it. Re-run a job
only once the evidence shows the failure is a known flake, and say so to the user. If the cause is out of reach,
stop and report the failure with its log.

## Merging

Merge only when the user asked for it, and only once every check is green. The repo merges with merge commits:
`gh pr merge <number> --merge`. Do not pass `--delete-branch`: it also deletes the local branch, which the worktree
has checked out.

The repo does not delete merged branches, so delete the remote branch after the merge:
`git push origin --delete <branch>`. Keep it only for a concrete reason, such as the user asking to keep it, and
name the reason to the user.

## PR Descriptions

ALWAYS open the description with a simple explanation of the problem based on the initial user's prompt, and then briefly explain the solution. NEVER lead with an implementation inventory:

BAD

> Removed implicit workspace carry-over from every "ne\I thread" entry point (cmd
> +n / cmd+shift+o, sidebar v1/v2 buttons, command palette). New threads inherit
> only the project from context; branch, worktree, and env mode always come from the configured defaults. Deleted buildContextualThreadOptions,
> startNewThreadInProjectFromContext, and the vl sidebar's seed-context machinery.

GOOD

> My "new worktree" default was ignored when starting new threads on existing worktrees. Super unintuitive. Now your preferences always apply.

Other tips:

- Titles should easy to understand. Conventional commit styles in projects that use them, ie. "fix(web): new threads no longer spike CPU"
- Add a blurb to the end of the PR description about what model and harness is making the changes
