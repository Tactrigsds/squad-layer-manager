export type Rgb = { r: number; g: number; b: number }

// one argument of rgb()/hsl(): a number, optionally a percentage or a hue in degrees
const NUMERIC_PART = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?(%|deg)?$/

/** Parses the CSS colour syntaxes a user can type into a setting: hex, rgb()/rgba(), hsl()/hsla(), and names. */
export function parse(input: string): Rgb | null {
	const value = input.trim().toLowerCase()
	const named = NAMED[value]
	if (named) return parse(named)
	if (value.startsWith('#')) return parseHex(value.slice(1))
	const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(value)
	if (!fn) return null
	const parts = fn[2].split(/[\s,/]+/).filter((p) => p !== '')
	if (parts.length < 3 || parts.length > 4 || !parts.every((p) => NUMERIC_PART.test(p))) return null
	if (fn[1].startsWith('rgb')) {
		const [r, g, b] = parts.map((p) => channel(p, 255))
		return r === null || g === null || b === null ? null : { r, g, b }
	}
	const h = Number.parseFloat(parts[0])
	const s = channel(parts[1], 1)
	const l = channel(parts[2], 1)
	if (!Number.isFinite(h) || s === null || l === null) return null
	return fromHsl(h, s, l)
}

function parseHex(hex: string): Rgb | null {
	if (!/^[0-9a-f]+$/.test(hex)) return null
	// the alpha nibbles of #rgba / #rrggbbaa are dropped: the mark's accent is always opaque
	if (hex.length === 3 || hex.length === 4) {
		const nibble = (i: number) => Number.parseInt(hex[i] + hex[i], 16)
		return { r: nibble(0), g: nibble(1), b: nibble(2) }
	}
	if (hex.length === 6 || hex.length === 8) {
		const pair = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16)
		return { r: pair(0), g: pair(2), b: pair(4) }
	}
	return null
}

function channel(part: string, max: number): number | null {
	const raw = Number.parseFloat(part)
	if (!Number.isFinite(raw)) return null
	const value = part.endsWith('%') ? (raw / 100) * max : raw
	return Math.min(max, Math.max(0, value))
}

function fromHsl(hue: number, s: number, l: number): Rgb {
	const c = (1 - Math.abs(2 * l - 1)) * s
	const h = (((hue % 360) + 360) % 360) / 60
	const x = c * (1 - Math.abs((h % 2) - 1))
	const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
	const m = l - c / 2
	const to255 = (v: number) => Math.round((v + m) * 255)
	return { r: to255(r), g: to255(g), b: to255(b) }
}

export function toHex({ r, g, b }: Rgb): string {
	const pair = (v: number) => Math.round(v).toString(16).padStart(2, '0')
	return `#${pair(r)}${pair(g)}${pair(b)}`
}

export type Oklab = { l: number; a: number; b: number }

export function toOklab({ r, g, b }: Rgb): Oklab {
	const lr = srgbToLinear(r / 255)
	const lg = srgbToLinear(g / 255)
	const lb = srgbToLinear(b / 255)
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
	return {
		l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	}
}

// null when the color falls outside sRGB
export function fromOklch(lightness: number, chroma: number, hueDeg: number): Rgb | null {
	const h = (hueDeg * Math.PI) / 180
	const a = chroma * Math.cos(h)
	const b = chroma * Math.sin(h)
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
	const linear = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	]
	if (linear.some((v) => v < -1e-4 || v > 1 + 1e-4)) return null
	const [r, g, bl] = linear.map((v) => Math.round(linearToSrgb(Math.min(1, Math.max(0, v))) * 255))
	return { r, g, b: bl }
}

function srgbToLinear(v: number) {
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(v: number) {
	return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
}

/** Perceptual distance (ΔE in OKLab). About 0.02 is barely noticeable. */
export function distance(x: Oklab, y: Oklab): number {
	return Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b)
}

