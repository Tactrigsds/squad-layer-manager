import { CONFIG } from '../config'
import * as C from '@/server/context'
import * as RBAC from '@/rbac.models'
import * as Discord from '@/server/systems/discord'
import * as Schema from '@/server/schema'
import * as E from 'drizzle-orm/expressions'
import { objKeys } from '@/lib/object'
import { procedure, router } from '@/server/trpc.server'
import deepEqual from 'fast-deep-equal'

let roles!: RBAC.Role[]
let globalRolePermissions!: Record<RBAC.Role, RBAC.Permission[]>
let roleAssignments!: RBAC.RoleAssignment[]
export function setup() {
	roles = []
	globalRolePermissions = {}
	for (const role of objKeys(CONFIG.globalRolePermissions)) {
		roles.push(role as RBAC.Role)
		let permTypes: (RBAC.GlobalPermissionType | '*')[] = CONFIG.globalRolePermissions[role]
		if (permTypes.includes('*')) {
			permTypes = Object.values(RBAC.GLOBAL_PERMISSION_TYPE.Values)
		}
		const perms: RBAC.Permission[] = []
		for (const permType of permTypes as RBAC.GlobalPermissionType[]) {
			perms.push(RBAC.perm(permType))
		}

		globalRolePermissions[role] = perms
	}

	roleAssignments = []
	for (const assignment of CONFIG.roleAssignments?.['discord-role'] ?? []) {
		for (const role of assignment.roles) {
			roleAssignments.push({
				type: 'discord-role',
				role,
				discordRoleId: assignment.discordRoleId,
			})
		}
	}
	for (const assignment of CONFIG.roleAssignments?.['discord-user'] ?? []) {
		for (const role of assignment.roles) {
			roleAssignments.push({
				type: 'discord-user',
				role,
				discordUserId: assignment.userId,
			})
		}
	}
	for (const assignment of CONFIG.roleAssignments?.['discord-server-member'] ?? []) {
		for (const role of assignment.roles) {
			roleAssignments.push({
				type: 'discord-server-member',
				role,
			})
		}
	}

	// TODO add preflight checks to make sure the remote references in role assignments are valid
}

// TODO error visibility
export async function getRolesForDiscordUser(baseCtx: C.Log, userId: bigint) {
	await using ctx = C.pushOperation(baseCtx, 'rbac:get-roles-for-discord-user')
	const roles: RBAC.Role[] = []
	for (const assignment of roleAssignments) {
		if (assignment.type === 'discord-user' && assignment.discordUserId === userId) {
			roles.push(assignment.role)
		}
		ctx.tasks.push(
			(async () => {
				if (assignment.type === 'discord-server-member') {
					const memberRes = await Discord.fetchMember(ctx, CONFIG.homeDiscordGuildId, userId)
					if (memberRes.code === 'ok') {
						roles.push(assignment.role)
					}
				}
				if (assignment.type === 'discord-role') {
					const memberRes = await Discord.fetchMember(ctx, CONFIG.homeDiscordGuildId, userId)
					if (memberRes.code === 'ok') {
						const member = memberRes.member
						if (member.roles.cache.has(assignment.discordRoleId.toString())) {
							roles.push(assignment.role)
						}
					}
				}
			})()
		)
	}
	await Promise.all(ctx.tasks)
	return roles
}

export async function getUserRbac(baseCtx: C.Log & C.Db, userId: bigint) {
	await using ctx = C.pushOperation(baseCtx, 'rbac:get-permissions-for-discord-user')
	const ownedFiltersPromise = getOwnedFilters()
	const roles = await getRolesForDiscordUser(ctx, userId)
	const userFilterContributorsPromise = getUserContributorFilters()
	const roleFilterContributorsPromise = getRoleContributorFilters()
	const perms: RBAC.Permission[] = []
	for (const role of roles) {
		perms.push(...globalRolePermissions[role])
	}
	if (perms.find((p) => p.type === 'filters:write-all')) {
		const allFilters = await ctx.db().select({ id: Schema.filters.id }).from(Schema.filters)
		perms.push(...allFilters.map((f) => RBAC.perm('filters:write', { filterId: f.id })))
	}
	if (perms.find((p) => p.type === 'queue:force-write')) {
		perms.push(RBAC.perm('queue:write'))
	}

	perms.push(...(await ownedFiltersPromise).flatMap((f) => [RBAC.perm('filters:write', { filterId: f.id })]))

	perms.push(...(await userFilterContributorsPromise).map((filterId) => RBAC.perm('filters:write', { filterId: filterId })))
	perms.push(...(await roleFilterContributorsPromise).map((filterId) => RBAC.perm('filters:write', { filterId: filterId })))

	return { perms: dedupePerms(perms), roles }

	async function getOwnedFilters() {
		return await ctx.db().select({ id: Schema.filters.id }).from(Schema.filters).where(E.eq(Schema.filters.owner, userId))
	}
	async function getRoleContributorFilters() {
		const rows = await ctx
			.db()
			.select({ filterId: Schema.filterRoleContributors.filterId })
			.from(Schema.filterRoleContributors)
			.where(E.inArray(Schema.filterRoleContributors.roleId, roles))
		return rows.map((r) => r.filterId)
	}
	async function getUserContributorFilters() {
		const rows = await ctx
			.db()
			.select({ filterId: Schema.filterUserContributors.filterId })
			.from(Schema.filterUserContributors)
			.where(E.eq(Schema.filterUserContributors.userId, userId))
		return rows.map((r) => r.filterId)
	}
}

function dedupePerms(perms: RBAC.Permission[]) {
	const types = new Map(perms.map((p) => [p.type, []] as const)) as Map<RBAC.PermissionType, RBAC.Permission[]>
	for (const perm of perms) {
		if (!types.has(perm.type)) {
			types.set(perm.type, [])
		}
		let foundDuplicate = false
		for (const toMatch of types.get(perm.type)!) {
			if (deepEqual(perm, toMatch)) {
				foundDuplicate = true
				break
			}
		}

		if (!foundDuplicate) {
			types.get(perm.type)!.push(perm)
		}
	}
	return [...types.values()].flat()
}

export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	baseCtx: C.Log & C.Db,
	userId: bigint,
	perm: RBAC.Permission<T>
): Promise<RBAC.PermissionDeniedResponse<T> | null>
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	baseCtx: C.Log & C.Db,
	userId: bigint,
	perms: RBAC.Permission<T>[]
): Promise<RBAC.PermissionDeniedResponse<T> | null>
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	baseCtx: C.Log & C.Db,
	userId: bigint,
	permissionReq: RBAC.PermissionReq<T>
): Promise<RBAC.PermissionDeniedResponse<T> | null>
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	baseCtx: C.Log & C.Db,
	userId: bigint,
	reqOrPerms: RBAC.Permission<T> | RBAC.Permission<T>[] | RBAC.PermissionReq<T>
) {
	await using ctx = C.pushOperation(baseCtx, 'rbac:check-permissions')
	const userRbac = await getUserRbac(ctx, userId)

	const req: RBAC.PermissionReq<T> =
		'check' in reqOrPerms
			? reqOrPerms
			: {
					check: 'all',
					permits: Array.isArray(reqOrPerms) ? reqOrPerms : [reqOrPerms],
				}

	return RBAC.tryDenyPermissionForUser(userId, userRbac.perms, req)
}

export const rbacRouter = router({
	getRoles: procedure.query(() => {
		return roles
	}),
})
