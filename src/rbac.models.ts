import { z } from 'zod'

import * as Arr from '@/lib/array-utils'
import * as Obj from '@/lib/object-utils'
import * as F from '@/models/filter.models'
import type * as USR from '@/models/users.models'

import { assertNever } from './lib/type-guards'

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
export type UserRbac = {
	perms: TracedPermission[]
	roles: Role[]
}

export namespace Role {
	// mutates `roles` in place (adding `role` unless an equal one is already present) and returns it. Callers rely on
	// the mutation -- see merge() and rbac.server's assignment resolvers, which discard the return value.
	export function push(roles: Role[], role: Role): Role[] {
		for (const r of roles) {
			if (Obj.deepEqual(r, role)) {
				return roles
			}
		}
		roles.push(role)
		return roles
	}
	export function merge(roles: Role[], otherRoles: Role[]): Role[] {
		const newRoles = [...roles]
		for (const role of otherRoles) {
			push(newRoles, role)
		}
		return newRoles
	}
}

export function isInferredRoleType<R extends { type: Role['type'] }>(role: R): role is Extract<R, { type: InferredRole['type'] }> {
	return role.type === 'filter-owner' || role.type === 'filter-user-contributor' || role.type === 'filter-role-contributor'
}

export const UserDefinedRoleIdSchema = z
	.string()
	.regex(/^[a-z0-9-]+$/)
	.min(3)
	.max(32)
	.refine((roleType) => !isInferredRoleType({ type: roleType }), {
		error: `Role cannot be the same as one of the inferred roles: ${InferredRoleSchema.options
			.map((opt) => opt.shape.type.value)
			.join(', ')}`,
	})

export type RoleAssignment =
	| { type: 'discord-role'; discordRoleId: bigint; role: Role }
	| { type: 'discord-user'; discordUserId: bigint; role: Role }
	| { type: 'discord-server-member'; role: Role }
	// both name the admin list they speak of: which lists a server uses is per-server, so an unqualified one could not
	// say whether it meant this server's admins or some other server's
	| { type: 'admin-list-group'; role: Role; listId: string; groupId: string }
	| { type: 'ingame-admin'; role: Role; listId: string }

export const ROLE_ASSIGNMENT_TYPES = ['discord-role', 'discord-user', 'discord-server-member'] as const
{
	// typecheck
	const _ = '' as (typeof ROLE_ASSIGNMENT_TYPES)[number] satisfies RoleAssignment['type']
}

export const PERM_SCOPE_ARGS = {
	global: z.undefined(),
	filter: z.object({ filterId: F.FilterEntityIdSchema }),
	// acts on one squad server's live state or its queue. null serverId = all servers, as everywhere below
	server: z.object({ serverId: z.string().nullable() }),
	// null = unlimited (Infinity doesn't serialize and zod rejects it)
	timeout: z.object({ serverId: z.string().nullable(), maxDurationMs: z.number().int().positive().nullable() }),
	// null = unlimited
	'layer-requests': z.object({ serverId: z.string().nullable(), maxQueued: z.number().int().positive().nullable() }),
	// null serverId = all servers
	'server-settings': z.object({ serverId: z.string().nullable() }),
	// paths are dotted setting-path prefixes (e.g. "queue.mainPool"); null = all non-sensitive settings
	'server-settings-write': z.object({ serverId: z.string().nullable(), paths: z.array(z.string()).nullable() }),
	'global-settings-write': z.object({ paths: z.array(z.string()).nullable() }),
}

type PermScope = keyof typeof PERM_SCOPE_ARGS

export type UserWithRbac = USR.User & { perms: TracedPermission[] }

// the return is cast to a keyed record ({ [K in T]: ... }); left to inference the computed `[type]` key becomes a
// string index signature, which erases the specific key so PERMISSION_DEFINITION[K] can't resolve per-permission
function definePermission<T extends string, S extends PermScope>(type: T, args: { description: string; scope: S }) {
	return { [type]: { type, description: args.description, scope: args.scope, scopeArgs: PERM_SCOPE_ARGS[args.scope] } } as {
		[K in T]: { type: T; description: string; scope: S; scopeArgs: (typeof PERM_SCOPE_ARGS)[S] }
	}
}

