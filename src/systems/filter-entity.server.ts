import * as Orpc from '@orpc/server'
import * as E from 'drizzle-orm'

import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Schema from '$root/drizzle/schema.ts'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import type { Parts } from '@/lib/types'
import { z } from '@/lib/zod'
import * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared.models'
import * as FR from '@/models/filter-references.models'
import * as F from '@/models/filter.models'
import * as ATTRS from '@/models/otel-attrs.models'
import * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Sql from '@/server/sql'
import * as AppEventsSys from '@/systems/app-events.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Rbac from '@/systems/rbac.server'
import * as Settings from '@/systems/settings.server'
import * as Users from '@/systems/users.server'

const module = initModule('filter-entity')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)
const SQL = Sql.forModule(module)

const UserContributors = Schema.filterUserContributors
const RoleContributors = Schema.filterRoleContributors

export const filterMutation$ = new IsolatedSubject<[C.Db & CS.Otel, F.FilterEntityMutation]>()
const ToggleFilterContributorInputSchema = z
	.object({ filterId: F.FilterEntityIdSchema, userId: z.bigint().optional(), roleId: RBAC.UserDefinedRoleIdSchema.optional() })
	.refine((input) => input.userId || input.roleId, {
		error: 'Either userId or role must be provided',
	})
export type ToggleFilterContributorInput = z.infer<typeof ToggleFilterContributorInputSchema>

// -------- statements --------

const idP = SQL.params({ id: Schema.filters.id })
const filterById = SQL.def('filterById', idP, SQL.select().from(Schema.filters).where(E.eq(Schema.filters.id, idP.id)))
const filterName = SQL.def(
	'filterName',
	idP,
	SQL.select({ name: Schema.filters.name }).from(Schema.filters).where(E.eq(Schema.filters.id, idP.id)),
)
const filterOwner = SQL.def(
	'filterOwner',
	idP,
	SQL.select({ ownerUserId: Schema.filters.ownerUserId }).from(Schema.filters).where(E.eq(Schema.filters.id, idP.id)),
)
const deleteFilterRow = SQL.def('deleteFilterRow', idP, SQL.delete(Schema.filters).where(E.eq(Schema.filters.id, idP.id)))
const allFilters = SQL.def('allFilters', SQL.params({}), SQL.select().from(Schema.filters), { scans: ['filters'] })

const filterP = SQL.params(E.getTableColumns(Schema.filters))
const insertFilter = SQL.def('insertFilter', filterP, SQL.insert(Schema.filters).values(filterP))
const insertFilterIfAbsent = SQL.def('insertFilterIfAbsent', filterP, SQL.insert(Schema.filters).values(filterP).onConflictDoNothing())

// every column an update may change: the filter's own fields, never its id or owner
const contentP = SQL.params({
	id: Schema.filters.id,
	name: Schema.filters.name,
	description: Schema.filters.description,
	filter: Schema.filters.filter,
	alertMessage: Schema.filters.alertMessage,
	emoji: Schema.filters.emoji,
	invertedAlertMessage: Schema.filters.invertedAlertMessage,
	invertedEmoji: Schema.filters.invertedEmoji,
	missExemption: Schema.filters.missExemption,
})
const { id: _contentId, ...contentSetP } = contentP
const updateFilterContent = SQL.def(
	'updateFilterContent',
	contentP,
	SQL.update(Schema.filters).set(contentSetP).where(E.eq(Schema.filters.id, contentP.id)),
)
const ownerP = SQL.params({ id: Schema.filters.id, ownerUserId: Schema.filters.ownerUserId, ownerPluginId: Schema.filters.ownerPluginId })
const setFilterOwner = SQL.def(
	'setFilterOwner',
	ownerP,
	SQL.update(Schema.filters)
		.set({ ownerUserId: ownerP.ownerUserId, ownerPluginId: ownerP.ownerPluginId })
		.where(E.eq(Schema.filters.id, ownerP.id)),
)

