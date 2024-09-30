import { createContext } from '@/context'
import { Crypto } from '@peculiar/webcrypto'
import { FastifyTRPCPluginOptions, fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import fastify from 'fastify'

import { type AppRouter, appRouter } from './router'

globalThis.crypto = new Crypto()

const server = fastify({
	maxParamLength: 5000,
})
server.register(fastifyTRPCPlugin, {
	prefix: '/trpc',
	trpcOptions: {
		router: appRouter,
		createContext,
		onError({ path, error }) {
			// report to error monitoring
			console.error(`Error in tRPC handler on path '${path}':`, error)
		},
	} satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
})
;(async () => {
	try {
		const port = 3000
		await server.listen({ port })
		console.log('listening on port ', port)
	} catch (err) {
		server.log.error(err)
		process.exit(1)
	}
})()
