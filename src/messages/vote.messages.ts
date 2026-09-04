import * as DH from '@/lib/display-helpers'
import * as MsgFmt from '@/messages/format'
import type * as L from '@/models/layer'
import type * as LL from '@/models/layer-list.models'
import { def, join, t } from '@/models/messages.models'
import type * as V from '@/models/vote.models'

export const started = def(
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
		// the vote config editor previews the broadcast the server would actually send, so text serves both
		return {
			text: ({ locale }) =>
				t('Vote for the next layer{internal, select, yes { (internal)} other {}}:\n{lines}\nYou have {duration} to vote.\n', {
					internal: state.voterType === 'internal' ? 'yes' : 'no',
					lines,
					duration: MsgFmt.formatInterval(duration, { round: 'second', locale }),
				}),
		}
	},
)

export const winnerSelected = def(
	(tally: V.Tally, voteItem: LL.VoteItem, winnerId: LL.ItemId, displayProps: DH.LayerDisplayProp[], early: boolean = false) => {
		const results = Array.from(tally.totals.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([choiceId, votes]) => {
				const choice = voteItem.choices.find((c) => c.itemId === choiceId)
				return t('{votes} votes - ({percentage}%) {isWinner, select, yes {[WINNER] } other {}}{layerName}', {
					votes,
					percentage: tally.percentages.get(choiceId)?.toFixed(0),
					isWinner: choiceId === winnerId ? 'yes' : 'no',
					layerName: choice ? DH.toShortLayerNameFromId(choice.layerId, undefined, displayProps) : t('Unknown'),
				})
			})
		const tie = tally.leaders.length > 1 ? [t('\n(Winner randomly selected - {count} way tie.)', { count: tally.leaders.length })] : []

		return {
			broadcast: join([
				t('\nVote {early, select, yes {was ended early} other {has ended}}:', { early: early ? 'yes' : 'no' }),
				...results,
				...tie,
			]),
		}
	},
)

export const insufficientVotes = def((voteItem: LL.VoteItem, displayProps: DH.LayerDisplayProp[]) => {
	const defaultChoice = voteItem.choices[0]
	return {
		broadcast: t('\nVote has ended!\nNot enough votes received to decide outcome.\nDefaulting to {toShortLayerNameFromId}', {
			toShortLayerNameFromId: DH.toShortLayerNameFromId(defaultChoice.layerId, undefined, displayProps),
		}),
	}
})

export const aborted = def(() => ({
	broadcast: t('\nThe vote has been aborted.'),
}))

export const voteReminder = def(
	(
		state: Extract<V.VoteState, { code: 'in-progress' }>,
		voteItem: LL.VoteItem,
		timeLeft: number,
		finalReminder = false,
		displayProps: DH.LayerDisplayProp[],
	) => {
		const lines = MsgFmt.voteChoicesLines(
			state.choiceIds.flatMap((id) => {
				const choice = voteItem.choices.find((choice) => choice.itemId === id)
				if (choice) return [choice.layerId]
				return []
			}),
			undefined,
			displayProps,
		).join('\n')

		return {
			broadcast: ({ locale }) =>
				t('{final, select, yes {VOTE NOW: {duration} left to cast your vote!} other {{duration} to cast your vote!}}\n{lines}', {
					final: finalReminder ? 'yes' : 'no',
					duration: MsgFmt.formatInterval(timeLeft, { round: 'second', locale }),
					lines,
				}),
		}
	},
)

export const noVoteInProgress = def('No vote in progress')
export const invalidChoice = def('Invalid vote choice')

export const voteCast = def((choice: L.LayerId, displayProps: DH.LayerDisplayProp[]) => ({
	warn: t('Vote cast for {toShortLayerNameFromId}.', {
		toShortLayerNameFromId: DH.toShortLayerNameFromId(choice, undefined, displayProps),
	}),
}))

export const wrongChat = def((correctChannel: string) => ({
	warn: t('Vote must be cast in {correctChannel}', { correctChannel }),
}))

