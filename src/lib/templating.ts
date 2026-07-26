import Mustache from 'mustache'

// in-game messages are plain text, not HTML; disable mustache's default &<> escaping
Mustache.escape = (t) => String(t)

// renders a {{var}} template against the given variables. Unknown variables render empty; a malformed
// template falls back to the raw string so a bad template can never break message delivery.
export function renderTemplate(template: string, vars: Record<string, string>): string {
	try {
		return Mustache.render(template, vars)
	} catch {
		return template
	}
}

// `inverted` marks a variable used as an inverted section somewhere ({{^x}}fallback{{/x}}), the idiom for giving one
// a default
export type TemplateVar = { name: string; inverted: boolean }

// every variable a template references, interpolations and section names alike, in source order and deduplicated.
// `undefined` means the template is malformed (an unclosed section), which renderTemplate would silently pass through
// unrendered -- callers that validate a template need to tell that apart from one that references nothing.
export function templateVars(template: string): TemplateVar[] | undefined {
	const vars: TemplateVar[] = []
	const walk = (tokens: unknown[][]) => {
		for (const token of tokens) {
			const [type, value, , , subTokens] = token as [string, string, number, number, unknown[][]?]
			if (type === 'name' || type === '&' || type === '{' || type === '#' || type === '^') {
				const existing = vars.find((v) => v.name === value)
				if (existing) existing.inverted ||= type === '^'
				else vars.push({ name: value, inverted: type === '^' })
			}
			if (Array.isArray(subTokens)) walk(subTokens)
		}
	}
	try {
		walk(Mustache.parse(template) as unknown[][])
	} catch {
		return undefined
	}
	return vars
}
