import { TRPCError } from '@trpc/server'
import { eq, aliasedTable, and } from 'drizzle-orm'
import { Subject } from 'rxjs'
import { z } from 'zod'

import { toAsyncGenerator } from '@/lib/async'
import * as RBAC from '@/rbac.models'
import * as Rbac from '@/server/systems/rbac.system'
import { returnInsertErrors } from '@/lib/drizzle'
import * as M from '@/models.ts'
import * as Schema from '@/server/schema.ts'
import { procedure, router } from '@/server/trpc.server.ts'
import { assertNever } from '@/lib/typeGuards'
import { Parts } from '@/lib/types'
import * as LayerQueue from '@/server/systems/layer-queue'

const filterMutation$ = new Subject<M.UserEntityMutation<M.FilterEntity>>()
const ToggleFilterContributorInputSchema = z
	.object({ filterId: M.FilterEntityIdSchema, userId: z.bigint().optional(), role: RBAC.RoleSchema.optional() })
	.refine((input) => input.userId || input.role, { message: 'Either userId or role must be provided' })
export type ToggleFilterContributorInput = z.infer<typeof ToggleFilterContributorInputSchema>

export const GetFiltersInput = z.object({ parts: z.array(z.literal('users')).optional() }).optional()
export const filtersRouter = router({
	getFilters: procedure
		.input(GetFiltersInput)
		.query(async ({ ctx, input }): Promise<{ code: 'ok'; filters: M.FilterEntity[] } & Parts<Partial<M.UserPart>>> => {
			if (input?.parts?.includes('users')) {
				const rows = await ctx.db().select().from(Schema.filters).leftJoin(Schema.users, eq(Schema.users.discordId, Schema.filters.owner))

				const users = rows.map((row) => row.users).filter((user) => user !== null)
				const filters = rows.map((row) => M.FilterEntitySchema.parse(row.filters))

				return {
					code: 'ok' as const,
					filters: filters,
					parts: {
						users: users,
					},
				}
			}
			const filters = (await ctx.db().select().from(Schema.filters)).map((row) => M.FilterEntitySchema.parse(row))
			return {
				code: 'ok' as const,
				filters: filters,
				parts: {},
			}
		}),
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
			check: 'any',
			permits: [RBAC.perm('filters:write', { filterId: input.filterId })],
		})
		if (denyRes) {
			return denyRes
		}

		if (input.userId) {
			const res = await returnInsertErrors(
				ctx.db().insert(Schema.filterUserContributors).values({
					filterId: input.filterId,
					userId: input.userId,
				})
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
				})
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
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
			check: 'any',
			permits: [RBAC.perm('filters:write', { filterId: input.filterId })],
		})
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
			filterMutation$.next({
				type: 'add',
				value: newFilterEntity,
				username: ctx.user.username,
			})
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
				const deniedRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
					check: 'any',
					permits: [RBAC.perm('filters:write', { filterId: id })],
				})
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
				filterMutation$.next({
					type: 'update',
					value: res.filter,
					username: ctx.user.username,
				})
			}
			return res
		}),
	deleteFilter: procedure.input(M.FilterEntityIdSchema).mutation(async ({ input: idToDelete, ctx }) => {
		const serverState = await LayerQueue.getServerState({}, ctx)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
			check: 'any',
			permits: [RBAC.perm('filters:write', { filterId: idToDelete })],
		})
		if (denyRes) {
			return denyRes
		}
		if (idToDelete === serverState.settings.queue.poolFilterId) {
			return { code: 'err:cannot-delete-pool-filter' as const }
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
		filterMutation$.next({
			type: 'delete',
			username: ctx.user.username,
			value: res.filter,
		})
		return { code: 'ok' as const }
	}),
	watchFilter: procedure.input(M.FilterEntityIdSchema).subscription(async function* watchFilter({
		input,
		ctx,
	}): AsyncGenerator<WatchFilterOutput, void, unknown> {
		const [filterRaw] = await ctx.db().select().from(Schema.filters).where(eq(Schema.filters.id, input))
		if (!filterRaw) {
			yield { code: `err:not-found` as const }
		}
		const filter = M.FilterEntitySchema.parse(filterRaw)
		yield { code: 'initial-value' as const, entity: filter }
		for await (const mutation of toAsyncGenerator(filterMutation$)) {
			if (mutation.value.id === input) {
				yield { code: 'mutation' as const, mutation }
			}
			if (mutation.type === 'delete') break
		}
	}),
})

export type WatchFilterOutput =
	| {
			code: 'err:not-found'
	  }
	| {
			code: 'initial-value'
			entity: M.FilterEntity
	  }
	| {
			code: 'mutation'
			mutation: M.UserEntityMutation<M.FilterEntity>
	  }
