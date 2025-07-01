import * as LOGS from '@/models/logs'
import pino from 'pino'
export const baseLogger = pino({
	browser: {
		write: LOGS.showLogEvent,
	},
})
