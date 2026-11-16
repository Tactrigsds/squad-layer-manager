// Resolves and caches the icon shown beside each nav link. The server does the fetching so that a site which declares
// its icon in its html, or which blocks hotlinking, still gets one, and so that browsers only ever load the icon from
// SLM. Candidates are tried in order: the icons the page's <link> tags declare, the origin's /favicon.ico, then
// Google's favicon service, which also covers sites behind a bot challenge.

import * as Crypto from 'node:crypto'

import type * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'
import * as Settings from '@/systems/settings.server'

const module = initModule('nav-link-icons')

export type Icon = { body: Buffer; contentType: string; etag: string }

const HIT_TTL_MS = 24 * 60 * 60 * 1000
const MISS_TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8_000
const MAX_HTML_BYTES = 512 * 1024
const MAX_ICON_BYTES = 256 * 1024
const MAX_PAGE_CANDIDATES = 3
// the icon renders at 14px, so 32px covers a 2x display
const TARGET_ICON_PX = 32
// Some sites (BattleMetrics' Cloudflare among them) refuse requests that do not look like a browser.
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

const cache = new Map<string, { icon: Icon | null; expiresAt: number }>()
const inFlight = new Map<string, Promise<Icon | null>>()

// null when the url is not a configured nav link, or when no candidate yields an image
export async function get(ctx: C.Db, url: string): Promise<Icon | null> {
	const cached = cache.get(url)
	if (cached && cached.expiresAt > Date.now()) return cached.icon
	if (!isConfiguredNavLink(ctx, url)) return null
	let pending = inFlight.get(url)
	if (!pending) {
		pending = resolve(new URL(url))
			.catch((error: unknown) => {
				module.getLogger().warn({ err: error, url }, 'resolving nav link icon failed')
				return null
			})
			.then((icon) => {
				cache.set(url, { icon, expiresAt: Date.now() + (icon ? HIT_TTL_MS : MISS_TTL_MS) })
				return icon
			})
			.finally(() => inFlight.delete(url))
		inFlight.set(url, pending)
	}
	return pending
}

// Only configured links are resolved, so the route cannot be used to make the server fetch arbitrary urls.
function isConfiguredNavLink(ctx: C.Db, url: string) {
	if (Settings.GLOBAL_SETTINGS.navLinks?.some((link) => link.url === url)) return true
	for (const entry of Settings.listServerEntries()) {
		if (entry.broken) continue
		if (Settings.getServerSettings(ctx, entry.id).navLinks.some((link) => link.url === url)) return true
	}
	return false
}

// Shared by every request for the url, so it runs on its own timeout rather than any one request's signal.
async function resolve(url: URL): Promise<Icon | null> {
	const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS * 3)
	for (const candidate of await pageIconCandidates(signal, url)) {
		const icon = await fetchIcon(signal, candidate)
		if (icon) return icon
	}
	return (
		(await fetchIcon(signal, new URL('/favicon.ico', url.origin))) ??
		(await fetchIcon(signal, new URL(`https://www.google.com/s2/favicons?sz=${TARGET_ICON_PX * 2}&domain=${url.hostname}`)))
	)
}

async function pageIconCandidates(signal: AbortSignal, url: URL, followRefresh = true): Promise<URL[]> {
	const res = await fetchWithTimeout(signal, url, 'text/html')
	if (!res) return []
	// A page that redirects elsewhere is usually a sign-in wall, whose icon belongs to the sign-in provider.
	const finalUrl = new URL(res.url)
	if (!res.ok || finalUrl.origin !== url.origin || !res.headers.get('content-type')?.includes('html')) {
		await res.body?.cancel()
		return []
	}
	const html = (await readCapped(res, MAX_HTML_BYTES, true)).toString('utf8')
	const headEnd = html.search(/<\/head\s*>/i)
	const head = headEnd === -1 ? html : html.slice(0, headEnd)
	const links = parseIconLinks(head, finalUrl)
	if (links.length > 0) return links.slice(0, MAX_PAGE_CANDIDATES).map((link) => link.href)
	// a static site's root is often a meta refresh to its real landing page, which declares the icon
	const refreshTarget = followRefresh ? metaRefreshTarget(head, finalUrl) : null
	if (!refreshTarget || refreshTarget.origin !== url.origin) return []
	return pageIconCandidates(signal, refreshTarget, false)
}