export const PERMISSION_DEFINITION = {
	...definePermission('site:authorized', { description: 'Access the site', scope: 'global' }),

	...definePermission('queue:write', { description: 'Add, remove, edit or reorder layers in the queue', scope: 'server' }),
	...definePermission('queue:force-write', {
		description: "Add, remove, edit or reorder layers in the queue, even if the layer isn't in the pool",
		scope: 'server',
	}),
	...definePermission('queue:manage-all-notes', {
		description: "Edit or delete anyone's notes on queued layers. Writing notes, and managing your own, only needs queue:write",
		scope: 'server',
	}),
	...definePermission('queue:manage-tags', {
		description: 'Create and edit layer tags from the queue, without needing settings access',
		scope: 'global',
	}),
	...definePermission('queue:request-layers', {
		description: 'Request layers (the backburner below the queue and /reqlayer in-game), up to the granted number of concurrent requests',
		scope: 'layer-requests',
	}),
	...definePermission('vote:manage', { description: 'Start and abort votes', scope: 'server' }),

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
		description: 'Manage a filters owner and contributors, and delete the filter',
		scope: 'filter',
	}),

	...definePermission('squad-server:view', {
		description: "View a server's dashboard: its roster, chat, queue and match history",
		scope: 'server',
	}),
	...definePermission('squad-server:end-match', { description: 'End the current match on the server', scope: 'server' }),
	...definePermission('squad-server:disable-slm-updates', {
		description: 'Disable updates from slm to the game-server',
		scope: 'server',
	}),
	...definePermission('squad-server:turn-fog-off', { description: 'Disable fog-of-war for the current match', scope: 'server' }),
	...definePermission('squad-server:manage-players', {
		description: 'Kill players, disband squads, remove players from squads, demote commanders, and manage team swaps',
		scope: 'server',
	}),
	...definePermission('squad-server:warn-players', { description: 'Send in-game warnings to players', scope: 'server' }),
	...definePermission('squad-server:broadcast', { description: 'Send server-wide broadcast messages', scope: 'server' }),
	...definePermission('squad-server:kick-players', {
		description: 'Kick players from the server (no timeout; they may rejoin immediately)',
		scope: 'server',
	}),
	...definePermission('squad-server:timeout-players', {
		description: 'Kick players with a timeout barring them from rejoining, up to the granted maximum duration',
		scope: 'timeout',
	}),
	...definePermission('squad-server:view-console', {
		description:
			"Read the server's raw rcon traffic and unparsed log lines. This is everything the game server says, " +
			'including player IPs, steam and EOS ids, admin chat and every admin action, so it discloses more than the ' +
			'dashboard does. Read-only: it cannot issue commands.',
		scope: 'server',
	}),

	...definePermission('sandbox:control', {
		description:
			'Drive a sandbox server: connect and disconnect fabricated players, speak as them, end matches and inject faults. ' +
			'Has no effect on a server backed by a real squad server.',
		scope: 'server',
	}),

	...definePermission('battlemetrics:write-flags', { description: 'Add or remove BattleMetrics player flags', scope: 'global' }),

	...definePermission('admin:manage-servers', {
		description: 'Manage the server registry: create servers, start/stop them and set the default server',
		scope: 'global',
	}),
	...definePermission('admin:delete-servers', { description: 'Delete servers', scope: 'global' }),
	...definePermission('admin:restart-slm', { description: 'Restart the SLM application', scope: 'global' }),
}
export type KnownPermission = (typeof PERMISSION_DEFINITION)[keyof typeof PERMISSION_DEFINITION]
export type PermissionType = KnownPermission['type']

export type GlobalPermissionType = Extract<KnownPermission, { scope: 'global' }>['type']
export type ServerPermissionType = Extract<KnownPermission, { scope: 'server' }>['type']

export const PERMISSION_TYPE = z.enum(Object.keys(PERMISSION_DEFINITION) as [PermissionType, ...PermissionType[]])
export const GLOBAL_PERMISSION_TYPE = z.enum(
	Object.values(PERMISSION_DEFINITION).flatMap((def) => (def.scope === 'global' ? [def.type] : [])) as [
		GlobalPermissionType,
		...GlobalPermissionType[],
	],
)
export const SERVER_PERMISSION_TYPE = z.enum(
	Object.values(PERMISSION_DEFINITION).flatMap((def) => (def.scope === 'server' ? [def.type] : [])) as [
		ServerPermissionType,
		...ServerPermissionType[],
	],
)

