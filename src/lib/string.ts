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

function normalizeForMatch(s: string) {
	return s.replace(/[^\x20-\x7E]|\s/g, '').toLowerCase()
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
