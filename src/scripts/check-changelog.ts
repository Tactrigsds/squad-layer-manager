import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { parseArgs } from 'node:util'

import * as Paths from '$root/paths.ts'
import * as CL from '@/models/changelog.models'
import * as ChangelogFiles from '@/systems/changelog-files.server'

// Checks the changelog. Run with `pnpm changelog:check`, which validates every fragment, and in CI with
// `--base <ref>`, which also checks the pull request records what it changes:
//
// - a PR whose commits are all background types (refactor, test, ci, style, chore, docs, build) needs nothing
// - any other PR adds or edits a pending fragment, or says `Changelog: none` in its description or a commit
//   message, optionally followed by a reason on the same line
// - a PR with a breaking commit (`feat!:`, `fix(scope)!:`) adds or edits a pending operators fragment, and cannot
//   opt out
//
// `pnpm release` moves every fragment out of changes/, so a fragment there is pending: it has not shipped. An edit
// counts only if the fragment is still pending on the base, since one released there since the merge base has
// shipped.
//
// The PR description comes in through the PR_BODY environment variable.

const args = parseArgs({ options: { base: { type: 'string' } } })

function git(...gitArgs: string[]) {
	return execFileSync('git', gitArgs, { encoding: 'utf8' }).trim()
}

const problems: string[] = []
const loaded = ChangelogFiles.load(Paths.CHANGELOG, Paths.CHANGES)
problems.push(...loaded.errors)

const base = args.values.base
if (base) {
	// `..` for the log, since `...` there is the symmetric difference and would count the base's own commits on a
	// branch that is behind it. The diff's `...` is from the merge base, which is what we want.
	const range = `${base}...HEAD`
	const commits = git('log', '--no-merges', '--format=%x1e%s%x1f%B', `${base}..HEAD`)
		.split('\x1e')
		.filter(Boolean)
		.map((raw) => {
			const [subject, message] = raw.split('\x1f')
			return { subject, message }
		})
	// a fragment's id is its file name, so a renamed fragment is a new entry
	const fragmentIds = (diffFilter: string) =>
		git('diff', '--name-only', '--no-renames', `--diff-filter=${diffFilter}`, range, '--', 'changes/')
			.split('\n')
			.filter((file) => file.endsWith('.md') && path.basename(file) !== 'README.md')
			.map((file) => path.basename(file, '.md'))
	const added = fragmentIds('A')
	const modified = fragmentIds('M')
	const pendingOnBase = new Set(
		git('ls-tree', '--name-only', base, '--', 'changes/')
			.split('\n')
			.map((file) => path.basename(file, '.md')),
	)
	const touched = new Set([...added, ...modified.filter((id) => pendingOnBase.has(id))])
	const touchedEntries = loaded.pending.filter((entry) => touched.has(entry.id))

	const breaking = commits.filter((c) => CL.CONVENTIONAL.exec(c.subject)?.groups?.breaking)
	if (breaking.length > 0 && !touchedEntries.some((entry) => entry.audience === 'operators')) {
		problems.push(
			`breaking commits need a new or edited operators fragment in changes/ saying what an upgrade has to do:\n    ${breaking.map((c) => c.subject).join('\n    ')}`,
		)
	}

	const optedOut = CL.OPT_OUT.test(process.env.PR_BODY ?? '') || commits.some((c) => CL.OPT_OUT.test(c.message))
	const needsFragment = commits.filter((c) => !CL.isBackgroundSubject(c.subject))
	if (touchedEntries.length === 0 && !optedOut && needsFragment.length > 0) {
		problems.push(
			'this PR changes more than background code but adds or edits no pending fragment in changes/. Add one (see changes/README.md), ' +
				'or put "Changelog: none" in the PR description or a commit message if nobody using or running SLM would notice. ' +
				'A reason can follow on the same line: "Changelog: none, fixes a bug that never shipped". ' +
				`Commits:\n    ${needsFragment.map((c) => c.subject).join('\n    ')}`,
		)
	}
}

if (problems.length > 0) {
	for (const problem of problems) console.error(`changelog: ${problem}`)
	process.exit(1)
}
console.log('changelog: ok')
