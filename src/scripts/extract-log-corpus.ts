import { matchLog } from '@/lib/log-parsing'
import * as SM from '@/models/squad.models'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { anonymizeIps } from './anonymize-ips'

// Builds the emulator log corpus from real SquadGame.log files: representative raw samples per
// matched event type, complete chainID groupings for the chain events, and a frequency table of
// unmatched line families (background noise the emulator should be able to reproduce).
//
// usage: pnpm run script src/scripts/extract-log-corpus.ts <path> [...paths]

const MAX_SAMPLES_PER_TYPE = 8
const MAX_FAMILY_SAMPLES = 3
const MAX_CHAIN_EXAMPLES = 4
const PREAMBLE_LINES = 60

const logStartRegex = /^([[0-9.:-]+]\[[ 0-9]*]).+$/

type Sample = { file: string; entry: string }
type ChainExample = { file: string; chainID: string; primaryType: string; entries: string[] }

const eventSamples = new Map<string, Sample[]>()
const eventCounts = new Map<string, number>()
// keyed by line family: the log category plus the following token, e.g. "LogSquad: Player"
const unmatchedFamilies = new Map<string, { count: number; samples: Sample[] }>()
const chainExamples = new Map<string, ChainExample[]>()
const parseErrors: { file: string; entry: string; error: string }[] = []
let preambles: { file: string; lines: string[] }[] = []

// map event type -> chain it belongs to, so we know which chainIDs to capture in full
const CHAIN_PRIMARIES = new Map<string, string>([
	['PLAYER_CONNECTED', 'PLAYER_CONNECTED_CHAIN'],
	['ROUND_ENDED', 'ROUND_ENDED_CHAIN'],
	['KICKING_PLAYER', 'PLAYER_KICKED_CHAIN'],
])

function familyOf(entry: string): string {
	// strip the [timestamp][chainID] header, then take "LogCategory: NextToken"
	const m = entry.match(/^\[[0-9.:-]+]\[[ 0-9]*](\w+): ?(\S*)/)
	if (!m) return '(headerless)'
	return `${m[1]}: ${m[2].split('(')[0]}`
}

function pushBounded<T>(arr: T[], item: T, max: number) {
	if (arr.length < max) arr.push(item)
}

async function* fileChunks(p: string): AsyncGenerator<string> {
	const stream = fs.createReadStream(p, { encoding: 'utf8', highWaterMark: 1 << 20 })
	for await (const chunk of stream) yield chunk as string
}

