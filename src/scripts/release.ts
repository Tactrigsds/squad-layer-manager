import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import * as Paths from '$root/paths.ts'
import * as CL from '@/models/changelog.models'
import * as Project from '@/models/project.models'
import * as ChangelogFiles from '@/systems/changelog-files.server'

// Cuts a release: moves every fragment in changes/ into changelog/<version>/, adds the release to
// changelog/releases.json and regenerates CHANGELOG.md. Run with `pnpm release` from a clean checkout of the latest
// origin/main, commit the result on a branch and merge it. CI tags the merged commit `v<version>` and its image
// `:<version>` and `:stable`.
//
// CI already holds every PR to a fragment or a `Changelog: none` line. What it cannot judge is whether an opt-out was
// right, so this lists the PRs since the last release that opted out, with their reasons. If one should have had a
// fragment, add it to changes/ on main and run this again.

const CHANGELOG_MD = path.join(Paths.PROJECT_ROOT, 'CHANGELOG.md')

function fail(msg: string): never {
	console.error(`release: ${msg}`)
	process.exit(1)
}

function git(...args: string[]) {
	return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

// A release that is not cut from the latest main leaves out whatever merged since, fragments included.
function preflight() {
	git('fetch', '--quiet', 'origin', 'main')
	const head = git('rev-parse', 'HEAD')
	const main = git('rev-parse', 'origin/main')
	if (head !== main) fail(`HEAD is ${head.slice(0, 8)} but origin/main is ${main.slice(0, 8)}. Cut a release from the latest main.`)
	if (git('status', '--porcelain')) fail('the checkout has uncommitted changes')
}

type Commit = { subject: string; message: string }

function commitsIn(range: string): Commit[] {
	return git('log', '--no-merges', '--format=%x1e%s%x1f%B', range)
		.split('\x1e')
		.filter(Boolean)
		.map((raw) => {
			const [subject, message] = raw.split('\x1f')
			return { subject, message }
		})
}

// A fragment already in changes/ has not shipped, since a release moves every one out, so editing it counts.
function addsOrEditsFragment(from: string, to: string): boolean {
	return git('diff', '--name-only', '--no-renames', '--diff-filter=AM', from, to, '--', 'changes/')
		.split('\n')
		.some((file) => file.endsWith('.md') && path.basename(file) !== 'README.md')
}

// The changes on main's first-parent line since the last release that added or edited no fragment and are not
// background-only, each with the `Changelog: none` reason it gave. A PR's reason is in its commits or, when absent
// there, its description, which git does not have.
function optedOutSinceLastRelease(): string[] {
	const lastRelease = git('log', '-1', '--format=%H', '--', 'changelog/releases.json')
	const range = lastRelease ? `${lastRelease}..HEAD` : 'HEAD'
	const lines: string[] = []
	for (const row of git('log', '--first-parent', '--reverse', '--format=%H%x1f%P%x1f%s%x1f%b%x1e', range).split('\x1e')) {
		const [hash, parents, subject, body] = row.trim().split('\x1f')
		if (!hash) continue
		const [first, second] = parents.split(' ')
		const commits = second ? commitsIn(`${first}..${second}`) : [{ subject, message: `${subject}\n${body}` }]
		if (commits.every((c) => CL.isBackgroundSubject(c.subject))) continue
		if (addsOrEditsFragment(first, hash)) continue
		const label = second ? `${subject.match(/#\d+/)?.[0] ?? hash.slice(0, 8)} ${body.split('\n')[0]}` : `${hash.slice(0, 8)} ${subject}`
		const reason = commits.map((c) => c.message.match(CL.OPT_OUT)?.[0]).find(Boolean) ?? '(opted out in the PR description)'
		lines.push(`${label}\n      ${reason}`)
	}
	return lines
}

preflight()

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
// the rendered markdown is not wrapped the way the pre-push format check wants it
execFileSync('pnpm', ['exec', 'oxfmt', CHANGELOG_MD], { stdio: 'ignore' })

console.log(`Cut ${version} (${date}) with ${loaded.pending.length} changes.`)
const optedOut = optedOutSinceLastRelease()
if (optedOut.length > 0) {
	console.log(`\nThese ${optedOut.length} changes since the last release opted out of a fragment. Check each reason holds:\n`)
	for (const line of optedOut) console.log(`  ${line}`)
}
console.log(
	`\nNext: commit on a branch (git switch -c release/${version} && git add -A changes changelog CHANGELOG.md), with ` +
		`"Changelog: none, this is the release commit" in the message, and open a PR.`,
)
