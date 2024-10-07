import ws from '@fastify/websocket'
import { FastifyTRPCPluginOptions, fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import fastify from 'fastify'
import fastifySocketIo from 'fastify-socket.io'
import { Server } from 'socket.io'

import { createContext } from './context.ts'
import { setupDatabase } from './db'
import { setupEnv } from './env.ts'
import { baseLogger, setupLogger } from './logger.ts'
import * as TrpcRouter from './router'
import { setupLayerQueue } from './systems/layer-queue.ts'

// --------  system initialization --------
setupEnv()
await setupLogger()
setupDatabase()
setupLayerQueue()

// --------  server configuration --------
const server = fastify({
	maxParamLength: 5000,
	loggerInstance: baseLogger,
})
server.register(ws)
server.register(fastifySocketIo)

server.register(fastifyTRPCPlugin, {
	prefix: '/trpc',
	useWSS: true,
	keepAlive: {
		enabled: true,
		pingMs: 30_000,
		pongWaitMs: 5000,
	},
	trpcOptions: {
		router: TrpcRouter.appRouter,
		createContext: createContext,
		onError({ path, error }) {
			server.log.error(error, `Error in tRPC handler on path '${path}':`)
		},
	} satisfies FastifyTRPCPluginOptions<TrpcRouter.AppRouter>['trpcOptions'],
})

server.ready((err) => {
	if (err) throw err
	server.io.on('connection', (socket) => {
		console.info('Socket connected!', socket.id)
		socket.on('hello', (data: any) => {
			console.log('hello', data)
		})

		socket.on('error', (error) => {
			console.error('error', error)
		})
	})
})

// --------  start server  --------
try {
	const port = 3000
	await server.listen({ port })
	server.log.info('listening on port ', port)
} catch (err) {
	server.log.error(err)
	process.exit(1)
}

declare module 'fastify' {
	interface FastifyInstance {
		io: Server<{ hello: any }>
	}
}
