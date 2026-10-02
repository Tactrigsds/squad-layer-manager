import rehypeShikiFromHighlighter from '@shikijs/rehype/core'
import tailwindcss from '@tailwindcss/postcss'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import * as Pagefind from 'pagefind'
import postcss from 'postcss'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'
import { rolldown } from 'rolldown'
import { createCssVariablesTheme, createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

import * as Paths from '$root/paths'
import * as Site from '@/components/docs-site/site'
import * as Logo from '@/lib/logo'
import { assertNever } from '@/lib/type-guards'
import * as DS from '@/models/docs-site.models'
import * as PLG from '@/models/plugins.models'
import * as Project from '@/models/project.models'

// Builds the documentation site. Run with `pnpm docs:build`, or `pnpm docs:dev` to rebuild on change and serve it.
//
// The site holds one folder per version of the docs, and an unversioned root:
//
//   <root>/next/...        the docs on main
//   <root>/v2026.9.4/...   the docs of a release, built once from its tag and never rebuilt
//   <root>/index.html      the landing page, the 404 page, versions.json, all pointing at the latest release
//
// `--version-only` builds DOCS_VERSION's folder, `--root-only` rebuilds the root from the version folders already in
// DOCS_OUT; neither flag does both. The publishing workflow (.github/workflows/docs-pages.yml) runs the version half
// from the ref being published and the root half from main.
//
// DOCS_ROOT is the path the site is served under (default "/"), DOCS_VERSION the folder to build (default "next"),
// DOCS_REF the git ref its source links point at (default "main"), DOCS_OUT the site directory (default dist-docs),
// DOCS_CNAME a custom domain for GitHub Pages. The build fails on a link to a page or heading that does not exist, and
// on a code block in a language it has no grammar for.

const ROOT = Paths.PROJECT_ROOT
const OUT = path.resolve(ROOT, process.env.DOCS_OUT ?? 'dist-docs')
const SITE_ROOT = normalizeBase(process.env.DOCS_ROOT ?? '/')
const VERSION = process.env.DOCS_VERSION ?? DS.NEXT_VERSION
const REF = process.env.DOCS_REF ?? 'main'
const CNAME = process.env.DOCS_CNAME || null
const VERSION_ONLY = process.argv.includes('--version-only')
const ROOT_ONLY = process.argv.includes('--root-only')
const SERVE = process.argv.includes('--serve')
const PORT = Number(process.env.DOCS_PORT ?? 4400)

const LANDING = {
	tagline: 'SLM is a tool for managing the upcoming layers on a Squad server, and other things also.',
	description:
		'Its web app and in-game admin commands simplify layer and player management, and work alongside existing tools such as Discord and BattleMetrics. It is the main admin tool of the TacTrig server.',
	demoCommand: 'docker run --rm -p 3000:3000 -e DEMO=1 ghcr.io/tactrigsds/squad-layer-manager:latest',
	youtubeId: null as string | null,
	highlights: [
		{
			title: 'Control over layer selection',
			text: 'Designed to work in place of the in-game voting system, SLM provides convenient and fine-grained control over what kinds of layers are played on the server.',
			page: 'docs/features/layer_selection.md',
			linkLabel: 'Read about layer selection',
			media: { kind: 'shot', file: 'docs/images/features/layer_queue.png', alt: 'the layer queue' },
		},
		{
			title: 'Player management',
			text: 'Warn, kick and time out players, manage team swaps, and flag and note players through BattleMetrics.',
			page: 'docs/features/player_management.md',
			linkLabel: 'Read about player management',
			media: {
				kind: 'shot',
				file: 'docs/images/features/teams_panel.png',
				alt: 'the teams panel',
				crop: { x: 0, y: 0, width: 490 },
			},
		},
		{
			title: 'Extensible with plugins',
			text: 'Plugins add commands, settings and behaviour. Install one from a URL, or write your own.',
			page: 'docs/features/integrations_and_hosting.md',
			anchor: 'plugins',
			linkLabel: 'Read about plugins',
			media: {
				kind: 'shot',
				file: 'docs/images/features/plugins.png',
				alt: 'the plugins settings page',
				crop: { x: 0, y: 0, width: 460 },
			},
		},
		{
			title: 'Built to self-host',
			text: 'Runs on any system with Docker installed.',
			page: 'docs/installing.md',
			linkLabel: 'Read the install guide',
			media: { kind: 'docker' },
		},
	] satisfies Site.Highlight[],
}

// Self-hosted from @fontsource, latin only. Every face is `font-display: optional`: one that is cached, or arrives
// within the browser's short block period, is used from the first paint, and one that arrives later is skipped for
// that page instead of swapped in, which would reflow the text on every navigation whose font request is slow. The
// faces every page's header and headings use are preloaded, so a first visit has them in time.
const FONTS = [
	{ family: 'Barlow', pkg: 'barlow', weight: 400, style: 'normal', preload: true },
	{ family: 'Barlow', pkg: 'barlow', weight: 400, style: 'italic', preload: false },
	{ family: 'Barlow', pkg: 'barlow', weight: 500, style: 'normal', preload: false },
	{ family: 'Barlow', pkg: 'barlow', weight: 600, style: 'normal', preload: true },
	{ family: 'Barlow', pkg: 'barlow', weight: 700, style: 'normal', preload: false },
	{ family: 'Roboto Condensed', pkg: 'roboto-condensed', weight: 700, style: 'normal', preload: true },
	{ family: 'Roboto Condensed', pkg: 'roboto-condensed', weight: 800, style: 'normal', preload: true },
]

const LANGS = {
	sh: () => import('shiki/langs/shellscript.mjs'),
	ts: () => import('shiki/langs/typescript.mjs'),
	tsx: () => import('shiki/langs/tsx.mjs'),
	yaml: () => import('shiki/langs/yaml.mjs'),
	json: () => import('shiki/langs/json.mjs'),
}
// fence labels the grammars answer to, beyond their own names
const LANG_ALIASES = ['bash', 'shell', 'shellscript', 'typescript', 'yml']

type HastNode = {
	type: string
	tagName?: string
	value?: string
	properties?: Record<string, unknown>
	children?: HastNode[]
	position?: { start: { line: number } }
}

type LinkProblem = { file: string; message: string }

async function main() {
	const started = performance.now()
	if (!DS.isVersionName(VERSION)) throw new Error(`DOCS_VERSION "${VERSION}" is not "${DS.NEXT_VERSION}" or a release tag`)
	fs.mkdirSync(OUT, { recursive: true })
	const highlighter = await createHighlighter()
	if (!ROOT_ONLY) await buildVersion(highlighter)
	if (!VERSION_ONLY) await buildRoot(highlighter)
	console.log(`docs: built into ${path.relative(ROOT, OUT) || '.'} in ${Math.round(performance.now() - started)}ms`)
}

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>

// one version's folder: every page in DS.PAGES, the images they embed, and a search index over them alone
async function buildVersion(highlighter: Highlighter) {
	const dir = path.join(OUT, VERSION)
	fs.rmSync(dir, { recursive: true, force: true })
	fs.mkdirSync(dir, { recursive: true })
	const base = `${SITE_ROOT}${VERSION}/`
	const site = { ...(await buildStatic(dir, base)), base, root: SITE_ROOT, assetBase: base, version: VERSION, ref: REF }

	const problems: LinkProblem[] = []
	const assets = renderPages(DS.versionedPages(), dir, site, highlighter, problems)
	// the bare version url opens its first page
	writePage(dir, 'index.html', React.createElement(Site.RedirectDocument, { to: DS.pageHref(site, DS.versionedPages()[0]) }))
	copyAssets(dir, assets, problems)
	if (problems.length > 0) {
		for (const p of problems) console.error(`docs: ${p.file}: ${p.message}`)
		throw new Error(`${problems.length} problem(s) in the docs`)
	}
	await buildSearchIndex(dir)
}

// renders `pages` into `dir`, and returns the images they embed
function renderPages(pages: DS.Page[], dir: string, site: Site.SiteInfo, highlighter: Highlighter, problems: LinkProblem[]) {
	const assets = new Set<string>()
	const headingIds = new Map<string, Set<string>>()
	const pageLinks: { from: DS.Page; link: DS.Link }[] = []

	for (const page of pages) {
		const source = fs.readFileSync(path.join(ROOT, page.file), 'utf8')
		checkFences(page, source, problems)
		if (source !== PLG.withCurrentApiRange(source))
			problems.push({ file: page.file, message: `an example apiVersion is not ${PLG.currentApiRange()}: run \`pnpm api:report\`` })
		const headings: Site.Heading[] = []
		const html = renderToStaticMarkup(
			React.createElement(
				Markdown,
				{
					remarkPlugins: [remarkGfm],
					rehypePlugins: [
						rehypeSlug,
						[rehypeShikiFromHighlighter, highlighter, { theme: 'css-variables', addLanguageClass: true }],
						() => (tree: HastNode) => collectHeadings(tree, headings),
						() => (tree: HastNode) => markCallouts(tree),
					],
					components: markdownComponents(site, page, { assets, pageLinks, problems }),
				},
				source,
			),
		)
		headingIds.set(page.file, new Set(headings.map((h) => h.id)))
		const title = headings.find((h) => h.depth === 1)?.text ?? page.label
		writePage(
			dir,
			`${page.slug}/index.html`,
			React.createElement(
				Site.DocsDocument,
				{
					site,
					title: DS.tabTitle(title),
					description: `${title}, from the Squad Layer Manager documentation.`,
					section: page.section,
					sidebar: React.createElement(Site.Sidebar, { site, page }),
				},
				React.createElement(Site.DocPage, { site, page, html, headings }),
			),
		)
	}

	for (const { from, link } of pageLinks) {
		if (link.kind === 'anchor') {
			if (!headingIds.get(from.file)!.has(link.href.slice(1))) problems.push({ file: from.file, message: `no heading for ${link.href}` })
		} else if (link.kind === 'page' && link.hash) {
			// a page this build does not render is checked by the build that does
			const ids = headingIds.get(link.page.file)
			if (ids && !ids.has(decodeURIComponent(link.hash.slice(1))))
				problems.push({ file: from.file, message: `${link.page.file} has no heading for ${link.hash}` })
		}
	}
	return assets
}

// the unversioned root: landing page, 404 page and versions.json, all pointing at the latest release
async function buildRoot(highlighter: Highlighter) {
	const versions = DS.sortVersions(
		fs
			.readdirSync(OUT, { withFileTypes: true })
			.filter((d) => d.isDirectory() && DS.isVersionName(d.name) && fs.existsSync(path.join(OUT, d.name, 'index.html')))
			.map((d) => d.name),
	)
	if (versions.length === 0) throw new Error(`no version folders in ${OUT}: build one first`)
	const index: DS.VersionIndex = { latest: DS.latestRelease(versions), versions }
	const shown = index.latest ?? DS.NEXT_VERSION
	fs.writeFileSync(path.join(OUT, 'versions.json'), JSON.stringify(index))

	const dir = path.join(OUT, 'static')
	fs.rmSync(dir, { recursive: true, force: true })
	fs.mkdirSync(dir)
	const absent = new Set(
		DS.versionedPages()
			.filter((p) => !fs.existsSync(path.join(OUT, shown, p.slug, 'index.html')))
			.map((p) => p.slug),
	)
	const site = {
		...(await buildStatic(dir, `${SITE_ROOT}static/`)),
		base: `${SITE_ROOT}${shown}/`,
		absent,
		root: SITE_ROOT,
		assetBase: `${SITE_ROOT}static/`,
		version: shown,
		ref: shown === DS.NEXT_VERSION ? 'main' : shown,
	}

	const problems: LinkProblem[] = []
	for (const page of DS.unversionedPages()) fs.rmSync(path.join(OUT, page.slug), { recursive: true, force: true })
	const pageSite = { ...site, ref: 'main' }
	const assets = renderPages(DS.unversionedPages(), OUT, pageSite, highlighter, problems)
	checkHighlights(absent, shown, problems)
	for (const h of LANDING.highlights) if (h.media.kind === 'shot') assets.add(h.media.file)
	const firstGuide = DS.pagesIn('guide')[0]
	const sidebar = React.createElement(Site.Sidebar, { site, page: firstGuide })
	writePage(
		OUT,
		'index.html',
		React.createElement(
			Site.DocsDocument,
			{ site, title: DS.tabTitle(null), description: LANDING.tagline, section: null, sidebar },
			React.createElement(Site.LandingPage, { site, ...LANDING, highlights: LANDING.highlights.map(withImageSize) }),
		),
	)
	writePage(
		OUT,
		'404.html',
		React.createElement(
			Site.DocsDocument,
			{ site, title: DS.tabTitle('Page not found'), description: 'Page not found', section: null, sidebar },
			React.createElement(Site.NotFoundPage, { site }),
		),
	)
	copyAssets(dir, assets, problems)
	if (problems.length > 0) {
		for (const p of problems) console.error(`docs: ${p.file}: ${p.message}`)
		throw new Error(`${problems.length} problem(s) in the landing page`)
	}
	fs.writeFileSync(path.join(OUT, 'favicon.svg'), Logo.themedSvg({ accent: null }))
	// GitHub Pages runs Jekyll over a branch unless this file exists, and Jekyll drops anything starting with "_"
	fs.writeFileSync(path.join(OUT, '.nojekyll'), '')
	if (CNAME) fs.writeFileSync(path.join(OUT, 'CNAME'), `${CNAME}\n`)
}

function withImageSize(h: Site.Highlight): Site.SizedHighlight {
	if (h.media.kind !== 'shot') return { ...h, media: h.media }
	const { width, height } = imageSize(h.media.file)
	if (width === undefined || height === undefined) throw new Error(`the landing highlight "${h.title}" needs a PNG screenshot`)
	return { ...h, media: { ...h.media, size: { width, height } } }
}

// every landing highlight must link to a published page, and to a heading that page has
function checkHighlights(absent: ReadonlySet<string>, shown: string, problems: LinkProblem[]) {
	for (const h of LANDING.highlights) {
		const page = DS.PAGE_BY_FILE.get(h.page)
		if (!page) {
			problems.push({ file: h.page, message: `the landing highlight "${h.title}" links to a page the site does not publish` })
			continue
		}
		if (!h.anchor) continue
		const version = absent.has(page.slug) ? DS.NEXT_VERSION : shown
		const html = fs.readFileSync(path.join(OUT, version, page.slug, 'index.html'), 'utf8')
		if (!html.includes(` id="${h.anchor}"`)) problems.push({ file: h.page, message: `no heading for the landing highlight #${h.anchor}` })
	}
}

// the stylesheet, script and fonts a set of pages loads, written into `dir` and served from `base`
async function buildStatic(dir: string, base: string) {
	const fonts = copyFonts(dir, base)
	const [cssHref, jsHref] = await Promise.all([buildCss(dir, base, fonts.css), buildJs(dir, base)])
	return { repoUrl: Project.REPO_URL, cssHref, jsHref, fontPreloads: fonts.preloads }
}

function copyAssets(dir: string, assets: Set<string>, problems: LinkProblem[]) {
	for (const file of assets) {
		const src = path.join(ROOT, file)
		if (!fs.existsSync(src)) {
			problems.push({ file, message: 'image does not exist' })
			continue
		}
		const dest = path.join(dir, 'assets', file)
		fs.mkdirSync(path.dirname(dest), { recursive: true })
		fs.copyFileSync(src, dest)
	}
}

function markdownComponents(
	site: Site.SiteInfo,
	page: DS.Page,
	sink: { assets: Set<string>; pageLinks: { from: DS.Page; link: DS.Link }[]; problems: LinkProblem[] },
) {
	const heading =
		(level: 1 | 2 | 3 | 4 | 5 | 6) =>
		({ children, id }: React.ComponentProps<'h1'> & ExtraProps) =>
			React.createElement(
				Site.SourceHeading,
				{ level, id, sourceHref: id ? `${site.repoUrl}/blob/${site.ref}/${page.file}#${id}` : null },
				children,
			)
	const components: Components = {
		h1: heading(1),
		h2: heading(2),
		h3: heading(3),
		h4: heading(4),
		h5: heading(5),
		h6: heading(6),
		a: ({ node: _node, href, children, ...rest }) => {
			const link = DS.resolveLink(page.file, href ?? '')
			sink.pageLinks.push({ from: page, link })
			// "see installing.md" reads as a file on GitHub; on the site the page's own name reads better
			const text = link.kind === 'page' && children === link.page.file.split('/').at(-1) ? link.page.label : children
			return React.createElement('a', { ...rest, href: linkHref(site, link, sink.assets) }, text)
		},
		img: ({ node: _node, src, alt }) => {
			const link = DS.resolveLink(page.file, src ?? '')
			if (link.kind !== 'asset') return React.createElement('img', { src: linkHref(site, link, sink.assets), alt })
			sink.assets.add(link.file)
			const size = fs.existsSync(path.join(ROOT, link.file)) ? imageSize(link.file) : {}
			return React.createElement('img', {
				src: DS.assetHref(site.assetBase, link.file),
				alt: alt ?? '',
				loading: 'lazy',
				decoding: 'async',
				...size,
			})
		},
		pre: ({ node: _node, children, ...rest }) => React.createElement(Site.CodeBlock, rest, children),
		table: ({ node: _node, children, ...rest }) =>
			React.createElement('div', { className: 'docs-table' }, React.createElement('table', rest, children)),
	}
	return components
}

function linkHref(site: Site.SiteInfo, link: DS.Link, assets: Set<string>) {
	switch (link.kind) {
		case 'page':
			return DS.pageHref(site, link.page, link.hash)
		case 'asset':
			assets.add(link.file)
			return DS.assetHref(site.assetBase, link.file)
		case 'repo':
			return `${site.repoUrl}/blob/${site.ref}/${link.file}${link.hash}`
		case 'external':
		case 'anchor':
			return link.href
		default:
			return assertNever(link)
	}
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/

function checkFences(page: DS.Page, source: string, problems: LinkProblem[]) {
	let open: string | null = null
	for (const [i, line] of source.split('\n').entries()) {
		const m = FENCE.exec(line)
		if (!m) continue
		if (open !== null) {
			if (m[1].startsWith(open) && m[2] === '') open = null
			continue
		}
		open = m[1]
		const lang = m[2]
		if (lang && !(lang in LANGS) && !LANG_ALIASES.includes(lang) && lang !== 'text')
			problems.push({ file: `${page.file}:${i + 1}`, message: `no grammar for code block language "${lang}"` })
	}
}

function collectHeadings(tree: HastNode, out: Site.Heading[]) {
	walk(tree, (node) => {
		const m = node.type === 'element' ? /^h([1-6])$/.exec(node.tagName ?? '') : null
		if (m && typeof node.properties?.id === 'string') out.push({ depth: Number(m[1]), id: node.properties.id, text: textOf(node) })
	})
}

// GitHub's `> [!NOTE]` alerts: the marker becomes a title, and the blockquote a styled callout
function markCallouts(tree: HastNode) {
	walk(tree, (node) => {
		if (node.tagName !== 'blockquote') return
		const para = node.children?.find((c) => c.type === 'element')
		const first = para?.tagName === 'p' ? para.children?.[0] : undefined
		const m = first?.type === 'text' ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/.exec(first.value ?? '') : null
		if (!m || !para || !first) return
		const kind = m[1].toLowerCase()
		first.value = (first.value ?? '').slice(m[0].length)
		if (para.children?.[1]?.tagName === 'br') para.children.splice(1, 1)
		node.properties = { ...node.properties, className: [`docs-callout-${kind}`] }
		node.children = [
			{
				type: 'element',
				tagName: 'div',
				properties: { className: ['docs-callout-title'] },
				children: [{ type: 'text', value: kind }],
			},
			...(node.children ?? []),
		]
	})
}

function walk(node: HastNode, visit: (node: HastNode) => void) {
	visit(node)
	for (const child of node.children ?? []) walk(child, visit)
}

function textOf(node: HastNode): string {
	if (node.type === 'text') return node.value ?? ''
	return (node.children ?? []).map(textOf).join('')
}

async function createHighlighter() {
	const langs = await Promise.all(Object.values(LANGS).map((load) => load()))
	return createHighlighterCore({
		themes: [createCssVariablesTheme({ name: 'css-variables', variablePrefix: '--shiki-', fontStyle: true })],
		langs: langs.map((l) => l.default),
		engine: createJavaScriptRegexEngine(),
	})
}

function copyFonts(dir: string, base: string) {
	fs.mkdirSync(path.join(dir, 'fonts'))
	let css = ''
	const preloads: string[] = []
	for (const font of FONTS) {
		const file = `${font.pkg}-latin-${font.weight}-${font.style}.woff2`
		fs.copyFileSync(path.join(ROOT, 'node_modules/@fontsource', font.pkg, 'files', file), path.join(dir, 'fonts', file))
		const href = `${base}fonts/${file}`
		css += `@font-face{font-family:'${font.family}';font-style:${font.style};font-weight:${font.weight};font-display:optional;src:url(${href}) format('woff2')}`
		if (font.preload) preloads.push(href)
	}
	return { css, preloads }
}

async function buildCss(dir: string, base: string, fontCss: string) {
	const entry = path.join(ROOT, 'src/docs-site.css')
	const result = await postcss([tailwindcss({ optimize: { minify: true } })]).process(fs.readFileSync(entry, 'utf8'), {
		from: entry,
	})
	return writeHashed(dir, base, 'docs', 'css', fontCss + result.css)
}

async function buildJs(dir: string, base: string) {
	const bundle = await rolldown({ input: path.join(ROOT, 'src/systems/docs-site.client.ts'), platform: 'browser' })
	const { output } = await bundle.generate({ format: 'esm', minify: true })
	await bundle.close()
	return writeHashed(dir, base, 'docs', 'js', output[0].code)
}

function writeHashed(dir: string, base: string, name: string, ext: string, content: string) {
	const hash = createHash('sha256').update(content).digest('hex').slice(0, 10)
	const file = `${name}.${hash}.${ext}`
	fs.writeFileSync(path.join(dir, file), content)
	return `${base}${file}`
}

function writePage(dir: string, rel: string, element: React.ReactElement) {
	const dest = path.join(dir, rel)
	fs.mkdirSync(path.dirname(dest), { recursive: true })
	fs.writeFileSync(dest, `<!doctype html>${renderToStaticMarkup(element)}`)
}

// A PNG's size in CSS pixels, so it reserves its space before it loads and shows at the size it was captured at. A
// screenshot taken at a device scale factor of 2 records 144 DPI in its pHYs chunk (scripts/stamp-png-density.mjs);
// anything without one is taken as 1x.
function imageSize(file: string): { width?: number; height?: number } {
	if (!file.endsWith('.png')) return {}
	const png = fs.readFileSync(path.join(ROOT, file))
	const width = png.readUInt32BE(16)
	const height = png.readUInt32BE(20)
	let scale = 1
	for (let at = 8; at + 8 <= png.length;) {
		const len = png.readUInt32BE(at)
		const type = png.toString('ascii', at + 4, at + 8)
		if (type === 'IDAT') break
		// unit 1 is pixels per metre; 144 DPI is 5669
		if (type === 'pHYs' && png[at + 16] === 1) scale = Math.max(1, Math.round(png.readUInt32BE(at + 8) / 2835))
		at += 12 + len
	}
	return { width: Math.round(width / scale), height: Math.round(height / scale) }
}

async function buildSearchIndex(dir: string) {
	const { index, errors } = await Pagefind.createIndex({})
	if (!index) throw new Error(`pagefind: ${errors.join(', ')}`)
	const added = await index.addDirectory({ path: dir })
	if (added.errors.length > 0) throw new Error(`pagefind: ${added.errors.join(', ')}`)
	const written = await index.writeFiles({ outputPath: path.join(dir, 'pagefind') })
	if (written.errors.length > 0) throw new Error(`pagefind: ${written.errors.join(', ')}`)
	await Pagefind.close()
}

function normalizeBase(base: string) {
	return `/${base.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/')
}

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.wasm': 'application/wasm',
	'.woff2': 'font/woff2',
}

const IMMUTABLE = /(?:\.[0-9a-f]{10}\.(?:css|js)|\.woff2)$/

// a static file server over dist-docs, answering the way a static host would
function serve() {
	http
		.createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://localhost')
			let rel = decodeURIComponent(url.pathname)
			if (!rel.startsWith(SITE_ROOT)) rel = SITE_ROOT
			rel = rel.slice(SITE_ROOT.length)
			let file = path.join(OUT, rel)
			if (!file.startsWith(OUT)) file = OUT
			if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
			const found = fs.existsSync(file)
			if (!found) file = path.join(OUT, '404.html')
			const stat = fs.statSync(file)
			const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`
			// hashed files and fonts never change under their name; pages and versions.json are checked on every visit
			const cache = IMMUTABLE.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache'
			const headers = { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': cache, etag }
			if (found && req.headers['if-none-match'] === etag) {
				res.writeHead(304, headers)
				res.end()
				return
			}
			res.writeHead(found ? 200 : 404, headers)
			fs.createReadStream(file).pipe(res)
		})
		.listen(PORT, () => console.log(`docs: serving http://localhost:${PORT}${SITE_ROOT}`))
}

await main()
if (SERVE) serve()
