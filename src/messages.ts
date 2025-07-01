import * as DH from '@/lib/display-helpers'
import * as BAL from '@/models/balance-triggers.models'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as MH from '@/models/match-history.models'
import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as dateFns from 'date-fns'
import { WarnOptions } from './lib/rcon/squad-rcon'
import { assertNever, isNullOrUndef } from './lib/type-guards'
import { CommandConfig } from './server/config'

function formatInterval(interval: number) {
	const duration = dateFns.intervalToDuration({ start: 0, end: interval })
	return dateFns.formatDuration(duration).replace(' seconds', 's').replace(' minutes', 'm')
}

export const BROADCASTS = {
	fogOff: 'Fog of War is disabled. All points are visible. Check your maps.',
	matchEnded(user: USR.User) {
		return `${user.username} ended the match via squad-layer-manager`
	},
	queue: {},
	vote: {
		started(choices: L.LayerId[], defaultLayer: L.LayerId, duration: number) {
			const fullText = `\nVote for the next layer:\n${voteChoicesLines(choices, defaultLayer).join('\n')}\nYou have ${
				formatInterval(duration)
			} to vote`
			return fullText
		},
		winnerSelected(tally: V.Tally, winner: L.LayerId) {
			const resultsText = Array.from(tally.totals.entries())
				.sort((a, b) => b[1] - a[1])
				.map(([choice, votes]) => {
					const isWinner = choice === winner
					const layerName = DH.toShortLayerNameFromId(choice)
					return `${votes} votes - (${tally.percentages.get(choice)?.toFixed(1)}%) ${isWinner ? '[WINNER] ' : ''}${layerName}`
				})
			const randomChoiceExplanation = tally.leaders.length > 1 ? `\n(Winner randomly selected - ${tally.leaders.length} way tie)` : ''
			const fullText = `\nVote has ended:\n${resultsText.join('\n')}\n${randomChoiceExplanation}`
			return fullText
		},
		insufficientVotes: (defaultChoice: L.LayerId) => {
			return `\nVote has ended!\nNot enough votes received to decide outcome.\nDefaulting to ${DH.toShortLayerNameFromId(defaultChoice)}`
		},
		aborted(defaultLayer: L.LayerId) {
			return `\nVote has been aborted. Defaulting to ${DH.toShortLayerNameFromId(defaultLayer)} for now`
		},
		voteReminder(timeLeft: number, choices: L.LayerId[], finalReminder = false) {
			const durationStr = formatInterval(timeLeft)
			const choicesText = choices.map((c, index) => `${index + 1}. ${DH.toShortLayerNameFromId(c)}`).join('\n')
			const prefix = finalReminder ? `FINAL REMINDER: ${durationStr} left` : `${durationStr} to cast your vote!`
			const fullText = `${prefix}\n${choicesText}`
			return fullText
		},
	},
} satisfies MessageNode

