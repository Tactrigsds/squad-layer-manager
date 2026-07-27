import * as fs from 'node:fs'
import * as path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import * as Paths from '$root/paths'
import { LandingDocument } from '@/components/landing-pages'
import * as Rx from '@/lib/rxjs'
import type * as USR_Msgs from '@/messages/users.messages'
import * as CS from '@/models/context-shared'
import * as Env from '@/server/env.ts'
import { initModule } from '@/server/logger'
import * as Discord from '@/systems/discord.server'
import * as LogoSys from '@/systems/logo.server'
import * as Settings from '@/systems/settings.server'

// Static, no-JS pages served outside the SPA: the login landing at '/' and the 403 shown to authenticated users
// who lack site access. Authored as React components (landing-pages.tsx), rendered to a string once at setup()
// and held, so requests never re-render them. The <html> attributes, <meta> tags and fonts/preconnects are pulled
// out of index.html (the single source of truth, id="site-head"); the source in dev/test, the built dist copy in
// prod. Their own scoped Tailwind (landing-css.ts) is inlined so the pages are self-contained: unlike the app's
// stylesheet under /assets, an inline <style> is not gated by the auth hook, so it loads for the unauthenticated
// visitors these pages exist for.

const DEFAULT_REPO_URL = 'https://github.com/Tactrigsds/squad-layer-manager'

type Link = { rel: string; href: string; crossOrigin?: 'anonymous'; as?: string; type?: string; media?: string }
type Meta = { charSet?: string; name?: string; content?: string; httpEquiv?: string }
type Head = { htmlAttrs: Record<string, string>; metas: Meta[]; assetLinks: Link[] }

// links we reuse from the SPA's <head>; modulepreload/script entries are SPA-only and dropped
const SHARED_RELS = new Set(['preconnect', 'dns-prefetch', 'stylesheet', 'icon', 'apple-touch-icon'])

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>
const module = initModule('landing')

let landingHtmlCache!: string
let forbiddenHtmlCache!: string
let renderInputs!: { repoUrl: string; guildName: string | null; head: Head; inlineCss: string; accent: string | null }

// must run after Discord.setup() so the home guild name is resolved, and after Settings.setup() for the accent
export async function setup() {
	ENV = envBuilder()
	renderInputs = {
		repoUrl: ENV.PUBLIC_REPO_URL ?? DEFAULT_REPO_URL,
		guildName: Discord.getHomeGuildName(),
		head: resolveHead(),
		inlineCss: await resolveInlineCss(),
		accent: LogoSys.accent({ ...CS.init(), log: module.getLogger() }),
	}
	renderCaches()
	module.getLogger().info('landing pages rendered (guild: %s)', renderInputs.guildName ?? '<none>')

	Settings.settings$.pipe(Rx.filter((event) => event.scope === 'global')).subscribe(() => {
		renderInputs = { ...renderInputs, accent: LogoSys.accent({ ...CS.init(), log: module.getLogger() }) }
		renderCaches()
	})
}

function renderCaches() {
	// with discord auth off there is no oauth flow to send anyone into, so '/' offers the username form instead
	landingHtmlCache = render(ENV.QUERY_PARAM_AUTH_BYPASS ? 'no-auth' : 'landing', null)
	forbiddenHtmlCache = render('forbidden', null)
}

async function resolveInlineCss(): Promise<string> {
	// prod's bundled server has no Tailwind, so it reads the sheet build-landing-css.ts baked into the image;
	// dev/test run from source via tsx and compile it in-process (the dynamic import keeps Tailwind out of the bundle)
	if (ENV.NODE_ENV === 'production') return fs.readFileSync(path.join(Paths.DIST, 'landing.css'), 'utf8')
	const { compileLandingCss } = await import('@/systems/landing-css')
	return compileLandingCss()
}

export function landingHtml() {
	return landingHtmlCache
}

export function forbiddenHtml() {
	return forbiddenHtmlCache
}

// the only page rendered per request: a rejected username has to say why, and nobody is served this often
// enough for a cache to matter
export function noAuthHtml(error: string) {
	return render('no-auth', error)
}

function render(variant: USR_Msgs.LandingVariant, error: string | null) {
	return '<!DOCTYPE html>' + renderToStaticMarkup(createElement(LandingDocument, { variant, error, ...renderInputs }))
}

function resolveHead(): Head {
	// only the bundled prod server lacks the source tree, so it reads the built copy; dev/test run from source
	const html =
		ENV.NODE_ENV === 'production'
			? fs.readFileSync(path.join(Paths.DIST, 'index.html'), 'utf8')
			: fs.readFileSync(path.join(Paths.PROJECT_ROOT, 'index.html'), 'utf8')
	return { htmlAttrs: parseHtmlAttrs(html), metas: parseMetas(html), assetLinks: parseSharedLinks(html) }
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
		// the app's own stylesheet (same-origin /assets, vite-injected) is auth-gated and superseded by our inline
		// sheet; keep only the external font/preconnect links
		if (attrs.rel === 'stylesheet' && attrs.href.startsWith('/')) continue
		const link: Link = { rel: attrs.rel, href: attrs.href }
		if ('crossorigin' in attrs) link.crossOrigin = 'anonymous'
		if (attrs.as) link.as = attrs.as
		if (attrs.type) link.type = attrs.type
		if (attrs.media) link.media = attrs.media
		links.push(link)
	}
	return links
}
