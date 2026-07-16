import * as DH from '@/lib/display-helpers.ts'
import * as Obj from '@/lib/object'
import { BasicStrNoWhitespace, HumanTime, ParsableBigIntSchema } from '@/lib/zod'
import * as AAR from '@/models/admin-action-reasons.models.ts'
import * as BAL from '@/models/balance-triggers.models.ts'
import * as CHAT from '@/models/chat.models.ts'
import * as CMD from '@/models/command.models.ts'
import * as CB from '@/models/constraint-builders'
import * as F from '@/models/filter.models'
import * as LP from '@/models/labeled-presets.models'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as PG from '@/models/player-groupings.models'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import { z } from 'zod'

// ============================== rbac (moved out of the deploy-time config so it's admin-editable at runtime) ==============================

// Everything about a role lives under `roles[roleId]`: its permissions, timeout cap, restricted settings grants, and
// which discord entities it's assigned to. Consolidating per-role (rather than five parallel role-keyed maps) makes the
// "a role must be defined to be referenced" invariant structural, so the schema no longer has to police it.
// dotted path into a settings document, e.g. "vote.voteDuration" or just "vote" for the whole section
const SettingsGrantPathSchema = z.string().trim().min(1).regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, {
	error: 'Must be a dotted setting path, e.g. "vote.voteDuration"',
})

// discord ids are kept as strings here (ParsableBigInt) so they round-trip cleanly through the JSON settings editor /
// settings GUI; rbac.server converts them to bigint at the boundary
const RoleAssignmentsSchema = z.object({
	discordRoleIds: z.array(ParsableBigIntSchema).prefault([]).describe('Discord role ids whose members are granted this role'),
	discordUserIds: z.array(ParsableBigIntSchema).prefault([]).describe('Discord user ids granted this role'),
	everyMember: z.boolean().prefault(false).describe('Grant this role to every member of the Discord server'),
}).prefault({})

const ServerSettingsGrantSchema = z.object({
	access: z.enum(['read', 'write', 'write-sensitive']).prefault('write').describe(
		'read = view settings (never connection details); write = edit non-sensitive settings; write-sensitive = view and edit the RCON/SFTP connection details',
	),
	serverIds: z.array(z.string()).prefault([]).describe('Server ids this grant applies to; empty = all servers'),
	paths: z.array(SettingsGrantPathSchema).prefault([]).describe(
		'Write grants only: dotted setting paths to restrict the grant to (e.g. "queue.mainPool"); empty = all non-sensitive settings',
	),
})

const RoleConfigSchema = z.object({
	permissions: z.array(RBAC.ROLE_PERMISSION_EXPRESSION).prefault([]).describe(
		'Permissions granted by this role. Settings permissions granted here are unrestricted (all servers / all settings); '
			+ 'use the settings-grants below for restricted grants.',
	),
	// "up to N" comparisons can't ride the permission-expression grammar (grants are equality-matched), so the timeout cap
	// is its own field. Absent = the role cannot issue timeouts; negation doesn't apply, drop the field instead.
	maxTimeout: HumanTime.optional().describe(
		'Maximum kick-timeout duration (e.g. "2h"). Absent = this role cannot issue timeouts. Super users/roles are unlimited.',
	),
	// restricted settings grants, like maxTimeout these carry arguments the expression grammar can't: they let the role
	// edit only specific settings (and for servers, only specific servers). Unrestricted access is granted via `permissions`.
	globalSettingsGrants: z.array(SettingsGrantPathSchema).prefault([]).describe(
		'Restricted global-settings write grants: dotted setting paths the role may edit (e.g. "vote.voteDuration", or "vote" for the whole section). '
			+ 'Any grant also lets the role view global settings. A "!global-settings:write" denial in permissions overrides these.',
	),
	serverSettingsGrants: z.array(ServerSettingsGrantSchema).prefault([]).describe(
		"Restricted server-settings grants. Any grant also lets the role view the server's (non-sensitive) settings. "
			+ 'Matching "!server-settings:*" denials in permissions override these.',
	),
	assignments: RoleAssignmentsSchema.describe('Which discord roles/users/members are granted this role'),
}).describe('Everything about a role: its permissions, timeout cap, restricted settings grants and assignments')

