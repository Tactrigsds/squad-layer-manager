import * as Arr from '@/lib/array'
import * as Obj from '@/lib/object'
import * as F from '@/models/filter.models'
import type * as USR from '@/models/users.models'

import { z } from 'zod'

export type GenericRole = {
	type: string
}

export function userDefinedRole(type: string): GenericRole {
	return { type }
}

// roles which are inferred by other state, for example the owner of a filter will get the filter-owner role. when an inferred role is present, it's expected to also have access to a particular permission to know what entity the inferred role is associated with.
export const InferredRoleSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('filter-owner'), filterId: F.FilterEntityIdSchema }),
	z.object({ type: z.literal('filter-user-contributor'), filterId: F.FilterEntityIdSchema }),
	z.object({
		type: z.literal('filter-role-contributor'),
		source: z.literal('inferred'),
		filterId: F.FilterEntityIdSchema,
		roleId: z.string(),
	}),
])

export type InferredRole = z.infer<typeof InferredRoleSchema>
{
	// make sure these are subspecies of GenericRoles
	const _ = {} as InferredRole satisfies GenericRole
}

export type Role = InferredRole | GenericRole
export type RoleArg = InferredRole | string

export function isInferredRoleType<R extends { type: Role['type'] }>(role: R): role is Extract<R, { type: InferredRole['type'] }> {
	return role.type === 'filter-owner' || role.type === 'filter-user-contributor' || role.type === 'filter-role-contributor'
}

export const UserDefinedRoleIdSchema = z
	.string()
	.regex(/^[a-z0-9-]+$/)
	.min(3)
	.max(32)
	.refine((roleType) => !isInferredRoleType({ type: roleType }), {
		error: `Role cannot be the same as one of the inferred roles: ${
			InferredRoleSchema.options.map((opt) => opt.shape.type.value).join(', ')
		}`,
	})

export type RoleAssignment =
	| { type: 'discord-role'; discordRoleId: bigint; role: Role }
	| { type: 'discord-user'; discordUserId: bigint; role: Role }
	| { type: 'discord-server-member'; role: Role }

export const ROLE_ASSIGNMENT_TYPES = ['discord-role', 'discord-user', 'discord-server-member'] as const
{
	// typecheck
	const _ = '' as typeof ROLE_ASSIGNMENT_TYPES[number] satisfies RoleAssignment['type']
}

export const PERM_SCOPE_ARGS = {
	global: z.undefined(),
	filter: z.object({ filterId: F.FilterEntityIdSchema }),
}

type PermScope = keyof typeof PERM_SCOPE_ARGS

export type UserWithRbac = USR.User & { perms: TracedPermission[] }

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
export type KnownPermission = (typeof PERMISSION_DEFINITION)[number]
export type PermissionType = KnownPermission['type']

export type GlobalPermissionType = Extract<KnownPermission, { scope: 'global' }>['type']

export const PERMISSION_TYPE = z.enum(Object.keys(PERMISSION_DEFINITION) as [PermissionType, ...PermissionType[]])
export const GLOBAL_PERMISSION_TYPE = z.enum(
	Object.values(PERMISSION_DEFINITION).flatMap((def) => def.scope === 'global' ? [def.type] : []) as [
		GlobalPermissionType,
		...GlobalPermissionType[],
	],
)

export const NEGATED_GLOBAL_PERMISSION_TYPE = GLOBAL_PERMISSION_TYPE.options.map((perm) => `!${perm}` as const)

export function isGlobalPermissionType(expr: GlobalPermissionTypeExpression): expr is GlobalPermissionType {
	return GLOBAL_PERMISSION_TYPE.safeParse(expr).success
}
export function parseNegatingPermissionType(expr: string): GlobalPermissionType | undefined {
	if (!expr.startsWith('!')) return undefined
	const perm = expr.slice(1)
	if (!isGlobalPermissionType(perm)) return undefined
	return perm
}