const filterIdsP = SQL.params({ ids: SQL.list(Schema.filters.id) })
const filtersByIds = SQL.def(
	'filtersByIds',
	filterIdsP,
	SQL.select().from(Schema.filters).where(SQL.inJson(Schema.filters.id, filterIdsP.ids)),
)
const deleteFiltersByIds = SQL.def(
	'deleteFiltersByIds',
	filterIdsP,
	SQL.delete(Schema.filters).where(SQL.inJson(Schema.filters.id, filterIdsP.ids)),
)

const userContributorsP = SQL.params({ filterId: UserContributors.filterId })
const userContributorIds = SQL.def(
	'userContributorIds',
	userContributorsP,
	SQL.select({ userId: UserContributors.userId })
		.from(UserContributors)
		.where(E.eq(UserContributors.filterId, userContributorsP.filterId)),
)
const roleContributorsP = SQL.params({ filterId: RoleContributors.filterId })
const roleContributorIds = SQL.def(
	'roleContributorIds',
	roleContributorsP,
	SQL.select({ roleId: RoleContributors.roleId })
		.from(RoleContributors)
		.where(E.eq(RoleContributors.filterId, roleContributorsP.filterId)),
)
const allRoleContributors = SQL.def('allRoleContributors', SQL.params({}), SQL.select().from(RoleContributors), {
	scans: ['filterRoleContributors'],
})

const userContributorP = SQL.params({ filterId: UserContributors.filterId, userId: UserContributors.userId })
const insertUserContributor = SQL.def(
	'insertUserContributor',
	userContributorP,
	SQL.insert(UserContributors).values({ filterId: userContributorP.filterId, userId: userContributorP.userId }).onConflictDoNothing(),
)
const deleteUserContributor = SQL.def(
	'deleteUserContributor',
	userContributorP,
	SQL.delete(UserContributors).where(
		E.and(E.eq(UserContributors.filterId, userContributorP.filterId), E.eq(UserContributors.userId, userContributorP.userId)),
	),
)
const roleContributorP = SQL.params({ filterId: RoleContributors.filterId, roleId: RoleContributors.roleId })
const insertRoleContributor = SQL.def(
	'insertRoleContributor',
	roleContributorP,
	SQL.insert(RoleContributors).values({ filterId: roleContributorP.filterId, roleId: roleContributorP.roleId }).onConflictDoNothing(),
)
const deleteRoleContributor = SQL.def(
	'deleteRoleContributor',
	roleContributorP,
	SQL.delete(RoleContributors).where(
		E.and(E.eq(RoleContributors.filterId, roleContributorP.filterId), E.eq(RoleContributors.roleId, roleContributorP.roleId)),
	),
)

const userIdP = SQL.params({ userId: Schema.users.discordId })
const userExists = SQL.def(
	'userExists',
	userIdP,
	SQL.select({ id: Schema.users.discordId }).from(Schema.users).where(E.eq(Schema.users.discordId, userIdP.userId)),
)

// the columns Users.buildUsers reads
const USER_COLUMNS = {
	discordId: Schema.users.discordId,
	nickname: Schema.users.nickname,
	username: Schema.discordAccounts.username,
}
const userIdsP = SQL.params({ ids: SQL.list(Schema.users.discordId) })
const usersByIds = SQL.def(
	'usersByIds',
	userIdsP,
	SQL.select(USER_COLUMNS)
		.from(Schema.users)
		.innerJoin(Schema.discordAccounts, E.eq(Schema.users.discordId, Schema.discordAccounts.discordId))
		.where(SQL.inJson(Schema.users.discordId, userIdsP.ids)),
)
const contributingUsers = SQL.def(
	'contributingUsers',
	userContributorsP,
	SQL.select(USER_COLUMNS)
		.from(UserContributors)
		.innerJoin(Schema.users, E.eq(Schema.users.discordId, UserContributors.userId))
		.innerJoin(Schema.discordAccounts, E.eq(Schema.users.discordId, Schema.discordAccounts.discordId))
		.where(E.eq(UserContributors.filterId, userContributorsP.filterId)),
)

