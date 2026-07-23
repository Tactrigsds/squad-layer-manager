import * as Schema from '$root/drizzle/schema.ts'
import { objKeys } from '@/lib/object'
import type * as CS from '@/models/context-shared'
import * as ATTRS from '@/models/otel-attrs'
import * as SETTINGS from '@/models/settings.models'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import { initModule } from '@/server/logger'
import * as AdminList from '@/systems/adminlist.server'
import * as User from '@/systems/users.server'

import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import * as Env from '@/server/env'

import { getOrpcBase } from '@/server/orpc-base'
import * as Discord from '@/systems/discord.server'

import { IsolatedSubject } from '@/lib/isolated-subject'
import { assertNever } from '@/lib/type-guards'
import * as E from 'drizzle-orm'
import { unionAll } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

// the role type attributed to permissions granted by the env-level SUPER_USERS/SUPER_ROLES bootstrap
const SUPER_ROLE: RBAC.Role = { type: 'super' }

const envBuilder = Env.getEnvBuilder({ ...Env.groups.rbac, ...Env.groups.discord })
let ENV!: ReturnType<typeof envBuilder>

type RbacCache = {
	// primarily discord sourced roles, with secondary lookup againste linked steam accounts
	users: Map<USR.UserId, Promise<RBAC.UserRbac>>

	// primary steam/eosid sourced roles, with inverse lookup as above to resolve discord accounts
	players: Map<SM.PlayerId, Promise<RBAC.UserRbac>>
}
let cache!: RbacCache
// discordId -> the player ids cached under it, so evictUser can drop a user's linked player entries without a db hit
let userPlayerIndex = new Map<bigint, Set<SM.PlayerId>>()

// emitted whenever cached perms are invalidated, so the client-facing layer (users.server) can push a refetch to the
// affected session(s). 'all' = everyone (settings/adminlist/discord-role change); 'user' = one discord identity.
export type RbacInvalidation = { scope: 'all' } | { scope: 'user'; discordId: bigint }
export const invalidation$ = new IsolatedSubject<RbacInvalidation>()
let sourceSubs: { unsubscribe(): void }[] = []

type RoleConfig = NonNullable<SETTINGS.RbacSettings['roles'][string]>

let userDefinedRoles: RBAC.Role[] = []
let userDefinedPermissionExpressions: Record<string, RBAC.RolePermissionExpression[]> = {}
let roleAssignments: RBAC.RoleAssignment[] = []
// role -> max kick-timeout duration in ms (roles[role].maxTimeout; HumanTime decodes to ms)
let roleMaxTimeouts: Record<string, number> = {}
// role -> max concurrent layer requests (roles[role].maxLayerRequests)
let roleMaxLayerRequests: Record<string, number> = {}
// restricted settings grants (roles[role].globalSettingsGrants / .serverSettingsGrants)
let roleGlobalSettingsGrants: Record<string, RoleConfig['globalSettingsGrants']> = {}
let roleServerSettingsGrants: Record<string, RoleConfig['serverSettingsGrants']> = {}
let superUserIds = new Set<bigint>()
let superRoleIds = new Set<bigint>()

export function setup() {
	ENV = envBuilder()
	cache = {
		users: new Map(),
		players: new Map(),
	}
	userPlayerIndex = new Map()
	// role config comes from admin-editable global settings and is pushed in via applyRbacSettings() once settings load;
	// start from an empty set (not the schema's preset default) so we never reference an unset binding
	applyRbacSettings(SETTINGS.RbacSettingsSchema.parse({ roles: {} }))
	superUserIds = new Set(ENV.SUPER_USERS)
	superRoleIds = new Set(ENV.SUPER_ROLES)
}

