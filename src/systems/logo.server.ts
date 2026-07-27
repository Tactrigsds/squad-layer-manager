import * as Color from '@/lib/color'
import * as Logo from '@/lib/logo'
import * as Raster from '@/lib/raster'
import type * as CS from '@/models/context-shared'
import * as Settings from '@/systems/settings.server'

// The served renditions of the SLM mark. Their accent is the instance's topBarColor, so they are built from
// settings rather than shipped in dist/, and rebuilt whenever an admin changes the colour.

export type Kind = 'favicon.ico' | 'favicon.svg' | 'apple-touch-icon.png'

export type Artifact = { body: Buffer | string; contentType: string; etag: string }

/** The .ico carries both so browser chrome and the Windows shell each get an exact size; see docs/brand.md. */
const ICO_SIZES = [32, 48]
const APPLE_TOUCH_SIZE = 180

let cached: { accent: string | null; artifacts: Record<Kind, Artifact> } | undefined

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
	const png = (size: number) => Raster.png(Raster.draw(fills(accent), { size, viewBox: Logo.VIEW_BOX }), size)
	return {
		'favicon.ico': {
			body: Raster.ico(ICO_SIZES.map((size) => ({ size, png: png(size) }))),
			contentType: 'image/x-icon',
			etag,
		},
		'favicon.svg': { body: Logo.themedSvg({ accent }), contentType: 'image/svg+xml', etag },
		'apple-touch-icon.png': { body: png(APPLE_TOUCH_SIZE), contentType: 'image/png', etag },
	}
}

// rasters can't follow the browser's colour scheme, so they take the dark-theme mark: a light tile reads on
// either tab strip, where a dark one disappears into dark chrome.
function fills(accent: string | null): Raster.Fill[] {
	const accentColor = accent === null ? null : Color.parse(accent)
	return Logo.shapes(accentColor !== null).map((shape) => ({
		d: shape.d,
		translate: shape.translate,
		color: shape.role === 'accent' ? accentColor! : Color.parse(Logo.THEME_FILLS.dark[shape.role])!,
	}))
}
