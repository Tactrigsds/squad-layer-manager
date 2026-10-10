import pino from 'pino'

import * as LOG from '@/models/logs.models'

export function createLogger(forward?: (event: LOG.LogEvent) => void) {
	return pino({
		level: 'debug',
		browser: {
			// without this an Error passed as the first argument is dropped in its entirety -- pino spreads it, and an
			// Error has no enumerable properties, so `log.error(err, msg)` logs only msg
			serialize: true,
			write: ((event: LOG.LogEvent) => {
				LOG.showLogEvent(event)
				forward?.(event)
			}) as any,
		},
	})
}

export const baseLogger = createLogger()
