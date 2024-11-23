import stringifyCompact from 'json-stringify-pretty-compact'
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

type OperationNode = {
	type: string
	id: string
	completed: boolean
	error?: any
	logs: any[]
	children: OperationNode[]
}
type Operation = {
	type: string
	id: string
	completed: boolean
	error?: any
	logs: any[]
	parentId: string | null
	children: string[]
}

const operations = new Map<string, Operation>()
operations.set('root', {
	type: 'root',
	id: 'root',
	parentId: null,
	completed: false,
	logs: [],
	children: [],
})

function getConsoleArgs(level: number, obj: any) {
	const humanTime = new Date(obj.time).toLocaleTimeString([], {
		hour12: false,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		// @ts-expect-error wwhy
		fractionalSecondDigits: 3,
	})
	obj = { ...obj }
	const msg = obj.msg
	delete obj.msg
	let opStr = ''
	if (obj.ops) {
		const op = obj.ops[obj.ops.length - 1]
		opStr = op.type + '::' + op.id
	}
	return [levels[level as keyof typeof levels] || 'UNKNOWN', `[${humanTime}]`, opStr, msg, obj]
}

function printLogEntry(level: number, obj: any) {
	const args = getConsoleArgs(level, obj)
	switch (level) {
		case 10: // trace
		case 20: // debug
			console.debug(...args)
			break
		case 30: // info
			console.info(...args)
			break
		case 40: // warn
			console.warn(...args)
			break
		case 50: // error
		case 60: {
			// fatal
			console.error(...args)
			break
		}
		default:
			console.log(`UNKNOWN: ${level}`, ...args.slice(1))
	}
}

function createOperationKey(type: string, id: string) {
	return `${type}::${id}`
}

export default async function (opts: { ignore?: string }) {
	opts.ignore ??= ''
	const ignoreFields = opts.ignore ? opts.ignore.split(',') : []

	return build(
		async function (source: AsyncIterable<any>) {
			for await (let obj of source) {
				const level = obj.level as number
				const msg = obj.msg as string
				obj = { ...obj }

				// @ts-expect-error fuck you
				obj.levelStr = levels[level] ?? 'unknown'

				// Remove ignored fields from the log object
				for (const field of ignoreFields) {
					delete obj[field.trim()]
				}

				try {
					if (obj.ops && obj.ops.length > 0) {
						let parentId = 'root'
						for (let i = 0; i < obj.ops.length; i++) {
							const op = obj.ops[i]
							const key = createOperationKey(op.type, op.id)
							const found = operations.get(key)
							const opError = (msg: string) => {
								return new Error(`Operation ${key} ${msg}`)
							}

							if (i === obj.ops.length - 1) {
								if (msg.endsWith('started')) {
									if (found) {
										throw opError('already exists')
									}
									operations.set(key, {
										...op,
										parentId,
										completed: false,
										logs: [],
										children: [],
									})
									const parent = operations.get(parentId)
									if (parent) {
										parent.children.push(createOperationKey(op.type, op.id))
									}
								} else if (msg.endsWith('completed')) {
									if (!found) {
										throw opError('not found')
									}
									found.completed = true
								} else if (msg.endsWith('failed')) {
									if (!found) {
										throw opError('not found')
									}
									found.completed = true
									found.error = obj.error
								} else {
									if (!found) throw opError('not found')
									const log = { ...obj }
									delete log.ops
									found.logs.push(log)
								}
							} else {
								if (!found) {
									throw opError('not found')
								}
								parentId = key
							}
						}
					}
				} catch (e) {
					console.error(e)
					throw e
				}

				printLogEntry(level, obj)
			}
		},
		{
			async close(_: any) {
				// No need to close anything when using console methods
			},
		}
	)
}

