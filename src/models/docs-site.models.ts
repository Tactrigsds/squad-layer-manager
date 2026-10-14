// The static documentation site (src/scripts/build-docs.ts): which markdown files become pages, where they are
// served, and how a link written against the repo resolves on the site.

export type SectionId = 'features' | 'guide' | 'developers' | 'faq' | 'changelog'

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
	{ id: 'features', label: 'Features' },
	{ id: 'guide', label: 'Setup guide' },
	{ id: 'developers', label: 'Developers' },
	{ id: 'faq', label: 'FAQ' },
	{ id: 'changelog', label: 'Changelog' },
]

export const PAGES: Page[] = [
	{
		file: 'docs/features/layer_selection.md',
		slug: 'layer-selection',
		label: 'Layer selection',
		section: 'features',
		group: 'Features',
	},
	{
		file: 'docs/features/player_management.md',
		slug: 'player-management',
		label: 'Player management',
		section: 'features',
		group: 'Features',
	},
	{
		file: 'docs/features/server_monitoring.md',
		slug: 'monitoring-and-history',
		label: 'Monitoring and history',
		section: 'features',
		group: 'Features',
	},
	{
		file: 'docs/features/ingame_commands.md',
		slug: 'ingame-commands',
		label: 'In-game commands',
		section: 'features',
		group: 'Features',
	},
	{
		file: 'docs/features/permissions.md',
		slug: 'permissions-and-access',
		label: 'Permissions and access control',
		section: 'features',
		group: 'Features',
	},
	{
		file: 'docs/features/integrations_and_hosting.md',
		slug: 'integrations-and-hosting',
		label: 'Integrations and hosting',
		section: 'features',
		group: 'Features',
	},
	{
		file: 'docs/features/learning_slm.md',
		slug: 'learning-slm',
		label: 'Learning SLM',
		section: 'features',
		group: 'Features',
	},
	{ file: 'docs/installing.md', slug: 'installing', label: 'Installing', section: 'guide', group: 'Start here' },
	{ file: 'docs/guide/configuring/overview.md', slug: 'configuring', label: 'Configuring SLM', section: 'guide', group: 'Configuring' },
	{
		file: 'docs/guide/configuring/permissions.md',
		slug: 'permissions',
		label: 'Permissions and users',
		section: 'guide',
		group: 'Configuring',
	},
	{ file: 'docs/guide/configuring/servers.md', slug: 'servers', label: 'Servers', section: 'guide', group: 'Configuring' },
	{
		file: 'docs/guide/configuring/admin_actions.md',
		slug: 'admin-actions',
		label: 'Admin actions and commands',
		section: 'guide',
		group: 'Configuring',
	},
	{
		file: 'docs/guide/configuring/command_triggers.md',
		slug: 'command-triggers',
		label: 'Command triggers',
		section: 'guide',
		group: 'Configuring',
	},
	{ file: 'docs/guide/configuring/players.md', slug: 'players', label: 'Players', section: 'guide', group: 'Configuring' },
	{
		file: 'docs/guide/configuring/layer_pool.md',
		slug: 'layer-pool',
		label: 'Layer pool and filters',
		section: 'guide',
		group: 'Configuring',
	},
	{
		file: 'docs/guide/configuring/layer_rotation.md',
		slug: 'layer-rotation',
		label: 'Layer rotation',
		section: 'guide',
		group: 'Configuring',
	},
	{
		file: 'docs/guide/configuring/integrations.md',
		slug: 'integrations',
		label: 'Integrations',
		section: 'guide',
		group: 'Configuring',
	},
	{ file: 'docs/guide/configuring/plugins.md', slug: 'plugins', label: 'Plugins', section: 'guide', group: 'Configuring' },
	{
		file: 'docs/guide/operations/upgrading.md',
		slug: 'upgrading',
		label: 'Upgrading and downgrading',
		section: 'guide',
		group: 'Operational details',
	},
	{
		file: 'docs/guide/operations/secrets.md',
		slug: 'secrets',
		label: 'Secrets and the encryption key',
		section: 'guide',
		group: 'Operational details',
	},
	{
		file: 'docs/guide/operations/backups.md',
		slug: 'backups',
		label: 'Backups and restoring',
		section: 'guide',
		group: 'Operational details',
	},
	{
		file: 'docs/guide/operations/server_agent.md',
		slug: 'server-agent',
		label: 'Server agent',
		section: 'guide',
		group: 'Operational details',
	},
	{ file: 'docs/guide/operations/layer_data.md', slug: 'layer-data', label: 'Layer data', section: 'guide', group: 'Operational details' },
	{
		file: 'docs/guide/operations/sandbox_servers.md',
		slug: 'sandbox-servers',
		label: 'Sandbox servers',
		section: 'guide',
		group: 'Operational details',
	},
	{
		file: 'docs/guide/operations/server_console.md',
		slug: 'server-console',
		label: 'Server console',
		section: 'guide',
		group: 'Operational details',
	},
	{ file: 'CONTRIBUTING.md', slug: 'contributing', label: 'Getting started', section: 'developers', group: 'Contributing' },
	{
		file: 'docs/developers/dev_instances.md',
		slug: 'dev-workspaces',
		label: 'Development workspaces',
		section: 'developers',
		group: 'Contributing',
	},
	{
		file: 'docs/developers/writing_plugins.md',
		slug: 'writing-plugins',
		label: 'Writing a plugin',
		section: 'developers',
		group: 'Plugins',
	},
	{
		file: 'docs/developers/plugin_ui.md',
		slug: 'plugin-ui',
		label: 'Plugin UI',
		section: 'developers',
		group: 'Plugins',
	},
	{
		file: 'docs/developers/architecture.md',
		slug: 'architecture',
		label: 'Architecture',
		section: 'developers',
		group: 'Reference',
	},
	{
		file: 'docs/developers/custom_layer_data.md',
		slug: 'custom-layer-data',
		label: 'Building custom layer data',
		section: 'developers',
		group: 'Reference',
	},
	{ file: 'docs/faq.md', slug: 'faq', label: 'FAQ', section: 'faq', group: 'FAQ' },
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

// the browser tab title: the site's name alone, or the article in front of it
export function tabTitle(article: string | null) {
	return article === null ? 'SLM Docs' : `${article} - SLM Docs`
}

export const PAGE_BY_FILE = new Map(PAGES.map((p) => [p.file, p]))

export function pagesIn(section: SectionId) {
	return PAGES.filter((p) => p.section === section)
}

// a section of one page has nothing to navigate between
export function hasSidebar(section: SectionId) {
	return pagesIn(section).length > 1
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

// where pages are served from: `base` is the version's folder, `root` the site root. `absent` holds the slugs of pages
// that version does not have, such as a page added after it was released, which are linked in latest instead.
export type Bases = { base: string; root: string; absent?: ReadonlySet<string> }

export function pageHref(bases: Bases, page: Page, hash = '') {
	if (page.unversioned) return `${bases.root}${page.slug}/${hash}`
	if (bases.absent?.has(page.slug)) return `${bases.root}${LATEST_VERSION}/${page.slug}/${hash}`
	return `${bases.base}${page.slug}/${hash}`
}

export function versionedPages() {
	return PAGES.filter((p) => !p.unversioned)
}

export function unversionedPages() {
	return PAGES.filter((p) => p.unversioned)
}

// The version folders mirror the image tags: latest is built from main, a release folder such as 2026.9.4 from its
// tag, and stable is the newest release built a second time under its own name.
export const LATEST_VERSION = 'latest'
export const STABLE_VERSION = 'stable'

const RELEASE = /^\d+(?:\.\d+)*$/

export function isRelease(name: string) {
	return RELEASE.test(name)
}

export function isVersionName(name: string) {
	return name === LATEST_VERSION || name === STABLE_VERSION || isRelease(name)
}

// the release a git ref names, such as 2026.9.4 for the tag v2026.9.4
export function releaseOfRef(ref: string) {
	const name = ref.replace(/^v/, '')
	return isRelease(name) ? name : null
}

function releaseParts(name: string) {
	return name.split('.').map(Number)
}

// releases, newest first
export function sortReleases(names: string[]) {
	return names.filter(isRelease).sort((a, b) => {
		const x = releaseParts(a)
		const y = releaseParts(b)
		for (let i = 0; i < Math.max(x.length, y.length); i++) {
			const d = (y[i] ?? 0) - (x[i] ?? 0)
			if (d !== 0) return d
		}
		return 0
	})
}

// The site root's versions.json, read by every page to list the versions and flag an outdated one, and by the app to
// pick its docs. `stable` is the release the stable folder holds. `versions` lists every folder: latest, stable, then
// releases newest first. App builds from before the folders were renamed read `versions` too.
export type VersionIndex = { stable: string | null; versions: string[] }

export function sortVersions(names: string[]) {
	return [LATEST_VERSION, STABLE_VERSION].filter((n) => names.includes(n)).concat(sortReleases(names))
}

// The docs an app build links to. A build past a release (`2026.9.4+2`) is main's code, the `:latest` image, so it
// gets latest. A release gets stable while it is the newest release, and its own folder after. A release the index
// does not list, or any release while the index is unknown, gets the site root, which opens stable.
export function docsUrlFor(root: string, appVersion: string, index: VersionIndex | null) {
	if (appVersion.includes('+')) return `${root}${LATEST_VERSION}/`
	if (index?.stable === appVersion) return `${root}${STABLE_VERSION}/`
	if (index?.versions.includes(appVersion)) return `${root}${appVersion}/`
	return root
}

export function assetHref(base: string, file: string) {
	return `${base}assets/${file}`
}
