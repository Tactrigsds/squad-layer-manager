import { sdk as otelSdk, setupOtel } from '@/systems/otel.server'

import * as Cli from '@/systems/cli.server'
import * as Config from './config.ts'
import * as Env from './env.ts'

await Cli.ensureCliParsed()
Env.ensureEnvSetup()
await Config.ensureSetup()

const ENV = Env.getEnvBuilder({ OTEL_ENABLED: Env.groups.general.OTEL_ENABLED })()

if (ENV.OTEL_ENABLED) {
	setupOtel()

	process.on('beforeExit', async () => {
		await otelSdk.shutdown()
	})

	otelSdk.start()

	console.log('instrumentation setup complete')
} else {
	console.log('OpenTelemetry disabled via OTEL_ENABLED=false')
}

await import('./main.ts')
