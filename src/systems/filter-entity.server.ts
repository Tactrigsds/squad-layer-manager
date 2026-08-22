import * as Orpc from '@orpc/server'
import * as E from 'drizzle-orm'
import { z } from 'zod'

import * as Schema from '$root/drizzle/schema.ts'
import { returnInsertErrors } from '@/lib/drizzle'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import type { Parts } from '@/lib/types'
import * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared'
import * as FR from '@/models/filter-references.models'
import * as F from '@/models/filter.models'
import * as ATTRS from '@/models/otel-attrs'
import * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AppEventsSys from '@/systems/app-events.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Rbac from '@/systems/rbac.server'
import * as Settings from '@/systems/settings.server'
import * as Users from '@/systems/users.server'

const module = initModule('filter-entity')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export const filterMutation$ = new IsolatedSubject<[C.Db & CS.Otel, USR.UserEntityMutation<F.FilterEntityId, F.FilterEntity>]>()
const ToggleFilterContributorInputSchema = z
	.object({ filterId: F.FilterEntityIdSchema, userId: z.bigint().optional(), roleId: RBAC.UserDefinedRoleIdSchema.optional() })
	.refine((input) => input.userId || input.roleId, {
		error: 'Either userId or role must be provided',
	})
export type ToggleFilterContributorInput = z.infer<typeof ToggleFilterContributorInputSchema>

async function recordFilterChange(
	ctx: C.Db & USR.Ctx.Id,
	action: AppEvents.FilterChanged['action'],
	filterId: string,
	details?: { filterName?: string; changedFields?: string[] },
) {
	await AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.FilterChanged>({
			type: 'FILTER_CHANGED',
			action,
			filterId,
			filterName: details?.filterName,
			changedFields: details?.changedFields,
			actor: { type: 'slm-user', userId: ctx.user.discordId },
			serverId: null,
			matchId: null,
			causeId: null,
		}),
	)
}

// managing who can contribute to a filter is an ownership concern, so it's restricted to the filter owner (or
// anyone with blanket write access), rather than any contributor who merely has filters:write for the filter.
async function denyUnlessFilterOwner(ctx: C.Db & USR.Ctx.Id & CS.AbortSignal, filterId: F.FilterEntityId) {
	const [filter] = await ctx.db().select({ owner: Schema.filters.owner }).from(Schema.filters).where(E.eq(Schema.filters.id, filterId))
	if (filter && filter.owner === ctx.user.discordId) return null
	return Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('filters:write-all'))
}

async function recordFilterContributor(
	ctx: C.Db & USR.Ctx.Id,
	action: AppEvents.FilterContributorChanged['action'],
	filterId: string,
	input: ToggleFilterContributorInput,
) {
	const [filter] = await ctx.db().select({ name: Schema.filters.name }).from(Schema.filters).where(E.eq(Schema.filters.id, filterId))
	await AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.FilterContributorChanged>({
			type: 'FILTER_CONTRIBUTOR_CHANGED',
			action,
			filterId,
			filterName: filter?.name,
			contributor: input.userId !== undefined ? { type: 'user', userId: input.userId } : { type: 'role', roleId: input.roleId! },
			actor: { type: 'slm-user', userId: ctx.user.discordId },
			serverId: null,
			matchId: null,
			causeId: null,
		}),
	)
}

async function selectFilters(ctx: C.Db) {
	return (await ctx.db().select().from(Schema.filters)).map((row) => F.FilterEntitySchema.parse(row))
}

// Recomputed rather than maintained incrementally: it is read when a filter page is opened or something changes,
// and the whole set of filters and server pool configs is small enough that a full rebuild is cheaper than
// keeping an incremental one honest.
export async function computeReferenceIndex(ctx: C.Db): Promise<FR.Index> {
	const [filters, servers] = await Promise.all([selectFilters(ctx), Settings.listServerPoolConfigs(ctx)])
	return FR.buildIndex(filters, servers)
}

// the live reference index every client watches. Assigned in setup, since it needs a db context.
export let filterReferences$!: Rx.Observable<FR.Index>

