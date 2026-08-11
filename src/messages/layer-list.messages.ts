import * as DH from '@/lib/display-helpers'
import { assertNever, isNullOrUndef } from '@/lib/type-guards'
import * as MsgFmt from '@/messages/format'
import * as CMD from '@/models/command.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import type * as LQY from '@/models/layer-queries.models'
import { def, join, raw, t, type TString } from '@/models/messages.models'
import type * as USR from '@/models/users.models'

export const lowQueueItemCount = def(
	'WARNING: only {count, plural, one {# item} other {# items}} in the queue. Consider adding some more',
	(count: number) => ({ count }),
)

export type NextLayerViolations = { repeatViolations: LQY.RepeatMatchDescriptor[]; poolViolations: string[] }

// What the next layer breaks, appended to a message that has already named it.
function violationsLine(violations: NextLayerViolations) {
	const repeatedList =
		violations.repeatViolations.length > 0 ? [...new Set(violations.repeatViolations.map((r) => r.field))].join(', ') : undefined
	const poolList = violations.poolViolations.length > 0 ? violations.poolViolations.join(', ') : undefined
	if (!repeatedList && !poolList) return undefined
	return t(
		'{which, select, both {WARNING: repeat violations ({repeatedList}) and pool violations ({poolList})} repeat {WARNING: repeat violations ({repeatedList})} other {WARNING: pool violations ({poolList})}}. Check SLM for more details.',
		{
			repeatedList,
			poolList,
			which: repeatedList && poolList ? 'both' : repeatedList ? 'repeat' : 'pool',
		},
	)
}

export const votePending = def((matchStartTime: Date, threshold: number, autostart: boolean, commands: CMD.CommandConfigs) => ({
	// formatInterval renders for a locale, which ICU cannot carry, so the message resolves per reader
	warn: ({ locale }) => {
		const timeUntilVote = Math.max(0, threshold - (Date.now() - matchStartTime.getTime()))
		const showNextCmd = CMD.buildCommand('showNext', {}, commands, true)[0]
		return t(
			'A Vote is pending{autostart, select, yes { and will be run in {formattedTime}} other {}}. Run {showNextCmd} to preview the vote',
			{
				autostart: autostart ? 'yes' : 'no',
				formattedTime: MsgFmt.formatInterval(timeUntilVote, { round: 'second', locale }),
				showNextCmd,
			},
		)
	},
}))

export const empty = def('WARNING: Queue is empty. Please populate it')

export const abandonedEditsDiscarded = def((draft: 'queue' | 'request') => ({
	toast: [t('Unsaved {draft, select, queue {queue} other {layer request}} edits were discarded: nobody was left editing them', { draft })],
}))

export const opFailed = def(() => ({
	toast: [t('Failed to apply queue operation')],
}))

// Who put the layer at the head of the queue, named only to admins.
function setByDisplay(item: LL.Item | undefined, setByUser: USR.User | undefined) {
	if (!item) return t('Unknown')
	switch (item.source.type) {
		case 'generated':
			return t('Generated')
		case 'gameserver':
			return t('Game Server')
		case 'ingame-vote':
			return t('In-game vote')
		case 'manual':
			return setByUser && item.source.userId === setByUser.discordId
				? t('Set by {displayName}', { displayName: setByUser.displayName })
				: t('Set by {displayName}', { displayName: t('Unknown') })
		case undefined:
		case 'unknown':
			return t('Unknown')
		default:
			assertNever(item.source)
	}
}

export const showNext = def(
	(
		layerQueue: LL.List,
		nextLayer: L.UnvalidatedLayer | null,
		setByUser: USR.User | undefined,
		commands: Record<CMD.CommandId, CMD.CommandConfig>,
		opts?: { updated?: boolean; isAdmin?: boolean; violations?: NextLayerViolations },
	) => ({
		// the per-recipient form: warnAll re-invokes this for each player, which is what lets the layer be rendered
		// from that player's next-team perspective
		warn: (ctx) => {
			const item = layerQueue.length > 0 ? layerQueue[0] : undefined
			const playerNextTeamId = isNullOrUndef(ctx.player.teamId) ? undefined : ctx.player.teamId === 1 ? 2 : 1
			const updated = opts?.updated ? 'yes' : 'no'
			const lines: TString[] = []
			if (item && LL.isVoteItem(item) && nextLayer && L.areLayersCompatible(item.layerId, nextLayer)) {
				if (item.endingVoteState && item.endingVoteState.code === 'ended:winner') {
					let winningLayer: L.LayerId | undefined

					for (const { item: choice } of LL.iterItems(item.choices)) {
						if (item.endingVoteState.winnerId === choice.itemId) {
							winningLayer = item.layerId
							break
						}
					}
					lines.push(
						t('{updated, select, yes {Next Layer changed} other {Next Layer}} (Chosen via vote)\n{layer}', {
							updated,
							layer: winningLayer
								? DH.displayLayer(winningLayer, playerNextTeamId, ['layer', 'factions', 'units'], '\n')
								: t('unknown'),
						}),
					)
				} else {
					if (opts?.updated) {
						const showNextTrigger = CMD.primaryTrigger(commands.showNext)
						const showNextString = showNextTrigger ? CMD.triggerString(showNextTrigger) : 'shownext'
						// only an admin can run it, so only an admin is told how
						lines.push(
							opts.isAdmin
								? t('Next layer Changed. Will be chosen via vote (run with {showNextString}):', { showNextString })
								: t('Next layer Changed. Will be chosen via vote:'),
						)
					} else {
						lines.push(t('Upcoming vote:'))
					}
					lines.push(
						raw(
							MsgFmt.voteChoicesLines(
								item.choices.map((choice) => choice.layerId),
								playerNextTeamId,
								['layer', 'factions', 'units'],
							).join(),
						),
					)
				}
			} else {
				if (nextLayer === null) {
					lines.push(t('No next layer data available'))
				} else {
					lines.push(
						t('{updated, select, yes {Next Layer changed} other {Next Layer}}:\n{layer}\n', {
							updated,
							layer: DH.displayLayer(nextLayer, playerNextTeamId, ['layer', 'factions', 'units'], '\n'),
						}),
					)
				}
			}

			// only show who set the layer to admins
			if (opts?.isAdmin) {
				lines.push(setByDisplay(item, setByUser))
				const violations = opts.violations && violationsLine(opts.violations)
				if (violations) lines.push(violations)
			}

			return { msg: lines }
		},
	}),
)

