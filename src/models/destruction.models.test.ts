import { describe, expect, it } from 'vitest'

import * as DSTR from '@/models/destruction.models'
import * as SM from '@/models/squad.models'

// Lines are real ones from production logs unless marked otherwise, trimmed of their FullPath tails.

async function parse(lines: string[]): Promise<SM.LogEvents.ParseOutputEvent[]> {
	async function* chunks() {
		// parseLogStream only flushes an entry once the next one starts
		yield [...lines, '[2026.09.27-23.59.59:999][999]LogSquad: end'].join('\n') + '\n'
	}
	const errors: Error[] = []
	const out: SM.LogEvents.ParseOutputEvent[] = []
	for await (const event of SM.LogEvents.parseLogStream(chunks(), errors)) if (event) out.push(event)
	expect(errors).toEqual([])
	return out
}

async function replay(lines: string[], state = DSTR.init()) {
	return (await replayAll(lines, state)).destructions
}

async function replayAll(lines: string[], state = DSTR.init()) {
	DSTR.resetForMatch(state, 1)
	const destructions: DSTR.Destruction[] = []
	const radioDamage: DSTR.RadioDamage[] = []
	for (const event of await parse(lines)) {
		let destruction: DSTR.Destruction | null = null
		switch (event.type) {
			case 'DAMAGE_APPLIED':
				DSTR.onDamageApplied(state, event)
				break
			case 'VEHICLE_ENTERED':
				DSTR.onVehicleEntered(state, event)
				break
			case 'VEHICLE_EXITED':
				DSTR.onVehicleExited(state, event)
				break
			case 'VEHICLE_HEALTH_CHANGED':
				destruction = DSTR.onVehicleHealthChanged(state, event)
				break
			case 'DEPLOYABLE_HEALTH_CHANGED': {
				const outcome = DSTR.onDeployableHealthChanged(state, event)
				if (outcome?.kind === 'radio-damaged') {
					const { kind: _, ...damage } = outcome
					radioDamage.push(damage)
				} else if (outcome) {
					const { kind: _, ...rest } = outcome
					destruction = rest
				}
				break
			}
		}
		if (destruction) destructions.push(destruction)
	}
	return { destructions, radioDamage }
}

const TRIMM = '0002915f0c1c482e95f1a94a000f3ec6'
const JSE = '00020ce2bd8e413c93588ffbbddacd6e'

// constructed in the real format: the enter line for the helicopter below
const TRIMM_ENTERS_UH60 =
	'[2026.09.27-11.15.01:000][100]LogSquadTrace: [DedicatedServer]OnPossess(): PC=Trimm Trabb (Online IDs: EOS: 0002915f0c1c482e95f1a94a000f3ec6 steam: 76561198244402856) Entered Vehicle Pawn=BP_UH60_TLF_PKM_C_2147386709 (Asset Name = BP_UH60_TLF_PKM_C) FullPath=BP_UH60_TLF_PKM_C /Game/Maps/Jensens_Range/Gameplay_Layers/Jensens_Range_WPMC-TLF.Jensens_Range_WPMC-TLF:PersistentLevel.BP_UH60_TLF_PKM_C_2147386709 Seat Number=0'

const UH60_SHOT_DOWN = [
	'[2026.09.27-11.16.14:883][252]LogSquadTrace: [DedicatedServer]TraceAndMessageClient(): SQVehicleSeat::TakeDamage[PointDamage] BP_UH60_TLF_PKM_C_2147386709 for 960.000000 damage (type=BP_BasicHeatDamageType_C)',
	'[2026.09.27-11.16.14:883][252]LogSquadTrace: [DedicatedServer]TraceAndMessageClient(): Trimm Trabb: 960.00 damage taken by causer BP_Hydra70_Proj2_C_2147383920 instigator (Online Ids: jse.frog) EOS: 00020ce2bd8e413c93588ffbbddacd6e steam: 76561198132409257 health remaining -130.00',
	'[2026.09.27-11.16.14:883][252]LogSquadTrace: [DedicatedServer]OnUnPossess(): PC=Trimm Trabb (Online IDs: EOS: 0002915f0c1c482e95f1a94a000f3ec6 steam: 76561198244402856) Exited Vehicle Pawn=Trimm Trabb (Asset Name=BP_UH60_TLF_PKM_C) FullPath=BP_UH60_TLF_PKM_C /Game/Maps/Jensens_Range/Gameplay_Layers/Jensens_Range_WPMC-TLF.Jensens_Range_WPMC-TLF:PersistentLevel.BP_UH60_TLF_PKM_C_2147386709 Seat Number=0',
]