// Categorical colors that stay legible as text and as a tinted background against both the light and dark app themes.
// Every pair is at least 0.11 apart; the second half was chosen by farthest-point search around the first.
export const SWATCHES = {
	red: '#d1495b',
	orange: '#e08e45',
	blue: '#3d7dd9',
	green: '#3f9e6b',
	purple: '#8367c7',
	pink: '#e68cde',
	sky: '#49c1ea',
	lime: '#9bc14d',
	ochre: '#9f7100',
	periwinkle: '#9095e8',
	magenta: '#c265b0',
	mint: '#04cfa2',
} as const

export const SWATCH_LIST: readonly string[] = Object.values(SWATCHES)
const SWATCH_LABS = SWATCH_LIST.map((hex) => toOklab(parseHex(hex.slice(1))!))

// how far apart two colors must be to read as different categories at a glance
const MIN_DISTINCT_DISTANCE = 0.1

// Fallback candidates once every swatch is too close to something taken: an OKLCH grid kept to the lightness and chroma
// band the swatches sit in, so a generated color looks like it belongs with them.
let generatedCandidates: { hex: string; lab: Oklab }[] | undefined
function getGeneratedCandidates() {
	if (generatedCandidates) return generatedCandidates
	generatedCandidates = []
	for (const lightness of [0.58, 0.64, 0.7, 0.76]) {
		for (const chroma of [0.15, 0.12]) {
			for (let hue = 0; hue < 360; hue += 10) {
				const rgb = fromOklch(lightness, chroma, hue)
				if (rgb) generatedCandidates.push({ hex: toHex(rgb), lab: toOklab(rgb) })
			}
		}
	}
	return generatedCandidates
}

/**
 * Picks a color for a new category that is easy to tell apart from `taken`. The first swatch far enough from every taken
 * color wins; past that, the generated candidate farthest from its nearest taken color. Deterministic, so the same
 * inputs always give the same color. Unparseable entries in `taken` are ignored.
 */
export function pickDistinct(taken: readonly string[]): string {
	const takenLabs: Oklab[] = []
	for (const color of taken) {
		const rgb = parse(color)
		if (rgb) takenLabs.push(toOklab(rgb))
	}
	const nearest = (lab: Oklab) => {
		let min = Infinity
		for (const other of takenLabs) min = Math.min(min, distance(lab, other))
		return min
	}

	for (let i = 0; i < SWATCH_LIST.length; i++) {
		if (nearest(SWATCH_LABS[i]) >= MIN_DISTINCT_DISTANCE) return SWATCH_LIST[i]
	}

	let best = getGeneratedCandidates()[0]
	let bestDistance = -1
	for (const candidate of getGeneratedCandidates()) {
		const d = nearest(candidate.lab)
		if (d > bestDistance) {
			best = candidate
			bestDistance = d
		}
	}
	return best.hex
}

