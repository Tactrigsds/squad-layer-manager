import { z } from 'zod'

import * as CD from '@/lib/ctx-def'
import * as DH from '@/lib/display-helpers.ts'
import * as Obj from '@/lib/object-utils'
import type * as Rx from '@/lib/rxjs'
import * as ZodUtils from '@/lib/zod-utils'
import * as AAR from '@/models/admin-action-reasons.models.ts'
import * as AppEvents from '@/models/app-events.models'
import * as BAL from '@/models/balance-triggers.models.ts'
import * as CHAT from '@/models/chat.models.ts'
import * as CMD from '@/models/command.models.ts'
import * as CB from '@/models/constraint-builders'
import * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as LTag from '@/models/layer-tags.models'
import * as PG from '@/models/player-groupings.models'
import type * as SS from '@/models/server-state.models'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'

// ============================== rbac (moved out of the deploy-time config so it's admin-editable at runtime) ==============================

// Everything about a role lives under `roles[roleId]`: its permissions, timeout cap, restricted settings grants, and
// which discord entities it's assigned to. Consolidating per-role (rather than five parallel role-keyed maps) makes the
// "a role must be defined to be referenced" invariant structural, so the schema no longer has to police it.
// dotted path into a settings document, e.g. "vote.voteDuration" or just "vote" for the whole section
const SettingsGrantPathSchema = z
	.string()
	.trim()
	.min(1)
	.regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, {
		error: 'Must be a dotted setting path, e.g. "vote.voteDuration"',
	})

// discord ids are kept as strings here (ParsableBigInt) so they round-trip cleanly through the JSON settings editor /
// settings GUI; rbac.server converts them to bigint at the boundary
const RoleAssignmentsSchema = z
	.object({
		discordRoleIds: z.array(ZodUtils.ParsableBigIntSchema).prefault([]).describe('Discord role ids whose members are granted this role'),
		discordUserIds: z.array(ZodUtils.ParsableBigIntSchema).prefault([]).describe('Discord user ids granted this role'),
		everyMember: z.boolean().prefault(false).describe('Grant this role to every member of the Discord server'),
		ingameAdminLists: z
			.array(SM.AdminListIdSchema)
			.prefault([])
			.describe(
				'Grant this role to the in-game admins of the named admin lists. A player counts as an admin of a list when that list ' +
					"places them in a group holding one of the list's own admin-identifying permissions. The role only applies on servers " +
					'that actually use the named list.',
			),
		adminListGroups: z
			.array(
				z.object({
					listId: SM.AdminListIdSchema.describe('The admin list the group belongs to'),
					groupId: z.string().min(1).describe('The group name within that list'),
				}),
			)
			.prefault([])
			.describe(
				'Grant this role by admin-list group membership. A player gets it while the named list places them in the named group, ' +
					'admin-identifying or not (e.g. a Whitelist reserve-slot group), and only on servers that use that list.',
			),
	})
	.prefault({})

const ServerSettingsGrantSchema = z.object({
	access: z
		.enum(['read', 'write', 'write-sensitive'])
		.prefault('write')
		.describe(
			'read = view settings (never connection details); write = edit non-sensitive settings; write-sensitive = view and edit the RCON/SFTP connection details',
		),
	serverIds: z.array(z.string()).prefault([]).describe('Server ids this grant applies to; empty = all servers'),
	paths: z
		.array(SettingsGrantPathSchema)
		.prefault([])
		.describe(
			'Write grants only: dotted setting paths to restrict the grant to (e.g. "queue.mainPool"); empty = all non-sensitive settings',
		),
})

// A server-scoped permission restricted to specific servers. The unrestricted (all-servers) form is the bare
// expression in `permissions`, so a grant here always names at least one server.
const ServerGrantSchema = z.object({
	permission: RBAC.SERVER_PERMISSION_TYPE.describe('The server-scoped permission this grant covers'),
	serverIds: z.array(z.string()).min(1).describe('Server ids this grant applies to'),
})

