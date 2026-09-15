// Foundry theme for CodeMirror 6: the editor as another inset well (see src/theme.css, src/foundry.css).
// Every colour and size is a Foundry token read at use time, so a density change or a palette edit moves the
// editor with the rest of the app.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

const SELECTION = 'color-mix(in oklab, var(--ctl-hi) 55%, transparent)'
const LINE_HI = 'color-mix(in oklab, var(--panel-hi) 60%, transparent)'
const PRI_WASH = 'color-mix(in oklab, var(--pri) 25%, transparent)'

const chrome = EditorView.theme(
	{
		'&': {
			height: '100%',
			color: 'var(--text)',
			backgroundColor: 'var(--ground)',
			fontSize: 'var(--fs)',
		},
		'&.cm-focused': { outline: 'none' },
		'.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
		'.cm-content': { caretColor: 'var(--pri-hi)' },
		'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--pri-hi)' },
		'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
			backgroundColor: SELECTION,
		},
		'.cm-selectionMatch': { backgroundColor: 'color-mix(in oklab, var(--pri) 14%, transparent)' },
		'.cm-activeLine': { backgroundColor: LINE_HI },

		'.cm-gutters': {
			backgroundColor: 'var(--ctl-lo)',
			color: 'var(--text-3)',
			borderRight: '1px solid var(--line)',
		},
		'.cm-activeLineGutter': { backgroundColor: LINE_HI, color: 'var(--text-2)' },
		'.cm-foldPlaceholder': {
			backgroundColor: 'var(--ctl-bg)',
			border: '1px solid var(--line)',
			borderRadius: '2px',
			color: 'var(--text-2)',
			padding: '0 4px',
		},

		'.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
			backgroundColor: PRI_WASH,
			outline: '1px solid var(--pri-lo)',
		},
		'.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { color: 'var(--danger)' },

		// popovers: autocomplete, schema hover, the search panel
		'.cm-tooltip': {
			backgroundColor: 'var(--panel-hi)',
			border: '1px solid var(--line)',
			borderRadius: '3px',
			color: 'var(--text)',
			boxShadow: '0 4px 12px rgba(0, 0, 0, 0.6)',
		},
		'.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'var(--line)', borderBottomColor: 'var(--line)' },
		'.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--panel-hi)', borderBottomColor: 'var(--panel-hi)' },
		'.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '16em' },
		'.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 6px', color: 'var(--text-2)' },
		'.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
			backgroundColor: 'var(--ctl-bg)',
			color: 'var(--text)',
		},
		'.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--pri-hi)', fontWeight: '700' },
		'.cm-completionDetail': { color: 'var(--text-3)', fontStyle: 'italic' },
		'.cm-completionIcon': { color: 'var(--text-3)' },
		'.cm-tooltip-hover, .cm6-json-schema-hover': { fontFamily: 'var(--font-sans)', padding: '4px 8px', maxWidth: '40em' },
		'.cm6-json-schema-hover--description': { color: 'var(--text-2)' },
		'.cm6-json-schema-hover--code': { fontFamily: 'var(--font-mono)', color: 'var(--pri-hi)' },

		'.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
		'.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
		'.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
		'.cm-textfield': {
			backgroundColor: 'var(--ground)',
			color: 'var(--text)',
			border: '1px solid var(--line)',
			borderRadius: '3px',
		},
		'.cm-button': {
			backgroundColor: 'var(--ctl-bg)',
			backgroundImage: 'none',
			color: 'var(--text)',
			border: '1px solid var(--line)',
			borderRadius: '3px',
		},
		'.cm-button:active': { backgroundColor: 'var(--ctl-lo)' },
		'.cm-searchMatch': { backgroundColor: PRI_WASH, outline: '1px solid var(--pri-lo)' },
		'.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--pri-lo)' },
	},
	{ dark: true },
)

// YAML's tag set is narrow: keys, scalars, quoted strings, comments, punctuation, and the rare sigil (anchors,
// tags, directives). Keys take the primary orange because they are the document's structure; the sigils take the
// remaining accents; everything else is the three text greys.
const highlight = HighlightStyle.define([
	{ tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--text-3)', fontStyle: 'italic' },
	{ tag: t.definition(t.propertyName), color: 'var(--pri-hi)' },
	{ tag: [t.content, t.string, t.number, t.bool, t.null], color: 'var(--text)' },
	{ tag: t.special(t.string), color: 'var(--warn)' },
	{ tag: [t.separator, t.punctuation, t.squareBracket, t.brace, t.meta], color: 'var(--text-3)' },
	{ tag: t.labelName, color: 'var(--teamA)' },
	{ tag: t.typeName, color: 'var(--admin-c)' },
	{ tag: [t.keyword, t.operator], color: 'var(--pri)' },
	{ tag: t.attributeValue, color: 'var(--text-2)' },
	{ tag: t.invalid, color: 'var(--danger)' },
])

export const foundryTheme: Extension = [chrome, syntaxHighlighting(highlight)]
