// Declared keyboard bindings, and the check that no two of them answer the same keys where a key could reach both.
//
// A scope type is a kind of region a key can be pressed in, and names the types it can sit within (`parents`, or
// `'any'` for every type that is not a `leaf`, which holds no other scopes). A key pressed in a scope reaches the bindings of that scope, then of each scope around it, until it leaves
// an `isolated` scope, which keeps keys from passing outward. A type that `extends` another is that type too: it takes
// its parents, isolation and bindings, and adds bindings of its own.
//
// Two bindings clash when they share a key on some platform and a key could reach both: both apply in one scope, or one
// applies in a scope the other's scope can sit within. The one that applies closer to the key may take the other's keys
// only by naming it in `shadows`, and a `shadows` entry that settles no clash is an error too, so a declaration cannot
// outlive the clash it settled. One binding declared in nested scopes never clashes with itself: the innermost answers.
//
// A chord is modifiers and a key joined by `+`, such as `Mod+Shift+Z`. `Mod` is cmd on a mac and ctrl elsewhere, while
// `Ctrl` and `Meta` name the physical key on both. The key is KeyboardEvent.key, matched without case for a letter.

export type Platform = 'mac' | 'other'
export const PLATFORMS: readonly Platform[] = ['mac', 'other']

export type KeySpec = string | { chord: string; platform: Platform }

export type ScopeDef<S extends string> = {
	parents?: readonly S[] | 'any'
	extends?: S
	isolated?: true
	// covers everything beneath it, so a key with nothing focused goes to the topmost open one
	modal?: true
	// joins the keys of a key pressed with nothing focused while the pointer is over it
	hover?: true
	leaf?: true
}

export type BindingDef<S extends string, Id extends string> = {
	scopes: readonly S[]
	keys: readonly KeySpec[]
	shadows?: readonly Id[]
	// answered by the browser or a library. Declared so a binding of ours has to say when it takes the keys away
	native?: true
	// answered by the focused control itself before the key reaches the dispatcher, through KEYS.matches
	local?: true
	// answered by clicking the button the scope marks for the binding, so it needs no handler
	button?: true
	// answers a held key's repeats as well as its first press
	repeat?: true
}

export type AnyTable = {
	scopes: Record<string, ScopeDef<string>>
	bindings: Record<string, BindingDef<string, string>>
}

// keeps the scope names and the ids `shadows` names checked against the table's own, and the table's literal types
// for the registration types built from it
export function define<
	const Sc extends Record<string, ScopeDef<string>>,
	const B extends Record<string, BindingDef<string, string>>,
>(table: {
	scopes: Sc & { [K in keyof Sc]: ScopeDef<Extract<keyof Sc, string>> }
	bindings: B & { [K in keyof B]: BindingDef<Extract<keyof Sc, string>, Extract<keyof B, string>> }
}): { scopes: Sc; bindings: B } {
	return table
}

// -------- chords --------

export type Chord = { mod: boolean; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean; key: string }

const MODIFIERS = new Set(['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'])

export function parseChord(text: string): Chord {
	// a trailing `+` is the plus key itself
	const plusKey = text.endsWith('++') || text === '+'
	const parts = (plusKey ? text.slice(0, -1) : text).split('+').filter((part, i, all) => part !== '' || i < all.length - 1)
	const key = plusKey ? '+' : parts.pop()
	if (!key) throw new Error(`chord "${text}" has no key`)
	const chord: Chord = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: key.length === 1 ? key.toLowerCase() : key }
	for (const part of parts) {
		if (!MODIFIERS.has(part)) throw new Error(`chord "${text}" has an unknown modifier "${part}"`)
		const field = part.toLowerCase() as 'mod' | 'ctrl' | 'meta' | 'alt' | 'shift'
		if (chord[field]) throw new Error(`chord "${text}" repeats "${part}"`)
		chord[field] = true
	}
	return chord
}

export function chordsFor(def: { keys: readonly KeySpec[] }, platform: Platform): Chord[] {
	const chords: Chord[] = []
	for (const spec of def.keys) {
		if (typeof spec === 'string') chords.push(parseChord(spec))
		else if (spec.platform === platform) chords.push(parseChord(spec.chord))
	}
	return chords
}

function physical(chord: Chord, platform: Platform) {
	return {
		ctrl: chord.ctrl || (platform === 'other' && chord.mod),
		meta: chord.meta || (platform === 'mac' && chord.mod),
	}
}

