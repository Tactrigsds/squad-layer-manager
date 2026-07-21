import * as Schema from '$root/drizzle/schema.ts'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { returnInsertErrors } from '@/lib/drizzle'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import type { Parts } from '@/lib/types'
import * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as ATTRS from '@/models/otel-attrs'

import * as AppEvents from '@/models/app-events.models'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import * as AppEventsSys from '@/systems/app-events.server'

import { IsolatedSubject } from '@/lib/isolated-subject'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Users from '@/systems/users.server'
import * as Orpc from '@orpc/server'
import { aliasedTable } from 'drizzle-orm'
import * as E from 'drizzle-orm'
import { z } from 'zod'

const module = initModule('filter-entity')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export const filterMutation$ = new IsolatedSubject<[C.Db & C.OtelCtx, USR.UserEntityMutation<F.FilterEntityId, F.FilterEntity>]>()
const ToggleFilterContributorInputSchema = z
	.object({ filterId: F.FilterEntityIdSchema, userId: z.bigint().optional(), roleId: RBAC.UserDefinedRoleIdSchema.optional() })
	.refine((input) => input.userId || input.roleId, {
		error: 'Either userId or role must be provided',
	})
export type ToggleFilterContributorInput = z.infer<typeof ToggleFilterContributorInputSchema>

async function recordFilterChange(
	ctx: C.Db & C.UserId,
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
async function denyUnlessFilterOwner(ctx: C.Db & C.UserId, filterId: F.FilterEntityId) {
	const [filter] = await ctx.db().select({ owner: Schema.filters.owner }).from(Schema.filters).where(E.eq(Schema.filters.id, filterId))
	if (filter && filter.owner === ctx.user.discordId) return null
	return Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('filters:write-all'))
}

async function recordFilterContributor(
	ctx: C.Db & C.UserId,
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
			contributor: input.userId !== undefined
				? { type: 'user', userId: input.userId }
				: { type: 'role', roleId: input.roleId! },
			actor: { type: 'slm-user', userId: ctx.user.discordId },
			serverId: null,
			matchId: null,
			causeId: null,
		}),
	)
}

