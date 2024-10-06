import build from 'pino-abstract-transport'

// This transport makes inspecting via Chrome's Node.js DevTools much more pleasant https://blog.logrocket.com/debug-node-js-chrome-devtools-watchers/#running-inspector

const levels = {
	10: 'TRACE',
	20: 'DEBUG',
	30: 'INFO',
	40: 'WARN',
	50: 'ERROR',
	60: 'FATAL',
}

export default async function (opts: { ignore?: string }) {
	opts.ignore ??= ''
	const ignoreFields = opts.ignore ? opts.ignore.split(',') : []

	return build(
		async function (source: AsyncIterable<any>) {
			for await (let obj of source) {
				const level = obj.level as number
				const msg = obj.msg
				obj = { ...obj }

				obj.humanTime = new Date(obj.time).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
				//@ts-expect-error fuck you
				obj.levelStr = levels[level] ?? 'unknown'

				// Remove ignored fields from the log object
				for (const field of ignoreFields) {
					delete obj[field.trim()]
				}

				// Log using the appropriate console method
				switch (level) {
					case 10: // trace
					case 20: // debug
						console.debug(levels[level], `[${obj.humanTime}] ${msg}`, obj)
						break
					case 30: // info
						console.info(levels[level], `[${obj.humanTime}] ${msg}`, obj)
						break
					case 40: // warn
						console.warn(levels[level], `[${obj.humanTime}] ${msg}`, obj)
						break
					case 50: // error
						console.error(levels[level], `[${obj.humanTime}] ${msg}`, obj)
						break
					case 60: // fatal
						console.error(levels[level], `[${obj.humanTime}] ${msg}`, obj)
						break
					default:
						console.log(`UNKNOWN: ${level}`, `[${obj.humanTime}] ${msg}`, obj)
				}
			}
		},
		{
			async close(_: any) {
				// No need to close anything when using console methods
			},
		}
	)
}
