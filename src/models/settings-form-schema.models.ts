import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
import * as PLG from '@/models/plugins.models'
import * as SDoc from '@/models/schema-docs.models'
import { HIDDEN_SETTINGS_KEYS } from '@/models/settings-groups.models'

// The settings form walks the JSON Schema projection of a zod schema (z.toJSONSchema, io: 'input'). formSchema
// normalizes that projection so every union is an `anyOf`, and controlFor picks the control the form renders for a
// node. jsonFallbackPaths runs the same dispatch over a whole schema without React, so a test and `plugin:pack` can
// name every field the form would show as raw JSON.

export type SchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

// Annotations such as schema docs and plugin field controls are read through SDoc and PLG.
export type SchemaNode = {
	[key: string]: unknown
	type?: SchemaType
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

const formSchemas = new WeakMap<z.ZodType, SchemaNode>()

// The result is shared between callers and must not be mutated.
export function formSchema(schema: z.ZodType): SchemaNode {
	let node = formSchemas.get(schema)
	if (!node) {
		node = normalize(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }))
		formSchemas.set(schema, node)
	}
	return node
}

// keywords that constrain one JSON type, so they move into that type's branch when a `type` array is split
const TYPE_KEYWORDS: Record<SchemaType, readonly string[]> = {
	string: ['pattern', 'minLength', 'maxLength', 'format', 'contentEncoding', 'contentMediaType'],
	number: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
	integer: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
	array: ['items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'contains'],
	object: ['properties', 'required', 'additionalProperties', 'propertyNames', 'patternProperties', 'minProperties', 'maxProperties'],
	boolean: [],
	null: [],
}

const SUBSCHEMA_MAP_KEYWORDS = ['properties', 'patternProperties', '$defs', 'definitions'] as const
const SUBSCHEMA_KEYWORDS = ['items', 'additionalProperties', 'propertyNames', 'contains', 'not'] as const
const SUBSCHEMA_LIST_KEYWORDS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const

// Zod writes a union of primitives, a nullable one included, as `type: ["string", "null"]`, and every other union as
// `anyOf`. Rewriting the first form into the second leaves the form one shape to read. Annotations stay on the outer
// node, where the form reads them.
function normalize(input: unknown): SchemaNode {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) return input as SchemaNode
	const node: Record<string, unknown> = { ...(input as Record<string, unknown>) }
	for (const key of SUBSCHEMA_MAP_KEYWORDS) {
		const map = node[key]
		if (map && typeof map === 'object') {
			node[key] = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, normalize(v)]))
		}
	}
	for (const key of SUBSCHEMA_KEYWORDS) {
		if (node[key] && typeof node[key] === 'object') node[key] = normalize(node[key])
	}
	for (const key of SUBSCHEMA_LIST_KEYWORDS) {
		if (Array.isArray(node[key])) node[key] = (node[key] as unknown[]).map(normalize)
	}
	if (!Array.isArray(node.type)) return node as SchemaNode
	const types = node.type as SchemaType[]
	delete node.type
	if (types.length === 1) return { ...node, type: types[0] } as SchemaNode
	const branches = types.map((type): SchemaNode => {
		const branch: SchemaNode = { type }
		for (const keyword of TYPE_KEYWORDS[type]) {
			if (keyword in node) branch[keyword] = node[keyword]
		}
		return branch
	})
	for (const type of types) for (const keyword of TYPE_KEYWORDS[type]) delete node[keyword]
	return { ...node, anyOf: [...((node.anyOf as SchemaNode[] | undefined) ?? []), ...branches] } as SchemaNode
}

export function stripNullable(node: SchemaNode): { inner: SchemaNode; nullable: boolean } {
	if (!node?.anyOf) return { inner: node, nullable: false }
	const others = node.anyOf.filter((b) => b.type !== 'null')
	if (others.length === node.anyOf.length || others.length === 0) return { inner: node, nullable: false }
	if (others.length === 1) return { inner: others[0], nullable: true }
	return { inner: { ...node, anyOf: others }, nullable: true }
}

// HumanTime and similar accept `string | number`; the form edits them as the string form
export function isStringOrNumber(node: SchemaNode): boolean {
	if (!node?.anyOf || node.anyOf.length !== 2) return false
	const types = new Set(node.anyOf.map((b) => b.type))
	return types.has('string') && types.has('number')
}

// a discriminated union (Zod z.discriminatedUnion) projects to `oneOf`/`anyOf` of object branches that each pin one
// property to a `const` (the discriminator). Returns those branches and the discriminator key.
export function discriminatedUnion(node: SchemaNode): { branches: ObjectSchemaNode[]; discriminator: string } | null {
	const branches = node?.oneOf ?? node?.anyOf
	if (!branches || branches.length < 2) return null
	if (!branches.every((b): b is ObjectSchemaNode => b?.type === 'object' && !!b.properties)) return null
	const constKeys = Object.keys(branches[0].properties).filter((k) => branches[0].properties[k]?.const !== undefined)
	const discriminator = constKeys.find((k) => branches.every((b) => b.properties[k]?.const !== undefined))
	if (!discriminator) return null
	return { branches, discriminator }
}

// a bespoke editor the form renders in place of the structural control for a node
export type OverrideId =
	| PLG.FieldControl
	| 'admin-lists'
	| 'server-admin-lists'
	| 'installed-mods'
	| 'allowed-prefixes'
	| 'locale'
	| 'server-color'
	| 'command'
	| 'admin-message-shorthands'
	| 'layer-table'
	| 'layer-generation'
	| 'layer-tags'
	| 'flag-multi-select'
	| 'player-groupings'
	| 'main-pool'
	| 'server-agent-token'
	| 'counterbalance-groups'
	| 'counterbalance-pick-first'
	| 'password'

