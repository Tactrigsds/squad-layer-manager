import * as SM from '@/models/squad.models'
import * as fs from 'node:fs'
import * as util from 'node:util'

// Runs a log file through parseLogStream and dumps every parsed event with full
// details, so we can eyeball whether everything parses cleanly and completely.

async function* fileChunks(path: string): AsyncGenerator<string> {
	const stream = fs.createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })
	for await (const chunk of stream) yield chunk as string
}

// Optional case-insensitive substring; when set, we only dump full detail for events
// whose stringified form matches it (raw line, ids, usernames). Everything is still counted.
const FILTER = process.env.FILTER?.toLowerCase()
// UNKNOWN events are usually noise; only dump matching UNKNOWNs when explicitly asked.
const SHOW_UNKNOWN = process.env.SHOW_UNKNOWN === '1'

function matchesFilter(ev: SM.LogEvents.ParseOutputEvent): boolean {
	if (!FILTER) return ev.type !== 'UNKNOWN' || SHOW_UNKNOWN
	if (ev.type === 'UNKNOWN' && !SHOW_UNKNOWN) return false
	return util.inspect(ev, { depth: null }).toLowerCase().includes(FILTER)
}

async function run(path: string) {
	console.log('==================================================')
	console.log('FILE:', path)
	console.log('==================================================')

	const errors: Error[] = []
	const counts = new Map<string, number>()
	const matched: SM.LogEvents.ParseOutputEvent[] = []
	let total = 0
	let nullYields = 0

	for await (const ev of SM.LogEvents.parseLogStream(fileChunks(path), errors)) {
		if (ev === null) {
			nullYields++
			continue
		}
		total++
		counts.set(ev.type, (counts.get(ev.type) ?? 0) + 1)
		if (matchesFilter(ev)) matched.push(ev)
	}

	console.log(`\nparsed events: ${total}, null yields (parse failures): ${nullYields}, errors: ${errors.length}`)
	if (FILTER) console.log(`filter: "${FILTER}" -> ${matched.length} matching events`)
	console.log('\nevent type counts:')
	for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${type}: ${count}`)
	}

	console.log(`\n--- ${FILTER ? 'matching ' : ''}events (full detail) ---`)
	for (const ev of matched) {
		console.log(util.inspect(ev, { depth: null, colors: true, breakLength: 140 }))
	}

	if (errors.length) {
		console.log(`\n--- errors (${errors.length}) ---`)
		for (const err of errors) console.log(err.message)
	}
}

async function main() {
	const paths = process.argv.slice(2)
	if (paths.length === 0) {
		console.error('usage: pnpm run script src/scripts/dump-log-events.ts <path> [...paths]')
		process.exit(1)
	}
	for (const f of paths) await run(f)
}
main().catch(e => {
	console.error(e)
	process.exit(1)
})
