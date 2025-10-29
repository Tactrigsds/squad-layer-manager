import { onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/ws'
import { orpcAppRouter } from './router.ts'

export const orpcHandler = new RPCHandler(orpcAppRouter, {
	interceptors: [
		onError((error, { context: ctx }) => {
			ctx.log.error(error)
		}),
	],
})
