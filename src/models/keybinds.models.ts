// Every keyboard shortcut SLM binds, the scope types they bind in, and the browser's and libraries' own shortcuts that
// SLM's could collide with. src/lib/keybinds.ts describes how scopes nest and when two bindings clash, and
// src/systems/keybinds.client.ts dispatches keys to the handlers scopes register. A test checks this table for both
// platforms, and a development build checks it again on startup.
//
// A key a focused control handles for itself, such as Enter in an input or an arrow key in a list, is not a binding
// here: it only reaches that control. The documentation site binds `/` and Mod+K in its own bundle, which shares
// nothing with the app's pages. Escape is not declared yet: docs/developers/architecture.md, "Keyboard shortcuts", says
// why.
import * as KB from '@/lib/keybinds'

const SUBMIT_KEYS: KB.KeySpec[] = ['Mod+Enter', { chord: 'Ctrl+Enter', platform: 'mac' }]

export const TABLE = KB.define({
	scopes: {
		app: {},
		page: { parents: ['app'] },
		dialog: { parents: 'any', isolated: true, modal: true },
		// a draggable window keeps its keys to itself, but floats beside the page rather than covering it
		window: { parents: 'any', isolated: true },
		popover: { parents: 'any' },
		'combo-box': { extends: 'popover', leaf: true },
		'queue-editor': { parents: ['app', 'page'] },
		'rotation-editor': { parents: ['app', 'page'] },
		'filter-editor': { parents: ['app', 'page', 'dialog', 'window', 'popover'] },
		// a region searched by its own find bar
		'find-region': { parents: ['app', 'page', 'dialog', 'window'], hover: true },
		// the activity feed's rows, while some are selected
		feed: { parents: ['app', 'page', 'window', 'find-region'] },
		// the dispatcher opens these two around a key typed into a text field or a CodeMirror editor
		'text-field': { parents: 'any', leaf: true },
		'code-editor': { parents: 'any', leaf: true },
	},
	bindings: {
		// -------- the browser's --------
		'browser-find': { scopes: ['app'], keys: ['Mod+F'], native: true },
		'browser-copy': { scopes: ['app'], keys: ['Mod+C'], native: true },
		'browser-select-all': { scopes: ['app'], keys: ['Mod+A'], native: true },
		'browser-print': { scopes: ['app'], keys: ['Mod+P'], native: true },
		'browser-save-page': { scopes: ['app'], keys: ['Mod+S'], native: true },
		'browser-reload': { scopes: ['app'], keys: ['Mod+R'], native: true },
		'browser-address-bar': { scopes: ['app'], keys: ['Mod+L'], native: true },
		'browser-new-tab': { scopes: ['app'], keys: ['Mod+T'], native: true },
		'browser-close-tab': { scopes: ['app'], keys: ['Mod+W'], native: true },
		'browser-new-window': { scopes: ['app'], keys: ['Mod+N'], native: true },
		'browser-bookmark': { scopes: ['app'], keys: ['Mod+D'], native: true },

		// a text field's own editing, which it keeps from every binding around it
		'text-undo': { scopes: ['text-field'], keys: ['Mod+Z'], native: true, shadows: ['undo'] },
		'text-redo': {
			scopes: ['text-field'],
			keys: [{ chord: 'Ctrl+Y', platform: 'other' }, 'Mod+Shift+Z'],
			native: true,
			shadows: ['redo'],
		},
		'text-copy': { scopes: ['text-field'], keys: ['Mod+C'], native: true, shadows: ['browser-copy', 'copy-rows'] },
		'text-select-all': { scopes: ['text-field'], keys: ['Mod+A'], native: true, shadows: ['browser-select-all'] },

		// -------- libraries' --------
		// sonner moves focus to the toasts
		'toasts-focus': { scopes: ['app'], keys: ['Alt+T'], native: true },
		// CodeMirror's keymap (basicSetup), where it overlaps keys bound around an editor. keybinds.models.test.ts builds
		// the keymap the editors run and fails on any of its keys that overlaps one bound around an editor undeclared
		'code-insert-line': {
			scopes: ['code-editor'],
			keys: SUBMIT_KEYS,
			native: true,
			shadows: ['submit'],
		},
		'code-undo': { scopes: ['code-editor'], keys: ['Mod+Z'], native: true, shadows: ['undo'] },
		'code-redo': {
			scopes: ['code-editor'],
			keys: [
				{ chord: 'Ctrl+Y', platform: 'other' },
				{ chord: 'Ctrl+Shift+Z', platform: 'other' },
				{ chord: 'Meta+Shift+Z', platform: 'mac' },
			],
			native: true,
			shadows: ['redo'],
		},
		'code-search': { scopes: ['code-editor'], keys: ['Mod+F'], native: true, shadows: ['browser-find', 'find-in-region'] },
		'code-select-all': { scopes: ['code-editor'], keys: ['Mod+A'], native: true, shadows: ['browser-select-all'] },
		'code-select-next': { scopes: ['code-editor'], keys: ['Mod+D'], native: true, shadows: ['browser-bookmark'] },

		// -------- SLM's --------
		// clicks the scope's submit button. A dialog or window with none keeps the key, a popover passes it to its opener
		submit: { scopes: ['page', 'dialog', 'window', 'popover'], keys: SUBMIT_KEYS, button: true },
		// a multi-select combo box toggles its highlighted option and commits the selection, instead of submitting what
		// holds the box. cmdk would take the key first, so the box answers it in its own keydown
		'combo-box-commit': { scopes: ['combo-box'], keys: SUBMIT_KEYS, local: true, shadows: ['submit'] },
		undo: { scopes: ['queue-editor', 'rotation-editor', 'filter-editor'], keys: ['Mod+Z'], button: true, repeat: true },
		redo: {
			scopes: ['queue-editor', 'rotation-editor', 'filter-editor'],
			keys: [{ chord: 'Ctrl+Y', platform: 'other' }, 'Mod+Shift+Z'],
			button: true,
			repeat: true,
		},
		'find-in-region': { scopes: ['find-region'], keys: ['Mod+F'], shadows: ['browser-find'] },
		// a text selection inside the feed copies the ordinary way
		'copy-rows': { scopes: ['feed'], keys: ['Mod+C'], shadows: ['browser-copy'] },
		'copy-row-link': { scopes: ['feed'], keys: ['Mod+Alt+C'] },
	},
})

