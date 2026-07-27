import * as DH from '@/lib/display-helpers'
import { assertNever, isNullOrUndef } from '@/lib/type-guards'
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
		const formattedTime = Msgs.formatInterval(timeUntilVote, { terse: false, round: 'second' })
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
						Msgs.voteChoicesLines(
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