// -------- helpers --------

function recordFilterChange(
	ctx: C.Db,
	actor: AppEvents.Actor,
	action: AppEvents.FilterChanged['action'],
	filterId: string,
	details?: { filterName?: string; changedFields?: string[] },
) {
	AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.FilterChanged>({
			type: 'FILTER_CHANGED',
			action,
			filterId,
			filterName: details?.filterName,
			changedFields: details?.changedFields,
			actor,
			serverId: null,
			matchId: null,
			causeId: null,
		}),
	)
}

// managing who can contribute to a filter is an ownership concern, so it's restricted to the filter owner (or
// anyone with blanket write access), rather than any contributor who merely has filters:write for the filter.
async function denyUnlessFilterOwner(ctx: C.Db & USR.Ctx.Id & CS.AbortSignal, filterId: F.FilterEntityId) {
	const filter = DB.get(ctx, filterOwner({ id: filterId }))
	if (filter && filter.ownerUserId === ctx.user.discordId) return null
	return Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('filters:write-all'))
}

function recordFilterContributor(
	ctx: C.Db,
	action: AppEvents.FilterContributorChanged['action'],
	filterId: F.FilterEntityId,
	contributor: RBAC.Contributor,
	actor: AppEvents.Actor,
) {
	const filter = DB.get(ctx, filterName({ id: filterId }))
	AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.FilterContributorChanged>({
			type: 'FILTER_CONTRIBUTOR_CHANGED',
			action,
			filterId,
			filterName: filter?.name,
			contributor,
			actor,
			serverId: null,
			matchId: null,
			causeId: null,
		}),
	)
}

function toContributor(input: ToggleFilterContributorInput): RBAC.Contributor {
	return input.userId !== undefined ? { type: 'user', userId: input.userId } : { type: 'role', roleId: input.roleId! }
}

// a user contributor gains or loses the filter-user-contributor inferred role; a role contributor changes it for
// every holder of the role
function invalidateContributor(contributor: RBAC.Contributor) {
	if (contributor.type === 'user') Rbac.invalidateUser(contributor.userId)
	else Rbac.invalidateAll()
}

// a subscriber runs its statements after the emitting transaction has ended
function outsideTx(ctx: C.Db): C.Db {
	const { tx: _tx, ...rest } = ctx as C.Db & Partial<C.Tx>
	return rest
}

function emit(ctx: C.Db, mutation: F.FilterEntityMutation) {
	DB.afterCommit(ctx, () => filterMutation$.next([CS.storeLinkToActiveSpan(outsideTx(ctx), 'event.emitter'), mutation]))
}

function filterExists(ctx: C.Db, filterId: F.FilterEntityId) {
	return !!DB.get(ctx, filterName({ id: filterId }))
}

export function listFilterContributors(ctx: C.Db, filterId: F.FilterEntityId): RBAC.Contributor[] {
	const users = DB.all(ctx, userContributorIds({ filterId }))
	const roles = DB.all(ctx, roleContributorIds({ filterId }))
	return [
		...users.map((u): RBAC.Contributor => ({ type: 'user', userId: u.userId })),
		...roles.map((r): RBAC.Contributor => ({ type: 'role', roleId: r.roleId })),
	]
}

