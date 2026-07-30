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

// The items whose text is closest to what was typed, best first. Every "did you mean" in the app ranks with this, so
// a suggestion and the list it is drawn from can never disagree about what counts as close.
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