export function isServerScoped(type: PermissionType): type is ServerPermissionType {
	return PERMISSION_DEFINITION[type].scope === 'server'
}

// permissions grantable as bare expressions in role definitions. Global- and server-scope perms plus the settings
// perms, which a bare expression grants unrestricted (all servers / all paths); restricted grants live in the rbac
// settings' globalSettingsGrants/serverSettingsGrants/serverGrants lists instead.
const ROLE_GRANTABLE_SCOPED_PERMISSION_TYPES = [
	'global-settings:write',
	'server-settings:read',
	'server-settings:write',
	'server-settings:write-sensitive',
] as const satisfies PermissionType[]

export type RoleGrantablePermissionType =
	| GlobalPermissionType
	| ServerPermissionType
	| (typeof ROLE_GRANTABLE_SCOPED_PERMISSION_TYPES)[number]

export const ROLE_GRANTABLE_PERMISSION_TYPE = z.enum([
	...GLOBAL_PERMISSION_TYPE.options,
	...SERVER_PERMISSION_TYPE.options,
	...ROLE_GRANTABLE_SCOPED_PERMISSION_TYPES,
] as unknown as [RoleGrantablePermissionType, ...RoleGrantablePermissionType[]])

// the scope args a bare role expression grants: unrestricted everything (all servers, all paths)
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
			if (isServerScoped(type as PermissionType)) return { serverId: null } as PermArgs<T>
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
	// Obj.exclude collapses the discriminated union; the runtime object is still a valid Permission
	return perms.filter((perm) => !perm.negated && !perm.negating).map((perm) => Obj.exclude(perm, ['negated', 'negating']) as Permission)
}

export function recalculateNegations(perms: TracedPermission[]) {
	const recalculated = perms.map((perm) => {
		let negated: boolean
		if (perm.negating) negated = true
		else {
			const negatedVersion = { ...perm, negating: true, negated: true }
			negated = perms.some((perm) => arePermsEqual(negatedVersion, perm))
		}
		return { ...perm, negated }
	})
	return recalculated
}

export const ROLE_PERMISSION_EXPRESSION = z.union([
	ROLE_GRANTABLE_PERMISSION_TYPE,
	z.literal('*').describe('include all'),
	z
		.string()
		.regex(/^!/)
		.refine((str) => ROLE_GRANTABLE_PERMISSION_TYPE.safeParse(str.slice(1)).success, {
			error: 'Negated permission must be a valid role-grantable permission type',
		})
		.describe('negated permissions. takes precedence wherever present for a user'),
])

export type RolePermissionExpression = z.infer<typeof ROLE_PERMISSION_EXPRESSION>

// precomputed as concrete maps rather than `z.infer<(PERMISSION_DEFINITION)[K]['scopeArgs']>` inline: a bare
// z.infer over the indexed access does not resolve per-member when distributed below, leaving `args` the full
// union and defeating narrowing. A map lookup (PermArgsMap[K]) resolves cleanly.
type PermArgsMap = { [K in PermissionType]: z.infer<(typeof PERMISSION_DEFINITION)[K]['scopeArgs']> }
type PermScopeMap = { [K in PermissionType]: (typeof PERMISSION_DEFINITION)[K]['scope'] }
export type PermArgs<T extends PermissionType> = PermArgsMap[T]

type PermissionFor<K extends PermissionType> = {
	type: K
	scope: PermScopeMap[K]
	args: PermArgsMap[K]
}

// distributive over T so `Permission` is a discriminated union on `type`: narrowing `perm.type === 'x'` then
// narrows `scope` and `args` to x's. (`ReturnType<typeof perm>` would collapse to one object with independently
// unioned fields, which doesn't narrow.)
export type Permission<T extends PermissionType = PermissionType> = T extends unknown ? PermissionFor<T> : never