// checked up front because a missing filter or user would otherwise fail the insert's foreign key
export const addFilterContributor = DB.txOp(
	'addFilterContributor',
	{ module },
	(ctx: C.Db & C.Tx, filterId: F.FilterEntityId, contributor: RBAC.Contributor, actor: AppEvents.Actor) => {
		if (!filterExists(ctx, filterId)) return { code: 'err:not-found' as const }
		const changes = { changes: { atLeast: 1 }, otherwise: 'err:already-exists' as const }
		let res
		switch (contributor.type) {
			case 'user': {
				if (!DB.get(ctx, userExists({ userId: contributor.userId }))) return { code: 'err:unknown-user' as const }
				res = DB.run(ctx, insertUserContributor({ filterId, userId: contributor.userId }), changes)
				break
			}
			case 'role':
				res = DB.run(ctx, insertRoleContributor({ filterId, roleId: contributor.roleId }), changes)
				break
			default:
				assertNever(contributor)
		}
		if (res.code !== 'ok') return { code: res.code }
		recordFilterContributor(ctx, 'added', filterId, contributor, actor)
		DB.afterCommit(ctx, () => invalidateContributor(contributor))
		return { code: 'ok' as const }
	},
)

export const removeFilterContributor = DB.txOp(
	'removeFilterContributor',
	{ module },
	(ctx: C.Db & C.Tx, filterId: F.FilterEntityId, contributor: RBAC.Contributor, actor: AppEvents.Actor) => {
		const changes = { changes: { atLeast: 1 }, otherwise: 'err:not-found' as const }
		let res
		switch (contributor.type) {
			case 'user':
				res = DB.run(ctx, deleteUserContributor({ filterId, userId: contributor.userId }), changes)
				break
			case 'role':
				res = DB.run(ctx, deleteRoleContributor({ filterId, roleId: contributor.roleId }), changes)
				break
			default:
				assertNever(contributor)
		}
		if (res.code !== 'ok') return { code: res.code }
		recordFilterContributor(ctx, 'removed', filterId, contributor, actor)
		DB.afterCommit(ctx, () => invalidateContributor(contributor))
		return { code: 'ok' as const }
	},
)

/**
 * Adds the source's contributors to the target's, keeping any the target already has. Records an event only for the
 * contributors it actually added.
 */
export const copyFilterContributors = DB.txOp(
	'copyFilterContributors',
	{ module },
	(ctx: C.Db & C.Tx, sourceId: F.FilterEntityId, targetId: F.FilterEntityId, actor: AppEvents.Actor) => {
		if (!filterExists(ctx, sourceId) || !filterExists(ctx, targetId)) return { code: 'err:not-found' as const }
		const added: RBAC.Contributor[] = []
		for (const { userId } of DB.all(ctx, userContributorIds({ filterId: sourceId }))) {
			if (DB.run(ctx, insertUserContributor({ filterId: targetId, userId })).changes > 0) added.push({ type: 'user', userId })
		}
		for (const { roleId } of DB.all(ctx, roleContributorIds({ filterId: sourceId }))) {
			if (DB.run(ctx, insertRoleContributor({ filterId: targetId, roleId })).changes > 0) added.push({ type: 'role', roleId })
		}
		for (const contributor of added) {
			recordFilterContributor(ctx, 'added', targetId, contributor, actor)
			DB.afterCommit(ctx, () => invalidateContributor(contributor))
		}
		return { code: 'ok' as const }
	},
)

// Filters SLM owns rather than a person: the tutorial stands its own up alongside its scoped server,
// because no particular filter is guaranteed to exist in an install and a pool config naming one that does not
// fails every layer-status query for that server. Deliberately not the oRPC handlers above -- those enforce RBAC
// and the reference index for a human editing the filter index, neither of which applies to a row the runtime
// creates and deletes within one run. Both emit on filterMutation$ so open clients see the change.
export function putRuntimeFilters(ctx: C.Db, filters: F.FilterEntity[]) {
	if (filters.length === 0) return
	DB.transaction(ctx, {}, (ctx) => {
		for (const filter of filters) {
			DB.run(ctx, insertFilter(filterRow(filter)))
			emit(ctx, { type: 'add', key: filter.id, actor: { type: 'system' }, value: filter })
		}
	})
}

