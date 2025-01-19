import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { Subject } from 'rxjs'
import { z } from 'zod'

import { toAsyncGenerator } from '@/lib/async'
import { returnInsertErrors } from '@/lib/drizzle'
import * as M from '@/models.ts'
import * as Schema from '@/server/schema.ts'
import { procedure, router } from '@/server/trpc.server.ts'

const filterMutation$ = new Subject<M.UserEntityMutation<M.FilterEntity>>()

export const filtersRouter = router({
	getFilters: procedure.query(async ({ ctx }) => {
		return ctx.db().select().from(Schema.filters) as Promise<M.FilterEntity[]>
	}),
	createFilter: procedure.input(M.FilterEntitySchema).mutation(async ({ input, ctx }) => {
		const res = await returnInsertErrors(ctx.db().insert(Schema.filters).values(input))
		if (res.code === 'ok') {
			filterMutation$.next({
				type: 'add',
				value: input,
				username: ctx.user.username,
			})
		}
		return res.code
	}),
	updateFilter: procedure.input(z.tuple([M.FilterEntityIdSchema, M.FilterUpdateSchema.partial()])).mutation(async ({ input, ctx }) => {
		const [id, update] = input
		const res = await ctx.db().transaction(async (tx) => {
			const [rawFilter] = await tx.select().from(Schema.filters).where(eq(Schema.filters.id, id)).for('update')
			if (!rawFilter) {
				return { code: 'err:not-found' as const }
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
	deleteFilter: procedure.input(M.FilterEntityIdSchema).mutation(async ({ input, ctx }) => {
		const res = await ctx.db().transaction(async (tx) => {
			const [rawFilter] = await tx.select().from(Schema.filters).where(eq(Schema.filters.id, input)).for('update')
			if (!rawFilter) {
				return { code: 'err:filter-not-found' as const }
			}
			const filter = M.FilterEntitySchema.parse(rawFilter)
			await tx.delete(Schema.filters).where(eq(Schema.filters.id, input))
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
		return { code: 'ok' }
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
