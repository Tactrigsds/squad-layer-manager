import * as SchemaModels from '$root/drizzle/schema.models'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import { z } from 'zod'
import { isNullOrUndef } from '../lib/type-guards'

// -------- types --------
type BaseBalanceTriggerInput = {
	// last entry will the match for the current trigger event
	history: MH.MatchDetails[]
}

export const TRIGGER_LEVEL = SchemaModels.TRIGGER_LEVEL
export type TriggerWarnLevel = z.infer<typeof TRIGGER_LEVEL>
export type BalanceTriggerEvent = SchemaModels.BalanceTriggerEvent
export type EvaluationResultBase<Input> = {
	code: 'triggered'
	strongerTeam: 'teamA' | 'teamB'
	messageTemplate: string
	relevantInput: Input
}
export type BalanceTrigger<ID extends string, Input> = {
	id: ID
	name: string
	// update whenever we change the logic for the trigger
	version: number
	description: string

	// the result of resolveInput will be serialized and included in the event log
	resolveInput: (input: BaseBalanceTriggerInput) => Input

	// feel free to add more detail in the input
	evaluate: (ctx: CS.Log, input: Input) => EvaluationResultBase<Input> | undefined

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
	resolveInput: lastNResolvedMatchesForSession(2),
	evaluate: resolveBasicTicketStreak(150, 2),
})

const trig200x2 = createTrigger<'200x2', MH.PostGameMatchDetails[]>({
	id: '200x2',
	version: 1,
	name: '200 tickets x2',
	description: '2 consecutive games of a Team winning by 200+ tickets',
	resolveInput: lastNResolvedMatchesForSession(2),
	evaluate: resolveBasicTicketStreak(200, 2),
})

function resolveBasicTicketStreak(threshold: number, length: number) {
	return (_ctx: CS.Log, matchDetails: MH.PostGameMatchDetails[]) => {
		let prevWinner: 'teamA' | 'teamB' | undefined
		if (matchDetails.length < length) return
		let match!: MH.PostGameMatchDetails
		for (let i = matchDetails.length - 1; i >= 0; i--) {
			match = matchDetails[i]
			const outcome = MH.getTeamNormalizedOutcome(match)
			if (outcome.type === 'draw') return

			if (prevWinner && prevWinner !== outcome.type) return
			if (Math.abs(outcome.teamATickets - outcome.teamBTickets) < threshold) return
			if (isNullOrUndef(prevWinner)) prevWinner = outcome.type
		}
		return {
			code: 'triggered' as const,
			strongerTeam: prevWinner!,
			messageTemplate: `{{strongerTeam}} has won ${length} games by ${threshold}+ tickets.`,
			relevantInput: matchDetails,
		}
	}
}

const trigRWS5 = createTrigger<'RWS5', MH.PostGameMatchDetails[]>({
	id: 'RWS5',
	version: 1,
	name: 'Raw Win Streak Across 5',
	description: '5 consecutive games of a team winning by any number of tickets',
	resolveInput: lastNResolvedMatchesForSession(5),
	evaluate: (_ctx, matchDetails) => {
		let streaker: 'teamA' | 'teamB' | undefined
		let match!: MH.PostGameMatchDetails
		let streakLength = 0
		for (let i = matchDetails.length - 1; i >= 0; i--) {
			match = matchDetails[i]
			const outcome = MH.getTeamNormalizedOutcome(match)
			if (outcome.type === 'draw') break
			if (streaker && streaker !== outcome.type) break
			if (isNullOrUndef(streaker)) streaker = outcome.type
			streakLength++
			if (streakLength === 5) {
				return {
					code: 'triggered' as const,
					strongerTeam: streaker!,
					messageTemplate: `{{strongerTeam}} has won five games in a row.`,
					relevantInput: matchDetails,
				}
			}
		}
	},
})

const trigRAM3Plus = createTrigger<'RAM3+', MH.PostGameMatchDetails[]>({
	id: 'RAM3+',
	version: 1,
	name: 'Maximum Rolling Average Across 3+',
	description: 'a rolling average of 150+ tickets across any streak of 3 or more games (utilizing the max of all options.)',
	resolveInput: lastNResolvedMatchesForSession(20),
	evaluate: (_ctx, matchDetails) => {
		let streaker: 'teamA' | 'teamB' | undefined
		let match!: MH.PostGameMatchDetails
		let streakLength = 0
		for (let i = matchDetails.length - 1; i >= 0; i--) {
			match = matchDetails[i]
			const outcome = MH.getTeamNormalizedOutcome(match)
			if (outcome.type === 'draw') break
			if (streaker && streaker !== outcome.type) break
			if (isNullOrUndef(streaker)) streaker = outcome.type
			streakLength++
		}

		if (streakLength < 3 || !streaker) return
		for (let currentWindow = 3; currentWindow <= streakLength; currentWindow++) {
			let totalA = 0
			let totalB = 0

			for (let i = matchDetails.length - currentWindow; i < matchDetails.length; i++) {
				const match = matchDetails[i]
				const outcome = MH.getTeamNormalizedOutcome(match)
				if (outcome.type === 'draw') throw new Error('Draw outcome')
				totalA += outcome.teamATickets
				totalB += outcome.teamBTickets
			}

			const avgA = totalA / currentWindow
			const avgB = totalB / currentWindow

			const avgWinner = streaker === 'teamA' ? avgA : avgB
			const avgLoser = streaker === 'teamA' ? avgB : avgA
			const avgDiff = avgWinner - avgLoser

			if (avgDiff >= 150) {
				return {
					code: 'triggered' as const,
					strongerTeam: streaker!,
					messageTemplate: `{{strongerTeam}} has been winning for ${currentWindow} games with an average of +${avgDiff} tickets`,
					relevantInput: matchDetails.slice(matchDetails.length - currentWindow),
				}
			}
		}
	},
})

export const TRIGGERS = {
	[trig150x2.id]: trig150x2,
	[trig200x2.id]: trig200x2,
	[trigRWS5.id]: trigRWS5,
	[trigRAM3Plus.id]: trigRAM3Plus,
} satisfies { [key: string]: BalanceTrigger<string, any> }

export type TriggerId = keyof typeof TRIGGERS
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

function lastNResolvedMatchesForSession(n: number) {
	const terminatingGamemodes = ['Training', 'Seed', 'Invasion', 'Destruction', 'Insurgency']
	return (input: BaseBalanceTriggerInput): MH.PostGameMatchDetails[] => {
		const matches: MH.PostGameMatchDetails[] = []
		for (let i = input.history.length - 1; i >= 0 && matches.length < n; i--) {
			const match = input.history[i]
			if (match.status !== 'post-game') break
			const layer = L.toLayer(match.layerId)
			if (terminatingGamemodes.includes(layer.Gamemode as string)) break
			matches.unshift(match)
		}
		return matches
	}
}

export function getTriggerPriority(level: string): number {
	switch (level) {
		case 'violation':
			return 3
		case 'warn':
			return 2
		case 'info':
			return 1
		default:
			return 0
	}
}

export function getHighestPriorityTriggerEvent(events: BalanceTriggerEvent[]): BalanceTriggerEvent | null {
	if (events.length === 0) return null

	let highestPriority = 0
	let highestEvent = null

	for (const event of events) {
		const priority = getTriggerPriority(event.level)
		if (priority > highestPriority) {
			highestPriority = priority
			highestEvent = event
		}
	}

	return highestEvent
}
