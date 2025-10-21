import * as Obj from '@/lib/object'
import * as F from '@/models/filter.models'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as USR from '@/models/users.models'
import { z } from 'zod'

const DEFAULT_REPEAT_RULES: LQY.RepeatRule[] = [
	{ field: 'Map', within: 4 },
	{ field: 'Layer', within: 7 },
	{ field: 'Faction', within: 3 },
]

export const PoolConfigurationSchema = z.object({
	filters: z.array(F.FilterEntityIdSchema),
	repeatRules: z.array(LQY.RepeatRuleSchema),
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

export const ServerSettingsSchema = PublicServerSettingsSchema.extend({
	connections: ServerConnectionSchema,
})

export type ServerSettings = z.infer<typeof ServerSettingsSchema>
export type Changed<T> = {
	[K in keyof T]: T[K] extends object ? Changed<T[K]> : boolean
}

export type SettingsChanged = Changed<ServerSettings>

// note the QueryConstraint is not perfectly suited to this kind of use-case as we have to arbitrarily specify apply-as
export function getPoolConstraints(
	poolConfig: PoolConfiguration,
	applyAsDnr: LQY.LayerQueryConstraint['applyAs'] = 'field',
	applyAsFilterEntiry: LQY.LayerQueryConstraint['applyAs'] = 'field',
) {
	const constraints: LQY.LayerQueryConstraint[] = []

	for (const rule of poolConfig.repeatRules) {
		constraints.push({
			type: 'do-not-repeat',
			rule,
			id: 'layer-pool:' + rule.field,
			name: rule.field,
			applyAs: applyAsDnr,
		})
	}

	for (const filterId of poolConfig.filters) {
		constraints.push({
			type: 'filter-entity',
			id: 'pool:' + filterId,
			filterEntityId: filterId,
			applyAs: applyAsFilterEntiry,
		})
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
export type SettingsPath = (string | number)[]

export const SettingMutationSchema = z.object({
	path: SettingsPathSchema,
	value: z.any(),
})
	.refine(mut => !!derefSettingsSchema(mut.path), { message: 'Path must resolve to a valid setting' })
	.refine(mut => {
		const schema = derefSettingsSchema(mut.path)
		if (!schema) return false
		return schema.safeParse(mut.value).success
	}, { message: `Invalid value for setting` })
export type SettingMutation = z.infer<typeof SettingMutationSchema>

export function idk() {
}

export function derefSettingsSchema(path: SettingsPath): z.ZodAny | null {
	let current: any = ServerSettingsSchema
	for (const key of path) {
		if (typeof key === 'number') {
			if (!('element' in current)) return null
			current = current.element as z.ZodAny
		} else {
			current = (current as any).shape[key]
			if (!current) return null
		}
	}
	return current as unknown as z.ZodAny
}

export function derefSettingsValue<T extends PublicServerSettings>(settings: T, path: SettingsPath) {
	let current = settings as any
	for (const key of path) {
		current = (current as any)[key]
		if (!current) return null
	}
	return current as unknown
}

function setPathValue<T extends PublicServerSettings>(settings: T, path: SettingsPath, value: any) {
	let current = settings as any
	for (let i = 0; i < path.length - 1; i++) {
		const key = path[i]
		if (!current[key]) current[key] = {}
		current = current[key]
	}
	current[path[path.length - 1]] = value
}

export function applySettingMutations<T extends PublicServerSettings>(settings: T, mutations: SettingMutation[]) {
	for (const mutation of mutations) {
		setPathValue(settings, mutation.path, mutation.value)
	}
	return settings
}

export function getPublicSettings(settings: ServerSettings): PublicServerSettings {
	return Obj.exclude(settings, ['connections'])
}
