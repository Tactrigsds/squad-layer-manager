import React from 'react'

import * as Rx from '@/lib/rxjs'
import { LOCAL_YAML_EDITOR_PATHS } from '@/lib/settings-groups'
import type * as Templating from '@/lib/templating'
import type { z } from '@/lib/zod'
import * as ZodUtils from '@/lib/zod-utils'
import * as Zus from '@/lib/zustand'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as SETTINGS from '@/models/settings.models'
import type * as RBAC from '@/rbac.models'
import { tr } from '@/systems/messages.client'

// The form is driven off the JSON-Schema projection of a Zod schema (input mode), edited in the encoded/input shape
// (e.g. HumanTime fields as '5m' strings). Custom widgets are matched by path for the flag + rbac config.
//
// Data flow is inverted from a plain controlled form: instead of a `value` prop we hand each field a `value$`
// (a BehaviorSubject-like state observable it reads via `.getValue()`) and a `reset$` signal. Native text/number
// inputs stay *uncontrolled* (seeded from `value$.getValue()`, edits debounced upward) so typing never round-trips
// through React state; `reset$` is emitted after any structural or programmatic change so those uncontrolled inputs
// re-read their current value. Composite widgets (selects, switches, pickers) render controlled off a small local
// mirror of `value$` that only re-syncs on emissions/`reset$`.
//
// The `reset$` pulse is synchronous, so it lands while the inputs still hold their PREVIOUS `value$` bindings,
// before React has re-rendered with the new ones. A structural edit that changes a value's shape or removes a row
// therefore runs the old projection against the new data: a union-shaped field reads the wrong variant, and a
// projection indexed by row position reads an index that no longer exists. Guard the projection (return undefined
// for a row that is gone) rather than deferring the pulse, which the uncontrolled inputs depend on being immediate.

// The JSON Schema projection of a settings schema (z.toJSONSchema, io: 'input'), narrowed to the keys the form walks.
// Annotations such as schema docs and plugin field controls are read through SDoc and PLG.
export type SchemaNode = {
	[key: string]: unknown
	type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
	enum?: (string | number)[]
	const?: string | number | boolean | null
	default?: unknown
	anyOf?: SchemaNode[]
	oneOf?: SchemaNode[]
	items?: SchemaNode
	properties?: Record<string, SchemaNode>
	// false for a strict object
	additionalProperties?: SchemaNode | boolean
	propertyNames?: SchemaNode
}

export type ObjectSchemaNode = SchemaNode & { properties: Record<string, SchemaNode> }

export type Path = (string | number)[]

// a BehaviorSubject-like handle: subscribable, plus a synchronous `.getValue()` for the current value
export type ValueState<T = any> = Zus.ValueObservable<T>

export const DEBOUNCE_MS = 250

// derive a child value-state scoped to `key` of the parent. distinctUntilChanged keeps copy-on-write siblings quiet.
export function scopeValue(parent$: ValueState, key: string | number): ValueState {
	const child$ = parent$.pipe(
		Rx.map((v: any) => v?.[key]),
		Rx.distinctUntilChanged(),
	) as ValueState
	child$.getValue = () => (parent$.getValue() as any)?.[key]
	return child$
}

// derive a child value-state through a projection rather than a key, for a child whose shape in the parent varies
// (a union member). Same contract as scopeValue.
export function mapValue<T, U>(parent$: ValueState<T>, project: (v: T) => U): ValueState<U> {
	const child$ = parent$.pipe(Rx.map(project), Rx.distinctUntilChanged()) as ValueState<U>
	child$.getValue = () => project(parent$.getValue())
	return child$
}

// current value of a field, for widgets that render controlled. Takes no reset$: a reset writes the draft, which
// every value state is derived from, so the emission it already causes is the re-read. Uncontrolled inputs are the
// ones the pulse exists for -- see useReset.
export function useFieldValue<T>(value$: ValueState<T>): T {
	return Zus.useStore(value$)
}

// run `fn` whenever reset$ fires (used by uncontrolled inputs to re-read their DOM value)
export function useReset(reset$: Rx.Observable<void>, fn: () => void) {
	const fnRef = React.useRef(fn)
	fnRef.current = fn
	React.useEffect(() => {
		const sub = reset$.subscribe(() => fnRef.current())
		return () => sub.unsubscribe()
	}, [reset$])
}