// Deletes the named rows, ignoring any that are already gone. Takes explicit ids rather than a prefix: which ids
// a runtime owns is the caller's to know, and a prefix wide enough to sweep every run would also match a filter a
// person (or a test fixture) happened to name that way.
export function deleteRuntimeFilters(ctx: C.Db, ids: F.FilterEntityId[]) {
	if (ids.length === 0) return 0
	const { deleted } = DB.transaction(ctx, {}, (ctx) => {
		const rows = DB.all(ctx, filtersByIds({ ids }))
		if (rows.length > 0) DB.run(ctx, deleteFiltersByIds({ ids: rows.map((row) => row.id) }))
		for (const row of rows) {
			const filter = F.fromRow(row)
			emit(ctx, { type: 'delete', key: filter.id, actor: { type: 'system' }, value: filter })
		}
		return { code: 'ok' as const, deleted: rows.length }
	})
	return deleted
}

// F.toRow types the nullable columns as optional, and a FilterEntity carries every one
function filterRow(filter: F.FilterEntity) {
	return F.toRow(filter) as SchemaModels.Filter
}

function selectFilters(ctx: C.Db) {
	return DB.all(ctx, allFilters({})).map(F.fromRow)
}

// Recomputed rather than maintained incrementally: it is read when a filter page is opened or something changes,
// and the whole set of filters and server pool configs is small enough that a full rebuild is cheaper than
// keeping an incremental one honest.
export function computeReferenceIndex(ctx: C.Db): FR.Index {
	return FR.buildIndex(selectFilters(ctx), Settings.listServerPoolConfigs(ctx), pluginFilterRefs())
}

// What the active plugins' configs name, pushed in from plugins.server rather than pulled: importing it here
// would close a cycle back through the queue. Same direction as rbac.server's applyScopedServers.
let pluginFilterRefs: () => FR.PluginFilterRefs[] = () => []
const referenceSourcesChanged$ = new Rx.Subject<void>()

export function registerPluginFilterRefs(read: () => FR.PluginFilterRefs[]) {
	pluginFilterRefs = read
	referenceSourcesChanged$.next()
}

/** A plugin's config, or which plugins are running, has changed. */
export function invalidateReferences() {
	referenceSourcesChanged$.next()
}

// the live reference index every client watches. Assigned in setup, since it needs a db context.
export let filterReferences$!: Rx.Observable<FR.Index>

// The write itself, without the permission check. The rpc handler, the shared-draft save path
// (filter-edit.server.ts) and a plugin all go through here, so a filter is only ever written one way.
export function updateFilter(ctx: C.Db, id: F.FilterEntityId, update: Partial<F.FilterEntityUpdate>, actor: AppEvents.Actor) {
	const res = DB.transaction(ctx, {}, (ctx) => {
		const rawFilter = DB.get(ctx, filterById({ id }))
		if (!rawFilter) {
			return { code: 'err:not-found' as const }
		}
		if (update.filter) {
			// the tree the engine sees is the referenced filters inlined, so a loop among them has no
			// fixed point: it has to be refused at the point it would be written
			const candidates = selectFilters(ctx).map((f) => (f.id === id ? { ...f, ...update } : f))
			const cycle = FR.findCycle(candidates, id)
			if (cycle) return { code: 'err:cyclical-reference' as const, cycle }
		}
		const { ownerUserId: _ownerUserId, ownerPluginId: _ownerPluginId, ...content } = rawFilter
		const updateResult = DB.run(ctx, updateFilterContent({ ...content, ...Obj.trimUndefined(update) }))

		if (updateResult.changes === 0) {
			throw new Orpc.ORPCError('INTERNAL_SERVER_ERROR', {
				message: 'Unable to update filter',
			})
		}
		const prevFilter = F.fromRow(rawFilter)
		const filter = { ...prevFilter, ...update }
		emit(ctx, { type: 'update', key: id, value: filter, actor })
		// the update is a partial, and a field resubmitted unchanged isn't a change worth recording
		const changedFields = Object.keys(update).filter(
			(field) => !Obj.deepEqual((prevFilter as Record<string, unknown>)[field], (update as Record<string, unknown>)[field]),
		)
		recordFilterChange(ctx, actor, 'updated', id, { filterName: filter.name, changedFields })
		return { code: 'ok' as const, filter, prevFilter }
	})
	// res carries the whole filter entity (AST included); flattening that into attributes wrote a key
	// per node of the filter tree on every update, at info level
	log.info({ [ATTRS.Filter.ID]: id, [ATTRS.Filter.OUTCOME]: res.code }, 'Updated filter %s: %s', id, res.code)
	return res
}

