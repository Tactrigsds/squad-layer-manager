import * as DH from '@/lib/display-helpers'
import { assertNever, isNullOrUndef } from '@/lib/type-guards'
import * as MsgFmt from '@/messages/format'
import * as Msgs from '@/messages/shared'
import * as CMD from '@/models/command.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import type * as LQY from '@/models/layer-queries.models'
import type * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'

export const lowQueueItemCount = Msgs.def((count: number) => ({
	warn: () => `WARNING: only ${count} item${count === 1 ? '' : 's'} in the queue. Consider adding some more`,
}))

export const nextLayerWarning = Msgs.def(
	(layerId: L.LayerId, _opts: { repeatViolations: LQY.RepeatMatchDescriptor[]; poolViolations: string[] }) => ({
		warn: () => {
			const opts = {
				repeatViolations: _opts.repeatViolations.length > 0 ? _opts.repeatViolations : undefined,
				poolViolations: _opts.poolViolations.length > 0 ? _opts.poolViolations : undefined,
			}
			const repeatedList = opts.repeatViolations ? [...new Set(opts.repeatViolations?.map((r) => r.field))].join(', ') : undefined
			const poolList = opts.poolViolations?.join(', ')
			let str = ''
			if (repeatedList && poolList) {
				str = `Repeat violations(${repeatedList}) and pool violations (${poolList})`
			} else if (repeatedList) {
				str = `Repeat violations(${repeatedList})`
			} else if (poolList) {
				str = `Pool violations (${poolList})`
			}

			return `WARNING: The next layer (${DH.displayLayer(layerId)}) has ${str}. Check SLM for more details.`
		},
	}),
)

export const votePending = Msgs.def((matchStartTime: Date, threshold: number, autostart: boolean, commands: CMD.CommandConfigs) => ({
	warn: () => {
		const timeUntilVote = Math.max(0, threshold - (Date.now() - matchStartTime.getTime()))
		const formattedTime = MsgFmt.formatInterval(timeUntilVote, { round: 'second' })
		const showNextCmd = CMD.buildCommand('showNext', {}, commands, true)[0]
		return `A Vote is pending${autostart ? ' and will be run in ' + formattedTime : ''}. Run ${showNextCmd} to preview the vote`
	},
}))

export const empty = Msgs.def(() => ({ warn: () => `WARNING: Queue is empty. Please populate it` }))

export const abandonedEditsDiscarded = Msgs.def((draft: 'queue' | 'request') => ({
	toast: () => [`Unsaved ${draft === 'queue' ? 'queue' : 'layer request'} edits were discarded: nobody was left editing them`],
}))

export const opFailed = Msgs.def(() => ({
	toast: () => ['Failed to apply queue operation'],
}))

export const showNext = Msgs.def(
	(
		layerQueue: LL.List,
		nextLayer: L.UnvalidatedLayer | null,
		setByUser: USR.User | undefined,
		commands: Record<CMD.CommandId, CMD.CommandConfig>,
		opts?: { updated?: boolean; isAdmin?: boolean },
	) => ({
		// the per-recipient form: warnAll re-invokes this for each player, which is what lets the layer be rendered
		// from that player's next-team perspective
		warn: () => (ctx: SM.Ctx) => {
			const item = layerQueue.length > 0 ? layerQueue[0] : undefined
			const playerNextTeamId = isNullOrUndef(ctx.player.teamId) ? undefined : ctx.player.teamId === 1 ? 2 : 1
			let lines: string[] = []
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
						`Next Layer${opts?.updated ? ' changed' : ''} (Chosen via vote)\n${
							winningLayer ? DH.displayLayer(winningLayer, playerNextTeamId, ['layer', 'factions', 'units'], '\n') : 'unknown'
						}`,
					)
				} else {
					if (opts?.updated) {
						const showNextTrigger = CMD.primaryTrigger(commands.showNext)
						const showNextString = showNextTrigger ? CMD.triggerString(showNextTrigger) : 'shownext'
						const runWithPart = opts.isAdmin ? ` (run with ${showNextString})` : ''
						lines.push(`Next layer Changed. Will be chosen via vote${runWithPart}:`)
					} else {
						lines.push('Upcoming vote:')
					}
					lines.push(
						MsgFmt.voteChoicesLines(
							item.choices.map((choice) => choice.layerId),
							playerNextTeamId,
							['layer', 'factions', 'units'],
						).join(),
					)
				}
			} else {
				if (nextLayer === null) {
					lines.push(`No next layer data available`)
				} else {
					lines.push(
						`Next Layer${opts?.updated ? ' changed' : ''}:\n${DH.displayLayer(
							nextLayer,
							playerNextTeamId,
							['layer', 'factions', 'units'],
							'\n',
						)}\n`,
					)
				}
			}

			// only show who set the layer to admins
			if (opts?.isAdmin) {
				let setByDisplay: string
				if (!item) {
					setByDisplay = `Unknown`
				} else {
					switch (item.source.type) {
						case 'generated':
							setByDisplay = `Generated`
							break
						case 'gameserver':
							setByDisplay = `Game Server`
							break
						case 'ingame-vote':
							setByDisplay = `In-game vote`
							break
						case 'manual':
							{
								const userId = item.source.userId
								setByDisplay = `Set by ${setByUser && userId === setByUser.discordId ? setByUser.displayName : 'Unknown'}`
							}
							break
						case undefined:
						case 'unknown':
							setByDisplay = `Unknown`
							break
						default:
							assertNever(item.source)
					}
				}

				lines.push(setByDisplay)
			}

			return { msg: lines }
		},
	}),
)