const RoleConfigSchema = z.object({
	permissions: z
		.array(RBAC.ROLE_PERMISSION_EXPRESSION)
		.prefault([])
		.describe(
			'Permissions granted by this role. Settings permissions granted here are unrestricted (all servers / all settings); ' +
				'use the settings-grants below for restricted grants.',
		),
	// "up to N" comparisons can't ride the permission-expression grammar (grants are equality-matched), so the timeout cap
	// is its own field. Absent = the role cannot issue timeouts; negation doesn't apply, drop the field instead.
	maxTimeout: ZodUtils.HumanTime.optional().describe(
		'Maximum kick-timeout duration (e.g. "2h"). Absent = this role cannot issue timeouts. Super users/roles are unlimited.',
	),
	maxLayerRequests: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Maximum concurrent layer requests (backburner items) the role may hold. Absent = this role cannot request layers. Super users/roles are unlimited.',
		),
	// restricted settings grants, like maxTimeout these carry arguments the expression grammar can't: they let the role
	// edit only specific settings (and for servers, only specific servers). Unrestricted access is granted via `permissions`.
	globalSettingsGrants: z
		.array(SettingsGrantPathSchema)
		.prefault([])
		.describe(
			'Restricted global-settings write grants: dotted setting paths the role may edit (e.g. "vote.voteDuration", or "vote" for the whole section). ' +
				'Any grant also lets the role view global settings. A "!global-settings:write" denial in permissions overrides these.',
		),
	serverSettingsGrants: z
		.array(ServerSettingsGrantSchema)
		.prefault([])
		.describe(
			"Restricted server-settings grants. Any grant also lets the role view the server's (non-sensitive) settings. " +
				'Matching "!server-settings:*" denials in permissions override these.',
		),
	serverGrants: z
		.array(ServerGrantSchema)
		.prefault([])
		.describe(
			'Restricted grants of the per-server permissions (queue, votes, in-game actions), limited to specific servers. ' +
				'Granting one of these in `permissions` instead applies it to every server. A matching denial in permissions overrides these.',
		),
	assignments: RoleAssignmentsSchema.describe('Which discord roles/users/members are granted this role'),
})

