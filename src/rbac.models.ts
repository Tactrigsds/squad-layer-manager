import { z } from 'zod'
import * as M from '@/models'
import deepEqual from 'fast-deep-equal'

export const RoleSchema = z
	.string()
	.regex(/^[a-z0-9-]+$/)
	.min(3)
	.max(32)
export type Role = z.infer<typeof RoleSchema>

export const RoleAssignmentSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('discord-role'), discordRoleId: M.UserIdSchema, role: RoleSchema }),
	z.object({ type: z.literal('discord-user'), discordUserId: M.UserIdSchema, role: RoleSchema }),
	z.object({ type: z.literal('discord-server-member'), role: RoleSchema }),
])
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>

export const PERMISSION_SOURCE = z.enum(['config', 'programmatic'])
export const PERM_SCOPE_ARGS = {
	global: z.undefined(),
	filter: z.object({ filterId: M.FilterEntityIdSchema }),
}

type PermScope = keyof typeof PERM_SCOPE_ARGS

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
	...definePermission('filters:manage', { description: 'Delete a filter or add or remove contributors to a filter', scope: 'filter' }),
	...definePermission('users:get', { description: 'Get user information', scope: 'global' }),
}
export type PermissionType = (typeof PERMISSION_DEFINITION)[number]['type']
export const PERMISSION_TYPE = z.enum(Object.keys(PERMISSION_DEFINITION) as [PermissionType, ...PermissionType[]])
export const GLOBAL_PERMISSION_TYPE = PERMISSION_TYPE.extract([
	'site:authorized',
	'queue:write',
	'settings:write',
	'vote:manage',
	'filters:write-all',
	'users:get',
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

export type Permission<T extends PermissionType = PermissionType> = ReturnType<typeof perm<T>>

export function permissionDenied<T extends PermissionType>(req: PermissionReq<T>) {
	return {
		code: 'err:permission-denied' as const,
		...req,
	}
}

export type PermissionDeniedResponse<T extends PermissionType = PermissionType> = ReturnType<typeof permissionDenied<T>>
export type PermissionReq<T extends PermissionType = PermissionType> = { check: 'all' | 'any'; permits: Permission<T>[] }

export function rbacUserHasPerms<T extends PermissionType>(user: M.UserWithRbac, req: PermissionReq<T>): boolean {
	return userHasPerms(user.discordId, user.perms, req)
}

// TODO technically incorrect when it comes to filters:write-all
export function userHasPerms<T extends PermissionType>(userId: bigint, perms: Permission[], req: PermissionReq<T>): boolean {
	for (const perm of req.permits) {
		const hasPerm = perms.find((userPerm) => deepEqual(userPerm, perm))
		if (req.check === 'all' && !hasPerm) return false
		if (req.check === 'any' && hasPerm) return true
	}
	return req.check === 'all'
}

export function tryDenyPermissionsForRbacUser<T extends PermissionType>(user: M.UserWithRbac, req: PermissionReq<T>) {
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
