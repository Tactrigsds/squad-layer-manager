import * as CD from '@/lib/ctx-def'
import * as DH from '@/lib/display-helpers.ts'
import * as Obj from '@/lib/object-utils'
import type * as Rx from '@/lib/rxjs'
import * as Templating from '@/lib/templating'
import { z } from '@/lib/zod'
import * as ZodUtils from '@/lib/zod-utils'
import * as AAR from '@/models/admin-action-reasons.models.ts'
import * as AppEvents from '@/models/app-events.models'
import * as CHAT from '@/models/chat.models.ts'
import * as CMD from '@/models/command.models.ts'
import * as CB from '@/models/constraint-builders'
import * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as LTag from '@/models/layer-tags.models'
import { t } from '@/models/messages.models'
import * as PG from '@/models/player-groupings.models'
import * as SDoc from '@/models/schema-docs.models'
import type * as SS from '@/models/server-state.models'
import * as SM from '@/models/squad.models'
import * as TA from '@/models/team-attribution.models'
import * as RBAC from '@/rbac.models'

// ============================== rbac (moved out of the deploy-time config so it's admin-editable at runtime) ==============================

// Everything about a role lives under `roles[roleId]`: its permissions, timeout cap, restricted settings grants, and
// which discord entities it's assigned to. Consolidating per-role (rather than five parallel role-keyed maps) makes the
// "a role must be defined to be referenced" invariant structural, so the schema no longer has to police it.
// dotted path into a settings document, e.g. "vote.voteDuration" or just "vote" for the whole section
const DOTTED_SETTINGS_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/
const SettingsGrantPathSchema = z.string().trim().min(1).regex(DOTTED_SETTINGS_PATH, {
	error: 'Must be a dotted setting path, e.g. "vote.voteDuration"',
})

// ============================== comments ==============================

// Freeform prose on any setting, keyed by its dotted path (a leaf, or a section for the whole subtree). Lives inside
// the settings document, so a comment is staged, diffed, saved and audited exactly like the value it annotates. The
// GUI shows it under the field's name; the YAML editor renders it as `#` lines above the key and reads it back from
// there. Absent rather than empty when there are none, so a document without comments has no `comments` key at all.
export const COMMENTS_KEY = 'comments'
export const SETTING_COMMENT_MAX_LENGTH = 1200
export const SettingCommentSchema = z.string().trim().min(1).max(SETTING_COMMENT_MAX_LENGTH)
export const SettingsCommentsSchema = z.record(z.string().regex(DOTTED_SETTINGS_PATH), SettingCommentSchema)
export type SettingsComments = z.infer<typeof SettingsCommentsSchema>

type Commentable = { [COMMENTS_KEY]?: SettingsComments }

// copy-on-write. A cleared comment leaves no key behind, and an emptied map no `comments` key.
export function withSettingComment<T extends Commentable>(settings: T, path: string, comment: string | null): T {
	const trimmed = comment?.trim() || null
	const prev = settings.comments ?? {}
	if ((prev[path] ?? null) === trimmed) return settings
	const next = { ...prev }
	if (trimmed === null) delete next[path]
	else next[path] = trimmed
	return withComments(settings, next)
}

function withComments<T extends Commentable>(settings: T, comments: SettingsComments): T {
	if (Object.keys(comments).length === 0) return Obj.exclude(settings, [COMMENTS_KEY]) as T
	return { ...settings, comments }
}

// The comments strictly below `path`, re-keyed relative to it: what a YAML editor over that subtree renders. The
// subtree's own comment stays out, since the editor's document root has no key to hang it on.
export function subtreeComments(comments: SettingsComments | undefined, path: string): SettingsComments {
	const out: SettingsComments = {}
	for (const [p, text] of Object.entries(comments ?? {})) {
		if (p.startsWith(path + '.')) out[p.slice(path.length + 1)] = text
	}
	return out
}

export function withSubtreeComments<T extends Commentable>(settings: T, path: string, relative: SettingsComments): T {
	const next: SettingsComments = {}
	for (const [p, text] of Object.entries(settings.comments ?? {})) {
		if (!p.startsWith(path + '.')) next[p] = text
	}
	for (const [p, text] of Object.entries(relative)) next[`${path}.${p}`] = text
	if (Obj.deepEqual(next, settings.comments ?? {})) return settings
	return withComments(settings, next)
}

// a comment is authorized like the setting it annotates, so a change under `comments.` is checked at that path
export function settingPathForChange(path: string): string {
	return path.startsWith(COMMENTS_KEY + '.') ? path.slice(COMMENTS_KEY.length + 1) : path
}

// discord ids are kept as strings here (ParsableBigInt) so they round-trip cleanly through the JSON settings editor /
// settings GUI; rbac.server converts them to bigint at the boundary
const RoleAssignmentsSchema = z
	.object({
		discordRoleIds: z
			.array(ZodUtils.ParsableBigIntSchema)
			.prefault([])
			.meta(SDoc.of({ label: t('Discord Role IDs'), description: t('Discord role ids whose members are granted this role') })),
		discordUserIds: z
			.array(ZodUtils.ParsableBigIntSchema)
			.prefault([])
			.meta(SDoc.of({ label: t('Discord User IDs'), description: t('Discord user ids granted this role') })),
		everyMember: z
			.boolean()
			.prefault(false)
			.meta(SDoc.of({ label: t('Every Member'), description: t('Grant this role to every member of the Discord server') })),
		ingameAdminLists: z
			.array(SM.AdminListIdSchema)
			.prefault([])
			.meta(
				SDoc.of({
					label: t('In-game Admin Lists'),
					description: t(
						"Grant this role to the in-game admins of the named admin lists. A player counts as an admin of a list when that list places them in a group holding one of the list's own admin-identifying permissions. The role only applies on servers that actually use the named list.",
					),
				}),
			),
		adminListGroups: z
			.array(
				z.object({
					listId: SM.AdminListIdSchema.meta(SDoc.of({ label: t('List ID'), description: t('The admin list the group belongs to') })),
					groupId: z
						.string()
						.min(1)
						.meta(SDoc.of({ label: t('Group ID'), description: t('The group name within that list') })),
				}),
			)
			.prefault([])
			.meta(
				SDoc.of({
					label: t('Admin List Groups'),
					description: t(
						'Grant this role by admin-list group membership. A player gets it while the named list places them in the named group, admin-identifying or not (e.g. a Whitelist reserve-slot group), and only on servers that use that list.',
					),
				}),
			),
	})
	.prefault({})

const ServerSettingsGrantSchema = z.object({
	access: z
		.enum(['read', 'write', 'write-sensitive'])
		.prefault('write')
		.meta(
			SDoc.of({
				label: t('Access'),
				description: t(
					'read = view settings (never connection details); write = edit non-sensitive settings; write-sensitive = view and edit the RCON/SFTP connection details',
				),
			}),
		),
	serverIds: z
		.array(z.string())
		.prefault([])
		.meta(SDoc.of({ label: t('Server IDs'), description: t('Server ids this grant applies to; empty = all servers') })),
	paths: z
		.array(SettingsGrantPathSchema)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Paths'),
				description: t(
					'Write grants only: dotted setting paths to restrict the grant to (e.g. "queue.mainPool"); empty = all non-sensitive settings',
				),
			}),
		),
})