// the physical keys a chord presses on a platform, so `Mod+Z` on a mac and `Meta+Z` compare equal
export function canonical(chord: Chord, platform: Platform): string {
	const { ctrl, meta } = physical(chord, platform)
	return [ctrl && 'Ctrl', meta && 'Meta', chord.alt && 'Alt', chord.shift && 'Shift', chord.key].filter(Boolean).join('+')
}

export type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

// the canonical spelling of the keys an event pressed, for looking bindings up by. An alt+letter is spelled by its
// physical key: option+letter on a mac types another character
export function eventKeys(e: KeyEventLike): string {
	const letter = e.altKey && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : null
	const key = letter ?? (e.key.length === 1 ? e.key.toLowerCase() : e.key)
	return [e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+')
}

export function matchesChord(e: KeyEventLike, chord: Chord, platform: Platform): boolean {
	return eventKeys(e) === canonical(chord, platform)
}

const MAC_SYMBOLS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘', Enter: '↵' }

// how the chord reads on a button: `⇧⌘Z` on a mac, `Ctrl+Shift+Z` elsewhere
export function chordLabel(chord: Chord, platform: Platform): string {
	const { ctrl, meta } = physical(chord, platform)
	const key = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key
	if (platform === 'mac') {
		const mods = [ctrl && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', meta && 'Meta'].filter(Boolean) as string[]
		return [...mods, key].map((part) => MAC_SYMBOLS[part] ?? part).join('')
	}
	const glyph = key === 'Enter' ? MAC_SYMBOLS.Enter : key
	return [ctrl && 'Ctrl', meta && 'Meta', chord.alt && 'Alt', chord.shift && 'Shift', glyph].filter(Boolean).join('+')
}

// the aria-keyshortcuts spelling of one chord
export function chordAria(chord: Chord, platform: Platform): string {
	return canonical(chord, platform)
		.replace('Ctrl', 'Control')
		.replace(/\+([a-z])$/, (_, letter: string) => `+${letter.toUpperCase()}`)
}

// -------- scope layout --------

export function lineage(table: AnyTable, scope: string): string[] {
	const result: string[] = []
	for (let s: string | undefined = scope; s !== undefined; s = table.scopes[s].extends) {
		if (result.includes(s)) throw new Error(`scope ${scope} extends itself`)
		result.push(s)
	}
	return result
}

function inherited<K extends 'parents' | 'isolated' | 'modal' | 'hover' | 'leaf'>(
	table: AnyTable,
	scope: string,
	key: K,
): ScopeDef<string>[K] {
	for (const s of lineage(table, scope)) {
		if (table.scopes[s][key] !== undefined) return table.scopes[s][key]
	}
	return undefined
}

export function parentsOf(table: AnyTable, scope: string): readonly string[] {
	const parents = inherited(table, scope, 'parents') ?? []
	return parents === 'any' ? Object.keys(table.scopes).filter((s) => !inherited(table, s, 'leaf')) : parents
}

export function isIsolated(table: AnyTable, scope: string) {
	return !!inherited(table, scope, 'isolated')
}

export function isModal(table: AnyTable, scope: string) {
	return !!inherited(table, scope, 'modal')
}

export function isHover(table: AnyTable, scope: string) {
	return !!inherited(table, scope, 'hover')
}

// whether `scope` is `type`, or a type extending it
export function isA(table: AnyTable, scope: string, type: string) {
	return lineage(table, scope).includes(type)
}

export function canSitWithin(table: AnyTable, scope: string, parent: string) {
	return parentsOf(table, scope).some((p) => isA(table, parent, p))
}

// the bindings that apply in a scope of this type, each with how far up the type's lineage it was declared
function applying(table: AnyTable, scope: string): Map<string, number> {
	const line = lineage(table, scope)
	const result = new Map<string, number>()
	for (const [id, def] of Object.entries(table.bindings)) {
		const depth = Math.min(...def.scopes.map((s) => line.indexOf(s)).filter((i) => i !== -1))
		if (Number.isFinite(depth)) result.set(id, depth)
	}
	return result
}

// every scope type a key pressed in `scope` can climb to, stopping at isolated scopes
function reach(table: AnyTable, scope: string): Set<string> {
	const result = new Set<string>()
	const visited = new Set<string>([scope])
	const stack = [scope]
	while (stack.length > 0) {
		const s = stack.pop()!
		if (isIsolated(table, s)) continue
		for (const parent of parentsOf(table, s)) {
			// a parent named by a type stands for every type extending it
			for (const candidate of Object.keys(table.scopes)) {
				if (!isA(table, candidate, parent) || inherited(table, candidate, 'leaf') || visited.has(candidate)) continue
				visited.add(candidate)
				result.add(candidate)
				stack.push(candidate)
			}
		}
	}
	return result
}

// -------- checking --------

export type Clash = { platform: Platform; keys: string; scope: string; outer: string; inner: string; reason: 'unshadowed' | 'same-scope' }
export type StaleShadow = { binding: string; shadows: string }
export type LayoutError = { scope: string; error: string }

export function check(table: AnyTable): { clashes: Clash[]; staleShadows: StaleShadow[]; layout: LayoutError[] } {
	const layout: LayoutError[] = []
	for (const [scope, def] of Object.entries(table.scopes)) {
		for (const name of [...(def.parents === 'any' ? [] : (def.parents ?? [])), ...(def.extends ? [def.extends] : [])]) {
			if (!(name in table.scopes)) layout.push({ scope, error: `names unknown scope ${name}` })
		}
	}
	for (const [id, def] of Object.entries(table.bindings)) {
		for (const scope of def.scopes) if (!(scope in table.scopes)) layout.push({ scope: id, error: `binds in unknown scope ${scope}` })
	}
	if (layout.length > 0) return { clashes: [], staleShadows: [], layout }

	const clashes: Clash[] = []
	const seen = new Set<string>()
	const usedShadows = new Set<string>()
	const shadows = (inner: string, outer: string) => table.bindings[inner].shadows?.includes(outer) ?? false
	const report = (clash: Clash) => {
		const key = `${clash.platform} ${clash.keys} ${clash.outer} ${clash.inner}`
		if (seen.has(key)) return
		seen.add(key)
		clashes.push(clash)
	}

	const applyingByScope = new Map(Object.keys(table.scopes).map((s) => [s, applying(table, s)]))
	const reachByScope = new Map(Object.keys(table.scopes).map((s) => [s, reach(table, s)]))

	for (const platform of PLATFORMS) {
		const keysOf = new Map(
			Object.entries(table.bindings).map(([id, def]) => [id, new Set(chordsFor(def, platform).map((c) => canonical(c, platform)))]),
		)
		const shared = (a: string, b: string) => [...keysOf.get(a)!].filter((k) => keysOf.get(b)!.has(k))

		for (const [scope, here] of applyingByScope) {
			const ids = [...here.keys()]
			// two bindings that both apply in this scope: the one declared on the more specific type may shadow the other
			for (let i = 0; i < ids.length; i++) {
				for (let j = i + 1; j < ids.length; j++) {
					for (const keys of shared(ids[i], ids[j])) {
						const [inner, outer] = here.get(ids[i])! < here.get(ids[j])! ? [ids[i], ids[j]] : [ids[j], ids[i]]
						if (here.get(inner)! < here.get(outer)! && shadows(inner, outer)) usedShadows.add(`${inner} ${outer}`)
						else report({ platform, keys, scope, outer, inner, reason: 'same-scope' })
					}
				}
			}
			// a binding here against one in a scope around it
			for (const outerScope of reachByScope.get(scope)!) {
				for (const outer of applyingByScope.get(outerScope)!.keys()) {
					if (here.has(outer)) continue
					for (const inner of ids) {
						for (const keys of shared(inner, outer)) {
							if (shadows(inner, outer)) usedShadows.add(`${inner} ${outer}`)
							else report({ platform, keys, scope, outer, inner, reason: 'unshadowed' })
						}
					}
				}
			}
		}
	}

	const staleShadows: StaleShadow[] = []
	for (const [id, def] of Object.entries(table.bindings)) {
		for (const shadowed of def.shadows ?? []) {
			if (!usedShadows.has(`${id} ${shadowed}`)) staleShadows.push({ binding: id, shadows: shadowed })
		}
	}
	return { clashes, staleShadows, layout }
}

export function assertValid(table: AnyTable) {
	const { clashes, staleShadows, layout } = check(table)
	if (clashes.length === 0 && staleShadows.length === 0 && layout.length === 0) return
	const lines = [
		...layout.map((l) => `${l.scope} ${l.error}`),
		...clashes.map((c) =>
			c.reason === 'same-scope'
				? `${c.outer} and ${c.inner} both bind ${c.keys} (${c.platform}) in ${c.scope}`
				: `${c.inner} binds ${c.keys} (${c.platform}) in ${c.scope}, inside ${c.outer}'s scope: add "${c.outer}" to its shadows, or pick other keys`,
		),
		...staleShadows.map((s) => `${s.binding} shadows ${s.shadows}, but no key reaches both`),
	]
	throw new Error(`keybinding table:\n${lines.join('\n')}`)
}
