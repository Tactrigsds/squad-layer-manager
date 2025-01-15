import { CONFIG } from '../config'
import * as M from '@/models'
import * as C from '@/server/context'
import * as RBAC from '@/server/rbac.models'
import * as Discord from '@/server/systems/discord'
import { objKeys } from '@/lib/object'
import deepEqual from 'fast-deep-equal'

let roles!: RBAC.Role[]
let globalRolePermissions!: Record<RBAC.Role, RBAC.Permission[]>
let roleAssignments!: RBAC.RoleAssignment[]
export function setup() {
	roles = []
	globalRolePermissions = {}
	for (const role of objKeys(CONFIG.globalRolePermissions)) {
		roles.push(role as RBAC.Role)
		let permTypes = CONFIG.globalRolePermissions[role]
		if (permTypes.includes('*')) {
			permTypes = RBAC.SCOPE_TO_PERMISSION_TYPES.global.options
		}
		const perms: RBAC.Permission[] = []

		for (const perm of permTypes as RBAC.PermissionType[]) {
			if (RBAC.PERMISSION_TYPE_TO_SCOPE[perm] === 'global') {
				perms.push({ type: perm, scope: { type: 'global' } })
			} else {
				throw new Error(`unexpected scope for configured permission ${perm}`)
			}
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
		if (assignment.type !== 'discord-user' || assignment.discordUserId !== userId) continue
		roles.push(assignment.role)
	}
	for (const assignment of roleAssignments) {
		const memberRes = await Discord.fetchMember(ctx, CONFIG.homeDiscordGuildId, userId)
		if (assignment.type !== 'discord-server-member') continue
		if (memberRes.code !== 'ok') continue
		roles.push(assignment.role)
	}
	for (const assignment of roleAssignments) {
		if (assignment.type !== 'discord-role') continue
		const memberRes = await Discord.fetchMember(ctx, CONFIG.homeDiscordGuildId, userId)
		if (memberRes.code !== 'ok') continue
		const member = memberRes.member
		if (member.roles.cache.has(assignment.discordRoleId.toString())) {
			roles.push(assignment.role)
		}
	}
	return roles
}

export async function getAllPermissionsForDiscordUser(baseCtx: C.Log, userId: bigint) {
	await using ctx = C.pushOperation(baseCtx, 'rbac:get-permissions-for-discord-user')
	const roles = await getRolesForDiscordUser(ctx, userId)
	const perms: RBAC.Permission[] = []
	for (const role of roles) {
		perms.push(...globalRolePermissions[role])
	}
	return dedupePerms(perms)
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

type PermissionReq<T extends RBAC.PermissionType = RBAC.PermissionType> =
	| { check: 'all'; permits: RBAC.Permission<T>[] }
	| { check: 'any'; permits: RBAC.Permission<T>[] }

export async function checkPermissions<T extends RBAC.PermissionType>(
	baseCtx: C.Log,
	userId: bigint,
	req: PermissionReq<T>
): Promise<boolean> {
	await using ctx = C.pushOperation(baseCtx, 'rbac:check-permissions')
	const userPermits = await getAllPermissionsForDiscordUser(ctx, userId)

	if (req.check === 'any') {
		for (const reqPermit of req.permits) {
			for (const userPermit of userPermits) {
				if (deepEqual(reqPermit, userPermit)) return true
			}
		}
		return false
	}

	for (const reqPermit of req.permits) {
		let hasRequired = false
		for (const userPermit of userPermits) {
			if (deepEqual(reqPermit, userPermit)) {
				hasRequired = true
				break
			}
		}
		if (!hasRequired) return false
	}
	return true
}
