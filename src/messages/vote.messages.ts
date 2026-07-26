import * as DH from '@/lib/display-helpers'
import * as Msgs from '@/messages/shared'
import type * as L from '@/models/layer'
import type * as LL from '@/models/layer-list.models'
import type * as V from '@/models/vote.models'

export const BROADCASTS = {
	started(
		state: Pick<V.VoteState, 'choiceIds' | 'voterType'>,
		voteItem: LL.VoteItem | L.LayerId[],
		duration: number,
		displayProps: DH.LayerDisplayProp[],
	) {
		const layerIds = Array.isArray(voteItem)
			? voteItem
			: state.choiceIds.flatMap((id) => {
					const choice = voteItem.choices.find((choice) => choice.itemId === id)
					if (choice) return [choice.layerId]
					return []
				})
		const lines = Msgs.voteChoicesLines(layerIds, undefined, displayProps).join('\n')
		const formattedInterval = Msgs.formatInterval(duration, { terse: false, round: 'second' })
		const voterTypeDisp = state.voterType === 'internal' ? ' (internal)' : ''
		const fullText = `Vote for the next layer${voterTypeDisp}:\n${lines}\nYou have ${formattedInterval} to vote.\n`
		return fullText
	},
	winnerSelected(tally: V.Tally, voteItem: LL.VoteItem, winnerId: LL.ItemId, displayProps: DH.LayerDisplayProp[], early: boolean = false) {
		const resultsText = Array.from(tally.totals.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([choiceId, votes]) => {
				const isWinner = choiceId === winnerId
				const choice = voteItem.choices.find((c) => c.itemId === choiceId)
				const layerName = choice ? DH.toShortLayerNameFromId(choice.layerId, undefined, displayProps) : 'Unknown'
				return `${votes} votes - (${tally.percentages.get(choiceId)?.toFixed(0)}%) ${isWinner ? '[WINNER] ' : ''}${layerName}`
			})
		const randomChoiceExplanation = tally.leaders.length > 1 ? `\n(Winner randomly selected - ${tally.leaders.length} way tie.)` : ''
		const fullText = `\nVote ${early ? 'was' : 'has'} ended${early ? ' early' : ''}:\n${resultsText.join(
			'\n',
		)}\n${randomChoiceExplanation}`
		return fullText
	},
	insufficientVotes(voteItem: LL.VoteItem, displayProps: DH.LayerDisplayProp[]) {
		const defaultChoice = voteItem.choices[0]
		return `\nVote has ended!\nNot enough votes received to decide outcome.\nDefaulting to ${DH.toShortLayerNameFromId(
			defaultChoice.layerId,
			undefined,
			displayProps,
		)}`
	},
	aborted: `\nThe vote has been aborted.`,
	voteReminder(
		state: Extract<V.VoteState, { code: 'in-progress' }>,
		voteItem: LL.VoteItem,
		timeLeft: number,
		finalReminder = false,
		displayProps: DH.LayerDisplayProp[],
	) {
		const durationStr = Msgs.formatInterval(timeLeft, { terse: false, round: 'second' })
		const prefix = finalReminder ? `VOTE NOW: ${durationStr} left to cast your vote!` : `${durationStr} to cast your vote!`

		const lines = Msgs.voteChoicesLines(
			state.choiceIds.flatMap((id) => {
				const choice = voteItem.choices.find((choice) => choice.itemId === id)
				if (choice) return [choice.layerId]
				return []
			}),
			undefined,
			displayProps,
		).join('\n')
		const fullText = `${prefix}\n${lines}`
		return fullText
	},
} satisfies Msgs.MessageNode

export const WARNS = {
	noVoteInProgress: `No vote in progress`,
	invalidChoice: `Invalid vote choice`,
	voteCast: (choice: L.LayerId, displayProps: DH.LayerDisplayProp[]) =>
		`Vote cast for ${DH.toShortLayerNameFromId(choice, undefined, displayProps)}.`,
	wrongChat: (correctChannel: string) => `Vote must be cast in ${correctChannel}`,
	start: {
		noVoteConfigured: `No vote is currently configured`,
		voteAlreadyInProgress: `A vote is already in progress`,
		itemNotFound: `Item not found`,
		invalidItemType: `Referenced item must be a vote`,
		editingInProgress: `Vote is currently being edited`,
		publicVoteNotFirst: `Public vote must be the first item in the queue when initiated`,
		noVoteInPostGame: 'Not votes allowed in post-game',
	},
} satisfies Msgs.WarnNode
