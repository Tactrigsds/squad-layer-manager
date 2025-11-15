import * as Obj from '@/lib/object'
import * as CB from '@/models/constraint-builders'
import * as F from '@/models/filter.models'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import type * as USR from '@/models/users.models'
import { z } from 'zod'

const DEFAULT_REPEAT_RULES: LQY.RepeatRule[] = [
	{ label: 'Map', field: 'Map', within: 4 },
	{ label: 'Layer', field: 'Layer', within: 7 },
	{ label: 'Faction', field: 'Faction', within: 3 },
]

export const POOL_FILTER_APPLY_AS = z.enum(['regular', 'inverted', 'disabled'])
export type ConstraintApplyAs = z.infer<typeof POOL_FILTER_APPLY_AS>
export const DEFAULT_POOL_FILTER_APPLY_AS = 'regular'

export const PoolFilterConfigSchema = z.object({
	filterId: F.FilterEntityIdSchema,
	applyAs: POOL_FILTER_APPLY_AS,
})
export type PoolFilterConfig = z.infer<typeof PoolFilterConfigSchema>

export const PoolConfigurationSchema = z.object({
	filters: z.array(
		// migrate
		z.preprocess(obj => typeof obj === 'string' ? ({ filterId: obj, applyAs: DEFAULT_POOL_FILTER_APPLY_AS }) : obj, PoolFilterConfigSchema),
	),
	repeatRules: z.array(LQY.RepeatRuleSchema).refine(
		(rules) => new Set(rules.map(r => r.label)).size === rules.length,
		{ message: 'Repeat rule labels must be unique' },
	),
})

export type PoolConfiguration = z.infer<typeof PoolConfigurationSchema>
export const ServerConnectionSchema = z.object({
	rcon: z.object({
		host: z.string().nonempty(),
		port: z.number().min(1).max(65535),
		password: z.string().nonempty(),
	}),
	sftp: z.object({
		host: z.string().nonempty(),
		port: z.number().min(1).max(65535),
		username: z.string().nonempty(),
		password: z.string().nonempty(),
		logFile: z.string().nonempty(),
	}),
})
export type ServerConnection = z.infer<typeof ServerConnectionSchema>

export const QueueSettingsSchema = z.object({
	mainPool: PoolConfigurationSchema.default({ filters: [], repeatRules: DEFAULT_REPEAT_RULES }),
	// extends the main pool during automated generation
	applyMainPoolToGenerationPool: z.boolean().default(true),
	generationPool: PoolConfigurationSchema.default({ filters: [], repeatRules: [] }),
	preferredLength: z.number().default(12),
	generatedItemType: z.enum(['layer', 'vote']).default('layer'),
	preferredNumVoteChoices: z.number().default(3),
})
export type QueueSettings = z.infer<typeof QueueSettingsSchema>

export const PublicServerSettingsSchema = z
	.object({
		updatesToSquadServerDisabled: z.boolean().default(false).describe('disable SLM from setting the next layer on the server'),
		queue: QueueSettingsSchema
			// avoid sharing default queue object - TODO unclear if necessary
			.default({}).transform((obj) => Obj.deepClone(obj)),
	})
export type PublicServerSettings = z.infer<typeof PublicServerSettingsSchema>

const EXAMPLE_PUBLIC_SETTINGS = PublicServerSettingsSchema.parse({})
EXAMPLE_PUBLIC_SETTINGS.queue.mainPool.filters.push({ applyAs: DEFAULT_POOL_FILTER_APPLY_AS, filterId: 'test-filter' })

export const ServerSettingsSchema = PublicServerSettingsSchema.extend({
	connections: ServerConnectionSchema,
})

export type ServerSettings = z.infer<typeof ServerSettingsSchema>
export type Changed<T> = {
	[K in keyof T]: T[K] extends object ? Changed<T[K]> : boolean
}

export type SettingsChanged = Changed<ServerSettings>

// note the QueryConstraint is not perfectly suited to this kind of use-case as we have to arbitrarily specify apply-as
export function getSettingsConstraints(
	settings: PublicServerSettings,
	opts?: { generatingLayers?: boolean },
) {
	const constraints: LQY.Constraint[] = []
	const poolConfigs: Record<string, PoolConfiguration> = { main: settings.queue.mainPool, generation: settings.queue.generationPool }
	if (!opts?.generatingLayers) {
		delete poolConfigs.generation
	} else if (!settings.queue.applyMainPoolToGenerationPool) {
		delete poolConfigs.mainPool
	}

	for (const [poolName, poolConfig] of Object.entries(poolConfigs)) {
		for (let j = 0; j < poolConfig.repeatRules.length; j++) {
			const rule = poolConfig.repeatRules[j]
			// label/field might not be unique so we're doing this instead. cringe
			constraints.push(CB.repeatRule(`layer-pool:${rule.label}`, rule, { filterResults: true, invert: true }))
		}

		for (const { filterId, applyAs } of poolConfig.filters) {
			constraints.push(
				CB.filterEntity(`layer-pool:${poolName}:${filterId}`, filterId, {
					filterResults: applyAs !== 'disabled',
					invert: applyAs === 'inverted',
				}),
			)
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
				| 'vote-timeout'
				| 'vote-abort'
				| 'vote-cleared'
				| 'next-layer-override'
				| 'vote-start'
				| 'admin-change-layer'
				| 'filter-delete'
				| 'next-layer-generated'
				| 'updates-to-squad-server-toggled'
		}
		// TODO bring this up to date with signature of VoteStateUpdate
		| {
			type: 'manual'
			event: 'edit'
			user: USR.GuiOrChatUserId
		}
}

export const ServerIdSchema = z.string().min(1).max(256)
export type ServerId = z.infer<typeof ServerIdSchema>

export const ServerStateSchema = z.object({
	id: ServerIdSchema,
	displayName: z.string().min(1).max(256),
	lastRoll: z.date().nullable(),
	layerQueueSeqId: z.number().int().default(0),
	layerQueue: LL.ListSchema,
	settings: ServerSettingsSchema,
})

export type ServerState = z.infer<typeof ServerStateSchema>

export const SettingsPathSchema = z.array(z.union([z.string(), z.number()]))
	.refine(path => {
		// does not check the last key because it could be undefined
		const valid = checkPublicSettingsPath(path)
		if (!valid) console.warn("settings path doesn't resolve", path)
		return valid
	}, { message: 'Path must resolve to a valid setting' })

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
