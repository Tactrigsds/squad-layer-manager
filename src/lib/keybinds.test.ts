import { describe, expect, it } from 'vitest'

import * as KB from '@/lib/keybinds'

const SCOPES = {
	app: {},
	page: { parents: ['app'] },
	dialog: { parents: 'any', isolated: true },
	'special-dialog': { extends: 'dialog' },
	editor: { parents: ['page', 'dialog'] },
	field: { parents: 'any', leaf: true },
} as const

const clashes = (table: KB.AnyTable) => KB.check(table).clashes.map((c) => [c.platform, c.outer, c.inner, c.reason])

describe('checking a keybinding table', () => {
	it('passes bindings that share keys in scopes a key cannot reach both of', () => {
		const table = KB.define({
			scopes: SCOPES,
			bindings: { a: { scopes: ['page'], keys: ['Mod+K'] }, b: { scopes: ['dialog'], keys: ['Mod+K'] } },
		})
		expect(KB.check(table)).toEqual({ clashes: [], staleShadows: [], layout: [] })
	})

	it('refuses two bindings of the same keys in one scope', () => {
		const table = KB.define({
			scopes: SCOPES,
			bindings: { a: { scopes: ['page'], keys: ['Mod+K'] }, b: { scopes: ['page'], keys: ['Ctrl+K', 'Mod+J'] } },
		})
		// Ctrl+K is Mod+K everywhere but a mac
		expect(clashes(table)).toEqual([['other', 'a', 'b', 'same-scope']])
	})

	it('refuses an inner binding that takes outer keys without saying so, however deep it sits', () => {
		const table = KB.define({
			scopes: SCOPES,
			bindings: { outer: { scopes: ['app'], keys: ['Mod+Z'] }, inner: { scopes: ['editor'], keys: ['Mod+Z'] } },
		})
		expect(clashes(table)).toEqual([
			['mac', 'outer', 'inner', 'unshadowed'],
			['other', 'outer', 'inner', 'unshadowed'],
		])
		expect(() => KB.assertValid(table)).toThrow(/add "outer" to its shadows/)
	})

	it('accepts the shadow once it is declared, and refuses one that settles nothing', () => {
		const table = KB.define({
			scopes: SCOPES,
			bindings: {
				outer: { scopes: ['app'], keys: ['Mod+Z'] },
				inner: { scopes: ['editor'], keys: ['Mod+Z'], shadows: ['outer'] },
				unrelated: { scopes: ['page'], keys: ['Mod+Y'], shadows: ['outer'] },
			},
		})
		expect(KB.check(table)).toEqual({ clashes: [], staleShadows: [{ binding: 'unrelated', shadows: 'outer' }], layout: [] })
	})

	it('keeps keys pressed inside an isolated scope from the scopes around it', () => {
		const table = KB.define({
			scopes: SCOPES,
			bindings: { outer: { scopes: ['app'], keys: ['Mod+Z'] }, inner: { scopes: ['dialog'], keys: ['Mod+Z'] } },
		})
		expect(clashes(table)).toEqual([])
	})

	it("checks a specialized type's own bindings against those it inherits, as one scope", () => {
		const table = KB.define({
			scopes: SCOPES,
			bindings: {
				submit: { scopes: ['dialog'], keys: ['Mod+Enter'] },
				special: { scopes: ['special-dialog'], keys: ['Mod+Enter'] },
			},
		})
		expect(clashes(table)).toEqual([
			['mac', 'submit', 'special', 'same-scope'],
			['other', 'submit', 'special', 'same-scope'],
		])
		const shadowed = KB.define({
			scopes: SCOPES,
			bindings: {
				submit: { scopes: ['dialog'], keys: ['Mod+Enter'] },
				special: { scopes: ['special-dialog'], keys: ['Mod+Enter'], shadows: ['submit'] },
			},
		})
		expect(KB.check(shadowed)).toEqual({ clashes: [], staleShadows: [], layout: [] })
	})

	it('lets one binding answer in nested scopes, and a dialog sit within a dialog', () => {
		const table = KB.define({
			scopes: SCOPES,
			bindings: { submit: { scopes: ['page', 'dialog', 'editor'], keys: ['Mod+Enter'] } },
		})
		expect(KB.check(table)).toEqual({ clashes: [], staleShadows: [], layout: [] })
		expect(KB.canSitWithin(table, 'dialog', 'dialog')).toBe(true)
		expect(KB.canSitWithin(table, 'special-dialog', 'editor')).toBe(true)
	})

	it('holds nothing within a leaf, and places a leaf anywhere', () => {
		const table = KB.define({ scopes: SCOPES, bindings: {} })
		expect(KB.canSitWithin(table, 'editor', 'field')).toBe(false)
		expect(KB.canSitWithin(table, 'field', 'editor')).toBe(true)
	})

	it('checks a platform-only chord on that platform alone', () => {
		const table = KB.define({
			scopes: SCOPES,
			bindings: {
				redo: { scopes: ['editor'], keys: [{ chord: 'Ctrl+Y', platform: 'other' }] },
				other: { scopes: ['page'], keys: [{ chord: 'Ctrl+Y', platform: 'mac' }] },
			},
		})
		expect(clashes(table)).toEqual([])
	})

	it('rejects a shadow naming a binding the table does not have, and a scope it does not have', () => {
		KB.define({
			scopes: SCOPES,
			// @ts-expect-error -- `nope` is not a binding
			bindings: { a: { scopes: ['page'], keys: ['Mod+K'], shadows: ['nope'] } },
		})
		KB.define({
			scopes: SCOPES,
			// @ts-expect-error -- `nowhere` is not a scope
			bindings: { a: { scopes: ['nowhere'], keys: ['Mod+K'] } },
		})
	})
})

describe('matching an event', () => {
	const event = (key: string, mods: Partial<KB.KeyEventLike> = {}): KB.KeyEventLike => ({
		key,
		code: '',
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		...mods,
	})

	it('reads Mod as cmd on a mac and ctrl elsewhere, and wants the modifiers exactly', () => {
		const undo = KB.parseChord('Mod+Z')
		expect(KB.matchesChord(event('z', { metaKey: true }), undo, 'mac')).toBe(true)
		expect(KB.matchesChord(event('z', { ctrlKey: true }), undo, 'mac')).toBe(false)
		expect(KB.matchesChord(event('Z', { ctrlKey: true }), undo, 'other')).toBe(true)
		expect(KB.matchesChord(event('Z', { ctrlKey: true, shiftKey: true }), undo, 'other')).toBe(false)
	})

	it('finds a letter by its physical key when option has changed the character it types', () => {
		expect(KB.matchesChord(event('ç', { code: 'KeyC', metaKey: true, altKey: true }), KB.parseChord('Mod+Alt+C'), 'mac')).toBe(true)
	})

	it('labels a chord for each platform', () => {
		const redo = KB.parseChord('Mod+Shift+Z')
		expect(KB.chordLabel(redo, 'mac')).toBe('⇧⌘Z')
		expect(KB.chordLabel(redo, 'other')).toBe('Ctrl+Shift+Z')
		expect(KB.chordAria(redo, 'mac')).toBe('Meta+Shift+Z')
		expect(KB.chordAria(KB.parseChord('Mod+Enter'), 'other')).toBe('Control+Enter')
	})
})
