import { onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/ws'
import { initModule } from './logger.ts'
import { orpcAppRouter } from './orpc-app-router.ts'

const module = initModule('orpc-handler')

export const orpcHandler = new RPCHandler(orpcAppRouter, {
	interceptors: [
		onError((error) => {
			module.getLogger().error(error)
		}),
	],
})