const NAMED: Record<string, string | undefined> = {
	aliceblue: '#f0f8ff',
	antiquewhite: '#faebd7',
	aqua: '#0ff',
	aquamarine: '#7fffd4',
	azure: '#f0ffff',
	beige: '#f5f5dc',
	bisque: '#ffe4c4',
	black: '#000',
	blanchedalmond: '#ffebcd',
	blue: '#00f',
	blueviolet: '#8a2be2',
	brown: '#a52a2a',
	burlywood: '#deb887',
	cadetblue: '#5f9ea0',
	chartreuse: '#7fff00',
	chocolate: '#d2691e',
	coral: '#ff7f50',
	cornflowerblue: '#6495ed',
	cornsilk: '#fff8dc',
	crimson: '#dc143c',
	cyan: '#0ff',
	darkblue: '#00008b',
	darkcyan: '#008b8b',
	darkgoldenrod: '#b8860b',
	darkgray: '#a9a9a9',
	darkgreen: '#006400',
	darkgrey: '#a9a9a9',
	darkkhaki: '#bdb76b',
	darkmagenta: '#8b008b',
	darkolivegreen: '#556b2f',
	darkorange: '#ff8c00',
	darkorchid: '#9932cc',
	darkred: '#8b0000',
	darksalmon: '#e9967a',
	darkseagreen: '#8fbc8f',
	darkslateblue: '#483d8b',
	darkslategray: '#2f4f4f',
	darkslategrey: '#2f4f4f',
	darkturquoise: '#00ced1',
	darkviolet: '#9400d3',
	deeppink: '#ff1493',
	deepskyblue: '#00bfff',
	dimgray: '#696969',
	dimgrey: '#696969',
	dodgerblue: '#1e90ff',
	firebrick: '#b22222',
	floralwhite: '#fffaf0',
	forestgreen: '#228b22',
	fuchsia: '#f0f',
	gainsboro: '#dcdcdc',
	ghostwhite: '#f8f8ff',
	gold: '#ffd700',
	goldenrod: '#daa520',
	gray: '#808080',
	green: '#008000',
	greenyellow: '#adff2f',
	grey: '#808080',
	honeydew: '#f0fff0',
	hotpink: '#ff69b4',
	indianred: '#cd5c5c',
	indigo: '#4b0082',
	ivory: '#fffff0',
	khaki: '#f0e68c',
	lavender: '#e6e6fa',
	lavenderblush: '#fff0f5',
	lawngreen: '#7cfc00',
	lemonchiffon: '#fffacd',
	lightblue: '#add8e6',
	lightcoral: '#f08080',
	lightcyan: '#e0ffff',
	lightgoldenrodyellow: '#fafad2',
	lightgray: '#d3d3d3',
	lightgreen: '#90ee90',
	lightgrey: '#d3d3d3',
	lightpink: '#ffb6c1',
	lightsalmon: '#ffa07a',
	lightseagreen: '#20b2aa',
	lightskyblue: '#87cefa',
	lightslategray: '#789',
	lightslategrey: '#789',
	lightsteelblue: '#b0c4de',
	lightyellow: '#ffffe0',
	lime: '#0f0',
	limegreen: '#32cd32',
	linen: '#faf0e6',
	magenta: '#f0f',
	maroon: '#800000',
	mediumaquamarine: '#66cdaa',
	mediumblue: '#0000cd',
	mediumorchid: '#ba55d3',
	mediumpurple: '#9370db',
	mediumseagreen: '#3cb371',
	mediumslateblue: '#7b68ee',
	mediumspringgreen: '#00fa9a',
	mediumturquoise: '#48d1cc',
	mediumvioletred: '#c71585',
	midnightblue: '#191970',
	mintcream: '#f5fffa',
	mistyrose: '#ffe4e1',
	moccasin: '#ffe4b5',
	navajowhite: '#ffdead',
	navy: '#000080',
	oldlace: '#fdf5e6',
	olive: '#808000',
	olivedrab: '#6b8e23',
	orange: '#ffa500',
	orangered: '#ff4500',
	orchid: '#da70d6',
	palegoldenrod: '#eee8aa',
	palegreen: '#98fb98',
	paleturquoise: '#afeeee',
	palevioletred: '#db7093',
	papayawhip: '#ffefd5',
	peachpuff: '#ffdab9',
	peru: '#cd853f',
	pink: '#ffc0cb',
	plum: '#dda0dd',
	powderblue: '#b0e0e6',
	purple: '#800080',
	rebeccapurple: '#639',
	red: '#f00',
	rosybrown: '#bc8f8f',
	royalblue: '#4169e1',
	saddlebrown: '#8b4513',
	salmon: '#fa8072',
	sandybrown: '#f4a460',
	seagreen: '#2e8b57',
	seashell: '#fff5ee',
	sienna: '#a0522d',
	silver: '#c0c0c0',
	skyblue: '#87ceeb',
	slateblue: '#6a5acd',
	slategray: '#708090',
	slategrey: '#708090',
	snow: '#fffafa',
	springgreen: '#00ff7f',
	steelblue: '#4682b4',
	tan: '#d2b48c',
	teal: '#008080',
	thistle: '#d8bfd8',
	tomato: '#ff6347',
	turquoise: '#40e0d0',
	violet: '#ee82ee',
	wheat: '#f5deb3',
	white: '#fff',
	whitesmoke: '#f5f5f5',
	yellow: '#ff0',
	yellowgreen: '#9acd32',
}