export const RbacSettingsSchema = z.object({
	roles: z.record(RBAC.UserDefinedRoleIdSchema, RoleConfigSchema).prefault({}).describe(
		'Defined roles, keyed by id. Each holds its own permissions, timeout cap, settings grants and assignments.',
	),
}).superRefine((val, ctx) => {
	// only the first path segment is validated (deeper segments that don't resolve simply never match a write)
	for (const [role, cfg] of Object.entries(val.roles ?? {})) {
		cfg.globalSettingsGrants.forEach((p, i) => {
			const head = p.split('.')[0]
			if (!globalSettingsTopLevelKeys().includes(head)) {
				ctx.addIssue({ code: 'custom', message: `"${head}" is not a global setting`, path: ['roles', role, 'globalSettingsGrants', i] })
			}
		})
		cfg.serverSettingsGrants.forEach((grant, i) => {
			if (grant.access !== 'write' && grant.paths.length > 0) {
				ctx.addIssue({
					code: 'custom',
					message: 'Paths only apply to write grants',
					path: ['roles', role, 'serverSettingsGrants', i, 'paths'],
				})
			}
			grant.paths.forEach((p, j) => {
				const head = p.split('.')[0]
				if (!serverSettingsGrantableTopLevelKeys().includes(head)) {
					ctx.addIssue({
						code: 'custom',
						message: `"${head}" is not a grantable server setting`,
						path: ['roles', role, 'serverSettingsGrants', i, 'paths', j],
					})
				}
			})
		})
	}
	// default to the tiered admins/managers/owners preset (see defaultRbacSettings). Lazy thunk because the preset reads
	// GlobalSettingsSchema, which is declared further down; also drives fresh-install seeding and the form's reset-to-default.
}).prefault(() => defaultRbacSettings())

// hoisted so the RbacSettingsSchema refine above can call them at parse time (the schemas are declared further down)
export function globalSettingsTopLevelKeys(): string[] {
	return Object.keys(GlobalSettingsSchema.shape)
}
// connections are deliberately excluded: they're only reachable via server-settings:write-sensitive, never a path grant
export function serverSettingsGrantableTopLevelKeys(): string[] {
	return Object.keys(ServerSettingsSchema.shape).filter((k) => k !== 'connections')
}

export type RbacSettings = z.infer<typeof RbacSettingsSchema>

