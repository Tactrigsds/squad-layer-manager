import { baseLogger } from '@/systems/logger.client.ts'
import { onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/ws'
import { orpcAppRouter } from './orpc-app-router.ts'

export const orpcHandler = new RPCHandler(orpcAppRouter, {
	interceptors: [
		onError((error, { context: ctx }) => {
			baseLogger.error(error)
		}),
	],
})