// wires the invalidation sources. Separate from setup() because AdminList.changed$ registers a long-lived observer
// whose first fetch reads settings, so it must run only after adminlist + settings are set up (see main.ts order).
export function wireInvalidationSources() {
	// admin-list content changes affect admin-derived roles globally; discord role definitions affect every holder;
	// a single member's roles/membership change is targeted to that user
	for (const sub of sourceSubs) sub.unsubscribe()
	sourceSubs = [
		AdminList.changed$.subscribe(() => invalidateAll()),
		Discord.guildRbacEvents$.subscribe((e) => e.type === 'roles' ? invalidateAll() : invalidateUser(e.discordId)),
	]
}

// clears every cached perm set (settings/adminlist/discord-role change) and notifies clients to refetch
export function invalidateAll() {
	cache.users.clear()
	cache.players.clear()
	userPlayerIndex.clear()
	invalidation$.next({ scope: 'all' })
}

// drops one discord identity's cached perms (and its linked player entries) and notifies that user's session(s)
export function invalidateUser(discordId: bigint) {
	cache.users.delete(discordId)
	const players = userPlayerIndex.get(discordId)
	if (players) {
		for (const playerId of players) cache.players.delete(playerId)
		userPlayerIndex.delete(discordId)
	}
	invalidation$.next({ scope: 'user', discordId })
}

// called by settings.server whenever global settings are (re)loaded so role/permission changes take effect without a restart
export function applyRbacSettings(rbac: SETTINGS.RbacSettings) {
	userDefinedPermissionExpressions = {}
	userDefinedRoles = []
	roleMaxTimeouts = {}
	roleMaxLayerRequests = {}
	roleGlobalSettingsGrants = {}
	roleServerSettingsGrants = {}
	roleAssignments = []

	for (const roleType of objKeys(rbac.roles)) {
		const cfg = rbac.roles[roleType]
		userDefinedRoles.push(RBAC.userDefinedRole(roleType))
		userDefinedPermissionExpressions[roleType] = cfg.permissions
		if (cfg.maxTimeout !== undefined) roleMaxTimeouts[roleType] = cfg.maxTimeout
		if (cfg.maxLayerRequests !== undefined) roleMaxLayerRequests[roleType] = cfg.maxLayerRequests
		if (cfg.globalSettingsGrants.length > 0) roleGlobalSettingsGrants[roleType] = cfg.globalSettingsGrants
		if (cfg.serverSettingsGrants.length > 0) roleServerSettingsGrants[roleType] = cfg.serverSettingsGrants

		for (const discordRoleId of cfg.assignments.discordRoleIds) {
			roleAssignments.push({ type: 'discord-role', role: RBAC.userDefinedRole(roleType), discordRoleId: BigInt(discordRoleId) })
		}
		for (const userId of cfg.assignments.discordUserIds) {
			roleAssignments.push({ type: 'discord-user', role: RBAC.userDefinedRole(roleType), discordUserId: BigInt(userId) })
		}
		if (cfg.assignments.everyMember) {
			roleAssignments.push({ type: 'discord-server-member', role: RBAC.userDefinedRole(roleType) })
		}
		for (const group of cfg.assignments.adminListGroups) {
			roleAssignments.push({ type: 'admin-list-group', groupId: group, role: RBAC.userDefinedRole(roleType) })
		}
		if (cfg.assignments.includeIngameAdmins) {
			roleAssignments.push({ type: 'ingame-admin', role: RBAC.userDefinedRole(roleType) })
		}
	}

	// TODO add preflight checks to make sure the remote references in role assignments are valid
}

// superUsers/superRoles from the deploy-time config always receive every permission -- the anti-lockout bootstrap
async function fetchIsSuperUser(userId: bigint): Promise<boolean> {
	if (superUserIds.has(userId)) return true
	if (superRoleIds.size === 0) return false
	const memberRes = await Discord.fetchMember(ENV.DISCORD_HOME_GUILD_ID, userId)
	if (memberRes.code !== 'ok') return false
	for (const roleId of superRoleIds) {
		if (memberRes.member.roles.cache.has(roleId.toString())) return true
	}
	return false
}

