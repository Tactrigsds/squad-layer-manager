import * as E from 'drizzle-orm'
import { unionAll } from 'drizzle-orm/sqlite-core'

import * as Schema from '$root/drizzle/schema.ts'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
import type * as CS from '@/models/context-shared'
import * as ATTRS from '@/models/otel-attrs'
import * as PA from '@/models/procedure-access.models'
import * as SETTINGS from '@/models/settings.models'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as Env from '@/server/env'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AdminList from '@/systems/adminlist.server'
import * as Discord from '@/systems/discord.server'
import * as User from '@/systems/users.server'

// the role type attributed to permissions granted by the env-level SUPER_USERS/SUPER_ROLES bootstrap
const SUPER_ROLE: RBAC.Role = { type: 'super' }

// attributed to the implicit full-control grant a scoped server's owner holds on it (resolveScopedOwnerPerms)
const SCOPED_OWNER_ROLE: RBAC.Role = { type: 'scoped-server-owner' }

// Which server ids are scoped, and to whom. Pushed from settings.server via applyScopedServers whenever the registry
// changes: rbac.server cannot import settings.server (settings.server imports this), so the data flows the other way,
// exactly like applyRbacSettings. The matcher reads scopedServerIds to keep wildcard grants off scoped servers;
// resolveScopedOwnerPerms reads scopedServersByOwner to hand the owner an explicit grant that does reach theirs.
let scopedServers: ReadonlyMap<string, bigint | null> = new Map()
let scopedServerIds: ReadonlySet<string> = new Set()
let scopedServersByOwner = new Map<bigint, string[]>()

const envBuilder = Env.getEnvBuilder({ ...Env.groups.demo, ...Env.groups.rbac, ...Env.groups.discord })
let ENV!: ReturnType<typeof envBuilder>

type RbacCache = {
	// primarily discord sourced roles, with secondary lookup againste linked steam accounts
	users: Map<USR.UserId, Promise<RBAC.UserRbac>>

	// primary steam/eosid sourced roles, with inverse lookup as above to resolve discord accounts
	// keyed by playerCacheKey(serverId, playerId): which admin lists speak for a player is a per-server question
	players: Map<string, Promise<RBAC.UserRbac>>
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

// What an rbac config says about its roles, indexed for permsFromRoles and assignment resolution. Built from the live
// config, or from a proposed one to see what a save would grant. Maps rather than objects, since role ids come from
// settings and an object's lookup falls through to its prototype.
type RoleIndex = {
	roles: RBAC.Role[]
	assignments: RBAC.RoleAssignment[]
	permissionExpressions: Map<string, RBAC.RolePermissionExpression[]>
	// role -> max kick-timeout duration in ms (roles[role].maxTimeout; HumanTime decodes to ms)
	maxTimeouts: Map<string, number>
	// role -> max concurrent layer requests (roles[role].maxLayerRequests)
	maxLayerRequests: Map<string, number>
	// restricted settings grants (roles[role].globalSettingsGrants / .serverSettingsGrants)
	globalSettingsGrants: Map<string, RoleConfig['globalSettingsGrants']>
	serverSettingsGrants: Map<string, RoleConfig['serverSettingsGrants']>
	// per-server grants of the server-scoped permissions (roles[role].serverGrants)
	serverGrants: Map<string, RoleConfig['serverGrants']>
	pluginGrants: Map<string, RoleConfig['pluginGrants']>
}
let roleIndex!: RoleIndex
let superUserIds = new Set<bigint>()
let superRoleIds = new Set<bigint>()

export function setup() {
	ENV = envBuilder()
	cache = {
		users: new Map(),
		players: new Map(),
	}
	userPlayerIndex = new Map()
	scopedServers = new Map()
	scopedServerIds = new Set()
	scopedServersByOwner = new Map()
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
		Discord.guildRbacEvents$.subscribe((e) => {
			if (e.type === 'member') invalidateUser(e.discordId)
			else if (e.type === 'role-deleted') {
				if (isDiscordRoleReferenced(e.roleId)) invalidateAll()
			} else assertNever(e)
		}),
	]
}

function isDiscordRoleReferenced(roleId: bigint) {
	if (superRoleIds.has(roleId)) return true
	return roleIndex.assignments.some((a) => a.type === 'discord-role' && a.discordRoleId === roleId)
}