export const RbacSettingsSchema = z
	.object({
		roles: z.record(RBAC.UserDefinedRoleIdSchema, RoleConfigSchema).prefault({}).describe('Defined roles, keyed by id.'),
	})
	.superRefine((val, ctx) => {
		// only the first path segment is validated (deeper segments that don't resolve simply never match a write)
		for (const [role, cfg] of Object.entries(val.roles ?? {})) {
			cfg.globalSettingsGrants.forEach((p, i) => {
				const head = p.split('.')[0]
				if (!globalSettingsTopLevelKeys().includes(head)) {
					ctx.addIssue({
						code: 'custom',
						message: `"${head}" is not a global setting`,
						path: ['roles', role, 'globalSettingsGrants', i],
					})
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
	})
	.prefault(() => defaultRbacSettings())

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
// stale. Drop those grants instead and hand the caller a
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

export const NavLinkSchema = z.array(
	z.object({
		label: z.string(),
		url: z.url(),
	}),
)

// ============================== global settings ==============================

export const GlobalSettingsSchema = z
	.object({
		topBarColor: z
			.string()
			.prefault('green')
			.nullable()
			.describe(
				'Tints the top navigation bar so non-production environments are visually distinct. Set to null in production to disable the tint.',
			),
		adminActionReasons: AAR.AdminActionReasonsSchema.describe(
			'Preset reasons admins can pick when acting against players. A reason is offered for an action only where it has text for that ' +
				'action, so every reason needs at least one. The text reaches the player verbatim and takes {{label}}, {{duration}} ' +
				'(timeouts only) and any Message Variables below.',
		),
		requireReasonFor: z
			.array(AAR.REQUIRABLE_ADMIN_ACTION_TYPE)
			.prefault([])
			.describe('Actions that require a reason (a preset or custom text). Performing one of these without a reason is rejected.'),
		messageVariables: z
			.array(
				z.object({
					name: z
						.string()
						.trim()
						.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
							error: 'Letters, digits and underscore only; must not start with a digit',
						}),
					value: z.string(),
				}),
			)
			.prefault([])
			.describe('Custom variables usable in any admin action reason as {{name}} (e.g. name "discord", value "discord.gg/xyz").'),
		chat: CHAT.ChatConfigSchema.prefault({}).describe(
			'What the live chat feed leaves out. Neither list changes what is actually sent in-game.',
		),
		logFilePollInterval: ZodUtils.HumanTime.prefault('1s').describe('How often a local-file log source checks the log for new lines.'),
		seedSandboxServer: z
			.boolean()
			.prefault(true)
			.describe(
				'Create a sandbox server on startup if none exists. A sandbox has no real squad server behind it: SLM emulates one in-process, so ' +
					'it is somewhere to learn the queue, try a filter or reproduce a bug without touching anyone real. Turning this off leaves any ' +
					'existing sandbox alone; delete it from the server registry to be rid of it.',
			),
		tickRateThresholds: z
			.object({
				good: z
					.number()
					.positive()
					.prefault(60)
					.describe('At or above this tick rate the live server tick rate displays as good (green)'),
				warning: z
					.number()
					.positive()
					.prefault(50)
					.describe(
						'At or above this tick rate (but below the good threshold) the tick rate displays as a warning (yellow); below it, as unhealthy (red)',
					),
			})
			.prefault({})
			.describe('Thresholds for coloring the live server tick rate display'),
		balanceTriggerLevels: z
			.partialRecord(BAL.TRIGGER_IDS, BAL.TRIGGER_LEVEL)
			.prefault({ '150x2': 'warn' })
			.describe(
				'Which balance triggers run, and how severely each one reports when it fires (info, warn, or violation). A trigger with no ' +
					'level set here is not evaluated at all.',
			),
		playerFlagsRequiringNote: z
			.array(z.uuid())
			.prefault([])
			.describe(
				"Flags (by id) that require a reason to be given when added, which is included in the note posted to the player's BattleMetrics profile",
			),
		playerGroupings: PG.PlayerGroupingsSchema.prefault(PG.EMPTY_PLAYER_GROUPINGS).describe(
			'Named ways of sorting players into coloured groups. Each grouping is an ordered list of rules assigning a group to players with a given flag, highest priority first; the players panel and activity charts pick which grouping to show.',
		),
		navLinks: NavLinkSchema.optional().describe(
			'Links to display in the navbar dropdown menu, on every page. Each server can add links of its own on top of these.',
		),
		warnOnSlmStart: z.boolean().prefault(false).describe('Warn all in-game admins when SLM starts or restarts.'),
		allowedPrefixes: z
			.array(CMD.PrefixSchema)
			.min(1)
			.prefault([CMD.DEFAULT_PREFIX])
			.describe('Prefixes an in-game command may start with. Every command trigger must begin with one of these.'),
		defaultPrefix: CMD.PrefixSchema.prefault(CMD.DEFAULT_PREFIX).describe(
			'The allowed prefix that commands introduced by future SLM versions are seeded with',
		),
		commands: CMD.AllCommandConfigSchema,
		adminLists: z
			.record(SM.AdminListIdSchema, SM.AdminListDefSchema)
			.prefault({})
			.describe(
				'The admin lists this install knows about, by name. Each serves the same Admins.cfg the gameserver reads, in the same format, ' +
					'and carries its own admin-identifying permissions. Naming them is what lets a server choose which apply to it and a role ' +
					"assignment say which list's groups it means.",
			),
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
				{
					type: 'inrange',
					neg: false,
					args: [{ type: 'column', column: 'Balance_Differential' }, { type: 'value' }, { type: 'value' }],
				},
				{
					type: 'inrange',
					neg: false,
					args: [{ type: 'column', column: 'Asymmetry_Score' }, { type: 'value' }, { type: 'value' }],
				},
			],
		}).describe('Configures the appearance of the layers table and layer select menu'),
		layerTags: LTag.TagsSchema,
		layerGeneration: LC.LayerGenerationConfigSchema.prefault({
			pickOrder: ['Map', 'Gamemode', 'Faction_1', 'Faction_2', 'Unit_1', 'Unit_2'],
		}).describe(
			"How layers are picked during generation, vote generation and the layer table's random sort. Each column or matchup in the pick " +
				'order is drawn weighted-randomly in turn, narrowing the pool the next one draws from.',
		),
	})
	.superRefine((val, ctx) => {
		const allowedPrefixes = val.allowedPrefixes ?? [CMD.DEFAULT_PREFIX]
		const seenPrefix = new Set<string>()
		allowedPrefixes.forEach((p, i) => {
			if (seenPrefix.has(p)) {
				ctx.addIssue({ code: 'custom', message: `Duplicate prefix "${p}"`, path: ['allowedPrefixes', i] })
			}
			seenPrefix.add(p)
		})
		// commands seeded for future SLM versions take defaultPrefix, so it has to be one an admin actually accepts;
		// otherwise the next release's new commands would fail this schema on load and refuse to boot
		const defaultPrefix = val.defaultPrefix ?? CMD.DEFAULT_PREFIX
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

		// every trigger string across every command is one namespace, so dispatch never has to break a tie.
		// matching is case-insensitive, like dispatch.
		const triggerOwner = new Map<string, string>()
		for (const [id, cmd] of Object.entries(val.commands ?? {})) {
			;(cmd.triggers ?? []).forEach((trigger, j) => {
				const string = CMD.triggerString(trigger)
				if (!hasAllowedPrefix(string)) prefixIssue(string, 'Trigger', ['commands', id, 'triggers', j])
				const key = string.toLowerCase()
				const owner = triggerOwner.get(key)
				if (owner !== undefined) {
					ctx.addIssue({
						code: 'custom',
						message:
							owner === id
								? `Duplicate trigger "${string}"`
								: `Trigger "${string}" is already used by the "${owner}" command. Pick a different string.`,
						path: ['commands', id, 'triggers', j],
					})
				}
				triggerOwner.set(key, id)

				const args = CMD.triggerArgs(trigger)
				if (args === undefined) return
				const res = CMD.resolveTriggerArgs(id as CMD.CommandId, args)
				if (res.code !== 'ok') ctx.addIssue({ code: 'custom', message: res.msg, path: ['commands', id, 'triggers', j, 'args'] })
			})
		}

		const seenTagId = new Set<string>()
		const seenTagLabel = new Set<string>()
		val.layerTags?.forEach((tag, i) => {
			if (seenTagId.has(tag.id)) {
				ctx.addIssue({ code: 'custom', message: `Duplicate tag id "${tag.id}"`, path: ['layerTags', i, 'id'] })
			}
			seenTagId.add(tag.id)
			const label = tag.label.trim().toLowerCase()
			if (seenTagLabel.has(label)) {
				ctx.addIssue({ code: 'custom', message: `Another tag is already labeled "${tag.label}"`, path: ['layerTags', i, 'label'] })
			}
			seenTagLabel.add(label)
		})
	})

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>
// the pre-decode shape (e.g. ZodUtils.HumanTime fields as '5m' strings instead of milliseconds) -- what gets persisted/displayed for editing
export type GlobalSettingsInput = z.input<typeof GlobalSettingsSchema>

