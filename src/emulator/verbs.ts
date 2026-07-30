import * as SB from '@/models/sandbox.models'

import type { Emulator, EmuPlayer } from './index.ts'
import { makePlayer } from './index.ts'
import type { EmuSquad } from './world.ts'

// Runs the verbs defined in @/models/sandbox.models against a live emulator. Everything that drives a sandbox
// world goes through here: the dev repl, `pnpm emuctl`, and the app's sandbox router.

const DEFAULT_VOTE_LAYERS = ['Fallujah_Skirmish_v2', 'Mutaha_Skirmish_v1', 'Chora_Skirmish_v1']
const DEFAULT_VOTE_FACTIONS = ['BAF', 'MEI', 'VDV', 'TLF']

export type SandboxHost = {
	emu: Emulator
	// GUI/CLI-facing name -> player. The world keys players by eos id; a scenario names them.
	players: Map<string, EmuPlayer>
	// the dev host registers new players with its BattleMetrics stub so the app's lookups resolve rather than 404
	onPlayerJoined?: (player: EmuPlayer) => void
	// the emulated admin list, when the host keeps one. Absent (the dev host) means no gating and no editing:
	// that host's admins come from a real Admins.cfg on disk.
	adminList?: {
		isAdmin: (name: string) => boolean
		setPlayerGroups: (name: string, groups: string[]) => void
		defineGroup: (group: string, permissions: string[]) => void
		deleteGroup: (group: string) => void
		groupNames: () => string[]
	}
}

export function nextDefaultName(host: SandboxHost): string {
	for (let i = 0; ; i++) {
		const candidate = SB.defaultPlayerName(i)
		if (!host.players.has(candidate)) return candidate
	}
}

export function joinPlayer(host: SandboxHost, name: string): EmuPlayer {
	if (host.players.has(name)) throw new Error(`${name} is already connected`)
	if (host.players.size >= SB.MAX_PLAYERS) throw new Error(`the server is full (${SB.MAX_PLAYERS} players)`)
	const player = host.emu.world.connectPlayer(makePlayer({ name, teamId: host.players.size % 2 === 0 ? 1 : 2 }))
	host.players.set(name, player)
	host.onPlayerJoined?.(player)
	return player
}

function requireAdminList(host: SandboxHost): NonNullable<SandboxHost['adminList']> {
	if (!host.adminList) throw new Error('this host has no emulated admin list to edit')
	return host.adminList
}

function requirePlayer(host: SandboxHost, name: string): EmuPlayer {
	const player = host.players.get(name)
	if (!player) throw new Error(`no player named '${name}' -- 'players' lists them, 'join ${name}' connects them`)
	return player
}

