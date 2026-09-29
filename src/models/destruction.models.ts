import type * as SM from '@/models/squad.models'

// Vehicles and deployables being destroyed, and FOB radios being attacked, worked out from the game log. Squad logs
// no "destroyed" line, so a destruction is an actor's health crossing from above zero to zero or below, across the
// per-hit health lines (SM.LogEvents VEHICLE_HEALTH_CHANGED / DEPLOYABLE_HEALTH_CHANGED). This module holds the
// per-match state that takes (health, previous crossing, crew) and turns those lines into destructions. It knows
// nothing of teams or the layer: pending-events.models.ts resolves those when it builds the server event.
//
// Log quirks it has to absorb:
// - A crewed vehicle's health line names an occupant instead of the vehicle. The DAMAGE_APPLIED line for the same
//   hit, in the same tick and with the same damage, names the vehicle's actor, so that is how it is found.
// - A turret seat's enter line names the turret's actor, never the vehicle's, and only gives the vehicle's
//   blueprint. The turret is matched to the vehicle of that blueprint with the nearest higher instance id: the
//   engine spawns a vehicle's turrets just after it, and hands out instance ids in descending order.
// - Wrecks (`Loach_Destroyed_CAS`, `CTM131_Obliterate`) are actors of their own and take damage too.
// - Level-placed objects (`BP_SandBagWall_3`) have no instance suffix, and are not anyone's to lose.
// - FOB radios bottom out at RADIO_MIN_HEALTH and are never logged reaching zero, so a radio is never destroyed
//   here. An attack on one is reported instead: once when it starts, and once when the radio bottoms out. A radio
//   takes several hits a second while under fire, so one report per hit would bury everything else.

// the health a FOB radio stops losing at, measured across every radio in two days of production logs
export const RADIO_MIN_HEALTH = 24
// how long a radio has to go without losing health before its next hit counts as a new attack
export const RADIO_ATTACK_GAP_MS = 60_000

export const DEPLOYABLE_TYPES = [
	'MINE',
	'AMMO',
	'RADIO',
	'HAB',
	'FORTIFICATION',
	'EMPLACEMENT',
	'REPAIR',
	'EXPLOSIVE',
	'DEPLOYABLE',
] as const
export type DeployableType = (typeof DEPLOYABLE_TYPES)[number]

// how the final hit landed. 'fire' and 'ammo' are the vehicle burning out or its ammunition cooking off, which
// still carry whoever set them off as the instigator.
export const CAUSES = ['weapon', 'fire', 'ammo', 'collision'] as const
export type Cause = (typeof CAUSES)[number]

// an actor as the log names it, split into its blueprint (without `_C`) and instance
export type Actor = { className: string; instanceId: number }

const CHILD_ACTOR_PREFIX = 'SQDeployableChildActor_GEN_VARIABLE_'

export function parseActor(name: string): Actor | null {
	const match = name.match(/^(.+?)_C(?:_CAT)?_(\d+)$/)
	if (!match) return null
	const className = match[1].startsWith(CHILD_ACTOR_PREFIX) ? match[1].slice(CHILD_ACTOR_PREFIX.length) : match[1]
	return { className, instanceId: Number(match[2]) }
}

export function isWreck(className: string): boolean {
	return /(?:^|_)(?:destroyed?|obliterate|burn|burning|crash|wreck)(?:_|$)/i.test(className)
}

export function deployableType(className: string): DeployableType {
	if (/FOBRadio|(?:^|_)Radio(?:_|$)/i.test(className)) return 'RADIO'
	if (/(?:^|_)Hab(?:_|$)/i.test(className)) return 'HAB'
	if (/Mine/i.test(className)) return 'MINE'
	if (/Ammo(?:crate|bag|box)/i.test(className)) return 'AMMO'
	if (/Repair/i.test(className)) return 'REPAIR'
	if (/C4|IED|Explosive|Satchel/i.test(className)) return 'EXPLOSIVE'
	if (/Mortar|Emplaced|Tripod|TOW|Kornet|DShK|ZU23|Cannon|Launcher/i.test(className)) return 'EMPLACEMENT'
	if (/Sandbag|Hesco|Bunker|Wire|Wall|Ladder|Tower|Barrier|Hedgehog|Trench|Tent/i.test(className)) return 'FORTIFICATION'
	return 'DEPLOYABLE'
}

// The side a deployable belongs to, read off a faction id spelled as one of the blueprint's tokens
// (BP_Ammocrate_PLA, RGF_Hab_Woodland). A token may abbreviate the id (US_Hab_Forest for USA), so it matches as a
// prefix too, but only in capitals: a faction id is always spelled so, and a word never is. Null when neither or
// both sides match.
export function teamOfBlueprint(className: string, factions: [string | undefined, string | undefined]): SM.TeamId | null {
	const tokens = className.split(/[_-]/).filter((token) => token.length >= 2 && token === token.toUpperCase())
	const matches = factions.map((faction) => !!faction && tokens.some((token) => faction.toUpperCase().startsWith(token)))
	if (matches[0] === matches[1]) return null
	return matches[0] ? 1 : 2
}

