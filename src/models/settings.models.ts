import * as DH from '@/lib/display-helpers.ts'
import * as Obj from '@/lib/object'
import { BasicStrNoWhitespace, HumanTime, ParsableBigIntSchema } from '@/lib/zod'
import * as AAR from '@/models/admin-action-reasons.models.ts'
import * as BAL from '@/models/balance-triggers.models.ts'
import * as BM from '@/models/battlemetrics.models.ts'
import * as CHAT from '@/models/chat.models.ts'
import * as CMD from '@/models/command.models.ts'
import * as CB from '@/models/constraint-builders'
import * as F from '@/models/filter.models'
import * as LP from '@/models/labeled-presets.models'
import * as LQY from '@/models/layer-queries.models'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import { z } from 'zod'

// ============================== rbac (moved out of the deploy-time config so it's admin-editable at runtime) ==============================

// discord ids are kept as strings here (not bigint) so they round-trip cleanly through the JSON settings editor / settings GUI;
// rbac.server converts them to bigint at the boundary
// `roles` is the source of truth for which roles exist; every role referenced in `roleAssignments` must be defined there
// (enforced by the check below, mirrored in the GUI by keying the assignment role pickers to the defined roles).
// dotted path into a settings document, e.g. "vote.voteDuration" or just "vote" for the whole section
const SettingsGrantPathSchema = z.string().trim().min(1).regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, {
	error: 'Must be a dotted setting path, e.g. "vote.voteDuration"',
})

export const RbacSettingsSchema = z.object({
	roles: z
		.record(RBAC.UserDefinedRoleIdSchema, z.array(RBAC.ROLE_PERMISSION_EXPRESSION))
		.prefault({})
		.describe(
			'Defined roles and their permissions. The source of truth for which roles exist. '
				+ 'Settings permissions granted here are unrestricted (all servers / all settings); use the settings-grants maps below for restricted grants.',
		),
	roleAssignments: z.object({
		'discord-role': z.array(z.object({ discordRoleId: ParsableBigIntSchema, roles: z.array(RBAC.UserDefinedRoleIdSchema) })).prefault([]),
		'discord-user': z.array(z.object({ userId: ParsableBigIntSchema, roles: z.array(RBAC.UserDefinedRoleIdSchema) })).prefault([]),
		// there is only one "every member" bucket, so this is a flat list of roles rather than a keyed, repeatable list
		'discord-server-member': z.array(RBAC.UserDefinedRoleIdSchema).prefault([]).describe(
			'Roles granted to every member of the Discord server',
		),
	}).prefault({}).describe('Which discord roles/users/members are granted which roles'),
	// "up to N" comparisons can't ride the permission-expression grammar (grants are equality-matched),
	// so per-role timeout caps live in their own map. Negation doesn't apply: remove the entry instead.
	maxTimeouts: z.record(RBAC.UserDefinedRoleIdSchema, HumanTime).prefault({}).describe(
		'Per-role maximum kick-timeout duration (e.g. "2h"). Roles absent here cannot issue timeouts. Super users/roles are unlimited.',
	),
	// restricted settings grants, like maxTimeouts these carry arguments the expression grammar can't: they let a role
	// edit only specific settings (and for servers, only specific servers). Unrestricted access is granted via `roles`.
	globalSettingsGrants: z.record(RBAC.UserDefinedRoleIdSchema, z.array(SettingsGrantPathSchema)).prefault({}).describe(
		'Per-role restricted global-settings write grants: dotted setting paths the role may edit (e.g. "vote.voteDuration", or "vote" for the whole section). '
			+ 'Any grant also lets the role view global settings. A "!global-settings:write" denial in Roles overrides these.',
	),
	serverSettingsGrants: z.record(
		RBAC.UserDefinedRoleIdSchema,
		z.array(z.object({
			access: z.enum(['read', 'write', 'write-sensitive']).prefault('write').describe(
				'read = view settings (never connection details); write = edit non-sensitive settings; write-sensitive = view and edit the RCON/SFTP connection details',
			),
			serverIds: z.array(z.string()).prefault([]).describe('Server ids this grant applies to; empty = all servers'),
			paths: z.array(SettingsGrantPathSchema).prefault([]).describe(
				'Write grants only: dotted setting paths to restrict the grant to (e.g. "queue.mainPool"); empty = all non-sensitive settings',
			),
		})),
	).prefault({}).describe(
		"Per-role restricted server-settings grants. Any grant also lets the role view the server's (non-sensitive) settings. "
			+ 'Matching "!server-settings:*" denials in Roles override these.',
	),
}).superRefine((val, ctx) => {
	const defined = new Set(Object.keys(val.roles ?? {}))
	const checkRole = (role: string, path: (string | number)[]) => {
		if (!defined.has(role)) ctx.addIssue({ code: 'custom', message: `Role "${role}" is not defined in Roles`, path })
	}
	for (const type of ['discord-role', 'discord-user'] as const) {
		val.roleAssignments[type].forEach((assignment, i) => {
			assignment.roles.forEach((role, j) => checkRole(role, ['roleAssignments', type, i, 'roles', j]))
		})
	}
	val.roleAssignments['discord-server-member'].forEach((role, j) => checkRole(role, ['roleAssignments', 'discord-server-member', j]))
	for (const role of Object.keys(val.maxTimeouts ?? {})) checkRole(role, ['maxTimeouts', role])
	// only the first path segment is validated (deeper segments that don't resolve simply never match a write)
	for (const [role, paths] of Object.entries(val.globalSettingsGrants ?? {})) {
		checkRole(role, ['globalSettingsGrants', role])
		paths.forEach((p, i) => {
			const head = p.split('.')[0]
			if (!globalSettingsTopLevelKeys().includes(head)) {
				ctx.addIssue({ code: 'custom', message: `"${head}" is not a global setting`, path: ['globalSettingsGrants', role, i] })
			}
		})
	}
	for (const [role, grants] of Object.entries(val.serverSettingsGrants ?? {})) {
		checkRole(role, ['serverSettingsGrants', role])
		grants.forEach((grant, i) => {
			if (grant.access !== 'write' && grant.paths.length > 0) {
				ctx.addIssue({
					code: 'custom',
					message: 'Paths only apply to write grants',
					path: ['serverSettingsGrants', role, i, 'paths'],
				})
			}
			grant.paths.forEach((p, j) => {
				const head = p.split('.')[0]
				if (!serverSettingsGrantableTopLevelKeys().includes(head)) {
					ctx.addIssue({
						code: 'custom',
						message: `"${head}" is not a grantable server setting`,
						path: ['serverSettingsGrants', role, i, 'paths', j],
					})
				}
			})
		})
	}
}).prefault({})