// A server-scoped permission restricted to specific servers. The unrestricted (all-servers) form is the bare
// expression in `permissions`, so a grant here always names at least one server.
const ServerGrantSchema = z.object({
	permission: RBAC.SERVER_PERMISSION_TYPE.meta(
		SDoc.of({ label: t('Permission'), description: t('The server-scoped permission this grant covers') }),
	),
	serverIds: z
		.array(z.string())
		.min(1)
		.meta(SDoc.of({ label: t('Server IDs'), description: t('Server ids this grant applies to') })),
})

// An action a plugin declares, granted to this role. Stored as plain strings rather than validated against a
// live registry: plugins load long after settings do, so a grant has to survive its plugin being stopped,
// uninstalled or not yet activated. An id nothing declares simply grants nothing.
const PluginGrantSchema = z.object({
	pluginId: z
		.string()
		.min(1)
		.meta(SDoc.of({ label: t('Plugin ID'), description: t('The plugin that declares the action') })),
	permission: z
		.string()
		.min(1)
		.meta(SDoc.of({ label: t('Permission'), description: t('The action, as the plugin declares it') })),
	serverIds: z
		.array(z.string())
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Server IDs'),
				description: t('Server ids this grant applies to; empty = all servers, which is also what a plugin-wide action needs'),
			}),
		),
})

const RoleConfigSchema = z.object({
	permissions: z
		.array(RBAC.ROLE_PERMISSION_EXPRESSION)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Permissions'),
				description: t(
					'Permissions granted by this role. Settings permissions granted here are unrestricted (all servers / all settings); use the settings-grants below for restricted grants.',
				),
			}),
		),
	// "up to N" comparisons can't ride the permission-expression grammar (grants are equality-matched), so the timeout cap
	// is its own field. Absent = the role cannot issue timeouts; negation doesn't apply, drop the field instead.
	maxTimeout: ZodUtils.HumanTime.optional().meta(
		SDoc.of({
			label: t('Max Timeout'),
			description: t(
				'Maximum kick-timeout duration (e.g. "2h"). Absent = this role cannot issue timeouts. Super users/roles are unlimited.',
			),
		}),
	),
	maxLayerRequests: z
		.number()
		.int()
		.positive()
		.optional()
		.meta(
			SDoc.of({
				label: t('Max Layer Requests'),
				description: t(
					'Maximum concurrent layer requests (backburner items) the role may hold. Absent = this role cannot request layers. Super users/roles are unlimited.',
				),
			}),
		),
	// restricted settings grants, like maxTimeout these carry arguments the expression grammar can't: they let the role
	// edit only specific settings (and for servers, only specific servers). Unrestricted access is granted via `permissions`.
	globalSettingsGrants: z
		.array(SettingsGrantPathSchema)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Global Settings Grants'),
				description: t(
					'Restricted global-settings write grants: dotted setting paths the role may edit (e.g. "vote.voteDuration", or "vote" for the whole section). Any grant also lets the role view global settings. A "!global-settings:write" denial in permissions overrides these.',
				),
			}),
		),
	serverSettingsGrants: z
		.array(ServerSettingsGrantSchema)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Server Settings Grants'),
				description: t(
					'Restricted server-settings grants. Any grant also lets the role view the server\'s (non-sensitive) settings. Matching "!server-settings:*" denials in permissions override these.',
				),
			}),
		),
	serverGrants: z
		.array(ServerGrantSchema)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Server Grants'),
				description: t(
					'Restricted grants of the per-server permissions (queue, votes, in-game actions), limited to specific servers. Granting one of these in `permissions` instead applies it to every server. A matching denial in permissions overrides these.',
				),
			}),
		),
	pluginGrants: z
		.array(PluginGrantSchema)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Plugin Grants'),
				description: t(
					'Actions the installed plugins define for themselves. Each names the plugin and the action; a grant for a plugin that is not running does nothing, and is kept so stopping a plugin does not lose it.',
				),
			}),
		),
	assignments: RoleAssignmentsSchema.meta(
		SDoc.of({ label: t('Assignments'), description: t('Which discord roles/users/members are granted this role') }),
	),
})

export const RbacSettingsSchema = z
	.object({
		roles: z
			.record(RBAC.UserDefinedRoleIdSchema, RoleConfigSchema)
			.prefault({})
			.meta(SDoc.of({ label: t('Roles'), description: t('Defined roles, keyed by id.') })),
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
// comments are excluded from both: they're annotations on the grantable settings, authorized through those
export function globalSettingsTopLevelKeys(): string[] {
	return Object.keys(GlobalSettingsSchema.shape).filter((k) => k !== COMMENTS_KEY)
}
// connections are deliberately excluded: they're only reachable via server-settings:write-sensitive, never a path grant
export function serverSettingsGrantableTopLevelKeys(): string[] {
	return Object.keys(ServerSettingsSchema.shape).filter((k) => k !== 'connections' && k !== COMMENTS_KEY)
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
		label: z.string().meta(SDoc.of({ label: t('Label') })),
		url: z.url().meta(SDoc.of({ label: t('URL') })),
	}),
)

// ============================== integrations ==============================

// The third-party services SLM authenticates to, configured from the settings page rather than the environment so
// a token can be rotated without a redeploy. Each token is a secret (see SECRET_SETTING_PATHS): encrypted at
// rest, never sent to a browser once saved, and replaced by typing over the placeholder. The api hosts stay in
// the environment (BM_HOST and friends): only a dev instance or a test ever points one at a stub.
const IntegrationToggleSchema = z
	.boolean()
	.prefault(true)
	.meta(SDoc.of({ label: t('Enabled'), description: t('Turn the integration off while keeping its token configured.') }))

export const IntegrationsSchema = z
	.object({
		battlemetrics: z
			.object({
				enabled: IntegrationToggleSchema,
				token: z
					.string()
					.prefault('')
					.meta(
						SDoc.of({
							label: t('Token'),
							description: t(
								'A battlemetrics personal access token. It needs player flags (add and remove), player notes (read and create) and rcon (read). Leave it empty if you have no battlemetrics org: nothing is polled, and the features that read it are hidden.',
							),
							secret: true,
						}),
					),
				orgId: z
					.string()
					.prefault('')
					.meta(
						SDoc.of({
							label: t('Organization ID'),
							description: t('The battlemetrics organization the token belongs to. Player flags are filtered to it.'),
						}),
					),
			})
			.prefault({})
			.meta(
				SDoc.of({
					label: t('Battlemetrics'),
					description: t('Player flags, notes and profiles, and the moderation actions that read them.'),
				}),
			),
		squadBrowser: z
			.object({
				enabled: IntegrationToggleSchema,
				token: z
					.string()
					.prefault('')
					.meta(
						SDoc.of({
							label: t('API Key'),
							description: t(
								"A squad browser api key, which starts with 'sqb_'. It resolves a server's name into the join link behind the dashboard's join button. Leave it empty if you have no key: the button falls back to steam, or is hidden.",
							),
							secret: true,
						}),
					),
			})
			.prefault({})
			.meta(SDoc.of({ label: t('Squad Browser'), description: t("The join link behind the dashboard's join button.") })),
		steam: z
			.object({
				enabled: IntegrationToggleSchema,
				token: z
					.string()
					.prefault('')
					.meta(
						SDoc.of({
							label: t('API Key'),
							description: t(
								'A steam web api key, from https://steamcommunity.com/dev/apikey. It reads the lobby of a player in game, which is the half of a join link the squad browser is otherwise asked for. Leave it empty if you have no key.',
							),
							secret: true,
						}),
					),
			})
			.prefault({})
			.meta(
				SDoc.of({
					label: t('Steam'),
					description: t('A join link built from the lobby a player in game reports, where the squad browser cannot resolve one.'),
				}),
			),
	})
	.prefault({})
	.meta(
		SDoc.of({
			label: t('Integrations'),
			description: t(
				'Third-party services SLM talks to. A token is stored encrypted and never shown again once saved: the field shows a placeholder, and typing in it replaces the token.',
			),
		}),
	)

