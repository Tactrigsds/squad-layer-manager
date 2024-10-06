import devtoolsTransport from '@/lib/pino-nodejs-devtools-console-transport.ts'
import path from 'path'
import pino, { LoggerOptions } from 'pino'

import { ENV, Env } from './env'

// const projectRoot = path.resolve(__dirname, '..')
// const devtoolsTransportPath = path.join(projectRoot, 'src/lib', 'pino-nodejs-devtools-console-transport')

const ignore = 'pid,hostname,req.remotePort,req.remoteAddress,req.host,time'
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
export const baseConfig = envToLogger[ENV.NODE_ENV]

const logger = pino(ENV.USING_DEVTOOLS ? await devtoolsTransport({ ignore }) : baseConfig)

export default logger
