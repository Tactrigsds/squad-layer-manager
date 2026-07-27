import * as DH from '@/lib/display-helpers'
import * as Msgs from '@/messages/shared'
import type * as L from '@/models/layer'
import type * as LL from '@/models/layer-list.models'
import type * as V from '@/models/vote.models'

export const started = Msgs.def(
	(
		state: Pick<V.VoteState, 'choiceIds' | 'voterType'>,
		voteItem: LL.VoteItem | L.LayerId[],
		duration: number,
		displayProps: DH.LayerDisplayProp[],
	) => {
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
		const text = `Vote for the next layer${voterTypeDisp}:\n${lines}\nYou have ${formattedInterval} to vote.\n`

		return {
			broadcast: () => text,
			// the vote config editor previews the broadcast the server would actually send, so this is the same text
			react: () => text,
		}
	},
)

export const winnerSelected = Msgs.def(
	(tally: V.Tally, voteItem: LL.VoteItem, winnerId: LL.ItemId, displayProps: DH.LayerDisplayProp[], early: boolean = false) => {
		const resultsText = Array.from(tally.totals.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([choiceId, votes]) => {
				const isWinner = choiceId === winnerId
				const choice = voteItem.choices.find((c) => c.itemId === choiceId)
				const layerName = choice ? DH.toShortLayerNameFromId(choice.layerId, undefined, displayProps) : 'Unknown'
				return `${votes} votes - (${tally.percentages.get(choiceId)?.toFixed(0)}%) ${isWinner ? '[WINNER] ' : ''}${layerName}`
			})
		const randomChoiceExplanation = tally.leaders.length > 1 ? `\n(Winner randomly selected - ${tally.leaders.length} way tie.)` : ''

		return {
			broadcast: () =>
				`\nVote ${early ? 'was' : 'has'} ended${early ? ' early' : ''}:\n${resultsText.join('\n')}\n${randomChoiceExplanation}`,
		}
	},
)

export const insufficientVotes = Msgs.def((voteItem: LL.VoteItem, displayProps: DH.LayerDisplayProp[]) => {
	const defaultChoice = voteItem.choices[0]
	return {
		broadcast: () =>
			`\nVote has ended!\nNot enough votes received to decide outcome.\nDefaulting to ${DH.toShortLayerNameFromId(
				defaultChoice.layerId,
				undefined,
				displayProps,
			)}`,
	}
})

export const aborted = Msgs.def(() => ({
	broadcast: () => `\nThe vote has been aborted.`,
}))

export const voteReminder = Msgs.def(
	(
		state: Extract<V.VoteState, { code: 'in-progress' }>,
		voteItem: LL.VoteItem,
		timeLeft: number,
		finalReminder = false,
		displayProps: DH.LayerDisplayProp[],
	) => {
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

		return { broadcast: () => `${prefix}\n${lines}` }
	},
)

export const noVoteInProgress = Msgs.def(() => ({ warn: () => `No vote in progress` }))
export const invalidChoice = Msgs.def(() => ({ warn: () => `Invalid vote choice` }))

export const voteCast = Msgs.def((choice: L.LayerId, displayProps: DH.LayerDisplayProp[]) => ({
	warn: () => `Vote cast for ${DH.toShortLayerNameFromId(choice, undefined, displayProps)}.`,
}))

export const wrongChat = Msgs.def((correctChannel: string) => ({
	warn: () => `Vote must be cast in ${correctChannel}`,
}))

// What the web client tells the admin once a vote mutation comes back ok. Distinct from the broadcasts above,
// which announce the same events to players in game and are worded for that audience.
export const adminReceipt = {
	started: Msgs.def(() => ({ toast: () => ['Vote started!'] })),
	aborted: Msgs.def(() => ({ toast: () => ['Vote aborted!'] })),
	endedEarly: Msgs.def(() => ({ toast: () => ['Vote ended early!'] })),
	autostartCancelled: Msgs.def(() => ({ toast: () => ['Vote autostart cancelled!'] })),
}

export const start = {
	noVoteConfigured: Msgs.def(() => ({ warn: () => `No vote is currently configured` })),
	voteAlreadyInProgress: Msgs.def(() => ({ warn: () => `A vote is already in progress` })),
	itemNotFound: Msgs.def(() => ({ warn: () => `Item not found` })),
	invalidItemType: Msgs.def(() => ({ warn: () => `Referenced item must be a vote` })),
	editingInProgress: Msgs.def(() => ({ warn: () => `Vote is currently being edited` })),
	publicVoteNotFirst: Msgs.def(() => ({ warn: () => `Public vote must be the first item in the queue when initiated` })),
	noVoteInPostGame: Msgs.def(() => ({ warn: () => 'Not votes allowed in post-game' })),
}