export type Integrations = z.infer<typeof IntegrationsSchema>
export type IntegrationConfig = { enabled: boolean; token: string }

// an integration is in use when it is switched on and has something to authenticate with
export function integrationEnabled(config: IntegrationConfig): boolean {
	return config.enabled && config.token !== ''
}

// ============================== global settings ==============================

export const GlobalSettingsSchema = z
	.object({
		topBarColor: z
			.string()
			.prefault('green')
			.nullable()
			.meta(
				SDoc.of({
					label: t('Top Bar Color'),
					description: t(
						"Any CSS colour. Draws the top navigation bar's bottom border, and the accent under the letters of the logo and the favicon, so instances are distinguishable at a glance and in the browser tab. Set to null for the plain mark and a default border.",
					),
				}),
			),
		adminActionReasons: AAR.AdminActionReasonsSchema.meta(
			SDoc.of({
				label: t('Admin Action Reasons'),
				description: t(
					"Preset reasons admins can pick when acting against players. A reason is offered for an action only where it has text for that action, so every reason needs at least one. The text reaches the player verbatim and takes '{{label}},' '{{duration}}' (timeouts only), '{{squadName}}' (the target squad's name when the action targets a whole squad, empty otherwise) and any Message Variables below.",
				),
			}),
		),
		requireReasonFor: z
			.array(AAR.REQUIRABLE_ADMIN_ACTION_TYPE)
			.prefault([])
			.meta(
				SDoc.of({
					label: t('Require a Reason'),
					description: t(
						'Actions that require a reason (a preset or custom text). Performing one of these without a reason is rejected.',
					),
				}),
			),
		messageVariables: z
			.array(
				z.object({
					name: z
						.string()
						.trim()
						.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
							error: 'Letters, digits and underscore only; must not start with a digit',
						})
						.meta(SDoc.of({ label: t('Name') })),
					value: z.string().meta(SDoc.of({ label: t('Value') })),
				}),
			)
			.prefault([])
			.meta(
				SDoc.of({
					label: t('Message Variables'),
					description: t(
						'Custom variables usable in any admin action reason as \'{{name}}\' (e.g. name "discord", value "discord.gg/xyz"). A value is itself a template, so it can reference the other variables here, as long as the references do not form a cycle.',
					),
				}),
			),
		chat: CHAT.ChatConfigSchema.prefault({}).meta(
			SDoc.of({
				label: t('Chat Feed Suppression'),
				description: t('What the live chat feed leaves out. Neither list changes what is actually sent in-game.'),
			}),
		),
		logFilePollInterval: ZodUtils.HumanTime.prefault('1s').meta(
			SDoc.of({ label: t('Log File Poll Interval'), description: t('How often a local-file log source checks the log for new lines.') }),
		),
		seedSandboxServer: z
			.boolean()
			.prefault(true)
			.meta(
				SDoc.of({
					label: t('Seed Sandbox Server'),
					description: t(
						'Create a sandbox server on startup if none exists. A sandbox has no real squad server behind it: SLM emulates one in-process, so it is somewhere to learn the queue, try a filter or reproduce a bug without touching anyone real. Turning this off leaves any existing sandbox alone; delete it from the server registry to be rid of it.',
					),
				}),
			),
		tickRateThresholds: z
			.object({
				good: z
					.number()
					.positive()
					.prefault(60)
					.meta(
						SDoc.of({
							label: t('Good'),
							description: t('At or above this tick rate the live server tick rate displays as good (green)'),
						}),
					),
				warning: z
					.number()
					.positive()
					.prefault(50)
					.meta(
						SDoc.of({
							label: t('Warning'),
							description: t(
								'At or above this tick rate (but below the good threshold) the tick rate displays as a warning (yellow); below it, as unhealthy (red)',
							),
						}),
					),
			})
			.prefault({})
			.meta(SDoc.of({ label: t('Tick Rate Thresholds'), description: t('Thresholds for coloring the live server tick rate display') })),
		playerFlagsRequiringNote: z
			.array(z.uuid())
			.prefault([])
			.meta(
				SDoc.of({
					label: t('Player Flags Requiring a Note'),
					description: t(
						"Flags (by id) that require a reason to be given when added, which is included in the note posted to the player's BattleMetrics profile",
					),
				}),
			),
		playerGroupings: PG.PlayerGroupingsSchema.prefault(PG.EMPTY_PLAYER_GROUPINGS).meta(
			SDoc.of({
				label: t('Player Grouping Modes'),
				description: t(
					'Named ways of sorting players into coloured groups. Each grouping mode is an ordered list of rules assigning players to groups, highest priority first; the players panel and activity charts pick which grouping mode to show.',
				),
			}),
		),
		teamAttribution: TA.SettingsSchema.prefault(TA.DEFAULT_SETTINGS).meta(
			SDoc.of({
				label: t('Team Attribution'),
				description: t(
					'How players of a finished match are attributed to a team for the historical team breakdown: each player counts for the team they spent the most time on. These thresholds carve marginal players out of the breakdown chart; carved-out players still appear in the historical teams view, flagged. Players who never joined a squad or never took part in a kill or wound are always carved out.',
				),
			}),
		),
		navLinks: NavLinkSchema.optional().meta(
			SDoc.of({
				label: t('Nav Links'),
				description: t(
					'Links to display in the navbar dropdown menu, on every page. Each server can add links of its own on top of these.',
				),
			}),
		),
		warnOnSlmStart: z
			.boolean()
			.prefault(false)
			.meta(SDoc.of({ label: t('Warn on SLM Start'), description: t('Warn all in-game admins when SLM starts or restarts.') })),
		discord: z
			.object({
				expandHistoryLinks: z
					.boolean()
					.prefault(true)
					.meta(
						SDoc.of({
							label: t('Expand History Links'),
							description: t(
								'Reply to a message linking a selection on the history page with the selected events as text. Only for a poster who can use SLM, and only from the servers they can see. Needs Message Content Intent switched on for the bot in the discord developer portal.',
							),
						}),
					),
			})
			.prefault({})
			.meta(SDoc.of({ label: t('Discord'), description: t("What SLM's discord bot does in your discord server.") })),
		allowedPrefixes: z
			.array(CMD.PrefixConfigSchema)
			.min(1)
			.prefault([{ prefix: CMD.DEFAULT_PREFIX, replyToUnknown: true }])
			.meta(
				SDoc.of({
					label: t('Allowed Prefixes'),
					description: t('Prefixes an in-game command may start with. Every command trigger must begin with one of these.'),
				}),
			),
		defaultPrefix: CMD.PrefixSchema.prefault(CMD.DEFAULT_PREFIX).meta(
			SDoc.of({
				label: t('Default Prefix'),
				description: t('The allowed prefix that commands introduced by future SLM versions are seeded with'),
			}),
		),
		commands: CMD.AllCommandConfigSchema.meta(SDoc.of({ label: t('Commands') })),
		adminLists: z
			.record(SM.AdminListIdSchema, SM.AdminListDefSchema)
			.prefault({})
			.meta(
				SDoc.of({
					label: t('Admin Lists'),
					description: t(
						"The admin lists this install knows about, by name. Each serves the same Admins.cfg the gameserver reads, in the same format, and carries its own admin-identifying permissions. Naming them is what lets a server choose which apply to it and a role assignment say which list's groups it means.",
					),
				}),
			),
		rbac: RbacSettingsSchema.meta(SDoc.of({ label: t('Roles') })),
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
		}).meta(SDoc.of({ label: t('Layer Table'), description: t('Configures the appearance of the layers table and layer select menu') })),
		layerTags: LTag.TagsSchema.meta(SDoc.of({ label: t('Layer Tags') })),
		layerGeneration: LC.LayerGenerationConfigSchema.prefault({
			pickOrder: ['Map', 'Gamemode', 'Faction_1', 'Faction_2', 'Unit_1', 'Unit_2'],
		}).meta(
			SDoc.of({
				label: t('Layer Generation Weights'),
				description: t(
					"How layers are picked during generation, vote generation and the layer table's random sort. Each column or matchup in the pick order is drawn weighted-randomly in turn, narrowing the pool the next one draws from.",
				),
			}),
		),
		integrations: IntegrationsSchema,
		comments: SettingsCommentsSchema.optional().meta(SDoc.of({ label: t('Comments') })),
	})
	.superRefine((val, ctx) => {
		const allowedPrefixes = val.allowedPrefixes ?? [{ prefix: CMD.DEFAULT_PREFIX, replyToUnknown: true }]
		const prefixList = allowedPrefixes.map((p) => p.prefix).join(', ')
		const seenPrefix = new Set<string>()
		allowedPrefixes.forEach(({ prefix }, i) => {
			if (seenPrefix.has(prefix)) {
				ctx.addIssue({ code: 'custom', message: `Duplicate prefix "${prefix}"`, path: ['allowedPrefixes', i, 'prefix'] })
			}
			seenPrefix.add(prefix)
		})
		// commands seeded for future SLM versions take defaultPrefix, so it has to be one an admin actually accepts;
		// otherwise the next release's new commands would fail this schema on load and refuse to boot
		const defaultPrefix = val.defaultPrefix ?? CMD.DEFAULT_PREFIX
		if (!seenPrefix.has(defaultPrefix)) {
			ctx.addIssue({
				code: 'custom',
				message: `Default prefix "${defaultPrefix}" must be one of the allowed prefixes (${prefixList})`,
				path: ['defaultPrefix'],
			})
		}
		const hasAllowedPrefix = (s: string) => allowedPrefixes.some((p) => s.startsWith(p.prefix))
		const prefixIssue = (s: string, noun: string, path: (string | number)[]) => {
			ctx.addIssue({
				code: 'custom',
				message: `${noun} "${s}" must start with one of the allowed prefixes (${prefixList})`,
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

		const messageVariables = val.messageVariables ?? []
		for (const cycle of Templating.templateVarCycles(messageVariables)) {
			const members = new Set(cycle)
			messageVariables.forEach((v, i) => {
				if (!members.has(v.name)) return
				ctx.addIssue({
					code: 'custom',
					message: `Message variables reference each other in a cycle: ${cycle.join(' -> ')}`,
					path: ['messageVariables', i, 'value'],
				})
			})
		}
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
		'history:query',
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
		'battlemetrics:write-notes',
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
				// every global setting except the permissions config and the integration credentials
				globalSettingsGrants: globalSettingsTopLevelKeys().filter((k) => k !== 'rbac' && k !== 'integrations'),
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

// A fresh server is assumed to run stock Squad. The name is the catalog's, spelled out here rather than resolved
// through L.getDefaultCollection because a zod prefault is a value, evaluated when this module loads, and layer
// data is not loaded yet at that point.
const DEFAULT_INSTALLED_MODS = ['OWI'] as const

// autogen on by default: a fresh server that generates layers violating its own repeat rules is never what
// anyone wants, and the per-rule option is there to turn it off
const DEFAULT_REPEAT_RULE_CONFIGS: PoolRepeatRuleConfig[] = [
	{ field: 'Map', within: 4, autogen: true, warn: true, indicate: true },
	{ field: 'Layer', within: 7, autogen: true, warn: true, indicate: true },
	{ field: 'Faction', within: 3, autogen: true, warn: true, indicate: true },
]

export const POOL_FILTER_APPLY_AS = z.enum(['regular', 'inverted', 'disabled'])
export type PoolFilterApplyAs = z.infer<typeof POOL_FILTER_APPLY_AS>

export const POOL_FILTER_MODE = z.enum(['include', 'exclude'])
export type PoolFilterMode = z.infer<typeof POOL_FILTER_MODE>

export const PoolFilterSettingSchema = z.object({
	filterId: F.FilterEntityIdSchema.meta(SDoc.of({ label: t('Filter ID') })),
	mode: POOL_FILTER_MODE.meta(
		SDoc.of({ label: t('Mode'), description: t('Whether layers matching this filter are included in the pool or excluded from it') }),
	),
})
export type PoolFilterSetting = z.infer<typeof PoolFilterSettingSchema>

export const APPLIED_FILTER_APPLY_AS = z.enum(['regular', 'inverted'])
export type AppliedFilterApplyAs = z.infer<typeof APPLIED_FILTER_APPLY_AS>

export const AppliedFilterSettingSchema = z.object({
	filterId: F.FilterEntityIdSchema.meta(SDoc.of({ label: t('Filter ID') })),
	applyAs: APPLIED_FILTER_APPLY_AS.meta(
		SDoc.of({
			label: t('Apply as'),
			description: t('Whether the filter applies to layers matching it (regular) or layers NOT matching it (inverted)'),
		}),
	),
})
export type AppliedFilterSetting = z.infer<typeof AppliedFilterSettingSchema>

export const SELECTABLE_FILTER_APPLY_AS = z.enum(['regular', 'inverted', 'disabled'])
export type SelectableFilterApplyAs = z.infer<typeof SELECTABLE_FILTER_APPLY_AS>

export const SelectableFilterSettingSchema = z.object({
	filterId: F.FilterEntityIdSchema.meta(SDoc.of({ label: t('Filter ID') })),
	applyAs: SELECTABLE_FILTER_APPLY_AS.meta(
		SDoc.of({
			label: t('Apply as'),
			description: t(
				'The state the filter starts in during layer selection: applied (regular), applied inverted, or offered but not applied (disabled)',
			),
		}),
	),
})
export type SelectableFilterSetting = z.infer<typeof SelectableFilterSettingSchema>

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

export type PoolRepeatRuleConfig = z.infer<typeof RepeatRuleConfigSchema>

export const PoolConfigurationSchema = z.object({
	poolFilter: PoolFilterSettingSchema.nullable()
		.prefault(null)
		.meta(
			SDoc.of({
				label: t('Pool Filter'),
				description: t(
					'The single filter defining pool membership. Out-of-pool layers can only be queued by users with the queue:force-write permission, are warned about, and are never autogenerated. The filter entity must have both its match and miss indicators (emoji + alert message) configured.',
				),
			}),
		),
	indicateMatches: z
		.array(F.FilterEntityIdSchema)
		.prefault([])
		.meta(
			SDoc.of({ label: t('Indicate Matches'), description: t("Layers matching these filters display the filter's match indicator") }),
		),
	indicateMisses: z
		.array(F.FilterEntityIdSchema)
		.prefault([])
		.meta(
			SDoc.of({ label: t('Indicate Misses'), description: t("Layers NOT matching these filters display the filter's miss indicator") }),
		),
	defaultSelectable: z
		.array(SelectableFilterSettingSchema)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Selectable by Default'),
				description: t('Filters offered during layer selection, starting in the given state'),
			}),
		),
	warnFor: z
		.array(AppliedFilterSettingSchema)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Warn For'),
				description: t('Warn when a layer matching the filter in the given state is queued or about to be played'),
			}),
		),
	constrainGeneration: z
		.array(AppliedFilterSettingSchema)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Constrain Generation'),
				description: t('Autogenerated layers are constrained by these filters in the given state, in addition to the pool filter'),
			}),
		),
	layerRequestFilters: z
		.array(AppliedFilterSettingSchema)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Layer Request Filters'),
				description: t(
					'Layer requests carry these filters in the given state. Requests made in game always do; the request dialog starts with them applied.',
				),
			}),
		),
	skipWarningsForTags: z
		.array(LTag.TagIdSchema)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Skip Warnings for Tags'),
				description: t(
					'Queue items carrying any of these tags raise no warnings: not when saving the queue, and not in the next-layer message admins are shown in game. Being out of pool still gates saving on queue:force-write.',
				),
			}),
		),
	repeatRules: z.array(RepeatRuleConfigSchema).meta(
		SDoc.of({
			label: t('Repeat Rules'),
			description: t(
				'How far apart a map, layer or faction has to be spaced in the queue and recent match history. Each rule can warn when it is broken, constrain autogeneration, or both.',
			),
		}),
	),
})

