import * as Arr from '@/lib/array'
import * as DH from '@/lib/display-helpers'
import * as Obj from '@/lib/object'
import * as BAL from '@/models/balance-triggers.models'
import * as CMDH from '@/models/command-help.models'
import * as CMD from '@/models/command.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import type * as LQY from '@/models/layer-queries.models'
import * as MH from '@/models/match-history.models'
import type * as USR from '@/models/users.models'
import type * as V from '@/models/vote.models'
import type * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import type { WarnOptions } from '@/systems/squad-rcon.server'
import * as dateFns from 'date-fns'
import { assertNever, isNullOrUndef } from './lib/type-guards'

function formatInterval(interval: number, options?: { terse?: boolean; round?: 'second' }) {
	const { terse = true, round } = options ?? {}
	const normalizedInterval = round === 'second' ? Math.round(interval / 1000) * 1000 : interval
	const duration = dateFns.intervalToDuration({ start: 0, end: normalizedInterval })
	let txt = dateFns.formatDuration(duration)
	if (terse) txt = txt.replace(' seconds', 's').replace(' minutes', 'm')
	return txt
}

// TODO this structure is dumb, we need some way to colocate and reeuse messages between targets

export const BROADCASTS = {
	fogOff: 'Fog of War is disabled. All points are visible. Check your maps.',
	queue: {},
	vote: {
		started(
			state: Pick<V.VoteState, 'choiceIds' | 'voterType'>,
			voteItem: LL.VoteItem | L.LayerId[],
			duration: number,
			displayProps: DH.LayerDisplayProp[],
		) {
			const layerIds = Array.isArray(voteItem)
				? voteItem
				: state.choiceIds.flatMap(id => {
					const choice = voteItem.choices.find(choice => choice.itemId === id)
					if (choice) return [choice.layerId]
					return []
				})
			const lines = voteChoicesLines(layerIds, undefined, displayProps).join('\n')
			const formattedInterval = formatInterval(duration, { terse: false, round: 'second' })
			const voterTypeDisp = state.voterType === 'internal' ? ' (internal)' : ''
			const fullText = `Vote for the next layer${voterTypeDisp}:\n${lines}\nYou have ${formattedInterval} to vote.\n`
			return fullText
		},
		winnerSelected(
			tally: V.Tally,
			voteItem: LL.VoteItem,
			winnerId: LL.ItemId,
			displayProps: DH.LayerDisplayProp[],
			early: boolean = false,
		) {
			const resultsText = Array.from(tally.totals.entries())
				.sort((a, b) => b[1] - a[1])
				.map(([choiceId, votes]) => {
					const isWinner = choiceId === winnerId
					const choice = voteItem.choices.find(c => c.itemId === choiceId)
					const layerName = choice ? DH.toShortLayerNameFromId(choice.layerId, undefined, displayProps) : 'Unknown'
					return `${votes} votes - (${tally.percentages.get(choiceId)?.toFixed(0)}%) ${isWinner ? '[WINNER] ' : ''}${layerName}`
				})
			const randomChoiceExplanation = tally.leaders.length > 1 ? `\n(Winner randomly selected - ${tally.leaders.length} way tie.)` : ''
			const fullText = `\nVote ${early ? 'was' : 'has'} ended${early ? ' early' : ''}:\n${
				resultsText.join('\n')
			}\n${randomChoiceExplanation}`
			return fullText
		},
		insufficientVotes(voteItem: LL.VoteItem, displayProps: DH.LayerDisplayProp[]) {
			const defaultChoice = voteItem.choices[0]
			return `\nVote has ended!\nNot enough votes received to decide outcome.\nDefaulting to ${
				DH.toShortLayerNameFromId(defaultChoice.layerId, undefined, displayProps)
			}`
		},
		aborted: `\nThe vote has been aborted.`,
		inProgressVoteCleared() {
			return `in-progress vote has been cleared.`
		},
		voteReminder(
			state: Extract<V.VoteState, { code: 'in-progress' }>,
			voteItem: LL.VoteItem,
			timeLeft: number,
			finalReminder = false,
			displayProps: DH.LayerDisplayProp[],
		) {
			const durationStr = formatInterval(timeLeft, { terse: false, round: 'second' })
			const prefix = finalReminder ? `VOTE NOW: ${durationStr} left to cast your vote!` : `${durationStr} to cast your vote!`

			const lines = voteChoicesLines(
				state.choiceIds.flatMap(id => {
					const choice = voteItem.choices.find(choice => choice.itemId === id)
					if (choice) return [choice.layerId]
					return []
				}),
				undefined,
				displayProps,
			).join('\n')
			const fullText = `${prefix}\n${lines}`
			return fullText
		},
	},
} satisfies MessageNode

