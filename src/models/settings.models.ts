import * as DH from '@/lib/display-helpers.ts'
import * as Obj from '@/lib/object'
import { BasicStrNoWhitespace, HumanTime } from '@/lib/zod'
import * as BAL from '@/models/balance-triggers.models.ts'
import * as BM from '@/models/battlemetrics.models.ts'
import * as CHAT from '@/models/chat.models.ts'
import * as CMD from '@/models/command.models.ts'
import * as CB from '@/models/constraint-builders'
import * as F from '@/models/filter.models'
import * as LQY from '@/models/layer-queries.models'
import * as SM from '@/models/squad.models'
import { z } from 'zod'

export const NavLinkSchema = z.array(z.object({
	label: z.string(),
	url: z.url(),
}))

// ============================== global settings ==============================

export const GlobalSettingsSchema = z.object({
	topBarColor: z.string().prefault('green').nullable().describe('set to null for production'),
	warnPrefix: z.string().nullable().prefault('SLM: ').describe('Prefix to use for warnings'),
	postRollAnnouncementsTimeout: HumanTime.prefault('5m').describe('How long to wait before sending post-roll reminders'),
	fogOffDelay: HumanTime.prefault('25s').describe('Delay before fog is automatically turned off'),
	chat: CHAT.ChatConfigSchema.prefault({}),
	layerQueue: z.object({
		lowQueueWarningThreshold: z
			.number()
			.positive()
			.prefault(1)
			.describe('Number of layers in the queue to trigger a low queue size warning'),
		adminQueueReminderInterval: HumanTime.prefault('10m').describe(
			'How often to remind admins to maintain the queue. Low queue warnings happen half as often.',
		),
		maxQueueSize: z.int().min(1).max(100).prefault(20).describe('Maximum number of layers that can be in the queue'),
	}).prefault({}),
	vote: z.object({
		voteDuration: HumanTime.prefault('180s').describe('Duration of a vote'),
		startVoteReminderThreshold: HumanTime.prefault('20m').describe('How far into a match to start reminding admins to start a vote'),
		voteReminderInterval: HumanTime.prefault('30s').describe('How often to remind users to vote'),
		internalVoteReminderInterval: HumanTime.prefault('15s').describe('How often to remind admins to vote in an internal vote'),
		autoStartVoteDelay: HumanTime.prefault('20m').nullable().describe(
			'Delay before autostarting a vote from the start of the current match. Set to null to disable',
		),
		autoStartVoteCutoff: HumanTime.prefault('30m').describe(
			'How far into a match to stop auto-starting votes',
		),
		voteDisplayProps: z.array(DH.LAYER_DISPLAY_PROP).prefault(['map', 'gamemode']).describe(
			'What parts of a layer setup should be displayed',
		),
		finalVoteReminder: HumanTime.prefault('10s').describe('How far in advance the final vote reminder should be sent'),
		maxNumVoteChoices: z.int().min(1).max(50).prefault(5).describe('Maximum number of choices allowed in a vote'),
	}).prefault({}),
	squadServer: z.object({
		sftpPollInterval: HumanTime.prefault('1s'),
		sftpReconnectInterval: HumanTime.prefault('5s'),
		sftpMaxReconnectAttempts: z.int().min(1).prefault(10).describe(
			'How many consecutive SFTP failures to tolerate (reconnecting between each) before tearing down the server slice',
		),
		tickRateThresholds: z.object({
			good: z.number().positive().prefault(60).describe(
				'At or above this tick rate the live server tick rate displays as good (green)',
			),
			warning: z.number().positive().prefault(50).describe(
				'At or above this tick rate (but below the good threshold) the tick rate displays as a warning (yellow); below it, as unhealthy (red)',
			),
		}).prefault({}).describe('Thresholds for coloring the live server tick rate display'),
	}).prefault({}),
	steamLinkCodeExpiry: HumanTime.prefault('15m').describe('Duration of a steam account link code'),
	balanceTriggerLevels: z.partialRecord(BAL.TRIGGER_IDS, BAL.TRIGGER_LEVEL)
		.prefault({ '150x2': 'warn' })
		.describe('Configures the trigger warning levels for balance calculations'),
	playerFlagColorHierarchy: z.array(z.uuid()).optional(),
	playerFlagsRequiringNote: z.array(z.uuid()).prefault([]).describe(
		"Flags (by id) that require a reason to be given when added, which is included in the note posted to the player's BattleMetrics profile",
	),
	playerFlagGroupings: BM.PlayerFlagGroupingsSchema.optional(),
	navLinks: NavLinkSchema.optional().describe('Global links to display in the navbar dropdown menu'),
	warnOnSlmStart: z.boolean().prefault(false),
	adminListSources: z.record(z.string(), SM.AdminListSourceSchema).prefault({}).describe('Named admin list sources'),
	commandPrefix: BasicStrNoWhitespace.prefault('!').describe('Prefix character for in-game commands'),
	commands: CMD.AllCommandConfigSchema,
})

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>
// the pre-decode shape (e.g. HumanTime fields as '5m' strings instead of milliseconds) -- what gets persisted/displayed for editing
export type GlobalSettingsInput = z.input<typeof GlobalSettingsSchema>

// ============================== per-server settings ==============================

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
		remindersAndAnnouncementsEnabled: z.boolean().prefault(true).describe('Whether reminders/announcements for admins are enabled'),
		overrideAdminSetNextLayer: z.boolean().prefault(false).describe(
			'Whether AdminSetNextLayer commands not originating from SLM are respected',
		),
		warnOnChangeLayer: z.boolean().prefault(false).describe('Warn admins when the next layer is changed'),
	})

export type PublicServerSettings = z.infer<typeof PublicServerSettingsSchema>

const EXAMPLE_PUBLIC_SETTINGS = PublicServerSettingsSchema.parse({})
EXAMPLE_PUBLIC_SETTINGS.queue.mainPool.filters.push({ showIndicator: DEFAULT_POOL_FILTER_APPLY_AS, filterId: 'test-filter' })
EXAMPLE_PUBLIC_SETTINGS.queue.generationPool.filters.push({ applyAs: DEFAULT_POOL_FILTER_APPLY_AS, filterId: 'test-filter' })

export const ServerSettingsSchema = PublicServerSettingsSchema.extend({
	connections: ServerConnectionSchema,
	adminListSources: z.array(z.string()),
	adminIdentifyingPermissions: z.array(SM.PLAYER_PERM),
	navLinks: NavLinkSchema.optional().describe('Server-specific links to display in the navbar dropdown menu'),
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

export function derefSettingsValue(settings: PublicServerSettings, path: SettingsPath) {
	let current = settings as any
	for (const key of path) {
		current = (current as any)[key]
		if (!current) return null
	}
	return current as unknown
}

export function applySettingMutation(settings: PublicServerSettings, path: SettingsPath, value: any): void
export function applySettingMutation(settings: PublicServerSettings, mutation: SettingMutation): void
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
export function applySettingMutations(settings: PublicServerSettings, mutations: SettingMutation[]) {
	for (const mutation of mutations) {
		applySettingMutation(settings, mutation.path, mutation.value)
	}
}

export function getPublicSettings(settings: ServerSettings): PublicServerSettings {
	return Obj.exclude(settings, ['connections'])
}