// seeds configs for commands the stored settings predate, using their own defaultPrefix. Must be applied to raw
// settings before GlobalSettingsSchema parses them (the schema has no defaults for command triggers, since they
// depend on a sibling field). Call this instead of parsing raw global settings directly.
export function parseGlobalSettings(raw: unknown) {
	const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
	const defaultPrefix = typeof input.defaultPrefix === 'string' ? input.defaultPrefix : CMD.DEFAULT_PREFIX
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
		'squad-server:view',
		'queue:write',
		'queue:manage-tags',
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
	// still can't create servers (which requires supplying connection details). Policing other people's notes sits here
	// rather than with the admins: writing notes and managing your own only needs queue:write
	const managerPermissions: RBAC.RolePermissionExpression[] = [
		...adminPermissions,
		'queue:manage-all-notes',
		'admin:manage-servers',
		'admin:restart-slm',
	]
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
				maxLayerRequests: 5,
				// Whoever the game already trusts to admin gets SLM's day-to-day access, so in-game commands work
				// without anyone configuring RBAC first. Only the implicit list is named: it is the one list a fresh
				// install has (the sandbox's emulated Admins.cfg), and an install with real servers points this at
				// the lists it configures for them.
				assignments: { ingameAdminLists: [SM.IMPLICIT_LIST_ID] },
			},
			managers: {
				permissions: managerPermissions,
				maxTimeout: '6h',
				maxLayerRequests: 5,
				// every global setting except the permissions config
				globalSettingsGrants: globalSettingsTopLevelKeys().filter((k) => k !== 'rbac'),
				serverSettingsGrants: managerServerGrants,
			},
			owners: {
				permissions: ownerPermissions,
				// there is no in-settings "unlimited" (that comes only from the SUPER_USERS/SUPER_ROLES bootstrap), so a large finite cap
				maxTimeout: '52w',
				maxLayerRequests: 10,
			},
		},
	}
}

// ============================== per-server settings ==============================

// autogen on by default: a fresh server that generates layers violating its own repeat rules is never what
// anyone wants, and the per-rule checkbox is there to turn it off
const DEFAULT_REPEAT_RULE_CONFIGS: PoolRepeatRuleConfig[] = [
	{ label: 'Map', field: 'Map', within: 4, autogen: true },
	{ label: 'Layer', field: 'Layer', within: 7, autogen: true },
	{ label: 'Faction', field: 'Faction', within: 3, autogen: true },
]

export const POOL_FILTER_APPLY_AS = z.enum(['regular', 'inverted', 'disabled'])
export type PoolFilterApplyAs = z.infer<typeof POOL_FILTER_APPLY_AS>

export const POOL_FILTER_MODE = z.enum(['include', 'exclude'])
export type PoolFilterMode = z.infer<typeof POOL_FILTER_MODE>

export const PoolFilterSettingSchema = z.object({
	filterId: F.FilterEntityIdSchema,
	mode: POOL_FILTER_MODE.meta({
		description: 'Whether layers matching this filter are included in the pool or excluded from it',
	}),
})
export type PoolFilterSetting = z.infer<typeof PoolFilterSettingSchema>

export const APPLIED_FILTER_APPLY_AS = z.enum(['regular', 'inverted'])
export type AppliedFilterApplyAs = z.infer<typeof APPLIED_FILTER_APPLY_AS>

export const AppliedFilterSettingSchema = z.object({
	filterId: F.FilterEntityIdSchema,
	applyAs: APPLIED_FILTER_APPLY_AS.meta({
		description: 'Whether the filter applies to layers matching it (regular) or layers NOT matching it (inverted)',
	}),
})
export type AppliedFilterSetting = z.infer<typeof AppliedFilterSettingSchema>

export const SELECTABLE_FILTER_APPLY_AS = z.enum(['regular', 'inverted', 'disabled'])
export type SelectableFilterApplyAs = z.infer<typeof SELECTABLE_FILTER_APPLY_AS>

export const SelectableFilterSettingSchema = z.object({
	filterId: F.FilterEntityIdSchema,
	applyAs: SELECTABLE_FILTER_APPLY_AS.meta({
		description:
			'The state the filter starts in during layer selection: applied (regular), applied inverted, or offered but not applied (disabled)',
	}),
})
export type SelectableFilterSetting = z.infer<typeof SelectableFilterSettingSchema>

