import * as Schema from '$root/drizzle/schema.ts'
import { objKeys } from '@/lib/object'
import * as ATTRS from '@/models/otel-attrs'
import * as SETTINGS from '@/models/settings.models'
import { initModule } from '@/server/logger'

import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Env from '@/server/env'

import { getOrpcBase } from '@/server/orpc-base'
import * as Discord from '@/systems/discord.server'

import * as E from 'drizzle-orm'
import { unionAll } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

// the role type attributed to permissions granted by the env-level SUPER_USERS/SUPER_ROLES bootstrap
const SUPER_ROLE: RBAC.Role = { type: 'super' }

const envBuilder = Env.getEnvBuilder({ ...Env.groups.rbac, ...Env.groups.discord })
let ENV!: ReturnType<typeof envBuilder>

type RoleConfig = NonNullable<SETTINGS.RbacSettings['roles'][string]>

let userDefinedRoles: RBAC.Role[] = []
let userDefinedPermissionExpressions: Record<string, RBAC.RolePermissionExpression[]> = {}
let roleAssignments: RBAC.RoleAssignment[] = []
// role -> max kick-timeout duration in ms (roles[role].maxTimeout; HumanTime decodes to ms)
let roleMaxTimeouts: Record<string, number> = {}
// restricted settings grants (roles[role].globalSettingsGrants / .serverSettingsGrants)
let roleGlobalSettingsGrants: Record<string, RoleConfig['globalSettingsGrants']> = {}
let roleServerSettingsGrants: Record<string, RoleConfig['serverSettingsGrants']> = {}
let superUserIds = new Set<bigint>()
let superRoleIds = new Set<bigint>()

export function setup() {
	ENV = envBuilder()
	// role config comes from admin-editable global settings and is pushed in via applyRbacSettings() once settings load;
	// start from an empty set (not the schema's preset default) so we never reference an unset binding
	applyRbacSettings(SETTINGS.RbacSettingsSchema.parse({ roles: {} }))
	superUserIds = new Set(ENV.SUPER_USERS)
	superRoleIds = new Set(ENV.SUPER_ROLES)
}

// called by settings.server whenever global settings are (re)loaded so role/permission changes take effect without a restart
export function applyRbacSettings(rbac: SETTINGS.RbacSettings) {
	userDefinedPermissionExpressions = {}
	userDefinedRoles = []
	roleMaxTimeouts = {}
	roleGlobalSettingsGrants = {}
	roleServerSettingsGrants = {}
	roleAssignments = []

	for (const roleType of objKeys(rbac.roles)) {
		const cfg = rbac.roles[roleType]
		userDefinedRoles.push(RBAC.userDefinedRole(roleType))
		userDefinedPermissionExpressions[roleType] = cfg.permissions
		if (cfg.maxTimeout !== undefined) roleMaxTimeouts[roleType] = cfg.maxTimeout
		if (cfg.globalSettingsGrants.length > 0) roleGlobalSettingsGrants[roleType] = cfg.globalSettingsGrants
		if (cfg.serverSettingsGrants.length > 0) roleServerSettingsGrants[roleType] = cfg.serverSettingsGrants

		for (const discordRoleId of cfg.assignments.discordRoleIds) {
			roleAssignments.push({ type: 'discord-role', role: RBAC.userDefinedRole(roleType), discordRoleId: BigInt(discordRoleId) })
		}
		for (const userId of cfg.assignments.discordUserIds) {
			roleAssignments.push({ type: 'discord-user', role: RBAC.userDefinedRole(roleType), discordUserId: BigInt(userId) })
		}
		if (cfg.assignments.everyMember) {
			roleAssignments.push({ type: 'discord-server-member', role: RBAC.userDefinedRole(roleType) })
		}
	}

	// TODO add preflight checks to make sure the remote references in role assignments are valid
}

