import { assertNever } from '@/lib/type-guards'
import type * as ICU from '@/messages/icu'

// Pseudo-locales: machine-made catalogues that stress layout the way a real translation would, so a layout that only
// fits English shows up in development rather than after a translator delivers.
//
// en-XA swaps every letter for an accented or taller look-alike and pads each message by ~40%, the growth German or
// Finnish copy tends to show. The brackets mark both ends, so a clipped message is visible as a missing `]`.
// ar-XB is the same text under an RTL locale, which is what flips the document direction.
//
// Only literal text is rewritten. Argument names, plural and select keys, and tag names pass through untouched.

export const PSEUDO_LOCALES = ['en-XA', 'ar-XB'] as const

const ACCENTED: Record<string, string> = {
	a: 'å',
	b: 'ƀ',
	c: 'ç',
	d: 'ð',
	e: 'é',
	f: 'ƒ',
	g: 'ĝ',
	h: 'ĥ',
	i: 'î',
	j: 'ĵ',
	k: 'ķ',
	l: 'ļ',
	m: 'ɱ',
	n: 'ñ',
	o: 'ö',
	p: 'þ',
	q: 'ǫ',
	r: 'ŕ',
	s: 'š',
	t: 'ţ',
	u: 'û',
	v: 'ṽ',
	w: 'ŵ',
	x: 'ẋ',
	y: 'ý',
	z: 'ž',
	A: 'Å',
	B: 'Ɓ',
	C: 'Ç',
	D: 'Ð',
	E: 'É',
	F: 'Ƒ',
	G: 'Ĝ',
	H: 'Ĥ',
	I: 'Î',
	J: 'Ĵ',
	K: 'Ķ',
	L: 'Ļ',
	M: 'Ṁ',
	N: 'Ñ',
	O: 'Ö',
	P: 'Þ',
	Q: 'Ǫ',
	R: 'Ŕ',
	S: 'Š',
	T: 'Ţ',
	U: 'Û',
	V: 'Ṽ',
	W: 'Ŵ',
	X: 'Ẋ',
	Y: 'Ý',
	Z: 'Ž',
}

const EXPANSION = 0.4

function accent(text: string) {
	let out = ''
	for (const ch of text) out += ACCENTED[ch] ?? ch
	return out
}

function letterCount(message: ICU.Message): number {
	let n = 0
	for (const node of message) {
		if (typeof node === 'string') n += node.replace(/\s/g, '').length
		else if (node === 0 || node.length === 1) continue
		else if (node[1] === 'tag') n += letterCount(node[2])
		// a message that is all select or plural still has text to pad, as long as its longest branch
		else n += Math.max(0, ...Object.values(node[2]).map(letterCount))
	}
	return n
}

function accentMessage(message: ICU.Message): ICU.Message {
	return message.map((node): ICU.Node => {
		if (typeof node === 'string') return accent(node)
		if (node === 0 || node.length === 1) return node
		switch (node[1]) {
			case 'tag':
				return [node[0], 'tag', accentMessage(node[2])]
			case 'select':
				return [node[0], 'select', accentBranches(node[2])]
			case 'plural':
			case 'selectordinal':
				return [node[0], node[1], accentBranches(node[2]), node[3]]
			default:
				assertNever(node)
		}
	})
}

function accentBranches(branches: ICU.Branches): ICU.Branches {
	const out: Record<string, ICU.Message> = {}
	for (const [key, branch] of Object.entries(branches)) out[key] = accentMessage(branch)
	return out
}

// Whitespace at either end is kept outside the brackets: messages like " (no winner)" are glued to their neighbours.
export function pseudoEntry(entry: ICU.Entry): ICU.Entry {
	const message: ICU.Message = typeof entry === 'string' ? [entry] : entry
	if (letterCount(message) === 0) return entry
	const padding = '~'.repeat(Math.max(1, Math.round(letterCount(message) * EXPANSION)))
	const first = message[0]
	const last = message[message.length - 1]
	const lead = typeof first === 'string' ? (first.match(/^\s*/)?.[0] ?? '') : ''
	const trail = typeof last === 'string' ? (last.match(/\s*$/)?.[0] ?? '') : ''
	const body = accentMessage(message).map((node, i, all) => {
		if (typeof node !== 'string') return node
		let s = node
		if (i === 0) s = s.slice(lead.length)
		if (i === all.length - 1) s = s.slice(0, s.length - trail.length)
		return s
	})
	const out: ICU.Node[] = [lead + '[', ...body, ` ${padding}]` + trail]
	const merged: ICU.Node[] = []
	for (const node of out) {
		const prev = merged[merged.length - 1]
		if (typeof node === 'string' && typeof prev === 'string') merged[merged.length - 1] = prev + node
		else merged.push(node)
	}
	return merged.length === 1 && typeof merged[0] === 'string' ? merged[0] : merged
}