export const WARNS = {
	vote: {
		noVoteInProgress: `No vote in progress`,
		invalidChoice: `Invalid vote choice`,
		voteCast: (choice: L.LayerId) => `Vote cast for ${DH.toShortLayerNameFromId(choice)}`,
		start: {
			noVoteConfigured: `No vote is currently configured`,
			voteAlreadyInProgress: `A vote is already in progress`,
		},
	},
	balanceTrigger: {
		showEvent(event: BAL.BalanceTriggerEvent, currentMatch: MH.MatchDetails, opts?: { repeat?: number }) {
			return {
				repeat: opts?.repeat ?? 1,
				msg: GENERAL.balanceTrigger.showEvent(event, currentMatch),
			}
		},
	},
	queue: {
		lowQueueItemCount(count: number) {
			return `WARNING: only ${count} item${count === 1 ? '' : 's'} in the queue. Consider adding some more`
		},
		votePending: `Vote is pending`,
		empty: `WARNING: Queue is empty. Please populate it`,
		showNext: (layerQueue: LL.LayerList, parts: USR.UserPart, opts?: { repeat?: number }) => (ctx: C.Player) => {
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
						setByDisplay = `Set by ${parts?.users.find(user => user.discordId === userId)?.username ?? 'Unknown'}`
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

			const playerNextTeamId = isNullOrUndef(ctx.player.teamID) ? undefined : ctx.player.teamID === 1 ? 2 : 1

			if (item.vote) {
				if (item.layerId) {
					const msg = `Next Layer (Chosen via vote)\n${DH.displayUnvalidatedLayer(item.layerId, playerNextTeamId)}`
					return getOptions(msg)
				} else {
					const msg = [
						'Upcoming vote:',
						...voteChoicesLines(item.vote.choices, item.vote.defaultChoice, playerNextTeamId),
					]
					msg.push(extraDisplay)
					return getOptions(msg)
				}
			}

			// this shouldn't be possible
			if (!item.layerId) return `No next layer set`

			const msg = [`Next Layer\n${DH.displayUnvalidatedLayer(item.layerId, playerNextTeamId)}`]
			msg.push(extraDisplay)
			return getOptions(msg)
		},
	},
	commands: {
		unknownCommand(cmdText: string, closestMatch: string) {
			return `Unknown: ${cmdText}.\nDid you mean "${closestMatch}"?`
		},
		wrongChat: (correctChats: string[]) => `Command not available in this chat. Try using ${correctChats.join(' or ')}`,
		help(commands: (CommandConfig & { description: string })[], prefix: string) {
			const commandLines = commands.map((cmd) => {
				const sortedStrings = cmd.strings.sort((a, b) => a.length - b.length).map((s) => `${prefix}${s}`)
				return `[${sortedStrings.join(', ')}]: ${cmd.description}`
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
			const groupsJoined = groups.map((g) => g.join('\n')).join('\n')

			return { msg: groupsJoined, repeat: 3 }
		},
	},
	permissionDenied(res: RBAC.PermissionDeniedResponse) {
		return `Permission denied. You need ${res.check} of the following ${res.permits.map((p) => p.type).join(', ')}`
	},
} satisfies WarnNode

export const GENERAL = {
	auth: {
		noApplicationAccess: `You have not been granted access to this application. Please contact an administrator.`,
	},
	balanceTrigger: {
		showEvent(event: BAL.BalanceTriggerEvent, currentMatch: MH.MatchDetails) {
			if (!BAL.isKnownEventInstance(event)) {
				return (event.evaulationResult as BAL.EvaluationResultBase).genericMessage
			}

			const currentLayerPartial = L.toLayer(currentMatch.layerId)
			let strongerTeamFormatted: string
			let strongerTeamFaction: string | undefined
			if (
				!currentLayerPartial
				|| !(strongerTeamFaction = currentLayerPartial[MH.getTeamNormalizedFactionProp(currentMatch.ordinal, event.strongerTeam)])
			) {
				strongerTeamFormatted = DH.toFormattedNormalizedTeam(event.strongerTeam)
			} else {
				strongerTeamFormatted = `${DH.toFormattedNormalizedTeam(event.strongerTeam)}(current ${strongerTeamFaction})`
			}

			switch (event.triggerId) {
				case '150x2': {
					const ticketDiffs = event.input.map(match => {
						const outcome = MH.getTeamNormalizedOutcome(match)
						// should be impossible, we'll just return something benign
						if (outcome.type === 'draw') return 0

						return `${outcome.teamATickets}:${outcome.teamBTickets}`
					}).join(', ')
					return `${strongerTeamFormatted} has won the last two matches by more than 150+ tickets (${ticketDiffs})`
				}
				default:
					assertNever(event.triggerId)
			}
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

function voteChoicesLines(choices: L.LayerId[], defaultLayer: L.LayerId, you?: 1 | 2) {
	return choices.map((c, index) => {
		const isDefault = c === defaultLayer
		return `${index + 1}. ${DH.toShortLayerNameFromId(c, you)} ${isDefault ? '\n(Default)' : ''}`
	})
}
