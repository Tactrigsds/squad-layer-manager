// The SLM mark, as geometry. docs/brand.md is the spec; every rendition of the logo (the nav bar tile, the
// landing lockup, the served favicons) draws these shapes so they cannot drift apart.

export const VIEW_BOX = 100

const CORNER_RADIUS = VIEW_BOX / 6
const CAP_HEIGHT = 30.57
const ACCENT_WIDTH = 47
const ACCENT_HEIGHT = 7
const ACCENT_GAP = 7

// "SLM" in Roboto Condensed 800, letter-spacing -0.01em, outlined at font-size 43 of the 100-unit tile. The
// cap-box top sits at y=0 and the ink is centred on x=0, so the letters are positioned by translating alone.
// Outlines rather than text because the favicon renders where the webfont does not load; docs/brand.md says
// how to regenerate them.
const LETTERS =
	'M-22.31 22.49L-22.31 22.49Q-22.31 21.71-22.46 21.09Q-22.60 20.47-23.02 19.94Q-23.44 19.40-24.28 18.85Q-25.12 18.31-26.49 17.72L-26.49 17.72Q-28.17 17.03-29.75 16.20Q-31.34 15.37-32.60 14.27Q-33.86 13.16-34.61 11.66Q-35.37 10.16-35.37 8.15L-35.37 8.15Q-35.37 6.19-34.63 4.61Q-33.90 3.02-32.58 1.90Q-31.25 0.78-29.45 0.18Q-27.64-0.42-25.48-0.42L-25.48-0.42Q-22.56-0.42-20.38 0.77Q-18.19 1.95-16.98 4.08Q-15.76 6.21-15.76 9.05L-15.76 9.05L-22.39 9.05Q-22.39 7.81-22.73 6.88Q-23.06 5.94-23.77 5.41Q-24.47 4.87-25.61 4.87L-25.61 4.87Q-26.65 4.87-27.35 5.31Q-28.04 5.75-28.38 6.51Q-28.71 7.26-28.71 8.19L-28.71 8.19Q-28.71 8.92-28.37 9.49Q-28.02 10.06-27.42 10.54Q-26.82 11.02-25.99 11.46Q-25.16 11.90-24.20 12.30L-24.20 12.30Q-22.14 13.12-20.53 14.09Q-18.93 15.05-17.85 16.26Q-16.77 17.47-16.21 18.99Q-15.65 20.51-15.65 22.44L-15.65 22.44Q-15.65 24.42-16.32 26Q-17 27.59-18.25 28.70Q-19.50 29.81-21.28 30.40Q-23.06 30.99-25.27 30.99L-25.27 30.99Q-27.35 30.99-29.28 30.39Q-31.21 29.79-32.71 28.55Q-34.21 27.32-35.10 25.38Q-35.98 23.45-35.98 20.79L-35.98 20.79L-29.30 20.79Q-29.30 22.15-29.06 23.11Q-28.82 24.06-28.30 24.63Q-27.79 25.20-27.02 25.46Q-26.26 25.72-25.19 25.72L-25.19 25.72Q-24.09 25.72-23.46 25.28Q-22.83 24.84-22.57 24.11Q-22.31 23.39-22.31 22.49ZM-7.73 25.17L5.06 25.17L5.06 30.57L-7.73 30.57L-7.73 25.17ZM-12.20 0L-5.52 0L-5.52 30.57L-12.20 30.57L-12.20 0ZM19.62 30.57L10.82 0L16.43 0L21.97 21.04L27.49 0L32.76 0L24.30 30.57L19.62 30.57ZM7.95 30.57L7.95 0L13.55 0L14.50 21.73L14.50 30.57L7.95 30.57ZM29.43 21.73L30.37 0L35.98 0L35.98 30.57L29.43 30.57L29.43 21.73Z'

export type Role = 'tile' | 'letters' | 'accent'
export type Shape = { role: Role; d: string; translate?: { x: number; y: number }; scale?: number }

/**
 * `bleed` squares off the tile for the platforms that impose a mask of their own (the iOS home screen, Android
 * adaptive icons), so theirs is the only rounding. `contentScale` shrinks the letters and accent about the tile's
 * centre, to keep them inside the safe zone such a mask leaves.
 */
