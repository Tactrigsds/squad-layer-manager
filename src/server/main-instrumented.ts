import { sdk as otelSdk, setupOtel } from '@/server/systems/otel.ts'

import * as Config from './config.ts'
import * as Env from './env.ts'
import * as Cli from './systems/cli.ts'

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
