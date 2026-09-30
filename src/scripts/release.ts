import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import * as Paths from '$root/paths.ts'
import * as CL from '@/models/changelog.models'
import * as Project from '@/models/project.models'
import * as ChangelogFiles from '@/systems/changelog-files.server'

// Cuts a release: moves every fragment in changes/ into changelog/<version>/, adds the release to
// changelog/releases.json and regenerates CHANGELOG.md. Run with `pnpm release`, commit the result on a branch and
// merge it. CI tags the merged commit `v<version>` and its image `:<version>` and `:stable`.
//
// It also lists the commits since the last release that shipped without a fragment, so a change that should have
// had one can be caught before the release goes out: add the fragment to changes/ and run this again.

const CHANGELOG_MD = path.join(Paths.PROJECT_ROOT, 'CHANGELOG.md')

function fail(msg: string): never {
	console.error(`release: ${msg}`)
	process.exit(1)
}

function git(...args: string[]) {
	return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

// commits since the one that cut the last release, oldest first, without the ones that added a fragment
function commitsWithoutFragments(): string[] {
	const lastRelease = git('log', '-1', '--format=%H', '--', 'changelog/releases.json')
	const range = lastRelease ? `${lastRelease}..HEAD` : 'HEAD'
	const withFragment = new Set(git('log', '--no-merges', '--diff-filter=A', '--format=%H', range, '--', 'changes/').split('\n'))
	return git('log', '--no-merges', '--reverse', '--format=%H %h %s', range)
		.split('\n')
		.filter(Boolean)
		.filter((line) => !withFragment.has(line.slice(0, line.indexOf(' '))))
		.map((line) => line.slice(line.indexOf(' ') + 1))
}

const loaded = ChangelogFiles.load(Paths.CHANGELOG, Paths.CHANGES)
if (loaded.errors.length > 0) fail(`fix these first:\n  ${loaded.errors.join('\n  ')}`)
if (loaded.pending.length === 0) fail('changes/ has no fragments, so there is nothing to release')

const now = new Date()
const version = CL.nextVersion(
	loaded.index.map((r) => r.version),
	now,
)
const date = now.toISOString().slice(0, 10)

const releaseDir = path.join(Paths.CHANGELOG, version)
fs.mkdirSync(releaseDir, { recursive: true })
for (const entry of loaded.pending) {
	fs.renameSync(path.join(Paths.CHANGES, `${entry.id}.md`), path.join(releaseDir, `${entry.id}.md`))
}
const index: CL.ReleaseIndex = [{ version, date }, ...loaded.index]
fs.writeFileSync(path.join(Paths.CHANGELOG, 'releases.json'), JSON.stringify(index, null, '\t') + '\n')

const released = ChangelogFiles.load(Paths.CHANGELOG, Paths.CHANGES)
if (released.errors.length > 0) fail(`the release was written but does not load back:\n  ${released.errors.join('\n  ')}`)
fs.writeFileSync(CHANGELOG_MD, CL.renderMarkdown(released.releases, Project.REPO_URL))

console.log(`Cut ${version} (${date}) with ${loaded.pending.length} changes.`)
const unrecorded = commitsWithoutFragments()
if (unrecorded.length > 0) {
	console.log(`\nThese ${unrecorded.length} commits since the last release have no fragment. Check none of them should:\n`)
	for (const line of unrecorded) console.log(`  ${line}`)
}
console.log(`\nNext: commit on a branch (git switch -c release/${version} && git add -A changes changelog CHANGELOG.md) and open a PR.`)