export function stripNullable(node: SchemaNode): { inner: SchemaNode; nullable: boolean } {
	if (node?.anyOf) {
		const nulls = node.anyOf.filter((b: SchemaNode) => b.type === 'null')
		const others = node.anyOf.filter((b: SchemaNode) => b.type !== 'null')
		if (nulls.length && others.length) {
			return { inner: others.length === 1 ? others[0] : { anyOf: others }, nullable: true }
		}
	}
	return { inner: node, nullable: false }
}

// HumanTime and similar accept `string | number`; we edit them as the string form
export function isStringOrNumber(node: SchemaNode): boolean {
	if (!node?.anyOf || node.anyOf.length !== 2) return false
	const types = new Set(node.anyOf.map((b: SchemaNode) => b.type))
	return types.has('string') && types.has('number')
}

// a discriminated union (Zod z.discriminatedUnion) projects to `oneOf`/`anyOf` of object branches that each pin one
// property to a `const` (the discriminator). Returns those branches + the discriminator key so we can render a variant
// picker instead of falling back to a raw-json editor.
export function discriminatedUnion(node: SchemaNode): { branches: ObjectSchemaNode[]; discriminator: string } | null {
	const branches = node?.oneOf ?? node?.anyOf
	if (!branches || branches.length < 2) return null
	if (!branches.every((b): b is ObjectSchemaNode => b?.type === 'object' && !!b.properties)) return null
	const constKeys = Object.keys(branches[0].properties).filter((k) => branches[0].properties[k]?.const !== undefined)
	const discriminator = constKeys.find((k) => branches.every((b) => b.properties[k]?.const !== undefined))
	if (!discriminator) return null
	return { branches, discriminator }
}

export function emptyValue(node: SchemaNode): unknown {
	const { inner, nullable } = stripNullable(node)
	if (nullable) return null
	if (inner.const !== undefined) return inner.const
	if (inner.default !== undefined) return structuredClone(inner.default)
	if (inner.enum) return inner.enum[0]
	const du = discriminatedUnion(inner)
	if (du) return emptyValue(du.branches[0])
	if (isStringOrNumber(inner)) return '0s'
	switch (inner.type) {
		case 'string':
			return ''
		case 'integer':
		case 'number':
			return 0
		case 'boolean':
			return false
		case 'array':
			return []
		case 'object': {
			if (!inner.properties) return {}
			const obj: Record<string, unknown> = {}
			for (const key of Object.keys(inner.properties)) obj[key] = emptyValue(inner.properties[key])
			return obj
		}
		default:
			return null
	}
}

// granted permissions include the "*" wildcard; denials are stored with a "!" prefix but edited without it in a separate select
// the draft's custom message variable definitions (rbac-style sibling read), unresolved so the reason preview can
// re-resolve them per entry with the standard variables (duration, squadName) that entry is showing
export const MessageVarsContext = React.createContext<Templating.TemplateVarDef[]>([])

function readMessageVarDefs(v: any): Templating.TemplateVarDef[] {
	return ((v?.messageVariables ?? []) as { name?: string; value?: string }[]).flatMap((mv) =>
		mv.name ? [{ name: mv.name, value: mv.value ?? '' }] : [],
	)
}

// This one feeds a context at the form root, so it must hold its identity while the contents match: a fresh array
// per draft change would re-render the whole form on every keystroke. The selector is memoized per form instance
// rather than at module scope because the settings page mounts one form per section.
export function useMessageVars(value$: ValueState): Templating.TemplateVarDef[] {
	const prevRef = React.useRef<Templating.TemplateVarDef[]>([])
	const read = React.useCallback((v: any) => {
		const prev = prevRef.current
		const next = readMessageVarDefs(v)
		const same = prev.length === next.length && next.every((d, i) => prev[i].name === d.name && prev[i].value === d.value)
		if (!same) prevRef.current = next
		return prevRef.current
	}, [])
	return Zus.useStore(value$, read)
}

// per-form options. `idPrefix` scopes the DOM ids / URL-fragment anchors so multiple forms on the settings page (global
// settings + one per server) don't collide; it stays `setting:*` so the TOC scroll-spy and hash nav still match.
export const FormOptionsContext = React.createContext<{ idPrefix: string }>({ idPrefix: 'setting:' })

// The whole document being edited and its onChange, passed down every field. A bespoke field reads and writes siblings
// it isn't scoped to through it: the command-prefix editor propagates a prefix rename across every command string,
// and comments are stored on the root document.
export type FormRoot = { value$: ValueState; onChange: (next: any) => void }

// the zod schema of the whole document, so a field can resolve the sub-schema at its own path for its scoped YAML
// editor (the json-schema projection the form walks can't be handed back to zod for parsing)
export const RootSchemaContext = React.createContext<z.ZodType | null>(null)

