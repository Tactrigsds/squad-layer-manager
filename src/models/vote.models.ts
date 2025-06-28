import { Parts } from '@/lib/types'
import * as USR from '@/models/users.models'
import { z } from 'zod'
import * as L from './layer'

export const StartVoteInputSchema = z.object({
	restart: z.boolean().default(false),
	durationSeconds: z.number().positive(),
})

type TallyProperties = {
	votes: Record<string, L.LayerId>
	deadline: number
}

export type VoteState =
	| ({ code: 'ready' } & LayerVote)
	| (
		& {
			code: 'in-progress'
			initiator: USR.GuiOrChatUserId
		}
		& TallyProperties
		& LayerVote
	)
	| (
		& {
			code: 'ended:winner'
			winner: L.LayerId
		}
		& TallyProperties
		& LayerVote
	)
	| (
		& {
			code: 'ended:aborted'
			aborter: USR.GuiOrChatUserId
		}
		& TallyProperties
		& LayerVote
	)
	| (
		& {
			code: 'ended:insufficient-votes'
		}
		& TallyProperties
		& LayerVote
	)

export const LayerVoteSchema = z.object({
	defaultChoice: L.LayerIdSchema,
	choices: z.array(L.LayerIdSchema),
})
export type LayerVote = z.infer<typeof LayerVoteSchema>

export type VoteStateWithVoteData = Extract<
	VoteState,
	{ code: 'in-progress' | 'ended:winner' | 'ended:aborted' | 'ended:insufficient-votes' }
>

export type Tally = ReturnType<typeof tallyVotes>
export function tallyVotes(currentVote: VoteStateWithVoteData, numPlayers: number) {
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
		turnoutPercentage: isNaN(turnoutPercentage) ? null : turnoutPercentage,
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
			event: 'vote-timeout' | 'queue-change' | 'next-layer-override' | 'app-startup'
		}
		| {
			type: 'manual'
			event: 'start-vote' | 'abort-vote' | 'vote' | 'queue-change'
			user: USR.GuiOrChatUserId
		}
}