const TOP_LEVEL_OVERRIDES: Record<string, OverrideId> = {
	installedMods: 'installed-mods',
	allowedPrefixes: 'allowed-prefixes',
	locale: 'locale',
	color: 'server-color',
	adminMessageShorthands: 'admin-message-shorthands',
	layerTable: 'layer-table',
	layerGeneration: 'layer-generation',
	layerTags: 'layer-tags',
	playerFlagsRequiringNote: 'flag-multi-select',
	playerGroupings: 'player-groupings',
}

export function overrideFor(path: Path, node: SchemaNode): OverrideId | undefined {
	const declared = PLG.fieldControl(node)
	if (declared) return declared
	const last = path[path.length - 1]
	if (path.length === 1) {
		// global settings define the lists (a record); a server picks from them (an array of names)
		if (last === 'adminLists') return node.type === 'array' ? 'server-admin-lists' : 'admin-lists'
		const id = Object.hasOwn(TOP_LEVEL_OVERRIDES, last) ? TOP_LEVEL_OVERRIDES[last as string] : undefined
		if (id) return id
	}
	if (path.length === 2) {
		// each command renders as one compact card, which renders its own strings sub-editor
		if (path[0] === 'commands') return 'command'
		// server settings: the pool configuration reuses the dashboard popover's panels; connection passwords are masked
		if (path[0] === 'queue' && last === 'mainPool') return 'main-pool'
		if (path[0] === 'connections' && last === 'token') return 'server-agent-token'
		if (path[0] === 'teamswapCounterbalance' && last === 'neverPickGroups') return 'counterbalance-groups'
		if (path[0] === 'teamswapCounterbalance' && last === 'pickFirst') return 'counterbalance-pick-first'
	}
	if (SDoc.read(node)?.secret) return 'password'
	return undefined
}

export type Control =
	| { kind: 'override'; id: OverrideId }
	// the whole rbac subtree renders as one consolidated per-role editor
	| { kind: 'rbac' }
	| { kind: 'discriminated-union'; branches: ObjectSchemaNode[]; discriminator: string }
	| { kind: 'enum' | 'string-or-number' | 'number' | 'string'; inner: SchemaNode; nullable: boolean }
	| { kind: 'boolean' }
	| { kind: 'enum-array'; items: SchemaNode; options: (string | number)[] }
	| { kind: 'array' | 'record' | 'object'; inner: SchemaNode }
	| { kind: 'json-fallback' }

export function controlFor(path: Path, node: SchemaNode): Control {
	const override = overrideFor(path, node)
	if (override) return { kind: 'override', id: override }
	if (path.length === 1 && path[0] === 'rbac') return { kind: 'rbac' }

	const { inner, nullable } = stripNullable(node)
	const du = discriminatedUnion(inner)
	if (du) return { kind: 'discriminated-union', ...du }
	if (inner.enum && inner.type !== 'array') return { kind: 'enum', inner, nullable }
	if (isStringOrNumber(inner)) return { kind: 'string-or-number', inner, nullable }
	switch (inner.type) {
		case 'boolean':
			return { kind: 'boolean' }
		case 'integer':
		case 'number':
			return { kind: 'number', inner, nullable }
		case 'string':
			return { kind: 'string', inner, nullable }
		case 'array': {
			const items = inner.items ?? {}
			const itemsInner = stripNullable(items).inner
			if (itemsInner.enum && itemsInner.type !== 'array' && itemsInner.type !== 'object') {
				return { kind: 'enum-array', items, options: itemsInner.enum }
			}
			return { kind: 'array', inner }
		}
		case 'object':
			if (inner.additionalProperties && typeof inner.additionalProperties === 'object') return { kind: 'record', inner }
			return { kind: 'object', inner }
		case 'null':
		case undefined:
			return { kind: 'json-fallback' }
		default:
			assertNever(inner.type)
	}
}

// Every field under `root` that the form renders as a raw JSON editor, as dotted paths with `[]` for an array item
// and `*` for a record entry. Follows the form's own walk, so a subtree an override renders is not visited.
export function jsonFallbackPaths(root: SchemaNode): string[] {
	const out: string[] = []
	const visitProperties = (props: Record<string, SchemaNode>, path: Path, skip?: string) => {
		for (const [key, child] of Object.entries(props)) {
			if (key === skip || (path.length === 0 && HIDDEN_SETTINGS_KEYS.has(key))) continue
			visit(child, [...path, key])
		}
	}
	const visit = (node: SchemaNode, path: Path) => {
		const control = controlFor(path, node)
		switch (control.kind) {
			case 'override':
			case 'rbac':
			case 'enum':
			case 'string-or-number':
			case 'number':
			case 'string':
			case 'boolean':
			case 'enum-array':
				return
			case 'discriminated-union':
				for (const branch of control.branches) visitProperties(branch.properties, path, control.discriminator)
				return
			case 'array':
				return visit(control.inner.items ?? {}, [...path, 0])
			case 'record':
				return visit(control.inner.additionalProperties as SchemaNode, [...path, '*'])
			case 'object':
				return visitProperties(control.inner.properties ?? {}, path)
			case 'json-fallback':
				out.push(path.map((p) => (typeof p === 'number' ? '[]' : p)).join('.'))
				return
			default:
				assertNever(control)
		}
	}
	visitProperties(root.properties ?? {}, [])
	return out
}