// Creation and deletion without the permission check, which stays with the callers above. Same shape as
// updateFilter: the rpc handler and a plugin write a filter one way.
export const createFilter = DB.txOp('createFilter', { module }, (ctx: C.Db & C.Tx, filter: F.FilterEntity, actor: AppEvents.Actor) => {
	// a filter can name one that doesn't exist yet, so creating that filter is a way to close a loop
	const cycle = FR.findCycle([...selectFilters(ctx), filter], filter.id)
	if (cycle) return { code: 'err:cyclical-reference' as const, cycle }
	const res = DB.run(ctx, insertFilterIfAbsent(filterRow(filter)), { changes: { atLeast: 1 }, otherwise: 'err:already-exists' })
	if (res.code !== 'ok') return { code: res.code }
	emit(ctx, { type: 'add', key: filter.id, value: filter, actor })
	recordFilterChange(ctx, actor, 'created', filter.id, { filterName: filter.name })
	// a user owner gained this filter's filter-owner inferred role, so their cached perms are stale
	const ownerUserId = F.ownerUserId(filter.owner)
	if (ownerUserId !== null) DB.afterCommit(ctx, () => Rbac.invalidateUser(ownerUserId))
	return { code: 'ok' as const }
})

export const deleteFilter = DB.txOp(
	'deleteFilter',
	{ module },
	(ctx: C.Db & C.Tx, idToDelete: F.FilterEntityId, actor: AppEvents.Actor) => {
		// every way a filter can still be pointed at, so that nothing is left dangling by the delete. Extra
		// filters are not among them: they are pruned client-side once the filter is gone.
		const references = FR.referencesFor(computeReferenceIndex(ctx), idToDelete)
		if (references.length > 0) {
			return { code: 'err:filter-in-use' as const, references }
		}
		const rawFilter = DB.get(ctx, filterById({ id: idToDelete }))
		if (!rawFilter) {
			return { code: 'err:filter-not-found' as const }
		}
		const filter = F.fromRow(rawFilter)
		// captured before the delete so the affected inferred-role holders can be invalidated after commit
		const userContributorIdList = DB.all(ctx, userContributorIds({ filterId: idToDelete })).map((r) => r.userId)
		const hasRoleContributors = DB.all(ctx, roleContributorIds({ filterId: idToDelete })).length > 0
		DB.run(ctx, deleteFilterRow({ id: idToDelete }))
		// owner + user contributors lose their inferred roles; a role contributor affects every holder of that role
		DB.afterCommit(ctx, () => {
			if (hasRoleContributors) Rbac.invalidateAll()
			else {
				const ownerUserId = F.ownerUserId(filter.owner)
				if (ownerUserId !== null) Rbac.invalidateUser(ownerUserId)
				for (const userId of userContributorIdList) Rbac.invalidateUser(userId)
			}
		})
		emit(ctx, { type: 'delete', key: idToDelete, value: filter, actor })
		recordFilterChange(ctx, actor, 'deleted', idToDelete, { filterName: filter.name })
		return { code: 'ok' as const }
	},
)

