import type { MigrationDriver } from '@/server/migrate'

// PLAYER_DIED and PLAYER_WOUNDED rows stored the Die()/Wound() `caused by` token as `weapon`. It is now
// `damageSource`, and PLAYER_DIED records a deathVariant. A death from wounds was logged as KillingDamage=-300 but
// stored unsigned as 300, with the victim's own soldier pawn as its cause; those rows get back their sign and become
// 'diedOfWounds'. Every other death becomes 'killed'.
//
// Only the hot table is rewritten. Archived matches keep `weapon` in their compressed blobs and are upgraded when read
// (upgradeWoundedOrDiedPayload in server-events.models.ts), by the same rule as here.
//
// Plain SQL rather than a superjson round trip per row: the table holds millions of these rows, and none of the
// fields touched is a value superjson records in `meta`.
export async function up(db: MigrationDriver): Promise<void> {
	const weapon = `json_extract(data, '$.json.weapon')`
	const hasWeapon = `json_type(data, '$.json.weapon') IS NOT NULL`
	const diedOfWounds = `(json_extract(data, '$.json.damage') = 300 AND substr(${weapon}, 1, 10) = 'BP_Soldier')`

	const wounds = db
		.prepare(
			`UPDATE serverEvents SET data = json_set(json_remove(data, '$.json.weapon'), '$.json.damageSource', ${weapon})
			WHERE type = 'PLAYER_WOUNDED' AND ${hasWeapon}`,
		)
		.run()
	const deaths = db
		.prepare(
			`UPDATE serverEvents SET data = json_set(json_remove(data, '$.json.weapon'),
				'$.json.damageSource', ${weapon},
				'$.json.deathVariant', CASE WHEN ${diedOfWounds} THEN 'diedOfWounds' ELSE 'killed' END,
				'$.json.damage', CASE WHEN ${diedOfWounds} THEN -300 ELSE json_extract(data, '$.json.damage') END)
			WHERE type = 'PLAYER_DIED' AND ${hasWeapon}`,
		)
		.run()
	console.info(`0141_death_damage_source: rewrote ${wounds.changes} wound(s) and ${deaths.changes} death(s)`)
}
