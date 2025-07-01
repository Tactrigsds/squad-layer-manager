import * as Schema from '$root/drizzle/schema.ts'
import { objKeys } from '@/lib/object'
import * as CS from '@/models/context-shared'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import * as Discord from '@/server/systems/discord'
import { procedure, router } from '@/server/trpc.server'
import * as Otel from '@opentelemetry/api'
import * as E from 'drizzle-orm/expressions'
import { CONFIG } from '../config'

let roles!: RBAC.Role[]
let globalRolePermissionExpressions!: Record<RBAC.Role, RBAC.GlobalPermissionTypeExpression[]>
let roleAssignments!: RBAC.RoleAssignment[]
export function setup() {
	globalRolePermissionExpressions = {}
	roles = []

	for (const role of objKeys(CONFIG.globalRolePermissions)) {
		roles.push(role as RBAC.Role)
		globalRolePermissionExpressions[role] = CONFIG.globalRolePermissions[role]
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

const tracer = Otel.trace.getTracer('rbac')

export const getRolesForDiscordUser = C.spanOp('rbac:get-roles-for-discord-user', { tracer }, async (baseCtx: CS.Log, userId: bigint) => {
	C.setSpanOpAttrs({ userId })
	const roles: RBAC.Role[] = []
	const tasks: Promise<void>[] = []
	for (const assignment of roleAssignments) {
		if (assignment.type === 'discord-user' && assignment.discordUserId === userId) {
			roles.push(assignment.role)
		}
		tasks.push(
			(async () => {
				if (assignment.type === 'discord-server-member') {
					const memberRes = await Discord.fetchMember(baseCtx, CONFIG.homeDiscordGuildId, userId)
					if (memberRes.code === 'ok') {
						roles.push(assignment.role)
					}
				}
				if (assignment.type === 'discord-role') {
					const memberRes = await Discord.fetchMember(baseCtx, CONFIG.homeDiscordGuildId, userId)
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
})

export const getUserRbacPerms = C.spanOp(
	'rbac:get-permissions-for-discord-user',
	{ tracer },
	async (baseCtx: CS.Log & C.Db, userId: bigint): Promise<RBAC.TracedPermission[]> => {
		C.setSpanOpAttrs({ userId })
		const ownedFiltersPromise = getOwnedFilters()
		const roles = await getRolesForDiscordUser(baseCtx, userId)
		const userFilterContributorsPromise = getUserContributorFilters()
		const roleFilterContributorsPromise = getRoleContributorFilters()

		const perms: RBAC.TracedPermission[] = []
		const allNegatedPerms: Set<RBAC.GlobalPermissionType> = new Set()
		for (const role of roles) {
			for (const permExpr of globalRolePermissionExpressions[role]) {
				const perm = RBAC.parseNegatingPermissionType(permExpr)
				if (!perm) continue
				allNegatedPerms.add(perm)
				perms.push(RBAC.tracedPerm(perm, [role], { negating: true }))
			}
		}

		const isNegated = (perm: RBAC.PermissionType) => allNegatedPerms.has(perm as RBAC.GlobalPermissionType)

		for (const role of roles) {
			if (globalRolePermissionExpressions[role].includes('*')) {
				for (const permType of RBAC.GLOBAL_PERMISSION_TYPE.options) {
					perms.push(RBAC.tracedPerm(permType, [role], { negated: allNegatedPerms.has(permType) }))
				}
			}
			for (const permExpr of globalRolePermissionExpressions[role]) {
				if (!RBAC.isGlobalPermissionType(permExpr)) continue
				RBAC.addTracedPerms(perms, RBAC.tracedPerm(permExpr, [role], { negated: allNegatedPerms.has(permExpr) }))
			}
		}

		for (const filter of (await ownedFiltersPromise)) {
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('filters:write', ['filter-owner'], { negated: isNegated('filters:write') }, { filterId: filter.id }),
			)
		}
		for (const filterId of (await userFilterContributorsPromise)) {
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('filters:write', [`filter-user-contributor`], { negated: isNegated('filters:write') }, { filterId: filterId }),
			)
		}

		for (const { filterId, roleId } of (await roleFilterContributorsPromise)) {
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('filters:write', [{ type: 'filter-role-contributor', roleId }], { negated: isNegated('filters:write') }, {
					filterId: filterId,
				}),
			)
		}
		return perms

		async function getOwnedFilters() {
			return await baseCtx.db().select({ id: Schema.filters.id }).from(Schema.filters).where(E.eq(Schema.filters.owner, userId))
		}
		async function getRoleContributorFilters() {
			const rows = await baseCtx
				.db()
				.select({ filterId: Schema.filterRoleContributors.filterId, roleId: Schema.filterRoleContributors.roleId })
				.from(Schema.filterRoleContributors)
				.where(E.inArray(Schema.filterRoleContributors.roleId, roles))
			return rows
		}
		async function getUserContributorFilters() {
			const rows = await baseCtx
				.db()
				.select({ filterId: Schema.filterUserContributors.filterId })
				.from(Schema.filterUserContributors)
				.where(E.eq(Schema.filterUserContributors.userId, userId))
			return rows.map((r) => r.filterId)
		}
	},
)

export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	baseCtx: CS.Log & C.Db,
	userId: bigint,
	perm: RBAC.Permission<T>,
): Promise<RBAC.PermissionDeniedResponse<T> | null>
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	baseCtx: CS.Log & C.Db,
	userId: bigint,
	perms: RBAC.Permission<T>[],
): Promise<RBAC.PermissionDeniedResponse<T> | null>
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	baseCtx: CS.Log & C.Db,
	userId: bigint,
	permissionReq: RBAC.PermissionReq<T>,
): Promise<RBAC.PermissionDeniedResponse<T> | null>
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	ctx: CS.Log & C.Db,
	userId: bigint,
	reqOrPerms: RBAC.Permission<T> | RBAC.Permission<T>[] | RBAC.PermissionReq<T>,
) {
	const perms = RBAC.fromTracedPermissions(await getUserRbacPerms(ctx, userId))

	const req: RBAC.PermissionReq<T> = 'check' in reqOrPerms
		? reqOrPerms
		: {
			check: 'all',
			permits: Array.isArray(reqOrPerms) ? reqOrPerms : [reqOrPerms],
		}

	return RBAC.tryDenyPermissionForUser(userId, perms, req)
}

export const rbacRouter = router({
	getRoles: procedure.query(() => {
		return roles
	}),
})
