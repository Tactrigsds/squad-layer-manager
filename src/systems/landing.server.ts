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
// and held, so requests never re-render them. The <html> attributes, <meta> tags, fonts/preconnects and the
// compiled Tailwind stylesheet are pulled out of index.html (the single source of truth, id="site-head"): the
// built dist/index.html in prod (which also carries the hashed stylesheet vite injected), the source index.html
// plus vite's live '/src/index.css' in dev.

const DEFAULT_REPO_URL = 'https://github.com/Tactrigsds/squad-layer-manager'

type Link = { rel: string; href: string; crossOrigin?: 'anonymous'; as?: string; type?: string; media?: string }
type Meta = { charSet?: string; name?: string; content?: string; httpEquiv?: string }
type Head = { htmlAttrs: Record<string, string>; metas: Meta[]; assetLinks: Link[] }

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
	const head = resolveHead()
	landingHtmlCache = render('landing', repoUrl, guildName, head)
	forbiddenHtmlCache = render('forbidden', repoUrl, guildName, head)
	module.getLogger().info('landing pages rendered (guild: %s)', guildName ?? '<none>')
}

export function landingHtml() {
	return landingHtmlCache
}

export function forbiddenHtml() {
	return forbiddenHtmlCache
}

function render(variant: 'landing' | 'forbidden', repoUrl: string, guildName: string | null, head: Head) {
	return '<!DOCTYPE html>' + renderToStaticMarkup(createElement(LandingDocument, { variant, repoUrl, guildName, head }))
}

function resolveHead(): Head {
	if (ENV.NODE_ENV === 'development') {
		const source = fs.readFileSync(path.join(Paths.PROJECT_ROOT, 'index.html'), 'utf8')
		// the source index.html has the fonts but not the compiled Tailwind sheet (vite injects that as JS); ?direct
		// makes vite serve it as text/css (a bare /src/index.css is an HMR JS module)
		return {
			htmlAttrs: parseHtmlAttrs(source),
			metas: parseMetas(source),
			assetLinks: [...parseSharedLinks(source), { rel: 'stylesheet', href: '/src/index.css?direct' }],
		}
	}
	// dist/index.html carries the fonts and the hashed Tailwind stylesheet vite injected
	const dist = fs.readFileSync(path.join(Paths.DIST, 'index.html'), 'utf8')
	return { htmlAttrs: parseHtmlAttrs(dist), metas: parseMetas(dist), assetLinks: parseSharedLinks(dist) }
}

function parseAttrs(raw: string): Record<string, string> {
	const attrs: Record<string, string> = {}
	for (const attr of raw.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*"([^"]*)")?/g)) {
		attrs[attr[1].toLowerCase()] = attr[2] ?? ''
	}
	return attrs
}

function parseHtmlAttrs(html: string): Record<string, string> {
	const match = html.match(/<html\b([^>]*)>/i)
	const attrs = match ? parseAttrs(match[1]) : {}
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(attrs)) out[key === 'class' ? 'className' : key] = value
	// the static page runs no theme JS, so pin the app's default (dark) theme rather than leaving it on :root/light
	out.className = out.className ? `${out.className} dark` : 'dark'
	return out
}

function parseMetas(html: string): Meta[] {
	const metas: Meta[] = []
	for (const tag of html.matchAll(/<meta\b([^>]*?)\/?>/gi)) {
		const attrs = parseAttrs(tag[1])
		const meta: Meta = {}
		if (attrs.charset) meta.charSet = attrs.charset
		if (attrs.name) meta.name = attrs.name
		if (attrs.content) meta.content = attrs.content
		if (attrs['http-equiv']) meta.httpEquiv = attrs['http-equiv']
		if (Object.keys(meta).length > 0) metas.push(meta)
	}
	return metas
}

function parseSharedLinks(html: string): Link[] {
	const links: Link[] = []
	for (const tag of html.matchAll(/<link\b([^>]*)>/gi)) {
		const attrs = parseAttrs(tag[1])
		if (!attrs.href || !SHARED_RELS.has(attrs.rel)) continue
		const link: Link = { rel: attrs.rel, href: attrs.href }
		if ('crossorigin' in attrs) link.crossOrigin = 'anonymous'
		if (attrs.as) link.as = attrs.as
		if (attrs.type) link.type = attrs.type
		if (attrs.media) link.media = attrs.media
		links.push(link)
	}
	return links
}
