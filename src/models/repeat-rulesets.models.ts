// A ruleset is a named list of repeat rules, kept in the global settings. Every server points at one through
// `queue.mainPool.repeatRulesetId`, so one set of rules can serve many servers. A public server gets a ruleset of its own
// when it is created (`ownerServerId`), named after it.
import * as Str from '@/lib/string-utils'
import { z } from '@/lib/zod'
import * as LQY from '@/models/layer-queries.models'
import { t } from '@/models/messages.models'
import * as SDoc from '@/models/schema-docs.models'
import type * as SS from '@/models/server-state.models'

// warn and indicate default on rather than off: every rule warned and indicated before either was configurable, so
// an existing rule that says nothing about them must keep doing both.
export const RepeatRuleConfigSchema = LQY.RepeatRuleSchema.extend({
	indicate: z
		.boolean()
		.prefault(true)
		.meta(SDoc.of({ label: t('Indicate'), description: t('Mark layers violating this rule wherever layers are displayed') })),
	warn: z
		.boolean()
		.prefault(true)
		.meta(
			SDoc.of({
				label: t('Warn'),
				description: t('Users should be warned before saving or before the layer violating this repeat rule is played'),
			}),
		),
	autogen: z
		.boolean()
		.optional()
		.meta(SDoc.of({ label: t('Apply to Generation'), description: t('Apply this rule when autogenerating layers') })),
})
export type RepeatRuleConfig = z.infer<typeof RepeatRuleConfigSchema>

// autogen on by default: a fresh server that generates layers violating its own repeat rules is never what
// anyone wants, and the per-rule option is there to turn it off
export const DEFAULT_RULES: readonly RepeatRuleConfig[] = [
	{ field: 'Map', within: 4, autogen: true, warn: true, indicate: true },
	{ field: 'Layer', within: 7, autogen: true, warn: true, indicate: true },
	{ field: 'Faction', within: 3, autogen: true, warn: true, indicate: true },
]

export const MAX_NAME_LENGTH = 64

export const RulesetIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9_-]+$/, { error: 'Must contain only lowercase letters, numbers, hyphens, and underscores' })
export type RulesetId = z.infer<typeof RulesetIdSchema>

export const RulesetSchema = z.object({
	id: RulesetIdSchema.meta(SDoc.of({ label: t('ID') })),
	name: z
		.string()
		.trim()
		.min(1)
		.max(MAX_NAME_LENGTH)
		.meta(SDoc.of({ label: t('Name') })),
	ownerServerId: z
		.string()
		.min(1)
		.max(256)
		.optional()
		.meta(
			SDoc.of({
				label: t('Owner Server'),
				description: t(
					'The server this ruleset was created for. Deleting that server deletes the ruleset, unless something else uses it.',
				),
			}),
		),
	rules: z
		.array(RepeatRuleConfigSchema)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Repeat Rules'),
				description: t(
					'How far apart a map, layer or faction has to be spaced in the queue and recent match history. Each rule can warn when it is broken, constrain autogeneration, or both.',
				),
			}),
		),
})
export type Ruleset = z.infer<typeof RulesetSchema>

export const RulesetsSchema = z
	.array(RulesetSchema)
	.prefault([])
	.superRefine((rulesets, ctx) => {
		const seenIds = new Set<string>()
		const seenNames = new Set<string>()
		rulesets.forEach((ruleset, i) => {
			if (seenIds.has(ruleset.id)) ctx.addIssue({ code: 'custom', message: `Duplicate ruleset id "${ruleset.id}"`, path: [i, 'id'] })
			seenIds.add(ruleset.id)
			const name = ruleset.name.toLowerCase()
			if (seenNames.has(name)) {
				ctx.addIssue({ code: 'custom', message: `Another ruleset is already named "${ruleset.name}"`, path: [i, 'name'] })
			}
			seenNames.add(name)
		})
	})
	.meta(
		SDoc.of({
			label: t('Repeat Rulesets'),
			description: t('Named lists of repeat rules. Each server and rotation uses one repeat ruleset.'),
		}),
	)

export function find(rulesets: readonly Ruleset[], id: RulesetId | null | undefined): Ruleset | undefined {
	if (!id) return undefined
	return rulesets.find((r) => r.id === id)
}

// a ruleset id that does not resolve applies no rules: the reference is reported where it is configured, not
// guessed at here
export function rulesFor(rulesets: readonly Ruleset[], id: RulesetId | null | undefined): readonly RepeatRuleConfig[] {
	return find(rulesets, id)?.rules ?? []
}

// the id a server's own ruleset takes: the server's id where that is a valid, unused ruleset id, else a slug of it
// with the first free numeric suffix
export function ownIdForServer(rulesets: readonly Ruleset[], serverId: SS.ServerId): RulesetId {
	return freeId(rulesets, serverId, 'server')
}

// `wanted` as an unused ruleset id: slugged, with the first free numeric suffix
export function freeId(rulesets: readonly Ruleset[], wanted: string, fallback = 'ruleset'): RulesetId {
	const base = Str.slugify(wanted, 56) || fallback
	const taken = new Set(rulesets.map((r) => r.id))
	if (!taken.has(base)) return base
	for (let i = 2; ; i++) {
		const candidate = `${base}-${i}`
		if (!taken.has(candidate)) return candidate
	}
}

export function nameTaken(rulesets: readonly Ruleset[], name: string, ignoreId?: RulesetId): boolean {
	const normalized = name.trim().toLowerCase()
	return rulesets.some((r) => r.id !== ignoreId && r.name.toLowerCase() === normalized)
}

// the first name free of a case-insensitive clash, appending " (2)", " (3)", ...
export function freeName(rulesets: readonly Ruleset[], wanted: string): string {
	const base = wanted.trim().slice(0, MAX_NAME_LENGTH - 5) || 'Ruleset'
	const taken = new Set(rulesets.map((r) => r.name.toLowerCase()))
	if (!taken.has(base.toLowerCase())) return base
	for (let i = 2; ; i++) {
		const candidate = `${base} (${i})`
		if (!taken.has(candidate.toLowerCase())) return candidate
	}
}
