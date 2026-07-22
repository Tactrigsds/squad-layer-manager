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
	// null = unlimited (Infinity doesn't serialize and zod rejects it)
	timeout: z.object({ maxDurationMs: z.number().int().positive().nullable() }),
	// null = unlimited
	'layer-requests': z.object({ maxQueued: z.number().int().positive().nullable() }),
	// null serverId = all servers
	'server-settings': z.object({ serverId: z.string().nullable() }),
	// paths are dotted setting-path prefixes (e.g. "queue.mainPool"); null = all non-sensitive settings
	'server-settings-write': z.object({ serverId: z.string().nullable(), paths: z.array(z.string()).nullable() }),
	'global-settings-write': z.object({ paths: z.array(z.string()).nullable() }),
}

type PermScope = keyof typeof PERM_SCOPE_ARGS

export type UserWithRbac = USR.User & { perms: TracedPermission[] }

function definePermission<T extends string, S extends PermScope>(type: T, args: { description: string; scope: S }) {
	return { [type]: { type, description: args.description, scope: args.scope, scopeArgs: PERM_SCOPE_ARGS[args.scope] } } as const
}

export const PERMISSION_DEFINITION = {
	...definePermission('site:authorized', { description: 'Access the site', scope: 'global' }),

	...definePermission('queue:write', { description: 'Add, remove, edit or reorder layers in the queue', scope: 'global' }),
	...definePermission('queue:force-write', {
		description: "Add, remove, edit or reorder layers in the queue, even if the layer isn't in the pool",
		scope: 'global',
	}),
	...definePermission('queue:request-layers', {
		description: 'Request layers (the backburner below the queue and /reqlayer in-game), up to the granted number of concurrent requests',
		scope: 'layer-requests',
	}),
	...definePermission('vote:manage', { description: 'Start and abort votes', scope: 'global' }),

	...definePermission('global-settings:read', { description: 'View global settings and the audit log', scope: 'global' }),
	...definePermission('global-settings:write', {
		description: 'Edit global settings, optionally restricted to specific setting paths. Implies global-settings:read',
		scope: 'global-settings-write',
	}),
	...definePermission('server-settings:read', {
		description: 'View server settings. Never includes the RCON/SFTP connection details',
		scope: 'server-settings',
	}),
	...definePermission('server-settings:write', {
		description: 'Edit non-sensitive server settings, optionally restricted to specific setting paths. Implies server-settings:read',
		scope: 'server-settings-write',
	}),
	...definePermission('server-settings:write-sensitive', {
		description: 'View and edit the RCON/SFTP connection details of a server',
		scope: 'server-settings',
	}),

	...definePermission('filters:create', { description: 'Create new filters', scope: 'global' }),
	...definePermission('filters:write-all', {
		description: 'Delete or modify any filter, change their owners, and add/remove contributors',
		scope: 'global',
	}),
	...definePermission('filters:write', { description: 'Modify a filter', scope: 'filter' }),
	...definePermission('filters:manage', {
		description: 'Manage a filter\s owner and contributors, and delete the filter',
		scope: 'filter',
	}),

	...definePermission('squad-server:end-match', { description: 'End the current match on the server', scope: 'global' }),
	...definePermission('squad-server:disable-slm-updates', { description: 'Disable updates from slm to the game-server', scope: 'global' }),
	...definePermission('squad-server:turn-fog-off', { description: 'Disable fog-of-war for the current match', scope: 'global' }),
	...definePermission('squad-server:manage-players', {
		description: 'Disband squads, remove players from squads, and manage team swaps',
		scope: 'global',
	}),
	...definePermission('squad-server:warn-players', { description: 'Send in-game warnings to players', scope: 'global' }),
	...definePermission('squad-server:broadcast', { description: 'Send server-wide broadcast messages', scope: 'global' }),
	...definePermission('squad-server:kick-players', {
		description: 'Kick players from the server (no timeout; they may rejoin immediately)',
		scope: 'global',
	}),
	...definePermission('squad-server:timeout-players', {
		description: 'Kick players with a timeout barring them from rejoining, up to the granted maximum duration',
		scope: 'timeout',
	}),

	...definePermission('battlemetrics:write-flags', { description: 'Add or remove BattleMetrics player flags', scope: 'global' }),

	...definePermission('admin:manage-servers', {
		description: 'Manage the server registry: create servers, start/stop them and set the default server',
		scope: 'global',
	}),
	...definePermission('admin:delete-servers', { description: 'Delete servers', scope: 'global' }),
	...definePermission('admin:restart-slm', { description: 'Restart the SLM application', scope: 'global' }),
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

// permissions grantable as bare expressions in role definitions. Global-scope perms plus the settings perms, which a
// bare expression grants unrestricted (all servers / all paths); restricted settings grants live in the rbac settings'
// globalSettingsGrants/serverSettingsGrants maps instead.
const ROLE_GRANTABLE_SCOPED_PERMISSION_TYPES = [
	'global-settings:write',
	'server-settings:read',
	'server-settings:write',
	'server-settings:write-sensitive',
] as const satisfies PermissionType[]

export type RoleGrantablePermissionType = GlobalPermissionType | (typeof ROLE_GRANTABLE_SCOPED_PERMISSION_TYPES)[number]

export const ROLE_GRANTABLE_PERMISSION_TYPE = z.enum(
	[...GLOBAL_PERMISSION_TYPE.options, ...ROLE_GRANTABLE_SCOPED_PERMISSION_TYPES] as unknown as [
		RoleGrantablePermissionType,
		...RoleGrantablePermissionType[],
	],
)

// the scope args a bare role expression grants for one of the grantable settings perms: unrestricted everything
export function unrestrictedRoleGrantArgs<T extends RoleGrantablePermissionType>(type: T): PermArgs<T> {
	switch (type as RoleGrantablePermissionType) {
		case 'global-settings:write':
			return { paths: null } as PermArgs<T>
		case 'server-settings:read':
		case 'server-settings:write-sensitive':
			return { serverId: null } as PermArgs<T>
		case 'server-settings:write':
			return { serverId: null, paths: null } as PermArgs<T>
		default:
			return undefined as PermArgs<T>
	}
}

export function isRoleGrantablePermissionType(expr: RolePermissionExpression): expr is RoleGrantablePermissionType {
	return ROLE_GRANTABLE_PERMISSION_TYPE.safeParse(expr).success
}
export function parseNegatingPermissionType(expr: string): RoleGrantablePermissionType | undefined {
	if (!expr.startsWith('!')) return undefined
	const perm = expr.slice(1)
	if (!isRoleGrantablePermissionType(perm)) return undefined
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

export const ROLE_PERMISSION_EXPRESSION = z.union([
	ROLE_GRANTABLE_PERMISSION_TYPE,
	z.literal('*').describe('include all'),
	z.string().regex(/^!/).refine((str) => ROLE_GRANTABLE_PERMISSION_TYPE.safeParse(str.slice(1)).success, {
		error: 'Negated permission must be a valid role-grantable permission type',
	}).describe('negated permissions. takes precedence wherever present for a user'),
])

export type RolePermissionExpression = z.infer<typeof ROLE_PERMISSION_EXPRESSION>

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

export function tryDenyPermissionsForRbacUser<T extends PermissionType>(
	user: UserWithRbac,
	req: Permission<T>,
): PermissionDeniedResponse<T> | null
export function tryDenyPermissionsForRbacUser<T extends PermissionType>(
	user: UserWithRbac,
	req: Permission<T>[],
): PermissionDeniedResponse<T> | null
export function tryDenyPermissionsForRbacUser<T extends PermissionType>(
	user: UserWithRbac,
	req: PermissionReq<T>,
): PermissionDeniedResponse<T> | null
export function tryDenyPermissionsForRbacUser<T extends PermissionType>(
	user: UserWithRbac,
	req: Permission<T> | Permission<T>[] | PermissionReq<T>,
): PermissionDeniedResponse<T> | null {
	const normReq: PermissionReq<T> = 'check' in req ? req : { check: 'all', permits: Array.isArray(req) ? req : [req] }
	if (!rbacUserHasPerms(user, normReq)) {
		return permissionDenied(normReq)
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

// matches on identity alone (type + scope + args). Unlike arePermsEqual this ignores negation state, which changes as
// permission simulation is applied and so can't be part of a perm's identity.
export function isSamePerm(perm1: Permission & Partial<PermissionTrace>, perm2: Permission & Partial<PermissionTrace>) {
	return arePermsEqual(Obj.selectProps(perm1, ['args', 'scope', 'type']), Obj.selectProps(perm2, ['args', 'scope', 'type']))
}

export function getWritePermReqForFilterEntity(id: F.FilterEntityId): PermissionReq {
	return {
		check: 'any',
		permits: [perm('filters:write', { filterId: id }), perm('filters:write-all')],
	}
}
export function getManagePermReqForFilterEntity(id: F.FilterEntityId): PermissionReq {
	return {
		check: 'any',
		permits: [perm('filters:manage', { filterId: id }), perm('filters:write-all')],
	}
}

// the effective max kick-timeout duration a set of perms grants: undefined = no grant at all,
// null = unlimited, number = max ms. Deliberately not routed through arePermsEqual: "up to N" is a
// comparator, not an equality match.
export function maxTimeoutDurationMs(perms: Permission[]): number | null | undefined {
	let max: number | undefined = undefined
	for (const p of perms) {
		if (p.type !== 'squad-server:timeout-players') continue
		const args = p.args as z.infer<(typeof PERM_SCOPE_ARGS)['timeout']> | undefined
		if (!args) continue
		if (args.maxDurationMs === null) return null
		if (max === undefined || args.maxDurationMs > max) max = args.maxDurationMs
	}
	return max
}

// the effective max concurrent layer requests a set of perms grants: undefined = no grant at all,
// null = unlimited, number = max items. A comparator like maxTimeoutDurationMs, not an equality match.
export function maxLayerRequests(perms: Permission[]): number | null | undefined {
	let max: number | undefined = undefined
	for (const p of perms) {
		if (p.type !== 'queue:request-layers') continue
		const args = p.args as z.infer<(typeof PERM_SCOPE_ARGS)['layer-requests']> | undefined
		if (!args) continue
		if (args.maxQueued === null) return null
		if (max === undefined || args.maxQueued > max) max = args.maxQueued
	}
	return max
}

// ============================== settings access ==============================
// Settings write grants are prefix-matched against setting paths and server ids ("covers", not "equals"), so like
// timeouts they bypass the equality-matched permission path and get aggregated here instead.

export type SettingsWriteAccess =
	| { kind: 'none' }
	| { kind: 'all' }
	// dotted setting-path prefixes the grant is limited to
	| { kind: 'paths'; paths: string[] }

export function dottedSettingsPath(path: string | (string | number)[]): string {
	return typeof path === 'string' ? path : path.join('.')
}

// PermArgs<T> resolves imprecisely on the merged PERMISSION_DEFINITION, so the readers below type args
// straight off PERM_SCOPE_ARGS (same approach as maxTimeoutDurationMs)
type ServerScopeArgs = z.infer<(typeof PERM_SCOPE_ARGS)['server-settings']>
type ServerWriteArgs = z.infer<(typeof PERM_SCOPE_ARGS)['server-settings-write']>
type GlobalWriteArgs = z.infer<(typeof PERM_SCOPE_ARGS)['global-settings-write']>

function serverIdMatches(args: { serverId: string | null } | undefined, serverId: string): boolean {
	// missing args = a legacy/defensive grant; treat as unrestricted
	return !args || args.serverId === null || args.serverId === serverId
}

function collectWriteAccess(pathSets: (string[] | null)[]): SettingsWriteAccess {
	if (pathSets.length === 0) return { kind: 'none' }
	const paths: string[] = []
	for (const set of pathSets) {
		if (set === null) return { kind: 'all' }
		paths.push(...set)
	}
	return paths.length > 0 ? { kind: 'paths', paths } : { kind: 'none' }
}

export function globalSettingsWriteAccess(perms: Permission[]): SettingsWriteAccess {
	const pathSets: (string[] | null)[] = []
	for (const p of perms) {
		if (p.type !== 'global-settings:write') continue
		const args = p.args as GlobalWriteArgs | undefined
		pathSets.push(args ? args.paths : null)
	}
	return collectWriteAccess(pathSets)
}

export function canReadGlobalSettings(perms: Permission[]): boolean {
	return perms.some((p) => p.type === 'global-settings:read') || globalSettingsWriteAccess(perms).kind !== 'none'
}

export function serverSettingsWriteAccess(perms: Permission[], serverId: string): SettingsWriteAccess {
	const pathSets: (string[] | null)[] = []
	for (const p of perms) {
		if (p.type !== 'server-settings:write') continue
		const args = p.args as ServerWriteArgs | undefined
		if (!serverIdMatches(args, serverId)) continue
		pathSets.push(args ? args.paths : null)
	}
	return collectWriteAccess(pathSets)
}

export function canWriteSensitiveServerSettings(perms: Permission[], serverId: string): boolean {
	return perms.some((p) =>
		p.type === 'server-settings:write-sensitive'
		&& serverIdMatches(p.args as ServerScopeArgs | undefined, serverId)
	)
}

// creating a server means supplying its connection details, which is gated by write-sensitive. A grant scoped to a
// specific server id can't authorize a brand-new id, so creation requires an unscoped (all-servers) write-sensitive grant.
export function canCreateServers(perms: Permission[]): boolean {
	return perms.some((p) =>
		p.type === 'server-settings:write-sensitive'
		&& ((p.args as ServerScopeArgs | undefined)?.serverId ?? null) === null
	)
}

export function canReadServerSettings(perms: Permission[], serverId: string): boolean {
	if (perms.some((p) => p.type === 'server-settings:read' && serverIdMatches(p.args as ServerScopeArgs | undefined, serverId))) {
		return true
	}
	return serverSettingsWriteAccess(perms, serverId).kind !== 'none' || canWriteSensitiveServerSettings(perms, serverId)
}

// strict check used for enforcement: the written path must sit at or below one of the granted prefixes
export function settingsPathAllowed(access: SettingsWriteAccess, path: string | (string | number)[]): boolean {
	if (access.kind === 'all') return true
	if (access.kind === 'none') return false
	const dotted = dottedSettingsPath(path)
	return access.paths.some((p) => dotted === p || dotted.startsWith(p + '.'))
}

// loose check used for UI gating of a whole subtree: true when anything under `path` is potentially writable
// (a granted prefix covers the subtree, or points somewhere inside it)
export function settingsPathOverlaps(access: SettingsWriteAccess, path: string | (string | number)[]): boolean {
	if (access.kind === 'all') return true
	if (access.kind === 'none') return false
	const dotted = dottedSettingsPath(path)
	return access.paths.some((p) => dotted === p || dotted.startsWith(p + '.') || p.startsWith(dotted + '.'))
}

// does `perms` already grant everything `perm` grants? The scoped permissions ("up to N ms", "these paths on these
// servers") are comparators rather than equality matches, so they're covered scope-by-scope here.
export function permSubsumedBy(perm: Permission, perms: Permission[]): boolean {
	switch (perm.type) {
		case 'squad-server:timeout-players': {
			const args = perm.args as z.infer<(typeof PERM_SCOPE_ARGS)['timeout']> | undefined
			const max = maxTimeoutDurationMs(perms)
			if (max === undefined) return false
			if (max === null) return true
			if (!args || args.maxDurationMs === null) return false
			return args.maxDurationMs <= max
		}
		case 'queue:request-layers': {
			const args = perm.args as z.infer<(typeof PERM_SCOPE_ARGS)['layer-requests']> | undefined
			const max = maxLayerRequests(perms)
			if (max === undefined) return false
			if (max === null) return true
			if (!args || args.maxQueued === null) return false
			return args.maxQueued <= max
		}
		case 'global-settings:write': {
			const args = perm.args as GlobalWriteArgs | undefined
			return pathsCoveredBy(args ? args.paths : null, globalSettingsWriteAccess(perms))
		}
		case 'server-settings:read':
		case 'server-settings:write-sensitive': {
			const serverId = (perm.args as ServerScopeArgs | undefined)?.serverId ?? null
			// an all-servers grant can only be covered by another all-servers grant
			if (serverId === null) {
				return perms.some((p) => p.type === perm.type && ((p.args as ServerScopeArgs | undefined)?.serverId ?? null) === null)
			}
			return perm.type === 'server-settings:read'
				? canReadServerSettings(perms, serverId)
				: canWriteSensitiveServerSettings(perms, serverId)
		}
		case 'server-settings:write': {
			const args = perm.args as ServerWriteArgs | undefined
			const serverId = args?.serverId ?? null
			if (serverId === null) {
				const allServerPathSets = perms.flatMap((p) => {
					if (p.type !== 'server-settings:write') return []
					const pArgs = p.args as ServerWriteArgs | undefined
					return (pArgs?.serverId ?? null) === null ? [pArgs?.paths ?? null] : []
				})
				return pathsCoveredBy(args ? args.paths : null, collectWriteAccess(allServerPathSets))
			}
			return pathsCoveredBy(args ? args.paths : null, serverSettingsWriteAccess(perms, serverId))
		}
		default:
			return perms.some((p) => arePermsEqual(p, perm))
	}
}

// null paths = unrestricted, so only an unrestricted grant covers it
function pathsCoveredBy(paths: string[] | null, access: SettingsWriteAccess): boolean {
	if (access.kind === 'all') return true
	if (access.kind === 'none' || paths === null) return false
	return paths.every((path) => settingsPathAllowed(access, path))
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
