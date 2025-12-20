import * as LOGS from '@/models/logs'
import pino from 'pino'
export const baseLogger = pino({
	level: 'debug',
	browser: {
		write: LOGS.showLogEvent as any,
	},
})
