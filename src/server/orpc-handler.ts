import { StandardRPCSerializer } from '@orpc/client/standard'
import { onError } from '@orpc/server'
import { StandardHandler, StandardRPCCodec, StandardRPCMatcher } from '@orpc/server/standard'
import { WsHandler } from '@orpc/server/ws'

import { FastRPCJsonSerializer } from '@/lib/orpc-json-serializer'

import { initModule } from './logger.ts'
import { orpcAppRouter } from './orpc-app-router.ts'

const module = initModule('orpc-handler')

// RPCHandler from @orpc/server/ws, assembled by hand to swap in the faster json serializer
export const orpcHandler = new WsHandler(
	new StandardHandler(
		orpcAppRouter,
		new StandardRPCMatcher(),
		new StandardRPCCodec(new StandardRPCSerializer(new FastRPCJsonSerializer())),
		{
			interceptors: [
				onError((error) => {
					module.getLogger().error(error)
				}),
			],
		},
	),
)