// The write itself, without the permission check. The rpc handler and the shared-draft save path
// (filter-edit.server.ts) both go through here, so a filter is only ever written one way.
export async function updateFilter(ctx: C.Db & USR.Ctx.Id & CS.AbortSignal, id: F.FilterEntityId, update: Partial<F.FilterEntityUpdate>) {
	const res = await DB.runTransaction(ctx, async (ctx) => {
		const [rawFilter] = await ctx.db().select().from(Schema.filters).where(E.eq(Schema.filters.id, id))
		if (!rawFilter) {
			return { code: 'err:not-found' as const }
		}
		if (update.filter) {
			// the tree the engine sees is the referenced filters inlined, so a loop among them has no
			// fixed point: it has to be refused at the point it would be written
			const candidates = (await selectFilters(ctx)).map((f) => (f.id === id ? { ...f, ...update } : f))
			const cycle = FR.findCycle(candidates, id)
			if (cycle) return { code: 'err:cyclical-reference' as const, cycle }
		}
		const updateResult = await ctx.db().update(Schema.filters).set(update).where(E.eq(Schema.filters.id, id))

		if (updateResult.changes === 0) {
			throw new Orpc.ORPCError('INTERNAL_SERVER_ERROR', {
				message: 'Unable to update filter',
			})
		}
		const filter = F.FilterEntitySchema.parse(rawFilter)
		return { code: 'ok' as const, filter: { ...filter, ...update }, prevFilter: filter }
	})
	// res carries the whole filter entity (AST included); flattening that into attributes wrote a key
	// per node of the filter tree on every update, at info level
	log.info({ [ATTRS.Filter.ID]: id, [ATTRS.Filter.OUTCOME]: res.code }, 'Updated filter %s: %s', id, res.code)
	if (res.code === 'ok') {
		filterMutation$.next([
			CS.storeLinkToActiveSpan(ctx, 'event.emitter'),
			{
				type: 'update',
				key: id,
				value: res.filter,
				userId: ctx.user.discordId,
			},
		])
		// the update is a partial, and a field resubmitted unchanged isn't a change worth recording
		const changedFields = Object.keys(update).filter(
			(field) => !Obj.deepEqual((res.prevFilter as Record<string, unknown>)[field], (update as Record<string, unknown>)[field]),
		)
		await recordFilterChange(ctx, 'updated', id, { filterName: res.filter.name, changedFields })
	}
	return res
}

