import * as Paths from '$root/paths'
import { LandingDocument } from '@/components/landing-pages'
import * as Env from '@/server/env.ts'
import { initModule } from '@/server/logger'
import * as Discord from '@/systems/discord.server'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Static, no-JS pages served outside the SPA: the login landing at '/' and the 403 shown to authenticated users
// who lack site access. Authored as React components (landing-pages.tsx), rendered to a string once at setup()
// and held, so requests never re-render them. Fonts/preconnects and the compiled Tailwind stylesheet are pulled
// out of index.html (the single source of truth, id="site-head"): the built dist/index.html in prod (which also
// carries the hashed stylesheet vite injected), the source index.html plus vite's live '/src/index.css' in dev.

const DEFAULT_REPO_URL = 'https://github.com/Tactrigsds/squad-layer-manager'

type Link = { rel: string; href: string; crossOrigin?: 'anonymous'; as?: string; type?: string; media?: string }

// links we reuse from the SPA's <head>; modulepreload/script entries are SPA-only and dropped
const SHARED_RELS = new Set(['preconnect', 'dns-prefetch', 'stylesheet', 'icon'])

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>
const module = initModule('landing')

let landingHtmlCache!: string
let forbiddenHtmlCache!: string

// must run after Discord.setup() so the home guild name is resolved
export function setup() {
	ENV = envBuilder()
	const repoUrl = ENV.PUBLIC_REPO_URL ?? DEFAULT_REPO_URL
	const guildName = Discord.getHomeGuildName()
	const assetLinks = resolveAssetLinks()
	landingHtmlCache = render('landing', repoUrl, guildName, assetLinks)
	forbiddenHtmlCache = render('forbidden', repoUrl, guildName, assetLinks)
	module.getLogger().info('landing pages rendered (guild: %s)', guildName ?? '<none>')
}

export function landingHtml() {
	return landingHtmlCache
}

export function forbiddenHtml() {
	return forbiddenHtmlCache
}

function render(variant: 'landing' | 'forbidden', repoUrl: string, guildName: string | null, assetLinks: Link[]) {
	return '<!DOCTYPE html>' + renderToStaticMarkup(createElement(LandingDocument, { variant, repoUrl, guildName, assetLinks }))
}

function resolveAssetLinks(): Link[] {
	if (ENV.NODE_ENV === 'development') {
		// the source index.html has the fonts; the compiled Tailwind sheet is not a <link> there, so vite serves it
		// at /src/index.css. ?direct makes vite return it as text/css (a bare /src/index.css is an HMR JS module).
		const source = fs.readFileSync(path.join(Paths.PROJECT_ROOT, 'index.html'), 'utf8')
		return [...parseSharedLinks(source), { rel: 'stylesheet', href: '/src/index.css?direct' }]
	}
	// dist/index.html carries the fonts and the hashed Tailwind stylesheet vite injected
	return parseSharedLinks(fs.readFileSync(path.join(Paths.DIST, 'index.html'), 'utf8'))
}

function parseSharedLinks(html: string): Link[] {
	const links: Link[] = []
	for (const tag of html.matchAll(/<link\b([^>]*)>/gi)) {
		const attrs: Record<string, string> = {}
		let bareCrossOrigin = false
		for (const attr of tag[1].matchAll(/([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*"([^"]*)")?/g)) {
			const name = attr[1].toLowerCase()
			if (name === 'crossorigin') bareCrossOrigin = attr[2] === undefined
			if (attr[2] !== undefined) attrs[name] = attr[2]
		}
		if (!attrs.href || !SHARED_RELS.has(attrs.rel)) continue
		const link: Link = { rel: attrs.rel, href: attrs.href }
		if (bareCrossOrigin || attrs.crossorigin === 'anonymous') link.crossOrigin = 'anonymous'
		if (attrs.as) link.as = attrs.as
		if (attrs.type) link.type = attrs.type
		if (attrs.media) link.media = attrs.media
		links.push(link)
	}
	return links
}
