import type { EmuPlayer, World } from '../emulator'
import { makePlayer } from '../emulator'
import type * as Fmt from '../emulator/format'
import * as Profile from './profile'

// Keeps an emulated server full and busy: a roster of players in squads, players leaving and others taking their
// slots, and log events and chat at the per-minute rates in profile.ts. Each kind of event is a Poisson process,
// sampled once per tick.

export type WorldDriverOptions = {
	players: number
	// multiplies every rate, to model a busier server or compress a longer run
	intensity: number
	// distinct players who come and go over the run; a slot that frees up is taken by one of these
	populationPool: number
	// a match ends this long after it starts. The emulator brings the next one up after its post-match delay.
	matchDurationMs: number
	chatPerMinute: number
	// the server's id, which salts its players' ids and names them
	salt: string
	random?: () => number
	// the emulator's clock, which the history seeder runs ahead of the wall
	now?: () => number
}

export const TICK_MS = 250

// the same people on every run and in the seeded history, so a live match is played by players the history knows
export const poolPlayerName = (serverId: string, i: number) => `Load${serverId}P${i}`
const SQUAD_SIZE = 9
const SQUADS_FORM_AFTER_NEW_GAME_MS = 15_000
const VEHICLES = ['BP_BTR80_Militia', 'BP_M60T_Desert', 'BP_Tigr_RWS', 'BP_LAV25_Woodland', 'BP_BMP2_RU']
const DEPLOYABLES = ['BP_Ammocrate_RGF', 'BP_FOBRadio_RGF', 'BP_Hesco_Wall_Small', 'BP_Sandbag_Wall']
const WEAPONS = ['BP_M4_M68', 'BP_AK74M_1P87', 'BP_M249', 'BP_PKM_Bipod', 'BP_SVD_PSO1']
const CHAT_CHANNELS: Fmt.ChatChannel[] = ['ChatAll', 'ChatTeam', 'ChatTeam', 'ChatSquad', 'ChatSquad', 'ChatSquad']
const CHAT_LINES = ['need ammo at the fob', 'tank on the ridge north', 'rally is down', 'gg', 'who has the hab', 'medic pls']

// Lines no parser rule matches, shaped like the categories that dominate a real log (LogSquadTrace, LogNet,
// LogStreaming). They carry no player names, so they cannot be mistaken for an event about one.
const UNPARSED = [
	'LogSquadTrace: [DedicatedServer]ASQGameMode::PostLogin(): Validating replicated state for controller slot',
	'LogNet: NotifyAcceptingConnection accepted from: 203.0.113.10:7787',
	'LogStreaming: Display: FlushAsyncLoading: 1 QueuedPackages, 0 AsyncPackages',
	'LogSquadCommon: SQCommonDataSubsystem: refreshing cached squad role availability for team',
	'LogRedpointEOSNetworkAuth: Verbose: Connection verification succeeded for an incoming connection',
	'LogGameMode: Display: Match State Changed from InProgress to InProgress',
]

// what the driver needs of a server: an Emulator, or the seeder's world on a fake clock
export type DrivenServer = { world: World; endMatchAndRoll: (opts?: { winnerTeamId?: number }) => void }

export class WorldDriver {
	#emu: DrivenServer
	#opts: WorldDriverOptions
	#random: () => number
	#now: () => number
	#timer: NodeJS.Timeout | null = null
	#offline: EmuPlayer[] = []
	#matchStartedAt = 0
	#awaitingNewGame = false
	#counts = new Map<string, number>()

	constructor(emu: DrivenServer, opts: WorldDriverOptions) {
		this.#emu = emu
		this.#opts = opts
		this.#random = opts.random ?? Math.random
		this.#now = opts.now ?? Date.now
		for (let i = 0; i < opts.populationPool; i++) {
			this.#offline.push(makePlayer({ name: poolPlayerName(opts.salt, i) }, opts.salt))
		}
	}

	get world() {
		return this.#emu.world
	}

	// events emitted so far, by profile key
	get counts(): ReadonlyMap<string, number> {
		return this.#counts
	}