// Scope args are required for every permission that has them, and rejected for the ones that don't (global scope,
// whose PermArgs is `undefined`). Written as a rest tuple because that is the only way to make a parameter's
// optionality depend on the type argument: without it a server-scoped `perm('queue:write')` compiles and silently
// asks for an all-servers grant, which is exactly the mistake worth catching at the call site.
export function perm<T extends PermissionType>(
	type: T,
	...[scopeOpts]: undefined extends PermArgs<T> ? [scopeOpts?: PermArgs<T>] : [scopeOpts: PermArgs<T>]
): Permission<T> {
	// the generic construction can't be checked against the distributive union, but each concrete instantiation is sound
	return {
		type,
		scope: PERMISSION_DEFINITION[type].scope,
		args: scopeOpts ?? (undefined as PermArgs<T>),
	} as Permission<T>
}

export function tracedPerm<T extends PermissionType>(
	type: T,
	roles: Role[],
	opts?: { negated?: boolean; negating?: boolean },
	scopeOpts?: PermArgs<T>,
) {
	return {
		// the rest-tuple signature on perm() can't be satisfied from a plain optional parameter; role expansion builds
		// its own args from the stored grant, so the requirement is already met by construction here
		...(perm as (type: T, scopeOpts?: PermArgs<T>) => Permission<T>)(type, scopeOpts),
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
		let matched = false
		for (const permToCompare of perms) {
			if (arePermsEqual(permToAdd, permToCompare)) {
				permToCompare.allowedByRoles = Arr.union(permToCompare.allowedByRoles, permToAdd.allowedByRoles)
				matched = true
				break
			}
		}
		if (!matched) perms.push(permToAdd)
	}
}

export function permissionDenied(checkType: PermissionReq['check'], failures: string[]): PermissionDeniedResponse {
	return {
		code: 'err:permission-denied',
		checkType,
		failures,
	}
}

// failures are pre-rendered to human-readable strings (a permission type, or a callback's message) rather than
// carrying the structured Permission. That keeps the response shallow and non-generic, which matters: the richer
// shape overflowed oRPC's client type-transform and got silently dropped from complex handlers' return unions.
export type PermissionDeniedResponse = {
	code: 'err:permission-denied'
	checkType: PermissionReq['check']
	failures: string[]
}

export type PermitCheckerCallback = (perms: Permission[]) => string | undefined

// permissions whose args carry a serverId. The bare-string permit form matches on type alone, which for these would
// mean "holds this on *some* server" -- a sandbox-only grant would satisfy a check against a production server. So
// they are excluded from that form and must be passed as a built `perm(type, { serverId })`.
export type ServerAwarePermissionType = ServerPermissionType | 'squad-server:timeout-players' | 'queue:request-layers'

export type PermitChecker<T extends PermissionType = PermissionType> =
	| Permission<T>
	| PermitCheckerCallback
	| Exclude<T, ServerAwarePermissionType>

export type PermissionReq<T extends PermissionType = PermissionType> = { check: 'all' | 'any'; permits: PermitChecker<T>[] }
export function permReq<T extends PermissionType>(check: 'all' | 'any', permits: (PermitChecker<T> | undefined)[]): PermissionReq<T> {
	return { check, permits: permits.filter((v) => Boolean(v)) as PermitChecker<T>[] }
}

// how a failed static permit is described in a denial response
export function describePermit<T extends PermissionType>(permit: Permission<T> | T): string {
	return typeof permit === 'string' ? permit : permit.type
}

export function tryDenyPermissionsForRbacUser<T extends PermissionType>(
	user: UserWithRbac,
	req: PermitChecker<T> | PermitChecker<T>[] | PermissionReq<T>,
): PermissionDeniedResponse | null {
	const perms = fromTracedPermissions(user.perms)
	return tryDenyPermissions(perms, req)
}

