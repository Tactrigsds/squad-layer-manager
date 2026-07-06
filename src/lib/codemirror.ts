// Shared CodeMirror 6 setup for JSON editors with zod-derived JSON-schema autocomplete + hover.
// WARNING: only import this from lazily-loaded (React.lazy'd) components -- it statically pulls in the
// whole CodeMirror + codemirror-json-schema bundle, which we don't want in the initial/route chunk.
import { json, jsonLanguage } from '@codemirror/lang-json'
import type { Extension } from '@codemirror/state'
import { EditorState } from '@codemirror/state'
import { EditorView, hoverTooltip } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { jsonCompletion, jsonSchemaHover, stateExtensions, updateSchema } from 'codemirror-json-schema'
import type { JSONSchema7 } from 'json-schema'
import { dracula } from 'thememirror'
import { z } from 'zod'

export { EditorState, EditorView, updateSchema }
export type { Extension }

// codemirror-json-schema types its schema as json-schema's JSONSchema7.
export type JsonSchema = JSONSchema7

// Generate a draft-7 JSON Schema (input side, so codec fields like HumanTime keep their editable string form)
// for schema-driven autocomplete + hover. Returns undefined when the schema can't be represented as JSON
// Schema (e.g. exotic transforms), in which case the editor still works, just without completion.
export function toJsonSchema(schema: z.core.$ZodType): JsonSchema | undefined {
	try {
		return z.toJSONSchema(schema, { io: 'input', target: 'draft-7', unrepresentable: 'any' }) as JsonSchema
	} catch {
		return undefined
	}
}

const heightTheme = EditorView.theme({
	'&': { height: '100%', fontSize: '13px' },
	'.cm-scroller': { overflow: 'auto' },
})

// Base extensions for a JSON editor: editing affordances, JSON syntax, dracula theme, line wrapping, and --
// when a schema is provided -- schema-driven autocompletion and hover tooltips (descriptions come from
// `.describe()` annotations on the zod schema).
export function jsonEditorExtensions(schema: JsonSchema | undefined): Extension[] {
	return [
		basicSetup,
		json(),
		jsonLanguage.data.of({ autocomplete: jsonCompletion() }),
		hoverTooltip(jsonSchemaHover()),
		stateExtensions(schema),
		dracula,
		EditorView.lineWrapping,
		heightTheme,
	]
}

// Replace the entire document contents.
export function setDoc(view: EditorView, text: string) {
	view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
}