async function scan(file: string) {
	const base = path.basename(file)
	console.log(`scanning ${file} ...`)

	let foundLogStart = false
	let lineBuffer: string[] = []
	let preamble: string[] = []
	let carry = ''

	// chainID -> raw entries, for assembling full chain examples. chainIDs are reused over time,
	// so evict once we've moved on (entries with one chainID are contiguous in practice).
	const chainBuffers = new Map<string, string[]>()
	const chainOrder: string[] = []

	function flushChain(chainID: string) {
		const entries = chainBuffers.get(chainID)
		chainBuffers.delete(chainID)
		if (!entries) return
		// does this chain group contain a primary chain event?
		for (const entry of entries) {
			const [event] = matchLog(entry, SM.LogEvents.EventMatchers)
			if (!event || event.type === 'UNKNOWN') continue
			const chainKey = CHAIN_PRIMARIES.get(event.type)
			if (!chainKey) continue
			const examples = chainExamples.get(chainKey) ?? []
			chainExamples.set(chainKey, examples)
			pushBounded(examples, { file: base, chainID, primaryType: event.type, entries }, MAX_CHAIN_EXAMPLES)
			break
		}
	}

	function handleEntry(entry: string) {
		const chainIdMatch = entry.match(/^\[[0-9.:-]+]\[([ 0-9]*)]/)
		const chainID = chainIdMatch ? chainIdMatch[1].trim() : ''
		if (chainID) {
			if (!chainBuffers.has(chainID)) {
				chainBuffers.set(chainID, [])
				chainOrder.push(chainID)
				// evict old chains; anything 30 chainIDs back won't get more entries
				while (chainOrder.length > 30) flushChain(chainOrder.shift()!)
			}
			chainBuffers.get(chainID)!.push(entry)
		}

		const [event, err] = matchLog(entry, SM.LogEvents.EventMatchers)
		if (err) {
			pushBounded(parseErrors, { file: base, entry, error: String(err) }, 50)
			return
		}
		if (!event) return
		eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1)
		if (event.type === 'UNKNOWN') {
			const family = familyOf(entry)
			const bucket = unmatchedFamilies.get(family) ?? { count: 0, samples: [] }
			unmatchedFamilies.set(family, bucket)
			bucket.count++
			pushBounded(bucket.samples, { file: base, entry }, MAX_FAMILY_SAMPLES)
		} else {
			const samples = eventSamples.get(event.type) ?? []
			eventSamples.set(event.type, samples)
			pushBounded(samples, { file: base, entry }, MAX_SAMPLES_PER_TYPE)
		}
	}

	for await (const chunk of fileChunks(file)) {
		const lines = chunk.split(/\r?\n/)
		lines[0] = carry + lines[0]
		carry = lines.pop() ?? ''
		for (const line of lines) {
			if (!foundLogStart && preamble.length < PREAMBLE_LINES) preamble.push(line)
			const match = line.match(logStartRegex)
			if (!match) {
				if (foundLogStart && lineBuffer.length <= 100) lineBuffer.push(line)
				continue
			}
			if (foundLogStart) {
				handleEntry(lineBuffer.join('\n'))
				lineBuffer = [line]
				continue
			}
			foundLogStart = true
			lineBuffer = [line]
		}
	}
	if (lineBuffer.length > 0) handleEntry(lineBuffer.join('\n'))
	for (const chainID of chainOrder) flushChain(chainID)
	preambles.push({ file: base, lines: preamble })
}

async function main() {
	const files = process.argv.slice(2)
	if (files.length === 0) {
		console.error('usage: pnpm run script src/scripts/extract-log-corpus.ts <path> [...paths]')
		process.exit(1)
	}
	for (const f of files) await scan(f)

	const outDir = path.join(import.meta.dirname, '../../test/corpus/logs')
	fs.mkdirSync(outDir, { recursive: true })

	// the family tail is dominated by tokens embedding player names etc.; keep the recurring ones
	// and fold the rest into an aggregate count so totals still add up
	const familyEntries = [...unmatchedFamilies.entries()].sort((a, b) => b[1].count - a[1].count)
	const kept = familyEntries.filter(([, v]) => v.count >= 20)
	const prunedCount = familyEntries.filter(([, v]) => v.count < 20).reduce((acc, [, v]) => acc + v.count, 0)
	const sortedFamilies = Object.fromEntries(kept)
	if (prunedCount > 0) {
		sortedFamilies['(pruned tail: families with <20 occurrences)'] = { count: prunedCount, samples: [] }
	}
	const out = {
		generatedAt: new Date().toISOString(),
		sourceFiles: files.map(f => path.basename(f)),
		eventCounts: Object.fromEntries([...eventCounts.entries()].sort((a, b) => b[1] - a[1])),
		eventSamples: Object.fromEntries(eventSamples),
		chainExamples: Object.fromEntries(chainExamples),
		unmatchedFamilies: sortedFamilies,
		preambles,
		parseErrors,
	}
	const outFile = path.join(outDir, 'log-corpus.json')
	fs.writeFileSync(outFile, anonymizeIps(JSON.stringify(out, null, '\t')))
	console.log(`\nwrote ${outFile}`)
	console.log('event counts:')
	for (const [type, count] of Object.entries(out.eventCounts)) console.log(`  ${type}: ${count}`)
	console.log(
		`unmatched families: ${unmatchedFamilies.size}, chain examples: ${
			[...chainExamples.values()].flat().length
		}, parse errors kept: ${parseErrors.length}`,
	)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