export const filtersRouter = {
	// users and roles are read separately: joining both onto the filter crosses them, so each user came back
	// once per role and each role once per user
	getFilterContributors: orpcBase.input(F.FilterEntityIdSchema).handler(async ({ input, context: ctx }) => {
		const contributingUserIds = ctx
			.db()
			.select({ userId: Schema.filterUserContributors.userId })
			.from(Schema.filterUserContributors)
			.where(E.eq(Schema.filterUserContributors.filterId, input))
		const userRows = await Users.selectUsers(ctx).where(E.inArray(Schema.users.discordId, contributingUserIds))
		const roleRows = await ctx
			.db()
			.select({ roleId: Schema.filterRoleContributors.roleId })
			.from(Schema.filterRoleContributors)
			.where(E.eq(Schema.filterRoleContributors.filterId, input))

		return {
			users: await Users.buildUsers(userRows),
			roles: roleRows.map((row) => row.roleId),
		}
	}),

	getAllFilterRoleContributors: orpcBase.handler(async ({ context: ctx }) => {
		const rows = await ctx.db().select().from(Schema.filterRoleContributors)

		return rows
	}),

	addFilterContributor: orpcBase
		.meta({ type: 'mutation' })
		.input(ToggleFilterContributorInputSchema)
		.handler(async ({ input, context: ctx }) => {
			const denyRes = await denyUnlessFilterOwner(ctx, input.filterId)
			if (denyRes) {
				return denyRes
			}

			if (input.userId) {
				const res = await returnInsertErrors(
					ctx.db().insert(Schema.filterUserContributors).values({
						filterId: input.filterId,
						userId: input.userId,
					}),
				)
				switch (res.code) {
					case 'err:already-exists':
						return { code: 'err:already-exists' as const }
					case 'ok':
						await recordFilterContributor(ctx, 'added', input.filterId, input)
						// this user gained the filter-user-contributor inferred role
						Rbac.invalidateUser(input.userId)
						return { code: 'ok' as const }
					default:
						assertNever(res)
				}
			} else {
				const res = await returnInsertErrors(
					ctx.db().insert(Schema.filterRoleContributors).values({
						filterId: input.filterId,
						roleId: input.roleId!,
					}),
				)
				switch (res.code) {
					case 'err:already-exists':
						return { code: 'err:already-exists' as const }
					case 'ok':
						await recordFilterContributor(ctx, 'added', input.filterId, input)
						// every holder of this role gains the filter-role-contributor inferred role
						Rbac.invalidateAll()
						return { code: 'ok' as const }
					default:
						assertNever(res)
				}
			}
		}),
	removeFilterContributor: orpcBase
		.meta({ type: 'mutation' })
		.input(ToggleFilterContributorInputSchema)
		.handler(async ({ input, context: ctx }) => {
			const denyRes = await denyUnlessFilterOwner(ctx, input.filterId)
			if (denyRes) {
				return denyRes
			}
			let query: any
			if (input.userId) {
				query = ctx
					.db()
					.delete(Schema.filterUserContributors)
					.where(
						E.and(
							E.eq(Schema.filterUserContributors.filterId, input.filterId),
							E.eq(Schema.filterUserContributors.userId, input.userId!),
						),
					)
			} else {
				query = ctx
					.db()
					.delete(Schema.filterRoleContributors)
					.where(
						E.and(
							E.eq(Schema.filterRoleContributors.filterId, input.filterId),
							E.eq(Schema.filterRoleContributors.roleId, input.roleId!),
						),
					)
			}

			const resultSet = await query
			if (resultSet.changes === 0) {
				return { code: 'err:not-found' as const }
			}

			await recordFilterContributor(ctx, 'removed', input.filterId, input)
			// mirror addFilterContributor: a user contributor is targeted, a role contributor affects every holder
			if (input.userId) Rbac.invalidateUser(input.userId)
			else Rbac.invalidateAll()
			return { code: 'ok' as const }
		}),
	createFilter: orpcBase
		.meta({ type: 'mutation' })
		.input(F.NewFilterEntitySchema)
		.handler(async ({ input, context: ctx }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('filters:create'))
			if (denyRes) {
				return denyRes
			}
			const newFilterEntity: F.FilterEntity = {
				...input,
				owner: ctx.user.discordId,
			}
			// a filter can name one that doesn't exist yet, so creating that filter is a way to close a loop
			const cycle = FR.findCycle([...(await selectFilters(ctx)), newFilterEntity], newFilterEntity.id)
			if (cycle) return { code: 'err:cyclical-reference' as const, cycle }
			const res = await returnInsertErrors(ctx.db().insert(Schema.filters).values(newFilterEntity))
			if (res.code === 'ok') {
				filterMutation$.next([
					CS.storeLinkToActiveSpan(ctx, 'event.emitter'),
					{
						type: 'add',
						key: newFilterEntity.id,
						value: newFilterEntity,
						userId: ctx.user.discordId,
					},
				])
				await recordFilterChange(ctx, 'created', newFilterEntity.id, { filterName: newFilterEntity.name })
				// the creator is now this filter's owner (filter-owner inferred role), so their cached perms are stale
				Rbac.invalidateUser(ctx.user.discordId)
			}
			return {
				code: 'ok' as const,
			}
		}),
	updateFilter: orpcBase
		.meta({ type: 'mutation' })
		.input(z.tuple([F.FilterEntityIdSchema, F.UpdateFilterEntitySchema.partial()]))
		.handler(async ({ input, context: ctx }) => {
			const [id, update] = input
			// resolved before the transaction, as createFilter and deleteFilter already do: the check reaches discord
			// over the network to resolve the user's roles, and the tx lock is global
			const deniedRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.getWritePermReqForFilterEntity(id))
			if (deniedRes) {
				return deniedRes
			}
			return await updateFilter(ctx, id, update)
		}),
	deleteFilter: orpcBase
		.meta({ type: 'mutation' })
		.input(F.FilterEntityIdSchema)
		.handler(async ({ input: idToDelete, context: ctx }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.getWritePermReqForFilterEntity(idToDelete))
			if (denyRes) {
				return denyRes
			}

			// every way a filter can still be pointed at, so that nothing is left dangling by the delete. Extra
			// filters are not among them: they are pruned client-side once the filter is gone.
			const references = FR.referencesFor(await computeReferenceIndex(ctx), idToDelete)
			if (references.length > 0) {
				return { code: 'err:filter-in-use' as const, references }
			}

			const res = await DB.runTransaction(ctx, async (ctx) => {
				const [rawFilter] = await ctx.db().select().from(Schema.filters).where(E.eq(Schema.filters.id, idToDelete))
				if (!rawFilter) {
					return { code: 'err:filter-not-found' as const }
				}
				const filter = F.FilterEntitySchema.parse(rawFilter)
				// captured before the delete so the affected inferred-role holders can be invalidated after commit
				const userContributors = await ctx
					.db()
					.select({ userId: Schema.filterUserContributors.userId })
					.from(Schema.filterUserContributors)
					.where(E.eq(Schema.filterUserContributors.filterId, idToDelete))
				const [roleContributor] = await ctx
					.db()
					.select({ roleId: Schema.filterRoleContributors.roleId })
					.from(Schema.filterRoleContributors)
					.where(E.eq(Schema.filterRoleContributors.filterId, idToDelete))
					.limit(1)
				await ctx.db().delete(Schema.filters).where(E.eq(Schema.filters.id, idToDelete))
				return {
					code: 'ok' as const,
					filter,
					userContributorIds: userContributors.map((r) => r.userId),
					hasRoleContributors: !!roleContributor,
				}
			})
			if (res.code !== 'ok') {
				return res
			}
			// owner + user contributors lose their inferred roles; a role contributor affects every holder of that role
			if (res.hasRoleContributors) Rbac.invalidateAll()
			else {
				Rbac.invalidateUser(res.filter.owner)
				for (const userId of res.userContributorIds) Rbac.invalidateUser(userId)
			}
			filterMutation$.next([
				CS.storeLinkToActiveSpan(ctx, 'event.emitter'),
				{
					type: 'delete',
					key: idToDelete,
					userId: ctx.user.discordId,
					value: res.filter,
				},
			])
			await recordFilterChange(ctx, 'deleted', idToDelete, { filterName: res.filter.name })
			return { code: 'ok' as const }
		}),
	watchFilters: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ context, signal }) {
		yield* watchFilters({ ctx: context, signal })
	}),

	watchFilterReferences: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ signal }) {
		yield* Rx.Ext.toAsyncGenerator(filterReferences$.pipe(Rx.Ext.withAbortSignal(signal!)))
	}),

	changeFilterOwner: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ filterId: F.FilterEntityIdSchema, newOwner: USR.UserIdSchema }))
		.handler(async ({ input, context: ctx }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.getManagePermReqForFilterEntity(input.filterId))
			if (denyRes) {
				return denyRes
			}

			const res = await DB.runTransaction(ctx, async (ctx) => {
				const [rawFilter] = await ctx.db().select().from(Schema.filters).where(E.eq(Schema.filters.id, input.filterId))
				if (!rawFilter) {
					return { code: 'err:filter-not-found' as const }
				}
				const filter = F.FilterEntitySchema.parse(rawFilter)
				if (filter.owner === input.newOwner) {
					return {
						code: 'err:user-already-owns-filter' as const,
					}
				}
				await ctx.db().update(Schema.filters).set({ owner: input.newOwner }).where(E.eq(Schema.filters.id, input.filterId))
				return { code: 'ok' as const, filter }
			})
			if (res.code !== 'ok') return res
			// filter-owner moved: the old owner loses the inferred role, the new owner gains it
			Rbac.invalidateUser(res.filter.owner)
			Rbac.invalidateUser(input.newOwner)
			filterMutation$.next([
				CS.storeLinkToActiveSpan(ctx, 'event.emitter'),
				{
					type: 'update',
					key: input.filterId,
					value: res.filter,
					userId: ctx.user.discordId,
				},
			])
		}),
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
	const ids = [...new Set(Array.from(state.filters.values()).map((f) => f.owner))]

	const dbUsers = await Users.selectUsers(ctx).where(E.inArray(Schema.users.discordId, ids))

	yield {
		code: 'initial-value' as const,
		entities: Array.from(state.filters.values()),
		parts: {
			users: await Users.buildUsers(dbUsers),
		},
	}
	for await (const [ctx, mutation] of Rx.Ext.toAsyncGenerator(filterMutation$.pipe(Rx.Ext.withAbortSignal(signal!)))) {
		const dbUsers = await Users.selectUsers(ctx).where(
			E.inArray(Schema.users.discordId, [...new Set([mutation.value.owner, mutation.userId])]),
		)
		const users = await Users.buildUsers(dbUsers)

		yield {
			code: 'mutation' as const,
			mutation,
			parts: {
				users,
			},
		}
	}
}

export async function setup() {
	log = module.getLogger()
	const ctx = DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal })
	const filterRows = await selectFilters(ctx)
	state = {
		filters: new Map(filterRows.map((filter) => [filter.id, filter])),
	}
	filterReferences$ = Rx.merge(
		Rx.of(null),
		filterMutation$,
		// a pool config lives in a server's settings, and the registry decides which servers there are
		Settings.settings$.pipe(Rx.filter((e) => e.scope === 'server' || e.scope === 'registry')),
	).pipe(
		// a settings write broadcasts once per changed scope, and a filter mutation lands beside it; one rebuild covers the burst
		Rx.debounceTime(0),
		Rx.concatMap(() => computeReferenceIndex(ctx)),
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
			mutation: USR.UserEntityMutation<F.FilterEntityId, F.FilterEntity>
	  }
