import * as Schema from '$root/drizzle/schema.ts'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { returnInsertErrors } from '@/lib/drizzle'
import { assertNever } from '@/lib/type-guards'
import type { Parts } from '@/lib/types'
import type * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import orpcBase from '@/server/orpc-base'

import * as Rbac from '@/server/systems/rbac'
import * as SquadServer from '@/server/systems/squad-server'
import * as Orpc from '@orpc/server'
import { aliasedTable } from 'drizzle-orm'
import * as E from 'drizzle-orm/expressions'
import { Subject } from 'rxjs'
import { z } from 'zod'
import { baseLogger } from '../logger'
import * as Users from './users'

export const filterMutation$ = new Subject<[CS.Log & C.Db, USR.UserEntityMutation<F.FilterEntityId, F.FilterEntity>]>()
const ToggleFilterContributorInputSchema = z
	.object({ filterId: F.FilterEntityIdSchema, userId: z.bigint().optional(), roleId: RBAC.UserDefinedRoleIdSchema.optional() })
	.refine((input) => input.userId || input.roleId, { message: 'Either userId or role must be provided' })
export type ToggleFilterContributorInput = z.infer<typeof ToggleFilterContributorInputSchema>

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
			users: await Users.buildUsers(ctx, rows.map((row) => row.user).filter((user) => user !== null)),
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

	addFilterContributor: orpcBase.input(ToggleFilterContributorInputSchema).handler(async ({ input, context: ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, [
			RBAC.perm('filters:write', { filterId: input.filterId }),
			RBAC.perm('filters:write-all'),
		])
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
					return { code: 'ok' as const }
				default:
					assertNever(res)
			}
		}
	}),
	removeFilterContributor: orpcBase.input(ToggleFilterContributorInputSchema).handler(async ({ input, context: ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.getWritePermReqForFilterEntity(input.filterId))
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

		const [resultSet] = await query
		if (resultSet.affectedRows === 0) {
			return { code: 'err:not-found' as const }
		}

		return { code: 'ok' as const }
	}),
	createFilter: orpcBase.input(F.NewFilterEntitySchema).handler(async ({ input, context: ctx }) => {
		const newFilterEntity: F.FilterEntity = {
			...input,
			owner: ctx.user.discordId,
		}
		const res = await returnInsertErrors(ctx.db().insert(Schema.filters).values(newFilterEntity))
		if (res.code === 'ok') {
			filterMutation$.next([ctx, {
				type: 'add',
				key: newFilterEntity.id,
				value: newFilterEntity,
				username: ctx.user.username,
				displayName: ctx.user.displayName,
			}])
		}
		return {
			code: 'ok' as const,
		}
	}),
	updateFilter: orpcBase
		.input(z.tuple([F.FilterEntityIdSchema, F.UpdateFilterEntitySchema.partial()]))
		.handler(async ({ input, context: ctx }) => {
			const [id, update] = input
			const res = await ctx.db().transaction(async (tx) => {
				const [rawFilter] = await tx.select().from(Schema.filters).where(E.eq(Schema.filters.id, id)).for('update')
				if (!rawFilter) {
					return { code: 'err:not-found' as const }
				}
				const deniedRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.getWritePermReqForFilterEntity(id))
				if (deniedRes) {
					return deniedRes
				}
				const [updateResult] = await tx.update(Schema.filters).set(update).where(E.eq(Schema.filters.id, id))

				if (updateResult.affectedRows === 0) {
					throw new Orpc.ORPCError('INTERNAL_SERVER_ERROR', {
						message: 'Unable to update filter',
					})
				}
				const filter = F.FilterEntitySchema.parse(rawFilter)
				return { code: 'ok' as const, filter: { ...filter, ...update } }
			})
			ctx.log.info(res, 'Updated filter %d', id)
			if (res.code === 'ok') {
				filterMutation$.next([ctx, {
					type: 'update',
					key: id,
					value: res.filter,
					username: ctx.user.username,
					displayName: ctx.user.displayName,
				}])
			}
			return res
		}),
	deleteFilter: orpcBase.input(F.FilterEntityIdSchema).handler(async ({ input: idToDelete, context: ctx }) => {
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
			for (const { filterId } of serverState.settings.queue.mainPool.filters) {
				if (filterId === idToDelete) return { code: 'err:cannot-delete-pool-filter' as const }
			}
			for (const { filterId } of serverState.settings.queue.generationPool.filters) {
				if (filterId === idToDelete) return { code: 'err:cannot-delete-pool-filter' as const }
			}
		}

		const allFilters = (await ctx.db().select().from(Schema.filters)).map((row) => F.FilterEntitySchema.parse(row))

		const referencingFilters = allFilters.filter((f) => f.id != idToDelete && F.filterContainsId(idToDelete, f.filter)).map((f) => f.id)
		if (referencingFilters.length > 0) {
			return { code: 'err:filter-in-use' as const, referencingFilters }
		}

		const res = await ctx.db().transaction(async (tx) => {
			const [rawFilter] = await tx.select().from(Schema.filters).where(E.eq(Schema.filters.id, idToDelete)).for('update')
			if (!rawFilter) {
				return { code: 'err:filter-not-found' as const }
			}
			const filter = F.FilterEntitySchema.parse(rawFilter)
			await tx.delete(Schema.filters).where(E.eq(Schema.filters.id, idToDelete))
			return { code: 'ok' as const, filter }
		})
		if (res.code !== 'ok') {
			return res
		}
		filterMutation$.next([ctx, {
			type: 'delete',
			key: idToDelete,
			username: ctx.user.username,
			displayName: ctx.user.displayName,
			value: res.filter,
		}])
		return { code: 'ok' as const }
	}),
	watchFilters: orpcBase.handler(async function*({ context, signal }) {
		yield* watchFilters({ ctx: context, signal })
	}),
}

export let state!: {
	filters: Map<string, F.FilterEntity>
}

export async function* watchFilters(
	{ ctx, signal }: { ctx: CS.Log & C.Db; signal?: AbortSignal },
): AsyncGenerator<FilterEntityChange & Parts<USR.UserPart>, void, unknown> {
	const ids = [...new Set(Array.from(state.filters.values()).map(f => f.owner))]

	const dbUsers = await ctx.db().select().from(Schema.users).where(E.inArray(Schema.users.discordId, ids))

	yield {
		code: 'initial-value' as const,
		entities: Array.from(state.filters.values()),
		parts: {
			users: await Users.buildUsers(ctx, dbUsers),
		},
	}
	for await (const [ctx, mutation] of toAsyncGenerator(filterMutation$.pipe(withAbortSignal(signal!)))) {
		const dbUsers = await ctx.db().select().from(Schema.users).where(
			E.or(E.eq(Schema.users.discordId, mutation.value.owner), E.eq(Schema.users.username, mutation.username)),
		)
		const users = await Users.buildUsers(ctx, dbUsers)

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
	const ctx = DB.addPooledDb({ log: baseLogger })
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