export const filtersRouter = {
	getFilterContributors: orpcBase.input(F.FilterEntityIdSchema).handler(async ({ input, context: ctx }) => {
		const userContributors = aliasedTable(Schema.users, 'contributingUsers')
		const rows = await ctx
			.db()
			.select({
				user: userContributors,
				role: Schema.filterRoleContributors.roleId,
			})
			.from(Schema.filters)
			.where(E.eq(Schema.filters.id, input))
			.leftJoin(Schema.filterUserContributors, E.eq(Schema.filterUserContributors.filterId, input))
			.leftJoin(userContributors, E.eq(userContributors.discordId, Schema.filterUserContributors.userId))
			.leftJoin(Schema.filterRoleContributors, E.eq(Schema.filterRoleContributors.filterId, input))

		return {
			users: await Users.buildUsers(rows.map((row) => row.user).filter((user) => user !== null)),
			roles: rows.map((row) => row.role).filter((role) => role !== null),
		}
	}),

	getAllFilterRoleContributors: orpcBase.handler(async ({ context: ctx }) => {
		const rows = await ctx
			.db()
			.select()
			.from(Schema.filterRoleContributors)

		return rows
	}),

	addFilterContributor: orpcBase.meta({ type: 'mutation' }).input(ToggleFilterContributorInputSchema).handler(
		async ({ input, context: ctx }) => {
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
						return { code: 'ok' as const }
					default:
						assertNever(res)
				}
			}
		},
	),
	removeFilterContributor: orpcBase.meta({ type: 'mutation' }).input(ToggleFilterContributorInputSchema).handler(
		async ({ input, context: ctx }) => {
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
						E.and(E.eq(Schema.filterUserContributors.filterId, input.filterId), E.eq(Schema.filterUserContributors.userId, input.userId!)),
					)
			} else {
				query = ctx
					.db()
					.delete(Schema.filterRoleContributors)
					.where(
						E.and(E.eq(Schema.filterRoleContributors.filterId, input.filterId), E.eq(Schema.filterRoleContributors.roleId, input.roleId!)),
					)
			}

			const resultSet = await query
			if (resultSet.changes === 0) {
				return { code: 'err:not-found' as const }
			}

			await recordFilterContributor(ctx, 'removed', input.filterId, input)
			return { code: 'ok' as const }
		},
	),
	createFilter: orpcBase.meta({ type: 'mutation' }).input(F.NewFilterEntitySchema).handler(async ({ input, context: ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('filters:create'))
		if (denyRes) {
			return denyRes
		}
		const newFilterEntity: F.FilterEntity = {
			...input,
			owner: ctx.user.discordId,
		}
		const res = await returnInsertErrors(ctx.db().insert(Schema.filters).values(newFilterEntity))
		if (res.code === 'ok') {
			filterMutation$.next([C.storeLinkToActiveSpan(ctx, 'event.emitter'), {
				type: 'add',
				key: newFilterEntity.id,
				value: newFilterEntity,
				userId: ctx.user.discordId,
			}])
			await recordFilterChange(ctx, 'created', newFilterEntity.id, { filterName: newFilterEntity.name })
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
			const res = await DB.runTransaction(ctx, async (ctx) => {
				const [rawFilter] = await ctx.db().select().from(Schema.filters).where(E.eq(Schema.filters.id, id))
				if (!rawFilter) {
					return { code: 'err:not-found' as const }
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
				filterMutation$.next([C.storeLinkToActiveSpan(ctx, 'event.emitter'), {
					type: 'update',
					key: id,
					value: res.filter,
					userId: ctx.user.discordId,
				}])
				// the update is a partial, and a field resubmitted unchanged isn't a change worth recording
				const changedFields = Object.keys(update).filter(
					(field) => !Obj.deepEqual((res.prevFilter as Record<string, unknown>)[field], (update as Record<string, unknown>)[field]),
				)
				await recordFilterChange(ctx, 'updated', id, { filterName: res.filter.name, changedFields })
			}
			return res
		}),
	deleteFilter: orpcBase.meta({ type: 'mutation' }).input(F.FilterEntityIdSchema).handler(async ({ input: idToDelete, context: ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.getWritePermReqForFilterEntity(idToDelete))
		if (denyRes) {
			return denyRes
		}

		for (const serverId of SquadServer.globalState.slices.keys()) {
			const serverCtx = SquadServer.resolveSliceCtx(ctx, serverId)
			const serverState = await SquadServer.getServerState(serverCtx)
			// TODO: right now we are not handling sub-filters here. we should do the following:
			// 1. implement method to return the ids of all transient filters, while checking for cyclical dependencies
			// 2. disallow any dependent filters from those applied in the filter pool from being deleted
			// 3. include a filter entity status notification(novel concept at time of writing) on the filter-edit screen that indicates that this filter is part of the currently active layer pool setup
			const mainPool = serverState.settings.queue.mainPool
			const referencedIds = [
				...(mainPool.poolFilter ? [mainPool.poolFilter.filterId] : []),
				...mainPool.indicateMatches,
				...mainPool.indicateMisses,
				...[...mainPool.defaultSelectable, ...mainPool.warnFor, ...mainPool.constrainGeneration].map((c) => c.filterId),
			]
			if (referencedIds.includes(idToDelete)) return { code: 'err:cannot-delete-pool-filter' as const }
		}

		const allFilters = (await ctx.db().select().from(Schema.filters)).map((row) => F.FilterEntitySchema.parse(row))

		const referencingFilters = allFilters.filter((f) => f.id != idToDelete && F.filterContainsId(idToDelete, f.filter)).map((f) => f.id)
		if (referencingFilters.length > 0) {
			return { code: 'err:filter-in-use' as const, referencingFilters }
		}

		const res = await DB.runTransaction(ctx, async (ctx) => {
			const [rawFilter] = await ctx.db().select().from(Schema.filters).where(E.eq(Schema.filters.id, idToDelete))
			if (!rawFilter) {
				return { code: 'err:filter-not-found' as const }
			}
			const filter = F.FilterEntitySchema.parse(rawFilter)
			await ctx.db().delete(Schema.filters).where(E.eq(Schema.filters.id, idToDelete))
			return { code: 'ok' as const, filter }
		})
		if (res.code !== 'ok') {
			return res
		}
		filterMutation$.next([C.storeLinkToActiveSpan(ctx, 'event.emitter'), {
			type: 'delete',
			key: idToDelete,
			userId: ctx.user.discordId,
			value: res.filter,
		}])
		await recordFilterChange(ctx, 'deleted', idToDelete, { filterName: res.filter.name })
		return { code: 'ok' as const }
	}),
	watchFilters: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ context, signal }) {
		yield* watchFilters({ ctx: context, signal })
	}),
}

export let state!: {
	filters: Map<string, F.FilterEntity>
}

export async function* watchFilters(
	{ ctx, signal }: { ctx: C.Db; signal?: AbortSignal },
): AsyncGenerator<FilterEntityChange & Parts<USR.UserPart>, void, unknown> {
	const ids = [...new Set(Array.from(state.filters.values()).map(f => f.owner))]

	const dbUsers = await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, ids))

	yield {
		code: 'initial-value' as const,
		entities: Array.from(state.filters.values()),
		parts: {
			users: await Users.buildUsers(dbUsers),
		},
	}
	for await (const [ctx, mutation] of toAsyncGenerator(filterMutation$.pipe(withAbortSignal(signal!)))) {
		const dbUsers = await ctx.db().select().from(Schema.users).where(
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
	const filterRows = (await ctx.db().select().from(Schema.filters)).map((row) => F.FilterEntitySchema.parse(row))
	state = {
		filters: new Map(filterRows.map(filter => [filter.id, filter])),
	}
	filterMutation$.subscribe(mutation => {
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