describe('vehicles', () => {
	it('resolves a crewed vehicle logged under its occupant, and credits the attacker', async () => {
		const destructions = await replay([TRIMM_ENTERS_UH60, ...UH60_SHOT_DOWN])
		expect(destructions).toEqual([
			{
				actor: { className: 'BP_UH60_TLF_PKM', instanceId: 2147386709 },
				damageType: 'BP_BasicHeatDamageType',
				cause: 'weapon',
				weapon: 'BP_Hydra70_Proj2',
				attacker: JSE,
				crew: [TRIMM],
			},
		])
	})

	it('only counts the hit that crosses zero', async () => {
		const later =
			'[2026.09.27-11.16.15:883][300]LogSquadTrace: [DedicatedServer]TraceAndMessageClient(): BP_UH60_TLF_PKM_C_2147386709: 50.00 damage taken by causer BP_Hydra70_Proj2_C_2147383921 instigator (Online Ids: jse.frog) EOS: 00020ce2bd8e413c93588ffbbddacd6e steam: 76561198132409257 health remaining -180.00'
		expect(await replay([TRIMM_ENTERS_UH60, ...UH60_SHOT_DOWN, later])).toHaveLength(1)
	})

	it('leaves an unattributed burn-out with nobody credited', async () => {
		const destructions = await replay([
			'[2026.09.29-01.00.41:772][550]LogSquadTrace: [DedicatedServer]TraceAndMessageClient(): SQVehicleSeat::TakeDamage[GenericDamage] BP_M1117_C_2144372144 for 2.475000 damage (type=SQBurningDamage)',
			'[2026.09.29-01.00.41:772][550]LogSquadTrace: [DedicatedServer]TraceAndMessageClient(): BP_M1117_C_2144372144: 2.47 damage taken by causer BP_M1117_C_2144372144 instigator (Online Ids: nullptr) INVALID health remaining -1.97',
		])
		expect(destructions).toEqual([
			{
				actor: { className: 'BP_M1117', instanceId: 2144372144 },
				damageType: 'SQBurningDamage',
				cause: 'fire',
				weapon: null,
				attacker: null,
				crew: [],
			},
		])
	})

	// constructed: a turret's enter line names the turret, so its gunner reaches the vehicle through the
	// nearest higher instance id of the same blueprint
	it('counts a turret gunner as crew of the vehicle the turret sits on', async () => {
		const enter = (name: string, eos: string, pawn: string) =>
			`[2026.09.27-09.40.00:000][10]LogSquadTrace: [DedicatedServer]OnPossess(): PC=${name} (Online IDs: EOS: ${eos} steam: 76561198000000000) Entered Vehicle Pawn=${pawn} (Asset Name = BP_M60T_Desert_C) FullPath=x Seat Number=0`
		const destructions = await replay([
			enter('Driver', '0002000000000000000000000000000a', 'BP_M60T_Desert_C_2147476056'),
			enter('Other', '0002000000000000000000000000000b', 'BP_M60T_Desert_C_2147476100'),
			enter('Gunner', '0002000000000000000000000000000c', 'BP_M60T_Turret_Desert_C_2147476046'),
			'[2026.09.27-09.47.42:371][489]LogSquadTrace: [DedicatedServer]TraceAndMessageClient(): SQVehicleSeat::TakeDamage[PointDamage] BP_M60T_Turret_Desert_C_2147476046 for 7509.103027 damage (type=BP_Kinetic_DamageType_C)',
			'[2026.09.27-09.47.42:371][489]LogSquadTrace: [DedicatedServer]TraceAndMessageClient(): SQVehicleSeat::TakeDamage[PointDamage] BP_M60T_Desert_C_2147476056 for 750.910339 damage (type=BP_Kinetic_DamageType_C)',
			'[2026.09.27-09.47.42:371][489]LogSquadTrace: [DedicatedServer]TraceAndMessageClient(): BP_M60T_Desert_C_2147476056: 750.91 damage taken by causer BP_MG253_AP_WPMC_C_2147441582 instigator (Online Ids: MOLOT) EOS: 00026ded7c504ebdac3df18531679199 steam: 76561198935782515 health remaining -313.74',
		])
		expect(destructions).toHaveLength(1)
		expect(destructions[0].actor).toEqual({ className: 'BP_M60T_Desert', instanceId: 2147476056 })
		expect(destructions[0].crew.sort()).toEqual(['0002000000000000000000000000000a', '0002000000000000000000000000000c'])
		expect(destructions[0].damageType).toBe('BP_Kinetic_DamageType')
	})

	it('forgets health across matches', async () => {
		const state = DSTR.init()
		await replay([TRIMM_ENTERS_UH60, ...UH60_SHOT_DOWN], state)
		DSTR.resetForMatch(state, 2)
		expect(state.health.size).toBe(0)
		expect(state.occupants.size).toBe(0)
	})
})