export function tryDenyPermissions<T extends PermissionType>(
	_userPerms: Permission[],
	_req: PermitChecker<T> | PermitChecker<T>[] | PermissionReq<T>,
) {
	// just in case
	const userPerms = fromTracedPermissions(_userPerms as unknown as TracedPermission[])
	let failures: string[] = []

	let req: PermissionReq<T>
	if (typeof _req === 'object' && 'check' in _req) {
		req = _req
	} else {
		req = { check: 'all', permits: Array.isArray(_req) ? _req : [_req] }
	}

	for (const reqPerm of req.permits) {
		if (typeof reqPerm === 'function') {
			const errorMessage = reqPerm(userPerms)
			if (errorMessage) {
				failures.push(errorMessage)
			}
		} else {
			const hasPerm =
				typeof reqPerm === 'string' ? userPerms.some((userPerm) => userPerm.type === reqPerm) : permSubsumedBy(reqPerm, userPerms)
			if (!hasPerm) {
				failures.push(describePermit(reqPerm))
			}
		}
	}

	let failure: boolean
	if (req.check === 'all') {
		failure = failures.length > 0
	} else if (req.check === 'any') {
		failure = failures.length === req.permits.length
	} else {
		assertNever(req.check)
	}

	if (!failure) return null
	return { code: 'err:permission-denied' as const, failures, checkType: req.check }
}

// a permission-shaped value for the structural comparison/manipulation helpers. Looser than the discriminated
// `Permission` on purpose: Obj.selectProps/exclude collapse the union, so their results (and callers passing them)
// need a shape that no longer correlates type<->scope<->args.
export type PermLike = { type: PermissionType; scope: string; args?: unknown } & Partial<PermissionTrace>

export function arePermsEqual(perm1: PermLike, perm2: PermLike) {
	const a = Obj.selectProps(perm1, ['args', 'scope', 'type', 'negated', 'negating']) as Record<string, unknown>
	const b = Obj.selectProps(perm2, ['args', 'scope', 'type', 'negated', 'negating']) as Record<string, unknown>
	Obj.trimUndefined(a)
	Obj.trimUndefined(b)

	// defaults are false
	if (!a.negated) delete a.negated
	if (!b.negated) delete b.negated
	if (!a.negating) delete a.negating
	if (!b.negating) delete b.negating

	return Obj.deepEqual(a, b)
}

