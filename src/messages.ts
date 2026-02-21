import * as DH from '@/lib/display-helpers'
import * as Obj from '@/lib/object'
import * as BAL from '@/models/balance-triggers.models'
import * as CMD from '@/models/command.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
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
		winnerSelected(tally: V.Tally, voteItem: LL.VoteItem, winnerId: LL.ItemId, displayProps: DH.LayerDisplayProp[]) {
			const resultsText = Array.from(tally.totals.entries())
				.sort((a, b) => b[1] - a[1])
				.map(([choiceId, votes]) => {
					const isWinner = choiceId === winnerId
					const choice = voteItem.choices.find(c => c.itemId === choiceId)
					const layerName = choice ? DH.toShortLayerNameFromId(choice.layerId, undefined, displayProps) : 'Unknown'
					return `${votes} votes - (${tally.percentages.get(choiceId)?.toFixed(0)}%) ${isWinner ? '[WINNER] ' : ''}${layerName}`
				})
			const randomChoiceExplanation = tally.leaders.length > 1 ? `\n(Winner randomly selected - ${tally.leaders.length} way tie.)` : ''
			const fullText = `\nVote has ended:\n${resultsText.join('\n')}\n${randomChoiceExplanation}`
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
		showEvent(event: BAL.BalanceTriggerEvent, match: MH.MatchDetails, opts?: { repeat?: number; isCurrent?: boolean }) {
			return {
				repeat: opts?.repeat ?? 1,
				msg: GENERAL.balanceTrigger.showEvent(event, match, !!opts?.isCurrent),
			}
		},
	},
	queue: {
		lowQueueItemCount(count: number) {
			return `WARNING: only ${count} item${count === 1 ? '' : 's'} in the queue. Consider adding some more`
		},
		votePending(matchStartTime: Date, threshold: number, autostart: boolean, commands: CMD.CommandConfigs, commandPrefix: string) {
			const timeUntilVote = Math.max(0, threshold - (Date.now() - matchStartTime.getTime()))
			const formattedTime = formatInterval(timeUntilVote, { terse: false, round: 'second' })
			const showNextCmd = CMD.buildCommand('showNext', {}, commands, commandPrefix, true)[0]
			return `A Vote is pending${autostart ? ' and will be run in ' + formattedTime : ''}. Run ${showNextCmd} to preview the vote`
		},
		empty: `WARNING: Queue is empty. Please populate it`,
		showNext: (layerQueue: LL.List, parts: USR.UserPart, opts?: { repeat?: number }) => (ctx: C.Player) => {
			const item = layerQueue[0]
			let setByDisplay: string
			switch (item?.source.type) {
				case undefined:
				case 'unknown':
					setByDisplay = `Unknown`
					break
				case 'generated':
					setByDisplay = `Generated`
					break
				case 'gameserver':
					setByDisplay = `Game Server`
					break
				case 'manual':
					{
						const userId = item.source.userId
						setByDisplay = `Set by ${parts?.users.find(user => user.discordId === userId)?.displayName ?? 'Unknown'}`
					}
					break
				default:
					assertNever(item.source)
			}

			const extraDisplay = setByDisplay
			const getOptions = (msg: string | string[]) => ({
				msg,
				repeat: opts?.repeat ?? 1,
			})

			const playerNextTeamId = isNullOrUndef(ctx.player.teamId) ? undefined : ctx.player.teamId === 1 ? 2 : 1

			if (LL.isVoteItem(item)) {
				if (item.endingVoteState && item.endingVoteState.code === 'ended:winner') {
					let winningLayer: L.LayerId | undefined

					for (const { item: choice } of LL.iterItems(item.choices)) {
						if (item.endingVoteState.winnerId === choice.itemId) {
							winningLayer = item.layerId
							break
						}
					}
					const msg = `Next Layer (Chosen via vote)\n${
						winningLayer ? DH.displayLayer(winningLayer, playerNextTeamId, ['layer', 'factions', 'units']) : 'unknown'
					}`
					return getOptions(msg)
				} else {
					const msg = [
						'Upcoming vote:',
						voteChoicesLines(item.choices.map(choice => choice.layerId), playerNextTeamId, ['layer', 'factions', 'units']).join('\n'),
					]
					msg.push(extraDisplay)
					return getOptions(msg)
				}
			}

			// this shouldn't be possible
			if (!item.layerId) return `No next layer set`

			const msg = [`Next Layer\n${DH.displayLayer(item.layerId, playerNextTeamId, ['layer', 'factions', 'units'])}`]
			msg.push(extraDisplay)
			return getOptions(msg)
		},
		requestFeedback: (index: LL.ItemIndex, playerName: string, item: LL.Item) => ({
			msg: [
				`${playerName} has requested feedback for`,
				LL.displayLayerListItem(item, index),
			].join('\n'),
			repeat: 3,
		}),
	},
	commands: {
		unknownCommand(cmdText: string, closestMatch: string) {
			return `Unknown: ${cmdText}.\nDid you mean "${closestMatch}"?`
		},
		wrongChat: (correctChats: string[]) => `Command not available in this chat. Try using ${correctChats.join(' or ')}`,
		help(commands: Record<CMD.CommandId, CMD.CommandConfig>, prefix: string) {
			const commandLines = Obj.objEntries(commands).map(([id, cmd]) => {
				const sortedStrings = cmd.strings.sort((a, b) => a.length - b.length).map((s) => `${prefix}${s}`)
				return `[${sortedStrings.join(', ')}]: ${GENERAL.command.descriptions[id]}`
			})
			const groups: string[][] = []
			let currentGroup: string[] = []
			groups.push(currentGroup)
			for (const config of commandLines) {
				if (currentGroup.length >= 3) {
					currentGroup = []
					groups.push(currentGroup)
				}
				currentGroup.push(config)
			}
			groups[0].unshift(`Available commands:`)
			const groupsJoined = groups.map((g) => g.join('\n'))

			return { msg: groupsJoined, repeat: 3 }
		},
		missingSteamId: () => `You are not signed in as a Steam user.`,
		steamAccountLinked: (username: string) => `Your Steam account has been linked to discord user ${username}.`,
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
			startVote: 'Start a new vote',
			abortVote: 'Abort the current vote',
			showNext: 'Show the next item in the queue',
			enableSlmUpdates: 'Allow SLM to set the next layer',
			disableSlmUpdates: 'Prevent SLM from setting the next layer',
			getSlmUpdatesEnabled: 'Check if SLM is allowed to set the next layer',
			linkSteamAccount: 'Link your Steam account to your Discord account',
			requestFeedback: 'Request feedback on a layer',
		},
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