export const requestFeedback = def((index: LL.ItemIndex, playerName: string, item: LL.Item) => ({
	warn: {
		msg: join([t('{playerName} has requested feedback for', { playerName }), raw(LL.displayLayerListItem(item, index))]),
	},
}))

// You are the last one editing, so leaving drops the draft rather than handing it on. The browser's own confirm()
// takes a bare string, hence `text`.
export const leavingDiscardsEdits = def(
	'Leaving discards your unsaved edits, since nobody else is editing. Are you sure you want to leave?',
)

export const ownEditsDiscarded = def(() => ({
	toast: [t('Your unsaved edits have been discarded')],
}))

// -------- where a queue item came from --------
// Shown on the source avatar beside a queue item. A manual source names the user instead, so it has no entry here.

export const sourceNames: Record<Exclude<LL.Source['type'], 'manual'>, string> = {
	gameserver: 'Game Server',
	unknown: 'Unknown',
	generated: 'Generated',
	'ingame-vote': 'In-Game Vote',
}

export const setByLabel = def('Set By')

// -------- the queue item controls --------

export const editItem = def('Edit')

export const swapFactions = def('Swap Factions')

export const deleteItem = def('Delete')

export const cloneItem = def('Clone')

export const addLayersBefore = def('Add Layers Before')

export const addLayersAfter = def('Add Layers After')

export const sendToFront = def('Send to Front')

export const sendToBack = def('Send to Back')

// the choice a vote falls back to, and the one it landed on
export const defaultChoice = def('Default')

export const selectedChoice = def('Selected')

// -------- whether the queue head is what the server will actually play next --------
// Shown on the head item, or for a vote on whichever choice would win right now.

export const isNextLayer = def('Next Layer')

export const isNextLayerBlurb = def('This is the posted next layer on the server.')

export const notNextLayer = def('Not Next Layer')

export const notCurrentNextLayer = def('Not current next layer on server')

export const notNextLayerUnsaved = def('Not Next Layer: Unsaved')

export const notNextLayerUnsavedBlurb = def(
	'The next layer set on the server is still {layer}. Save the changes to set this layer instead. If someone has forgotten to save their changes, use force save:',
	(layer: string) => ({ layer }),
)

// the SlmUpdatesDisabled alert above the queue already explains why, so this badge carries no tooltip
export const notNextLayerBlocked = def('Not Next Layer: Unable To Set')

export const pasteRotationTitle = def('Paste Rotation')

// -------- the queue panel --------

export const repeatsDetected = def('Repeats Detected')

export const repeatsBlurb = def(
	'Edits made in this session left the following queued layers repeating elements that violate our configured rules:',
)

export const filterWarnings = def('Filter Warnings')

export const filterWarningsBlurb = def('The following queued layers were edited in this session and trigger filter warnings:')

export const clearQueue = def('Clear Queue')

export const addLayers = def('Add Layers')

export const genVote = def('Gen Vote')

export const reset = def('Reset')

export const saving = def('Saving...')

export const startEditing = def('Start Editing')

export const toggleForceSave = def('Toggle force save')

export const toggleForceSaveHint = def('Toggle Force save (Save even if others are still editing)')

export const poolConfiguration = def('Pool Configuration')

export const upNext = def('Up Next')

// -------- what set the next layer --------
// The heading names the mechanism; the attributions below finish the sentence "Disabled by ..." / "set by ...".

export const inGameVoteRunning = def('In-Game Vote Running')

export const inGameVoteBlurb = def('The Squad server is running its own vote, which decides the next layer.')

export const currentlyVotingBetween = def('Currently voting between {choices}.', (choices: string) => ({ choices }))

export const slmUpdatesDisabled = def('SLM Updates Disabled')

export const slmUpdatesDisabledBy = def('SLM is not syncing the queue to the squad server. Disabled by')

export const currentNextLayerIs = def('Current next layer on the server is')

export const clickHere = def('Click Here')

export const disabledByInferredVote = def('in-game voting, most likely: the server stopped having a next layer set')

export const disabledByIngameVote = def('an in-game vote on the Squad server')

export const disabledByIngameAdmin = def('an admin in game')

export const disabledByUnrecorded = def('someone (not recorded)')

export const disabledByUnnamedUser = def('a user')

export const disabledBySlm = def('SLM')

// what the enable button does, which differs when the server is mid-vote
export const enableUpdatesCta = def(
	'to enable SLM Updates{alsoStopsIngameVote, select, yes { and turn off in-game voting on the server} other {}}.',
	(alsoStopsIngameVote: boolean) => ({ alsoStopsIngameVote: alsoStopsIngameVote ? 'yes' : 'no' }),
)
