import * as fs from 'node:fs'

import { ensureEnvSetup } from '@/server/env'
import { ensureLoggerSetup } from '@/server/logger'
import Rcon, * as CoreRcon from '@/systems/core-rcon.server'

// Issues batches of concurrent commands through the app's Rcon client and checks that each caller receives the response
// to its own command. Commands come from a file (one per line, # comments) and are cycled to fill each batch. Each
// verb's response is recognised by its shape, and ShowCommandInfo's by the command it names, so a response delivered to
// the wrong caller shows up as a mismatch. ShowCommandInfo is the cheapest command for the server to answer.
//
// usage:
//   NODE_ENV=development RCON_HOST=... RCON_PORT=... RCON_PASSWORD=... \
//     pnpm run script src/scripts/probe-rcon-concurrency.ts --exec-file <file> --batches 40,70

const HOST = process.env.RCON_HOST!
const PORT = Number(process.env.RCON_PORT!)
const PASSWORD = process.env.RCON_PASSWORD!
if (!HOST || !PORT || !PASSWORD) {
	console.error('RCON_HOST, RCON_PORT, RCON_PASSWORD are required')
	process.exit(1)
}
const execFileIdx = process.argv.indexOf('--exec-file')
const batchesIdx = process.argv.indexOf('--batches')
if (execFileIdx === -1 || batchesIdx === -1) {
	console.error('--exec-file and --batches are required')
	process.exit(1)
}
const COMMANDS = fs
	.readFileSync(process.argv[execFileIdx + 1], 'utf8')
	.split('\n')
	.map((l) => l.trim())
	.filter((l) => l && !l.startsWith('#'))
const BATCHES = process.argv[batchesIdx + 1].split(',').map(Number)

function matches(command: string, response: string): boolean {
	const [verb, ...rest] = command.split(' ')
	switch (verb) {
		case 'ShowCommandInfo':
			return response.startsWith(`\n${rest[0]}`)
		case 'ShowCurrentMap':
			return response.startsWith('Current level')
		case 'ShowNextMap':
			return response.startsWith('Next level')
		default:
			return response.length > 0
	}
}

type Result = { i: number; command: string; ms: number; outcome: 'ok' | 'mismatch' | 'timeout'; body?: string }

async function runBatch(rcon: Rcon, size: number): Promise<Result[]> {
	const start = performance.now()
	return Promise.all(
		Array.from({ length: size }, async (_, i): Promise<Result> => {
			const command = COMMANDS[i % COMMANDS.length]
			const res = await rcon.execute(command)
			const ms = Math.round(performance.now() - start)
			if (res.code !== 'ok') return { i, command, ms, outcome: 'timeout' }
			return { i, command, ms, outcome: matches(command, res.data) ? 'ok' : 'mismatch', body: res.data.slice(0, 60) }
		}),
	)
}

async function main() {
	ensureEnvSetup()
	ensureLoggerSetup()
	CoreRcon.setup()
	const rcon = new Rcon({
		serverId: 'probe',
		transport: new CoreRcon.DirectSocketTransport({ host: HOST, port: PORT, password: PASSWORD }),
	})
	await rcon.connect()
	for (const size of BATCHES) {
		const results = await runBatch(rcon, size)
		const count = (o: Result['outcome']) => results.filter((r) => r.outcome === o).length
		console.log(`\n===== batch of ${size}: ok ${count('ok')}, mismatch ${count('mismatch')}, timeout ${count('timeout')} =====`)
		for (const r of results) {
			if (r.outcome === 'ok') continue
			console.log(`#${r.i} ${r.outcome} after ${r.ms}ms: ${r.command}${r.body !== undefined ? ` <- ${JSON.stringify(r.body)}` : ''}`)
		}
		const okTimes = results.filter((r) => r.outcome === 'ok').map((r) => r.ms)
		if (okTimes.length) console.log(`ok responses arrived ${Math.min(...okTimes)}-${Math.max(...okTimes)}ms after the batch started`)
		// lets stragglers from a timed-out batch drain before the next one, so they cannot land on its listeners
		await new Promise((res) => setTimeout(res, 5000))
	}
	rcon.disconnect()
	process.exit(0)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