export function shapes(withAccent: boolean, opts: { bleed?: boolean; contentScale?: number } = {}): Shape[] {
	const scale = opts.contentScale ?? 1
	const block = withAccent ? CAP_HEIGHT + ACCENT_GAP + ACCENT_HEIGHT : CAP_HEIGHT
	const top = (VIEW_BOX - block) / 2
	const out: Shape[] = [
		{ role: 'tile', d: roundedRect(0, 0, VIEW_BOX, VIEW_BOX, opts.bleed ? 0 : CORNER_RADIUS) },
		scaled({ role: 'letters', d: LETTERS, translate: { x: VIEW_BOX / 2, y: top } }, scale),
	]
	if (withAccent) {
		const y = top + CAP_HEIGHT + ACCENT_GAP
		out.push(
			scaled(
				{
					role: 'accent',
					d: roundedRect((VIEW_BOX - ACCENT_WIDTH) / 2, y, ACCENT_WIDTH, ACCENT_HEIGHT, ACCENT_HEIGHT / 2),
				},
				scale,
			),
		)
	}
	return out
}

// folds a scale about the tile's centre into the shape's own translate, so a renderer only has to apply
// `translate(...) scale(...)` in that order
function scaled(shape: Shape, scale: number): Shape {
	if (scale === 1) return shape
	const centre = VIEW_BOX / 2
	const { x, y } = shape.translate ?? { x: 0, y: 0 }
	return { ...shape, scale, translate: { x: centre * (1 - scale) + x * scale, y: centre * (1 - scale) + y * scale } }
}

/** The `transform` a shape's path needs, or undefined when it needs none. */
export function transform(shape: Shape): string | undefined {
	const parts: string[] = []
	if (shape.translate) parts.push(`translate(${n(shape.translate.x)} ${n(shape.translate.y)})`)
	if (shape.scale !== undefined) parts.push(`scale(${shape.scale})`)
	return parts.length === 0 ? undefined : parts.join(' ')
}

/** Fills for the mark on a surface of the given theme: the tile takes --foreground, the letters --background. */
export const THEME_FILLS = {
	light: { tile: '#09090b', letters: '#ffffff' },
	dark: { tile: '#fafafa', letters: '#09090b' },
} as const

export type ThemeFills = (typeof THEME_FILLS)[keyof typeof THEME_FILLS]

export function svg(opts: { accent: string | null; fills: ThemeFills; size?: number }): string {
	const paths = shapes(opts.accent !== null).map((s) => path(s, `fill="${s.role === 'accent' ? opts.accent : opts.fills[s.role]}"`))
	return wrap(paths.join(''), opts.size)
}

/** A favicon that follows the browser's colour scheme, for `rel="icon" type="image/svg+xml"`. */
export function themedSvg(opts: { accent: string | null; size?: number }): string {
	const scheme = (fills: ThemeFills) => `.t{fill:${fills.tile}}.l{fill:${fills.letters}}`
	const style = `${scheme(THEME_FILLS.light)}@media(prefers-color-scheme:dark){${scheme(THEME_FILLS.dark)}}`
	const attrs = { tile: 'class="t"', letters: 'class="l"', accent: `fill="${opts.accent}"` } as const
	const paths = shapes(opts.accent !== null).map((s) => path(s, attrs[s.role]))
	return wrap(`<style>${style}</style>${paths.join('')}`, opts.size)
}

function path(shape: Shape, fillAttr: string) {
	const attr = transform(shape)
	return `<path ${fillAttr}${attr === undefined ? '' : ` transform="${attr}"`} d="${shape.d}"/>`
}

function wrap(body: string, size?: number) {
	const dims = size === undefined ? '' : ` width="${size}" height="${size}"`
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_BOX} ${VIEW_BOX}"${dims}>${body}</svg>`
}

// circular arcs approximated with cubics; the constant is the standard 4/3*(sqrt(2)-1)
const KAPPA = 0.5522847498
function roundedRect(x: number, y: number, w: number, h: number, r: number) {
	const k = r * KAPPA
	const [x1, y1] = [x + w, y + h]
	if (r === 0) return `M${n(x)} ${n(y)}L${n(x1)} ${n(y)}L${n(x1)} ${n(y1)}L${n(x)} ${n(y1)}Z`
	return (
		`M${n(x + r)} ${n(y)}` +
		`L${n(x1 - r)} ${n(y)}C${n(x1 - r + k)} ${n(y)} ${n(x1)} ${n(y + r - k)} ${n(x1)} ${n(y + r)}` +
		`L${n(x1)} ${n(y1 - r)}C${n(x1)} ${n(y1 - r + k)} ${n(x1 - r + k)} ${n(y1)} ${n(x1 - r)} ${n(y1)}` +
		`L${n(x + r)} ${n(y1)}C${n(x + r - k)} ${n(y1)} ${n(x)} ${n(y1 - r + k)} ${n(x)} ${n(y1 - r)}` +
		`L${n(x)} ${n(y + r)}C${n(x)} ${n(y + r - k)} ${n(x + r - k)} ${n(y)} ${n(x + r)} ${n(y)}Z`
	)
}

function n(value: number) {
	return +value.toFixed(2)
}
