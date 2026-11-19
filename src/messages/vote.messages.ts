import { assertNever } from '@/lib/type-guards'
import * as MsgFmt from '@/messages/format'
import { def, join, t } from '@/models/messages.models'
import * as V from '@/models/vote.models'

// Every broadcast below takes the choices as players see them (V.voteItemChoices for a layer vote), so a layer vote and a
// simple vote announce their reminders and results the same way.

export const started = def((voterType: V.VoterType, labels: string[], duration: number) => ({
	// the vote config editor previews the broadcast the server would actually send, so text serves both
	text: ({ locale }) =>
		t('Vote for the next layer{internal, select, yes { (internal)} other {}}:\n{lines}\nYou have {duration} to vote.\n', {
			internal: voterType === 'internal' ? 'yes' : 'no',
			lines: MsgFmt.numberedChoiceLines(labels, locale).join('\n'),
			duration: MsgFmt.formatInterval(duration, { round: 'second', locale }),
		}),
}))

export const winnerSelected = def((tally: V.Tally, choices: V.VoteChoice[], winnerId: string, early: boolean) => {
	const results = choices
		.map((choice) => ({ choice, votes: tally.totals.get(choice.id) ?? 0 }))
		.sort((a, b) => b.votes - a.votes)
		.map(({ choice, votes }) =>
			t('{votes} votes - ({percentage}%) {isWinner, select, yes {[WINNER] } other {}}{choice}', {
				votes,
				percentage: tally.percentages.get(choice.id)?.toFixed(0),
				isWinner: choice.id === winnerId ? 'yes' : 'no',
				choice: choice.label,
			}),
		)
	const tie = tally.leaders.length > 1 ? [t('\n(Winner randomly selected - {count} way tie.)', { count: tally.leaders.length })] : []
	return {
		broadcast: join([
			t('\nVote {early, select, yes {was ended early} other {has ended}}:', { early: early ? 'yes' : 'no' }),
			...results,
			...tie,
		]),
	}
})

// `fallback` is what a layer vote falls back to. A simple vote has none.
export const insufficientVotes = def((fallback?: string) => ({
	broadcast: t(
		'\nVote has ended!\nNot enough votes received to decide outcome.{hasFallback, select, yes {\nDefaulting to {fallback}} other {}}',
		{ hasFallback: fallback === undefined ? 'no' : 'yes', fallback },
	),
}))

export const aborted = def(() => ({
	broadcast: t('\nThe vote has been aborted.'),
}))

export const voteReminder = def((labels: string[], timeLeft: number, finalReminder: boolean) => ({
	broadcast: ({ locale }) =>
		t('{final, select, yes {VOTE NOW: {duration} left to cast your vote!} other {{duration} to cast your vote!}}\n{lines}', {
			final: finalReminder ? 'yes' : 'no',
			duration: MsgFmt.formatInterval(timeLeft, { round: 'second', locale }),
			lines: MsgFmt.numberedChoiceLines(labels, locale).join('\n'),
		}),
}))

export const noVoteInProgress = def('No vote in progress')
// an end or abort aimed at a vote that has since ended, or been replaced by another
export const voteChanged = def('That vote is no longer running')
export const invalidChoice = def('Invalid vote choice')

export const voteCast = def((label: string) => ({ warn: t('Vote cast for {choice}.', { choice: label }) }))

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

export const choiceTextsLabel = def('Choice text')

export const choiceTextsBlurb = def('Shown to players in place of the layer. Leave blank to show the layer details.')

export const choiceTextFor = def('Text for choice {position}, {layer}', (position: number, layer: string) => ({ position, layer }))

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

export const createVote = def('Create Vote')

// -------- simple votes --------

export const simple = {
	started: def((voterType: V.VoterType, choices: string[], duration: number) => ({
		broadcast: ({ locale }) =>
			t(
				'Vote{internal, select, yes { (internal)} other {}}:\n{lines}\nType the number of your choice in chat. You have {duration} to vote.',
				{
					internal: voterType === 'internal' ? 'yes' : 'no',
					lines: MsgFmt.numberedChoiceLines(choices, locale).join('\n'),
					duration: MsgFmt.formatInterval(duration, { round: 'second', locale }),
				},
			),
	})),

	tooFewChoices: def('A vote needs at least {min} choices', (min: number) => ({ min })),
	tooManyChoices: def('A vote can have at most {max} choices', (max: number) => ({ max })),
	choiceTooLong: def('"{choice}" is longer than {max} characters', (choice: string, max: number) => ({ choice, max })),
	duplicateChoice: def('"{choice}" is listed twice', (choice: string) => ({ choice })),
	simpleVoteInProgress: def('A simple vote is in progress'),
}

// -------- a vote's status, wherever a vote is shown --------

export const status = {
	inProgress: def('In progress'),
	ended: def('Ended'),
	insufficientVotes: def('Not enough votes'),
	aborted: def('Aborted'),
}

// -------- the vote box over the activity feed --------

export const box = {
	// the number players type to vote for the choice
	choiceLabel: def('{position}. {choice}', (position: number, choice: string) => ({ position, choice })),
	collapse: def('Collapse the vote'),
	expand: def('Expand the vote'),
}

// -------- /vote --------

export const fromChat = {
	added: def((labels: string[]) => ({
		warn: ({ locale }) => t('Vote added first in the queue:\n{lines}', { lines: MsgFmt.numberedChoiceLines(labels, locale).join('\n') }),
	})),
	unfilledChoices: def(
		'{count, plural, one {No layer in the pool matches {values}.} other {No layers in the pool match {values}.}} Nothing was queued.',
		(values: string[]) => ({ count: values.length, values: values.map((v) => `"${v}"`).join(', ') }),
	),
	textOnFilter: def('"{token}" is a filter, and only a choice can have a text after its colon.', (token: string) => ({ token })),
	mixedFields: def('Every choice must be the same kind: all maps, all layers, all gamemodes or all sizes.'),
	unsupportedField: def('"{token}" is {value}. A vote choice must be a map, layer, gamemode or size.', (token: string, value: string) => ({
		token,
		value,
	})),
	invalidFilter: def(
		'{count, plural, one {The filter {filterList} cannot be applied.} other {The filters {filterList} cannot be applied.}} Nothing was queued.',
		(filterNames: string[]) => ({ count: filterNames.length, filterList: filterNames.map((name) => `"${name}"`).join(', ') }),
	),
	queueBeingEdited: def('Someone is editing the queue in SLM. Try again once they have saved.'),
}

// what a simple vote's choices are refused with, on every surface that starts one
export function simpleChoicesError(error: V.SimpleVote.ChoicesError) {
	switch (error.code) {
		case 'err:too-few-choices':
			return simple.tooFewChoices(V.SimpleVote.MIN_CHOICES)
		case 'err:too-many-choices':
			return simple.tooManyChoices(V.SimpleVote.MAX_CHOICES)
		case 'err:choice-too-long':
			return simple.choiceTooLong(error.choice, V.SimpleVote.MAX_CHOICE_LENGTH)
		case 'err:duplicate-choice':
			return simple.duplicateChoice(error.choice)
		default:
			assertNever(error)
	}
}
