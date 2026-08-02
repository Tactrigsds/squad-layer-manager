import * as SB from '@/models/sandbox.models'

import * as EmuControl from '../../src/dev/emu-control'
import * as Verbs from '../../src/emulator/verbs'
import { steamIdForName } from '../../src/emulator/world'
import type { AppFixture } from '../harness/app-fixture'
import { cmd } from '../harness/arrange'
import { type Recorder, type Rng, sleep } from './metrics'

// The in-game half of the load: a populated server whose players talk, kill each other, shuffle between squads,
// come and go, and type commands, with the map rolling underneath all of it.
//
// This is where most of the app's involuntary work comes from. Every line here is parsed out of the tailed
// SquadGame.log, and the roster behind it is polled over RCON, so the cost of a busy server is paid whether or
// not anyone has the dashboard open.

const CHATTER = [
	'need a medic',
	'squad up',
	'anyone on hab',
	'gg',
	'push left flank',
	'logi run inbound',
	'who has the truck',
	'nice shot',
	'fob is under attack',
	'+1',
]

const SQUAD_NAMES = ['INF', 'ARMOR', 'LOGI', 'RECON', 'CAS', 'MORTARS', 'HAT', 'ENGI']

// What a player can type in all-chat. Only the commands whose defaults allow the public chat group; anything
// else is refused before it reaches a handler, which would measure the rejection rather than the work.
const PUBLIC_COMMANDS = ['shownext', 'reqs', 'admin help please', 'requestlayer gorodok raas', 'rmreq']

// What the seeded admin types in admin chat. `help all` renders every command's usage and `broadcast` goes back
// out over rcon, so the mix costs more than a status read.
const ADMIN_COMMANDS = ['slmstatus', 'shownext', 'reqs', 'warns', 'swaps', 'listflags', 'help all', 'broadcast load test in progress']

export type IngameOptions = {
	app: AppFixture
	recorder: Recorder
	rng: Rng
	signal: AbortSignal
	// how many players to hold on the server
	players: number
	// the player whose steam id the fixture seeded into Admins.cfg
	adminName: string
	// mean gap between one player action and the next, across the whole server
	actionIntervalMs: number
	// mean gap between map rolls. 0 never rolls.
	rollIntervalMs: number
}

export type IngameActor = {
	// connects the starting roster; separate from run() so a scenario can warm up before profiling starts
	populate: () => Promise<void>
	run: () => Promise<void>
	playerNames: () => string[]
	adminSteamId: string
}

export function playerName(index: number): string {
	return `Loader${index}`
}