// Grants reference settings by path, so a setting a later SLM release renames or removes leaves behind grants the
// RbacSettingsSchema refine above rejects -- taking the whole install down at boot over a reference that is merely
// stale. Drop those grants instead (same reasoning as unresolvable command aliases below) and hand the caller a
// description of each one to report. Operates on raw settings, so it must run before the schema parses them.
export function trimStaleSettingsGrants(raw: unknown): { settings: unknown; dropped: string[] } {
	const dropped: string[] = []
	if (!raw || typeof raw !== 'object') return { settings: raw, dropped }
	const rbac = (raw as Record<string, unknown>).rbac
	if (!rbac || typeof rbac !== 'object') return { settings: raw, dropped }
	const rolesRaw = (rbac as Record<string, unknown>).roles
	if (!rolesRaw || typeof rolesRaw !== 'object') return { settings: raw, dropped }

	const globalKeys = globalSettingsTopLevelKeys()
	const serverKeys = serverSettingsGrantableTopLevelKeys()
	// only the head segment is checked, matching the refine: deeper segments that don't resolve simply never match a write
	const keepPaths = (paths: unknown, liveKeys: string[], describe: (path: string, index: number) => string) => {
		if (!Array.isArray(paths)) return paths
		const kept = paths.filter((p, i) => {
			if (typeof p !== 'string' || liveKeys.includes(p.split('.')[0])) return true
			dropped.push(describe(p, i))
			return false
		})
		return kept.length === paths.length ? paths : kept
	}

	let rolesChanged = false
	const roles: Record<string, unknown> = {}
	for (const [roleId, cfgRaw] of Object.entries(rolesRaw as Record<string, unknown>)) {
		roles[roleId] = cfgRaw
		if (!cfgRaw || typeof cfgRaw !== 'object') continue
		const cfg = cfgRaw as Record<string, unknown>

		const globalGrants = keepPaths(
			cfg.globalSettingsGrants,
			globalKeys,
			(path, i) => `rbac.roles.${roleId}.globalSettingsGrants[${i}] ("${path}")`,
		)

		let serverGrants = cfg.serverSettingsGrants
		if (Array.isArray(serverGrants)) {
			const nextGrants = serverGrants.map((grantRaw, gi) => {
				if (!grantRaw || typeof grantRaw !== 'object') return grantRaw
				const grant = grantRaw as Record<string, unknown>
				const paths = keepPaths(
					grant.paths,
					serverKeys,
					(path, i) => `rbac.roles.${roleId}.serverSettingsGrants[${gi}].paths[${i}] ("${path}")`,
				)
				return paths === grant.paths ? grantRaw : { ...grant, paths }
			})
			if (nextGrants.some((g, i) => g !== (serverGrants as unknown[])[i])) serverGrants = nextGrants
		}

		if (globalGrants === cfg.globalSettingsGrants && serverGrants === cfg.serverSettingsGrants) continue
		roles[roleId] = { ...cfg, globalSettingsGrants: globalGrants, serverSettingsGrants: serverGrants }
		rolesChanged = true
	}
	if (!rolesChanged) return { settings: raw, dropped }
	return { settings: { ...(raw as Record<string, unknown>), rbac: { ...(rbac as Record<string, unknown>), roles } }, dropped }
}

export const NavLinkSchema = z.array(z.object({
	label: z.string(),
	url: z.url(),
}))

// ============================== global settings ==============================

