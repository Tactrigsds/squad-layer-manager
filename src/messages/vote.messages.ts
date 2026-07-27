import * as DH from '@/lib/display-helpers'
import * as MsgFmt from '@/messages/format'
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
		const lines = MsgFmt.voteChoicesLines(layerIds, undefined, displayProps).join('\n')
		const formattedInterval = MsgFmt.formatInterval(duration, { terse: false, round: 'second' })
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
		const durationStr = MsgFmt.formatInterval(timeLeft, { terse: false, round: 'second' })
		const prefix = finalReminder ? `VOTE NOW: ${durationStr} left to cast your vote!` : `${durationStr} to cast your vote!`
		const lines = MsgFmt.voteChoicesLines(
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

// -------- the vote row on the queue --------

export const heading = Msgs.def(() => ({ text: () => 'Vote' }))

// reads as "starts in <countdown>"
export const startsIn = Msgs.def(() => ({ text: () => 'starts in' }))

export const cancelAutostart = Msgs.def(() => ({ text: () => 'Cancel Autostart' }))

export const tally = Msgs.def((received: number, players: number) => ({ text: () => `${received} of ${players} votes received` }))

export const endVoteEarly = Msgs.def(() => ({ text: () => 'End Vote Early' }))

export const abortVote = Msgs.def(() => ({ text: () => 'Abort Vote' }))

// an internal vote polls the admins in SLM rather than the players in game
export const internalVote = Msgs.def(() => ({ text: () => 'Internal' }))

export const startVote = Msgs.def(() => ({ text: () => 'Start Vote' }))

export const addVoteChoices = Msgs.def(() => ({ text: () => 'Add Vote Choices' }))

export const configureVote = Msgs.def(() => ({ text: () => 'Configure vote' }))

export const generateVoteTitle = Msgs.def(() => ({ text: () => 'Generate Vote' }))

export const saveVoteConfig = Msgs.def(() => ({ text: () => 'Save' }))

// -------- the vote display config editor --------

export const displayOptionsHeading = Msgs.def(() => ({ text: () => 'Vote Display Options' }))

export const displayOptionsBlurb = Msgs.def(() => ({ text: () => 'Choose what info to show to voters' }))

export const displayLayer = Msgs.def(() => ({ text: () => 'Layer' }))

export const displayMap = Msgs.def(() => ({ text: () => 'Map' }))

export const displayGamemode = Msgs.def(() => ({ text: () => 'Gamemode' }))

export const displayFactions = Msgs.def(() => ({ text: () => 'Factions' }))

export const displayUnits = Msgs.def(() => ({ text: () => 'Units' }))

export const choicesIndistinguishable = Msgs.def(() => ({ text: () => "Warning: Can't distinguish between vote choices." }))

export const previewLabel = Msgs.def(() => ({ text: () => 'Preview' }))

export const durationLabel = Msgs.def(() => ({ text: () => 'Vote Duration (seconds)' }))

export const resetToDefault = Msgs.def(() => ({ text: () => 'Reset to Default' }))

// -------- the generate-vote dialog --------

export const noLayerSelected = Msgs.def(() => ({ text: () => 'No layer selected' }))

export const editChoice = Msgs.def(() => ({ text: () => 'Edit this choice' }))

export const regenerateChoice = Msgs.def(() => ({ text: () => 'Regenerate this choice' }))

export const generateChoice = Msgs.def(() => ({ text: () => 'Generate this choice' }))

export const removeChoice = Msgs.def(() => ({ text: () => 'Remove this choice (minimum 2 required)' }))

export const addChoiceHint = Msgs.def(() => ({ text: () => 'Add choice' }))

export const addChoice = Msgs.def(() => ({ text: () => 'Add Choice' }))

export const playNext = Msgs.def(() => ({ text: () => 'Play Next' }))

export const playAfter = Msgs.def(() => ({ text: () => 'Play After' }))

export const submit = Msgs.def(() => ({ text: () => 'Submit' }))

// -------- the tally readout --------

export const voteEnded = Msgs.def(() => ({ text: () => 'Vote has ended.' }))

export const voteInProgress = Msgs.def(() => ({ text: () => 'Vote in progress...' }))

export const unknownChoice = Msgs.def(() => ({ text: () => 'Unknown' }))

export const choiceVotes = Msgs.def((votes: number, percentage: number) => ({
	text: () => `${votes} vote${votes !== 1 ? 's' : ''} (${percentage.toFixed(1)}%)`,
}))

export const turnout = Msgs.def((received: number, players: number, percentage: number | null) => ({
	text: () => `Received: ${received} of ${players} votes` + (percentage !== null ? ` (${percentage.toFixed(1)}%)` : ''),
}))