// a blueprint as a reader would name it, for the ones the layer data has no name for: BP_Ammocrate_PLA -> Ammocrate PLA
export function prettyClassName(className: string): string {
	return className
		.replace(/^BP_/, '')
		.replace(/^Deployable_/, '')
		.replace(/[_-]+/g, ' ')
		.trim()
}

// every value a destroyed event's targetType can hold: the layer data's vehicle types, then the deployable types
export function targetTypes(vehicleTypes: readonly string[] | undefined): string[] {
	return [...(vehicleTypes ?? []), ...DEPLOYABLE_TYPES]
}

// damage types keep their blueprint spelling minus `_C`, like weapons (SM.LogEvents normalizeWeapon)
export function normalizeDamageType(damageType: string): string {
	return damageType.replace(/_C$/, '')
}

export function causeOf(damageType: string | null): Cause {
	if (damageType === 'SQBurningDamage') return 'fire'
	if (damageType === 'SQDamageType_Collision') return 'collision'
	if (damageType !== null && /AmmoBox/i.test(damageType)) return 'ammo'
	return 'weapon'
}

type Hit = { actor: string; damage: number; damageType: string }

type Occupant = { username: string; pawn: string; assetClass: string }

export type State = {
	matchId: number | null
	// last health seen per actor, vehicles and deployables alike. Kept after a destruction, so later lines on the
	// same actor cannot cross zero again.
	health: Map<string, number>
	// vehicle actors seen, by blueprint, for matching turrets back to their vehicle
	vehiclesByClass: Map<string, Set<string>>
	occupants: Map<SM.PlayerId, Occupant>
	// the DAMAGE_APPLIED lines of the tick being read. A tick's key is its time and chainID together, since the
	// chainID alone wraps at 1000.
	tick: { key: string; hits: Hit[] }
	// when each radio last lost health, for telling a new attack from the one in progress
	radioLastHitAt: Map<string, number>
}

export function init(): State {
	return {
		matchId: null,
		health: new Map(),
		vehiclesByClass: new Map(),
		occupants: new Map(),
		tick: { key: '', hits: [] },
		radioLastHitAt: new Map(),
	}
}

// Everything here is per match: actor names are not reused across one, but health from the last one is stale.
export function resetForMatch(state: State, matchId: number) {
	if (state.matchId === matchId) return
	state.matchId = matchId
	state.health.clear()
	state.vehiclesByClass.clear()
	state.occupants.clear()
	state.tick = { key: '', hits: [] }
	state.radioLastHitAt.clear()
}

function tickKey(event: { time: number; chainID: number }) {
	return `${event.time}:${event.chainID}`
}

function noteVehicle(state: State, actorName: string) {
	const actor = parseActor(actorName)
	if (!actor) return
	let actors = state.vehiclesByClass.get(actor.className)
	if (!actors) state.vehiclesByClass.set(actor.className, (actors = new Set()))
	actors.add(actorName)
}

export function onDamageApplied(state: State, event: SM.LogEvents.DamageApplied) {
	const key = tickKey(event)
	if (state.tick.key !== key) state.tick = { key, hits: [] }
	state.tick.hits.push({ actor: event.actor, damage: event.damage, damageType: normalizeDamageType(event.damageType) })
}

export function onVehicleEntered(state: State, event: SM.LogEvents.VehicleEntered) {
	const assetClass = event.assetClass.replace(/_C$/, '')
	if (parseActor(event.pawn)?.className === assetClass) noteVehicle(state, event.pawn)
	state.occupants.set(event.playerIds.eos, { username: event.playerIds.username, pawn: event.pawn, assetClass })
}

export function onVehicleExited(state: State, event: SM.LogEvents.VehicleExited) {
	state.occupants.delete(event.playerIds.eos)
}

// the vehicle actor an occupant's pawn belongs to: the pawn itself for the vehicle's own seats, else the turret's
// vehicle as the module header describes
function vehicleOfPawn(state: State, occupant: Occupant): string | null {
	const pawn = parseActor(occupant.pawn)
	if (!pawn) return null
	if (pawn.className === occupant.assetClass) return occupant.pawn
	let best: { name: string; id: number } | null = null
	for (const name of state.vehiclesByClass.get(occupant.assetClass) ?? []) {
		const id = parseActor(name)!.instanceId
		if (id > pawn.instanceId && (!best || id < best.id)) best = { name, id }
	}
	return best?.name ?? null
}

function vehicleOfOccupantName(state: State, username: string): string | null {
	for (const occupant of state.occupants.values()) {
		if (occupant.username === username) return vehicleOfPawn(state, occupant)
	}
	return null
}

function crewOf(state: State, vehicle: string): SM.PlayerId[] {
	const crew: SM.PlayerId[] = []
	for (const [playerId, occupant] of state.occupants) {
		if (vehicleOfPawn(state, occupant) === vehicle) crew.push(playerId)
	}
	return crew
}