export const GlobalSettingsSchema = z.object({
	topBarColor: z.string().prefault('green').nullable().describe(
		'Tints the top navigation bar so non-production environments are visually distinct. Set to null in production to disable the tint.',
	),
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
	chat: CHAT.ChatConfigSchema.prefault({}).describe(
		'Live chat/event feed settings, including regex patterns for suppressing noisy warn and broadcast messages.',
	),
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
			'What parts of a layer setup should be displayed by default',
		),
		finalVoteReminder: HumanTime.prefault('10s').describe('How far in advance the final vote reminder should be sent'),
		maxNumVoteChoices: z.int().min(1).max(50).prefault(5).describe('Maximum number of choices allowed in a vote'),
	}).prefault({}),
	squadServer: z.object({
		logFilePollInterval: HumanTime.prefault('1s').describe('How often a local-file log source checks the log for new lines.'),
		rconCacheTTL: z.object({
			layersStatus: HumanTime.prefault('5s').describe(
				'How stale the cached current/next layer may be before a read refetches it over RCON.',
			),
			serverInfo: HumanTime.prefault('10s').describe(
				'How stale cached server info (player count, tick rate) may be before a read refetches it over RCON.',
			),
			teams: HumanTime.prefault('5s').describe(
				'How stale the cached roster may be before a read refetches it over RCON. Also the interval at which observers poll ListPlayers.',
			),
		}).prefault({}).describe(
			'How long RCON responses stay cached. Lower means fresher data and more RCON traffic; these are the dominant source of roster/status latency.',
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
	playerFlagsRequiringNote: z.array(z.uuid()).prefault([]).describe(
		"Flags (by id) that require a reason to be given when added, which is included in the note posted to the player's BattleMetrics profile",
	),
	playerGroupings: PG.PlayerGroupingsSchema.prefault(PG.EMPTY_PLAYER_GROUPINGS).describe(
		'Named ways of sorting players into coloured groups. Each grouping is an ordered list of rules assigning a group to players with a given flag, highest priority first; the players panel and activity charts pick which grouping to show.',
	),
	navLinks: NavLinkSchema.optional().describe('Global links to display in the navbar dropdown menu'),
	warnOnSlmStart: z.boolean().prefault(false).describe('Warn all in-game admins when SLM starts or restarts.'),
	allowedPrefixes: z.array(CMD.PrefixSchema).min(1).prefault([CMD.FALLBACK_PREFIX]).describe(
		'Prefixes an in-game command may start with. Every command string and timeout alias must begin with one of these',
	),
	defaultPrefix: CMD.PrefixSchema.prefault(CMD.FALLBACK_PREFIX).describe(
		'The allowed prefix that commands introduced by future SLM versions are seeded with',
	),
	commandAliases: z.array(z.object({
		alias: BasicStrNoWhitespace.describe('The shortcut typed in chat, including its prefix'),
		command: z.string().min(1).describe('The full command this alias runs, including its prefix and every argument'),
	})).prefault([]).describe(
		'Shortcuts to complete commands, e.g. /rules = /broadcast Read the rules. An alias takes no arguments of its own '
			+ '(anything typed after it is ignored), runs in the scopes of the command it points at, and loses to a real command string on collision.',
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

			{ name: 'Balance_Differential' },
			{ name: 'Asymmetry_Score' },
		],
		defaultSortBy: { type: 'random' },
		extraLayerSelectMenuItems: [
			{ type: 'inrange', neg: false, args: [{ type: 'column', column: 'Balance_Differential' }, { type: 'value' }, { type: 'value' }] },
			{ type: 'inrange', neg: false, args: [{ type: 'column', column: 'Asymmetry_Score' }, { type: 'value' }, { type: 'value' }] },
		],
	}).describe('Configures the columns, default sort, and extra menu items of the layer table'),
	layerGeneration: LC.LayerGenerationConfigSchema.prefault({
		pickOrder: ['Map', 'Gamemode', 'Faction_1', 'Faction_2', 'Unit_1', 'Unit_2'],
	}).describe(
		"Configures how layers are picked during generation (autogeneration, vote generation, and the layer table's random sort). "
			+ 'Each column or matchup in the pick order is picked weighted-randomly in turn, narrowing the candidate pool for the next.',
	),
}).superRefine((val, ctx) => {
	const allowedPrefixes = val.allowedPrefixes ?? [CMD.FALLBACK_PREFIX]
	const seenPrefix = new Set<string>()
	allowedPrefixes.forEach((p, i) => {
		if (seenPrefix.has(p)) {
			ctx.addIssue({ code: 'custom', message: `Duplicate prefix "${p}"`, path: ['allowedPrefixes', i] })
		}
		seenPrefix.add(p)
	})
	// commands seeded for future SLM versions take defaultPrefix, so it has to be one an admin actually accepts;
	// otherwise the next release's new commands would fail this schema on load and refuse to boot
	const defaultPrefix = val.defaultPrefix ?? CMD.FALLBACK_PREFIX
	if (!allowedPrefixes.includes(defaultPrefix)) {
		ctx.addIssue({
			code: 'custom',
			message: `Default prefix "${defaultPrefix}" must be one of the allowed prefixes (${allowedPrefixes.join(', ')})`,
			path: ['defaultPrefix'],
		})
	}
	const hasAllowedPrefix = (s: string) => allowedPrefixes.some((p) => s.startsWith(p))
	const prefixIssue = (s: string, noun: string, path: (string | number)[]) => {
		ctx.addIssue({
			code: 'custom',
			message: `${noun} "${s}" must start with one of the allowed prefixes (${allowedPrefixes.join(', ')})`,
			path,
		})
	}

	// command strings and alias strings share one namespace: a real command always wins on collision, so an alias
	// that clashes is unreachable. matching is case-insensitive, like dispatch.
	const commandOwner = new Map<string, string>()
	for (const [id, cmd] of Object.entries(val.commands ?? {})) {
		;(cmd.strings ?? []).forEach((s, j) => {
			if (!hasAllowedPrefix(s)) prefixIssue(s, 'Command string', ['commands', id, 'strings', j])
			commandOwner.set(s.toLowerCase(), id)
		})
	}
	const seenAlias = new Set<string>()
	val.commandAliases?.forEach((alias, i) => {
		const key = alias.alias.toLowerCase()
		if (!hasAllowedPrefix(alias.alias)) prefixIssue(alias.alias, 'Alias', ['commandAliases', i, 'alias'])
		const owner = commandOwner.get(key)
		if (owner) {
			ctx.addIssue({
				code: 'custom',
				message: `Alias "${alias.alias}" clashes with the command "${owner}". Pick a different string.`,
				path: ['commandAliases', i, 'alias'],
			})
		}
		if (seenAlias.has(key)) {
			ctx.addIssue({ code: 'custom', message: `Duplicate alias "${alias.alias}"`, path: ['commandAliases', i, 'alias'] })
		}
		seenAlias.add(key)

		// only malformed args are an error here. An alias whose command string doesn't resolve is left to load and
		// surface as unavailable in the editor and the help listings: a later SLM release can rename a command's
		// strings, and stored settings that predate the rename must not stop the server booting.
		const res = CMD.resolveAliasCommand(alias.command, val.commands as CMD.CommandConfigs)
		if (res.code === 'err:invalid-args') {
			ctx.addIssue({ code: 'custom', message: res.msg, path: ['commandAliases', i, 'command'] })
		}
	})
})

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>
// the pre-decode shape (e.g. HumanTime fields as '5m' strings instead of milliseconds) -- what gets persisted/displayed for editing
export type GlobalSettingsInput = z.input<typeof GlobalSettingsSchema>

