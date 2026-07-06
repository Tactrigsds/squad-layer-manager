import * as SM from '@/models/squad.models'
import * as fs from 'node:fs'

// For each victim (by username), walk their Wound()/Die() timeline in order and ask:
// does each Die have at least one Wound since that victim's previous Die?
// Bucket deaths by (has-preceding-wound) x (weapon valid vs null/nullptr).

async function* fileChunks(path: string): AsyncGenerator<string> {
	const stream = fs.createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })
	for await (const chunk of stream) yield chunk as string
}

async function run(path: string) {
	console.log('\n==================================================')
	console.log('FILE:', path)
	console.log('==================================================')

	const errors: Error[] = []
	// per-username: count of wounds seen since that victim's last death
	const pendingWounds = new Map<string, number>()

	let deaths = 0
	let deathsPaired = 0
	let deathsUnpaired = 0
	// split unpaired by weapon presence
	let unpairedWithWeapon = 0
	let unpairedNullWeapon = 0
	let pairedWithWeapon = 0
	let pairedNullWeapon = 0
	const unpairedWeaponSamples: string[] = []

	for await (const ev of SM.LogEvents.parseLogStream(fileChunks(path), errors)) {
		if (ev === null) continue
		if (ev.type === 'PLAYER_WOUNDED') {
			const v = ev.victimIds.username ?? '<none>'
			pendingWounds.set(v, (pendingWounds.get(v) ?? 0) + 1)
		} else if (ev.type === 'PLAYER_DIED') {
			const v = ev.victimIds.username ?? '<none>'
			deaths++
			const hasWound = (pendingWounds.get(v) ?? 0) > 0
			const hasWeapon = ev.weapon != null
			if (hasWound) {
				deathsPaired++
				if (hasWeapon) pairedWithWeapon++
				else pairedNullWeapon++
				pendingWounds.set(v, 0) // consume the wound(s) up to this death
			} else {
				deathsUnpaired++
				if (hasWeapon) {
					unpairedWithWeapon++
					if (unpairedWeaponSamples.length < 12) unpairedWeaponSamples.push(`${v}  |  weapon=${ev.weapon}`)
				} else {
					unpairedNullWeapon++
				}
			}
		}
	}

	const pct = (n: number) => deaths ? `${(100 * n / deaths).toFixed(1)}%` : '-'
	console.log(`\ntotal deaths parsed: ${deaths}`)
	console.log(`  paired (>=1 wound since victim's last death): ${deathsPaired} (${pct(deathsPaired)})`)
	console.log(`     - with valid weapon: ${pairedWithWeapon}`)
	console.log(`     - null weapon      : ${pairedNullWeapon}`)
	console.log(`  UNPAIRED (no preceding wound):               ${deathsUnpaired} (${pct(deathsUnpaired)})`)
	console.log(`     - with valid weapon: ${unpairedWithWeapon}   <-- deaths with a real weapon but NO wound`)
	console.log(`     - null weapon      : ${unpairedNullWeapon}`)
	if (unpairedWeaponSamples.length) {
		console.log('\n  samples of UNPAIRED deaths that DO have a valid weapon:')
		for (const s of unpairedWeaponSamples) console.log('    ', s)
	}
}

async function main() {
	for (const f of process.argv.slice(2)) await run(f)
}
main().catch(e => {
	console.error(e)
	process.exit(1)
})
