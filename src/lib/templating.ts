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
