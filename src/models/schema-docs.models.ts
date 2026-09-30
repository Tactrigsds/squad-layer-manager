import type * as Msgs from '@/models/messages.models'

// Display text for a schema node, carried as zod metadata so it lives beside the field it names:
//
//   logFile: z.string().meta(SDoc.of({ label: t('Log File'), description: t('Path to SquadGame.log') }))
//
// The metadata survives z.toJSONSchema, which is how the settings form, its table of contents and the YAML editor's
// hover reach it. Messages stay unresolved here, since a model has no locale; each surface translates them.
//
// Each part sits under its own key because zod merges .meta() key by key: a property naming a shared union
// (`.meta(SDoc.of({ label }))`) must not erase the option names the union declared for itself.

export type Doc = {
	label?: Msgs.TString
	description?: Msgs.TString
	// names for the values of an enum, or for the branches of a discriminated union keyed by their discriminator
	options?: Record<string, Msgs.TString>
	// edited as one value (raw YAML, or a dedicated editor built on its own messages), so its members need no labels
	opaque?: true
	// a credential: edited in a password field, masked wherever a change is shown, and encrypted at rest (see
	// SETTINGS.SECRET_SETTING_PATHS)
	secret?: true
}

const KEYS = {
	label: 'x-slm-label',
	description: 'x-slm-description',
	options: 'x-slm-options',
	opaque: 'x-slm-opaque',
	secret: 'x-slm-secret',
} as const satisfies Record<keyof Doc, string>

const KEY_SET = new Set<string>(Object.values(KEYS))

export function of(doc: Doc) {
	const meta: Record<string, unknown> = {}
	for (const part of Object.keys(doc) as (keyof Doc)[]) meta[KEYS[part]] = doc[part]
	return meta
}

export function read(node: unknown): Doc | undefined {
	if (!node || typeof node !== 'object') return undefined
	const n = node as Record<string, unknown>
	const doc: Doc = {}
	for (const part of Object.keys(KEYS) as (keyof Doc)[]) {
		if (n[KEYS[part]] !== undefined) (doc as Record<string, unknown>)[part] = n[KEYS[part]]
	}
	return Object.keys(doc).length ? doc : undefined
}

type JsonNode = Record<string, unknown>

// A copy of a JSON schema whose `title` and `description` are the translated doc, for consumers that only read the
// standard keys (the YAML editor's hover). Nodes without a doc keep what they had.
export function localizeJsonSchema<T>(schema: T, translate: (msg: Msgs.TString) => string): T {
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(walk)
		if (!value || typeof value !== 'object') return value
		const out: JsonNode = {}
		for (const [k, v] of Object.entries(value as JsonNode)) out[k] = KEY_SET.has(k) ? v : walk(v)
		const doc = read(value)
		if (doc?.label) out.title = translate(doc.label)
		if (doc?.description) out.description = translate(doc.description)
		return out
	}
	return walk(schema) as T
}
