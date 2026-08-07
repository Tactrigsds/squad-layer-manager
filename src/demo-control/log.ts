import pino from 'pino'

import * as ControlEnv from './env.ts'

// The control plane keeps its own pino rather than reaching for src/server/logger.ts: that one is wired to the
// app's env schema and otel module registry, neither of which describe this process.

let base: pino.Logger | undefined

export function setup() {
	base = pino({ level: ControlEnv.get().DEMO_LOG_LEVEL })
}

export function forModule(name: string): pino.Logger {
	if (!base) throw new Error('demo-control logger read before setup')
	return base.child({ module: name })
}
