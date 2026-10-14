import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import * as CMKeys from '@/lib/codemirror-keymap'
import * as KB from '@/lib/keybinds'
import * as KEYS from '@/models/keybinds.models'

it("SLM's keybindings do not clash on either platform", () => {
	expect(() => KB.assertValid(KEYS.TABLE)).not.toThrow()
})

// CodeMirror answers its keymap before a key reaches the dispatcher, so each of its keys that is bound around an editor
// has to be declared under `code-editor`, shadowing what it takes. The rest of the keymap concerns nobody.
describe("CodeMirror's keymap", () => {
	const MODIFIERS: Record<string, string> = {
		mod: 'Mod',
		ctrl: 'Ctrl',
		c: 'Ctrl',
		alt: 'Alt',
		a: 'Alt',
		shift: 'Shift',
		s: 'Shift',
		meta: 'Meta',
		cmd: 'Meta',
		m: 'Meta',
	}

	// CodeMirror's `Mod-Shift-z` as a chord. A two-stroke binding is left out: the table binds single keys
	function chordOf(cmKey: string): string | null {
		if (cmKey.includes(' ')) return null
		const parts = cmKey.split(/-(?!$)/)
		const key = parts.pop()!
		const mods = parts.map((part) => MODIFIERS[part.toLowerCase()])
		if (mods.some((mod) => !mod)) throw new Error(`unknown modifier in ${cmKey}`)
		return [...mods, key === 'Space' ? ' ' : key].join('+')
	}

	function keymapChords(platform: KB.Platform): Set<string> {
		const state = EditorState.create({ extensions: [CMKeys.basicSetup, CMKeys.yamlIndentKeymap] })
		const chords = new Set<string>()
		for (const binding of state.facet(keymap).flat()) {
			const specs = platform === 'mac' ? [binding.mac ?? binding.key] : [binding.win ?? binding.key, binding.linux ?? binding.key]
			for (const spec of specs) {
				const chord = spec && chordOf(spec)
				if (chord) chords.add(KB.canonical(KB.parseChord(chord), platform))
			}
		}
		return chords
	}

	it('declares every key it takes from a binding around an editor', () => {
		const bindings: Record<string, KB.BindingDef<string, string>> = { ...KEYS.TABLE.bindings }
		for (const platform of KB.PLATFORMS) {
			const declared = new Set(
				Object.values(KEYS.TABLE.bindings)
					.filter((def) => (def.scopes as readonly string[]).includes('code-editor'))
					.flatMap((def) => KB.chordsFor(def, platform).map((c) => KB.canonical(c, platform))),
			)
			let i = 0
			for (const chord of keymapChords(platform)) {
				if (declared.has(chord)) continue
				bindings[`codemirror ${chord}`] = {
					scopes: ['code-editor'],
					keys: [{ chord, platform }],
					native: true,
				}
				i++
			}
			expect(i).toBeGreaterThan(0)
		}
		expect(() => KB.assertValid({ scopes: KEYS.TABLE.scopes, bindings })).not.toThrow()
	})
})