export const filtersRouter = {
	// users and roles are read separately: joining both onto the filter crosses them, so each user came back
	// once per role and each role once per user
	getFilterContributors: orpcBase.input(F.FilterEntityIdSchema).handler(async ({ input, context: ctx }) => {
		const userRows = DB.all(ctx, contributingUsers({ filterId: input }))
		const roleRows = DB.all(ctx, roleContributorIds({ filterId: input }))

		return {
			users: await Users.buildUsers(userRows),
			roles: roleRows.map((row) => row.roleId),
		}
	}),

	getAllFilterRoleContributors: orpcBase.handler(({ context: ctx }) => DB.all(ctx, allRoleContributors({}))),

	addFilterContributor: orpcBase
		.meta({ type: 'mutation' })
		.input(ToggleFilterContributorInputSchema)
		.handler(async ({ input, context: ctx }) => {
			const denyRes = await denyUnlessFilterOwner(ctx, input.filterId)
			if (denyRes) {
				return denyRes
			}
			return addFilterContributor(ctx, input.filterId, toContributor(input), { type: 'slm-user', userId: ctx.user.discordId })
		}),
	removeFilterContributor: orpcBase
		.meta({ type: 'mutation' })
		.input(ToggleFilterContributorInputSchema)
		.handler(async ({ input, context: ctx }) => {
			const denyRes = await denyUnlessFilterOwner(ctx, input.filterId)
			if (denyRes) {
				return denyRes
			}
			return removeFilterContributor(ctx, input.filterId, toContributor(input), { type: 'slm-user', userId: ctx.user.discordId })
		}),
	createFilter: orpcBase
		.meta({ type: 'mutation' })
		.input(F.NewFilterEntitySchema)
		.handler(({ input, context: ctx }) => {
			const user = { type: 'slm-user' as const, userId: ctx.user.discordId }
			return createFilter(ctx, { ...input, owner: user }, user)
		}),
	updateFilter: orpcBase
		.meta({ type: 'mutation' })
		.input(z.tuple([F.FilterEntityIdSchema, F.UpdateFilterEntitySchema.partial()]))
		.handler(({ input, context: ctx }) => {
			const [id, update] = input
			return updateFilter(ctx, id, update, { type: 'slm-user', userId: ctx.user.discordId })
		}),
	deleteFilter: orpcBase
		.meta({ type: 'mutation' })
		.input(F.FilterEntityIdSchema)
		.handler(({ input: idToDelete, context: ctx }) => {
			return deleteFilter(ctx, idToDelete, { type: 'slm-user', userId: ctx.user.discordId })
		}),
	watchFilters: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ context, signal }) {
		yield* watchFilters({ ctx: context, signal })
	}),

	watchFilterReferences: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ signal }) {
		yield* Rx.Ext.toAsyncGenerator(filterReferences$.pipe(Rx.Ext.withAbortSignal(signal!)))
	}),

	changeFilterOwner: orpcBase
		.meta({ type: 'mutation' })
		// a plugin takes ownership through the plugin API, never from here
		.input(
			z.object({
				filterId: F.FilterEntityIdSchema,
				newOwner: z.discriminatedUnion('type', [
					z.object({ type: z.literal('slm-user'), userId: USR.UserIdSchema }),
					z.object({ type: z.literal('system') }),
				]),
			}),
		)
		.handler(({ input, context: ctx }) =>
			DB.transaction(ctx, {}, (ctx) => {
				const rawFilter = DB.get(ctx, filterById({ id: input.filterId }))
				if (!rawFilter) {
					return { code: 'err:filter-not-found' as const }
				}
				const prevFilter = F.fromRow(rawFilter)
				if (F.ownersEqual(prevFilter.owner, input.newOwner)) {
					return { code: 'err:already-owns-filter' as const }
				}
				const owner = F.ownerColumns(input.newOwner) as Pick<SchemaModels.Filter, 'ownerUserId' | 'ownerPluginId'>
				DB.run(ctx, setFilterOwner({ id: input.filterId, ...owner }))
				const filter = { ...prevFilter, owner: input.newOwner }
				// filter-owner moved: the old owner loses the inferred role, the new owner gains it
				DB.afterCommit(ctx, () => {
					for (const owner of [prevFilter.owner, filter.owner]) {
						const userId = F.ownerUserId(owner)
						if (userId !== null) Rbac.invalidateUser(userId)
					}
				})
				const actor = { type: 'slm-user' as const, userId: ctx.user.discordId }
				emit(ctx, { type: 'update', key: input.filterId, value: filter, actor })
				recordFilterChange(ctx, actor, 'updated', input.filterId, { filterName: filter.name, changedFields: ['owner'] })
				return { code: 'ok' as const }
			}),
		),
}

