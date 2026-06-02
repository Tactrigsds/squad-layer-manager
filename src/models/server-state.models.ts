import * as Obj from '@/lib/object'
import * as CB from '@/models/constraint-builders'
import * as F from '@/models/filter.models'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as SM from '@/models/squad.models'
import * as Teamswitches from '@/models/teamswitches.models'
import type * as USR from '@/models/users.models'
import { z } from 'zod'

const DEFAULT_REPEAT_RULE_CONFIGS: PoolRepeatRuleConfig[] = [
	{ label: 'Map', field: 'Map', within: 4 },
	{ label: 'Layer', field: 'Layer', within: 7 },
	{ label: 'Faction', field: 'Faction', within: 3 },
]

export const POOL_FILTER_APPLY_AS = z.enum(['regular', 'inverted', 'disabled'])
export type PoolFilterApplyAs = z.infer<typeof POOL_FILTER_APPLY_AS>
export const POOL_FILTER_DEFAULT_APPLY_AS_SETTING = z.enum(['regular', 'inverted', 'disabled', 'hidden'])
export type PoolFilterDefaultApplyAsSetting = z.infer<typeof POOL_FILTER_DEFAULT_APPLY_AS_SETTING>
export type ConstraintApplyAs = z.infer<typeof POOL_FILTER_APPLY_AS>
export const DEFAULT_POOL_FILTER_APPLY_AS = 'regular'

export const PoolFilterConfigSchema = z.object({
	filterId: F.FilterEntityIdSchema,
	showIndicator: LQY.INDICATOR_STATE.optional().meta({
		description:
			'Whether to indicate items that match this filter. Invert to indicate that an item DOES NOT match the filter, or "both" to indicate both matches and non-matches',
	}),
	defaultApplyDuringLayerSelection: POOL_FILTER_DEFAULT_APPLY_AS_SETTING.optional().meta({
		description: 'How to apply this filter during layer selection by default',
	})
		.optional(),
	warn: POOL_FILTER_APPLY_AS.optional().meta({
		description:
			"How users should be warned if a layer matching this filter is about to be played, or when it is added to the queue. Invert if you want warnings for layers which *DON't match this filter",
	}).optional(),
}).refine(c => !c.warn || c.showIndicator && c.showIndicator !== 'disabled', 'Cannot warn without indicating matches')
export type PoolFilterConfig = z.infer<typeof PoolFilterConfigSchema>

export const RepeatRuleConfigSchema = LQY.RepeatRuleSchema.extend({
	warn: z.boolean().optional().meta({
		description: 'Users should be warned before saving or before the layer violating this repeat rule is played',
	}),
})

export type PoolRepeatRuleConfig = z.infer<typeof RepeatRuleConfigSchema>

export const PoolConfigurationSchema = z.object({
	filters: z.array(
		// migrate
		z.preprocess(
			(obj) => typeof obj === 'string' ? ({ filterId: obj, applyAs: DEFAULT_POOL_FILTER_APPLY_AS }) : obj,
			PoolFilterConfigSchema,
		),
	),
	repeatRules: z.array(RepeatRuleConfigSchema).refine(
		(rules) => new Set(rules.map((r) => r.label)).size === rules.length,
		{
			error: 'Repeat rule labels must be unique',
		},
	),
})

export type PoolConfiguration = z.infer<typeof PoolConfigurationSchema>
export const ServerConnectionSchema = z.object({
	rcon: z.object({
		host: z.string().min(1),
		port: z.number().min(1).max(65535),
		password: z.string().min(1),
	}),
	logs: z.discriminatedUnion('type', [
		z.object({
			type: z.literal('log-receiver'),
			token: z.string().default('dev'),
		}),
		z.object({
			type: z.literal('sftp'),
			host: z.string().min(1),
			port: z.number().min(1).max(65535),
			username: z.string().min(1),
			password: z.string().min(1),
			logFile: z.string().min(1),
		}),
	]),
})
export const GenerationFilterConfigSchema = z.object({ filterId: z.string(), applyAs: POOL_FILTER_APPLY_AS })
export type GenerationFilterConfig = z.infer<typeof GenerationFilterConfigSchema>
export type ServerConnection = z.infer<typeof ServerConnectionSchema>
export const GenerationConfigSchema = z.object({
	filters: z.array(GenerationFilterConfigSchema),
	repeatRules: z.array(LQY.RepeatRuleSchema),
	applyMainPoolRepeatRules: z.boolean().prefault(false),
})

export const QueueSettingsSchema = z.object({
	mainPool: PoolConfigurationSchema.prefault({ filters: [], repeatRules: DEFAULT_REPEAT_RULE_CONFIGS }),
	generationPool: GenerationConfigSchema.prefault({ filters: [], repeatRules: [], applyMainPoolRepeatRules: false }),
	preferredLength: z.number().prefault(12),
	generatedItemType: z.enum(['layer', 'vote']).prefault('layer'),
	preferredNumVoteChoices: z.number().prefault(3),
})
export type QueueSettings = z.infer<typeof QueueSettingsSchema>