// TODO error visibility

const module = initModule('rbac')
const orpcBase = getOrpcBase(module)

export const getRbacForDiscordUser = C.spanOp(
	'getRbacForDiscordUser',
	{ module, levels: { event: 'trace' }, attrs: (ctx: C.UserId) => ({ [ATTRS.User.ID]: String(ctx.user.discordId) }) },
	async (ctx: C.Db & C.UserId & CS.AbortSignal) => {
		const discordUserId = ctx.user.discordId
		const cached = cache.users.get(discordUserId)
		if (cached) return await cached
		const playerIds = await User.findUserPlayerIds(ctx, discordUserId)

		const userRbacPromise = (async () => {
			const ingameRolesPromise = (async () => {
				return resolveAdminListAssignments(ctx, playerIds)
			})()
			const discordRolesPromise = resolveDiscordAssignments(ctx, discordUserId)
			const baseRoles = RBAC.Role.merge(await ingameRolesPromise, await discordRolesPromise)
			const inferredRoles = await resolveInferredRoleAssignments(ctx, baseRoles, discordUserId)
			const roles = RBAC.Role.merge(baseRoles, inferredRoles)
			const perms = permsFromRoles(roles)
			if (discordUserId) {
				const superUserPerms = await resolveSuperUserPerms(discordUserId)
				RBAC.addTracedPerms(perms, ...superUserPerms)
			}
			return { roles, perms }
		})()

		cache.users.set(discordUserId, userRbacPromise)
		const linkedPlayerIds = new Set<SM.PlayerId>()
		for (const ids of playerIds) {
			const playerId = SM.PlayerIds.getPlayerId(ids)
			cache.players.set(playerId, userRbacPromise)
			linkedPlayerIds.add(playerId)
		}
		userPlayerIndex.set(discordUserId, linkedPlayerIds)
		return await userRbacPromise
	},
)

export const getRbacForPlayer = C.spanOp(
	'getRbacForPlayer',
	{ module },
	async (ctx: C.Db & C.PlayerIds<'eos'> & CS.AbortSignal) => {
		const ids = ctx.player.ids
		const playerId = SM.PlayerIds.getPlayerId(ids)
		const cached = cache.players.get(playerId)
		if (cached) return await cached
		let steamId: bigint | undefined
		if (ids.steam === undefined) {
			const [row] = await ctx.db().select({ steamId: Schema.players.steamId }).from(Schema.players).where(
				E.eq(Schema.players.eosId, ids.eos),
			)
			if (row && row.steamId) steamId = row.steamId
		} else {
			steamId = BigInt(ids.steam)
		}

		let discordId: bigint | undefined
		if (steamId) {
			discordId = await User.findDiscordIdBySteam64Id(ctx, steamId)
		}

		const rbacPromise = (async () => {
			let adminListAssignmentsPromise: Promise<RBAC.Role[]>
			if (steamId) {
				adminListAssignmentsPromise = resolveAdminListAssignments(ctx, [{ ...ids, steam: steamId.toString() }])
			} else {
				adminListAssignmentsPromise = Promise.resolve([])
			}
			const discordUserRolesPromise = (async () => {
				if (!discordId) return []
				return await resolveDiscordAssignments(ctx, discordId)
			})()

			const baseRoles = RBAC.Role.merge(await adminListAssignmentsPromise, await discordUserRolesPromise)
			const inferredRoles = await resolveInferredRoleAssignments(ctx, baseRoles, discordId)
			const roles = RBAC.Role.merge(baseRoles, inferredRoles)
			const perms = permsFromRoles(roles)
			if (discordId) {
				const superUserPerms = await resolveSuperUserPerms(discordId)
				RBAC.addTracedPerms(perms, ...superUserPerms)
			}

			return { roles, perms }
		})()

		cache.players.set(playerId, rbacPromise)
		if (discordId) {
			cache.users.set(discordId, rbacPromise)
			let linked = userPlayerIndex.get(discordId)
			if (!linked) {
				linked = new Set()
				userPlayerIndex.set(discordId, linked)
			}
			linked.add(playerId)
		}
		return await rbacPromise
	},
)

