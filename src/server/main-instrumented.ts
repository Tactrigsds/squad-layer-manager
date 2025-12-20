import { sdk as otelSdk, setupOtel } from '@/systems/otel.server'

import * as Config from './config.ts'
import * as Env from './env.ts'
import * as Cli from '@/systems/cli.server'

await Cli.ensureCliParsed()
Env.ensureEnvSetup()
await Config.ensureSetup()

setupOtel()

process.on('beforeExit', async () => {
	await otelSdk.shutdown()
})

otelSdk.start()

console.log('instrumentation setup complete')

await import('./main.ts')