// A squad is addressed by id or by name, and only among its player's own team: (team, id) is what identifies one,
// and a squad on the other team is not one they could join.
function requireSquad(host: SandboxHost, player: EmuPlayer, ref: string): EmuSquad {
	const teamId = player.teamId
	if (teamId === null) throw new Error(`${player.name} is not on a team yet, so has no squads to join`)
	const onTeam = host.emu.world.squads.filter((s) => s.teamId === teamId)
	const squad = onTeam.find((s) => String(s.squadId) === ref.trim() || s.name === ref.trim())
	if (!squad) {
		const known = onTeam.map((s) => `${s.squadId} '${s.name}'`).join(', ')
		throw new Error(`no squad '${ref}' on team ${teamId}${known ? ` -- there is ${known}` : ' -- it has no squads'}`)
	}
	return squad
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
			const { name, message, channel } = input as SB.SandboxVerbInput<'chat'>
			const player = requirePlayer(host, name)
			if (channel === 'ChatAdmin' && host.adminList && !host.adminList.isAdmin(name)) {
				throw new Error(`${name} is not an admin, so cannot speak in admin chat`)
			}
			world.chat(player, channel, message)
			return `[${channel}] ${name}: ${message}`
		}
		case 'admchat': {
			const { name, message } = input as SB.SandboxVerbInput<'admchat'>
			const player = requirePlayer(host, name)
			// a real server does not show admin chat to non-admins, let alone let them speak in it
			if (host.adminList && !host.adminList.isAdmin(name)) {
				throw new Error(`${name} is not an admin, so cannot speak in admin chat`)
			}
			world.chat(player, 'ChatAdmin', message)
			return `[ChatAdmin] ${name}: ${message}`
		}
		case 'bulk-join': {
			const { count } = input as SB.SandboxVerbInput<'bulk-join'>
			const room = SB.MAX_PLAYERS - host.players.size
			if (room <= 0) throw new Error(`the server is full (${SB.MAX_PLAYERS} players)`)
			const names: string[] = []
			// clamp rather than throw partway: joining some and then failing would leave the world changed by a
			// command that reported an error
			for (let i = 0; i < Math.min(count, room); i++) names.push(joinPlayer(host, nextDefaultName(host)).name)
			const short = count > room ? ` (${count - room} refused: server full)` : ''
			return `${names.length} joined${short}: ${names.join(', ')}`
		}
		case 'set-player-groups': {
			const { name, groups } = input as SB.SandboxVerbInput<'set-player-groups'>
			requirePlayer(host, name)
			const list = requireAdminList(host)
			const unknown = groups.filter((g) => !list.groupNames().includes(g))
			if (unknown.length > 0) throw new Error(`no such group: ${unknown.join(', ')}`)
			list.setPlayerGroups(name, groups)
			return groups.length > 0 ? `${name} is now in ${groups.join(', ')}` : `${name} is no longer in the admin list`
		}
		case 'define-group': {
			const { group, permissions } = input as SB.SandboxVerbInput<'define-group'>
			requireAdminList(host).defineGroup(group, permissions)
			return `group ${group} grants ${permissions.length > 0 ? permissions.join(', ') : 'nothing'}`
		}
		case 'delete-group': {
			const { group } = input as SB.SandboxVerbInput<'delete-group'>
			const list = requireAdminList(host)
			if (!list.groupNames().includes(group)) throw new Error(`no such group: ${group}`)
			list.deleteGroup(group)
			return `group ${group} removed`
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
		case 'squads': {
			const squads = world.squads
			if (squads.length === 0) return '(no squads)'
			return squads
				.map(
					(s) =>
						`  team ${s.teamId}\t${s.squadId}\t${s.name}\t${world
							.squadMembers(s)
							.map((p) => p.name)
							.join(', ')}`,
				)
				.join('\n')
		}
		case 'join-squad': {
			const { name, squad } = input as SB.SandboxVerbInput<'join-squad'>
			const player = requirePlayer(host, name)
			const target = requireSquad(host, player, squad)
			world.joinSquad(player, target)
			return `${name} joined squad ${target.squadId} '${target.name}' on team ${target.teamId}`
		}
		case 'leave-squad': {
			const { name } = input as SB.SandboxVerbInput<'leave-squad'>
			const player = requirePlayer(host, name)
			if (player.squadId === null) throw new Error(`${name} is not in a squad`)
			world.leaveSquad(player)
			return `${name} left their squad`
		}
		case 'set-team': {
			const { name, teamId } = input as SB.SandboxVerbInput<'set-team'>
			const player = requirePlayer(host, name)
			if (player.teamId === teamId) return `${name} is already on team ${teamId}`
			world.setTeam(player, teamId)
			return `${name} moved to team ${teamId}`
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
			host.emu.endMatchAndRoll(winnerTeamId ? { winnerTeamId } : undefined)
			return winnerTeamId ? `match ended, team ${winnerTeamId} won` : 'match ended'
		}
		case 'vote': {
			const { kind, choices } = input as SB.SandboxVerbInput<'vote'>
			const resolved = choices.length > 0 ? choices : kind === 'layer' ? DEFAULT_VOTE_LAYERS : DEFAULT_VOTE_FACTIONS
			world.startIngameVote(kind, resolved)
			return `${kind} vote opened between ${resolved.join(', ')}`
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