function hitsThisTick(state: State, event: { time: number; chainID: number }): Hit[] {
	return state.tick.key === tickKey(event) ? state.tick.hits : []
}

// the vehicle actor a health line is about, for the lines that name an occupant instead
function resolveVehicle(state: State, event: SM.LogEvents.VehicleHealthChanged): string | null {
	if (parseActor(event.subject)) return event.subject
	const candidates = hitsThisTick(state, event).filter((hit) => Math.abs(hit.damage - event.damage) < 0.01 && parseActor(hit.actor))
	const byOccupant = vehicleOfOccupantName(state, event.subject)
	if (candidates.length === 1) return candidates[0].actor
	if (byOccupant && (candidates.length === 0 || candidates.some((hit) => hit.actor === byOccupant))) return byOccupant
	return candidates.at(-1)?.actor ?? null
}

// A causer is the weapon's blueprint, or the attacking vehicle's occupant when the damage came from a crewed
// vehicle, in which case it is that vehicle's blueprint.
function weaponOf(state: State, causer: string): string | null {
	const actor = parseActor(causer)
	if (actor) return actor.className
	const vehicle = vehicleOfOccupantName(state, causer)
	return vehicle ? parseActor(vehicle)!.className : null
}

export type Destruction = {
	actor: Actor
	damageType: string | null
	cause: Cause
	// null when the vehicle finished itself (fire, cook-off, collision), or the causer could not be identified
	weapon: string | null
	attacker: SM.PlayerId | null
	crew: SM.PlayerId[]
}

// Records the health a line reports, returning what it was before.
function recordHealth(state: State, actorName: string, damage: number, health: number): number {
	const previous = state.health.get(actorName) ?? health + damage
	state.health.set(actorName, health)
	return previous
}

function crossedZero(state: State, actorName: string, damage: number, health: number): boolean {
	const previous = recordHealth(state, actorName, damage, health)
	return damage > 0 && previous > 0 && health <= 0
}

export function onVehicleHealthChanged(state: State, event: SM.LogEvents.VehicleHealthChanged): Destruction | null {
	const vehicle = resolveVehicle(state, event)
	if (!vehicle) return null
	noteVehicle(state, vehicle)
	if (!crossedZero(state, vehicle, event.damage, event.health)) return null
	const hit = hitsThisTick(state, event).findLast((h) => h.actor === vehicle && Math.abs(h.damage - event.damage) < 0.01)
	const damageType = hit?.damageType ?? null
	const selfInflicted = event.causer === event.subject || event.causer === vehicle
	return {
		actor: parseActor(vehicle)!,
		damageType,
		cause: causeOf(damageType),
		weapon: selfInflicted ? null : weaponOf(state, event.causer),
		attacker: event.instigatorIds?.eos ?? null,
		crew: crewOf(state, vehicle),
	}
}

export type RadioDamage = {
	actor: Actor
	damageType: string | null
	weapon: string | null
	attacker: SM.PlayerId | null
	health: number
	// this hit took the radio down to RADIO_MIN_HEALTH
	bottomedOut: boolean
}

export type DeployableOutcome = ({ kind: 'destroyed' } & Destruction) | ({ kind: 'radio-damaged' } & RadioDamage)

export function onDeployableHealthChanged(state: State, event: SM.LogEvents.DeployableHealthChanged): DeployableOutcome | null {
	const actor = parseActor(event.actor)
	if (!actor || isWreck(actor.className)) return null
	const previous = recordHealth(state, event.actor, event.damage, event.health)
	const lostHealth = event.damage > 0 && event.health < previous
	const hit = () => hitsThisTick(state, event).findLast((h) => h.actor === event.actor)
	const weapon = () => (event.causer === event.actor ? null : weaponOf(state, event.causer))

	if (deployableType(actor.className) === 'RADIO') {
		if (!lostHealth) return null
		const lastHitAt = state.radioLastHitAt.get(event.actor)
		state.radioLastHitAt.set(event.actor, event.time)
		const attackStarts = lastHitAt === undefined || event.time - lastHitAt > RADIO_ATTACK_GAP_MS
		const bottomedOut = previous > RADIO_MIN_HEALTH && event.health <= RADIO_MIN_HEALTH
		if (!attackStarts && !bottomedOut) return null
		return {
			kind: 'radio-damaged',
			actor,
			damageType: hit()?.damageType ?? null,
			weapon: weapon(),
			attacker: event.instigatorIds?.eos ?? null,
			health: event.health,
			bottomedOut,
		}
	}

	if (!(lostHealth && previous > 0 && event.health <= 0)) return null
	const damageType = hit()?.damageType ?? null
	return {
		kind: 'destroyed',
		actor,
		damageType,
		cause: causeOf(damageType),
		weapon: weapon(),
		attacker: event.instigatorIds?.eos ?? null,
		crew: [],
	}
}
