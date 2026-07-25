import * as SB from '@/models/sandbox.models'
import type { Emulator, EmuPlayer } from './index.ts'
import { makePlayer } from './index.ts'

// Runs the verbs defined in @/models/sandbox.models against a live emulator. Everything that drives a sandbox
// world goes through here: the dev repl, `pnpm emuctl`, and the app's sandbox router.

export type SandboxHost = {
	emu: Emulator
	// GUI/CLI-facing name -> player. The world keys players by eos id; a scenario names them.
	players: Map<string, EmuPlayer>
	// the dev host registers new players with its BattleMetrics stub so the app's lookups resolve rather than 404
	onPlayerJoined?: (player: EmuPlayer) => void
}

export function joinPlayer(host: SandboxHost, name: string): EmuPlayer {
	if (host.players.has(name)) throw new Error(`${name} is already connected`)
	const player = host.emu.world.connectPlayer(makePlayer({ name, teamId: host.players.size % 2 === 0 ? 1 : 2 }))
	host.players.set(name, player)
	host.onPlayerJoined?.(player)
	return player
}

function requirePlayer(host: SandboxHost, name: string): EmuPlayer {
	const player = host.players.get(name)
	if (!player) throw new Error(`no player named '${name}' -- 'players' lists them, 'join ${name}' connects them`)
	return player
}

export async function execute<V extends SB.SandboxVerb>(host: SandboxHost, verb: V, args: unknown): Promise<string> {
	const input = SB.parseVerbArgs(verb, args)
	const world = host.emu.world

	switch (verb) {
		case 'join': {
			const { name } = input as SB.SandboxVerbInput<'join'>
			const player = joinPlayer(host, name)
			return `${name} joined team ${player.teamId} (steam ${player.steam}, eos ${player.eos})`
		}
		case 'leave': {
			const { name } = input as SB.SandboxVerbInput<'leave'>
			world.disconnectPlayer(requirePlayer(host, name))
			host.players.delete(name)
			return `${name} left`
		}
		case 'chat': {
			const { name, message } = input as SB.SandboxVerbInput<'chat'>
			world.chat(requirePlayer(host, name), 'ChatAll', message)
			return `[ChatAll] ${name}: ${message}`
		}
		case 'admchat': {
			const { name, message } = input as SB.SandboxVerbInput<'admchat'>
			world.chat(requirePlayer(host, name), 'ChatAdmin', message)
			return `[ChatAdmin] ${name}: ${message}`
		}
		case 'players': {
			const list = world.playerList()
			if (list.length === 0) return '(nobody connected)'
			return list.map((p) => `  ${p.name}\tteam ${p.teamId ?? '-'}\tsquad ${p.squadId ?? '-'}`).join('\n')
		}
		case 'squad': {
			const { name, squadName } = input as SB.SandboxVerbInput<'squad'>
			const squad = world.createSquad(requirePlayer(host, name), squadName)
			return `${name} created squad ${squad.squadId} '${squadName}' on team ${squad.teamId}`
		}
		case 'cam': {
			const { name, off } = input as SB.SandboxVerbInput<'cam'>
			const player = requirePlayer(host, name)
			if (off) {
				world.unpossessAdminCam(player)
				return `${name} left admin camera`
			}
			world.possessAdminCam(player)
			return `${name} entered admin camera`
		}
		case 'kill': {
			const { victim, attacker } = input as SB.SandboxVerbInput<'kill'>
			world.killPlayer(requirePlayer(host, victim), requirePlayer(host, attacker))
			return `${attacker} killed ${victim}`
		}
		case 'end': {
			const { winnerTeamId } = input as SB.SandboxVerbInput<'end'>
			world.endMatch(winnerTeamId ? { winnerTeamId } : undefined)
			return winnerTeamId ? `match ended, team ${winnerTeamId} won` : 'match ended'
		}
		case 'rcon': {
			const { command } = input as SB.SandboxVerbInput<'rcon'>
			return world.handleCommand(command)
		}
		case 'cycle': {
			await host.emu.cycleRcon()
			return 'rcon cycled'
		}
		case 'rotate': {
			host.emu.rotateLog()
			return 'log rotated'
		}
		default: {
			const _exhaustive: never = verb
			throw new Error(`unknown sandbox verb '${verb as string}'`)
		}
	}
}

// The command-line front end: positional tokens, dispatched by name.
export async function executeTokens(host: SandboxHost, tokens: string[]): Promise<string> {
	const [name, ...rest] = tokens
	if (!name) return ''
	if (name === 'help') return SB.usageLines().join('\n')
	if (!(name in SB.SANDBOX_VERBS)) throw new Error(`unknown command '${name}' -- try 'help'`)
	const verb = name as SB.SandboxVerb
	return await execute(host, verb, SB.SANDBOX_VERBS[verb].tokens(rest))
}