async function resolveAdminListAssignments(ctx: C.Db & CS.AbortSignal, allIds: SM.PlayerIds.IdQuery<'steam'>[]) {
	const adminList = await AdminList.adminList.get(ctx)
	const roles: RBAC.Role[] = []
	for (const assignment of roleAssignments) {
		if (assignment.type === 'admin-list-group') {
			for (const ids of allIds) {
				const groups = SM.AdminList.getPlayerGroups(adminList, ids)
				if (groups?.has(assignment.groupId)) {
					RBAC.Role.push(roles, assignment.role)
				}
			}
		}
		if (assignment.type === 'ingame-admin') {
			for (const ids of allIds) {
				const isAdmin = SM.AdminList.getIsAdmin(adminList, ids)
				if (isAdmin) {
					RBAC.Role.push(roles, assignment.role)
				}
			}
		}
	}
	return roles
}

async function resolveDiscordAssignments(ctx: CS.Ctx, userId: bigint) {
	const roles: RBAC.Role[] = []
	const memberRes = await Discord.fetchMember(ENV.DISCORD_HOME_GUILD_ID, userId)
	for (const assignment of roleAssignments) {
		if (assignment.type === 'discord-user' && assignment.discordUserId === userId) {
			RBAC.Role.push(roles, assignment.role)
		}
		if (assignment.type === 'discord-server-member') {
			if (memberRes.code === 'ok') {
				RBAC.Role.push(roles, assignment.role)
			}
		}
		if (assignment.type === 'discord-role') {
			if (memberRes.code === 'ok') {
				const member = memberRes.member
				if (member.roles.cache.has(assignment.discordRoleId.toString())) {
					RBAC.Role.push(roles, assignment.role)
				}
			}
		}
	}
	return roles
}

async function resolveSuperUserPerms(userId: bigint) {
	const isSuperUser = await fetchIsSuperUser(userId)
	const perms: RBAC.TracedPermission[] = []
	if (
		!isSuperUser
	) return []
	for (const permType of RBAC.ROLE_GRANTABLE_PERMISSION_TYPE.options) {
		RBAC.addTracedPerms(perms, RBAC.tracedPerm(permType, [SUPER_ROLE], { negated: false }, RBAC.unrestrictedRoleGrantArgs(permType)))
	}
	RBAC.addTracedPerms(
		perms,
		RBAC.tracedPerm('squad-server:timeout-players', [SUPER_ROLE], { negated: false }, { maxDurationMs: null }),
	)
	RBAC.addTracedPerms(
		perms,
		RBAC.tracedPerm('queue:request-layers', [SUPER_ROLE], { negated: false }, { maxQueued: null }),
	)
	return perms
}

