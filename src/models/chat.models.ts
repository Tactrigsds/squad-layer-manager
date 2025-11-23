import * as SM from '@/models/squad.models'

type PlayerIdentifiers = {
	username: string
	discordId?: bigint
	steam64Id?: bigint
	eosID?: string
}

export type PlayerRef = string

export type Player = {
	ids: PlayerIdentifiers
	teamID: SM.TeamId | null
	squadID: SM.SquadId | null
	isLeader: boolean

	joinedAt: number
}

export type Channel = SM.ChatChannel
export type Event = Events.UserMessage

export namespace Events {
	export type UserMessage = {
		type: 'user-message'
		time: number
		message: string
		channel: SM.ChatChannel
		source:
			| 'chat'
			| 'slm'
		player: PlayerRef
	}

	export type AdminCommand = {
		type: 'admin-command'
		commandType: 'warn' | 'kick'
		admin?: PlayerRef
		player: PlayerRef
	}

	export type PlayerJoined = {
		type: 'player-connected'
		time: number
		player: PlayerRef
	}

	export type PlayerLeft = {
		type: 'player-disconnected'
		time: number
		player: PlayerRef
	}

	export type PlayerSwappedTeams = {
		type: 'player-swapped-teams'
		time: number
		player: PlayerRef
		oldTeam: SM.TeamId
		newTeam: SM.TeamId
	}
}

export const BUFFER_MAX_SIZE = 1000
