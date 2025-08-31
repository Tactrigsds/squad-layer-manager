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