export const RepeatRuleConfigSchema = LQY.RepeatRuleSchema.extend({
	warn: z.boolean().optional().meta({
		description: 'Users should be warned before saving or before the layer violating this repeat rule is played',
	}),
	autogen: z.boolean().optional().meta({
		description: 'Apply this rule when autogenerating layers',
	}),
})

export type PoolRepeatRuleConfig = z.infer<typeof RepeatRuleConfigSchema>

export const PoolConfigurationSchema = z.object({
	poolFilter: PoolFilterSettingSchema.nullable()
		.prefault(null)
		.meta({
			description:
				'The single filter defining pool membership. Out-of-pool layers can only be queued by users with the queue:force-write permission, ' +
				'are warned about, and are never autogenerated. The filter entity must have both its match and miss indicators (emoji + alert message) configured.',
		}),
	indicateMatches: z.array(F.FilterEntityIdSchema).prefault([]).meta({
		description: "Layers matching these filters display the filter's match indicator",
	}),
	indicateMisses: z.array(F.FilterEntityIdSchema).prefault([]).meta({
		description: "Layers NOT matching these filters display the filter's miss indicator",
	}),
	defaultSelectable: z.array(SelectableFilterSettingSchema).prefault([]).meta({
		description: 'Filters offered during layer selection, starting in the given state',
	}),
	warnFor: z.array(AppliedFilterSettingSchema).prefault([]).meta({
		description: 'Warn when a layer matching the filter in the given state is queued or about to be played',
	}),
	constrainGeneration: z.array(AppliedFilterSettingSchema).prefault([]).meta({
		description: 'Autogenerated layers are constrained by these filters in the given state, in addition to the pool filter',
	}),
	skipWarningsForTags: z
		.array(LTag.TagIdSchema)
		.prefault([])
		.meta({
			description:
				'Queue items carrying any of these tags raise no warnings: not when saving the queue, and not in the admin reminder before the ' +
				'layer is played. Being out of pool still gates saving on queue:force-write.',
		}),
	repeatRules: z
		.array(RepeatRuleConfigSchema)
		.describe(
			'How far apart a map, layer or faction has to be spaced in the queue and recent match history. Each rule can warn when it is ' +
				'broken, constrain autogeneration, or both.',
		)
		.refine((rules) => new Set(rules.map((r) => r.label)).size === rules.length, {
			error: 'Repeat rule labels must be unique',
		}),
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
	pollInterval: ZodUtils.HumanTime.prefault('1s').describe('How often to poll the remote log file over SFTP for new lines.'),
	reconnectInterval: ZodUtils.HumanTime.prefault('5s').describe('How long to wait between SFTP reconnection attempts.'),
	maxReconnectAttempts: z
		.int()
		.min(1)
		.prefault(10)
		.describe('How many consecutive SFTP failures to tolerate (reconnecting between each) before tearing down the server.'),
})

export const SandboxConnectionSchema = z.object({
	type: z.literal('sandbox'),
	serverName: z.string().min(1).prefault('SLM Sandbox').describe('The name the emulated server reports over RCON.'),
	maxPlayers: z.int().min(2).max(200).prefault(100).describe('The player slot count the emulated server reports.'),
})

// How SLM reaches a squad server, as four mutually-exclusive modes:
//   local        - SLM shares the box: reads the log file directly, dials RCON directly.
//   sftp         - SLM is remote: tails the log over SFTP, dials RCON directly over the network.
//   server-agent - the slm-server-agent (see ../../server-agent) runs on/near the box and handles BOTH
//                  logs and RCON. The RCON password lives in the agent's own config, never here; SLM only
//                  stores the shared handshake token.
//   sandbox      - there is no squad server. SLM runs one in-process (src/emulator) and talks to it over a
//                  loopback RCON socket, so every layer below this one behaves as it does against a real
//                  server. Nothing here is reachable from the network and nothing outbound is real; see
//                  src/systems/sandbox.server.ts.
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
	SandboxConnectionSchema,
])
export type ServerConnection = z.infer<typeof ServerConnectionSchema>
export type SandboxConnection = z.infer<typeof SandboxConnectionSchema>

// Why SLM stopped writing the rotation. The reason is the state: there is no separate flag, so a disabled server
// can never be missing one. 'ingame-vote' is set by SLM itself when it detects Squad's own vote and stands down --
// no user-facing control offers it, though the raw JSON editor can express it like any other value.
export const SlmUpdatesDisabledSchema = z.discriminatedUnion('type', [
	// `by` is null for settings written before disabling recorded who did it
	z.object({ type: z.literal('manual'), by: AppEvents.ActorSchema.nullable() }),
	// `inferred` marks the reason as deduced rather than observed: SLM never saw the vote's log lines, it saw the
	// server stop having a next layer, which is what enabling voting does. Everything treats the two the same; only
	// what is shown to an admin differs, since a guess should not be stated as fact.
	z.object({ type: z.literal('ingame-vote'), inferred: z.boolean().prefault(false) }),
])
export type SlmUpdatesDisabled = z.infer<typeof SlmUpdatesDisabledSchema>

