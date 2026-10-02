import StringComparison from 'string-comparison'

export function upperSnakeCaseToPascalCase(str: string): string {
	return str.toLowerCase().replace(/(^|_)(.)/g, (_, __, letter) => letter.toUpperCase())
}

export function snakeCaseToTitleCase(str: string): string {
	return str.toLowerCase().replace(/(^|_)(.)/g, (_, __, letter) => letter.toUpperCase())
}

export function kebabCaseToTitleCase(str: string): string {
	return str.toLowerCase().replace(/(^|-)(.)/g, (_, __, letter) => letter.toUpperCase())
}

// status code format to title case
// status codes will be in kebab case with sub-statments delimited by colons (:). transform to title case and add spaces on either side of each colon. normalize whitespace
export function statusCodeToTitleCase(str: string): string {
	let result = ''
	const phrases = str.split(':')
	for (let i = 0; i < phrases.length; i++) {
		const phrase = phrases[i]
		const words = phrase.split('-')
		for (let j = 0; j < words.length; j++) {
			const word = words[j]
			result += word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() + ' '
		}
		if (i + 1 < phrases.length) {
			result += ' : '
		}
	}
	return result
}

export function escapeRegex(str: string) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export namespace StrPatterns {
	export const PATH_SEGMENT = /[^/]+/
}

// Folds away only what a human plausibly varies when typing a name to search for: case, spacing, and unicode
// composition. Deliberately keeps non-ascii: a fully non-latin name would otherwise strip to the empty string,
// which is contained in every name and so matches everything.
export function normalizeForMatch(s: string) {
	return s.normalize('NFKC').replace(/\s/g, '').toLowerCase()
}

export function simpleStringMatch(names: string[], target: string) {
	const normalizedTarget = normalizeForMatch(target)
	const matched: number[] = []
	for (let i = 0; i < names.length; i++) {
		if (normalizeForMatch(names[i]).includes(normalizedTarget)) {
			matched.push(i)
		}
	}
	return matched
}

// How close a typed token is to one candidate. Scored against the candidate's words as well as the whole of it, so
// a clan tag or a suffix ("[7CAV] Alice_G") doesn't drown out the part the caller was aiming at. Levenshtein rather
// than the dice coefficient, which is degenerate on the shortest inputs: a two-character token holds one bigram, so
// "tq" and "tk" share none and score 0, and reason keywords are routinely that short.
//
// `whole` is kept alongside the best score to break ties, since matching on a word says less than being the word:
// "gorodokk" matches Gorodok and Gorodok_AAS_v1 equally well, and meant the map.
function similarity(typed: string, candidate: string): { best: number; whole: number } {
	const target = normalizeForMatch(typed)
	if (target === '') return { best: 0, whole: 0 }
	const whole = StringComparison.levenshtein.similarity(target, normalizeForMatch(candidate))
	const parts = candidate
		.split(/[^\p{L}\p{N}]+/u)
		.map(normalizeForMatch)
		.filter((p) => p !== '')
	return { best: Math.max(0, whole, ...parts.map((p) => StringComparison.levenshtein.similarity(target, p))), whole }
}

// Only there to keep a token that resembles nothing from being answered with a guess. Set low, because the two costs
// are not symmetric wherever these are offered back as a numbered list: a wrong one is a line the caller reads past,
// while a bar set high costs them the whole offer. A shortening scores its length over the candidate's, which puts
// "mod" for "moderation" at 0.3 -- anything stricter answers it with nothing at all.
const MIN_SIMILARITY = 0.25

// The items whose text is closest to what was typed, best first. Every "did you mean" for a name the user types to
// search for ranks with this, so a suggestion and the list it is drawn from can never disagree about what counts as
// close. Mistyped identifiers use `nearestWithinEdits` instead.
export function nearestBy<T>(typed: string, items: readonly T[], text: (item: T) => string, limit: number): T[] {
	return items
		.map((item) => ({ item, score: similarity(typed, text(item)) }))
		.filter((scored) => scored.score.best >= MIN_SIMILARITY)
		.toSorted((a, b) => b.score.best - a.score.best || b.score.whole - a.score.whole)
		.slice(0, limit)
		.map((scored) => scored.item)
}

export function nearest(typed: string, candidates: readonly string[], limit: number): string[] {
	return nearestBy(typed, candidates, (candidate) => candidate, limit)
}

// The one candidate a mistyped identifier most likely meant: the fewest case-insensitive edits away, within
// `maxEdits`, earliest on a tie. A swap of two adjacent characters counts as one edit. For catalogs of identifiers
// (layer, faction and unit names) too large to rank with `nearest` on every keystroke: it abandons a candidate as soon
// as it cannot come within `maxEdits`.
export function nearestWithinEdits(typed: string, candidates: readonly string[], maxEdits: number): string | null {
	const target = typed.toLowerCase()
	let best: string | null = null
	let bestEdits = maxEdits + 1
	for (const candidate of candidates) {
		const edits = boundedEditDistance(target, candidate.toLowerCase(), bestEdits - 1)
		if (edits < bestEdits) {
			best = candidate
			bestEdits = edits
			if (edits === 0) break
		}
	}
	return best
}

let editRows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)]

// Optimal string alignment distance, or max + 1 once every path through the current row already exceeds max
function boundedEditDistance(a: string, b: string, max: number): number {
	if (max < 0 || Math.abs(a.length - b.length) > max) return max + 1
	if (editRows[0].length <= b.length) editRows = [0, 1, 2].map(() => new Int32Array(b.length * 2))
	let [prevPrev, prev, curr] = editRows
	for (let j = 0; j <= b.length; j++) prev[j] = j
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i
		let rowMin = i
		const ac = a.charCodeAt(i - 1)
		for (let j = 1; j <= b.length; j++) {
			const bc = b.charCodeAt(j - 1)
			let value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (ac === bc ? 0 : 1))
			if (i > 1 && j > 1 && ac === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bc) value = Math.min(value, prevPrev[j - 2] + 1)
			curr[j] = value
			if (value < rowMin) rowMin = value
		}
		if (rowMin > max) return max + 1
		;[prevPrev, prev, curr] = [prev, curr, prevPrev]
	}
	return Math.min(prev[b.length], max + 1)
}

export function simpleUniqueStringMatch(names: string[], target: string) {
	const normalizedTarget = normalizeForMatch(target)
	const matched: number[] = []
	for (let i = 0; i < names.length; i++) {
		if (normalizeForMatch(names[i]).includes(normalizedTarget)) {
			matched.push(i)
		}
	}

	if (matched.length === 0) {
		return { code: 'err:not-found' as const }
	} else if (matched.length > 1) {
		return { code: 'err:multiple-matches' as const, count: matched.length }
	} else {
		return { code: 'ok' as const, matched: matched[0] }
	}
}
