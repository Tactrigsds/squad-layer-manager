import * as Schema from '$root/drizzle/schema.ts'
import { objKeys } from '@/lib/object'
import { initModule } from '@/server/logger'

import * as RBAC from '@/rbac.models'
import { CONFIG } from '@/server/config'
import * as C from '@/server/context'

import { getOrpcBase } from '@/server/orpc-base'
import * as Discord from '@/systems/discord.server'

import * as E from 'drizzle-orm'
import { unionAll } from 'drizzle-orm/sqlite-core'

let userDefinedRoles!: RBAC.Role[]
let userDefinedPermissionExpressions!: Record<string, RBAC.GlobalPermissionTypeExpression[]>
let roleAssignments!: RBAC.RoleAssignment[]
export function setup() {
	userDefinedPermissionExpressions = {}
	userDefinedRoles = []

	for (const roleType of objKeys(CONFIG.globalRolePermissions)) {
		userDefinedRoles.push(RBAC.userDefinedRole(roleType))
		userDefinedPermissionExpressions[roleType] = CONFIG.globalRolePermissions[roleType]
	}

	roleAssignments = []

	for (const assignment of CONFIG.roleAssignments?.['discord-role'] ?? []) {
		for (const roleType of assignment.roles) {
			roleAssignments.push({
				type: 'discord-role',
				role: RBAC.userDefinedRole(roleType),
				discordRoleId: assignment.discordRoleId,
			})
		}
	}
	for (const assignment of CONFIG.roleAssignments?.['discord-user'] ?? []) {
		for (const roleType of assignment.roles) {
			roleAssignments.push({
				type: 'discord-user',
				role: RBAC.userDefinedRole(roleType),
				discordUserId: assignment.userId,
			})
		}
	}
	for (const assignment of CONFIG.roleAssignments?.['discord-server-member'] ?? []) {
		for (const roleType of assignment.roles) {
			roleAssignments.push({
				type: 'discord-server-member',
				role: RBAC.userDefinedRole(roleType),
			})
		}
	}

	// TODO add preflight checks to make sure the remote references in role assignments are valid
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
						const memberRes = await Discord.fetchMember(CONFIG.homeDiscordGuildId, userId)
						if (memberRes.code === 'ok') {
							roles.push(assignment.role)
						}
					}
					if (assignment.type === 'discord-role') {
						const memberRes = await Discord.fetchMember(CONFIG.homeDiscordGuildId, userId)
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
		const roles = await getRolesForDiscordUser(baseCtx)
		const filterRowsPromise = getFilterPermissionRows()

		const perms: RBAC.TracedPermission[] = []
		const allNegatingPerms: Set<RBAC.GlobalPermissionType> = new Set()
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

export const orpcRouter = {
	getUserDefinedRoles: orpcBase.handler(() => {
		return userDefinedRoles
	}),
}