export const QueueSettingsSchema = z.object({
	maxQueueSize: z
		.int()
		.min(1)
		.max(100)
		.prefault(20)
		.describe('How long the queue is meant to get. Reaching it turns the queue counter red; nothing is rejected.'),
	lowQueueWarningThreshold: z
		.number()
		.positive()
		.prefault(1)
		.describe('Admins are warned after a map roll when the queue holds this many items or fewer.'),
	adminQueueReminderInterval: ZodUtils.HumanTime.prefault('10m').describe(
		'How often to remind admins to maintain the queue. Low queue warnings happen half as often.',
	),
	mainPool: PoolConfigurationSchema.prefault({ repeatRules: DEFAULT_REPEAT_RULE_CONFIGS }).describe(
		'Which layers this server considers playable, and which of them it warns about.',
	),
	layerRequests: z
		.object({
			maxTotal: z
				.number()
				.int()
				.positive()
				.prefault(50)
				.describe('Maximum number of layer requests the backburner may hold across all users'),
		})
		.prefault({})
		.describe('Limits on the backburner, where layers players request in-game wait to be picked up.'),
})
export type QueueSettings = z.infer<typeof QueueSettingsSchema>

// The language this managed server talks to its players in. Read where a warn or broadcast is rendered rather than
// held ambiently: one process serves many servers, each with its own.
export function locale(ctx: Ctx) {
	return ctx.serverSettings.settings.locale
}

export const PublicServerSettingsSchema = z.object({
	locale: z
		.string()
		.prefault('en')
		.describe(
			'The language this server talks to its players in: warnings, broadcasts and the in-game vote. A BCP-47 tag such as "en" or ' +
				'"de". Falls back to English wherever a message has not been translated. Does not affect the web app, which follows each ' +
				"viewer's own browser.",
		),
	adminLists: z
		.array(SM.AdminListIdSchema)
		.prefault([])
		.describe(
			'Which of the named admin lists (global settings) apply to this server. A player is only an admin here, and only picks up ' +
				'roles assigned by admin-list group, through a list named here. Empty means this server recognises no in-game admins.',
		),
	updatesToSquadServerDisabled: SlmUpdatesDisabledSchema.nullable()
		.prefault(null)
		.describe(
			'Why SLM is not writing the next layer to this server over RCON, or null when it is. The queue still runs and still tracks ' +
				'what is played; SLM just never sets the map itself, and stops sending the recurring in-game reminders and announcements ' +
				'that describe the queue as the rotation. For running SLM alongside something else that owns the rotation.',
		),
	// no defensive clone of the prefault: zod v4 builds a fresh default per parse, and the shared
	// DEFAULT_REPEAT_RULE_CONFIGS array is never mutated. A transform here would also be one-way, which costs
	// ServerSettingsSchema its encodability -- and the settings editor needs that to show ZodUtils.HumanTime fields as
	// "5s" rather than 5000.
	queue: QueueSettingsSchema.prefault({}),
	vote: z
		.object({
			voteDuration: ZodUtils.HumanTime.prefault('180s').describe('How long a vote stays open before it is tallied.'),
			startVoteReminderThreshold: ZodUtils.HumanTime.prefault('20m').describe(
				'How far into a match admins start being reminded that no vote has been started yet.',
			),
			voteReminderInterval: ZodUtils.HumanTime.prefault('30s').describe('How often players are reminded to vote while a vote is open.'),
			internalVoteReminderInterval: ZodUtils.HumanTime.prefault('15s').describe(
				'How often admins are reminded to vote while an internal (admin-only) vote is open.',
			),
			autoStartVoteDelay: ZodUtils.HumanTime.prefault('20m')
				.nullable()
				.describe(
					'How far into a match SLM starts a vote by itself, when the next queue item is a vote. Unset to only ever start votes manually.',
				),
			autoStartVoteCutoff: ZodUtils.HumanTime.prefault('30m').describe(
				'How far into a match auto-starting gives up. Past this point starting a vote is left to an admin, so a match running long ' +
					'does not open a vote nobody is around for.',
			),
			voteDisplayProps: z
				.array(DH.LAYER_DISPLAY_PROP)
				.prefault(['map', 'gamemode'])
				.describe('Which parts of a layer (map, gamemode, factions, units) vote choices spell out. Admins can override this per vote.'),
			finalVoteReminder: ZodUtils.HumanTime.prefault('10s').describe('How long before a vote closes the last-chance reminder is sent.'),
		})
		.prefault({}),
	overrideAdminSetNextLayer: z
		.boolean()
		.prefault(false)
		.describe(
			'What happens when the next layer is set from outside SLM (an in-game admin, or another RCON tool). On, SLM sets it straight ' +
				'back to whatever the queue says. Off, SLM adopts the change by putting that layer at the front of the queue.',
		),
	warnOnNextLayerChange: z
		.boolean()
		.prefault(false)
		.describe('Warn all in-game admins with the new next layer whenever it changes. A change SLM overrides is not announced.'),
	postRollAnnouncementsTimeout: ZodUtils.HumanTime.prefault('5m').describe(
		'How long after a map rolls before admins are told the balance trigger in effect, the next layer, and whether the queue is ' +
			'running low.',
	),
	fogOffDelay: ZodUtils.HumanTime.prefault('25s').describe(
		'How long after a FRAAS layer starts before fog of war is turned off and announced in-game. Other gamemodes are unaffected.',
	),
	remindersAndAnnouncementsEnabled: z
		.boolean()
		.prefault(true)
		.describe('Whether this server sends admins the recurring nudges: post-roll announcements, queue reminders, and vote reminders.'),
	rconCacheTTL: z
		.object({
			layersStatus: ZodUtils.HumanTime.prefault('5s').describe(
				'How stale the cached current/next layer may be before a read refetches it over RCON.',
			),
			serverInfo: ZodUtils.HumanTime.prefault('10s').describe(
				'How stale cached server info (player count, tick rate) may be before a read refetches it over RCON.',
			),
			teams: ZodUtils.HumanTime.prefault('5s').describe(
				'How stale the cached roster may be before a read refetches it over RCON. Also the interval at which observers poll ListPlayers.',
			),
		})
		.prefault({})
		.describe(
			'How long RCON responses stay cached. Lower means fresher data and more RCON traffic; these are the dominant source of roster/status latency.',
		),
})

