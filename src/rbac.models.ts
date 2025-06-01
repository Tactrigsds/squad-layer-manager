import * as Arr from '@/lib/array'
import * as M from '@/models'
import deepEqual from 'fast-deep-equal'
import { z } from 'zod'

// roles which are inferred by other state, for example the owner of a filter will get the filter-owner role. when an inferred role is present, it's expected to also have access to a particular permission to know what entity the inferred role is associated with.
export const InferredRoleSchema = z.union([
	z.literal('filter-owner'),
	z.literal('filter-user-contributor'),
	z.object({ type: z.literal('filter-role-contributor'), roleId: z.string() }),
])
export type InferredRole = z.infer<typeof InferredRoleSchema>

export const RoleSchema = z
	.string()
	.regex(/^[a-z0-9-]+$/)
	.min(3)
	.max(32)
	.refine((role) => !InferredRoleSchema.safeParse(role).success, {
		message: `Role cannot be the same as one of the inferred roles: ${InferredRoleSchema.options.join(', ')}`,
	})

export type Role = z.infer<typeof RoleSchema>
export type CompositeRole = Role | InferredRole

export const RoleAssignmentSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('discord-role'), discordRoleId: M.UserIdSchema, role: RoleSchema }),
	z.object({ type: z.literal('discord-user'), discordUserId: M.UserIdSchema, role: RoleSchema }),
	z.object({ type: z.literal('discord-server-member'), role: RoleSchema }),
])
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>

export const PERM_SCOPE_ARGS = {
	global: z.undefined(),
	filter: z.object({ filterId: M.FilterEntityIdSchema }),
}

type PermScope = keyof typeof PERM_SCOPE_ARGS

export type UserWithRbac = M.User & { perms: TracedPermission[] }

function definePermission<T extends string, S extends PermScope>(type: T, args: { description: string; scope: S }) {
	return { [type]: { type, description: args.description, scope: args.scope, scopeArgs: PERM_SCOPE_ARGS[args.scope] } } as const
}

export const PERMISSION_DEFINITION = {
	...definePermission('site:authorized', { description: 'Access the site', scope: 'global' }),

	...definePermission('queue:write', { description: 'Add, remove, edit or reorder layers in the queue', scope: 'global' }),
	// TODO implement
	...definePermission('queue:force-write', {
		description: "Add, remove, edit or reorder layers in the queue, even if the layer isn't in the pool",
		scope: 'global',
	}),
	...definePermission('settings:write', { description: 'Change settings like the configured layer pool filter', scope: 'global' }),
	...definePermission('vote:manage', { description: 'Start and abort votes', scope: 'global' }),

	...definePermission('filters:write-all', { description: 'Delete or modify any filter', scope: 'global' }),
	...definePermission('filters:write', { description: 'Modify a filter', scope: 'filter' }),

	...definePermission('squad-server:end-match', { description: 'End the current match on the server', scope: 'global' }),
	...definePermission('squad-server:disable-slm-updates', { description: 'Disable updates from slm to the game-server', scope: 'global' }),
	...definePermission('squad-server:turn-fog-off', { description: 'Disable fog-of-war for the current match', scope: 'global' }),
}
export type PermissionType = (typeof PERMISSION_DEFINITION)[number]['type']
export const PERMISSION_TYPE = z.enum(Object.keys(PERMISSION_DEFINITION) as [PermissionType, ...PermissionType[]])
export const GLOBAL_PERMISSION_TYPE = PERMISSION_TYPE.extract([
	'site:authorized',
	'queue:write',
	'queue:force-write',
	'settings:write',
	'vote:manage',
	'filters:write-all',
	'squad-server:end-match',
	'squad-server:disable-slm-updates',
	'squad-server:turn-fog-off',
])

export type PermArgs<T extends PermissionType> = z.infer<(typeof PERMISSION_DEFINITION)[T]['scopeArgs']>
export type GlobalPermissionType = z.infer<typeof GLOBAL_PERMISSION_TYPE>

export function perm<T extends PermissionType>(type: T, scopeOpts?: z.infer<(typeof PERMISSION_DEFINITION)[T]['scopeArgs']>) {
	return {
		type,
		scope: PERMISSION_DEFINITION[type].scope,
		args: scopeOpts ?? (undefined as PermArgs<T>),
	}
}
export function tracedPerm<T extends PermissionType>(
	type: T,
	roles: CompositeRole[],
	scopeOpts?: z.infer<(typeof PERMISSION_DEFINITION)[T]['scopeArgs']>,
) {
	return {
		...perm(type, scopeOpts),
		allowedByRoles: roles,
	}
}