// paths that render inside their section's "Advanced" disclosure (see settings-groups.ts). Empty for forms that
// declare none.
export const NO_ADVANCED_PATHS: ReadonlySet<string> = new Set()

export const AdvancedPathsContext = React.createContext<ReadonlySet<string>>(NO_ADVANCED_PATHS)

// the user's write grant over the settings being edited; leaves outside it render dimmed + inert (see LeafField)
export const WRITE_ACCESS_ALL: RBAC.SettingsWriteAccess = { kind: 'all' }

export const WriteAccessContext = React.createContext<RBAC.SettingsWriteAccess>(WRITE_ACCESS_ALL)

// the current draft's schema issues, normalized to dotted path strings. Each leaf field claims the issues at or below
// its own path (below-leaf paths -- array items, record entries -- have no dedicated field UI of their own).
export type NormalizedIssue = { path: string; message: string }

export const ValidationContext = React.createContext<NormalizedIssue[]>([])

export function issuesForField(all: NormalizedIssue[], pathStr: string): NormalizedIssue[] {
	return all.filter((i) => i.path === pathStr || i.path.startsWith(pathStr + '.'))
}

// the last-saved (persisted) baseline the draft was seeded from, so any field can offer "reset to saved" alongside
// "reset to default". Held at the root and indexed per-field by path (see `getAtPath`); only changes on save/refetch, so
// per-keystroke edits don't churn it. `undefined` while the settings are still loading.
export const SavedRootContext = React.createContext<{ saved: any }>({ saved: undefined })

export function getAtPath(root: any, path: Path): unknown {
	let cur = root
	for (const key of path) {
		if (cur === null || cur === undefined) return undefined
		cur = cur[key as any]
	}
	return cur
}

export type OverrideProps = { value$: ValueState; reset$: Rx.Subject<void>; onChange: (v: any) => void; path: Path; root: FormRoot }

// copy-on-write set at a nested path (arrays stay arrays)
export function setAtPath(root: any, path: Path, value: unknown): any {
	if (path.length === 0) return value
	const [head, ...rest] = path
	const base = root ?? (typeof head === 'number' ? [] : {})
	const copy: any = Array.isArray(base) ? [...base] : { ...base }
	copy[head as any] = setAtPath(base?.[head as any], rest, value)
	return copy
}

// placeholder for a text/number input: the schema default when there is one (doubles as a format hint, e.g. '5m'),
// an example duration for HumanTime fields without one, otherwise the field's name
export function placeholderFor(node: SchemaNode, inner: SchemaNode, path: Path): string | undefined {
	const def = effectiveDefault(node)
	if (def.has && def.value !== '' && (typeof def.value === 'string' || typeof def.value === 'number')) return String(def.value)
	if (isStringOrNumber(inner)) return tr.text(SETTINGS_Msgs.durationExample())
	const last = path[path.length - 1]
	return typeof last === 'string' ? tr.text(SETTINGS_Msgs.settingLabel(node, last)) : undefined
}

// the value a field falls back to. For prefaulted object sections the node default is often a bare {}, so we reconstruct
// from child defaults to get the real nested default (used for both the "Default:" hint and reset-to-default). A key the
// object's own default already provides wins over the child default (it's the more specific value, e.g. rbac's preset).
const defaultCache = new WeakMap<object, { has: boolean; value: unknown }>()

export function effectiveDefault(node: SchemaNode): { has: boolean; value: unknown } {
	if (node && typeof node === 'object' && defaultCache.has(node)) return defaultCache.get(node)!
	const { inner } = stripNullable(node)
	const explicit = node?.default !== undefined ? node.default : inner?.default
	let result: { has: boolean; value: unknown }
	if (inner?.type === 'object' && inner.properties) {
		const base = explicit && typeof explicit === 'object' && !Array.isArray(explicit) ? { ...explicit } : {}
		let has = explicit !== undefined
		for (const key of Object.keys(inner.properties)) {
			if (key in base) continue
			const d = effectiveDefault(inner.properties[key])
			if (d.has) {
				;(base as Record<string, unknown>)[key] = d.value
				has = true
			}
		}
		result = { has, value: base }
	} else if (explicit !== undefined) {
		result = { has: true, value: explicit }
	} else {
		result = { has: false, value: undefined }
	}
	if (node && typeof node === 'object') defaultCache.set(node, result)
	return result
}