export type PublicServerSettings = z.infer<typeof PublicServerSettingsSchema>

// the settings deciding what SLM does about the next layer, each addressed by its own single-key api in the
// pool-config panels so its checkbox is gated on write access to exactly that setting
export const NEXT_LAYER_SETTING_KEYS = ['overrideAdminSetNextLayer', 'warnOnNextLayerChange'] as const
export type NextLayerSettingKey = (typeof NEXT_LAYER_SETTING_KEYS)[number]

// the mainPool lists that add behavior on top of the pool filter rather than deciding pool membership. The
// pool-config panels render one editor per key, in this order.
export const SECONDARY_LIST_KEYS = ['indicateMatches', 'indicateMisses', 'defaultSelectable', 'warnFor', 'constrainGeneration'] as const
export type SecondaryListKey = (typeof SECONDARY_LIST_KEYS)[number]

const EXAMPLE_PUBLIC_SETTINGS = PublicServerSettingsSchema.parse({})
EXAMPLE_PUBLIC_SETTINGS.queue.mainPool.poolFilter = { filterId: 'test-filter', mode: 'include' }
EXAMPLE_PUBLIC_SETTINGS.queue.mainPool.defaultSelectable.push({ filterId: 'test-filter', applyAs: 'regular' })

export const ServerSettingsSchema = PublicServerSettingsSchema.extend({
	connections: ServerConnectionSchema.describe(
		'How SLM reaches this server. Local: SLM shares the box, reading the log file and dialing RCON directly. SFTP: SLM is remote, ' +
			'tailing the log over SFTP and dialing RCON over the network. Server agent: slm-server-agent runs next to the server and ' +
			"handles both, so the RCON password lives in the agent's config rather than here.",
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

// The recurring nudges all describe the queue as the rotation. While SLM is not writing the next layer the queue is
// not what the server will play, so announcing it tells admins something untrue.
export function remindersEnabled(settings: PublicServerSettings) {
	return settings.remindersAndAnnouncementsEnabled && !settings.updatesToSquadServerDisabled
}

export function getRepeatRuleConstraintId(poolName: string, opts: { label: string }) {
	return `layer-pool:${poolName}:${opts.label}`
}

export function getPoolFilterConstraint(
	settings: PublicServerSettings,
	opts?: { applyAs?: LQY.FilterApplicationState; warn?: boolean },
): LQY.Constraint | null {
	const poolFilter = settings.queue.mainPool.poolFilter
	if (!poolFilter) return null
	return CB.poolFilter(poolFilter.filterId, poolFilter.mode, opts)
}

// one constraint per filter appearing in indicateMatches/indicateMisses/warnFor. never applied as a query filter --
// these only drive indicators and save-time/in-game warnings.
export function getIndicationAndWarnConstraints(settings: PublicServerSettings, opts?: { includeWarns?: boolean }): LQY.Constraint[] {
	const pool = settings.queue.mainPool
	const configs = new Map<F.FilterEntityId, { showIndicator: LQY.IndicatorState; warn: LQY.FilterApplicationState }>()
	const entry = (filterId: F.FilterEntityId) => {
		let config = configs.get(filterId)
		if (!config) {
			config = { showIndicator: 'disabled', warn: 'disabled' }
			configs.set(filterId, config)
		}
		return config
	}
	for (const filterId of pool.indicateMatches) {
		const config = entry(filterId)
		config.showIndicator = config.showIndicator === 'inverted' ? 'both' : 'regular'
	}
	for (const filterId of pool.indicateMisses) {
		const config = entry(filterId)
		config.showIndicator = config.showIndicator === 'regular' ? 'both' : 'inverted'
	}
	if (opts?.includeWarns ?? true) {
		for (const { filterId, applyAs } of pool.warnFor) {
			entry(filterId).warn = applyAs
		}
	}
	return Array.from(configs, ([filterId, config]) =>
		CB.filterEntity(`filter-cfg:${filterId}`, filterId, {
			filterApplState: 'disabled',
			showIndicator: config.showIndicator,
			warn: config.warn,
		}),
	)
}

export function getSettingsConstraints(settings: PublicServerSettings, opts?: { generatingLayers?: boolean }) {
	const constraints: LQY.Constraint[] = []
	const queue = settings.queue

	if (opts?.generatingLayers) {
		const poolFilterConstraint = getPoolFilterConstraint(settings)
		if (poolFilterConstraint) constraints.push(poolFilterConstraint)
		for (const { filterId, applyAs } of queue.mainPool.constrainGeneration) {
			constraints.push(CB.filterEntity(`gen:${filterId}`, filterId, { filterApplState: applyAs }))
		}
		for (const rule of queue.mainPool.repeatRules) {
			if (!rule.autogen) continue
			constraints.push(CB.repeatRule(getRepeatRuleConstraintId('mainPool', { label: rule.label }), rule))
		}
	} else {
		const poolFilterConstraint = getPoolFilterConstraint(settings, { warn: true })
		if (poolFilterConstraint) constraints.push(poolFilterConstraint)
		constraints.push(...getIndicationAndWarnConstraints(settings))
		for (const rule of queue.mainPool.repeatRules) {
			constraints.push(CB.repeatRule(getRepeatRuleConstraintId('mainPool', { label: rule.label }), rule))
		}
	}

	return constraints
}

// the constraint describing pool membership, used to gate queue:force-write. with no pool filter configured the pool is
// unconstrained (force-write inert).
export function getPoolMembershipConstraints(settings: PublicServerSettings): LQY.Constraint[] {
	const constraint = getPoolFilterConstraint(settings)
	return constraint ? [constraint] : []
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

export const SettingsPathSchema = z.array(z.union([z.string(), z.number()])).refine(
	(path) => {
		// does not check the last key because it could be undefined
		const valid = checkPublicSettingsPath(path)
		if (!valid) console.warn("settings path doesn't resolve", path)
		return valid
	},
	{
		error: 'Path must resolve to a valid setting',
	},
)

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

export function dottedSettingsPath(path: string | (string | number)[]): string {
	return typeof path === 'string' ? path : path.join('.')
}

export namespace Grants {
	export function globalSettingsRead() {
		return RBAC.permReq<'global-settings:read' | 'global-settings:write'>('any', [
			RBAC.perm('global-settings:read'),
			'global-settings:write',
		])
	}

	export function writeGlobalSettingsPaths(paths: (SettingsPath | string)[]) {
		const dottedPaths = paths.map(dottedSettingsPath)
		return RBAC.permReq('all', [
			(perms) => {
				const access = RBAC.globalSettingsWriteAccess(perms)
				const missing = dottedPaths.filter((p) => !RBAC.settingsPathAllowed(access, p))
				if (missing.length === 0) return
				return `global-settings:write missing paths: ${missing.join(', ')}`
			},
		])
	}

	export function writeServerSettingsPaths(serverId: string, paths: (SettingsPath | string)[]) {
		const dottedPaths = paths.map(dottedSettingsPath)
		const isSensitive = (p: string) => p === 'connections' || p.startsWith('connections.')
		const nonSensitivePaths = dottedPaths.filter((p) => !isSensitive(p))
		const hasSensitivePaths = dottedPaths.some(isSensitive)

		return RBAC.permReq<'server-settings:write' | 'server-settings:write-sensitive'>('all', [
			(perms) => {
				const access = RBAC.serverSettingsWriteAccess(perms, serverId)
				const missing = nonSensitivePaths.filter((p) => !RBAC.settingsPathAllowed(access, p))
				if (missing.length === 0) return
				return `server-settings:write missing paths: ${missing.join(', ')}`
			},
			// connections are never a path grant; editing them requires write-sensitive regardless of the write grant above
			hasSensitivePaths
				? (perms) => {
						if (RBAC.canWriteSensitiveServerSettings(perms, serverId)) return
						return `server-settings:write-sensitive on ${serverId}`
					}
				: undefined,
		])
	}
}

export type Ctx = CS.Ctx & { serverSettings: Ctx.Payload } & CS.ServerId
export const CtxDef = CD.defCtx<Ctx>()(['serverSettings'], { name: 'serverSettings', extends: [CS.ServerIdDef] })

export namespace Ctx {
	export type Update = Readonly<[PublicServerSettings, SS.LQStateUpdate['source'] | null]>

	export type Payload = {
		settings: PublicServerSettings
		update$: Rx.ReplaySubject<Ctx.Update>
	}
}
