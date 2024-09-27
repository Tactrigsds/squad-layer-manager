import * as M from '@/models.ts'
import { ProcessedLayer } from '@/scripts/preprocess.ts'
import { initTRPC } from '@trpc/server'
import { z } from 'zod'

import * as DB from './db.ts'

type User = {
	id: string
	name: string
	bio?: string
}
const users: Record<string, User> = { id_bilbo: { id: 'id_bilbo', name: 'Bilbo Baggins', bio: 'Hobbit' } }
export const t = initTRPC.create()
export const appRouter = t.router({
	getLayersPaginated: t.procedure
		.input(
			z.object({
				pageIndex: z.number().int().min(0),
				pageSize: z.number().int().min(1).max(100),
				sortBy: z.string().optional(),
				sortDesc: z.boolean().optional(),
			})
		)
		.query(async ({ input }) => {
			const { pageIndex, pageSize, sortBy, sortDesc } = input

			const db = await DB.openConnection()

			const offset = pageIndex * pageSize

			let orderClause = ''
			if (sortBy) {
				orderClause = `ORDER BY ${sortBy} ${sortDesc ? 'DESC' : 'ASC'}`
			}

			const layersQuery = `
        SELECT *
        FROM layers
        ${orderClause}
        LIMIT ? OFFSET ?
      `

			const countQuery = 'SELECT COUNT(*) as count FROM layers'

			const [layers, countResult] = await Promise.all([
				db.all<ProcessedLayer>(layersQuery, [pageSize, offset]),
				db.get<{ count: number }>(countQuery),
			])

			const totalCount = countResult?.count || 0

			return {
				layers,
				totalCount,
				pageCount: Math.ceil(totalCount / pageSize),
			}
		}),
	gotRows: t.procedure.query(async () => {
		const c = await DB.openConnection()
		const layers = await c.all('SELECT * FROM layers limit 10')
		return layers as M.ProcessedLayer[]
	}),
	getUserById: t.procedure.input(z.string()).query((opts) => {
		return users[opts.input] // input type is string
	}),
	createUser: t.procedure
		.input(
			z.object({
				name: z.string().min(3),
				bio: z.string().max(142).optional(),
			})
		)
		.mutation((opts) => {
			const id = Date.now().toString()
			const user: User = { id, ...opts.input }
			users[user.id] = user
			return user
		}),
})
// export type definition of API
export type AppRouter = typeof appRouter
