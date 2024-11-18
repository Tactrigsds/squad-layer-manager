import pino, { LoggerOptions, Logger as PinoLogger } from 'pino'

import devtoolsTransport from '@/lib/pino-nodejs-devtools-console-transport.ts'

import { ENV, Env } from './env'

// const projectRoot = path.resolve(__dirname, '..')
// const devtoolsTransportPath = path.join(projectRoot, 'src/lib', 'pino-nodejs-devtools-console-transport')

const ignore = 'pid,hostname,req.remotePort,req.remoteAddress,req.host'

export type Logger = PinoLogger
export let baseLogger!: Logger

export async function setupLogger() {
	const envToLogger = {
		development: {
			level: ENV.LOG_LEVEL_OVERRIDE ?? 'debug',
			serializers: {
				bigint: (n: bigint) => n.toString(),
			},
			transport: {
				target: 'pino-pretty',
				options: {
					translateTime: 'HH:MM:ss Z',
					ignore,
				},
			},
		},
	} satisfies { [env in Env['NODE_ENV']]: LoggerOptions }
	const baseConfig = envToLogger[ENV.NODE_ENV]
	if (ENV.USING_DEVTOOLS) {
		//@ts-expect-error don't need it
		delete baseConfig.transport
		baseLogger = pino(baseConfig, await devtoolsTransport({ ignore }))
	} else {
		baseLogger = pino(baseConfig)
	}
}
