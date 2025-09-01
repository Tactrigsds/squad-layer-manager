import { Parts } from '@/lib/types'
import { HumanTime } from '@/lib/zod'
import * as USR from '@/models/users.models'
import { z } from 'zod'
import * as LL from './layer-list.models'

export const VOTER_TYPE = z.enum(['public', 'internal'])

export type VoterType = z.infer<typeof VOTER_TYPE>

export const AdvancedVoteConfigSchema = z.object({
	duration: z.number().positive().optional(),
})

export type AdvancedVoteConfig = z.infer<typeof AdvancedVoteConfigSchema>

export const StartVoteInputSchema = z.object({
	itemId: z.string().optional(),
	voterType: VOTER_TYPE.optional(),
	...AdvancedVoteConfigSchema.shape,
})

export type StartVoteInput = z.infer<typeof StartVoteInputSchema>

export function getDefaultVoteConfig() {
	return {
		duration: HumanTime.parse('120s'),
	} satisfies AdvancedVoteConfig
}

const TallyPropertiesSchema = z.object({
	votes: z.record(z.string(), z.string()),
	deadline: z.number(),
})

type TallyProperties = z.infer<typeof TallyPropertiesSchema>

const LayerVoteSchema = z.object({
	itemId: z.string(),
	choices: z.array(z.string()),
	voterType: VOTER_TYPE,
})

type LayerVote = z.infer<typeof LayerVoteSchema>

export const VoteStateSchema = z.discriminatedUnion('code', [
	// the vote state doesn't have to be set to 'ready' before they're started. this is here so we can autostart votes for the next layer
	z.object({
		code: z.literal('ready'),
		...LayerVoteSchema.shape,

		autostartTime: z.date().optional(),
	}),

	z.object({
		code: z.literal('in-progress'),
		initiator: z.union([USR.GuiOrChatUserIdSchema, z.literal('autostart')]),
		...TallyPropertiesSchema.shape,
		...LayerVoteSchema.shape,
	}),
])

export type VoteState = z.infer<typeof VoteStateSchema>

export const EndingVoteStateSchema = z.discriminatedUnion('code', [
	z.object({
		code: z.literal('ended:winner'),
		winner: z.string(),
		...TallyPropertiesSchema.shape,
		...LayerVoteSchema.shape,
	}),
	z.object({
		code: z.literal('ended:aborted'),
		aborter: z.union([USR.GuiOrChatUserIdSchema, z.literal('autostart')]),
		...TallyPropertiesSchema.shape,
		...LayerVoteSchema.shape,
	}),
	z.object({
		code: z.literal('ended:insufficient-votes'),
		...TallyPropertiesSchema.shape,
		...LayerVoteSchema.shape,
	}),
])

export type EndingVoteState = z.infer<typeof EndingVoteStateSchema>

export type VoteStateWithVoteData = Extract<
	VoteState | EndingVoteState,
	{ code: 'in-progress' | 'ended:winner' | 'ended:aborted' | 'ended:insufficient-votes' }
>

export const TallySchema = z.object({
	totals: z.map(z.string(), z.number()),
	totalVotes: z.number(),
	turnoutPercentage: z.number(),
	percentages: z.map(z.string(), z.number()),
	leaders: z.array(z.string()),
})

export type Tally = z.infer<typeof TallySchema>

export function tallyVotes(currentVote: VoteStateWithVoteData, numPlayers: number): Tally {
	if (Object.values(currentVote.choices).length == 0) {
		throw new Error('No choices listed')
	}
	const tally = new Map<string, number>()
	let leaders: string[] = []
	for (const choice of currentVote.choices) {
		tally.set(choice, 0)
	}

	for (const choice of Object.values(currentVote.votes)) {
		const newVotesForChoice = tally.get(choice)! + 1

		if (leaders.length === 0) {
			leaders = [choice]
		} else if (tally.get(leaders[0]!) === newVotesForChoice) {
			leaders.push(choice)
		} else if (tally.get(leaders[0]!)! < newVotesForChoice) {
			leaders = [choice]
		}
		tally.set(choice, newVotesForChoice)
	}
	const totalVotes = Object.values(currentVote.votes).length
	const percentages = new Map<string, number>()
	if (totalVotes > 0) {
		for (const [choice, votes] of tally.entries()) {
			percentages.set(choice, (votes / totalVotes) * 100)
		}
	}
	const turnoutPercentage = (totalVotes / numPlayers) * 100
	return {
		totals: tally,
		totalVotes,
		turnoutPercentage: isNaN(turnoutPercentage) ? 0 : turnoutPercentage,
		percentages,
		leaders: leaders,
	}
}

export type VoteStateUpdateOrInitialWithParts =
	| {
		code: 'initial-state'
		state: (VoteState & Parts<USR.UserPart>) | null
	}
	| {
		code: 'update'
		update: VoteStateUpdate & Parts<USR.UserPart>
	}

export type VoteStateUpdateOrInitial =
	| {
		code: 'initial-state'
		state: VoteState | null
	}
	| { code: 'update'; update: VoteStateUpdate }

export type VoteStateUpdate = {
	state: VoteState | null
	source:
		| {
			type: 'system'
			event: 'automatic-start-vote' | 'vote-timeout' | 'queue-change' | 'next-layer-override' | 'app-startup' | 'new-game'
		}
		| {
			type: 'manual'
			event: 'start-vote' | 'abort-vote' | 'vote' | 'queue-change'
			user: USR.GuiOrChatUserId
		}
}
export type VoteStateUpdateSource = VoteStateUpdate['source']
export type VoteStateUpdateSourceEvent = VoteStateUpdateSource['event']
export type ManualVoteStateUpdateSourceEvent = Extract<VoteStateUpdateSource, { type: 'manual' }>['event']

export function getDefaultChoice(state: { choices: string[] }) {
	return state.choices[0]
}

export function canInitiateVote(
	itemId: string,
	queue: LL.LayerList,
	voterType: VoterType,
	voteState?: Pick<VoteState | EndingVoteState, 'code'>,
) {
	const itemRes = LL.findItemById(queue, itemId)
	if (!itemRes) {
		return {
			code: 'err:item-not-found' as const,
		}
	}
	const item = itemRes.item

	if (!LL.isParentVoteItem(item)) {
		return {
			code: 'err:invalid-item-type' as const,
		}
	}

	if (voterType === 'public' && itemRes.outerIndex !== 0) {
		return {
			code: 'err:public-vote-not-first' as const,
		}
	}
	if (voteState?.code === 'in-progress') {
		return {
			code: 'err:vote-in-progress' as const,
		}
	}

	return {
		code: 'ok' as const,
		item,
	}
}