export const requestFeedback = Msgs.def((index: LL.ItemIndex, playerName: string, item: LL.Item) => ({
	warn: () => ({ msg: [`${playerName} has requested feedback for`, LL.displayLayerListItem(item, index)].join('\n') }),
}))

// You are the last one editing, so leaving drops the draft rather than handing it on. The browser's own confirm()
// takes a bare string, hence `text`.
export const leavingDiscardsEdits = Msgs.def(
	'Leaving discards your unsaved edits, since nobody else is editing. Are you sure you want to leave?',
)

export const ownEditsDiscarded = Msgs.def(() => ({
	toast: () => ['Your unsaved edits have been discarded'],
}))

// -------- where a queue item came from --------
// Shown on the source avatar beside a queue item. A manual source names the user instead, so it has no entry here.

export const sourceNames: Record<Exclude<LL.Source['type'], 'manual'>, string> = {
	gameserver: 'Game Server',
	unknown: 'Unknown',
	generated: 'Generated',
	'ingame-vote': 'In-Game Vote',
}

export const setByLabel = Msgs.def('Set By')

// -------- the queue item controls --------

export const editItem = Msgs.def('Edit')

export const swapFactions = Msgs.def('Swap Factions')

export const deleteItem = Msgs.def('Delete')

export const cloneItem = Msgs.def('Clone')

export const addLayersBefore = Msgs.def('Add Layers Before')

export const addLayersAfter = Msgs.def('Add Layers After')

export const sendToFront = Msgs.def('Send to Front')

export const sendToBack = Msgs.def('Send to Back')

// the choice a vote falls back to, and the one it landed on
export const defaultChoice = Msgs.def('Default')

export const selectedChoice = Msgs.def('Selected')

export const notCurrentNextLayer = Msgs.def('Not current next layer on server')

export const pasteRotationTitle = Msgs.def('Paste Rotation')

// -------- the queue panel --------

export const repeatsDetected = Msgs.def('Repeats Detected')

export const repeatsBlurb = Msgs.def('The following queued layers have repeated elements that violate our configured rules:')

export const filterWarnings = Msgs.def('Filter Warnings')

export const filterWarningsBlurb = Msgs.def('The following queued layers triggered filter warnings:')

export const clearQueue = Msgs.def('Clear Queue')

export const addLayers = Msgs.def('Add Layers')

export const genVote = Msgs.def('Gen Vote')

export const reset = Msgs.def('Reset')

export const saving = Msgs.def('Saving...')

export const startEditing = Msgs.def('Start Editing')

export const toggleForceSave = Msgs.def('Toggle force save')

export const toggleForceSaveHint = Msgs.def('Toggle Force save (Save even if others are still editing)')

export const poolConfiguration = Msgs.def('Pool Configuration')

export const upNext = Msgs.def('Up Next')

// -------- what set the next layer --------
// The heading names the mechanism; the attributions below finish the sentence "Disabled by ..." / "set by ...".

export const inGameVoteRunning = Msgs.def('In-Game Vote Running')

export const inGameVoteBlurb = Msgs.def('The Squad server is running its own vote, which decides the next layer.')

export const currentlyVotingBetween = Msgs.def('Currently voting between {choices}.', (choices: string) => ({ choices }))

export const slmUpdatesDisabled = Msgs.def('SLM Updates Disabled')

export const slmUpdatesDisabledBy = Msgs.def('SLM is not syncing the queue to the squad server. Disabled by')

export const currentNextLayerIs = Msgs.def('Current next layer on the server is')

export const clickHere = Msgs.def('Click Here')

export const disabledByInferredVote = Msgs.def('in-game voting, most likely: the server stopped having a next layer set')

export const disabledByIngameVote = Msgs.def('an in-game vote on the Squad server')

export const disabledByIngameAdmin = Msgs.def('an admin in game')

export const disabledByUnrecorded = Msgs.def('someone (not recorded)')

export const disabledByUnnamedUser = Msgs.def('a user')

export const disabledBySlm = Msgs.def('SLM')

// what the enable button does, which differs when the server is mid-vote
export const enableUpdatesCta = Msgs.def((alsoStopsIngameVote: boolean) =>
	alsoStopsIngameVote ? 'to enable SLM Updates and turn off in-game voting on the server.' : 'to enable SLM Updates.',
)
