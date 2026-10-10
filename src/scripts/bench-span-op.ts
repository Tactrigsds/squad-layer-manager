import * as Otel from '@opentelemetry/api'
import { node, tracing } from '@opentelemetry/sdk-node'
import { Mutex } from 'async-mutex'
import pino from 'pino'

import * as CS from '@/models/context-shared'
import * as Instr from '@/server/instrumentation'

// Measures the fixed cost spanOp adds to a call, against a recording tracer with no exporter and a logger at
// `info`, as in production. Each scenario awaits N sequential calls of a callback that does no work.
//
// usage: pnpm run script src/scripts/bench-span-op.ts [calls]

const N = Number(process.argv[2] ?? 200_000)

const provider = new node.NodeTracerProvider({ sampler: new tracing.AlwaysOnSampler() })
provider.register()

const log = pino({ level: 'info' }, { write: () => {} })
const module = { name: 'bench', tracer: Otel.trace.getTracer('bench'), getLogger: () => log }

const bare = Instr.spanOp('bare', { module }, async () => 1)

const rconLike = Instr.spanOp(
	'execute',
	{ module, kind: Otel.SpanKind.CLIENT, extraText: (_ctx: CS.Ctx & CS.ServerId, cmd: string) => cmd },
	async (_ctx: CS.Ctx & CS.ServerId, _cmd: string) => ({ code: 'ok' as const }),
)
const rconParent = Instr.spanOp('parent', { module }, async (ctx: CS.Ctx & CS.ServerId) => {
	for (let i = 0; i < N; i++) await rconLike(ctx, 'ListPlayers')
})

const mtx = new Mutex()
const locked = Instr.spanOp('locked', { module, mutexes: () => mtx }, async () => 1)

async function time(label: string, run: () => Promise<void>) {
	const start = performance.now()
	await run()
	const elapsed = performance.now() - start
	console.log(`${label.padEnd(10)} ${((elapsed * 1000) / N).toFixed(2).padStart(7)} us/call`)
}

const ctx = { ...CS.init(), serverId: 'bench-server' }
for (let round = 0; round < 3; round++) {
	console.log(`round ${round + 1}`)
	await time('bare', async () => {
		for (let i = 0; i < N; i++) await bare()
	})
	await time('rcon-like', () => rconParent(ctx))
	await time('mutex', async () => {
		for (let i = 0; i < N; i++) await locked()
	})
}
await provider.shutdown()
