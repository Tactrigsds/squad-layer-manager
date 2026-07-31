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

// a named variable whose value is itself a template, and so may reference other variables in the same set
export type TemplateVarDef = { name: string; value: string }

// the names a definition's value references, restricted to the set's own names. A malformed value contributes no
// edges: renderTemplate passes it through unrendered, so it can never expand into anything.
function ownRefs(defs: Map<string, string>, name: string): string[] {
	const value = defs.get(name)
	if (value === undefined) return []
	return (templateVars(value) ?? []).map((v) => v.name).filter((n) => defs.has(n))
}

// every reference cycle among the definitions, each listed as the chain of names that closes it (`a`, `b`, `a`).
// A value referencing its own name is a cycle of one. Cycles have to be rejected before resolveTemplateVars sees
// them: it breaks them arbitrarily rather than hanging, which would silently render something nobody configured.
export function templateVarCycles(defs: readonly TemplateVarDef[]): string[][] {
	const byName = new Map(defs.map((d) => [d.name, d.value]))
	const cycles: string[][] = []
	const seenCycle = new Set<string>()
	const onPath = new Set<string>()
	const finished = new Set<string>()
	const path: string[] = []

	const walk = (name: string) => {
		if (finished.has(name)) return
		if (onPath.has(name)) {
			const chain = [...path.slice(path.indexOf(name)), name]
			// one cycle reaches this branch once per node it is entered from, so key it on its member set
			const key = [...chain].sort().join('\0')
			if (!seenCycle.has(key)) {
				seenCycle.add(key)
				cycles.push(chain)
			}
			return
		}
		onPath.add(name)
		path.push(name)
		for (const ref of ownRefs(byName, name)) walk(ref)
		path.pop()
		onPath.delete(name)
		finished.add(name)
	}

	for (const name of byName.keys()) walk(name)
	return cycles
}

// resolves variables whose values reference each other, innermost first, and merges in `base`. `base` supplies the
// values a template gets per render (a duration, a label) and always wins: its values are leaves, never re-rendered,
// which is what stops player-controlled text from smuggling in template syntax of its own.
export function resolveTemplateVars(defs: readonly TemplateVarDef[], base: Record<string, string> = {}): Record<string, string> {
	const byName = new Map(defs.filter((d) => !(d.name in base)).map((d) => [d.name, d.value]))
	const resolved = new Map<string, string>()
	const resolving = new Set<string>()

	const resolve = (name: string): string => {
		const raw = byName.get(name)!
		const done = resolved.get(name)
		if (done !== undefined) return done
		// only reachable for definitions templateVarCycles rejects; leaving the value unexpanded terminates the walk
		if (resolving.has(name)) return raw
		resolving.add(name)
		const vars: Record<string, string> = { ...base }
		for (const ref of ownRefs(byName, name)) vars[ref] = resolve(ref)
		resolving.delete(name)
		const rendered = renderTemplate(raw, vars)
		resolved.set(name, rendered)
		return rendered
	}

	const out: Record<string, string> = {}
	for (const name of byName.keys()) out[name] = resolve(name)
	return { ...out, ...base }
}