export function createIngameActor(opts: IngameOptions): IngameActor {
	const { app, recorder, rng, signal } = opts
	const { host, join } = EmuControl.createEmuHost({ emu: app.emu, bm: app.bm })
	// the fixture seeds Admins.cfg before boot, and the admin list is cached for an hour after that, so who is
	// an admin has to be decided by then -- the emulator's ids are derived from the name, which is what makes
	// that possible (see steamIdForName)
	const adminSteamId = steamIdForName(opts.adminName)
	let nextPlayerIndex = 0

	const names = () => [...host.players.keys()]
	const others = () => names().filter((name) => name !== opts.adminName)

	async function verb<V extends SB.SandboxVerb>(action: string, name: V, args: SB.SandboxVerbInput<V>) {
		await recorder.time(`ingame:${action}`, () => Verbs.execute(host, name, args))
	}

	// One action, chosen from a mix that adds up to roughly what a full server produces: mostly talk and
	// killfeed, with squad and roster churn underneath and a command every so often.
	async function act() {
		const roll = rng.next()
		const roster = others()
		if (roster.length === 0) return

		if (roll < 0.4) {
			return verb('chat', 'chat', {
				name: rng.pick(roster),
				message: rng.pick(CHATTER),
				channel: rng.pick(['ChatAll', 'ChatTeam', 'ChatSquad']),
			})
		}
		if (roll < 0.6) {
			const victim = rng.pick(roster)
			const attacker = rng.pick(roster)
			if (victim === attacker) return
			return verb('kill', 'kill', { victim, attacker })
		}
		if (roll < 0.72) return squadChurn(roster)
		if (roll < 0.8) return playerChurn(roster)
		if (roll < 0.85) {
			return verb('set-team', 'set-team', { name: rng.pick(roster), teamId: rng.chance(0.5) ? 1 : 2 })
		}
		if (roll < 0.93) {
			return verb('public-command', 'chat', { name: rng.pick(roster), message: cmd(rng.pick(PUBLIC_COMMANDS)), channel: 'ChatAll' })
		}
		return verb('admin-command', 'admchat', { name: opts.adminName, message: cmd(rng.pick(ADMIN_COMMANDS)) })
	}

	async function squadChurn(roster: string[]) {
		const player = rng.pick(roster)
		if (app.emu.world.squads.length < SQUAD_NAMES.length && rng.chance(0.3)) {
			return verb('squad-create', 'squad', { name: player, squadName: rng.pick(SQUAD_NAMES) })
		}
		if (rng.chance(0.3)) {
			if (host.players.get(player)?.squadId === null) return
			return verb('squad-leave', 'leave-squad', { name: player })
		}
		// a squad is identified by (team, id), so only this player's own team's squads are ones they could join
		const joinable = app.emu.world.squads.filter((squad) => squad.teamId === host.players.get(player)?.teamId)
		if (joinable.length === 0) return
		return verb('squad-join', 'join-squad', { name: player, squad: String(rng.pick(joinable).squadId) })
	}

	// A disconnect and a reconnect, which is what churn looks like to the app: a roster the next poll has to
	// diff, and a player it has never resolved before. The name is never reused, so the joiner is genuinely new
	// each time -- a returning one would be served from whatever the app already cached about them.
	async function playerChurn(roster: string[]) {
		await verb('leave', 'leave', { name: rng.pick(roster) })
		await recorder.time('ingame:join', () => join(playerName(nextPlayerIndex++)))
	}

	return {
		adminSteamId,
		playerNames: names,
		populate: async () => {
			join(opts.adminName)
			for (let i = 0; i < opts.players - 1; i++) join(playerName(nextPlayerIndex++))
			// squads before the load starts, so the roster the app polls looks like a running match rather than
			// 60 unassigned players
			for (const squadName of SQUAD_NAMES) {
				const unassigned = others().filter((name) => host.players.get(name)?.squadId === null)
				if (unassigned.length === 0) break
				await Verbs.execute(host, 'squad', { name: unassigned[0], squadName })
			}
			for (const name of others()) {
				const squads = app.emu.world.squads.filter((squad) => squad.teamId === host.players.get(name)?.teamId)
				if (squads.length === 0 || host.players.get(name)?.squadId !== null) continue
				await Verbs.execute(host, 'join-squad', { name, squad: String(rng.pick(squads).squadId) }).catch(() => {})
			}
		},
		run: async () => {
			const rolls = opts.rollIntervalMs > 0 ? rollLoop(opts) : null
			while (!signal.aborted) {
				await act()
				await sleep(rng.jitter(opts.actionIntervalMs), signal)
			}
			await rolls
		},
	}
}

// The map roll is the most expensive thing that happens on a squad server, for the app as much as for the
// game: the queue advances, a match closes and another opens, and the whole roster is re-read as one snapshot.
//
// Timed to the match row rather than to the emulator, so the number is what the app took to see the roll
// through, not what the emulator took to write the lines. `endMatchAndRoll` is the realistic sequence: the
// round-end lines, then WaitingPostMatch, then the next world -- which is why the wait has to outlast the
// scenario's postMatchDelayMs.
async function rollLoop(opts: IngameOptions) {
	const { app, recorder, rng, signal } = opts
	while (!signal.aborted) {
		await sleep(rng.jitter(opts.rollIntervalMs, 0.25), signal)
		if (signal.aborted) return
		await recorder.time('ingame:roll', async () => {
			const before = matchCount(app)
			app.emu.endMatchAndRoll()
			await app.waitFor(() => matchCount(app) > before, { label: 'the roll producing a new match row', timeoutMs: 60_000 })
		})
	}
}

function matchCount(app: AppFixture): number {
	const db = app.readDb()
	try {
		return (db.prepare(`SELECT count(*) as n FROM matchHistory`).get() as { n: number }).n
	} finally {
		db.close()
	}
}