describe('deployables', () => {
	it('reports a deployable destroyed, with its damage type from the same tick', async () => {
		const destructions = await replay([
			'[2026.09.27-20.05.48:982][329]LogSquadTrace: [DedicatedServer]TakeDamage(): BP_Deployable_M15Mine_C_2146811059: 500.00 damage attempt by causer BP_Deployable_M112_C4Explosive_C_2146810491 instigator nagibator777 with damage type BP_Explosives_Damagetype_C health remaining 20.00',
			'[2026.09.27-20.05.48:982][329]LogSquadTrace: [DedicatedServer]TakeDamage(): ASQDeployable::TakeDamage[SQRadialDamage] BP_Deployable_M15Mine_C_2146811059 for 500.000000 damage (type=BP_Explosives_Damagetype_C) direct hit = 0',
			'[2026.09.27-20.05.48:982][329]LogSquadTrace: [DedicatedServer]TakeDamage(): BP_Deployable_M15Mine_C_2146811059: 500.00 damage taken by causer BP_Deployable_M112_C4Explosive_C_2146810491 instigator nagibator777 (Online IDs: EOS: 000243f2d3b640bbbed4633bb7208abf steam: 76561199844672503) health remaining 0.00',
		])
		expect(destructions).toEqual([
			{
				actor: { className: 'BP_Deployable_M15Mine', instanceId: 2146811059 },
				damageType: 'BP_Explosives_Damagetype',
				cause: 'weapon',
				weapon: 'BP_Deployable_M112_C4Explosive',
				attacker: '000243f2d3b640bbbed4633bb7208abf',
				crew: [],
			},
		])
		expect(DSTR.deployableType('BP_Deployable_M15Mine')).toBe('MINE')
	})

	it('ignores wrecks and level-placed objects', async () => {
		expect(
			await replay([
				'[2026.09.28-17.27.55:091][ 34]LogSquadTrace: [DedicatedServer]TakeDamage(): Loach_Destroyed_CAS_C_2147364155: 250.00 damage taken by causer BP_Mortarround4_C_2147330919 instigator nullptr health remaining 0.00',
				'[2026.09.27-09.50.45:703][180]LogSquadTrace: [DedicatedServer]TakeDamage(): BP_SandBagWall_3: 10.00 damage taken by causer BP_Projectile_125mm_Frag_C_2147438011 instigator MOLOT (Online IDs: EOS: 00026ded7c504ebdac3df18531679199 steam: 76561198935782515) health remaining 0.00',
			]),
		).toEqual([])
	})
})

describe('FOB radios', () => {
	const hit = (time: string, damage: number, health: number) =>
		`[2026.09.28-${time}][  5]LogSquadTrace: [DedicatedServer]TakeDamage(): BP_FOBRadio_TLF_C_2147398110: ${damage.toFixed(2)} damage taken by causer BP_EmplacedDshk_C_2147469189 instigator APFSDS-3BM59 (Online IDs: EOS: 00028d93c0ff4633b34d013dd7e75e4b steam: 76561199411874537) health remaining ${health.toFixed(2)}`

	// the first hit is a real line; the rest follow its format
	it('reports an attack as it starts, again after a lull, and when the radio bottoms out', async () => {
		const { destructions, radioDamage } = await replayAll([
			hit('16.15.46:399', 1.6, 298.4),
			hit('16.15.46:508', 1.6, 296.8),
			hit('16.16.30:479', 1.6, 295.2),
			hit('16.17.40:000', 1.6, 293.6),
			hit('16.17.41:000', 200, 93.6),
			hit('16.17.42:000', 115, 24),
			// at its minimum a radio still logs hits, but loses nothing more
			hit('16.19.04:919', 11.5, 24),
		])
		expect(destructions).toEqual([])
		expect(radioDamage.map((d) => [d.health, d.bottomedOut])).toEqual([
			[298.4, false],
			[293.6, false],
			[24, true],
		])
		expect(radioDamage[0]).toMatchObject({
			actor: { className: 'BP_FOBRadio_TLF', instanceId: 2147398110 },
			weapon: 'BP_EmplacedDshk',
			attacker: '00028d93c0ff4633b34d013dd7e75e4b',
		})
	})
})

describe('parseActor', () => {
	it('reads emplacements spawned as child actors', () => {
		expect(DSTR.parseActor('SQDeployableChildActor_GEN_VARIABLE_BP_Emplaced_ZU23-2_Antiaircannon_Base_INS_C_CAT_2147475541')).toEqual({
			className: 'BP_Emplaced_ZU23-2_Antiaircannon_Base_INS',
			instanceId: 2147475541,
		})
		expect(DSTR.parseActor('Trimm Trabb')).toBeNull()
	})
})

describe('teamOfBlueprint', () => {
	it('matches a faction token, abbreviated or not', () => {
		expect(DSTR.teamOfBlueprint('BP_Ammocrate_PLA', ['USA', 'PLA'])).toBe(2)
		expect(DSTR.teamOfBlueprint('US_Hab_Forest', ['USA', 'RGF'])).toBe(1)
	})

	it('prefers an exact faction over one it only abbreviates', () => {
		expect(DSTR.teamOfBlueprint('BP_FOBRadio_PLA', ['PLA', 'PLAAGF'])).toBe(1)
		expect(DSTR.teamOfBlueprint('BP_FOBRadio_PLAAGF', ['PLA', 'PLAAGF'])).toBe(2)
	})

	it('is null when no side, or both, match', () => {
		expect(DSTR.teamOfBlueprint('BP_Deployable_TM62Mine', ['USA', 'RGF'])).toBeNull()
		expect(DSTR.teamOfBlueprint('US_Hab_Forest', ['USA', 'USMC'])).toBeNull()
		expect(DSTR.teamOfBlueprint('BP_InfantryAmmobag_RGF', [undefined, undefined])).toBeNull()
	})
})