type Table = typeof TABLE
export type ScopeType = Extract<keyof Table['scopes'], string>
export type BindingId = Extract<keyof Table['bindings'], string>

// a scope type and every type it extends
type Lineage<S> = S extends ScopeType ? S | (Table['scopes'][S] extends { extends: infer P } ? Lineage<P> : never) : never

export type Extending<T extends ScopeType> = { [S in ScopeType]: T extends Lineage<S> ? S : never }[ScopeType]

// the bindings a scope of type S registers handlers for: those that apply in S, less the ones the browser, a library,
// a focused control or a button answers
export type HandledIn<S extends ScopeType> = {
	[B in BindingId]: Table['bindings'][B] extends { native: true } | { local: true } | { button: true }
		? never
		: Extract<Table['bindings'][B]['scopes'][number], Lineage<S>> extends never
			? never
			: B
}[BindingId]

// returns false to pass the key on to the scopes around this one
export type Handler = (e: KeyboardEvent, scopeElement: Element) => boolean | void

export type Handlers<S extends ScopeType> = { [B in HandledIn<S>]?: Handler }

export const PLATFORM: KB.Platform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other'

export function matches(e: KB.KeyEventLike, id: BindingId): boolean {
	return KB.chordsFor(TABLE.bindings[id], PLATFORM).some((chord) => KB.matchesChord(e, chord, PLATFORM))
}

// the binding's first chord on this platform, as it reads on a button
export function label(id: BindingId): string {
	return KB.chordLabel(KB.chordsFor(TABLE.bindings[id], PLATFORM)[0], PLATFORM)
}

export function ariaKeyshortcuts(id: BindingId): string {
	return KB.chordsFor(TABLE.bindings[id], PLATFORM)
		.map((chord) => KB.chordAria(chord, PLATFORM))
		.join(' ')
}
