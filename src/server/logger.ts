import pino, { LoggerOptions, Logger as PinoLogger } from 'pino'

import devtoolsTransport from '@/lib/devtools-log-transport.ts'
import { createId } from '@/lib/id'

import { ENV, Env } from './env'

const ignore = 'pid,hostname,req.remotePort,req.remoteAddress,req.host'

export type Logger = PinoLogger
export let baseLogger!: Logger

const serializers = {
	bigint: (n: bigint) => n.toString() + n,
}

export async function setupLogger() {
	const envToLogger = {
		development: {
			level: ENV.LOG_LEVEL_OVERRIDE ?? 'debug',
			serializers,
			base: undefined,
			transport: {
				target: 'pino-pretty',
				options: {
					translateTime: 'HH:MM:ss Z',
					ignore,
				},
			},
		},
		production: {
			level: ENV.LOG_LEVEL_OVERRIDE ?? 'info',
			base: undefined,
			serializers,
		},
	} satisfies { [env in Env['NODE_ENV']]: LoggerOptions }
	const baseConfig = envToLogger[ENV.NODE_ENV]
	if (ENV.USING_DEVTOOLS) {
		// @ts-expect-error don't need it
		delete baseConfig.transport
		baseLogger = pino(baseConfig, await devtoolsTransport({ ignore }))
	} else {
		baseLogger = pino(baseConfig)
	}
	baseLogger = baseLogger.child({ runId: createId(12) })
}