export type PoolConfiguration = z.infer<typeof PoolConfigurationSchema>
export const RconConnectionSchema = z.object({
	host: z
		.string()
		.min(1)
		.meta(SDoc.of({ label: t('Host') })),
	port: z
		.number()
		.min(1)
		.max(65535)
		.meta(SDoc.of({ label: t('Port') })),
	password: z
		.string()
		.min(1)
		.meta(SDoc.of({ label: t('Password'), secret: true })),
})
export type RconConnection = z.infer<typeof RconConnectionSchema>

export const SftpLogConnectionSchema = z.object({
	host: z
		.string()
		.min(1)
		.meta(SDoc.of({ label: t('Host') })),
	port: z
		.number()
		.min(1)
		.max(65535)
		.meta(SDoc.of({ label: t('Port') })),
	username: z
		.string()
		.min(1)
		.meta(SDoc.of({ label: t('Username') })),
	password: z
		.string()
		.min(1)
		.meta(SDoc.of({ label: t('Password'), secret: true })),
	logFile: z
		.string()
		.min(1)
		.meta(SDoc.of({ label: t('Log File') })),
	pollInterval: ZodUtils.HumanTime.prefault('1s').meta(
		SDoc.of({ label: t('Poll Interval'), description: t('How often to poll the remote log file over SFTP for new lines.') }),
	),
	reconnectInterval: ZodUtils.HumanTime.prefault('5s').meta(
		SDoc.of({ label: t('Reconnect Interval'), description: t('How long to wait between SFTP reconnection attempts.') }),
	),
	maxReconnectAttempts: z
		.int()
		.min(1)
		.prefault(10)
		.meta(
			SDoc.of({
				label: t('Max Reconnect Attempts'),
				description: t('How many consecutive SFTP failures to tolerate (reconnecting between each) before tearing down the server.'),
			}),
		),
})

