// Syntax highlighting for the plain-text rotation format, a Squad layer rotation .cfg file with SLM's `# VOTE:` and
// `# TAGS:` comment lines (see src/models/rotation-format.models.ts). Only the lazily-loaded source editor may import
// this, since it pulls in CodeMirror.
import { StreamLanguage } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

type State = { kind: 'line-start' | 'teams' | 'vote' | 'tags'; afterPlus: boolean; expectsSetting: boolean }

export const rotationCfg = StreamLanguage.define<State>({
	name: 'squad-rotation-cfg',
	startState: () => ({ kind: 'line-start', afterPlus: false, expectsSetting: true }),
	copyState: (state) => ({ ...state }),
	token(stream, state) {
		if (stream.sol()) {
			state.kind = 'line-start'
			state.afterPlus = false
			state.expectsSetting = true
		}
		if (stream.eatSpace()) {
			state.afterPlus = false
			return null
		}
		switch (state.kind) {
			case 'line-start': {
				if (stream.match(/^#\s*VOTE:/i)) {
					state.kind = 'vote'
					return 'header'
				}
				if (stream.match(/^#\s*TAGS:/i)) {
					state.kind = 'tags'
					return 'header'
				}
				if (stream.peek() === '#') {
					stream.skipToEnd()
					return 'comment'
				}
				if (stream.match(/^AdminSetNextLayer\b/i)) return 'header'
				stream.match(/^\S+/)
				state.kind = 'teams'
				return 'layer'
			}
			case 'teams': {
				if (stream.eat('+')) {
					state.afterPlus = true
					return 'punctuation'
				}
				stream.match(/^[^\s+]+/)
				return state.afterPlus ? 'unit' : 'faction'
			}
			case 'vote': {
				if (stream.eat(';')) {
					state.expectsSetting = true
					return 'punctuation'
				}
				if (stream.eat(',')) return 'punctuation'
				stream.match(/^[^\s,;]+/)
				if (!state.expectsSetting) return 'value'
				state.expectsSetting = false
				return 'setting'
			}
			case 'tags': {
				if (stream.eat(',')) return 'punctuation'
				stream.match(/^[^,]+/)
				return 'tag'
			}
		}
	},
	tokenTable: {
		header: t.keyword,
		comment: t.lineComment,
		layer: t.definition(t.propertyName),
		faction: t.typeName,
		unit: t.attributeValue,
		punctuation: t.punctuation,
		setting: t.labelName,
		value: t.string,
		tag: t.special(t.string),
	},
})
