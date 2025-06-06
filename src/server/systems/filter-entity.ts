import * as Schema from '$root/drizzle/schema.ts'
import { toAsyncGenerator } from '@/lib/async'
import { returnInsertErrors } from '@/lib/drizzle'
import { assertNever } from '@/lib/typeGuards'
import { Parts } from '@/lib/types'
import * as M from '@/models.ts'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import * as LayerQueue from '@/server/systems/layer-queue'
import * as Rbac from '@/server/systems/rbac.system'
import { procedure, router } from '@/server/trpc.server.ts'
import { TRPCError } from '@trpc/server'
import { aliasedTable, and, eq, or } from 'drizzle-orm'
import { Subject } from 'rxjs'
import { z } from 'zod'

export const filterMutation$ = new Subject<[C.Log & C.Db, M.UserEntityMutation<M.FilterEntityId, M.FilterEntity>]>()
const ToggleFilterContributorInputSchema = z
	.object({ filterId: M.FilterEntityIdSchema, userId: z.bigint().optional(), role: RBAC.RoleSchema.optional() })
	.refine((input) => input.userId || input.role, { message: 'Either userId or role must be provided' })
export type ToggleFilterContributorInput = z.infer<typeof ToggleFilterContributorInputSchema>

export const GetFiltersInput = z.object({ parts: z.array(z.literal('users')).optional() }).optional()
export const filtersRouter = router({
	getFilterContributors: procedure.input(M.FilterEntityIdSchema).query(async ({ input, ctx }) => {
		const userContributors = aliasedTable(Schema.users, 'contributingUsers')
		const rows = await ctx
			.db()
			.select({
				user: userContributors,
				role: Schema.filterRoleContributors.roleId,
			})
			.from(Schema.filters)
			.where(eq(Schema.filters.id, input))
			.leftJoin(Schema.filterUserContributors, eq(Schema.filterUserContributors.filterId, input))
			.leftJoin(userContributors, eq(userContributors.discordId, Schema.filterUserContributors.userId))
			.leftJoin(Schema.filterRoleContributors, eq(Schema.filterRoleContributors.filterId, input))

		return {
			users: rows.map((row) => row.user).filter((user) => user !== null),
			roles: rows.map((row) => row.role).filter((role) => role !== null),
		}
	}),
	addFilterContributor: procedure.input(ToggleFilterContributorInputSchema).mutation(async ({ input, ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
			check: 'all',
			permits: [RBAC.perm('filters:write', { filterId: input.filterId }), RBAC.perm('filters:write-all')],
		})
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
					roleId: input.role!,
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
	removeFilterContributor: procedure.input(ToggleFilterContributorInputSchema).mutation(async ({ input, ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, RBAC.getWritePermReqForFilterEntity(input.filterId))
		if (denyRes) {
			return denyRes
		}
		let query: any
		if (input.userId) {
			query = ctx
				.db()
				.delete(Schema.filterUserContributors)
				.where(and(eq(Schema.filterUserContributors.filterId, input.filterId), eq(Schema.filterUserContributors.userId, input.userId!)))
		} else {
			query = ctx
				.db()
				.delete(Schema.filterRoleContributors)
				.where(and(eq(Schema.filterRoleContributors.filterId, input.filterId), eq(Schema.filterRoleContributors.roleId, input.role!)))
		}

		const [resultSet] = await query
		if (resultSet.affectedRows === 0) {
			return { code: 'err:not-found' as const }
		}

		return { code: 'ok' as const }
	}),
	createFilter: procedure.input(M.NewFilterEntitySchema).mutation(async ({ input, ctx }) => {
		const newFilterEntity: M.FilterEntity = {
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
			}])
		}
		return {
			code: 'ok' as const,
		}
	}),
	updateFilter: procedure
		.input(z.tuple([M.FilterEntityIdSchema, M.UpdateFilterEntitySchema.partial()]))
		.mutation(async ({ input, ctx }) => {
			const [id, update] = input
			const res = await ctx.db().transaction(async (tx) => {
				const [rawFilter] = await tx.select().from(Schema.filters).where(eq(Schema.filters.id, id)).for('update')
				if (!rawFilter) {
					return { code: 'err:not-found' as const }
				}
				const deniedRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, RBAC.getWritePermReqForFilterEntity(id))
				if (deniedRes) {
					return deniedRes
				}
				const [updateResult] = await tx.update(Schema.filters).set(update).where(eq(Schema.filters.id, id))

				if (updateResult.affectedRows === 0) {
					throw new TRPCError({
						code: 'INTERNAL_SERVER_ERROR',
						message: 'Unable to update filter',
					})
				}
				const filter = M.FilterEntitySchema.parse(rawFilter)
				return { code: 'ok' as const, filter: { ...filter, ...update } }
			})
			ctx.log.info(res, 'Updated filter %d', id)
			if (res.code === 'ok') {
				filterMutation$.next([ctx, {
					type: 'update',
					key: id,
					value: res.filter,
					username: ctx.user.username,
				}])
			}
			return res
		}),
	deleteFilter: procedure.input(M.FilterEntityIdSchema).mutation(async ({ input: idToDelete, ctx }) => {
		const serverState = await LayerQueue.getServerState({}, ctx)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, RBAC.getWritePermReqForFilterEntity(idToDelete))
		if (denyRes) {
			return denyRes
		}

		// TODO: right now we are not handling sub-filters here. we should do the following:
		// 1. implement method to return the ids of all transient filters, while checking for cyclical dependencies
		// 2. disallow any dependent filters from those applied in the filter pool from being deleted
		// 3. include a filter entity status notification(novel concept at time of writing) on the filter-edit screen that indicates that this filter is part of the currently active layer pool setup
		for (const filterId of serverState.settings.queue.mainPool.filters) {
			if (filterId === idToDelete) return { code: 'err:cannot-delete-pool-filter' as const }
		}
		for (const filterId of serverState.settings.queue.generationPool.filters) {
			if (filterId === idToDelete) return { code: 'err:cannot-delete-pool-filter' as const }
		}

		const allFilters = (await ctx.db().select().from(Schema.filters)).map((row) => M.FilterEntitySchema.parse(row))

		const referencingFilters = allFilters.filter((f) => f.id != idToDelete && M.filterContainsId(idToDelete, f.filter)).map((f) => f.id)
		if (referencingFilters.length > 0) {
			return { code: 'err:filter-in-use' as const, referencingFilters }
		}

		const res = await ctx.db().transaction(async (tx) => {
			const [rawFilter] = await tx.select().from(Schema.filters).where(eq(Schema.filters.id, idToDelete)).for('update')
			if (!rawFilter) {
				return { code: 'err:filter-not-found' as const }
			}
			const filter = M.FilterEntitySchema.parse(rawFilter)
			await tx.delete(Schema.filters).where(eq(Schema.filters.id, idToDelete))
			return { code: 'ok' as const, filter }
		})
		if (res.code !== 'ok') {
			return res
		}
		filterMutation$.next([ctx, {
			type: 'delete',
			key: idToDelete,
			username: ctx.user.username,
			value: res.filter,
		}])
		return { code: 'ok' as const }
	}),
	watchFilters: procedure.subscription(
		async function* watchFilter({ ctx }): AsyncGenerator<WatchFiltersOutput & Parts<M.UserPart>, void, unknown> {
			const rows = await ctx.db().select().from(Schema.filters).leftJoin(
				Schema.users,
				eq(Schema.users.discordId, Schema.filters.owner),
			)

			const users = rows.map((row) => row.users).filter((user) => user !== null)
			const filters = rows.map((row) => M.FilterEntitySchema.parse(row.filters))

			yield {
				code: 'initial-value' as const,
				entities: filters,
				parts: {
					users: users,
				},
			}
			for await (const [ctx, mutation] of toAsyncGenerator(filterMutation$)) {
				// TODO could cache users
				const users = await ctx.db().select().from(Schema.users).where(
					or(eq(Schema.users.discordId, mutation.value.owner), eq(Schema.users.username, mutation.username)),
				)

				yield {
					code: 'mutation' as const,
					mutation,
					parts: {
						users,
					},
				}
			}
		},
	),
})

export type WatchFiltersOutput =
	| {
		code: 'initial-value'
		entities: M.FilterEntity[]
	}
	| {
		code: 'mutation'
		mutation: M.UserEntityMutation<M.FilterEntityId, M.FilterEntity>
	}