// hoisted so the RbacSettingsSchema refine above can call them at parse time (the schemas are declared further down)
export function globalSettingsTopLevelKeys(): string[] {
	return Object.keys(GlobalSettingsSchema.shape)
}
// connections are deliberately excluded: they're only reachable via server-settings:write-sensitive, never a path grant
export function serverSettingsGrantableTopLevelKeys(): string[] {
	return Object.keys(ServerSettingsSchema.shape).filter((k) => k !== 'connections')
}

export type RbacSettings = z.infer<typeof RbacSettingsSchema>

export const NavLinkSchema = z.array(z.object({
	label: z.string(),
	url: z.url(),
}))

// ============================== global settings ==============================

export const GlobalSettingsSchema = z.object({
	topBarColor: z.string().prefault('green').nullable().describe('set to null for production'),
	warnPrefix: z.string().nullable().prefault('SLM: ').describe(
		'Prefix applied to admin-directed warns (admin notifications and in-game command feedback). Never applied to warns delivered to affected players.',
	),
	adminActionReasons: AAR.AdminActionReasonsSchema.describe(
		'Preset reasons admins can pick when performing actions against players. Each reason carries separate text per action it applies to, and is available for an action only if it has text for that action (so every reason needs at least one action text). Text is sent verbatim to the affected player(s) in-game and supports {{variables}}. '
			+ 'Available: {{label}}, {{duration}} (timeouts only), plus any Message Variables below.',
	),
	broadcasts: LP.BroadcastPresetsSchema.describe(
		'Preset broadcast messages selectable by label or alias via the in-game broadcast command. Messages support {{variables}}: {{label}} plus any Message Variables below.',
	),
	requireReasonFor: z.array(AAR.REQUIRABLE_ADMIN_ACTION_TYPE).prefault([]).describe(
		'Actions that require a reason (a preset or custom text). Performing one of these without a reason is rejected. Warns always require a reason, so they are not listed here.',
	),
	messageVariables: z.array(z.object({
		name: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
			error: 'Letters, digits and underscore only; must not start with a digit',
		}),
		value: z.string(),
	})).prefault([]).describe(
		'Custom variables usable in reason and broadcast messages as {{name}} (e.g. name "discord", value "discord.gg/xyz").',
	),
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
	timeoutCommandAliases: z.array(z.object({
		string: BasicStrNoWhitespace.describe('Command string (without the prefix)'),
		duration: HumanTime.describe('Fixed timeout duration this alias kicks with'),
	})).prefault([]).describe(
		'Extra admin-chat commands that kick with a fixed timeout, e.g. yeet = 2h. Real command strings win on collision.',
	),
	commands: CMD.AllCommandConfigSchema,
	rbac: RbacSettingsSchema,
	layerTable: LQY.LayerTableConfigSchema.prefault({
		orderedColumns: [
			{ name: 'id', visible: false },
			{ name: 'Size' },
			{ name: 'Layer' },
			{ name: 'Map', visible: false },
			{ name: 'Gamemode', visible: false },
			{ name: 'LayerVersion', visible: false },

			{ name: 'Faction_1' },
			{ name: 'Unit_1' },
			{ name: 'Alliance_1', visible: false },

			{ name: 'Faction_2' },
			{ name: 'Unit_2' },
			{ name: 'Alliance_2', visible: false },
		],
		defaultSortBy: { type: 'random' },
	}).describe('Configures the columns, default sort, and extra menu items of the layer table'),
}).superRefine((val, ctx) => {
	// command strings and timeout-alias strings share one namespace: a real command always wins on collision, so
	// a timeout alias that clashes is unreachable (and vice versa). matching is case-insensitive, like dispatch.
	const prefix = val.commandPrefix ?? '!'
	const commandOwner = new Map<string, string>()
	for (const [id, cmd] of Object.entries(val.commands ?? {})) {
		// strings are stored without the prefix (dispatch strips one prefix char before matching), so a string that
		// bakes in the prefix would only ever trigger on a doubled prefix. reject it to prevent that misconfiguration.
		;(cmd.strings ?? []).forEach((s, j) => {
			if (prefix && s.startsWith(prefix)) {
				ctx.addIssue({
					code: 'custom',
					message: `Command string "${s}" must not include the command prefix "${prefix}"`,
					path: ['commands', id, 'strings', j],
				})
			}
			commandOwner.set(s.toLowerCase(), id)
		})
	}
	const seenAlias = new Set<string>()
	val.timeoutCommandAliases?.forEach((alias, i) => {
		const key = alias.string.toLowerCase()
		if (prefix && alias.string.startsWith(prefix)) {
			ctx.addIssue({
				code: 'custom',
				message: `Timeout alias "${alias.string}" must not include the command prefix "${prefix}"`,
				path: ['timeoutCommandAliases', i, 'string'],
			})
		}
		const owner = commandOwner.get(key)
		if (owner) {
			ctx.addIssue({
				code: 'custom',
				message: `Timeout alias "${alias.string}" clashes with the command "${owner}". Pick a different string.`,
				path: ['timeoutCommandAliases', i, 'string'],
			})
		}
		if (seenAlias.has(key)) {
			ctx.addIssue({ code: 'custom', message: `Duplicate timeout alias "${alias.string}"`, path: ['timeoutCommandAliases', i, 'string'] })
		}
		seenAlias.add(key)
	})
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
	inPool: POOL_FILTER_APPLY_AS.optional().meta({
		description:
			'Whether this filter defines main-pool membership. Layers that fail an active inPool filter can only be added to or set in the queue by users with the queue:force-write permission. Invert to require that pool layers do NOT match this filter. Defaults to disabled (this filter does not gate the pool).',
	}).optional(),
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

// what a server-settings:read (without write-sensitive) user sees and edits: everything but the connection details
export const ServerSettingsNoConnectionsSchema = ServerSettingsSchema.omit({ connections: true })
export type ServerSettingsNoConnections = z.infer<typeof ServerSettingsNoConnectionsSchema>

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

// constraints describing which layers belong to the main pool, used to gate queue:force-write. only mainPool filters
// with an active `inPool` apply-state participate; if none are configured the pool is unconstrained (force-write inert).
export function getPoolMembershipConstraints(settings: PublicServerSettings): LQY.Constraint[] {
	const constraints: LQY.Constraint[] = []
	for (const { filterId, inPool } of settings.queue.mainPool.filters) {
		if (!inPool || inPool === 'disabled') continue
		constraints.push(
			CB.filterEntity(getFilterEntityConstraintId('mainPool', { filterId }), filterId, { filterApplState: inPool }),
		)
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
