import * as Resvg from '@resvg/resvg-js'
import * as path from 'node:path'

import * as Paths from '$root/paths.ts'

// Rasterizes SVG to PNG for places that cannot show SVG, such as a discord embed. System fonts are never
// loaded: the image ships none, so text is drawn only in the fonts below.

const FONTS_DIR = path.join(Paths.ASSETS, 'fonts')

/** The font families text in a rasterized SVG can name. Any other family falls back to `regular`. */
export const FONT_FAMILIES = { regular: 'Barlow', semibold: 'Barlow SemiBold' } as const

const FONT_FILES = [path.join(FONTS_DIR, 'Barlow-Regular.ttf'), path.join(FONTS_DIR, 'Barlow-SemiBold.ttf')]

/** `scale` multiplies the SVG's own width and height, so a chart drawn at 1x can be sent at 2x. */
export function svgToPng(svg: string, opts?: { scale?: number }): Uint8Array {
	const resvg = new Resvg.Resvg(svg, {
		font: { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: FONT_FAMILIES.regular },
		fitTo: opts?.scale && opts.scale !== 1 ? { mode: 'zoom', value: opts.scale } : { mode: 'original' },
	})
	return resvg.render().asPng()
}