export const WARNS = {
	vote: {
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
	},
	balanceTrigger: {
		showEvent(event: BAL.BalanceTriggerEvent, match: MH.MatchDetails, opts?: { isCurrent?: boolean }) {
			return {
				msg: GENERAL.balanceTrigger.showEvent(event, match, !!opts?.isCurrent),
			}
		},
	},
	queue: {
		lowQueueItemCount(count: number) {
			return `WARNING: only ${count} item${count === 1 ? '' : 's'} in the queue. Consider adding some more`
		},

		nextLayerWarning(layerId: L.LayerId, _opts: { repeatViolations: LQY.RepeatMatchDescriptor[]; poolViolations: string[] }) {
			const opts = {
				repeatViolations: _opts.repeatViolations.length > 0 ? _opts.repeatViolations : undefined,
				poolViolations: _opts.poolViolations.length > 0 ? _opts.poolViolations : undefined,
			}
			const repeatedList = opts.repeatViolations ? [...new Set(opts.repeatViolations?.map(r => r.field))].join(', ') : undefined
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

		votePending(matchStartTime: Date, threshold: number, autostart: boolean, commands: CMD.CommandConfigs) {
			const timeUntilVote = Math.max(0, threshold - (Date.now() - matchStartTime.getTime()))
			const formattedTime = formatInterval(timeUntilVote, { terse: false, round: 'second' })
			const showNextCmd = CMD.buildCommand('showNext', {}, commands, true)[0]
			return `A Vote is pending${autostart ? ' and will be run in ' + formattedTime : ''}. Run ${showNextCmd} to preview the vote`
		},

		empty: `WARNING: Queue is empty. Please populate it`,
		showNext: (
			layerQueue: LL.List,
			nextLayer: L.UnvalidatedLayer | null,
			setByUser: USR.User | undefined,
			commands: Record<CMD.CommandId, CMD.CommandConfig>,
			opts?: { updated?: boolean; isAdmin?: boolean },
		) =>
		(ctx: C.Player) => {
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
						const showNextString = commands.showNext.strings[0]
						const runWithPart = opts.isAdmin ? ` (run with ${showNextString})` : ''
						lines.push(`Next layer Changed. Will be chosen via vote${runWithPart}:`)
					} else {
						lines.push('Upcoming vote:')
					}
					lines.push(
						voteChoicesLines(item.choices.map(choice => choice.layerId), playerNextTeamId, ['layer', 'factions', 'units']).join(),
					)
				}
			} else {
				if (nextLayer === null) {
					lines.push(`No next layer data available`)
				} else {
					lines.push(
						`Next Layer${opts?.updated ? ' changed' : ''}:\n${
							DH.displayLayer(nextLayer, playerNextTeamId, ['layer', 'factions', 'units'], '\n')
						}\n`,
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
		requestFeedback: (index: LL.ItemIndex, playerName: string, item: LL.Item) => ({
			msg: [
				`${playerName} has requested feedback for`,
				LL.displayLayerListItem(item, index),
			].join('\n'),
		}),
	},
	commands: {
		unknownCommand(cmdText: string, closestMatch: string) {
			return `Unknown: ${cmdText}.\nDid you mean "${closestMatch}"?`
		},
		wrongChat: (correctChats: string[]) => `Command not available in this chat. Try using ${correctChats.join(' or ')}`,
		// `section` is the raw token typed after the help command; omitted means the quick reference. Returns one
		// string per warn, since chat can only take a few lines at a time.
		help(
			commands: CMD.CommandConfigs,
			aliases: readonly CMD.CommandAlias[] = [],
			section?: string,
		) {
			const listing = CMDH.resolveHelpListing(commands, aliases, section)
			if (listing.code === 'err:unknown-section') return [listing.msg]

			const commandLines = listing.commands.map((id) => {
				const cmd = commands[id]
				const sortedStrings = cmd.strings.toSorted((a, b) => a.length - b.length)
				const signature = CMD.formatArgSignature(CMD.COMMAND_DECLARATIONS[id].args)
				return `[${sortedStrings.join(', ')}]${signature ? ` ${signature}` : ''}: ${GENERAL.command.descriptions[id]}`
			})
			// aliases take no args of their own, so they list as the shortcut and what it expands to
			const aliasLines = listing.aliases.map((a) => `[${a.alias}]: ${GENERAL.command.aliasDescription(a.command)}`)
			const lines = [...commandLines, ...aliasLines]
			if (lines.length === 0) return [`${listing.title}: none.`]
			const groups = Arr.paged(lines, 3)
			groups[0].unshift(`${listing.title}:`)
			return groups.map((g) => g.join('\n'))
		},
		missingSteamId: () => `You are not signed in as a Steam user.`,
		steamAccountNotLinked: () =>
			`This command requires a linked SLM account. Link your Steam ID on the SLM website (account menu > Linked Steam Accounts).`,
	},
	teamswaps: {
		notifyPlayerOfUpcomingTeamswap: 'You have been marked for a team swap on mapchange. '
			+ 'Thank you for helping with team balance and contact admins if you have issues.',
		notifyTeamswapCancelled: 'You will no longer be swapped to the other team on map roll.',
		notifyManualSwap: 'You have been swapped to the other team by an admin.',
		// added/removed are the real per-player diff against the previously saved swaps, not the net change in
		// size: a save that adds 3 and removes 1 is not "added 2"
		notifyAdminSwapsSaved: (name: string, count: number, added: number, removed: number, factionLines?: string[]) => {
			if (count === 0) return `${name} cleared all queued teamswaps for next map.`
			const parts: string[] = []
			if (added > 0) parts.push(`added ${added}`)
			if (removed > 0) parts.push(`removed ${removed}`)
			const changeSummary = parts.length > 0 ? ` (${parts.join(', ')})` : ''
			const base = `${name} queued ${count} teamswap${count !== 1 ? 's' : ''} for next map${changeSummary}`
			return factionLines?.length ? `${base}:\n${factionLines.join('\n')}` : `${base}.`
		},
		notifyAdminManualSwap: (name: string, count: number, factionLines?: string[]) =>
			factionLines?.length
				? `${name} swapped ${count} player${count !== 1 ? 's' : ''}:\n${factionLines.join('\n')}`
				: `${name} swapped ${count} player${count !== 1 ? 's' : ''} to the other team.`,
	},
	kill: {
		// a supplied reason is already the fully-rendered verbatim message; only the no-reason case gets a default
		notifyKilled: (reason?: string) => reason || 'You have been killed by an admin.',
	},
	permissionDenied(res: RBAC.PermissionDeniedResponse) {
		return `Permission denied. You need ${res.check} of the following ${res.permits.map((p) => p.type).join(', ')}`
	},
	slmUpdatesSet(enabled: boolean) {
		return `Updates from SLM have been ${enabled ? 'enabled' : 'disabled'}.`
	},
	slmUpdatesStatus(enabled: boolean) {
		return `Updates from SLM are ${enabled ? 'enabled' : 'disabled'}.`
	},
	slmStarted: (restartedBy?: string) => restartedBy ? `SLM has been restarted by ${restartedBy}.` : `SLM has been started.`,
} satisfies WarnNode

export const GENERAL = {
	auth: {
		noApplicationAccess: `You have not been granted access to this application. Please contact an administrator.`,
		unAuthenticated: `Not able to authenticate user`,
	},
	balanceTrigger: {
		showEvent(event: BAL.BalanceTriggerEvent, referenceMatch: MH.MatchDetails, qualifyAsCurrent: boolean) {
			if (!BAL.isKnownEventInstance(event)) {
				const result = event.evaluationResult as BAL.EvaluationResultBase<any>
				return result.messageTemplate.replace('{{strongerTeam}}', result.strongerTeam)
			}

			const currentLayerPartial = L.toLayer(referenceMatch.layerId)
			let strongerTeamFormatted: string
			const strongerTeamFaction = currentLayerPartial?.[MH.getTeamNormalizedFactionProp(referenceMatch.ordinal, event.strongerTeam)]
			if (!strongerTeamFaction) {
				strongerTeamFormatted = DH.toFormattedNormalizedTeam(event.strongerTeam)
			} else {
				strongerTeamFormatted = `${DH.toFormattedNormalizedTeam(event.strongerTeam)}(${
					qualifyAsCurrent ? 'current ' : ''
				}${strongerTeamFaction})`
			}

			return event.evaluationResult!.messageTemplate.replace('{{strongerTeam}}', strongerTeamFormatted)
		},
		descriptions: {
			'150x2': '2 consecutive games of a Team winning by 150+ tickets',
			'200x2': '2 consecutive games of a Team winning by 200+ tickets',
			'RWS5': '5 consecutive games of a team winning by any number of tickets',
			'RAM3+': 'a rolling average of 125+ tickets across any streak of 3 or more games(utilizing the max of all options).',
		} satisfies Record<BAL.TriggerId, string>,
	},
	command: {
		descriptions: {
			help: 'Display help information',
			startVote: 'Start the configured vote',
			abortVote: 'Abort the current vote',
			endVoteEarly: 'End the current vote early',
			showNext: 'Show the next item in the queue',
			enableSlmUpdates: 'Allow SLM to set the next layer',
			disableSlmUpdates: 'Prevent SLM from setting the next layer',
			getSlmUpdatesEnabled: 'Check if SLM is allowed to set the next layer',
			requestFeedback: 'Request feedback on a layer',
			flag: "Flag a player's BM profile, optionally with a reason (some flags require one)",
			removeFlag: "Remove a flag from a player's BM profile",
			listFlags: 'List BM flags for a player, or all org flags if no player is given',
			swapNow: 'Swap a player to the opposite team immediately',
			swapNext: 'Queue a player to swap teams on the next map',
			swapSquadNow: 'Swap an entire squad to the opposite team immediately',
			swapSquadNext: 'Queue an entire squad to swap teams on the next map',
			swaps: 'Show a summary of queued team swaps',
			clearSwaps: 'Clear all queued teamswaps',
			warn: 'Warn a player',
			listWarnReasons: 'List the configured admin action reasons and their aliases',
			warnSquad: 'Warn every member of a squad',
			kill: 'Kill a player',
			killSquad: 'Kill every member of a squad',
			removeFromSquad: 'Remove a player from their squad',
			disbandSquad: 'Disband a squad',
			demoteCommander: 'Demote a player from commander',
			broadcast: 'Send an admin broadcast: one word picks a preset, more words broadcast the message verbatim',
			kick: 'Kick a player from the server; they may rejoin immediately',
			kickSquad: 'Kick every member of a squad from the server',
			timeout: 'Kick a player with a timeout (e.g. 2h); they are re-kicked on any SLM server until it expires',
			timeoutSquad: 'Kick every member of a squad with a timeout (e.g. 2h)',
			clearTimeout: "Cancel a player's active timeout (works for offline players)",
		} satisfies Record<CMD.CommandId, string>,
		// configurable fixed-duration timeout aliases; shared by the in-game help and the web help dialog
		aliasDescription: (command: string) => `Shortcut for "${command}"`,
	},
}

type WarnNode = {
	[key: string]: WarnNode | WarnOptions | ((...args: any[]) => WarnOptions)
}

type MessageOutput = string
type MessageNode = {
	[key: string]: MessageNode | MessageOutput | ((...args: any[]) => MessageOutput)
}

function voteChoicesLines(choices: L.LayerId[], you?: 1 | 2, displayProps?: DH.LayerDisplayProp[]) {
	const lines = choices.map((c, index) => {
		return `${index + 1}. ${DH.toShortLayerNameFromId(c, you, displayProps)}`
	})

	if (lines.join(' ').length < 50) {
		return [lines.join(' ')]
	}
	return lines
}
