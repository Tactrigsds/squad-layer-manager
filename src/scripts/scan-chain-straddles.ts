import * as SM from '@/models/squad.models'
import * as fs from 'node:fs'
import * as readline from 'node:readline'
import { anonymizeIps } from './anonymize-ips'

// Diagnostic: reproduce parseLogStream's tick grouping over a log archive and report chains spanning ticks,
// several instances in one tick, and events sharing a tick with a chain. Re-run it before changing how
// partitionTick assigns members, to check the assumptions it relies on still hold.
//
// usage: pnpm run script src/scripts/scan-chain-straddles.ts <path> [...paths]
//        FIXTURE_OUT=test/fixtures/log-chain-ticks.json pnpm run script ... <path>   (regenerate the fixture)

type ChainSpec = { key: string; primary: string; members: string[]; required: string[] }

const CHAINS: ChainSpec[] = [
	{
		key: 'PLAYER_CONNECTED_CHAIN',
		primary: 'PLAYER_CONNECTED',
		members: ['PLAYER_CONNECTED', 'PLAYER_JOIN_SUCCEEDED', 'PLAYER_ADDED_TO_TEAM'],
		required: ['PLAYER_CONNECTED', 'PLAYER_JOIN_SUCCEEDED'],
	},
	{
		key: 'ROUND_ENDED_CHAIN',
		primary: 'ROUND_ENDED',
		members: ['ROUND_ENDED', 'ROUND_DECIDED_WINNER', 'ROUND_DECIDED_LOSER', 'ADMIN_ENDED_MATCH', 'LAYER_CHANGED'],
		required: ['ROUND_ENDED'],
	},
	{
		key: 'PLAYER_KICKED_CHAIN',
		primary: 'KICKING_PLAYER',
		members: ['KICKING_PLAYER', 'PLAYER_KICKED'],
		required: ['KICKING_PLAYER', 'PLAYER_KICKED'],
	},
]

const CHAIN_BY_PRIMARY = new Map(CHAINS.map(c => [c.primary, c]))

const logStartRegex = /^([[0-9.:-]+]\[[ 0-9]*]).+$/
const chainIdRegex = /^\[[0-9.:-]+]\[\s*([0-9]+)\s*]/

// type-only classification: the regexes alone, in EventMatchers order, minus the catch-all UNKNOWN
const MATCHERS = SM.LogEvents.EventMatchers
	.filter(m => m.event.type !== 'UNKNOWN')
	.map(m => ({ type: m.event.type, regex: m.regex }))

function classify(line: string): string | null {
	for (const m of MATCHERS) if (m.regex.test(line)) return m.type
	return null
}

type Buffered = { type: string; line: number; raw: string }
type Tick = { chainId: string; events: Buffered[]; line: number; lines: string[] }

// tick groups worth committing as a parser fixture, keyed by why they are interesting
type FixtureTick = { reason: string; file: string; line: number; chainId: string; lines: string[] }
const MAX_TICK_LINES = 200
const MAX_PER_REASON = 10
const CONSUMED_EVENTS = new Set(['NEW_GAME', 'PLAYER_DIED', 'PLAYER_WOUNDED', 'PLAYER_DISCONNECTED'])

const LOOKAHEAD = 4

type Report = {
	file: string
	fixtures: FixtureTick[]
	ticks: number
	recognized: number
	straddles: { chain: string; missing: string; foundAfterTicks: number; line: number; raw: string }[]
	missingEntirely: { chain: string; missing: string; line: number }[]
	collateral: { primary: string; dropped: string; line: number; raw: string; position: string }[]
	multiInstance: { chain: string; count: number; line: number; seq: string[] }[]
	multiChainType: { chains: string[]; line: number }[]
}

