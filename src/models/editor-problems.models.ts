// A problem a text editor found in its text: what is wrong, and the span of the text it is about. `line` and `column`
// count from 1 and describe `from`.
export type Problem = { from: number; to: number; line: number; column: number; message: string }

// The span is cut at the end of the line it starts on, so a problem about a whole collection underlines the line that
// opens it rather than everything inside it.
export function at(text: string, from: number, to: number, message: string): Problem {
	const start = Math.max(0, Math.min(from, text.length))
	const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1
	const lineEnd = endOfLine(text, start)
	let line = 1
	for (let i = text.indexOf('\n'); i !== -1 && i < start; i = text.indexOf('\n', i + 1)) line++
	return { from: start, to: Math.max(start, Math.min(to, lineEnd)), line, column: start - lineStart + 1, message }
}

// a problem about all of line `line` (counting from 1)
export function onLine(text: string, line: number, message: string): Problem {
	let start = 0
	for (let n = 1; n < line; n++) {
		const next = text.indexOf('\n', start)
		if (next === -1) break
		start = next + 1
	}
	return at(text, start, endOfLine(text, start), message)
}

function endOfLine(text: string, from: number) {
	const end = text.indexOf('\n', from)
	return end === -1 ? text.length : end
}

export function byPosition(a: Problem, b: Problem) {
	return a.from - b.from
}
