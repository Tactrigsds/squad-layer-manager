// The compiled form of an ICU message, and the walker that renders one.
//
// A pattern's structure is resolved by the extractor (src/scripts/compile-messages.ts) and shipped as JSON, so no
// pattern is parsed at runtime. That is the point: a parsed formatjs AST retains ~500 bytes per message and its
// IntlMessageFormat wrapper another ~500, against ~34 bytes of pattern text. This form is arrays and strings.
//
// Import leaf, like the vocabulary it serves. Tag renderers arrive through `values`, so nothing here knows about
// React.

// A literal carries text with ICU quoting already applied, so `''` and `'{...}'` never reach a reader. `0` is the
// `#` inside a plural, standing for that plural's own number.
export type Node =
	| string
	| 0
	| readonly [name: string]
	| readonly [name: string, kind: 'plural' | 'selectordinal', branches: Branches, offset: number]
	| readonly [name: string, kind: 'select', branches: Branches]
	| readonly [name: string, kind: 'tag', children: Message]

export type Branches = { readonly [key: string]: Message }
export type Message = readonly Node[]

// What a catalogue holds per key. A message with no arguments compiles to its own text, which is both the smallest
// entry and the fastest to resolve: 1,312 of the app's 1,694 messages take that shape.
export type Entry = string | Message

export type Values = Record<string, unknown>
export type TagRenderer = (chunks: unknown[]) => unknown

export class MissingValueError extends Error {
	constructor(readonly name: string) {
		super(`no value was provided for "${name}"`)
	}
}

const numberFormats = new Map<string, Intl.NumberFormat>()
const pluralRules = new Map<string, Intl.PluralRules>()

function numberFormat(locale: string) {
	let f = numberFormats.get(locale)
	if (!f) numberFormats.set(locale, (f = new Intl.NumberFormat(locale)))
	return f
}

function plurals(locale: string, type: Intl.PluralRuleType) {
	const cacheKey = `${locale} ${type}`
	let r = pluralRules.get(cacheKey)
	if (!r) pluralRules.set(cacheKey, (r = new Intl.PluralRules(locale, { type })))
	return r
}

// Adjacent text merges into one part, so a renderer sees one part per contiguous run rather than keying a sentence
// into a dozen fragments.
function push(out: unknown[], part: unknown) {
	const last = out[out.length - 1]
	if (typeof part === 'string' && typeof last === 'string') out[out.length - 1] = last + part
	else out.push(part)
}

function walk(message: Message, values: Values, locale: string, pluralValue: number | undefined, out: unknown[]) {
	for (const node of message) {
		if (typeof node === 'string') {
			push(out, node)
			continue
		}
		if (node === 0) {
			if (pluralValue !== undefined) push(out, numberFormat(locale).format(pluralValue))
			continue
		}
		const name = node[0]
		if (!(name in values)) throw new MissingValueError(name)
		const value = values[name]

		if (node.length === 1) {
			// a bare argument renders as text, except for a node the display layer passed in, which travels whole
			push(out, typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' ? String(value) : value || '')
			continue
		}
		if (node[1] === 'tag') {
			const chunks: unknown[] = []
			walk(node[2], values, locale, pluralValue, chunks)
			const rendered = (value as TagRenderer)(chunks)
			if (Array.isArray(rendered)) for (const part of rendered) push(out, part)
			else push(out, rendered)
			continue
		}
		if (node[1] === 'select') {
			walk(node[2][String(value)] ?? node[2].other, values, locale, pluralValue, out)
			continue
		}
		// an exact `=N` branch wins over the locale's plural category, and the offset shifts both that lookup and
		// the number `#` renders
		const numeric = typeof value === 'bigint' ? Number(value) : (value as number)
		const shifted = numeric - node[3]
		const branch =
			node[2][`=${numeric}`] ??
			node[2][plurals(locale, node[1] === 'selectordinal' ? 'ordinal' : 'cardinal').select(shifted)] ??
			node[2].other
		walk(branch, values, locale, shifted, out)
	}
}

// The parts of a rendered message, adjacent text merged. Throws MissingValueError when the message needs an
// argument or a tag renderer the caller did not supply.
export function evaluate(entry: Entry, values: Values, locale: string): unknown[] {
	if (typeof entry === 'string') return [entry]
	const out: unknown[] = []
	walk(entry, values, locale, undefined, out)
	return out
}