async function scanFile(path: string): Promise<Report> {
	const rep: Report = {
		file: path,
		fixtures: [],
		ticks: 0,
		recognized: 0,
		straddles: [],
		missingEntirely: [],
		collateral: [],
		multiInstance: [],
		multiChainType: [],
	}
	const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity })

	const pending: Tick[] = []
	let cur: Tick | null = null
	let lineNo = 0

	const flushAnalysis = (idx: number) => {
		const tick = pending[idx]
		const byType = new Map<string, Buffered[]>()
		for (const e of tick.events) {
			if (!byType.has(e.type)) byType.set(e.type, [])
			byType.get(e.type)!.push(e)
		}

		const primariesPresent = CHAINS.filter(c => byType.has(c.primary))
		if (primariesPresent.length === 0) return

		if (primariesPresent.length > 1) {
			rep.multiChainType.push({ chains: primariesPresent.map(c => c.key), line: tick.line })
		}

		const firstPrimary = tick.events.find(e => CHAIN_BY_PRIMARY.has(e.type))!
		const chain = CHAIN_BY_PRIMARY.get(firstPrimary.type)!

		const dupes = byType.get(chain.primary)!.length
		if (dupes > 1) {
			rep.multiInstance.push({ chain: chain.key, count: dupes, line: tick.line, seq: tick.events.map(e => e.type) })
			addFixture(rep, 'two-instances-one-tick', tick)
		}
		const losesConsumed = tick.events.some(e => !chain.members.includes(e.type) && CONSUMED_EVENTS.has(e.type))
		addFixture(rep, losesConsumed ? 'consumed-event-shares-tick' : 'chain-tick', tick)

		// non-members sharing the tick, positioned relative to the chain's own member span
		const memberIdxs = tick.events.map((e, i) => (chain.members.includes(e.type) ? i : -1)).filter(i => i >= 0)
		const firstMember = memberIdxs[0]
		const lastMember = memberIdxs[memberIdxs.length - 1]
		tick.events.forEach((e, i) => {
			if (chain.members.includes(e.type)) return
			const position = i < firstMember ? 'before' : i > lastMember ? 'after' : 'interleaved'
			rep.collateral.push({ primary: chain.key, dropped: e.type, line: e.line, raw: e.raw, position })
		})

		for (const req of chain.required) {
			if (byType.has(req)) continue
			let foundAfter = -1
			for (let k = 1; k <= LOOKAHEAD && idx + k < pending.length; k++) {
				if (pending[idx + k].events.some(e => e.type === req)) {
					foundAfter = k
					break
				}
			}
			if (foundAfter > 0) {
				rep.straddles.push({
					chain: chain.key,
					missing: req,
					foundAfterTicks: foundAfter,
					line: tick.line,
					raw: firstPrimary.raw.slice(0, 160),
				})
			} else {
				rep.missingEntirely.push({ chain: chain.key, missing: req, line: tick.line })
			}
		}
	}

	const drain = (keep: number) => {
		while (pending.length > keep) {
			flushAnalysis(0)
			pending.shift()
		}
	}

	for await (const line of rl) {
		lineNo++
		if (!logStartRegex.test(line)) continue
		const chainId = line.match(chainIdRegex)?.[1] ?? '?'
		if (!cur || cur.chainId !== chainId) {
			if (cur) {
				pending.push(cur)
				rep.ticks++
				// keep LOOKAHEAD+1 ticks resident so straddle lookahead has data
				drain(LOOKAHEAD + 1)
			}
			cur = { chainId, events: [], line: lineNo, lines: [] }
		}
		if (cur.lines.length < MAX_TICK_LINES) cur.lines.push(line)
		const type = classify(line)
		if (type) {
			rep.recognized++
			cur.events.push({ type, line: lineNo, raw: line })
		}
	}
	if (cur) {
		pending.push(cur)
		rep.ticks++
	}
	drain(0)
	return rep
}

function addFixture(rep: Report, reason: string, tick: Tick) {
	const existing = rep.fixtures.filter(f => f.reason === reason).length
	if (reason !== 'consumed-event-shares-tick' && existing >= MAX_PER_REASON) return
	rep.fixtures.push({ reason, file: rep.file, line: tick.line, chainId: tick.chainId, lines: tick.lines })
}

function tally<T>(rows: T[], key: (r: T) => string) {
	const m = new Map<string, number>()
	for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1)
	return [...m.entries()].sort((a, b) => b[1] - a[1])
}