export function fromTracedPermissions(perms: TracedPermission[]): Permission[] {
	return perms.filter(perm => !perm.negated && !perm.negating).map(perm => Obj.exclude(perm, ['negated', 'negating']))
}

export function recalculateNegations(perms: TracedPermission[]) {
	const recalculated = perms.map(perm => {
		let negated: boolean
		if (perm.negating) negated = true
		else {
			const negatedVersion = { ...perm, negating: true, negated: true }
			negated = perms.some((perm) => arePermsEqual(negatedVersion, perm))
		}
		return ({ ...perm, negated })
	})
	return recalculated
}

export const GLOBAL_PERMISSION_TYPE_EXPRESSION = z.union([
	GLOBAL_PERMISSION_TYPE,
	z.literal('*').describe('include all'),
	z.string().regex(/^!/).refine((str) => GLOBAL_PERMISSION_TYPE.safeParse(str.slice(1)).success, {
		error: 'Negated permission must be a valid global permission type',
	}).describe('negated permissions. takes precedence wherever present for a user'),
])

export type GlobalPermissionTypeExpression = z.infer<typeof GLOBAL_PERMISSION_TYPE_EXPRESSION>

export type PermArgs<T extends PermissionType> = z.infer<(typeof PERMISSION_DEFINITION)[T]['scopeArgs']>

export type Permission<T extends PermissionType = PermissionType> = ReturnType<typeof perm<T>>
export function perm<T extends PermissionType>(type: T, scopeOpts?: z.infer<(typeof PERMISSION_DEFINITION)[T]['scopeArgs']>) {
	return {
		type,
		scope: PERMISSION_DEFINITION[type].scope,
		args: scopeOpts ?? (undefined as PermArgs<T>),
	}
}

export function tracedPerm<T extends PermissionType>(
	type: T,
	roles: Role[],
	opts?: { negated?: boolean; negating?: boolean },
	scopeOpts?: z.infer<(typeof PERMISSION_DEFINITION)[T]['scopeArgs']>,
) {
	return {
		...perm(type, scopeOpts),
		allowedByRoles: roles,
		negated: opts?.negated ?? false,
		negating: opts?.negating ?? false,
	}
}

export type PermissionTrace = {
	allowedByRoles: Role[]
	// this perm has been negated by another perm or by itself.
	negated: boolean

	// this perm is a negating perm (!<perm>)
	negating: boolean
}
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
		return userHasPerms(user.discordId, fromTracedPermissions(user.perms), reqOrPerms)
	}
	const req: PermissionReq<T> = {
		check: 'all',
		permits: Array.isArray(reqOrPerms) ? reqOrPerms : [reqOrPerms],
	}
	return userHasPerms(user.discordId, fromTracedPermissions(user.perms), req)
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
	// just in case
	userPerms = fromTracedPermissions(userPerms as TracedPermission<T>[])
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
	perm1 = Obj.selectProps(perm1, ['args', 'scope', 'type', 'negated', 'negating'])
	perm2 = Obj.selectProps(perm2, ['args', 'scope', 'type', 'negated', 'negating'])
	Obj.trimUndefined(perm1)
	Obj.trimUndefined(perm2)

	// defaults are false
	if (!perm1.negated) delete perm1.negated
	if (!perm2.negated) delete perm2.negated
	if (!perm1.negating) delete perm1.negating
	if (!perm2.negating) delete perm2.negating

	return Obj.deepEqual(perm1, perm2)
}

export function getWritePermReqForFilterEntity(id: F.FilterEntityId): PermissionReq {
	return {
		check: 'any',
		permits: [perm('filters:write', { filterId: id }), perm('filters:write-all')],
	}
}

export function getPermissionsByRole(permissions: TracedPermission[]): [Role, TracedPermission[]][] {
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

	return Array.from(rolePermissionsMap.entries()).map(([roleKey, perms]) => [JSON.parse(roleKey) as Role, perms])
}