// What the web client tells the admin once a vote mutation comes back ok. Distinct from the broadcasts above,
// which announce the same events to players in game and are worded for that audience.
export const adminReceipt = {
	started: def(() => ({ toast: [t('Vote started!')] })),
	aborted: def(() => ({ toast: [t('Vote aborted!')] })),
	endedEarly: def(() => ({ toast: [t('Vote ended early!')] })),
	autostartCancelled: def(() => ({ toast: [t('Vote autostart cancelled!')] })),
}

export const start = {
	noVoteConfigured: def('No vote is currently configured'),
	voteAlreadyInProgress: def('A vote is already in progress'),
	itemNotFound: def('Item not found'),
	invalidItemType: def('Referenced item must be a vote'),
	editingInProgress: def('Vote is currently being edited'),
	publicVoteNotFirst: def('Public vote must be the first item in the queue when initiated'),
	noVoteInPostGame: def('Not votes allowed in post-game'),
}

// -------- the vote row on the queue --------

export const heading = def('Vote')

// reads as "starts in <countdown>"
export const startsIn = def('starts in')

export const cancelAutostart = def('Cancel Autostart')

export const tally = def('{received} of {players} votes received', (received: number, players: number) => ({ received, players }))

export const endVoteEarly = def('End Vote Early')

export const abortVote = def('Abort Vote')

// an internal vote polls the admins in SLM rather than the players in game
export const internalVote = def('Internal')

export const startVote = def('Start Vote')

export const addVoteChoices = def('Add Vote Choices')

export const configureVote = def('Configure vote')

export const generateVoteTitle = def('Generate Vote')

export const saveVoteConfig = def('Save')

// -------- the vote display config editor --------

export const displayOptionsHeading = def('Vote Display Options')

export const displayOptionsBlurb = def('Choose what info to show to voters')

export const displayLayer = def('Layer')

export const displayMap = def('Map')

export const displayGamemode = def('Gamemode')

export const displayFactions = def('Factions')

export const displayUnits = def('Units')

export const choicesIndistinguishable = def("Warning: Can't distinguish between vote choices.")

export const previewLabel = def('Preview')

export const durationLabel = def('Vote Duration (seconds)')

export const resetToDefault = def('Reset to Default')

// -------- the generate-vote dialog --------

export const noLayerSelected = def('No layer selected')

export const editChoice = def('Edit this choice')

export const regenerateChoice = def('Regenerate this choice')

export const generateChoice = def('Generate this choice')

export const removeChoice = def('Remove this choice (minimum 2 required)')

export const addChoiceHint = def('Add choice')

export const addChoice = def('Add Choice')

export const playNext = def('Play Next')

export const playAfter = def('Play After')

export const submit = def('Submit')

// -------- the tally readout --------

export const voteEnded = def('Vote has ended.')

export const voteInProgress = def('Vote in progress...')

export const unknownChoice = def('Unknown')

export const choiceVotes = def('{votes, plural, one {# vote} other {# votes}} ({percentage}%)', (votes: number, percentage: number) => ({
	votes,
	percentage: percentage.toFixed(1),
}))

export const turnout = def(
	'Received: {received} of {players} votes{hasPercentage, select, yes { ({percentage}%)} other {}}',
	(received: number, players: number, percentage: number | null) => ({
		received,
		players,
		percentage: percentage?.toFixed(1),
		hasPercentage: percentage != null ? 'yes' : 'no',
	}),
)

// the generate dialog's constraint-key toggles read as filters without a label; the switch reveals the picker's
// constraint menu
export const varyBy = def('Vary by')
export const showAdvanced = def('Show advanced')
export const advancedBlurb = def('applied to every choice, on top of the pool')
export const regenerateAll = def('Regenerate All')
export const generate = def('Generate')
export const enableUnique = def('Enable unique constraint')
export const disableUnique = def('Disable unique constraint')