async function main() {
	const files = process.argv.slice(2)
	const totals: Report = {
		file: '',
		fixtures: [],
		ticks: 0,
		recognized: 0,
		straddles: [],
		missingEntirely: [],
		collateral: [],
		multiInstance: [],
		multiChainType: [],
	}

	for (const f of files) {
		const rep = await scanFile(f)
		console.log(
			`\n=== ${f}\n    ticks=${rep.ticks} recognized=${rep.recognized} straddles=${rep.straddles.length} `
				+ `missingEntirely=${rep.missingEntirely.length} collateralDrops=${rep.collateral.length} `
				+ `multiInstance=${rep.multiInstance.length} multiChainType=${rep.multiChainType.length}`,
		)
		totals.fixtures.push(...rep.fixtures)
		totals.ticks += rep.ticks
		totals.recognized += rep.recognized
		totals.straddles.push(...rep.straddles)
		totals.missingEntirely.push(...rep.missingEntirely)
		totals.collateral.push(...rep.collateral)
		totals.multiInstance.push(...rep.multiInstance)
		totals.multiChainType.push(...rep.multiChainType)
	}

	console.log(`\n\n######## TOTALS across ${files.length} file(s)`)
	console.log(`ticks=${totals.ticks} recognizedEvents=${totals.recognized}`)

	console.log(`\n--- STRADDLES (chain primary in tick N, required member in tick N+k): ${totals.straddles.length}`)
	for (const [k, n] of tally(totals.straddles, s => `${s.chain} missing ${s.missing} found +${s.foundAfterTicks} tick(s)`)) {
		console.log(`  ${n.toString().padStart(6)}  ${k}`)
	}
	for (const s of totals.straddles.slice(0, 5)) console.log(`    e.g. line ${s.line}: ${s.raw}`)

	console.log(`\n--- REQUIRED MEMBER NEVER FOUND (within ${LOOKAHEAD} ticks): ${totals.missingEntirely.length}`)
	for (const [k, n] of tally(totals.missingEntirely, s => `${s.chain} missing ${s.missing}`)) {
		console.log(`  ${n.toString().padStart(6)}  ${k}`)
	}

	console.log(`\n--- COLLATERAL DROPS (recognized non-member event sharing a tick with a chain): ${totals.collateral.length}`)
	for (const [k, n] of tally(totals.collateral, s => `${s.dropped} dropped by ${s.primary}`)) {
		console.log(`  ${n.toString().padStart(6)}  ${k}`)
	}

	console.log(`\n--- COLLATERAL DROP POSITION relative to the chain's member span`)
	for (const [k, n] of tally(totals.collateral, s => `${s.position.padEnd(11)} ${s.dropped}`)) {
		console.log(`  ${n.toString().padStart(6)}  ${k}`)
	}
	console.log(`\n--- INTERLEAVED (strictly between two chain members), non-PLAYER_RESTARTED:`)
	for (const c of totals.collateral.filter(c => c.position === 'interleaved' && c.dropped !== 'PLAYER_RESTARTED')) {
		console.log(`    ${c.dropped} dropped by ${c.primary} @ line ${c.line}`)
	}

	console.log(`\n--- MULTIPLE INSTANCES OF ONE CHAIN IN A TICK: ${totals.multiInstance.length}`)
	for (const s of totals.multiInstance) console.log(`    line ${s.line} ${s.chain} x${s.count}: ${s.seq.join(' -> ')}`)

	console.log(`\n--- TWO+ CHAIN TYPES IN ONE TICK: ${totals.multiChainType.length}`)
	for (const [k, n] of tally(totals.multiChainType, s => s.chains.join(' + '))) console.log(`  ${n.toString().padStart(6)}  ${k}`)

	const fixtureOut = process.env.FIXTURE_OUT
	if (fixtureOut) {
		const perReason = new Map<string, number>()
		const picked = totals.fixtures.filter(f => {
			const n = perReason.get(f.reason) ?? 0
			if (f.reason !== 'consumed-event-shares-tick' && n >= MAX_PER_REASON) return false
			perReason.set(f.reason, n + 1)
			return true
		})
		const out = picked.map(f => ({ ...f, file: f.file.split('/').pop()! }))
		fs.writeFileSync(fixtureOut, anonymizeIps(JSON.stringify(out, null, '\t')) + '\n')
		console.log(`\nwrote ${picked.length} tick group(s) to ${fixtureOut}`)
		for (const [k, n] of tally(picked, f => f.reason)) console.log(`  ${n.toString().padStart(6)}  ${k}`)
	}

	const newGameDrops = totals.collateral.filter(c => c.dropped === 'NEW_GAME')
	console.log(`\n--- NEW_GAME DROPPED: ${newGameDrops.length}`)
	for (const d of newGameDrops) console.log(`    line ${d.line}: ${d.raw.slice(0, 170)}`)
}

void main()