// matches on identity alone (type + scope + args). Unlike arePermsEqual this ignores negation state, which changes as
// permission simulation is applied and so can't be part of a perm's identity.
export function isSamePerm(perm1: PermLike, perm2: PermLike) {
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

// the effective max kick-timeout duration a set of perms grants on `serverId`: undefined = no grant at all,
// null = unlimited, number = max ms. Deliberately not routed through arePermsEqual: "up to N" is a
// comparator, not an equality match.
export function maxTimeoutDurationMs(perms: Permission[], serverId: string | null): number | null | undefined {
	let max: number | undefined = undefined
	for (const p of perms) {
		if (p.type !== 'squad-server:timeout-players') continue
		const args = p.args
		if (!args || !grantAppliesTo(args, serverId)) continue
		if (args.maxDurationMs === null) return null
		if (max === undefined || args.maxDurationMs > max) max = args.maxDurationMs
	}
	return max
}

// the effective max concurrent layer requests a set of perms grants on `serverId`: undefined = no grant at all,
// null = unlimited, number = max items. A comparator like maxTimeoutDurationMs, not an equality match.
export function maxLayerRequests(perms: Permission[], serverId: string | null): number | null | undefined {
	let max: number | undefined = undefined
	for (const p of perms) {
		if (p.type !== 'queue:request-layers') continue
		const args = p.args
		if (!args || !grantAppliesTo(args, serverId)) continue
		if (args.maxQueued === null) return null
		if (max === undefined || args.maxQueued > max) max = args.maxQueued
	}
	return max
}

// Whether the dashboard for `serverId` is visible. Any server-scoped permission implies it: you cannot kick a player
// or edit a queue you are not allowed to look at, so requiring both would just be a grant every role has to remember.
// squad-server:view on its own is therefore the read-only grant.
export function canViewServer(perms: Permission[], serverId: string): boolean {
	return perms.some((p) => isServerScoped(p.type) && serverIdMatches(p.args as { serverId: string | null } | undefined, serverId))
}

// "holds this on at least one server", for the two client affordances that have no server in scope: the layer
// table's force-select toggle and the row selectability the query stream marks. Deliberately loose, and
// deliberately not spellable as a bare-string permit -- the authoritative check is the server-scoped one the
// queue handler runs (see layer-queue.server dispatchOp), which rejects the write regardless of what the UI offered.
export function hasPermOnAnyServer(perms: Permission[], type: ServerPermissionType): boolean {
	return perms.some((p) => p.type === type)
}

// "holds any layer-request grant on this server". A comparator perm, so it can't ride the equality-matched
// permission path (and its bare-string form is barred, which is the point: it would ignore the server).
export function anyLayerRequestGrant(serverId: string): PermitCheckerCallback {
	return (perms) => {
		if (maxLayerRequests(perms, serverId) !== undefined) return
		return `queue:request-layers on ${serverId}`
	}
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

function serverIdMatches(args: { serverId: string | null } | undefined, serverId: string): boolean {
	// missing args = a legacy/defensive grant; treat as unrestricted
	return !args || args.serverId === null || args.serverId === serverId
}

// Does a grant apply to the server being asked about? A null `serverId` asks for the grant that holds on *every*
// server, which only an unrestricted grant satisfies; a concrete one is also satisfied by an unrestricted grant.
function grantAppliesTo(args: { serverId: string | null } | undefined, serverId: string | null): boolean {
	if (serverId === null) return (args?.serverId ?? null) === null
	return serverIdMatches(args, serverId)
}

// Every plain server-scoped permission subsumes the same way, so this is one branch rather than a case per
// permission: adding a server-scoped permission needs no change here.
function serverScopedSubsumedBy(perm: Permission, perms: Permission[]): boolean {
	const args = perm.args as { serverId: string | null } | undefined
	return perms.some(
		(p) => p.type === perm.type && grantAppliesTo(p.args as { serverId: string | null } | undefined, args?.serverId ?? null),
	)
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
		const args = p.args
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
		const args = p.args
		if (!serverIdMatches(args, serverId)) continue
		pathSets.push(args ? args.paths : null)
	}
	return collectWriteAccess(pathSets)
}

export function canWriteSensitiveServerSettings(perms: Permission[], serverId: string): boolean {
	return perms.some((p) => p.type === 'server-settings:write-sensitive' && serverIdMatches(p.args, serverId))
}

// creating a server means supplying its connection details, which is gated by write-sensitive. A grant scoped to a
// specific server id can't authorize a brand-new id, so creation requires an unscoped (all-servers) write-sensitive grant.
export function canCreateServers(perms: Permission[]): boolean {
	return perms.some((p) => p.type === 'server-settings:write-sensitive' && (p.args?.serverId ?? null) === null)
}

export function canReadServerSettings(perms: Permission[], serverId: string): boolean {
	if (perms.some((p) => p.type === 'server-settings:read' && serverIdMatches(p.args, serverId))) {
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
			const args = perm.args
			const max = maxTimeoutDurationMs(perms, args?.serverId ?? null)
			if (max === undefined) return false
			if (max === null) return true
			if (!args || args.maxDurationMs === null) return false
			return args.maxDurationMs <= max
		}
		case 'queue:request-layers': {
			const args = perm.args
			const max = maxLayerRequests(perms, args?.serverId ?? null)
			if (max === undefined) return false
			if (max === null) return true
			if (!args || args.maxQueued === null) return false
			return args.maxQueued <= max
		}
		case 'global-settings:write': {
			const args = perm.args
			return pathsCoveredBy(args ? args.paths : null, globalSettingsWriteAccess(perms))
		}
		case 'server-settings:read':
		case 'server-settings:write-sensitive': {
			const serverId = perm.args?.serverId ?? null
			// an all-servers grant can only be covered by another all-servers grant
			if (serverId === null) {
				return perms.some((p) => p.type === perm.type && (p.args?.serverId ?? null) === null)
			}
			return perm.type === 'server-settings:read'
				? canReadServerSettings(perms, serverId)
				: canWriteSensitiveServerSettings(perms, serverId)
		}
		case 'server-settings:write': {
			const args = perm.args
			const serverId = args?.serverId ?? null
			if (serverId === null) {
				const allServerPathSets = perms.flatMap((p) => {
					if (p.type !== 'server-settings:write') return []
					const pArgs = p.args
					return (pArgs?.serverId ?? null) === null ? [pArgs?.paths ?? null] : []
				})
				return pathsCoveredBy(args ? args.paths : null, collectWriteAccess(allServerPathSets))
			}
			return pathsCoveredBy(args ? args.paths : null, serverSettingsWriteAccess(perms, serverId))
		}
		default:
			if (isServerScoped(perm.type)) return serverScopedSubsumedBy(perm, perms)
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