export const SandboxConnectionSchema = z.object({
	type: z.literal('sandbox').meta(SDoc.of({ label: t('Type') })),
	serverName: z
		.string()
		.min(1)
		.prefault('SLM Sandbox')
		.meta(SDoc.of({ label: t('Server Name'), description: t('The name the emulated server reports over RCON.') })),
	maxPlayers: z
		.int()
		.min(2)
		.max(200)
		.prefault(100)
		.meta(SDoc.of({ label: t('Max Players'), description: t('The player slot count the emulated server reports.') })),
	// Pacing overrides for scenario-driven sandboxes (tutorials). Absent means the emulator's realistic defaults:
	// a ~30s post-match wait and constant tick chatter. A tutorial turns the wait down so a staged roll is quick
	// and silences the chatter so the narrated log stays legible.
	postMatchDelayMs: z
		.int()
		.min(0)
		.optional()
		.meta(
			SDoc.of({
				label: t('Post-match Delay (ms)'),
				description: t('ms in WaitingPostMatch before the next world comes up. Omit for the realistic 30s.'),
			}),
		),
	tickChatter: z
		.boolean()
		.optional()
		.meta(
			SDoc.of({
				label: t('Tick Chatter'),
				description: t('Whether the emulated server emits its periodic tick-rate log lines. Omit to keep them.'),
			}),
		),
	// The layer the emulated server should hold as next at boot. A scenario-seeded sandbox sets this to its queue
	// head so SLM's first reconcile sees the head already staged, rather than the emulator's default seed -- which
	// it would otherwise pull into the queue as an external layer change and displace what the scenario seeded.
	nextLayerId: z
		.string()
		.optional()
		.meta(
			SDoc.of({
				label: t('Next Layer ID'),
				description: t('Layer id the emulated server holds as next at boot. Omit for the emulator default.'),
			}),
		),
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
export const ServerConnectionSchema = z
	.discriminatedUnion('type', [
		z.object({
			type: z.literal('local').meta(SDoc.of({ label: t('Type') })),
			logFile: z
				.string()
				.min(1)
				.meta(SDoc.of({ label: t('Log File') })),
			rcon: RconConnectionSchema.meta(SDoc.of({ label: t('RCON') })),
		}),
		z.object({
			type: z.literal('sftp').meta(SDoc.of({ label: t('Type') })),
			rcon: RconConnectionSchema.meta(SDoc.of({ label: t('RCON') })),
			sftp: SftpLogConnectionSchema.meta(SDoc.of({ label: t('SFTP Log Source') })),
		}),
		z.object({
			type: z.literal('server-agent').meta(SDoc.of({ label: t('Type') })),
			token: z
				.string()
				.default('dev')
				.meta(SDoc.of({ label: t('Agent Token'), secret: true })),
		}),
		SandboxConnectionSchema,
	])
	.meta(SDoc.of({ options: { local: t('Local file'), sftp: t('SFTP'), 'server-agent': t('Server agent'), sandbox: t('Sandbox') } }))
export type ServerConnection = z.infer<typeof ServerConnectionSchema>
export type SandboxConnection = z.infer<typeof SandboxConnectionSchema>

// Why SLM stopped writing the rotation. The reason is the state: there is no separate flag, so a disabled server
// can never be missing one. 'ingame-vote' is set by SLM itself when it detects Squad's own vote and stands down --
// no user-facing control offers it, though the raw JSON editor can express it like any other value.
export const SlmUpdatesDisabledSchema = z.discriminatedUnion('type', [
	// `by` is null for settings written before disabling recorded who did it
	z.object({
		type: z.literal('manual').meta(SDoc.of({ label: t('Type') })),
		by: AppEvents.ActorSchema.nullable().meta(SDoc.of({ label: t('Disabled By') })),
	}),
	// `inferred` marks the reason as deduced rather than observed: SLM never saw the vote's log lines, it saw the
	// server stop having a next layer, which is what enabling voting does. Everything treats the two the same; only
	// what is shown to an admin differs, since a guess should not be stated as fact.
	z.object({
		type: z.literal('ingame-vote').meta(SDoc.of({ label: t('Type') })),
		inferred: z
			.boolean()
			.prefault(false)
			.meta(SDoc.of({ label: t('Inferred') })),
	}),
])
export type SlmUpdatesDisabled = z.infer<typeof SlmUpdatesDisabledSchema>

export const QueueSettingsSchema = z.object({
	maxQueueSize: z
		.int()
		.min(1)
		.max(100)
		.prefault(20)
		.meta(
			SDoc.of({
				label: t('Max Queue Size'),
				description: t('How long the queue is meant to get. Reaching it turns the queue counter red; nothing is rejected.'),
			}),
		),
	// unset by default; the inner prefault is what the field fills in when it is switched back on
	lowQueueWarningThreshold: z
		.number()
		.positive()
		.prefault(1)
		.nullable()
		.prefault(null)
		.meta(
			SDoc.of({
				label: t('Low Queue Warning Threshold'),
				description: t(
					'Admins are warned after a map roll when the queue holds this many items or fewer. Unset to never warn about a short queue.',
				),
			}),
		),
	adminQueueReminderInterval: ZodUtils.HumanTime.prefault('10m').meta(
		SDoc.of({
			label: t('Admin Queue Reminder Interval'),
			description: t('How often to remind admins to maintain the queue. Low queue warnings happen half as often.'),
		}),
	),
	mainPool: PoolConfigurationSchema.prefault({ repeatRules: DEFAULT_REPEAT_RULE_CONFIGS }).meta(
		SDoc.of({ label: t('Main Pool'), description: t('Which layers this server considers playable, and which of them it warns about.') }),
	),
	layerRequests: z
		.object({
			maxTotal: z
				.number()
				.int()
				.positive()
				.prefault(50)
				.meta(
					SDoc.of({
						label: t('Max Total'),
						description: t('Maximum number of layer requests the backburner may hold across all users'),
					}),
				),
		})
		.prefault({})
		.meta(
			SDoc.of({
				label: t('Layer Requests'),
				description: t('Limits on the backburner, where layers players request in-game wait to be picked up.'),
			}),
		),
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
		.meta(
			SDoc.of({
				label: t('Locale'),
				description: t(
					'The language this server talks to its players in: warnings, broadcasts and the in-game vote. A BCP-47 tag such as "en" or "de". Falls back to English wherever a message has not been translated. Does not affect the web app, which follows each viewer\'s own browser.',
				),
			}),
		),
	navLinks: NavLinkSchema.prefault([]).meta(
		SDoc.of({
			label: t('Nav Links'),
			description: t('Links shown in the navbar links dropdown while this server is selected, below the global ones.'),
		}),
	),
	installedMods: z
		.array(z.string().min(1))
		.min(1)
		.prefault([...DEFAULT_INSTALLED_MODS])
		.meta(
			SDoc.of({
				label: t('Installed Mods'),
				description: t(
					'The layer collections this game server has installed, by catalog name. A layer from a collection not listed here cannot load, so SLM refuses to queue it, never generates one, and never offers one as a vote choice. OWI is vanilla Squad.',
				),
			}),
		),
	adminLists: z
		.array(SM.AdminListIdSchema)
		.prefault([])
		.meta(
			SDoc.of({
				label: t('Admin Lists'),
				description: t(
					'Which of the named admin lists (global settings) apply to this server. A player is only an admin here, and only picks up roles assigned by admin-list group, through a list named here. Empty means this server recognises no in-game admins.',
				),
			}),
		),
	updatesToSquadServerDisabled: SlmUpdatesDisabledSchema.nullable()
		.prefault(null)
		.meta(
			SDoc.of({
				label: t('SLM Updates Disabled'),
				opaque: true,
				description: t(
					'Why SLM is not writing the next layer to this server over RCON, or null when it is. The queue still runs and still tracks what is played; SLM just never sets the map itself, and stops sending the recurring in-game reminders and announcements that describe the queue as the rotation. For running SLM alongside something else that owns the rotation.',
				),
			}),
		),
	// no defensive clone of the prefault: zod v4 builds a fresh default per parse, and the shared
	// DEFAULT_REPEAT_RULE_CONFIGS array is never mutated. A transform here would also be one-way, which costs
	// ServerSettingsSchema its encodability -- and the settings editor needs that to show ZodUtils.HumanTime fields as
	// "5s" rather than 5000.
	queue: QueueSettingsSchema.prefault({}).meta(SDoc.of({ label: t('Queue') })),
	vote: z
		.object({
			voteDuration: ZodUtils.HumanTime.prefault('180s').meta(
				SDoc.of({ label: t('Vote Duration'), description: t('How long a vote stays open before it is tallied.') }),
			),
			startVoteReminderThreshold: ZodUtils.HumanTime.prefault('20m').meta(
				SDoc.of({
					label: t('Start Vote Reminder Threshold'),
					description: t('How far into a match admins start being reminded that no vote has been started yet.'),
				}),
			),
			voteReminderInterval: ZodUtils.HumanTime.prefault('30s').meta(
				SDoc.of({ label: t('Vote Reminder Interval'), description: t('How often players are reminded to vote while a vote is open.') }),
			),
			internalVoteReminderInterval: ZodUtils.HumanTime.prefault('15s').meta(
				SDoc.of({
					label: t('Internal Vote Reminder Interval'),
					description: t('How often admins are reminded to vote while an internal (admin-only) vote is open.'),
				}),
			),
			autoStartVoteDelay: ZodUtils.HumanTime.prefault('20m')
				.nullable()
				.meta(
					SDoc.of({
						label: t('Auto Start Vote Delay'),
						description: t(
							'How far into a match SLM starts a vote by itself, when the next queue item is a vote. Unset to only ever start votes manually.',
						),
					}),
				),
			autoStartVoteCutoff: ZodUtils.HumanTime.prefault('30m').meta(
				SDoc.of({
					label: t('Auto Start Vote Cutoff'),
					description: t(
						'How far into a match auto-starting gives up. Past this point starting a vote is left to an admin, so a match running long does not open a vote nobody is around for.',
					),
				}),
			),
			voteDisplayProps: z
				.array(DH.LAYER_DISPLAY_PROP)
				.prefault(['map', 'gamemode'])
				.meta(
					SDoc.of({
						label: t('Vote Display Options'),
						description: t(
							'Which parts of a layer (map, gamemode, factions, units) vote choices spell out. Admins can override this per vote.',
						),
					}),
				),
			finalVoteReminder: ZodUtils.HumanTime.prefault('10s').meta(
				SDoc.of({ label: t('Final Vote Reminder'), description: t('How long before a vote closes the last-chance reminder is sent.') }),
			),
		})
		.prefault({})
		.meta(SDoc.of({ label: t('Votes') })),
	overrideAdminSetNextLayer: z
		.boolean()
		.prefault(false)
		.meta(
			SDoc.of({
				label: t('Override Admin-set Next Layer'),
				description: t(
					'What happens when the next layer is set from outside SLM (an in-game admin, or another RCON tool). On, SLM sets it straight back to whatever the queue says. Off, SLM adopts the change by putting that layer at the front of the queue.',
				),
			}),
		),
	warnOnNextLayerChange: z
		.boolean()
		.prefault(false)
		.meta(
			SDoc.of({
				label: t('Warn on Next Layer Change'),
				description: t('Warn all in-game admins with the new next layer whenever it changes. A change SLM overrides is not announced.'),
			}),
		),
	warnOnGuiTeamswaps: z
		.boolean()
		.prefault(false)
		.meta(
			SDoc.of({
				label: t('Warn on GUI Teamswaps'),
				description: t(
					'Warn all in-game admins when someone swaps players, or edits the queued swaps, from the web dashboard. Swaps made with an in-game command never warn: every admin has already read the command in admin chat.',
				),
			}),
		),
	postRollAnnouncementsTimeout: ZodUtils.HumanTime.prefault('5m').meta(
		SDoc.of({
			label: t('Post Roll Announcements Timeout'),
			description: t(
				'How long after a map rolls before the post-roll announcements: the next layer, whether the queue is running low, and any reminders plugins add.',
			),
		}),
	),
	fogOffDelay: ZodUtils.HumanTime.prefault('25s').meta(
		SDoc.of({
			label: t('Fog Off Delay'),
			description: t(
				'How long after a FRAAS layer starts before fog of war is turned off and announced in-game. Other gamemodes are unaffected.',
			),
		}),
	),
	skipDestroyedOnTrainingLayers: z
		.boolean()
		.prefault(true)
		.meta(
			SDoc.of({
				label: t('Skip Destroyed Vehicles on Training Layers'),
				description: t(
					"Leave vehicles and deployables destroyed, and FOB radios attacked, on training layers (Jensen's Range) out of the feed and history. Players there crash and blow up vehicles on purpose, many times a match.",
				),
			}),
		),
	remindersAndAnnouncementsEnabled: z
		.boolean()
		.prefault(true)
		.meta(
			SDoc.of({
				label: t('Reminders and Announcements'),
				description: t(
					'Whether this server sends admins the recurring nudges: post-roll announcements, queue reminders, and vote reminders.',
				),
			}),
		),
	switchRequests: z
		.object({
			instantSwapLead: z
				.number()
				.int()
				.min(0)
				.prefault(1)
				.meta(
					SDoc.of({
						label: t('Team Size Lead for Instant Switch'),
						description: t(
							"How many players larger a /switch sender's own team must be than the other for the switch to happen immediately. Requests that do not meet this are queued, and the queue drains by the same rule (or by pairing waiters from both sides). 0 lets even teams switch instantly; higher values queue more.",
						),
					}),
				),
		})
		.prefault({})
		.meta(SDoc.of({ label: t('Switch Requests') })),
})

export type PublicServerSettings = z.infer<typeof PublicServerSettingsSchema>

// the settings deciding what SLM does about the next layer, each addressed by its own single-key api in the
// pool-config panels so its checkbox is gated on write access to exactly that setting
export const NEXT_LAYER_SETTING_KEYS = ['overrideAdminSetNextLayer', 'warnOnNextLayerChange'] as const
export type NextLayerSettingKey = (typeof NEXT_LAYER_SETTING_KEYS)[number]

// the mainPool lists that add behavior on top of the pool filter rather than deciding pool membership. The
// pool-config panels render one editor per key, in this order.
export const SECONDARY_LIST_KEYS = [
	'indicateMatches',
	'indicateMisses',
	'defaultSelectable',
	'warnFor',
	'constrainGeneration',
	'layerRequestFilters',
] as const
export type SecondaryListKey = (typeof SECONDARY_LIST_KEYS)[number]

const EXAMPLE_PUBLIC_SETTINGS = PublicServerSettingsSchema.parse({})
EXAMPLE_PUBLIC_SETTINGS.queue.mainPool.poolFilter = { filterId: 'test-filter', mode: 'include' }
EXAMPLE_PUBLIC_SETTINGS.queue.mainPool.defaultSelectable.push({ filterId: 'test-filter', applyAs: 'regular' })

export const ServerSettingsSchema = PublicServerSettingsSchema.extend({
	connections: ServerConnectionSchema.meta(
		SDoc.of({
			label: t('Connections'),
			description: t(
				"How SLM reaches this server. Local: SLM shares the box, reading the log file and dialing RCON directly. SFTP: SLM is remote, tailing the log over SFTP and dialing RCON over the network. Server agent: slm-server-agent runs next to the server and handles both, so the RCON password lives in the agent's config rather than here.",
			),
		}),
	),
	comments: SettingsCommentsSchema.optional().meta(SDoc.of({ label: t('Comments') })),
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

// keyed on the rule's position, which is the only identity a rule has: labels are optional and need not be unique
export function getRepeatRuleConstraintId(poolName: string, index: number) {
	return `layer-pool:${poolName}:${index}`
}

// the per-rule switches, in the shape CB.repeatRule takes. Every path that builds a rule's constraint goes through
// here, so the switches cannot diverge between the queue view, the layer table and the save-time warnings.
export function repeatRuleConstraintOpts(rule: PoolRepeatRuleConfig) {
	return { warn: rule.warn, showIndicator: rule.indicate ? ('regular' as const) : ('disabled' as const) }
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

// The constraint standing for "this server can actually load the layer". Applied as a hard query filter wherever
// layers are being produced (generation, vote choices); left unapplied but indicated wherever layers are being
// picked, so an unsupported layer is shown greyed out rather than silently missing from the catalog.
export function getInstalledModsConstraint(
	settings: PublicServerSettings,
	opts?: { applyAs?: LQY.FilterApplicationState },
): LQY.Constraint {
	return CB.installedMods(settings.installedMods, opts)
}

// The stand-in settings for a context with no managed server: the schema defaults, except that every collection in
// the catalog counts as installed. The layers page and the filter editor describe the catalog, not one server, so
// the default of vanilla-only would wrongly grey out every modded layer there.
export function catalogSettings(components = L.StaticLayerComponents): PublicServerSettings {
	return { ...PublicServerSettingsSchema.parse({}), installedMods: [...components.collections] }
}

export function getSettingsConstraints(settings: PublicServerSettings, opts?: { generatingLayers?: boolean }) {
	const constraints: LQY.Constraint[] = []
	const queue = settings.queue

	constraints.push(getInstalledModsConstraint(settings, { applyAs: opts?.generatingLayers ? 'regular' : 'disabled' }))

	if (opts?.generatingLayers) {
		const poolFilterConstraint = getPoolFilterConstraint(settings)
		if (poolFilterConstraint) constraints.push(poolFilterConstraint)
		for (const { filterId, applyAs } of queue.mainPool.constrainGeneration) {
			constraints.push(CB.filterEntity(`gen:${filterId}`, filterId, { filterApplState: applyAs }))
		}
		queue.mainPool.repeatRules.forEach((rule, index) => {
			if (!rule.autogen) return
			constraints.push(CB.repeatRule(getRepeatRuleConstraintId('mainPool', index), rule))
		})
	} else {
		const poolFilterConstraint = getPoolFilterConstraint(settings, { warn: true })
		if (poolFilterConstraint) constraints.push(poolFilterConstraint)
		constraints.push(...getIndicationAndWarnConstraints(settings))
		queue.mainPool.repeatRules.forEach((rule, index) => {
			constraints.push(CB.repeatRule(getRepeatRuleConstraintId('mainPool', index), rule, repeatRuleConstraintOpts(rule)))
		})
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

// An absent `value` unsets the key, the same thing an absent key means in the settings object the settings page
// sends. It has to be optional: JSON drops an undefined property, so a mutation written as `{path, value: undefined}`
// arrives as `{path}` and a required `value` rejects the whole batch.
export const SettingMutationSchema = z.object({
	path: SettingsPathSchema,
	value: z.any().optional(),
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
	const key = path[path.length - 1]
	// deleted rather than assigned undefined, so an unset optional key compares equal to the settings the server
	// sends back, where it is simply absent
	if (resolvedValue === undefined) delete current[key]
	else current[key] = resolvedValue
}
export function applySettingMutations(settings: PublicServerSettings, mutations: SettingMutation[]) {
	for (const mutation of mutations) {
		applySettingMutation(settings, mutation.path, mutation.value)
	}
}

export function getPublicSettings(settings: ServerSettings): PublicServerSettings {
	return Obj.exclude(settings, ['connections', COMMENTS_KEY])
}

// -------- secrets --------
//
// A field marked `secret: true` in its SDoc is a credential. The marker is the one place that knowledge lives:
// the form renders it as a password field, change lists mask it, the audit log redacts it, the server never
// streams a saved one to a browser, and the database holds it sealed (see secret-box.server.ts). One set of
// paths covers both documents, since a global path and a server path never coincide.

export const SECRET_SETTING_MASK = '••••••••'

// the dotted paths of every secret field, across every branch of every union
export const SECRET_SETTING_PATHS: ReadonlySet<string> = new Set([
	...collectSecretPaths(GlobalSettingsSchema),
	...collectSecretPaths(ServerSettingsSchema),
])

// every proper ancestor of a secret path, so a walk only descends where a secret can be
const SECRET_SETTING_PREFIXES: ReadonlySet<string> = new Set(
	[...SECRET_SETTING_PATHS].flatMap((path) => {
		const parts = path.split('.')
		return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('.'))
	}),
)

export function isSecretSettingPath(path: string): boolean {
	return SECRET_SETTING_PATHS.has(path)
}

// `value` as it sits at `path` ('' for a whole document), with `fn` applied to every secret string under it.
// Copy-on-write: what fn leaves alone is returned by reference, a whole document included.
export function mapSecretSettingValues<T>(path: string, value: T, fn: (value: string, path: string) => string): T {
	if (SECRET_SETTING_PATHS.has(path)) return (typeof value === 'string' ? fn(value, path) : value) as T
	if (path !== '' && !SECRET_SETTING_PREFIXES.has(path)) return value
	if (!value || typeof value !== 'object' || Array.isArray(value)) return value
	let out: Record<string, unknown> | undefined
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const mapped = mapSecretSettingValues(path ? `${path}.${key}` : key, child, fn)
		if (mapped === child) continue
		if (!out) out = { ...(value as Record<string, unknown>) }
		out[key] = mapped
	}
	return (out ?? value) as T
}

// the secret leaves under `path` replaced by `mask`; an empty one stays empty, since "unset" is not a secret
export function maskSecretSettingValue<T>(path: string, value: T, mask: string = SECRET_SETTING_MASK): T {
	return mapSecretSettingValues(path, value, (v) => (v === '' ? v : mask))
}

// A submitted document with the placeholders a browser sent back replaced by the values they stand in for, so a
// save that never touched a token leaves it as stored. `current` is the stored (encoded) document.
export function restoreMaskedSecrets<T>(submitted: T, current: unknown): T {
	return mapSecretSettingValues('', submitted, (v, path) => {
		if (v !== SECRET_SETTING_MASK) return v
		const stored = valueAtPath(current, path)
		return typeof stored === 'string' ? stored : ''
	})
}

// what the audit log keeps of a changed value: the whole `connections` subtree is replaced, since reading it
// takes write-sensitive where the log takes global-settings:read, and elsewhere only the secret leaves
export function redactSettingValue(path: string, value: unknown): unknown {
	if (path === 'connections' || path.startsWith('connections.')) return AppEvents.REDACTED_SETTING
	return maskSecretSettingValue(path, value, AppEvents.REDACTED_SETTING)
}

function valueAtPath(value: unknown, path: string): unknown {
	let cur = value
	for (const key of path.split('.')) {
		if (!cur || typeof cur !== 'object') return undefined
		cur = (cur as Record<string, unknown>)[key]
	}
	return cur
}

// the connection secrets: the RCON password (local/sftp), the SFTP log password, and the server-agent token.
// `fn` is seal, open or reseal (see secret-box.server.ts); in memory they are always plaintext
export function transformConnectionSecretValues(connections: ServerConnection, fn: (value: string) => string): ServerConnection {
	return mapSecretSettingValues('connections', connections, fn)
}

export function transformConnectionSecrets(settings: ServerSettings, fn: (value: string) => string): ServerSettings {
	return { ...settings, connections: transformConnectionSecretValues(settings.connections, fn) }
}

// walks the schema's static structure: objects, unions, arrays, records and the wrappers between them. A
// secret inside a record or array is reported at its element position, which the masking walk matches by index.
function collectSecretPaths(root: z.ZodType): Set<string> {
	const out = new Set<string>()
	const seen = new Set<unknown>()
	const visit = (schema: z.ZodType, path: string) => {
		if (seen.has(schema)) return
		seen.add(schema)
		if (SDoc.read(schema.meta())?.secret) out.add(path)
		const def = (schema as any).def
		const at = (key: string) => (path ? `${path}.${key}` : key)
		switch (def.type) {
			case 'object':
			case 'interface':
				for (const [key, child] of Object.entries(def.shape as Record<string, z.ZodType>)) visit(child, at(key))
				break
			case 'union':
				for (const option of def.options as z.ZodType[]) visit(option, path)
				break
			case 'optional':
			case 'nullable':
			case 'default':
			case 'prefault':
			case 'readonly':
			case 'nonoptional':
			case 'catch':
				visit(def.innerType, path)
				break
			case 'pipe':
				visit(def.in, path)
				visit(def.out, path)
				break
			case 'array':
				visit(def.element, path)
				break
			case 'record':
				visit(def.valueType, path)
				break
			case 'lazy':
				visit(def.getter(), path)
				break
		}
	}
	visit(root, '')
	return out
}

export function dottedSettingsPath(path: string | (string | number)[]): string {
	return typeof path === 'string' ? path : path.join('.')
}

export namespace Grants {
	export function globalSettingsRead(): RBAC.Req {
		return RBAC.Req.any(RBAC.perm('global-settings:read'), RBAC.Req.holdsAnyGrant('global-settings:write'))
	}

	export function writeGlobalSettingsPaths(paths: (SettingsPath | string)[]): RBAC.Req {
		return RBAC.Req.settingsWrite(null, paths.map(dottedSettingsPath).map(settingPathForChange))
	}

	// connections are never a path grant: editing them requires write-sensitive regardless of any write grant
	export function writeServerSettingsPaths(serverId: string, paths: (SettingsPath | string)[]): RBAC.Req {
		const dottedPaths = paths.map(dottedSettingsPath).map(settingPathForChange)
		const isSensitive = (p: string) => p === 'connections' || p.startsWith('connections.')
		const reqs = [
			RBAC.Req.settingsWrite(
				serverId,
				dottedPaths.filter((p) => !isSensitive(p)),
			),
		]
		if (dottedPaths.some(isSensitive)) reqs.push(RBAC.Req.perm('server-settings:write-sensitive', { serverId }))
		return RBAC.Req.all(...reqs)
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