	// fills the server and starts the current match's clock
	fill() {
		while (this.world.players.size < this.#opts.players && this.#offline.length > 0) this.#connectOne()
		this.#formSquads()
		this.#matchStartedAt = this.#now()
	}

	start() {
		this.fill()
		this.#timer = setInterval(() => this.step(), TICK_MS)
	}

	stop() {
		if (this.#timer) clearInterval(this.#timer)
		this.#timer = null
	}

	// one tick's worth of activity, at the driver's clock
	step() {
		const world = this.world
		// the post-match pause: no fighting while the server sits between worlds
		if (this.#awaitingNewGame) {
			// the roll leaves most players team-less until the emulator answers the next ListPlayers
			const startedAt = world.matchStartedAt?.getTime() ?? 0
			if (startedAt > this.#matchStartedAt && this.#now() - startedAt >= SQUADS_FORM_AFTER_NEW_GAME_MS) {
				this.#awaitingNewGame = false
				this.#matchStartedAt = startedAt
				this.#formSquads()
			}
			return
		}
		if (this.#now() - this.#matchStartedAt >= this.#opts.matchDurationMs / this.#opts.intensity) {
			this.#awaitingNewGame = true
			this.#emu.endMatchAndRoll({ winnerTeamId: this.#random() < 0.5 ? 1 : 2 })
			this.#bump('ROUND_ENDED_CHAIN', 1)
			return
		}

		const players = world.playerList()
		if (players.length < 2) return
		const r = Profile.RATES_PER_MINUTE
		const n = (perMinute: number) => this.#poisson((perMinute * this.#opts.intensity * TICK_MS) / 60_000)
		const pick = () => players[Math.floor(this.#random() * players.length)]
		const enemyOf = (p: EmuPlayer) => {
			for (let i = 0; i < 8; i++) {
				const q = pick()
				if (q !== p && q.teamId !== p.teamId) return q
			}
			return pick()
		}
		const weapon = () => WEAPONS[Math.floor(this.#random() * WEAPONS.length)]

		this.#repeat('PLAYER_WOUNDED', n(r.PLAYER_WOUNDED), () => {
			const victim = pick()
			world.woundPlayer(victim, enemyOf(victim), weapon())
		})
		this.#repeat('PLAYER_DIED', n(r.PLAYER_DIED), () => {
			const victim = pick()
			world.killPlayer(victim, enemyOf(victim), weapon())
		})
		this.#repeat('PLAYER_REVIVED', n(r.PLAYER_REVIVED), () => world.revivePlayer(pick(), pick()))
		this.#repeat('PLAYER_RESTARTED', n(r.PLAYER_RESTARTED), () => world.restartPlayer(pick()))
		this.#repeat('VEHICLE_ENTERED', n(r.VEHICLE_ENTERED), () => {
			const vehicle = VEHICLES[Math.floor(this.#random() * VEHICLES.length)]
			world.board(pick(), vehicle, Math.floor(this.#random() * 3))
		})
		this.#repeat('VEHICLE_EXITED', n(r.VEHICLE_EXITED), () => {
			for (let i = 0; i < 8; i++) if (world.getOut(pick())) return
		})
		this.#repeat('VEHICLE_HEALTH_CHANGED', n(r.VEHICLE_HEALTH_CHANGED), () => {
			const vehicle = VEHICLES[Math.floor(this.#random() * VEHICLES.length)]
			world.damageVehicle(pick(), vehicle, 50 + Math.floor(this.#random() * 300))
		})
		this.#repeat('DEPLOYABLE_HEALTH_CHANGED', n(r.DEPLOYABLE_HEALTH_CHANGED), () => {
			world.destroyDeployable(pick(), DEPLOYABLES[Math.floor(this.#random() * DEPLOYABLES.length)])
		})
		this.#repeat('PLAYER_DISCONNECTED', n(r.PLAYER_DISCONNECTED), () => {
			const p = pick()
			world.disconnectPlayer(p)
			this.#offline.push(p)
		})
		// the queue behind a full server takes every slot that frees up
		this.#repeat('PLAYER_CONNECTED_CHAIN', this.#opts.players - world.players.size, () => {
			const p = this.#connectOne()
			if (!p) return
			const squad = world.squads.find((s) => s.teamId === p.teamId && world.squadMembers(s).length < SQUAD_SIZE)
			if (squad) world.joinSquad(p, squad)
		})
		this.#repeat('CHAT_MESSAGE', n(this.#opts.chatPerMinute), () => {
			const channel = CHAT_CHANNELS[Math.floor(this.#random() * CHAT_CHANNELS.length)]
			world.chat(pick(), channel, CHAT_LINES[Math.floor(this.#random() * CHAT_LINES.length)])
		})
		const unparsed = n(Profile.UNPARSED_LINES_PER_MINUTE)
		if (unparsed > 0) {
			const lines: string[] = []
			for (let i = 0; i < unparsed; i++) lines.push(UNPARSED[Math.floor(this.#random() * UNPARSED.length)])
			world.logUnparsed(...lines)
			this.#bump('UNPARSED', unparsed)
		}
	}

	#connectOne(): EmuPlayer | null {
		const i = Math.floor(this.#random() * this.#offline.length)
		const p = this.#offline[i]
		if (!p) return null
		this.#offline[i] = this.#offline[this.#offline.length - 1]
		this.#offline.pop()
		p.teamId = null
		p.squadId = null
		p.isLeader = false
		return this.world.connectPlayer(p)
	}

	// squads are cleared when a new game comes up, so each match is played in fresh ones
	#formSquads() {
		const world = this.world
		for (const teamId of [1, 2]) {
			const team = world.playerList().filter((p) => p.teamId === teamId && p.squadId === null)
			for (let i = 0; i < team.length; i += SQUAD_SIZE) {
				const squad = world.createSquad(team[i], `SQUAD ${i / SQUAD_SIZE + 1}`)
				for (const member of team.slice(i + 1, i + SQUAD_SIZE)) world.joinSquad(member, squad)
			}
		}
	}

	#repeat(key: string, times: number, fn: () => void) {
		for (let i = 0; i < times; i++) fn()
		if (times > 0) this.#bump(key, times)
	}

	#bump(key: string, by: number) {
		this.#counts.set(key, (this.#counts.get(key) ?? 0) + by)
	}

	// Knuth's method, fine for the small means a 250ms tick has
	#poisson(mean: number) {
		const limit = Math.exp(-mean)
		let k = 0
		let p = this.#random()
		while (p > limit) {
			k++
			p *= this.#random()
		}
		return k
	}
}
