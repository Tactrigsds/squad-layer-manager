import { matchLog } from '@/lib/log-parsing'
import * as SM from '@/models/squad.models'
import * as fs from 'node:fs'
import * as readline from 'node:readline'

// Directly test each raw Die()/Wound() line against its matcher.
async function run(path: string) {
	console.log('\n==================================================')
	console.log('FILE:', path)
	console.log('==================================================')

	const rl = readline.createInterface({ input: fs.createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })

	const stats = {
		die: { total: 0, parsed: 0, bailedNull: 0, noMatch: 0, error: 0 },
		wound: { total: 0, parsed: 0, bailedNull: 0, noMatch: 0, error: 0 },
	}
	// "caused by" token distribution for dropped-but-not-INVALID lines
	const dieDroppedCausedBy = new Map<string, number>()
	const woundDroppedCausedBy = new Map<string, number>()
	const dieDroppedSamples: string[] = []
	const woundDroppedSamples: string[] = []
	// how many parsed events carry a valid attacker eos vs not
	let dieParsedWithAttacker = 0, dieParsedNoAttacker = 0
	let woundParsedWithAttacker = 0, woundParsedNoAttacker = 0

	const causedByOf = (line: string) => line.match(/caused by ([^\s(]+)/)?.[1] ?? '<none>'

	for await (const line of rl) {
		const isDie = line.includes('Die():')
		const isWound = line.includes('Wound():')
		if (!isDie && !isWound) continue
		const kind = isDie ? 'die' : 'wound'
		const s = stats[kind]
		s.total++
		const matcher = isDie ? SM.LogEvents.PlayerDiedMatcher : SM.LogEvents.PlayerWoundedMatcher
		const [event, err] = matchLog(line, [matcher])
		if (err) {
			s.error++
			continue
		}
		if (event) {
			s.parsed++
			const hasAttacker = !!(event as any).attackerIds?.eos
			if (isDie) {
				if (hasAttacker) dieParsedWithAttacker++
				else dieParsedNoAttacker++
			} else {
				if (hasAttacker) woundParsedWithAttacker++
				else woundParsedNoAttacker++
			}
			continue
		}
		// event === null && no err: either the regex didn't match, or onMatch bailed on INVALID
		const regexMatched = matcher.regex.test(line)
		if (regexMatched) {
			// regex matched but onMatch returned null -> INVALID id bail
			s.bailedNull++
		} else {
			s.noMatch++
			const cb = causedByOf(line)
			const map = isDie ? dieDroppedCausedBy : woundDroppedCausedBy
			map.set(cb, (map.get(cb) ?? 0) + 1)
			const samples = isDie ? dieDroppedSamples : woundDroppedSamples
			if (samples.length < 6) samples.push(line.slice(0, 200))
		}
	}

	const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : '-'
	console.log('\n--- PLAYER_DIED ---')
	console.log(`  raw Die() lines : ${stats.die.total}`)
	console.log(`  parsed event    : ${stats.die.parsed}  (${pct(stats.die.parsed, stats.die.total)})`)
	console.log(`  bailed (INVALID): ${stats.die.bailedNull}  <- intentional`)
	console.log(`  regex NO-MATCH  : ${stats.die.noMatch}  <- DROPPED, not intentional`)
	console.log(`  onMatch error   : ${stats.die.error}`)
	console.log(`  reconciles: ${stats.die.parsed + stats.die.bailedNull + stats.die.noMatch + stats.die.error === stats.die.total}`)
	console.log(`  parsed with attacker eos: ${dieParsedWithAttacker}, without: ${dieParsedNoAttacker}`)

	console.log('\n--- PLAYER_WOUNDED ---')
	console.log(`  raw Wound() lines: ${stats.wound.total}`)
	console.log(`  parsed event     : ${stats.wound.parsed}  (${pct(stats.wound.parsed, stats.wound.total)})`)
	console.log(`  bailed (INVALID) : ${stats.wound.bailedNull}  <- intentional`)
	console.log(`  regex NO-MATCH   : ${stats.wound.noMatch}  <- DROPPED, not intentional`)
	console.log(`  onMatch error    : ${stats.wound.error}`)
	console.log(
		`  reconciles: ${stats.wound.parsed + stats.wound.bailedNull + stats.wound.noMatch + stats.wound.error === stats.wound.total}`,
	)
	console.log(`  parsed with attacker eos: ${woundParsedWithAttacker}, without: ${woundParsedNoAttacker}`)

	if (dieDroppedCausedBy.size) {
		console.log('\n  DIE dropped-by-regex, "caused by" token distribution:')
		for (const [k, v] of [...dieDroppedCausedBy.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${v}\t${k}`)
		console.log('  DIE dropped samples:')
		for (const l of dieDroppedSamples) console.log('    ', l)
	}
	if (woundDroppedCausedBy.size) {
		console.log('\n  WOUND dropped-by-regex, "caused by" token distribution:')
		for (const [k, v] of [...woundDroppedCausedBy.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${v}\t${k}`)
		console.log('  WOUND dropped samples:')
		for (const l of woundDroppedSamples) console.log('    ', l)
	}
}

async function main() {
	for (const f of process.argv.slice(2)) await run(f)
}
main().catch(e => {
	console.error(e)
	process.exit(1)
})