function metaRefreshTarget(head: string, base: URL): URL | null {
	for (const match of head.matchAll(/<meta\b([^>]*)>/gi)) {
		const attrs = parseAttrs(match[1])
		if (attrs['http-equiv']?.toLowerCase() !== 'refresh') continue
		const target = attrs.content?.match(/url\s*=\s*['"]?([^'"]+)/i)?.[1]
		if (!target) return null
		try {
			return new URL(target.trim(), base)
		} catch {
			return null
		}
	}
	return null
}

type IconLink = { href: URL; rank: number }

// Ranked best first: scalable icons, then the smallest raster at or above TARGET_ICON_PX, then smaller rasters.
// mask-icon is excluded, since it is a monochrome silhouette meant to be tinted.
function parseIconLinks(head: string, base: URL): IconLink[] {
	const links: IconLink[] = []
	for (const match of head.matchAll(/<link\b([^>]*)>/gi)) {
		const attrs = parseAttrs(match[1])
		const rels = (attrs.rel ?? '').toLowerCase().split(/\s+/)
		const isTouchIcon = rels.includes('apple-touch-icon') || rels.includes('apple-touch-icon-precomposed')
		if (!rels.includes('icon') && !isTouchIcon) continue
		if (!attrs.href) continue
		let href: URL
		try {
			href = new URL(attrs.href, base)
		} catch {
			continue
		}
		if (href.protocol !== 'https:' && href.protocol !== 'http:') continue
		const isSvg = attrs.type === 'image/svg+xml' || href.pathname.endsWith('.svg') || attrs.sizes === 'any'
		const declared = Math.max(0, ...(attrs.sizes ?? '').split(/\s+/).map((size) => Number.parseInt(size, 10) || 0))
		// unsized: touch icons default to 180px, and a plain icon is usually at least 32px
		const size = declared || (isTouchIcon ? 180 : TARGET_ICON_PX)
		const rank = isSvg ? 0 : size >= TARGET_ICON_PX ? size : 10_000 - size
		links.push({ href, rank })
	}
	return links.sort((a, b) => a.rank - b.rank)
}

function parseAttrs(raw: string): Record<string, string> {
	const attrs: Record<string, string> = {}
	for (const match of raw.matchAll(/([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
		attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4])
	}
	return attrs
}

function decodeEntities(value: string) {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
}

async function fetchIcon(signal: AbortSignal, url: URL): Promise<Icon | null> {
	const res = await fetchWithTimeout(signal, url, 'image/*')
	if (!res) return null
	if (!res.ok) {
		await res.body?.cancel()
		return null
	}
	const body = await readCapped(res, MAX_ICON_BYTES, false).catch(() => null)
	if (!body) return null
	const contentType = sniffImageType(body)
	if (!contentType) return null
	return { body, contentType, etag: `"${Crypto.createHash('sha256').update(body).digest('base64url')}"` }
}

async function fetchWithTimeout(signal: AbortSignal, url: URL, accept: string): Promise<Response | null> {
	try {
		return await fetch(url, {
			signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
			headers: { 'User-Agent': USER_AGENT, Accept: accept },
		})
	} catch {
		return null
	}
}

// truncate keeps the first maxBytes of an oversized body, which is enough to find a page's <head>
async function readCapped(res: Response, maxBytes: number, truncate: boolean): Promise<Buffer> {
	const chunks: Uint8Array[] = []
	let total = 0
	for await (const chunk of res.body ?? []) {
		chunks.push(chunk)
		total += chunk.byteLength
		if (total > maxBytes) {
			await res.body?.cancel().catch(() => {})
			if (!truncate) throw new Error(`${res.url} is larger than ${maxBytes} bytes`)
			break
		}
	}
	return Buffer.concat(chunks).subarray(0, maxBytes)
}

// Servers often label icons application/octet-stream or text/html, so the type is read from the bytes instead.
function sniffImageType(body: Buffer): string | null {
	if (body.length < 4) return null
	if (body[0] === 0x89 && body.toString('latin1', 1, 4) === 'PNG') return 'image/png'
	if (body.readUInt32BE(0) === 0x00000100) return 'image/x-icon'
	if (body[0] === 0xff && body[1] === 0xd8) return 'image/jpeg'
	if (body.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
	if (body.toString('latin1', 0, 4) === 'RIFF' && body.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
	if (/<svg[\s>]/i.test(body.toString('utf8', 0, Math.min(body.length, 1024)))) return 'image/svg+xml'
	return null
}
