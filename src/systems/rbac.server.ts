import * as Schema from '$root/drizzle/schema.ts'
import { objKeys } from '@/lib/object'
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

let userDefinedRoles: RBAC.Role[] = []
let userDefinedPermissionExpressions: Record<string, RBAC.GlobalPermissionTypeExpression[]> = {}
let roleAssignments: RBAC.RoleAssignment[] = []
// role -> max kick-timeout duration in ms (rbac.maxTimeouts; HumanTime decodes to ms)
let roleMaxTimeouts: Record<string, number> = {}
let superUserIds = new Set<bigint>()
let superRoleIds = new Set<bigint>()

export function setup() {
	ENV = envBuilder()
	// role config comes from admin-editable global settings and is pushed in via applyRbacSettings() once settings load;
	// start from empty defaults so we never reference an unset binding
	applyRbacSettings(SETTINGS.RbacSettingsSchema.parse({}))
	superUserIds = new Set(ENV.SUPER_USERS)
	superRoleIds = new Set(ENV.SUPER_ROLES)
}

// called by settings.server whenever global settings are (re)loaded so role/permission changes take effect without a restart
export function applyRbacSettings(rbac: SETTINGS.RbacSettings) {
	userDefinedPermissionExpressions = {}
	userDefinedRoles = []

	for (const roleType of objKeys(rbac.roles)) {
		userDefinedRoles.push(RBAC.userDefinedRole(roleType))
		userDefinedPermissionExpressions[roleType] = rbac.roles[roleType]
	}

	roleMaxTimeouts = { ...rbac.maxTimeouts }

	roleAssignments = []

	for (const assignment of rbac.roleAssignments['discord-role']) {
		for (const roleType of assignment.roles) {
			roleAssignments.push({
				type: 'discord-role',
				role: RBAC.userDefinedRole(roleType),
				discordRoleId: BigInt(assignment.discordRoleId),
			})
		}
	}
	for (const assignment of rbac.roleAssignments['discord-user']) {
		for (const roleType of assignment.roles) {
			roleAssignments.push({
				type: 'discord-user',
				role: RBAC.userDefinedRole(roleType),
				discordUserId: BigInt(assignment.userId),
			})
		}
	}
	for (const roleType of rbac.roleAssignments['discord-server-member']) {
		roleAssignments.push({
			type: 'discord-server-member',
			role: RBAC.userDefinedRole(roleType),
		})
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
	{ module, levels: { event: 'trace' }, attrs: (_, userId) => ({ userId }) },
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

export const getUserRbacPerms = C.spanOp(
	'getUserRbacPerms',
	{ module, levels: { event: 'trace' }, attrs: (_, userId) => ({ userId }) },
	async (baseCtx: C.Db & C.UserId): Promise<RBAC.TracedPermission[]> => {
		const userId = baseCtx.user.discordId
		const rolesPromise = getRolesForDiscordUser(baseCtx)
		const superPromise = isSuperUser(baseCtx)
		const roles = await rolesPromise
		const filterRowsPromise = getFilterPermissionRows()

		const perms: RBAC.TracedPermission[] = []
		const allNegatingPerms: Set<RBAC.GlobalPermissionType> = new Set()

		// super users/roles are granted every global permission, overriding any negations. timeout grants are
		// not global-scoped, so the unlimited grant is added explicitly
		if (await superPromise) {
			for (const permType of RBAC.GLOBAL_PERMISSION_TYPE.options) {
				RBAC.addTracedPerms(perms, RBAC.tracedPerm(permType, [SUPER_ROLE], { negated: false }))
			}
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('squad-server:timeout-players', [SUPER_ROLE], { negated: false }, { maxDurationMs: null }),
			)
		}
		for (const role of roles) {
			for (const permExpr of userDefinedPermissionExpressions[role.type]) {
				const perm = RBAC.parseNegatingPermissionType(permExpr)
				if (!perm) continue
				allNegatingPerms.add(perm)
				perms.push(RBAC.tracedPerm(perm, [role], { negated: true, negating: true }))
			}
		}

		const isNegated = (perm: RBAC.PermissionType) => allNegatingPerms.has(perm as RBAC.GlobalPermissionType)

		for (const role of roles) {
			if (userDefinedPermissionExpressions[role.type].includes('*')) {
				for (const permType of RBAC.GLOBAL_PERMISSION_TYPE.options) {
					perms.push(RBAC.tracedPerm(permType, [role], { negated: allNegatingPerms.has(permType) }))
				}
			}
			for (const permExpr of userDefinedPermissionExpressions[role.type]) {
				if (!RBAC.isGlobalPermissionType(permExpr)) continue
				RBAC.addTracedPerms(perms, RBAC.tracedPerm(permExpr, [role], { negated: allNegatingPerms.has(permExpr) }))
			}
			if (roleMaxTimeouts[role.type] !== undefined) {
				RBAC.addTracedPerms(
					perms,
					RBAC.tracedPerm('squad-server:timeout-players', [role], {}, { maxDurationMs: roleMaxTimeouts[role.type] }),
				)
			}
		}

		const negatedFiltersWrite = isNegated('filters:write')
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

	// guild role/member lookups powering the settings role-assignment pickers; gated behind global-settings editing
	// since they surface guild role names and member identities
	listGuildRoles: orpcBase.handler(async ({ context: _ctx }) => {
		const ctx = DB.addPooledDb(_ctx as any)
		const denyRes = await tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-global-settings'))
		if (denyRes) return denyRes
		return Discord.listGuildRolesDetailed()
	}),

	searchGuildMembers: orpcBase.input(z.object({ query: z.string() })).handler(async ({ context: _ctx, input }) => {
		const ctx = DB.addPooledDb(_ctx as any)
		const denyRes = await tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-global-settings'))
		if (denyRes) return denyRes
		const query = input.query.trim()
		if (query.length === 0) return { code: 'ok' as const, members: [] }
		return Discord.searchGuildMembers(query)
	}),
}