async function resolveInferredRoleAssignments(ctx: C.Db, baseRoles: RBAC.Role[], discordUserId?: bigint): Promise<RBAC.Role[]> {
	const db = ctx.db()
	type Source = 'owner' | 'user-contributor' | 'role-contributor'
	const subqueries: any[] = []
	if (discordUserId) {
		subqueries.push(
			db
				.select({
					source: E.sql<Source>`'owner'`.as('source'),
					filterId: Schema.filters.id,
					roleId: E.sql<string | null>`null`.as('roleId'),
				})
				.from(Schema.filters)
				.where(E.eq(Schema.filters.owner, discordUserId)),
		)
		subqueries.push(
			db
				.select({
					source: E.sql<Source>`'user-contributor'`.as('source'),
					filterId: Schema.filterUserContributors.filterId,
					roleId: E.sql<string | null>`null`.as('roleId'),
				})
				.from(Schema.filterUserContributors)
				.where(E.eq(Schema.filterUserContributors.userId, discordUserId)),
		)
	}
	if (baseRoles.length > 0) {
		subqueries.push(
			db
				.select({
					source: E.sql<Source>`'role-contributor'`.as('source'),
					filterId: Schema.filterRoleContributors.filterId,
					roleId: E.sql<string | null>`${Schema.filterRoleContributors.roleId}`.as('roleId'),
				})
				.from(Schema.filterRoleContributors)
				.where(E.inArray(Schema.filterRoleContributors.roleId, baseRoles.map(r => r.type))),
		)
	}
	if (subqueries.length === 0) return []
	// @ts-expect-error idc
	const rows = await unionAll(...subqueries)

	const roles: RBAC.Role[] = []
	for (const row of rows) {
		switch (row.source) {
			case 'owner':
				RBAC.Role.push(roles, {
					type: 'filter-owner',
					filterId: row.filterId as any as string,
				})
				break
			case 'user-contributor':
				RBAC.Role.push(roles, {
					type: 'filter-user-contributor',
					filterId: row.filterId as any as string,
				})
				break
			case 'role-contributor':
				RBAC.Role.push(roles, {
					type: 'filter-role-contributor',
					filterId: row.filterId as any as string,
				})
				break
		}
	}
	return roles
}

// the permissions a set of roles grants purely from their rbac settings config. Negations only apply within the given
// set, which is what lets a single role be evaluated in isolation (see getSimulatableRoles).
function permsFromRoles(roles: RBAC.Role[]): RBAC.TracedPermission[] {
	const perms: RBAC.TracedPermission[] = []
	const allNegatingPerms: Set<RBAC.RoleGrantablePermissionType> = new Set()

	for (const role of roles) {
		for (const permExpr of userDefinedPermissionExpressions[role.type] ?? []) {
			const perm = RBAC.parseNegatingPermissionType(permExpr)
			if (!perm) continue
			allNegatingPerms.add(perm)
			perms.push(RBAC.tracedPerm(perm, [role], { negated: true, negating: true }, RBAC.unrestrictedRoleGrantArgs(perm)))
		}
	}

	const isNegated = (perm: RBAC.PermissionType) => allNegatingPerms.has(perm as RBAC.RoleGrantablePermissionType)

	for (const role of roles) {
		if (RBAC.isInferredRoleType(role)) {
			if (role.type === 'filter-owner') {
				RBAC.addTracedPerms(
					perms,
					RBAC.tracedPerm('filters:manage', [role], {}, { filterId: role.filterId }),
					RBAC.tracedPerm('filters:write', [role], {}, { filterId: role.filterId }),
				)
			} else if (role.type === 'filter-role-contributor' || role.type === 'filter-user-contributor') {
				RBAC.addTracedPerms(
					perms,
					RBAC.tracedPerm('filters:write', [role], {}, { filterId: role.filterId }),
				)
			} else {
				assertNever(role)
			}
			continue
		}
		if ((userDefinedPermissionExpressions[role.type] ?? []).includes('*')) {
			for (const permType of RBAC.ROLE_GRANTABLE_PERMISSION_TYPE.options) {
				perms.push(
					RBAC.tracedPerm(permType, [role], { negated: allNegatingPerms.has(permType) }, RBAC.unrestrictedRoleGrantArgs(permType)),
				)
			}
		}
		for (const permExpr of userDefinedPermissionExpressions[role.type] ?? []) {
			if (!RBAC.isRoleGrantablePermissionType(permExpr)) continue
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm(permExpr, [role], { negated: allNegatingPerms.has(permExpr) }, RBAC.unrestrictedRoleGrantArgs(permExpr)),
			)
		}
		if (roleMaxTimeouts[role.type] !== undefined) {
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('squad-server:timeout-players', [role], {}, { maxDurationMs: roleMaxTimeouts[role.type] }),
			)
		}
		if (roleMaxLayerRequests[role.type] !== undefined) {
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('queue:request-layers', [role], {}, { maxQueued: roleMaxLayerRequests[role.type] }),
			)
		}
		// restricted settings grants; a matching negation in any role's expressions wins over these too
		const globalPaths = roleGlobalSettingsGrants[role.type]
		if (globalPaths && globalPaths.length > 0) {
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('global-settings:write', [role], { negated: isNegated('global-settings:write') }, { paths: [...globalPaths] }),
			)
		}
		for (const grant of roleServerSettingsGrants[role.type] ?? []) {
			const serverIds: (string | null)[] = grant.serverIds.length > 0 ? grant.serverIds : [null]
			for (const serverId of serverIds) {
				if (grant.access === 'read') {
					RBAC.addTracedPerms(
						perms,
						RBAC.tracedPerm('server-settings:read', [role], { negated: isNegated('server-settings:read') }, { serverId }),
					)
				} else if (grant.access === 'write') {
					RBAC.addTracedPerms(
						perms,
						RBAC.tracedPerm('server-settings:write', [role], { negated: isNegated('server-settings:write') }, {
							serverId,
							paths: grant.paths.length > 0 ? [...grant.paths] : null,
						}),
					)
				} else {
					RBAC.addTracedPerms(
						perms,
						RBAC.tracedPerm('server-settings:write-sensitive', [role], { negated: isNegated('server-settings:write-sensitive') }, {
							serverId,
						}),
					)
				}
			}
		}
	}
	return perms
}

