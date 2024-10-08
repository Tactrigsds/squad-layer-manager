import devtoolsTransport from '@/lib/pino-nodejs-devtools-console-transport.ts'
import pino, { Logger, LoggerOptions } from 'pino'

import { ENV, Env } from './env'

// const projectRoot = path.resolve(__dirname, '..')
// const devtoolsTransportPath = path.join(projectRoot, 'src/lib', 'pino-nodejs-devtools-console-transport')

const ignore = 'pid,hostname,req.remotePort,req.remoteAddress,req.host'

export let baseLogger!: Logger

export async function setupLogger() {
	const envToLogger = {
		development: {
			level: ENV.LOG_LEVEL_OVERRIDE ?? 'debug',
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
	console.log(envToLogger)
	if (ENV.USING_DEVTOOLS) {
		//@ts-expect-error don't need it
		delete baseConfig.transport
		console.log('Using devtools')
		baseLogger = pino(baseConfig, await devtoolsTransport({ ignore }))
	} else {
		baseLogger = pino(baseConfig)
	}
	baseLogger.info(envToLogger, 'Logger set up')
}

export type Logger = typeof baseLogger
