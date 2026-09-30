// The static documentation site (src/scripts/build-docs.ts): which markdown files become pages, where they are
// served, and how a link written against the repo resolves on the site.

export type SectionId = 'guide' | 'developers' | 'changelog'

export type Page = {
	// repo-relative markdown source
	file: string
	// path under the site base, without slashes: "installing" is served at <base>installing/
	slug: string
	// sidebar label; the page's own h1 stays its heading
	label: string
	section: SectionId
	group: string
	// generated pages link to their generator instead of offering an edit
	generatedBy?: string
	// served once at the site root and rebuilt from main, instead of frozen into each version
	unversioned?: true
}

export const SECTIONS: { id: SectionId; label: string }[] = [
	{ id: 'guide', label: 'Setup guide' },
	{ id: 'developers', label: 'Developers' },
	{ id: 'changelog', label: 'Changelog' },
]

export const PAGES: Page[] = [
	{ file: 'docs/installing.md', slug: 'installing', label: 'Installing', section: 'guide', group: 'Start here' },
	{
		file: 'docs/server_dashboard.md',
		slug: 'server-dashboard',
		label: 'Learning how to use SLM',
		section: 'guide',
		group: 'Start here',
	},
	{ file: 'docs/configuring.md', slug: 'configuring', label: 'Configuring SLM', section: 'guide', group: 'Configuring' },
	{
		file: 'docs/command_triggers.md',
		slug: 'command-triggers',
		label: 'Command triggers',
		section: 'guide',
		group: 'Configuring',
	},
	{ file: 'docs/backups.md', slug: 'backups', label: 'Backups and restoring', section: 'guide', group: 'Operational details' },
	{ file: 'docs/server_agent.md', slug: 'server-agent', label: 'Server agent', section: 'guide', group: 'Operational details' },
	{ file: 'docs/layer_data.md', slug: 'layer-data', label: 'Layer data', section: 'guide', group: 'Operational details' },
	{
		file: 'docs/sandbox_servers.md',
		slug: 'sandbox-servers',
		label: 'Sandbox servers',
		section: 'guide',
		group: 'Operational details',
	},
	{
		file: 'docs/server_console.md',
		slug: 'server-console',
		label: 'Server console',
		section: 'guide',
		group: 'Operational details',
	},
	{ file: 'CONTRIBUTING.md', slug: 'contributing', label: 'Getting started', section: 'developers', group: 'Contributing' },
	{
		file: 'docs/dev_instances.md',
		slug: 'dev-workspaces',
		label: 'Development workspaces',
		section: 'developers',
		group: 'Contributing',
	},
	{
		file: 'docs/architecture.md',
		slug: 'architecture',
		label: 'Architecture',
		section: 'developers',
		group: 'Architecture',
	},
	{
		file: 'docs/writing_plugins.md',
		slug: 'writing-plugins',
		label: 'Writing a plugin',
		section: 'developers',
		group: 'Plugins',
	},
	{ file: 'docs/brand.md', slug: 'brand', label: 'Brand', section: 'developers', group: 'Reference' },
	{
		file: 'CHANGELOG.md',
		slug: 'changelog',
		label: 'Changelog',
		section: 'changelog',
		group: 'Releases',
		generatedBy: 'changelog/',
		unversioned: true,
	},
]

export const PAGE_BY_FILE = new Map(PAGES.map((p) => [p.file, p]))

export function pagesIn(section: SectionId) {
	return PAGES.filter((p) => p.section === section)
}

// consecutive pages sharing a group, in manifest order
export function groupsIn(section: SectionId) {
	const groups: { label: string; pages: Page[] }[] = []
	for (const page of pagesIn(section)) {
		const last = groups.at(-1)
		if (last?.label === page.group) last.pages.push(page)
		else groups.push({ label: page.group, pages: [page] })
	}
	return groups
}

export function neighbours(page: Page) {
	const list = pagesIn(page.section)
	const i = list.indexOf(page)
	return { prev: list[i - 1] ?? null, next: list[i + 1] ?? null }
}

export type Link =
	| { kind: 'page'; page: Page; hash: string }
	| { kind: 'asset'; file: string }
	| { kind: 'repo'; file: string; hash: string }
	| { kind: 'external' | 'anchor'; href: string }

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg|avif)$/i

// Resolves a link written in `fromFile` the way GitHub would, then decides what it becomes on the site: another
// page, a copied asset, or a link back to the repo for any file the site does not publish.
export function resolveLink(fromFile: string, href: string): Link {
	if (EXTERNAL.test(href)) return { kind: 'external', href }
	if (href.startsWith('#')) return { kind: 'anchor', href }
	const hashAt = href.indexOf('#')
	const target = hashAt === -1 ? href : href.slice(0, hashAt)
	const hash = hashAt === -1 ? '' : href.slice(hashAt)
	const file = joinRepoPath(dirOf(fromFile), decodeURI(target))
	const page = PAGE_BY_FILE.get(file)
	if (page) return { kind: 'page', page, hash }
	if (IMAGE.test(file)) return { kind: 'asset', file }
	return { kind: 'repo', file, hash }
}

function dirOf(file: string) {
	const i = file.lastIndexOf('/')
	return i === -1 ? '' : file.slice(0, i)
}

function joinRepoPath(dir: string, rel: string) {
	const parts = rel.startsWith('/') ? [] : dir.split('/').filter(Boolean)
	for (const seg of rel.split('/')) {
		if (seg === '' || seg === '.') continue
		if (seg === '..') parts.pop()
		else parts.push(seg)
	}
	return parts.join('/')
}

// where pages are served from: `base` is the version's folder, `root` the site root
export type Bases = { base: string; root: string }

export function pageHref(bases: Bases, page: Page, hash = '') {
	return `${page.unversioned ? bases.root : bases.base}${page.slug}/${hash}`
}

export function versionedPages() {
	return PAGES.filter((p) => !p.unversioned)
}

export function unversionedPages() {
	return PAGES.filter((p) => p.unversioned)
}

// the version folder built from main
export const NEXT_VERSION = 'next'

const RELEASE = /^v\d+(?:\.\d+)*$/

export function isVersionName(name: string) {
	return name === NEXT_VERSION || RELEASE.test(name)
}

function releaseParts(name: string) {
	return name.slice(1).split('.').map(Number)
}

// next first, then releases newest first
export function sortVersions(names: string[]) {
	const releases = names.filter((n) => n !== NEXT_VERSION)
	releases.sort((a, b) => {
		const x = releaseParts(a)
		const y = releaseParts(b)
		for (let i = 0; i < Math.max(x.length, y.length); i++) {
			const d = (y[i] ?? 0) - (x[i] ?? 0)
			if (d !== 0) return d
		}
		return 0
	})
	return names.includes(NEXT_VERSION) ? [NEXT_VERSION, ...releases] : releases
}

export function versionLabel(version: string) {
	return version === NEXT_VERSION ? 'Unreleased' : version
}

export function latestRelease(sorted: string[]) {
	return sorted.find((n) => n !== NEXT_VERSION) ?? null
}

// the site root's versions.json, read by every page to list the versions and flag an outdated one
export type VersionIndex = { latest: string | null; versions: string[] }

export function assetHref(base: string, file: string) {
	return `${base}assets/${file}`
}