// superUsers/superRoles from the deploy-time config always receive every permission -- the anti-lockout bootstrap
async function isSuperUser(baseCtx: C.UserId): Promise<boolean> {
	const userId = baseCtx.user.discordId
	if (superUserIds.has(userId)) return true
	if (superRoleIds.size === 0) return false
	const memberRes = await Discord.fetchMember(ENV.DISCORD_HOME_GUILD_ID, userId)
	if (memberRes.code !== 'ok') return false
	for (const roleId of superRoleIds) {
		if (memberRes.member.roles.cache.has(roleId.toString())) return true
	}
	return false
}

// TODO error visibility

const module = initModule('rbac')
const orpcBase = getOrpcBase(module)

export const getRolesForDiscordUser = C.spanOp(
	'getRolesForDiscordUser',
	{ module, levels: { event: 'trace' }, attrs: (ctx: C.UserId) => ({ [ATTRS.User.ID]: String(ctx.user.discordId) }) },
	async (baseCtx: C.UserId) => {
		const userId = baseCtx.user.discordId
		const roles: RBAC.Role[] = []
		const tasks: Promise<void>[] = []
		for (const assignment of roleAssignments) {
			if (assignment.type === 'discord-user' && assignment.discordUserId === userId) {
				roles.push(assignment.role)
			}
			tasks.push(
				(async () => {
					if (assignment.type === 'discord-server-member') {
						const memberRes = await Discord.fetchMember(ENV.DISCORD_HOME_GUILD_ID, userId)
						if (memberRes.code === 'ok') {
							roles.push(assignment.role)
						}
					}
					if (assignment.type === 'discord-role') {
						const memberRes = await Discord.fetchMember(ENV.DISCORD_HOME_GUILD_ID, userId)
						if (memberRes.code === 'ok') {
							const member = memberRes.member
							if (member.roles.cache.has(assignment.discordRoleId.toString())) {
								roles.push(assignment.role)
							}
						}
					}
				})(),
			)
		}
		await Promise.all(tasks)
		return roles
	},
)

// the permissions a set of roles grants purely from their rbac settings config. Negations only apply within the given
// set, which is what lets a single role be evaluated in isolation (see getSimulatableRoles).
function permsFromRoleConfigs(roles: RBAC.Role[]): RBAC.TracedPermission[] {
	const perms: RBAC.TracedPermission[] = []
	const allNegatingPerms: Set<RBAC.RoleGrantablePermissionType> = new Set()

	for (const role of roles) {
		for (const permExpr of userDefinedPermissionExpressions[role.type] ?? []) {
			const perm = RBAC.parseNegatingPermissionType(permExpr)
			if (!perm) continue
			allNegatingPerms.add(perm)
			perms.push(RBAC.tracedPerm(perm, [role], { negated: true, negating: true }, RBAC.unrestrictedRoleGrantArgs(perm)))
		}
	}

	const isNegated = (perm: RBAC.PermissionType) => allNegatingPerms.has(perm as RBAC.RoleGrantablePermissionType)

	for (const role of roles) {
		if ((userDefinedPermissionExpressions[role.type] ?? []).includes('*')) {
			for (const permType of RBAC.ROLE_GRANTABLE_PERMISSION_TYPE.options) {
				perms.push(
					RBAC.tracedPerm(permType, [role], { negated: allNegatingPerms.has(permType) }, RBAC.unrestrictedRoleGrantArgs(permType)),
				)
			}
		}
		for (const permExpr of userDefinedPermissionExpressions[role.type] ?? []) {
			if (!RBAC.isRoleGrantablePermissionType(permExpr)) continue
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm(permExpr, [role], { negated: allNegatingPerms.has(permExpr) }, RBAC.unrestrictedRoleGrantArgs(permExpr)),
			)
		}
		if (roleMaxTimeouts[role.type] !== undefined) {
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('squad-server:timeout-players', [role], {}, { maxDurationMs: roleMaxTimeouts[role.type] }),
			)
		}
		// restricted settings grants; a matching negation in any role's expressions wins over these too
		const globalPaths = roleGlobalSettingsGrants[role.type]
		if (globalPaths && globalPaths.length > 0) {
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('global-settings:write', [role], { negated: isNegated('global-settings:write') }, { paths: [...globalPaths] }),
			)
		}
		for (const grant of roleServerSettingsGrants[role.type] ?? []) {
			const serverIds: (string | null)[] = grant.serverIds.length > 0 ? grant.serverIds : [null]
			for (const serverId of serverIds) {
				if (grant.access === 'read') {
					RBAC.addTracedPerms(
						perms,
						RBAC.tracedPerm('server-settings:read', [role], { negated: isNegated('server-settings:read') }, { serverId }),
					)
				} else if (grant.access === 'write') {
					RBAC.addTracedPerms(
						perms,
						RBAC.tracedPerm('server-settings:write', [role], { negated: isNegated('server-settings:write') }, {
							serverId,
							paths: grant.paths.length > 0 ? [...grant.paths] : null,
						}),
					)
				} else {
					RBAC.addTracedPerms(
						perms,
						RBAC.tracedPerm('server-settings:write-sensitive', [role], { negated: isNegated('server-settings:write-sensitive') }, {
							serverId,
						}),
					)
				}
			}
		}
	}
	return perms
}