// @ts-expect-error idk
globalThis.OPS = {
	displayStrategy: 'table' as 'json' | 'table' | 'raw',
	ops: operations,

	print(data: any, displayStrategy: 'json' | 'table' | 'raw') {
		displayStrategy ??= this.displayStrategy
		switch (displayStrategy) {
			case 'json':
				console.log(stringifyCompact(data))
				break
			case 'table':
				if (Array.isArray(data)) {
					console.table(data)
				} else {
					console.log(data)
				}
				break
			case 'raw':
				console.log(data)
				break
		}
	},

	inProgress() {
		const uncompleted: Operation[] = []
		operations.forEach((op) => {
			if (!op.completed && op.type !== 'root') {
				uncompleted.push(op)
			}
		})
		return uncompleted
	},

	path(opKey: string) {
		const path: string[] = []
		let current = operations.get(opKey)

		while (current) {
			path.unshift(createOperationKey(current.type, current.id))
			if (current.parentId) {
				current = operations.get(current.parentId)
			} else {
				break
			}
		}

		return path
	},

	findByType(typeStr: string, partialMatch = false) {
		const matches: Operation[] = []
		operations.forEach((op) => {
			if (partialMatch ? op.type.startsWith(typeStr) : op.type === typeStr) {
				matches.push(op)
			}
		})
		return matches
	},

	getTree() {
		const buildTree = (opKey: string): OperationNode => {
			const op = operations.get(opKey)
			if (!op) throw new Error(`Operation ${opKey} not found`)

			return {
				type: op.type,
				id: op.id,
				completed: op.completed,
				error: op.error,
				logs: op.logs,
				children: op.children.map((childKey) => buildTree(childKey)),
			}
		}

		const tree = buildTree('root')
		return tree
	},
	prettyTree() {
		const buildPrettyTree = (opKey: string, indent = '') => {
			const op = operations.get(opKey)
			if (!op) throw new Error(`Operation ${opKey} not found`)

			console.log(
				(op.type === 'root' ? '' : indent) +
					createOperationKey(op.type, op.id) +
					` [${op.completed ? (op.error ? 'FAILED' : 'DONE') : 'RUNNING'}]`,
				op.logs.map((log) => getConsoleArgs(log.level, log))
			)

			if (op.children.length > 0) {
				op.children.forEach((childKey, idx) => {
					buildPrettyTree(childKey, indent + '  ')
				})
			}
		}

		buildPrettyTree('root', '')
	},
	getStats() {
		const stats: OpStats = {
			total: 0,
			completed: 0,
			failed: 0,
			inProgress: 0,
			byType: {} as Record<string, { total: number; completed: number; failed: number; inProgress: number }>,
		}

		operations.forEach((op) => {
			if (op.type === 'root') return

			stats.total++
			if (op.completed) {
				if (op.error) {
					stats.failed++
				} else {
					stats.completed++
				}
			} else {
				stats.inProgress++
			}

			if (!stats.byType[op.type]) {
				stats.byType[op.type] = { total: 0, completed: 0, failed: 0, inProgress: 0 }
			}
			stats.byType[op.type].total++
			if (op.completed) {
				if (op.error) {
					stats.byType[op.type].failed++
				} else {
					stats.byType[op.type].completed++
				}
			} else {
				stats.byType[op.type].inProgress++
			}
		})

		return stats
	},
	errored() {
		const errored: Operation[] = []
		operations.forEach((op) => {
			if (op.completed && op.error && op.type !== 'root') {
				errored.push(op)
			}
		})
		return errored
	},
	getLogs(opKeyOrOperation: string | Operation) {
		const logs: any[] = []
		let op: Operation
		if (typeof opKeyOrOperation === 'string') {
			const found = operations.get(opKeyOrOperation)
			if (!found) throw new Error(`Operation ${opKeyOrOperation} not found`)
			op = found
		} else {
			op = opKeyOrOperation
		}

		function collectLogs(operation: Operation) {
			logs.push(...operation.logs)
			for (const childKey of operation.children) {
				const child = operations.get(childKey)
				if (child) {
					collectLogs(child)
				}
			}
		}

		collectLogs(op)

		logs.sort((a, b) => a.time - b.time)
		for (const log of logs) {
			printLogEntry(log.level, log)
		}
	},
	completed() {
		const completed: Operation[] = []
		operations.forEach((op) => {
			if (op.completed && !op.error && op.type !== 'root') {
				completed.push(op)
			}
		})
		completed.sort((a, b) => a.logs[a.logs.length - 1].time - b.logs[b.logs.length - 1].time)
		return completed
	},
}

type OpStats = {
	total: number
	completed: number
	failed: number
	inProgress: number
	byType: Record<string, { total: number; completed: number; failed: number; inProgress: number }>
}
