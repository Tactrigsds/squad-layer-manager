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

export const ServerSettingsSchema = z
	.object({
		updatesToSquadServerDisabled: z.boolean().default(false).describe('disable SLM from setting the next layer on the server'),
		// should *always* be omitted on the frontend
		connections: ServerConnectionSchema.optional(),
		queue: QueueSettingsSchema
			// avoid sharing default queue object - TODO unclear if necessary
			.default({}).transform((obj) => Obj.deepClone(obj)),
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

export const UserModifiableServerStateSchema = z.object({
	layerQueueSeqId: z.number().int(),
	layerQueue: LL.ListSchema,
	settings: ServerSettingsSchema,
})

export type UserModifiableServerState = z.infer<typeof UserModifiableServerStateSchema>
export type LQStateUpdate = {
	state: LQServerState
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

export const ServerStateSchema = UserModifiableServerStateSchema.extend({
	id: ServerIdSchema,
	displayName: z.string().min(1).max(256),
	lastRoll: z.date().nullable(),
})

export type LQServerState = z.infer<typeof ServerStateSchema>

export const GenericServerStateUpdateSchema = UserModifiableServerStateSchema
