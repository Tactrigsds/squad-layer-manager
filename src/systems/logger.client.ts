import pino from 'pino'

import * as LOGS from '@/models/logs'

export function createLogger(forward?: (event: LOGS.LogEvent) => void) {
	return pino({
		level: 'debug',
		browser: {
			// without this an Error passed as the first argument is dropped in its entirety -- pino spreads it, and an
			// Error has no enumerable properties, so `log.error(err, msg)` logs only msg
			serialize: true,
			write: ((event: LOGS.LogEvent) => {
				LOGS.showLogEvent(event)
				forward?.(event)
			}) as any,
		},
	})
}

export const baseLogger = createLogger()
