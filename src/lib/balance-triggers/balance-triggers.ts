import * as SM from '@/lib/rcon/squad-models'
import * as M from '@/models'
import * as C from '@/server/context'
import { z } from 'zod'
import { isNullOrUndef } from '../typeGuards'

type BaseBalanceTriggerInput = {
	// includes current match
	history: SM.MatchDetails[]
}

export const TRIGGER_WARN_LEVEL = z.enum(['low', 'high'])
export type TriggerWarnLevel = z.infer<typeof TRIGGER_WARN_LEVEL>
export type BalanceTriggerEvent<Id extends string, Input> = {
	triggerId: Id
	matchTriggered: number
	message: string
	strongerTeam: 'teamA' | 'teamB'
	input: Input
}

export type BalanceTrigger<I> = {
	id: string
	name: string
	description: string
	level: TriggerWarnLevel

	// the result of resolveInput will be serialized and included in the event log
	resolveInput: (input: BaseBalanceTriggerInput) => I
	evaluate: (ctx: C.Log, input: I) => { code: 'triggered'; msg: string; strongerTeam: 'teamA' | 'teamB' } | undefined
}

export function add<I>(trigger: BalanceTrigger<I>) {
	return {
		[trigger.id]: trigger,
	}
}

export type BalanceTriggerInstance = typeof BALANCE_TRIGGERS[keyof typeof BALANCE_TRIGGERS]
export const BALANCE_TRIGGERS = {
	...add<SM.MatchDetails[]>({
		id: '150x2',
		name: '150 tickets x2',
		description: '2 consecutive games of a Team winning by 150+ tickets',
		level: 'high',
		resolveInput: (input) => input.history.slice(input.history.length - 2, input.history.length),
		evaluate: (_ctx, matchDetails) => {
			let prevWinner: 'teamA' | 'teamB' | undefined
			if (matchDetails.length < 2) return
			let match!: SM.MatchDetails
			let matchLayerDetails!: ReturnType<typeof M.getLayerPartial>
			for (let i = matchDetails.length - 1; i > matchDetails.length - 2; i--) {
				match = matchDetails[i]
				matchLayerDetails = M.getLayerPartial(M.getUnvalidatedLayerFromId(match.layerId))
				if (matchLayerDetails.Gamemode === 'Seed' || matchLayerDetails.Gamemode === 'Training') return
				if (match.status !== 'post-game') return
				const outcome = SM.getTeamNormalizedOutcome(match)
				if (outcome.type === 'draw') return

				if (prevWinner !== outcome.type) return
				if (isNullOrUndef(prevWinner)) prevWinner = outcome.type
			}
			return { code: 'triggered', msg: `${prevWinner!} has won by 150+ tickets two games in a row.`, strongerTeam: prevWinner! }
		},
	}),
} satisfies Record<string, BalanceTrigger<any>>

export function getTrigger(triggerId: string) {
	return BALANCE_TRIGGERS[triggerId]
}
