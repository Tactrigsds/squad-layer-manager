import * as SchemaModels from '$root/drizzle/schema.models'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import * as C from '@/server/context'
import { z } from 'zod'
import { isNullOrUndef } from '../lib/type-guards'

// -------- types --------
type BaseBalanceTriggerInput = {
	// includes current match
	history: MH.MatchDetails[]
}

export const TRIGGER_LEVEL = SchemaModels.TRIGGER_LEVEL
export type TriggerWarnLevel = z.infer<typeof TRIGGER_LEVEL>
export type BalanceTriggerEvent = SchemaModels.BalanceTriggerEvent
export type EvaluationResultBase = { code: 'triggered'; strongerTeam: 'teamA' | 'teamB'; genericMessage: string }
export type BalanceTrigger<ID extends string, Input> = {
	id: ID
	name: string
	// update whenever we change the logic for the trigger
	version: number
	description: string

	// the result of resolveInput will be serialized and included in the event log
	resolveInput: (input: BaseBalanceTriggerInput) => Input

	// feel free to add more detail in the output
	evaluate: (ctx: C.Log, input: Input) => EvaluationResultBase | undefined

	// types only, for convenience
	_: {
		input: Input
	}
}

export type EvaluationResult<BT extends BalanceTrigger<string, any>> = ReturnType<BT['evaluate']>
export type SpecificBalanceTriggerEvent<BT extends BalanceTrigger<string, any>> = BalanceTriggerEvent & {
	input: BT['_']['input']
	triggerId: BT['id']
} & { evaluationResult: EvaluationResult<BT> }
export type BalanceTriggerInstance = typeof TRIGGERS[keyof typeof TRIGGERS]
export type BalanceTriggerEventInstance = SpecificBalanceTriggerEvent<BalanceTriggerInstance>

// -------- trigger definitions --------
function createTrigger<Id extends string, Input>(trigger: Omit<BalanceTrigger<Id, Input>, '_'>) {
	return trigger as BalanceTrigger<Id, Input>
}

const trig150x2 = createTrigger<'150x2', MH.PostGameMatchDetails[]>({
	id: '150x2',
	version: 1,
	name: '150 tickets x2',
	description: '2 consecutive games of a Team winning by 150+ tickets',
	resolveInput: (input) => input.history.slice(input.history.length - 2, input.history.length).filter(m => m.status === 'post-game'),
	evaluate: (_ctx, matchDetails) => {
		let prevWinner: 'teamA' | 'teamB' | undefined
		if (matchDetails.length < 2) return
		let match!: MH.PostGameMatchDetails
		let matchLayerDetails!: ReturnType<typeof L.toLayer>
		for (let i = matchDetails.length - 1; i >= matchDetails.length - 2; i--) {
			match = matchDetails[i]
			matchLayerDetails = L.toLayer(match.layerId)
			if (['Seed', 'Training', 'Invasion'].includes(matchLayerDetails.Gamemode as string)) return
			const outcome = MH.getTeamNormalizedOutcome(match)
			if (outcome.type === 'draw') return

			if (prevWinner && prevWinner !== outcome.type) return
			if (Math.abs(outcome.teamATickets - outcome.teamBTickets) < 150) return
			if (isNullOrUndef(prevWinner)) prevWinner = outcome.type
		}
		return { code: 'triggered' as const, strongerTeam: prevWinner!, genericMessage: `${prevWinner} has won two games by 150+ tickets.` }
	},
})

export const TRIGGERS = {
	[trig150x2.id]: trig150x2,
} satisfies { [key: string]: BalanceTrigger<string, any> }

type TriggerId = keyof typeof TRIGGERS
export const TRIGGER_IDS = z.enum(Object.keys(TRIGGERS) as unknown as [TriggerId, ...TriggerId[]])

// -------- helpers --------

export function isEventForTrigger<BT extends BalanceTrigger<string, any>>(
	trigger: BT,
	event: BalanceTriggerEvent,
): event is SpecificBalanceTriggerEvent<BT> {
	return event.triggerId === trigger.id && event.triggerVersion === trigger.version
}

export function isKnownEventInstance(event: BalanceTriggerEvent): event is BalanceTriggerEventInstance {
	for (const trigger of Object.values(TRIGGERS)) {
		if (isEventForTrigger(trigger, event)) return true
	}
	return false
}
