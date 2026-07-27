export type Rgb = { r: number; g: number; b: number }

/** Parses the CSS colour syntaxes a user can type into a setting: hex, rgb()/rgba(), hsl()/hsla(), and names. */
export function parse(input: string): Rgb | null {
	const value = input.trim().toLowerCase()
	const named = NAMED[value]
	if (named) return parse(named)
	if (value.startsWith('#')) return parseHex(value.slice(1))
	const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(value)
	if (!fn) return null
	const parts = fn[2].split(/[\s,/]+/).filter((p) => p !== '')
	if (parts.length < 3) return null
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
