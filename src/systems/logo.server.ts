import * as Color from '@/lib/color'
import * as Logo from '@/lib/logo'
import * as Raster from '@/lib/raster'
import * as APP_Msgs from '@/messages/app.messages'
import * as I18n from '@/messages/i18n'
import type * as CS from '@/models/context-shared'
import * as Settings from '@/systems/settings.server'

// The served renditions of the SLM mark. Their accent is the instance's topBarColor, so they are built from
// settings rather than shipped in dist/, and rebuilt whenever an admin changes the colour.

export const KINDS = [
	'favicon.ico',
	'favicon.svg',
	'icon-192.png',
	'icon-512.png',
	'apple-touch-icon.png',
	'maskable-icon.png',
	'manifest.webmanifest',
] as const

export type Kind = (typeof KINDS)[number]

export type Artifact = { body: Buffer | string; contentType: string; etag: string }

/** The .ico carries all three so tab strip, bookmark bar and the Windows shell each get an exact size. */
const ICO_SIZES = [16, 32, 48]
/** The PNG fallback for browsers that ignore an SVG favicon, and the manifest's icons. */
const PNG_SIZES = [192, 512] as const
const APPLE_TOUCH_SIZE = 180
const MASKABLE_SIZE = 512
/** Android crops a maskable icon to an arbitrary shape, guaranteeing only the middle 80% of the square. */
const MASKABLE_CONTENT_SCALE = 0.85

const SHORT_NAME = 'SLM'
/** The manifest's splash and theme colours, matching the dark-theme mark the rasters use. */
const MANIFEST_BACKGROUND = Logo.THEME_FILLS.dark.letters

let cached: { accent: string | null; artifacts: Record<Kind, Artifact> } | undefined

// the 512px rasters take a moment to draw, and drawing them is synchronous; at boot that costs nothing, whereas
// on the first request it would stall every other request behind it
export function setup(ctx: CS.Log) {
	const current = accent(ctx)
	cached = { accent: current, artifacts: build(current) }
}

export function artifact(ctx: CS.Log, kind: Kind): Artifact {
	const current = accent(ctx)
	if (!cached || cached.accent !== current) {
		cached = { accent: current, artifacts: build(current) }
	}
	return cached.artifacts[kind]
}

/** The instance's topBarColor, or null when it is unset or unrenderable. */
export function accent(ctx: CS.Log): string | null {
	const configured = Settings.GLOBAL_SETTINGS.topBarColor
	if (configured === null) return null
	if (Color.parse(configured) === null) {
		ctx.log.warn('topBarColor %s is not a colour the logo can be rendered with; serving the mark without an accent', configured)
		return null
	}
	return configured
}

function build(accent: string | null): Record<Kind, Artifact> {
	const etag = `"${accent ?? 'plain'}"`
	const png = (size: number, opts?: { bleed?: boolean; contentScale?: number }) =>
		Raster.png(Raster.draw(fills(accent, opts), { size, viewBox: Logo.VIEW_BOX }), size)
	const asPng = (body: Buffer): Artifact => ({ body, contentType: 'image/png', etag })
	return {
		'favicon.ico': {
			body: Raster.ico(ICO_SIZES.map((size) => ({ size, png: png(size) }))),
			contentType: 'image/x-icon',
			etag,
		},
		'favicon.svg': { body: Logo.themedSvg({ accent }), contentType: 'image/svg+xml', etag },
		'icon-192.png': asPng(png(PNG_SIZES[0])),
		'icon-512.png': asPng(png(PNG_SIZES[1])),
		// iOS composites a transparent pixel onto black and then rounds the icon itself, so this one is a full-bleed
		// square: rounded corners of our own would show as black wedges outside its mask
		'apple-touch-icon.png': asPng(png(APPLE_TOUCH_SIZE, { bleed: true })),
		'maskable-icon.png': asPng(png(MASKABLE_SIZE, { bleed: true, contentScale: MASKABLE_CONTENT_SCALE })),
		'manifest.webmanifest': { body: manifest(accent), contentType: 'application/manifest+json', etag },
	}
}

function manifest(accent: string | null): string {
	const tr = I18n.translatorFor(I18n.DEFAULT_LOCALE)
	return JSON.stringify({
		id: '/',
		name: tr.text(APP_Msgs.productName()),
		short_name: SHORT_NAME,
		description: tr.text(APP_Msgs.tagline()),
		start_url: '/',
		scope: '/',
		display: 'standalone',
		theme_color: accent ?? MANIFEST_BACKGROUND,
		background_color: MANIFEST_BACKGROUND,
		icons: [
			...PNG_SIZES.map((size) => ({ src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })),
			{ src: '/maskable-icon.png', sizes: `${MASKABLE_SIZE}x${MASKABLE_SIZE}`, type: 'image/png', purpose: 'maskable' },
		],
	})
}

// rasters can't follow the browser's colour scheme, so they take the dark-theme mark: a light tile reads on
// either tab strip, where a dark one disappears into dark chrome.
function fills(accent: string | null, opts?: { bleed?: boolean; contentScale?: number }): Raster.Fill[] {
	const accentColor = accent === null ? null : Color.parse(accent)
	return Logo.shapes(accentColor !== null, opts).map((shape) => ({
		d: shape.d,
		translate: shape.translate,
		scale: shape.scale,
		color: shape.role === 'accent' ? accentColor! : Color.parse(Logo.THEME_FILLS.dark[shape.role])!,
	}))
}
