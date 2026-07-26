import pino from 'pino'

import * as LOGS from '@/models/logs'
export const baseLogger = pino({
	level: 'debug',
	browser: {
		write: LOGS.showLogEvent as any,
	},
})
