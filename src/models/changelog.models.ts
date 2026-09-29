import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
import * as TUT from '@/models/tutorial.models'

// The changelog is a set of fragments, one markdown file per change. A pull request adds one to `changes/`, and
// `pnpm release` moves every pending fragment into `changelog/<version>/` and appends the release to
// `changelog/releases.json`. A fragment's filename (without `.md`) is its id, and stays its id after release.
//
// A fragment is YAML frontmatter followed by the entry's text. The first line of the text is the title; anything
// after a blank line is the body, rendered as markdown.
//
// Versions are calendar versions, `YYYY.M.N`: the Nth release of that month. Nothing compares them for
// compatibility (the plugin API has its own version for that), so they only need to sort and say when.

export const AUDIENCES = ['users', 'operators'] as const
export type Audience = (typeof AUDIENCES)[number]

export const KINDS = ['added', 'changed', 'fixed', 'removed', 'breaking'] as const
export type Kind = (typeof KINDS)[number]

export const EntryIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/)

export const FrontmatterSchema = z
	.object({
		audience: z.enum(AUDIENCES),
		kind: z.enum(KINDS),
		// collapsed behind a count, and left out of the unseen count
		minor: z.boolean().prefault(false),
		tutorial: TUT.ScenarioIdSchema.optional(),
	})
	.strict()
	.refine((fm) => fm.kind !== 'breaking' || fm.audience === 'operators', { message: 'a breaking change is for operators' })

export type Entry = {
	id: string
	audience: Audience
	kind: Kind
	minor: boolean
	tutorial?: TUT.ScenarioId
	title: string
	body: string | null
}

export const VersionSchema = z.string().regex(/^\d{4}\.(?:[1-9]|1[0-2])\.[1-9]\d*$/)

export const ReleaseIndexSchema = z.array(z.object({ version: VersionSchema, date: z.iso.date() }))
export type ReleaseIndex = z.infer<typeof ReleaseIndexSchema>

// `version` and `date` are null for the pending changes, which run on a build from main before they are released
export type Release = { version: string | null; date: string | null; entries: Entry[] }

// a release as a user sees it: each entry with the time this install first ran it (unix ms)
export type ServedEntry = Entry & { firstServedAt: number }
export type ServedRelease = Omit<Release, 'entries'> & { entries: ServedEntry[] }

// which unseen entries a user is told about: none, the headline ones, or minor ones as well
export const NOTIFY_LEVELS = ['off', 'headline', 'all'] as const
export const NotifyLevelSchema = z.enum(NOTIFY_LEVELS)
export type NotifyLevel = z.infer<typeof NotifyLevelSchema>

export const PrefsSchema = z.object({ notifyLevel: NotifyLevelSchema, showOperatorNotes: z.boolean() })
export type Prefs = z.infer<typeof PrefsSchema>

export type UserState = Prefs & { seenAt: number }

export function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map(Number)
	const pb = b.split('.').map(Number)
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] - pb[i]
	}
	return 0
}

// the version a release cut on `date` gets, given the ones before it
export function nextVersion(existing: readonly string[], date: Date): string {
	const prefix = `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.`
	let n = 0
	for (const version of existing) {
		if (version.startsWith(prefix)) n = Math.max(n, Number(version.slice(prefix.length)))
	}
	return `${prefix}${n + 1}`
}

// Semver build metadata marks a build carrying changes past its release: `2026.9.4+3` is 2026.9.4 and three more.
export function runningVersion(latest: string | null, pendingCount: number): string {
	const base = latest ?? '0.0.0'
	return pendingCount > 0 ? `${base}+${pendingCount}` : base
}

const KIND_ORDER: Record<Kind, number> = { breaking: 0, added: 1, changed: 2, removed: 3, fixed: 4 }

// the order a release lists its entries in: by kind, then by id so a release reads the same on every load
export function sortEntries(entries: Entry[]): Entry[] {
	return entries.toSorted((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id))
}

// whether an unseen entry counts toward the dot and the menu count for a user with these preferences
export function notifiesAbout(entry: Entry, prefs: Prefs): boolean {
	if (entry.audience === 'operators' && !prefs.showOperatorNotes) return false
	switch (prefs.notifyLevel) {
		case 'off':
			return false
		case 'headline':
			return !entry.minor
		case 'all':
			return true
		default:
			assertNever(prefs.notifyLevel)
	}
}

export function countUnseen(releases: readonly ServedRelease[], state: UserState): number {
	if (state.notifyLevel === 'off') return 0
	let count = 0
	for (const release of releases) {
		for (const entry of release.entries) {
			if (entry.firstServedAt > state.seenAt && notifiesAbout(entry, state)) count++
		}
	}
	return count
}

export function latestServedAt(releases: readonly ServedRelease[]): number {
	let latest = 0
	for (const release of releases) {
		for (const entry of release.entries) latest = Math.max(latest, entry.firstServedAt)
	}
	return latest
}

const KIND_HEADINGS: Record<Kind, string> = {
	breaking: 'Breaking',
	added: 'Added',
	changed: 'Changed',
	removed: 'Removed',
	fixed: 'Fixed',
}

// CHANGELOG.md, generated by `pnpm release` from the released fragments, newest release first
export function renderMarkdown(releases: readonly Release[], repoUrl: string): string {
	const out: string[] = [
		'# Changelog',
		'',
		'Generated by `pnpm release` from `changelog/`. Do not edit by hand: add a fragment to `changes/` instead (see',
		'CONTRIBUTING.md).',
	]
	for (const release of releases) {
		if (!release.version) continue
		out.push('', `## [${release.version}](${repoUrl}/releases/tag/v${release.version}) (${release.date})`)
		for (const audience of AUDIENCES) {
			const entries = release.entries.filter((e) => e.audience === audience)
			if (entries.length === 0) continue
			out.push('', `### ${audience === 'users' ? 'For users' : 'For operators'}`, '')
			const lines = (list: Entry[]) => {
				for (const entry of list) {
					out.push(`- **${KIND_HEADINGS[entry.kind]}:** ${entry.title}`)
					// blank line then indented: a paragraph of the same list item, rather than a continuation of the title
					if (entry.body) out.push('', ...entry.body.split('\n').map((line) => (line ? `  ${line}` : '')))
				}
			}
			lines(entries.filter((e) => !e.minor))
			const minor = entries.filter((e) => e.minor)
			if (minor.length > 0) {
				out.push('', '<details><summary>Smaller fixes and tweaks</summary>', '')
				lines(minor)
				out.push('', '</details>')
			}
		}
	}
	return out.join('\n') + '\n'
}