export let state!: {
	filters: Map<string, F.FilterEntity>
}

export async function* watchFilters({
	ctx,
	signal,
}: {
	ctx: C.Db
	signal?: AbortSignal
}): AsyncGenerator<FilterEntityChange & Parts<USR.UserPart>, void, unknown> {
	const ids = [...new Set(Array.from(state.filters.values()).flatMap((f) => F.ownerUserId(f.owner) ?? []))]

	const dbUsers = ids.length > 0 ? DB.all(ctx, usersByIds({ ids })) : []

	yield {
		code: 'initial-value' as const,
		entities: Array.from(state.filters.values()),
		parts: {
			users: await Users.buildUsers(dbUsers),
		},
	}
	yield* Rx.Ext.toAsyncGenerator(mutationWithParts$.pipe(Rx.Ext.withAbortSignal(signal!)))
}

// the users a mutation names, built once for every watcher rather than once per watcher
const mutationWithParts$ = filterMutation$.pipe(
	Rx.concatMap(async ([ctx, mutation]) => {
		const userIds = new Set<bigint>()
		const ownerUserId = F.ownerUserId(mutation.value.owner)
		if (ownerUserId !== null) userIds.add(ownerUserId)
		if (mutation.actor.type === 'slm-user') userIds.add(mutation.actor.userId)
		const dbUsers = userIds.size > 0 ? DB.all(ctx, usersByIds({ ids: [...userIds] })) : []
		return { code: 'mutation' as const, mutation, parts: { users: await Users.buildUsers(dbUsers) } }
	}),
	Rx.share(),
)

export function setup() {
	log = module.getLogger()
	const ctx = DB.withDb({ ...CS.init(), signal: CleanupSys.shutdownSignal })
	const filterRows = selectFilters(ctx)
	state = {
		filters: new Map(filterRows.map((filter) => [filter.id, filter])),
	}
	filterReferences$ = Rx.merge(
		Rx.of(null),
		filterMutation$,
		// a pool config lives in a server's settings, and the registry decides which servers there are
		Settings.settings$.pipe(Rx.filter((e) => e.scope === 'server' || e.scope === 'registry')),
		referenceSourcesChanged$,
	).pipe(
		// a settings write broadcasts once per changed scope, and a filter mutation lands beside it; one rebuild covers the burst
		Rx.debounceTime(0),
		Rx.map(() => computeReferenceIndex(ctx)),
		Rx.shareReplay(1),
	)
	filterReferences$.subscribe()

	filterMutation$.subscribe((mutation) => {
		const [, mut] = mutation
		switch (mut.type) {
			case 'add':
				state.filters.set(mut.key, mut.value)
				break
			case 'update':
				state.filters.set(mut.key, mut.value)
				break
			case 'delete':
				state.filters.delete(mut.key)
				break
			default:
				assertNever(mut.type)
		}
	})
}

export type FilterEntityChange =
	| {
			code: 'initial-value'
			entities: F.FilterEntity[]
	  }
	| {
			code: 'mutation'
			mutation: F.FilterEntityMutation
	  }
