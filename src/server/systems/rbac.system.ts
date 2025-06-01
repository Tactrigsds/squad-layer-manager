import * as Schema from '$root/drizzle/schema.ts'
import { objKeys } from '@/lib/object'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import * as Discord from '@/server/systems/discord'
import { procedure, router } from '@/server/trpc.server'
import * as Otel from '@opentelemetry/api'
import * as E from 'drizzle-orm/expressions'
import { CONFIG } from '../config'

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

const tracer = Otel.trace.getTracer('rbac')

export const getRolesForDiscordUser = C.spanOp('rbac:get-roles-for-discord-user', { tracer }, async (baseCtx: C.Log, userId: bigint) => {
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
	async (baseCtx: C.Log & C.Db, userId: bigint): Promise<RBAC.TracedPermission[]> => {
		C.setSpanOpAttrs({ userId })
		const ownedFiltersPromise = getOwnedFilters()
		const roles = await getRolesForDiscordUser(baseCtx, userId)
		const userFilterContributorsPromise = getUserContributorFilters()
		const roleFilterContributorsPromise = getRoleContributorFilters()
		const perms: RBAC.TracedPermission[] = []
		for (const role of roles) {
			for (const perm of globalRolePermissions[role]) {
				RBAC.addTracedPerms(perms, { ...perm, allowedByRoles: [role] })
			}
		}

		for (const filter of (await ownedFiltersPromise)) {
			RBAC.addTracedPerms(perms, RBAC.tracedPerm('filters:write', ['filter-owner'], { filterId: filter.id }))
		}
		for (const filterId of (await userFilterContributorsPromise)) {
			RBAC.addTracedPerms(perms, RBAC.tracedPerm('filters:write', [`filter-user-contributor`], { filterId: filterId }))
		}

		for (const { filterId, roleId } of (await roleFilterContributorsPromise)) {
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('filters:write', [{ type: 'filter-role-contributor', roleId }], { filterId: filterId }),
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
	baseCtx: C.Log & C.Db,
	userId: bigint,
	perm: RBAC.Permission<T>,
): Promise<RBAC.PermissionDeniedResponse<T> | null>
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	baseCtx: C.Log & C.Db,
	userId: bigint,
	perms: RBAC.Permission<T>[],
): Promise<RBAC.PermissionDeniedResponse<T> | null>
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	baseCtx: C.Log & C.Db,
	userId: bigint,
	permissionReq: RBAC.PermissionReq<T>,
): Promise<RBAC.PermissionDeniedResponse<T> | null>
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	ctx: C.Log & C.Db,
	userId: bigint,
	reqOrPerms: RBAC.Permission<T> | RBAC.Permission<T>[] | RBAC.PermissionReq<T>,
) {
	const perms = await getUserRbacPerms(ctx, userId)

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