export function formatDefaultValue(val: unknown): string {
	const words = SETTINGS_Msgs.defaultValueWords
	if (val === null) return words.unset
	if (typeof val === 'boolean') return val ? words.on : words.off
	if (typeof val === 'string') return val === '' ? words.empty : val
	if (typeof val === 'number') return String(val)
	return JSON.stringify(val)
}

export function isScalarNode(inner: SchemaNode): boolean {
	if (inner?.enum && inner.type !== 'array') return true
	if (isStringOrNumber(inner)) return true
	return inner?.type === 'string' || inner?.type === 'number' || inner?.type === 'integer' || inner?.type === 'boolean'
}

// the comment on the setting at `pathStr`, read off the root document (see SETTINGS.COMMENTS_KEY)
export function useSettingComment(root$: ValueState, pathStr: string): string | undefined {
	const comment$ = React.useMemo(
		() => mapValue(root$, (v: any) => v?.[SETTINGS.COMMENTS_KEY]?.[pathStr] as string | undefined),
		[root$, pathStr],
	)
	return useFieldValue(comment$)
}

export type CommentProps = {
	root: FormRoot
	pathStr: string
	writable: boolean
	editing: boolean
	setEditing: (editing: boolean) => void
	// where the textarea puts its caret when editing opens: the character that was clicked, or the end of the text
	caretRef: React.RefObject<number | null>
}

export function useCommentProps(root: FormRoot, pathStr: string, writable: boolean): CommentProps {
	const [editing, setEditing] = React.useState(false)
	const caretRef = React.useRef<number | null>(null)
	return { root, pathStr, writable, editing, setEditing, caretRef }
}

// the collapsed preview squeezes each whitespace run to one space, so a caret placed in it has to be walked back to
// the original text. Returns the preview alongside the original index each of its characters came from.
export function flattenWhitespace(text: string): { flat: string; origIndex: number[] } {
	let flat = ''
	const origIndex: number[] = []
	let inRun = false
	for (let i = 0; i < text.length; i++) {
		const ws = /\s/.test(text[i])
		if (ws && inRun) continue
		flat += ws ? ' ' : text[i]
		origIndex.push(i)
		inRun = ws
	}
	return { flat, origIndex }
}

// the character offset of a click inside `container`, counted over its text nodes in document order (the link anchors
// RichText renders included). Null when the click landed on no text.
export function textOffsetAtPoint(container: HTMLElement, x: number, y: number): number | null {
	const doc = container.ownerDocument
	let node: globalThis.Node | null = null
	let offset = 0
	if (doc.caretPositionFromPoint) {
		const pos = doc.caretPositionFromPoint(x, y)
		if (pos) [node, offset] = [pos.offsetNode, pos.offset]
	} else if (doc.caretRangeFromPoint) {
		const range = doc.caretRangeFromPoint(x, y)
		if (range) [node, offset] = [range.startContainer, range.startOffset]
	}
	if (!node || !container.contains(node)) return null
	const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT)
	let total = 0
	for (let cur = walker.nextNode(); cur; cur = walker.nextNode()) {
		if (cur === node) return total + offset
		total += cur.textContent?.length ?? 0
	}
	return null
}

// how much of a comment survives the collapsed view. whitespace is flattened first so the preview is one line
// regardless of how the comment was written
export const COMMENT_PREVIEW_LENGTH = 160

// which editor a field with a scoped YAML editor is currently showing, mirroring the page-level section modes
export type FieldMode = 'gui' | 'yaml'

// the sub-schema for this field's scoped YAML editor, or undefined when it doesn't offer one
export function useLocalEditorSchema(pathStr: string): z.ZodType | undefined {
	const rootSchema = React.useContext(RootSchemaContext)
	return React.useMemo(
		// splitting pathStr rather than taking the path array keeps this memo stable: the array is rebuilt every render.
		// Only the declared paths are split, and those have no dots inside a segment.
		() => (rootSchema && LOCAL_YAML_EDITOR_PATHS.has(pathStr) ? ZodUtils.schemaAtPath(rootSchema, pathStr.split('.')) : undefined),
		[rootSchema, pathStr],
	)
}

// The form's drafts hold the input/encoded shape, but the editor validates through the sub-schema, which yields the
// decoded shape (e.g. HumanTime as milliseconds). Encode back where the schema allows it; a subtree carrying a
// one-way transform can't encode at all, and its output shape is its input shape anyway.
export function toInputShape(schema: z.ZodType, decoded: unknown): unknown {
	try {
		return schema.encode(decoded)
	} catch {
		return decoded
	}
}
