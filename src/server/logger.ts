import devtoolsTransport from '@/lib/pino-nodejs-devtools-console-transport.ts'
import pino, { Logger, LoggerOptions } from 'pino'

import { ENV, Env } from './env'

// const projectRoot = path.resolve(__dirname, '..')
// const devtoolsTransportPath = path.join(projectRoot, 'src/lib', 'pino-nodejs-devtools-console-transport')

const ignore = 'pid,hostname,req.remotePort,req.remoteAddress,req.host'
const envToLogger = {
	development: {
		level: 'debug',
		transport: {
			target: 'pino-pretty',
			options: {
				translateTime: 'HH:MM:ss Z',
				ignore,
			},
		},
	},
} satisfies { [env in Env['NODE_ENV']]: LoggerOptions }

export let baseConfig!: (typeof envToLogger)[Env['NODE_ENV']]
export let baseLogger!: Logger

export async function setupLogger() {
	baseConfig = envToLogger[ENV.NODE_ENV]
	if (ENV.USING_DEVTOOLS) {
		baseLogger = pino({ level: 'debug' }, await devtoolsTransport({ ignore }))
	} else {
		baseLogger = pino(baseConfig)
	}
}

export type Logger = typeof baseLogger