export const PublicServerSettingsSchema = z
	.object({
		updatesToSquadServerDisabled: z.boolean().prefault(false).describe('disable SLM from setting the next layer on the server'),
		queue: QueueSettingsSchema
			// avoid sharing default queue object - TODO unclear if necessary
			.prefault({}).transform((obj) => Obj.deepClone(obj)),
	})

export type PublicServerSettings = z.infer<typeof PublicServerSettingsSchema>

const EXAMPLE_PUBLIC_SETTINGS = PublicServerSettingsSchema.parse({})
EXAMPLE_PUBLIC_SETTINGS.queue.mainPool.filters.push({ showIndicator: DEFAULT_POOL_FILTER_APPLY_AS, filterId: 'test-filter' })
EXAMPLE_PUBLIC_SETTINGS.queue.generationPool.filters.push({ applyAs: DEFAULT_POOL_FILTER_APPLY_AS, filterId: 'test-filter' })

export const ServerSettingsSchema = PublicServerSettingsSchema.extend({
	connections: ServerConnectionSchema,
	adminListSources: z.array(z.string()),
	adminIdentifyingPermissions: z.array(SM.PLAYER_PERM),
})

export type ServerSettings = z.infer<typeof ServerSettingsSchema>
export type Changed<T> = {
	[K in keyof T]: T[K] extends object ? Changed<T[K]> : boolean
}

export type SettingsChanged = Changed<ServerSettings>
export function getFilterEntityConstraintId(poolName: string, opts: { filterId: string }) {
	return `layer-pool:${poolName}:${opts.filterId}`
}
export function getFilterEntityConfigFromId(poolConfig: PoolFilterConfig[], constraintId: string) {
	const [filterId] = constraintId.split(':').slice(2)
	if (!filterId) return
	return poolConfig.find((p) => p.filterId === filterId)
}
export function getRepeatRuleConstraintId(poolName: string, opts: { label: string }) {
	return `layer-pool:${poolName}:${opts.label}`
}
export function getRepeatRuleConfigFromConstraintId(poolConfig: PoolRepeatRuleConfig[], constraintId: string) {
	const [label] = constraintId.split(':').slice(2)
	if (!label) return
	return poolConfig.find((r) => r.label === label)
}

// note the QueryConstraint is not perfectly suited to this kind of use-case as we have to arbitrarily specify apply-as
export function getSettingsConstraints(
	settings: PublicServerSettings,
	opts?: { generatingLayers?: boolean },
) {
	const constraints: LQY.Constraint[] = []

	if (!opts?.generatingLayers) {
		const mainPoolConfig = settings.queue.mainPool
		for (const { filterId, showIndicator, defaultApplyDuringLayerSelection: applyAs, warn } of mainPoolConfig.filters) {
			constraints.push(
				CB.filterEntity(getFilterEntityConstraintId('mainPool', { filterId }), filterId, {
					filterApplState: applyAs === 'hidden' ? 'disabled' : applyAs,
					showIndicator: opts?.generatingLayers ? 'disabled' : showIndicator,
					warn,
				}),
			)
		}
	}

	if (!opts?.generatingLayers || settings.queue.generationPool.applyMainPoolRepeatRules) {
		const mainPoolConfig = settings.queue.mainPool
		for (let j = 0; j < mainPoolConfig.repeatRules.length; j++) {
			const rule = mainPoolConfig.repeatRules[j]
			constraints.push(
				CB.repeatRule(getRepeatRuleConstraintId('mainPool', { label: rule.label }), rule),
			)
		}
	}

	if (opts?.generatingLayers) {
		const genPoolConfig = settings.queue.generationPool

		for (const config of genPoolConfig.filters) {
			constraints.push(CB.filterEntity(getFilterEntityConstraintId('generationPool', { filterId: config.filterId }), config.filterId, {
				filterApplState: config.applyAs,
			}))
		}
		for (const config of genPoolConfig.repeatRules) {
			constraints.push(CB.repeatRule(getRepeatRuleConstraintId('generationPool', { label: config.label }), config))
		}
	}

	return constraints
}

export function getSettingsChanged(original: ServerSettings, modified: ServerSettings) {
	// @ts-expect-error it works
	const result: SettingsChanged = {}
	for (const _key in original) {
		const key = _key as keyof ServerSettings
		if (typeof original[key] === 'object') {
			// @ts-expect-error it works
			result[key] = getSettingsChanged(original[key] as ServerSettings, modified[key] as ServerSettings)
		} else {
			// @ts-expect-error it works
			result[key] = original[key] !== modified[key]
		}
	}
	return result
}

