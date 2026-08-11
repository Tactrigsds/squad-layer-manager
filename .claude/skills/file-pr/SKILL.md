---
name: file-pr
description: File a pull request. Use when the user asks to file, open, or create a PR
---

# File PR

Before filing, check whether a PR for this branch already exists. Review the diff locally against a fresh `origin/main` to make sure its contents match the goal.

Look for opportunities to squash commits so that the commit history is easy to read, and only includes changes that made it into the final diff.

Once the branch is up-to-date with origin/main and squashed, Run integration/e2e tests locally before filing the PR. If there are easily fixable issues, fix them before refiling. If there are issues that you cannot resolve easily yourself, bail out and ask for help.

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