// seeds configs for commands the stored settings predate, using their own defaultPrefix. Must be applied to raw
// settings before GlobalSettingsSchema parses them (the schema has no defaults for command strings, since they
// depend on a sibling field). Call this instead of parsing raw global settings directly.
export function parseGlobalSettings(raw: unknown) {
	const input = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
	const defaultPrefix = typeof input.defaultPrefix === 'string' ? input.defaultPrefix : CMD.FALLBACK_PREFIX
	return GlobalSettingsSchema.safeParse({ ...input, commands: CMD.seedCommandConfigs(input.commands, defaultPrefix) })
}

// The tiered RBAC preset a fresh install starts from (see settings.server loadGlobalSettings). The roles are defined
// but UNASSIGNED: a new install has no Discord role/user ids yet, so the env SUPER_USERS/SUPER_ROLES bootstrap grants
// initial access and an owner assigns Discord entities to these roles from the settings page afterwards. Owners are free
// to edit or delete them. Only applied on first install; existing installs keep whatever roles they already have.
//
//   admins   - in-game operations: queue, votes, filters, player moderation. No settings access.
//   managers - everything admins can do, plus most non-sensitive settings: every global setting except the permissions
//              config (so they can't escalate their own access), and editing existing servers' non-connection settings.
//              Can restart SLM. Cannot create servers or edit connection details (no write-sensitive), or delete servers.
//   owners   - everything.
// return type deliberately not annotated with `z.input<typeof RbacSettingsSchema>`: RbacSettingsSchema's prefault
// references this function, so annotating it back would make the schema type self-referential. The pieces are typed
// individually instead, which keeps the returned literal a valid schema input.
export function defaultRbacSettings() {
	// in-game admin capabilities, shared by admins and managers (all global-scope perms)
	const adminPermissions: RBAC.RolePermissionExpression[] = [
		'site:authorized',
		'queue:write',
		'vote:manage',
		'filters:create',
		'filters:write-all',
		'squad-server:end-match',
		'squad-server:turn-fog-off',
		'squad-server:manage-players',
		'squad-server:warn-players',
		'squad-server:broadcast',
		'squad-server:kick-players',
		'battlemetrics:write-flags',
	]
	// admin:manage-servers lets them enable/disable and set the default server; without a write-sensitive grant they
	// still can't create servers (which requires supplying connection details)
	const managerPermissions: RBAC.RolePermissionExpression[] = [...adminPermissions, 'admin:manage-servers', 'admin:restart-slm']
	const ownerPermissions: RBAC.RolePermissionExpression[] = ['*']
	// edit all servers' non-connection settings (write implies read); no write-sensitive, so connections stay off-limits
	const managerServerGrants: { access: 'read' | 'write' | 'write-sensitive'; serverIds: string[]; paths: string[] }[] = [
		{ access: 'write', serverIds: [], paths: [] },
	]
	return {
		roles: {
			admins: {
				permissions: adminPermissions,
				maxTimeout: '2h',
			},
			managers: {
				permissions: managerPermissions,
				maxTimeout: '6h',
				// every global setting except the permissions config
				globalSettingsGrants: globalSettingsTopLevelKeys().filter((k) => k !== 'rbac'),
				serverSettingsGrants: managerServerGrants,
			},
			owners: {
				permissions: ownerPermissions,
				// there is no in-settings "unlimited" (that comes only from the SUPER_USERS/SUPER_ROLES bootstrap), so a large finite cap
				maxTimeout: '52w',
			},
		},
	}
}

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
			'How users should be warned when a layer matching this filter is about to be played or is added to the queue. Invert to warn about layers that do NOT match this filter.',
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
export const RconConnectionSchema = z.object({
	host: z.string().min(1),
	port: z.number().min(1).max(65535),
	password: z.string().min(1),
})
export type RconConnection = z.infer<typeof RconConnectionSchema>