export type LQStateUpdate = {
	state: ServerState
	source:
		| {
			type: 'system'
			event:
				| 'server-roll'
				| 'app-startup'
				| 'ended-early'
				| 'vote-timeout'
				| 'vote-abort'
				| 'vote-cleared'
				| 'next-layer-override'
				| 'vote-start'
				| 'admin-change-layer'
				| 'filter-delete'
				| 'next-layer-generated'
				| 'updates-to-squad-server-toggled'
				| 'teamswitches-saved'
				| 'teamswitches-executed'
		}
		// TODO bring this up to date with signature of VoteStateUpdate
		| {
			type: 'manual'
			event: 'edit-queue' | 'edit-settings'
			user: USR.MiniUser
		}
}

export function printSource(source: LQStateUpdate['source']) {
	if (source.type === 'system') {
		const eventLabels: Record<typeof source.event, string> = {
			'server-roll': 'Server rolled to next layer',
			'app-startup': 'App startup',
			'vote-timeout': 'Vote timed out',
			'vote-abort': 'Vote aborted',
			'vote-cleared': 'Vote cleared',
			'next-layer-override': 'Next layer overridden',
			'vote-start': 'Vote started',
			'admin-change-layer': 'Admin changed layer',
			'filter-delete': 'Filter deleted',
			'next-layer-generated': 'Next layer generated',
			'updates-to-squad-server-toggled': 'Updates to Squad server toggled',
			'ended-early': 'Vote ended early',
			'teamswitches-executed': 'Teamswitches Executed',
			'teamswitches-saved': 'Teamswitches Saved',
		}
		return eventLabels[source.event]
	} else {
		const eventLabels: Record<typeof source.event, string> = {
			'edit-queue': 'saved changes to the queue',
			'edit-settings': 'edited the queue settings',
		}
		return `${source.user.displayName} ${eventLabels[source.event]}`
	}
}

export const ServerIdSchema = z.string().min(1).max(256)
export type ServerId = z.infer<typeof ServerIdSchema>

export const ServerStateSchema = z.object({
	id: ServerIdSchema,
	displayName: z.string().min(1).max(256),
	layerQueueSeqId: z.int().prefault(0),
	layerQueue: LL.ListSchema,
	teamswitches: Teamswitches.TeamswitchCollectionSchema,
	settings: ServerSettingsSchema,
})

export type ServerState = z.infer<typeof ServerStateSchema>

export const SettingsPathSchema = z.array(z.union([z.string(), z.number()]))
	.refine(path => {
		// does not check the last key because it could be undefined
		const valid = checkPublicSettingsPath(path)
		if (!valid) console.warn("settings path doesn't resolve", path)
		return valid
	}, {
		error: 'Path must resolve to a valid setting',
	})

export type SettingsPath = (string | number)[]

export const SettingMutationSchema = z.object({
	path: SettingsPathSchema,
	value: z.any(),
})

export type SettingMutation = z.infer<typeof SettingMutationSchema>

export function checkPublicSettingsPath(path: SettingsPath) {
	const defaultSettings = EXAMPLE_PUBLIC_SETTINGS
	let current = defaultSettings as any
	// we can't validate the last key because it could be undefined
	for (let key of path.slice(0, -1)) {
		if (typeof key === 'number') key = 0
		current = (current as any)[key]
		if (!current) return false
	}
	return true
}

export function derefSettingsValue<T extends PublicServerSettings>(settings: T, path: SettingsPath) {
	let current = settings as any
	for (const key of path) {
		current = (current as any)[key]
		if (!current) return null
	}
	return current as unknown
}

export function applySettingMutation<T extends PublicServerSettings>(settings: T, path: SettingsPath, value: any): void
export function applySettingMutation<T extends PublicServerSettings>(settings: T, mutation: SettingMutation): void
export function applySettingMutation<T extends PublicServerSettings>(
	settings: T,
	pathOrMutation: SettingsPath | SettingMutation,
	value?: any,
) {
	const path = Array.isArray(pathOrMutation) ? pathOrMutation : pathOrMutation.path
	const resolvedValue = Array.isArray(pathOrMutation) ? value : pathOrMutation.value

	let current = settings as any
	for (let i = 0; i < path.length - 1; i++) {
		const key = path[i]
		if (!current[key]) current[key] = {}
		current = current[key]
	}
	current[path[path.length - 1]] = resolvedValue
}
export function applySettingMutations<T extends PublicServerSettings>(settings: T, mutations: SettingMutation[]) {
	for (const mutation of mutations) {
		applySettingMutation(settings, mutation.path, mutation.value)
	}
}

export function getPublicSettings(settings: ServerSettings): PublicServerSettings {
	return Obj.exclude(settings, ['connections'])
}
