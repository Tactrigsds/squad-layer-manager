import * as SchemaModels from '$root/drizzle/schema.models'
import { assertNever, isNullOrUndef } from '@/lib/type-guards'
import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import { z } from 'zod'

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
	resolveInput: lastNResolvedMatchesForSession(2),
	evaluate: resolveBasicTicketStreak(150, 2),
})

const trig200x2 = createTrigger<'200x2', MH.PostGameMatchDetails[]>({
	id: '200x2',
	version: 1,
	name: '200 tickets x2',
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
		const windowAvgs: { avg: number; length: number }[] = []
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

			if (avgDiff >= 125) {
				windowAvgs.push({ avg: avgDiff, length: currentWindow })
			}
		}

		if (windowAvgs.length === 0) return
		let maxWindow: { avg: number; length: number } | null = null
		for (const window of windowAvgs) {
			if (!maxWindow || window.avg > maxWindow.avg) {
				maxWindow = window
			}
		}

		return {
			code: 'triggered' as const,
			strongerTeam: streaker!,
			messageTemplate: `{{strongerTeam}} has been winning for ${maxWindow!.length} games with an average of (125+)(${
				maxWindow!.avg.toFixed(2)
			}) tickets`,
			relevantInput: matchDetails.slice(matchDetails.length - maxWindow!.length),
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
	return (input: BaseBalanceTriggerInput) => {
		return resolveMatchSession(input.history.slice(Math.max(input.history.length - n, 0)))
	}
}

function resolveMatchSession(matches: MH.MatchDetails[], skipNonPost = false) {
	const terminatingGamemodes = ['Training', 'Seed', 'Invasion', 'Destruction', 'Insurgency']
	const session: MH.PostGameMatchDetails[] = []
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i]
		if (match.status !== 'post-game') {
			if (i === matches.length - 1 && skipNonPost) continue
			break
		}
		if (terminatingGamemodes.includes(L.toLayer(match.layerId)?.Gamemode as string)) break
		session.unshift(match)
	}
	return session
}

export function getTriggerPriority(level: TriggerWarnLevel): number {
	switch (level) {
		case 'violation':
			return 3
		case 'warn':
			return 2
		case 'info':
			return 1
		default:
			assertNever(level)
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

export type CurrentStreak = {
	team: 'teamA' | 'teamB'
	length: number
} | null

/**
 * Calculates the current win streak from match history
 * Returns null if no streak (less than 2 consecutive wins) or if most recent match is a draw
 */
export function getCurrentStreak(matches: MH.MatchDetails[]): CurrentStreak | null {
	return null
	const session = resolveMatchSession(matches, true)
	if (!session.length) return null

	let streaker: 'teamA' | 'teamB' | undefined
	let streakLength = 0

	for (let i = session.length - 1; i >= 0; i--) {
		const match = session[i]
		const outcome = MH.getTeamNormalizedOutcome(match)

		if (outcome.type === 'draw') break

		if (streaker && streaker !== outcome.type) break

		if (isNullOrUndef(streaker)) streaker = outcome.type as 'teamA' | 'teamB'
		streakLength++
	}

	if (!streaker) return null

	return {
		team: streaker!,
		length: streakLength,
	}
}
