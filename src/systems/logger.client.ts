import pino from 'pino'

import * as LOGS from '@/models/logs'
export const baseLogger = pino({
	level: 'debug',
	browser: {
		// without this an Error passed as the first argument is dropped in its entirety -- pino spreads it, and an
		// Error has no enumerable properties, so `log.error(err, msg)` logs only msg
		serialize: true,
		write: LOGS.showLogEvent as any,
	},
})
