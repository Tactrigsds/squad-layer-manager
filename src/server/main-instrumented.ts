import * as Cli from '@/systems/cli.server'
import { sdk as otelSdk, setupOtel } from '@/systems/otel.server'

import * as Env from './env.ts'

await Cli.ensureCliParsed()
Env.ensureEnvSetup()

const ENV = Env.getEnvBuilder({
	OTEL_ENABLED: Env.groups.otel.OTEL_ENABLED,
})()

if (ENV.OTEL_ENABLED) {
	// setupOtel registers sdk.shutdown() with cleanup.server, which runs it on SIGTERM.
	setupOtel()

	otelSdk.start()

	console.log('instrumentation setup complete')
} else {
	console.log('OpenTelemetry disabled via OTEL_ENABLED=false')
}

await import('./main.ts')