export const getUserRbacPerms = C.spanOp(
	'getUserRbacPerms',
	{ module, levels: { event: 'trace' }, attrs: (ctx: C.UserId) => ({ [ATTRS.User.ID]: String(ctx.user.discordId) }) },
	async (baseCtx: C.Db & C.UserId): Promise<RBAC.TracedPermission[]> => {
		const userId = baseCtx.user.discordId
		const rolesPromise = getRolesForDiscordUser(baseCtx)
		const superPromise = isSuperUser(baseCtx)
		const roles = await rolesPromise
		const filterRowsPromise = getFilterPermissionRows()

		const perms: RBAC.TracedPermission[] = []

		// super users/roles are granted every role-grantable permission (unrestricted), overriding any negations.
		// timeout grants are not expression-grantable, so the unlimited grant is added explicitly
		if (await superPromise) {
			for (const permType of RBAC.ROLE_GRANTABLE_PERMISSION_TYPE.options) {
				RBAC.addTracedPerms(perms, RBAC.tracedPerm(permType, [SUPER_ROLE], { negated: false }, RBAC.unrestrictedRoleGrantArgs(permType)))
			}
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('squad-server:timeout-players', [SUPER_ROLE], { negated: false }, { maxDurationMs: null }),
			)
		}

		for (const rolePerm of permsFromRoleConfigs(roles)) {
			RBAC.addTracedPerms(perms, rolePerm)
		}

		const negatedFiltersWrite = perms.some((p) => p.negating && p.type === 'filters:write')
		for (const row of await filterRowsPromise) {
			const source: RBAC.TracedPermission['allowedByRoles'][number] = row.source === 'owner'
				? { type: 'filter-owner', filterId: row.filterId }
				: row.source === 'user-contributor'
				? { type: 'filter-user-contributor', filterId: row.filterId }
				: { type: 'filter-role-contributor', filterId: row.filterId, roleId: row.roleId! }
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('filters:write', [source], { negated: negatedFiltersWrite }, { filterId: row.filterId }),
			)
		}
		return perms

		// owned filters, user contributors and role contributors fetched as one UNION ALL round-trip
		function getFilterPermissionRows() {
			const db = baseCtx.db()
			type Source = 'owner' | 'user-contributor' | 'role-contributor'
			const ownedFilters = db
				.select({
					source: E.sql<Source>`'owner'`.as('source'),
					filterId: Schema.filters.id,
					roleId: E.sql<string | null>`null`.as('roleId'),
				})
				.from(Schema.filters)
				.where(E.eq(Schema.filters.owner, userId))
			const userContributors = db
				.select({
					source: E.sql<Source>`'user-contributor'`.as('source'),
					filterId: Schema.filterUserContributors.filterId,
					roleId: E.sql<string | null>`null`.as('roleId'),
				})
				.from(Schema.filterUserContributors)
				.where(E.eq(Schema.filterUserContributors.userId, userId))
			if (roles.length === 0) return unionAll(ownedFilters, userContributors)
			const roleContributors = db
				.select({
					source: E.sql<Source>`'role-contributor'`.as('source'),
					filterId: Schema.filterRoleContributors.filterId,
					roleId: E.sql<string | null>`${Schema.filterRoleContributors.roleId}`.as('roleId'),
				})
				.from(Schema.filterRoleContributors)
				.where(E.inArray(Schema.filterRoleContributors.roleId, roles.map(r => r.type)))
			return unionAll(ownedFilters, userContributors, roleContributors)
		}
	},
)