export type Permission<T extends PermissionType = PermissionType> = ReturnType<typeof perm<T>>
export type PermissionTrace = { allowedByRoles: CompositeRole[] }
export type TracedPermission<T extends PermissionType = PermissionType> = Permission<T> & PermissionTrace
export function addTracedPerms(perms: TracedPermission[], ...permsToAdd: TracedPermission[]) {
	for (const permToAdd of permsToAdd) {
		for (const permToCompare of perms) {
			if (arePermsEqual(permToAdd, permToCompare)) {
				permToCompare.allowedByRoles = Arr.union(permToCompare.allowedByRoles, permToAdd.allowedByRoles)
				return
			}
		}
		perms.push(permToAdd)
	}
}

export function permissionDenied<T extends PermissionType>(req: PermissionReq<T>) {
	return {
		code: 'err:permission-denied' as const,
		...req,
	}
}

export type PermissionDeniedResponse<T extends PermissionType = PermissionType> = ReturnType<typeof permissionDenied<T>>
export type PermissionReq<T extends PermissionType = PermissionType> = { check: 'all' | 'any'; permits: Permission<T>[] }

export function rbacUserHasPerms<T extends PermissionType>(user: UserWithRbac, perms: Permission<T>): boolean
export function rbacUserHasPerms<T extends PermissionType>(user: UserWithRbac, perms: Permission<T>[]): boolean
export function rbacUserHasPerms<T extends PermissionType>(user: UserWithRbac, req: PermissionReq<T>): boolean
export function rbacUserHasPerms<T extends PermissionType>(
	user: UserWithRbac,
	reqOrPerms: Permission<T> | Permission<T>[] | PermissionReq<T>,
): boolean {
	if ('check' in reqOrPerms) {
		return userHasPerms(user.discordId, user.perms, reqOrPerms)
	}
	const req: PermissionReq<T> = {
		check: 'all',
		permits: Array.isArray(reqOrPerms) ? reqOrPerms : [reqOrPerms],
	}
	return userHasPerms(user.discordId, user.perms, req)
}

// TODO technically incorrect when it comes to filters:write-all
export function userHasPerms<T extends PermissionType>(userId: bigint, userPerms: Permission[], perm: Permission<T>): boolean
export function userHasPerms<T extends PermissionType>(userId: bigint, userPerms: Permission[], perms: Permission<T>[]): boolean
export function userHasPerms<T extends PermissionType>(userId: bigint, userPerms: Permission[], req: PermissionReq<T>): boolean
export function userHasPerms<T extends PermissionType>(
	userId: bigint,
	userPerms: Permission[],
	reqOrPerms: Permission<T> | Permission<T>[] | PermissionReq<T>,
): boolean {
	const req: PermissionReq<T> = 'check' in reqOrPerms
		? reqOrPerms
		: {
			check: 'all',
			permits: Array.isArray(reqOrPerms) ? reqOrPerms : [reqOrPerms],
		}

	for (const reqPerm of req.permits) {
		const hasPerm = userPerms.find((userPerm) => arePermsEqual(userPerm, reqPerm))
		if (req.check === 'all' && !hasPerm) return false
		if (req.check === 'any' && hasPerm) return true
	}
	return req.check === 'all'
}

export function tryDenyPermissionsForRbacUser<T extends PermissionType>(user: UserWithRbac, req: PermissionReq<T>) {
	if (!rbacUserHasPerms(user, req)) {
		return permissionDenied(req)
	}
	return null
}
export function tryDenyPermissionForUser<T extends PermissionType>(userId: bigint, perms: Permission[], req: PermissionReq<T>) {
	if (!userHasPerms(userId, perms, req)) {
		return permissionDenied(req)
	}
	return null
}

export function arePermsEqual(perm1: Permission & Partial<PermissionTrace>, perm2: Permission & Partial<PermissionTrace>) {
	perm1 = { ...perm1 }
	delete perm1.allowedByRoles
	perm2 = { ...perm2 }
	delete perm2.allowedByRoles
	return deepEqual(perm1, perm2)
}

export function getWritePermReqForFilterEntity(id: M.FilterEntityId): PermissionReq {
	return {
		check: 'any',
		permits: [perm('filters:write', { filterId: id }), perm('filters:write-all')],
	}
}

export function getPermissionsByRole(permissions: TracedPermission[]): [CompositeRole, TracedPermission[]][] {
	const rolePermissionsMap = new Map<string, TracedPermission[]>()

	for (const permission of permissions) {
		for (const role of permission.allowedByRoles) {
			const roleKey = JSON.stringify(role)
			if (!rolePermissionsMap.has(roleKey)) {
				rolePermissionsMap.set(roleKey, [])
			}
			rolePermissionsMap.get(roleKey)!.push(permission)
		}
	}

	return Array.from(rolePermissionsMap.entries()).map(([roleKey, perms]) => [JSON.parse(roleKey) as CompositeRole, perms])
}
