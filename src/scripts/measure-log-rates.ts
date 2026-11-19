import * as fs from 'node:fs'

import * as SM from '@/models/squad.models'

// Measures how often each log event occurs in real SquadGame.log files, per minute of log time, for sizing the
// synthetic load the emulator emits (src/scripts/load.ts). Prints a JSON rate profile.
//
// Population is estimated from connects and disconnects. A log opened mid-match starts with players it never saw
// connect, so the estimate floors at zero and drifts low. Only minutes at or above --min-players are counted.
//
//   pnpm run script src/scripts/measure-log-rates.ts [--min-players 80] <SquadGame.log>...

const args = process.argv.slice(2)
let minPlayers = 80
const files: string[] = []
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--min-players') minPlayers = Number(args[++i])
	else files.push(args[i])
}
if (files.length === 0) {
	console.error('usage: measure-log-rates.ts [--min-players N] <log>...')
	process.exit(1)
}

const STAMP = /^\[(\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3})\]/
const MINUTE = 60_000

type Minute = { events: Map<string, number>; lines: number; bytes: number; players: number }

async function* fileChunks(path: string): AsyncGenerator<string> {
	const stream = fs.createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })
	for await (const chunk of stream) yield chunk as string
}

async function measure(path: string) {
	const minutes = new Map<number, Minute>()
	const minuteAt = (time: number) => {
		const key = Math.floor(time / MINUTE)
		let m = minutes.get(key)
		if (!m) minutes.set(key, (m = { events: new Map(), lines: 0, bytes: 0, players: 0 }))
		return m
	}

	// raw line volume, which is what the tail and the parser pay for regardless of whether a line becomes an event
	for await (const chunk of fileChunks(path)) {
		for (const line of chunk.split('\n')) {
			const stamp = STAMP.exec(line)
			if (!stamp) continue
			const m = minuteAt(SM.LogEvents.parseTimestamp(stamp[1]))
			m.lines++
			m.bytes += line.length + 1
		}
	}

	const errors: Error[] = []
	let players = 0
	for await (const ev of SM.LogEvents.parseLogStream(fileChunks(path), errors)) {
		if (!ev || ev.type === 'UNKNOWN') continue
		if (ev.type === 'PLAYER_CONNECTED_CHAIN') players++
		if (ev.type === 'PLAYER_DISCONNECTED') players = Math.max(0, players - 1)
		const m = minuteAt(ev.time)
		m.events.set(ev.type, (m.events.get(ev.type) ?? 0) + 1)
		m.players = Math.max(m.players, players)
	}
	return [...minutes.values()]
}

function quantile(sorted: number[], q: number) {
	if (sorted.length === 0) return 0
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

const all: Minute[] = []
for (const file of files) all.push(...(await measure(file)))
const full = all.filter((m) => m.players >= minPlayers)

const types = new Set<string>()
for (const m of full) for (const t of m.events.keys()) types.add(t)

const perMinute = (pick: (m: Minute) => number) => {
	const values = full.map(pick).sort((a, b) => a - b)
	const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)
	return { mean: Math.round(mean * 100) / 100, p50: quantile(values, 0.5), p95: quantile(values, 0.95), max: values.at(-1) ?? 0 }
}

const profile = {
	minPlayers,
	minutesTotal: all.length,
	minutesCounted: full.length,
	lines: perMinute((m) => m.lines),
	bytes: perMinute((m) => m.bytes),
	events: Object.fromEntries([...types].sort().map((t) => [t, perMinute((m) => m.events.get(t) ?? 0)])),
}
console.log(JSON.stringify(profile, null, 2))