export const SftpLogConnectionSchema = z.object({
	host: z.string().min(1),
	port: z.number().min(1).max(65535),
	username: z.string().min(1),
	password: z.string().min(1),
	logFile: z.string().min(1),
	pollInterval: HumanTime.prefault('1s').describe('How often to poll the remote log file over SFTP for new lines.'),
	reconnectInterval: HumanTime.prefault('5s').describe('How long to wait between SFTP reconnection attempts.'),
	maxReconnectAttempts: z.int().min(1).prefault(10).describe(
		'How many consecutive SFTP failures to tolerate (reconnecting between each) before tearing down the server.',
	),
})

// How SLM reaches a squad server, as three mutually-exclusive modes:
//   local        - SLM shares the box: reads the log file directly, dials RCON directly.
//   sftp         - SLM is remote: tails the log over SFTP, dials RCON directly over the network.
//   server-agent - the slm-server-agent (see ../../server-agent) runs on/near the box and handles BOTH
//                  logs and RCON. The RCON password lives in the agent's own config, never here; SLM only
//                  stores the shared handshake token.
export const ServerConnectionSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('local'),
		logFile: z.string().min(1),
		rcon: RconConnectionSchema,
	}),
	z.object({
		type: z.literal('sftp'),
		rcon: RconConnectionSchema,
		sftp: SftpLogConnectionSchema,
	}),
	z.object({
		type: z.literal('server-agent'),
		token: z.string().default('dev'),
	}),
])
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
		updatesToSquadServerDisabled: z.boolean().prefault(false).describe('Disable SLM from setting the next layer on the server.'),
		queue: QueueSettingsSchema
			// avoid sharing default queue object - TODO unclear if necessary
			.prefault({}).transform((obj) => Obj.deepClone(obj)).describe(
				'The layer queue configuration: the main pool (filters and repeat rules), the generation pool used for autogeneration, and queue length / vote preferences.',
			),
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
	adminListSources: z.array(SM.AdminListSourceSchema).describe(
		"Admin list sources to load this server's admins from. Each is a remote URL, local file, or FTP path serving admins in Squad's Admins.cfg format.",
	),
	adminIdentifyingPermissions: z.array(SM.PLAYER_PERM).describe(
		'In-game admin-list permissions that mark a player as an admin in SLM (e.g. "canseeadminchat"). A player granted any of these by an '
			+ 'admin list source is treated as an admin, which drives admin-only warns and admin presence.',
	),
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