// TODO we should implement a version of this which only loads the relevant perms for the user
export async function tryDenyPermissionsForUser<T extends RBAC.PermissionType>(
	ctx: C.Db & C.UserId & CS.AbortSignal,
	reqOrPerms: RBAC.PermitChecker<T> | RBAC.PermitChecker<T>[] | RBAC.PermissionReq<T>,
) {
	const rbac = await getRbacForDiscordUser(ctx)
	const perms = RBAC.fromTracedPermissions(rbac.perms)

	const req: RBAC.PermissionReq<T> = typeof reqOrPerms === 'object' && 'check' in reqOrPerms
		? reqOrPerms
		: {
			check: 'all',
			permits: Array.isArray(reqOrPerms) ? reqOrPerms : [reqOrPerms],
		}

	return RBAC.tryDenyPermissions(perms, req)
}

export async function tryDenyPermissionsForPlayer<T extends RBAC.PermissionType>(
	ctx: C.Db & C.PlayerIds & CS.AbortSignal,
	reqOrPerms: RBAC.PermitChecker<T> | RBAC.PermitChecker<T>[] | RBAC.PermissionReq<T>,
) {
	const rbac = await getRbacForPlayer(ctx)
	const perms = RBAC.fromTracedPermissions(rbac.perms)
	const req: RBAC.PermissionReq<T> = typeof reqOrPerms === 'object' && 'check' in reqOrPerms
		? reqOrPerms
		: {
			check: 'all',
			permits: Array.isArray(reqOrPerms) ? reqOrPerms : [reqOrPerms],
		}

	return RBAC.tryDenyPermissions(perms, req)
}

// for the aggregate (non-equality) checks: settings access, timeouts
export async function getUserPermissions(ctx: C.Db & C.UserId & CS.AbortSignal): Promise<RBAC.Permission[]> {
	return RBAC.fromTracedPermissions((await getRbacForDiscordUser(ctx)).perms)
}