// Every notification re-runs each affected client's guarded stream checks and refetches its users and perms, and
// sources arrive in bursts (several members' roles changing at once, an admin list refresh beside a settings save).
// The first notification goes out at once. The rest within the window are merged and sent when it closes, one 'all'
// subsuming every user.
const NOTIFY_WINDOW_MS = 250
let heldNotifications: { all: boolean; users: Set<bigint> } | null = null

function notify(e: RbacInvalidation) {
	if (heldNotifications) {
		if (e.scope === 'all') heldNotifications.all = true
		else heldNotifications.users.add(e.discordId)
		return
	}
	invalidation$.next(e)
	heldNotifications = { all: false, users: new Set() }
	setTimeout(flushNotifications, NOTIFY_WINDOW_MS)
}

function flushNotifications() {
	const held = heldNotifications!
	if (!held.all && held.users.size === 0) {
		heldNotifications = null
		return
	}
	// a burst still going gets one merged notification per window rather than one per event
	heldNotifications = { all: false, users: new Set() }
	setTimeout(flushNotifications, NOTIFY_WINDOW_MS)
	if (held.all) invalidation$.next({ scope: 'all' })
	else for (const discordId of held.users) invalidation$.next({ scope: 'user', discordId })
}

// NUL rather than ':' -- a server id may hold most things, but not a NUL byte, so the split is unambiguous
function playerCacheKey(serverId: string, playerId: SM.PlayerId): string {
	return `${serverId}\0${playerId}`
}

function playerIdFromCacheKey(key: string): SM.PlayerId {
	return key.slice(key.indexOf('\0') + 1) as SM.PlayerId
}

// clears every cached perm set (settings/adminlist/discord-role change) and notifies clients to refetch
export function invalidateAll() {
	cache.users.clear()
	cache.players.clear()
	userPlayerIndex.clear()
	notify({ scope: 'all' })
}

// drops one discord identity's cached perms (and its linked player entries) and notifies that user's session(s)
export function invalidateUser(discordId: bigint) {
	cache.users.delete(discordId)
	const players = userPlayerIndex.get(discordId)
	if (players) {
		// player entries are keyed by server as well, so drop every server's entry for each linked player
		for (const key of [...cache.players.keys()]) {
			if (players.has(playerIdFromCacheKey(key))) cache.players.delete(key)
		}
		userPlayerIndex.delete(discordId)
	}
	notify({ scope: 'user', discordId })
}

// called by settings.server whenever global settings are (re)loaded so role/permission changes take effect without a restart
export function applyRbacSettings(rbac: SETTINGS.RbacSettings) {
	roleIndex = buildRoleIndex(rbac)
	// TODO add preflight checks to make sure the remote references in role assignments are valid
}

function buildRoleIndex(rbac: SETTINGS.RbacSettings): RoleIndex {
	const index: RoleIndex = {
		roles: [],
		assignments: [],
		permissionExpressions: new Map(),
		maxTimeouts: new Map(),
		maxLayerRequests: new Map(),
		globalSettingsGrants: new Map(),
		serverSettingsGrants: new Map(),
		serverGrants: new Map(),
		pluginGrants: new Map(),
	}
	for (const roleType of Obj.objKeys(rbac.roles)) {
		const cfg = rbac.roles[roleType]
		const role = RBAC.userDefinedRole(roleType)
		index.roles.push(role)
		index.permissionExpressions.set(roleType, cfg.permissions)
		if (cfg.maxTimeout !== undefined) index.maxTimeouts.set(roleType, cfg.maxTimeout)
		if (cfg.maxLayerRequests !== undefined) index.maxLayerRequests.set(roleType, cfg.maxLayerRequests)
		if (cfg.globalSettingsGrants.length > 0) index.globalSettingsGrants.set(roleType, cfg.globalSettingsGrants)
		if (cfg.serverSettingsGrants.length > 0) index.serverSettingsGrants.set(roleType, cfg.serverSettingsGrants)
		if (cfg.serverGrants.length > 0) index.serverGrants.set(roleType, cfg.serverGrants)
		if (cfg.pluginGrants.length > 0) index.pluginGrants.set(roleType, cfg.pluginGrants)

		for (const discordRoleId of cfg.assignments.discordRoleIds) {
			index.assignments.push({ type: 'discord-role', role, discordRoleId: BigInt(discordRoleId) })
		}
		for (const userId of cfg.assignments.discordUserIds) {
			index.assignments.push({ type: 'discord-user', role, discordUserId: BigInt(userId) })
		}
		if (cfg.assignments.everyMember) {
			index.assignments.push({ type: 'discord-server-member', role })
		}
		for (const { listId, groupId } of cfg.assignments.adminListGroups) {
			index.assignments.push({ type: 'admin-list-group', listId, groupId, role })
		}
		for (const listId of cfg.assignments.ingameAdminLists) {
			index.assignments.push({ type: 'ingame-admin', listId, role })
		}
	}
	return index
}

