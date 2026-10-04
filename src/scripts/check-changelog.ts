import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { parseArgs } from 'node:util'

import * as Paths from '$root/paths.ts'
import * as ChangelogFiles from '@/systems/changelog-files.server'

// Checks the changelog. Run with `pnpm changelog:check`, which validates every fragment, and in CI with
// `--base <ref>`, which also checks the pull request records what it changes:
//
// - a PR whose commits are all background types (refactor, test, ci, style, chore, docs, build) needs nothing
// - any other PR adds a fragment to changes/, or says `Changelog: none` in its description or a commit message,
//   optionally followed by a reason on the same line
// - a PR with a breaking commit (`feat!:`, `fix(scope)!:`) adds an operators fragment, and cannot opt out
//
// The PR description comes in through the PR_BODY environment variable.

const BACKGROUND_TYPES = new Set(['refactor', 'test', 'ci', 'style', 'chore', 'docs', 'build'])
const OPT_OUT = /^changelog:\s*none(?![\w-])/im
const CONVENTIONAL = /^(?<type>[a-z]+)(?:\([^)]*\))?(?<breaking>!)?:/

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
	const added = git('diff', '--name-only', '--no-renames', '--diff-filter=A', range, '--', 'changes/')
		.split('\n')
		.filter((file) => file.endsWith('.md') && path.basename(file) !== 'README.md')
		.map((file) => path.basename(file, '.md'))
	const addedEntries = loaded.pending.filter((entry) => added.includes(entry.id))

	const breaking = commits.filter((c) => CONVENTIONAL.exec(c.subject)?.groups?.breaking)
	if (breaking.length > 0 && !addedEntries.some((entry) => entry.audience === 'operators')) {
		problems.push(
			`breaking commits need an operators fragment in changes/ saying what an upgrade has to do:\n    ${breaking.map((c) => c.subject).join('\n    ')}`,
		)
	}

	const optedOut = OPT_OUT.test(process.env.PR_BODY ?? '') || commits.some((c) => OPT_OUT.test(c.message))
	const needsFragment = commits.filter((c) => !BACKGROUND_TYPES.has(CONVENTIONAL.exec(c.subject)?.groups?.type ?? ''))
	if (added.length === 0 && !optedOut && needsFragment.length > 0) {
		problems.push(
			'this PR changes more than background code but adds no fragment to changes/. Add one (see changes/README.md), ' +
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
