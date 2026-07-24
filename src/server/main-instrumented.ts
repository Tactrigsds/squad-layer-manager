import { sdk as otelSdk, setupOtel } from '@/systems/otel.server'
import { setupPyroscope } from '@/systems/pyroscope.server'

import * as Cli from '@/systems/cli.server'
import * as Env from './env.ts'

await Cli.ensureCliParsed()
Env.ensureEnvSetup()

const ENV = Env.getEnvBuilder({
	OTEL_ENABLED: Env.groups.otel.OTEL_ENABLED,
	PYROSCOPE_ENABLED: Env.groups.pyroscope.PYROSCOPE_ENABLED,
})()

if (ENV.OTEL_ENABLED) {
	// setupOtel registers sdk.shutdown() with cleanup.server, which runs it on SIGTERM. A 'beforeExit'
	// handler used to do the same, but beforeExit never fires on a signal or an explicit exit, so it was
	// only ever a duplicate of the cleanup path in the cases where it fired at all.
	setupOtel()

	otelSdk.start()

	console.log('instrumentation setup complete')
} else {
	console.log('OpenTelemetry disabled via OTEL_ENABLED=false')
}

if (ENV.PYROSCOPE_ENABLED) {
	setupPyroscope()
} else {
	console.log('Pyroscope profiling disabled via PYROSCOPE_ENABLED=false')
}

await import('./main.ts')