// superUsers/superRoles from the deploy-time config always receive every permission -- the anti-lockout bootstrap
async function fetchIsSuperUser(userId: bigint): Promise<boolean> {
	// a demo has no way to know who is who (anyone signs in as any name, see the no-auth login portal) and
	// nothing worth protecting, so everyone administers it
	if (ENV.DEMO) return true
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

export const getRbacForDiscordUser = Instr.spanOp(
	'getRbacForDiscordUser',
	{ module, levels: { event: 'trace' }, attrs: (ctx: USR.Ctx.Id) => ({ [ATTRS.User.ID]: String(ctx.user.discordId) }) },
	async (ctx: C.Db & USR.Ctx.Id & CS.AbortSignal) => {
		const discordUserId = ctx.user.discordId
		const cached = cache.users.get(discordUserId)
		if (cached) return await cached
		const playerIds = await User.findUserPlayerIds(ctx, discordUserId)

		const userRbacPromise = resolveUserRbac(ctx, discordUserId, playerIds)

		cache.users.set(discordUserId, userRbacPromise)
		// The linked players are indexed (so invalidating this user drops their entries) but no longer seeded with this
		// result: a user's roles are resolved against every configured admin list, a player's only against the ones
		// their server uses, so handing this answer to the player cache would grant roles on servers that do not
		// recognise the list behind them. getRbacForPlayer resolves discord roles itself, so nothing is lost but a
		// recomputation.
		const linkedPlayerIds = new Set<SM.PlayerId>()
		for (const ids of playerIds) linkedPlayerIds.add(SM.PlayerIds.getPlayerId(ids))
		userPlayerIndex.set(discordUserId, linkedPlayerIds)
		return await userRbacPromise
	},
)

export const getRbacForPlayer = Instr.spanOp(
	'getRbacForPlayer',
	{ module },
	async (ctx: C.Db & SM.Ctx.Ids<'eos'> & CS.ServerId & CS.AbortSignal) => {
		const ids = ctx.player.ids
		const playerId = SM.PlayerIds.getPlayerId(ids)
		// keyed by server as well as player: which admin lists speak for a player is per-server, so one cache entry
		// cannot answer for two servers without leaking one server's admins into the other
		const cacheKey = playerCacheKey(ctx.serverId, playerId)
		const cached = cache.players.get(cacheKey)
		if (cached) return await cached
		let steamId: bigint | undefined
		if (ids.steam === undefined) {
			const [row] = await ctx
				.db()
				.select({ steamId: Schema.players.steamId })
				.from(Schema.players)
				.where(E.eq(Schema.players.eosId, ids.eos))
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
				adminListAssignmentsPromise = resolveAdminListAssignments(
					ctx,
					[{ ...ids, steam: steamId.toString() }],
					await AdminList.getListsForServerId(ctx, ctx.serverId),
				)
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

		cache.players.set(cacheKey, rbacPromise)
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

// What a discord identity resolves to from a given set of linked players. Takes the ids rather than reading them,
// so a set that is not (yet) the stored one can be resolved: tryDenySteamLinkEscalation asks what a link would do.
async function resolveUserRbac(
	ctx: C.Db & CS.AbortSignal,
	discordUserId: bigint,
	playerIds: SM.PlayerIds.IdQuery<'steam'>[],
): Promise<RBAC.UserRbac> {
	const ingameRolesPromise = (async () => {
		return resolveAdminListAssignments(ctx, playerIds, await AdminList.getAllLists(ctx))
	})()
	const discordRolesPromise = resolveDiscordAssignments(ctx, discordUserId)
	const baseRoles = RBAC.Role.merge(await ingameRolesPromise, await discordRolesPromise)
	const inferredRoles = await resolveInferredRoleAssignments(ctx, baseRoles, discordUserId)
	const roles = RBAC.Role.merge(baseRoles, inferredRoles)
	const perms = permsFromRoles(roles)
	const superUserPerms = await resolveSuperUserPerms(discordUserId)
	RBAC.addTracedPerms(perms, ...superUserPerms)
	RBAC.addTracedPerms(perms, ...resolveScopedOwnerPerms(discordUserId))
	return { roles, perms }
}

// Linking somebody else's steam account to their discord account is a grant of whatever that steam id is an admin
// for, so it has to be held by whoever makes it. Weighed against what the link *changes* rather than everything the
// subject holds, so an admin can still fix a link on somebody who outranks them for unrelated reasons.
//
// Linking and unlinking move the same set of permissions in opposite directions, which is why there is one check and
// no direction argument: the delta is the same either way, and neither handing it over nor taking it away is
// something a caller who does not hold it may do.
export async function tryDenySteamLinkEscalation(
	ctx: C.Db & USR.Ctx.Id & CS.AbortSignal,
	subjectDiscordId: bigint,
	steamId: bigint,
): Promise<RBAC.PermissionDeniedResponse | undefined> {
	const steam = steamId.toString()
	const linked = await User.findUserPlayerIds(ctx, subjectDiscordId)
	const without = linked.filter((ids) => ids.steam !== steam)
	const withLink = [...without, { steam }]

	const [withoutPerms, withPerms] = await Promise.all([
		resolveUserRbac(ctx, subjectDiscordId, without).then((rbac) => RBAC.fromTracedPermissions(rbac.perms)),
		resolveUserRbac(ctx, subjectDiscordId, withLink).then((rbac) => RBAC.fromTracedPermissions(rbac.perms)),
	])
	const delta = withPerms.filter((perm) => !RBAC.permSubsumedBy(perm, withoutPerms, scopedServerIds))
	if (delta.length === 0) return

	const actorPerms = await getUserPermissions(ctx)
	const failures = delta.filter((perm) => !RBAC.permSubsumedBy(perm, actorPerms, scopedServerIds)).map((perm) => RBAC.describePermit(perm))
	if (failures.length === 0) return
	return { code: 'err:permission-denied', checkType: 'all', failures }
}

type RoleAffectingSettings = Pick<SETTINGS.GlobalSettings, 'rbac' | 'adminLists'>

// An edit to the roles or the admin lists must not grant anyone a permission its author does not hold, or a grant over
// those settings would be a grant of everything. A role that is new, or whose assignments or assigning admin lists
// changed, can reach new people, so its author must hold all it grants. Any other changed role needs only what it
// adds. Dropping a negation grants what it negated to everyone holding the role.
export async function tryDenyRoleSettingsEscalation(
	ctx: C.Db & USR.Ctx.Id & CS.AbortSignal,
	prev: RoleAffectingSettings,
	next: RoleAffectingSettings,
): Promise<RBAC.PermissionDeniedResponse | undefined> {
	const listIds = new Set([...Object.keys(prev.adminLists), ...Object.keys(next.adminLists)])
	const changedLists = new Set([...listIds].filter((id) => !Obj.deepEqual(prev.adminLists[id], next.adminLists[id])))
	const readsChangedList = (cfg: RoleConfig) =>
		cfg.assignments.ingameAdminLists.some((id) => changedLists.has(id)) ||
		cfg.assignments.adminListGroups.some((g) => changedLists.has(g.listId))

	const prevIndex = buildRoleIndex(prev.rbac)
	const nextIndex = buildRoleIndex(next.rbac)
	const required: RBAC.Permission[] = []
	for (const roleType of new Set([...Object.keys(prev.rbac.roles), ...Object.keys(next.rbac.roles)])) {
		const before = Object.hasOwn(prev.rbac.roles, roleType) ? prev.rbac.roles[roleType] : undefined
		const after = Object.hasOwn(next.rbac.roles, roleType) ? next.rbac.roles[roleType] : undefined
		const role = RBAC.userDefinedRole(roleType)
		if (before && after && Obj.deepEqual(before, after) && !readsChangedList(after)) continue

		for (const expr of before?.permissions ?? []) {
			const negated = RBAC.parseNegatingPermissionType(expr)
			if (negated && !after?.permissions.includes(expr)) {
				required.push(...RBAC.fromTracedPermissions([RBAC.tracedPerm(negated, [role], {}, RBAC.unrestrictedRoleGrantArgs(negated))]))
			}
		}
		if (!after) continue

		const granted = RBAC.fromTracedPermissions(permsFromRoles([role], nextIndex))
		if (!before || !Obj.deepEqual(before.assignments, after.assignments) || readsChangedList(after)) {
			required.push(...granted)
		} else {
			const had = RBAC.fromTracedPermissions(permsFromRoles([role], prevIndex))
			required.push(...granted.filter((perm) => !RBAC.permSubsumedBy(perm, had, scopedServerIds)))
		}
	}
	if (required.length === 0) return

	const actorPerms = await getUserPermissions(ctx)
	const failures = required
		.filter((perm) => !RBAC.permSubsumedBy(perm, actorPerms, scopedServerIds))
		.map((perm) => RBAC.describePermit(perm))
	if (failures.length === 0) return
	return { code: 'err:permission-denied', checkType: 'all', failures: [...new Set(failures)] }
}

// Resolved against a named set of lists rather than "the admin list". The two callers ask different questions: a
// player is on one server, so only that server's lists may speak for them -- that is what keeps a sandbox's admins
// out of production. A web user is on no server, so every configured list is consulted, and where the resulting role
// applies is decided by that role's own server-scoped grants.
async function resolveAdminListAssignments(ctx: C.Db & CS.AbortSignal, allIds: SM.PlayerIds.IdQuery<'steam'>[], lists: SM.AdminLists) {
	const roles: RBAC.Role[] = []
	for (const assignment of roleIndex.assignments) {
		if (assignment.type === 'admin-list-group') {
			const list = lists.get(assignment.listId)
			if (!list) continue
			for (const ids of allIds) {
				const groups = SM.AdminList.getPlayerGroups(list, ids)
				if (groups?.has(assignment.groupId)) {
					RBAC.Role.push(roles, assignment.role)
				}
			}
		}
		if (assignment.type === 'ingame-admin') {
			const list = lists.get(assignment.listId)
			if (!list) continue
			for (const ids of allIds) {
				const isAdmin = SM.AdminList.getIsAdmin(list, ids)
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
	for (const assignment of roleIndex.assignments) {
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

// Replace the known set of scoped servers. Called by settings.server on every registry change. Cheap to call with an
// unchanged set (public-only registries, most writes): it no-ops unless the scoped membership actually moved, so it
// never needlessly flushes everyone's cached perms.
export function applyScopedServers(next: ReadonlyMap<string, bigint | null>) {
	if (scopedServersEqual(scopedServers, next)) return
	scopedServers = new Map(next)
	const ids = new Set<string>()
	const byOwner = new Map<bigint, string[]>()
	for (const [id, owner] of next) {
		ids.add(id)
		if (owner !== null) {
			const owned = byOwner.get(owner) ?? []
			owned.push(id)
			byOwner.set(owner, owned)
		}
	}
	scopedServerIds = ids
	scopedServersByOwner = byOwner
	invalidateAll()
}

function scopedServersEqual(a: ReadonlyMap<string, bigint | null>, b: ReadonlyMap<string, bigint | null>): boolean {
	if (a.size !== b.size) return false
	for (const [id, owner] of a) {
		if (!b.has(id) || b.get(id) !== owner) return false
	}
	return true
}

// The implicit grant a scoped server's owner holds on it: full operational control (every server-scoped permission),
// but not settings-write or connection editing -- those are not server-scoped perms, so iterating SERVER_PERMISSION_TYPE
// deliberately leaves them out, and the owner cannot reconfigure a scoped sandbox into something that reaches the network.
function resolveScopedOwnerPerms(discordUserId: bigint): RBAC.TracedPermission[] {
	const owned = scopedServersByOwner.get(discordUserId)
	if (!owned || owned.length === 0) return []
	const perms: RBAC.TracedPermission[] = []
	for (const serverId of owned) {
		// the plain server-scoped perms (view, kick, sandbox:control, ...) take a bare { serverId }. timeout-players and
		// request-layers are comparators that carry their own args, so they are granted explicitly below rather than here.
		for (const permType of RBAC.SERVER_PERMISSION_TYPE.options) {
			RBAC.addTracedPerms(perms, RBAC.tracedPerm(permType, [SCOPED_OWNER_ROLE], { negated: false }, { serverId }))
		}
		RBAC.addTracedPerms(
			perms,
			RBAC.tracedPerm('squad-server:timeout-players', [SCOPED_OWNER_ROLE], { negated: false }, { serverId, maxDurationMs: null }),
		)
		RBAC.addTracedPerms(
			perms,
			RBAC.tracedPerm('queue:request-layers', [SCOPED_OWNER_ROLE], { negated: false }, { serverId, maxQueued: null }),
		)
		// the owner of a scoped server holds everything on it, plugins included
		RBAC.addTracedPerms(
			perms,
			RBAC.tracedPerm(
				'plugin:action',
				[SCOPED_OWNER_ROLE],
				{ negated: false },
				{ pluginId: RBAC.ANY_PLUGIN_ACTION, permission: RBAC.ANY_PLUGIN_ACTION, serverId },
			),
		)
	}
	return perms
}

async function resolveSuperUserPerms(userId: bigint) {
	const isSuperUser = await fetchIsSuperUser(userId)
	const perms: RBAC.TracedPermission[] = []
	if (!isSuperUser) return []
	for (const permType of RBAC.ROLE_GRANTABLE_PERMISSION_TYPE.options) {
		RBAC.addTracedPerms(perms, RBAC.tracedPerm(permType, [SUPER_ROLE], { negated: false }, RBAC.unrestrictedRoleGrantArgs(permType)))
	}
	RBAC.addTracedPerms(
		perms,
		RBAC.tracedPerm('squad-server:timeout-players', [SUPER_ROLE], { negated: false }, { serverId: null, maxDurationMs: null }),
	)
	RBAC.addTracedPerms(
		perms,
		RBAC.tracedPerm('queue:request-layers', [SUPER_ROLE], { negated: false }, { serverId: null, maxQueued: null }),
	)
	// which plugins exist is not knowable here, so a super user holds the wildcard rather than an enumeration
	RBAC.addTracedPerms(
		perms,
		RBAC.tracedPerm(
			'plugin:action',
			[SUPER_ROLE],
			{ negated: false },
			{ pluginId: RBAC.ANY_PLUGIN_ACTION, permission: RBAC.ANY_PLUGIN_ACTION, serverId: null },
		),
	)
	return perms
}

async function resolveInferredRoleAssignments(ctx: C.Db, baseRoles: RBAC.Role[], discordUserId?: bigint): Promise<RBAC.Role[]> {
	const db = ctx.db()
	if (!discordUserId && baseRoles.length === 0) return []
	type Source = 'owner' | 'user-contributor' | 'role-contributor'
	// unionAll's arms are positional, so an inapplicable arm has to select nothing rather than be omitted: drop one and
	// drizzle dereferences an undefined arm.
	const owned = db
		.select({
			source: E.sql<Source>`'owner'`.as('source'),
			filterId: Schema.filters.id,
		})
		.from(Schema.filters)
		.where(discordUserId ? E.eq(Schema.filters.ownerUserId, discordUserId) : E.sql`false`)
	const userContributed = db
		.select({
			source: E.sql<Source>`'user-contributor'`.as('source'),
			filterId: Schema.filterUserContributors.filterId,
		})
		.from(Schema.filterUserContributors)
		.where(discordUserId ? E.eq(Schema.filterUserContributors.userId, discordUserId) : E.sql`false`)
	const roleContributed = db
		.select({
			source: E.sql<Source>`'role-contributor'`.as('source'),
			filterId: Schema.filterRoleContributors.filterId,
		})
		.from(Schema.filterRoleContributors)
		.where(
			E.inArray(
				Schema.filterRoleContributors.roleId,
				baseRoles.map((r) => r.type),
			),
		)

	const rows = await unionAll(owned, userContributed, roleContributed)

	const roles: RBAC.Role[] = []
	for (const row of rows) {
		switch (row.source) {
			case 'owner':
				RBAC.Role.push(roles, { type: 'filter-owner', filterId: row.filterId })
				break
			case 'user-contributor':
				RBAC.Role.push(roles, { type: 'filter-user-contributor', filterId: row.filterId })
				break
			case 'role-contributor':
				RBAC.Role.push(roles, { type: 'filter-role-contributor', filterId: row.filterId })
				break
			default:
				assertNever(row.source)
		}
	}
	return roles
}

// the permissions a set of roles grants purely from their rbac settings config. Negations only apply within the given
// set, which is what lets a single role be evaluated in isolation (see getSimulatableRoles).
function permsFromRoles(roles: RBAC.Role[], index: RoleIndex = roleIndex): RBAC.TracedPermission[] {
	const perms: RBAC.TracedPermission[] = []
	const allNegatingPerms: Set<RBAC.RoleGrantablePermissionType> = new Set()

	for (const role of roles) {
		for (const permExpr of index.permissionExpressions.get(role.type) ?? []) {
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
				RBAC.addTracedPerms(perms, RBAC.tracedPerm('filters:write', [role], {}, { filterId: role.filterId }))
			} else {
				assertNever(role)
			}
			continue
		}
		if ((index.permissionExpressions.get(role.type) ?? []).includes('*')) {
			for (const permType of RBAC.ROLE_GRANTABLE_PERMISSION_TYPE.options) {
				perms.push(
					RBAC.tracedPerm(permType, [role], { negated: allNegatingPerms.has(permType) }, RBAC.unrestrictedRoleGrantArgs(permType)),
				)
			}
		}
		for (const permExpr of index.permissionExpressions.get(role.type) ?? []) {
			if (!RBAC.isRoleGrantablePermissionType(permExpr)) continue
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm(permExpr, [role], { negated: allNegatingPerms.has(permExpr) }, RBAC.unrestrictedRoleGrantArgs(permExpr)),
			)
		}
		const maxTimeout = index.maxTimeouts.get(role.type)
		if (maxTimeout !== undefined) {
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('squad-server:timeout-players', [role], {}, { serverId: null, maxDurationMs: maxTimeout }),
			)
		}
		const maxLayerRequests = index.maxLayerRequests.get(role.type)
		if (maxLayerRequests !== undefined) {
			RBAC.addTracedPerms(perms, RBAC.tracedPerm('queue:request-layers', [role], {}, { serverId: null, maxQueued: maxLayerRequests }))
		}
		// restricted settings grants; a matching negation in any role's expressions wins over these too
		const globalPaths = index.globalSettingsGrants.get(role.type)
		if (globalPaths && globalPaths.length > 0) {
			RBAC.addTracedPerms(
				perms,
				RBAC.tracedPerm('global-settings:write', [role], { negated: isNegated('global-settings:write') }, { paths: [...globalPaths] }),
			)
		}
		for (const grant of index.serverGrants.get(role.type) ?? []) {
			for (const serverId of grant.serverIds) {
				RBAC.addTracedPerms(perms, RBAC.tracedPerm(grant.permission, [role], { negated: isNegated(grant.permission) }, { serverId }))
			}
		}
		// no negation: `!plugin:action` would deny every plugin's every action, which nobody means. To remove one,
		// drop the grant -- the same rule the comparator-scoped grants follow.
		for (const grant of index.pluginGrants.get(role.type) ?? []) {
			const serverIds: (string | null)[] = grant.serverIds.length > 0 ? grant.serverIds : [null]
			for (const serverId of serverIds) {
				RBAC.addTracedPerms(
					perms,
					RBAC.tracedPerm('plugin:action', [role], {}, { pluginId: grant.pluginId, permission: grant.permission, serverId }),
				)
			}
		}
		for (const grant of index.serverSettingsGrants.get(role.type) ?? []) {
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
						RBAC.tracedPerm(
							'server-settings:write',
							[role],
							{ negated: isNegated('server-settings:write') },
							{
								serverId,
								paths: grant.paths.length > 0 ? [...grant.paths] : null,
							},
						),
					)
				} else {
					RBAC.addTracedPerms(
						perms,
						RBAC.tracedPerm(
							'server-settings:write-sensitive',
							[role],
							{ negated: isNegated('server-settings:write-sensitive') },
							{
								serverId,
							},
						),
					)
				}
			}
		}
	}
	return perms
}

export async function tryDenyPermissionsForUser(ctx: C.Db & USR.Ctx.Id & CS.AbortSignal, req: RBAC.ReqInput) {
	return RBAC.tryDenyPermissions(await getUserPermissions(ctx), req, scopedServerIds)
}

export async function tryDenyPermissionsForPlayer(ctx: C.Db & SM.Ctx.Ids & CS.ServerId & CS.AbortSignal, req: RBAC.ReqInput) {
	return RBAC.tryDenyPermissions(RBAC.fromTracedPermissions((await getRbacForPlayer(ctx)).perms), req, scopedServerIds)
}

// Deliberately no `tryDenyPermissionsFor(Actor)` here: authorization happens at the entry point, where the identity
// is known concretely (a user over oRPC, a player in chat), never inside a shared action function. A helper that
// falls back to "no identity, so allow" would make every such check fail-open for any future caller that reaches it
// without one. Checks that genuinely depend on loaded state stay where the state is, inside the transaction.

// For an entry point outside oRPC that does what a procedure does on the caller's behalf, so it requires exactly what
// that procedure does
export async function tryDenyProcedureAccess<P extends PA.CheckablePath>(
	ctx: C.Db & USR.Ctx.Id & CS.AbortSignal,
	path: P,
	input: PA.AccessInput<P>,
) {
	return await tryDenyPermissionsForUser(ctx, PA.checkedReq(path, input))
}

// One read of the caller's perms, for checking many requirements against them: a response filtered row by row
export async function getUserAccessCheck(ctx: C.Db & USR.Ctx.Id & CS.AbortSignal): Promise<(req: RBAC.ReqInput) => boolean> {
	const perms = await getUserPermissions(ctx)
	return (req) => RBAC.tryDenyPermissions(perms, req, scopedServerIds) === null
}

// every change to what this user holds, for a stream filtered by their access to recompute on
export function userInvalidation$(discordId: bigint): Rx.Observable<RbacInvalidation> {
	return invalidation$.pipe(Rx.filter((e) => e.scope === 'all' || e.discordId === discordId))
}

// for the aggregate (non-equality) checks: settings access, timeouts
export async function getUserPermissions(ctx: C.Db & USR.Ctx.Id & CS.AbortSignal): Promise<RBAC.Permission[]> {
	return RBAC.fromTracedPermissions((await getRbacForDiscordUser(ctx)).perms)
}

// "up to N concurrent items" layer-request checks bypass the equality-matched permission path
// (see RBAC.maxLayerRequests): undefined = no grant, null = unlimited, number = max concurrent items
export async function getMaxLayerRequestsForUser(
	ctx: C.Db & CS.AbortSignal & USR.Ctx.Id & CS.ServerId,
): Promise<number | null | undefined> {
	const perms = RBAC.fromTracedPermissions((await getRbacForDiscordUser(ctx)).perms)
	return RBAC.maxLayerRequests(perms, ctx.serverId, scopedServerIds)
}
export async function getMaxLayerRequestsForPlayer(
	ctx: C.Db & CS.AbortSignal & SM.Ctx.Ids & CS.ServerId,
): Promise<number | null | undefined> {
	const perms = RBAC.fromTracedPermissions((await getRbacForPlayer(ctx)).perms)
	return RBAC.maxLayerRequests(perms, ctx.serverId, scopedServerIds)
}

export const orpcRouter = {
	getUserDefinedRoles: orpcBase.handler(() => {
		return roleIndex.roles
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
		for (const role of roleIndex.roles) {
			if (heldRoles.has(role.type)) continue
			const perms = permsFromRoles([role])
			// a role granting nothing (or only negations) is vacuously subsumed, and simulating it is still meaningful:
			// its negations take access away
			const granted = RBAC.fromTracedPermissions(perms)
			if (!granted.every((p) => RBAC.permSubsumedBy(p, userPerms, scopedServerIds))) continue
			simulatable.push({ role, perms })
		}
		return simulatable
	}),

	// the env-configured SUPER_USERS/SUPER_ROLES bootstrap, surfaced read-only in the settings rbac section.
	// ids as strings so the snowflakes survive JSON
	getSuperConfig: orpcBase.handler(async ({ context: ctx }) => {
		return {
			code: 'ok' as const,
			superUsers: [...superUserIds].map(String),
			superRoles: [...superRoleIds].map(String),
		}
	}),

	// guild role/member lookups powering the settings role-assignment pickers; gated behind global-settings editing
	// since they surface guild role names and member identities
	listGuildRoles: orpcBase.handler(async ({ context: ctx }) => {
		return Discord.listGuildRolesDetailed()
	}),

	searchGuildMembers: orpcBase.input(z.object({ query: z.string() })).handler(async ({ context: ctx, input }) => {
		const query = input.query.trim()
		if (query.length === 0) return { code: 'ok' as const, members: [] }
		return Discord.searchGuildMembers(query)
	}),

	// Beside the two above because rbac.server is what may import discord.server; the reverse is a cycle.
	// Either grant, unlike them: the channel picker also renders in a plugin's config, and an admin who can
	// only manage plugins still has to be able to name a channel there.
	listGuildChannels: orpcBase.handler(async ({ context: ctx }) => {
		return Discord.listGuildChannels()
	}),

	// the groups each configured admin list defines, for the role-assignment picker. Grouped by list rather than
	// unioned: an assignment names the list it means, so the picker has to offer the pair, and two lists defining the
	// same group name are two different grants.
	listAdminListGroups: orpcBase.handler(async ({ context: ctx }) => {
		const lists = await Promise.all(
			AdminList.configuredListIds()
				.sort()
				.map(async (listId) => {
					const list = await AdminList.getList(ctx, listId)
					return { listId, groups: list ? [...list.groups.keys()].sort() : [] }
				}),
		)
		return { code: 'ok' as const, lists }
	}),
}
