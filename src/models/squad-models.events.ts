import type * as SM from './squad.models'

export type NewGame = {
	type: 'NEW_GAME'
	time: Date
	mapClassname: string
	layerClassname: string
}

export type RoundEnded = {
	type: 'ROUND_ENDED'
	time: Date
	winner: SM.SquadOutcomeTeam | null
	loser: SM.SquadOutcomeTeam | null
}

export type Event = NewGame | RoundEnded

export type DebugTicketOutcome = { team1: number; team2: number }