// "up to N concurrent items" layer-request checks bypass the equality-matched permission path
// (see RBAC.maxLayerRequests): undefined = no grant, null = unlimited, number = max concurrent items
export async function getMaxLayerRequestsForUser(ctx: C.Db & CS.AbortSignal & C.UserId): Promise<number | null | undefined> {
	const perms = RBAC.fromTracedPermissions((await getRbacForDiscordUser(ctx)).perms)
	return RBAC.maxLayerRequests(perms)
}
export async function getMaxLayerRequestsForPlayer(ctx: C.Db & CS.AbortSignal & C.PlayerIds): Promise<number | null | undefined> {
	const perms = RBAC.fromTracedPermissions((await getRbacForPlayer(ctx)).perms)
	return RBAC.maxLayerRequests(perms)
}

export const orpcRouter = {
	getUserDefinedRoles: orpcBase.handler(() => {
		return userDefinedRoles
	}),

	// the caller's own roles. Not derivable from their permissions' traces: a role granting nothing appears in no trace,
	// but is still a role they hold
	getMyRoles: orpcBase.handler(async ({ context: ctx }) => {
		const { roles } = await getRbacForDiscordUser(ctx)
		return roles
	}),

	// roles the caller doesn't hold but whose permissions they already hold anyway, so the permissions dialog can offer
	// them for simulation. Returning the role's traced perms lets the client attribute its own perms to the simulated
	// role without granting anything: a role is only offered when every permission it grants is subsumed by the caller's.
	getSimulatableRoles: orpcBase.handler(async ({ context: ctx }) => {
		const rbac = await getRbacForDiscordUser(ctx)
		const userPerms = RBAC.fromTracedPermissions(rbac.perms)
		const heldRoles = new Set(rbac.roles.map((r) => r.type))

		const simulatable: { role: RBAC.Role; perms: RBAC.TracedPermission[] }[] = []
		for (const role of userDefinedRoles) {
			if (heldRoles.has(role.type)) continue
			const perms = permsFromRoles([role])
			// a role granting nothing (or only negations) is vacuously subsumed, and simulating it is still meaningful:
			// its negations take access away
			const granted = RBAC.fromTracedPermissions(perms)
			if (!granted.every((p) => RBAC.permSubsumedBy(p, userPerms))) continue
			simulatable.push({ role, perms })
		}
		return simulatable
	}),

	// the env-configured SUPER_USERS/SUPER_ROLES bootstrap, surfaced read-only in the settings rbac section.
	// ids as strings so the snowflakes survive JSON
	getSuperConfig: orpcBase.handler(async ({ context: ctx }) => {
		const denyRes = await tryDenyPermissionsForUser(ctx, SETTINGS.Grants.globalSettingsRead())
		if (denyRes) return denyRes
		return {
			code: 'ok' as const,
			superUsers: [...superUserIds].map(String),
			superRoles: [...superRoleIds].map(String),
		}
	}),

	// guild role/member lookups powering the settings role-assignment pickers; gated behind global-settings editing
	// since they surface guild role names and member identities
	listGuildRoles: orpcBase.handler(async ({ context: ctx }) => {
		const denyRes = await tryDenyPermissionsForUser(ctx, SETTINGS.Grants.globalSettingsRead())
		if (denyRes) return denyRes
		return Discord.listGuildRolesDetailed()
	}),

	searchGuildMembers: orpcBase.input(z.object({ query: z.string() })).handler(async ({ context: ctx, input }) => {
		const denyRes = await tryDenyPermissionsForUser(ctx, SETTINGS.Grants.globalSettingsRead())
		if (denyRes) return denyRes
		const query = input.query.trim()
		if (query.length === 0) return { code: 'ok' as const, members: [] }
		return Discord.searchGuildMembers(query)
	}),

	// the admin-list groups currently defined across the configured sources, for the role-assignment adminListGroups picker
	listAdminListGroups: orpcBase.handler(async ({ context: ctx }) => {
		const denyRes = await tryDenyPermissionsForUser(ctx, SETTINGS.Grants.globalSettingsRead())
		if (denyRes) return denyRes
		const list = await AdminList.adminList.get(ctx)
		return { code: 'ok' as const, groups: [...list.groups.keys()].sort() }
	}),
}