// TODO we should implement a version of this which only loads the relevant perms for the user
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	baseCtx: C.Db & C.UserId,
	perm: RBAC.Permission<T>,
): Promise<RBAC.PermissionDeniedResponse<T> | null>
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	baseCtx: C.Db & C.UserId,
	perms: RBAC.Permission<T>[],
): Promise<RBAC.PermissionDeniedResponse<T> | null>
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	baseCtx: C.Db & C.UserId,
	permissionReq: RBAC.PermissionReq<T>,
): Promise<RBAC.PermissionDeniedResponse<T> | null>
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	ctx: C.Db & C.UserId,
	reqOrPerms: RBAC.Permission<T> | RBAC.Permission<T>[] | RBAC.PermissionReq<T>,
) {
	const perms = RBAC.fromTracedPermissions(await getUserRbacPerms(ctx))

	const req: RBAC.PermissionReq<T> = 'check' in reqOrPerms
		? reqOrPerms
		: {
			check: 'all',
			permits: Array.isArray(reqOrPerms) ? reqOrPerms : [reqOrPerms],
		}

	const userId = ctx.user.discordId
	return RBAC.tryDenyPermissionForUser(userId, perms, req)
}

// for the aggregate (non-equality) checks: settings access, timeouts
export async function getUserPermissions(ctx: C.Db & C.UserId): Promise<RBAC.Permission[]> {
	return RBAC.fromTracedPermissions(await getUserRbacPerms(ctx))
}

// viewing global settings is granted by global-settings:read or any global-settings:write grant (incl. restricted ones)
export async function tryDenyGlobalSettingsRead(
	ctx: C.Db & C.UserId,
): Promise<RBAC.PermissionDeniedResponse<'global-settings:read' | 'global-settings:write'> | null> {
	const perms = await getUserPermissions(ctx)
	if (RBAC.canReadGlobalSettings(perms)) return null
	return RBAC.permissionDenied({
		check: 'any',
		permits: [RBAC.perm('global-settings:read'), RBAC.perm('global-settings:write', { paths: null })],
	})
}

// "up to N" timeout checks bypass the equality-matched permission path (see RBAC.maxTimeoutDurationMs)
export async function tryDenyTimeoutForUser(
	ctx: C.Db & C.UserId,
	requestedDurationMs: number,
): Promise<RBAC.PermissionDeniedResponse<'squad-server:timeout-players'> | null> {
	const perms = RBAC.fromTracedPermissions(await getUserRbacPerms(ctx))
	const max = RBAC.maxTimeoutDurationMs(perms)
	if (max === null) return null
	if (max !== undefined && requestedDurationMs <= max) return null
	return RBAC.permissionDenied({
		check: 'all',
		permits: [RBAC.perm('squad-server:timeout-players', { maxDurationMs: requestedDurationMs })],
	})
}

