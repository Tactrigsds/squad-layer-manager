---
name: cut-release
description: Cut an SLM app release with `pnpm release`, file its PR, merge it and confirm CI tagged it. Use when the user asks to cut, ship or publish a release.
---

# Cut a release

CONTRIBUTING.md, "The changelog and app releases", describes what a release is. These are the steps.

1. Start a worktree for the release, then fetch and move it to `origin/main`. A new worktree can branch from a stale
   local `origin/main`, and `pnpm release` refuses to run anywhere but a clean checkout of the latest main.

   ```sh
   git fetch origin main
   git reset --hard origin/main
   ```

2. Run `pnpm release`. It prints the version it cut and the pull requests since the last release that opted out of a
   fragment with `Changelog: none`, each with its reason.

3. Read every reason in that list. A reason holds when nobody using or running SLM could notice the change, or the
   change refines a feature whose fragment has not shipped. When a reason does not hold, stop and tell the user. The
   missing fragment is added on main by its own PR, and the release is cut again from step 1.

4. Commit on a `release/<version>` branch. The pre-push hook reads only commit messages, so the opt-out goes in the
   commit:

   ```sh
   git switch -c release/<version>
   git add -A changes changelog CHANGELOG.md
   git commit -m "chore(release): <version>" -m "Changelog: none, this is the release commit"
   ```

5. Fetch `origin/main` again. If main moved, a PR merged since step 1, so go back to step 1. Otherwise push and open
   the PR, titled `chore(release): <version>`. The description names the release, the number of fragments it moved,
   what CI does after the merge, and the `Changelog: none` line. PR #579 is an example.

6. When the checks pass, merge the PR with a merge commit. Then watch the SLM Docker CI run on the merge commit:

   ```sh
   gh run list --commit <merge sha> --json databaseId,workflowName,status
   gh run watch <run id> --exit-status
   gh api repos/Tactrigsds/squad-layer-manager/git/ref/tags/v<version> --jq .object.sha
   ```

   The jobs `tag-release`, `publish / tag-latest` and `publish / deploy` pass, and the tag names the merge commit.
   A release PR labelled `fasttrack` is tagged only once the integration suite passes on the merge commit.