// gate for cancelling timeouts: any timeout grant (of any length) qualifies
export async function tryDenyAnyTimeoutGrant(
	ctx: C.Db & C.UserId,
): Promise<RBAC.PermissionDeniedResponse<'squad-server:timeout-players'> | null> {
	const perms = RBAC.fromTracedPermissions(await getUserRbacPerms(ctx))
	if (RBAC.maxTimeoutDurationMs(perms) !== undefined) return null
	return RBAC.permissionDenied({
		check: 'all',
		permits: [RBAC.perm('squad-server:timeout-players', { maxDurationMs: null })],
	})
}

export const orpcRouter = {
	getUserDefinedRoles: orpcBase.handler(() => {
		return userDefinedRoles
	}),

	// the caller's own roles. Not derivable from their permissions' traces: a role granting nothing appears in no trace,
	// but is still a role they hold
	getMyRoles: orpcBase.handler(async ({ context: _ctx }) => {
		const ctx = DB.addPooledDb(_ctx as any) as C.Db & C.UserId
		const roles = await getRolesForDiscordUser(ctx)
		// matches how the super bootstrap attributes its grants in getUserRbacPerms
		if (await isSuperUser(ctx)) return [SUPER_ROLE, ...roles]
		return roles
	}),

	// roles the caller doesn't hold but whose permissions they already hold anyway, so the permissions dialog can offer
	// them for simulation. Returning the role's traced perms lets the client attribute its own perms to the simulated
	// role without granting anything: a role is only offered when every permission it grants is subsumed by the caller's.
	getSimulatableRoles: orpcBase.handler(async ({ context: _ctx }) => {
		const ctx = DB.addPooledDb(_ctx as any) as C.Db & C.UserId
		const userPerms = RBAC.fromTracedPermissions(await getUserRbacPerms(ctx))
		const heldRoles = new Set((await getRolesForDiscordUser(ctx)).map((r) => r.type))

		const simulatable: { role: RBAC.Role; perms: RBAC.TracedPermission[] }[] = []
		for (const role of userDefinedRoles) {
			if (heldRoles.has(role.type)) continue
			const perms = permsFromRoleConfigs([role])
			// a role granting nothing (or only negations) is vacuously subsumed, and simulating it is still meaningful:
			// its negations take access away
			const granted = RBAC.fromTracedPermissions(perms)
			if (!granted.every((p) => RBAC.permSubsumedBy(p, userPerms))) continue
			simulatable.push({ role, perms })
		}
		return simulatable
	}),

	// the env-configured SUPER_USERS/SUPER_ROLES bootstrap, surfaced read-only in the settings rbac section.
	// ids as strings so the snowflakes survive JSON
	getSuperConfig: orpcBase.handler(async ({ context: _ctx }) => {
		const ctx = DB.addPooledDb(_ctx as any)
		const denyRes = await tryDenyGlobalSettingsRead(ctx)
		if (denyRes) return denyRes
		return {
			code: 'ok' as const,
			superUsers: [...superUserIds].map(String),
			superRoles: [...superRoleIds].map(String),
		}
	}),

	// guild role/member lookups powering the settings role-assignment pickers; gated behind global-settings editing
	// since they surface guild role names and member identities
	listGuildRoles: orpcBase.handler(async ({ context: _ctx }) => {
		const ctx = DB.addPooledDb(_ctx as any)
		const denyRes = await tryDenyGlobalSettingsRead(ctx)
		if (denyRes) return denyRes
		return Discord.listGuildRolesDetailed()
	}),

	searchGuildMembers: orpcBase.input(z.object({ query: z.string() })).handler(async ({ context: _ctx, input }) => {
		const ctx = DB.addPooledDb(_ctx as any)
		const denyRes = await tryDenyGlobalSettingsRead(ctx)
		if (denyRes) return denyRes
		const query = input.query.trim()
		if (query.length === 0) return { code: 'ok' as const, members: [] }
		return Discord.searchGuildMembers(query)
	}),
}
