import * as DH from '@/lib/display-helpers'
import * as M from '@/models'
import * as RBAC from '@/rbac.models'
import * as dateFns from 'date-fns'
import { WarnOptions } from './lib/rcon/squad-rcon'
import { assertNever } from './lib/typeGuards'
import { CommandConfig } from './server/config'

function formatInterval(interval: number) {
	const duration = dateFns.intervalToDuration({ start: 0, end: interval })
	return dateFns.formatDuration(duration).replace(' seconds', 's').replace(' minutes', 'm')
}

export const BROADCASTS = {
	fogOff: 'Fog of War is disabled. All points are visible. Check your maps.',
	queue: {},
	vote: {
		started(choices: M.LayerId[], defaultLayer: M.LayerId, duration: number) {
			const fullText = `\nVote for the next layer:\n${voteChoicesLines(choices, defaultLayer).join('\n')}\nYou have ${
				formatInterval(duration)
			} to vote`
			return fullText
		},
		winnerSelected(tally: M.Tally, winner: M.LayerId) {
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
		insufficientVotes: (defaultChoice: M.LayerId) => {
			return `\nVote has ended!\nNot enough votes received to decide outcome.\nDefaulting to ${DH.toShortLayerNameFromId(defaultChoice)}`
		},
		aborted(defaultLayer: M.LayerId) {
			return `\nVote has been aborted. Defaulting to ${DH.toShortLayerNameFromId(defaultLayer)} for now`
		},
		voteReminder(timeLeft: number, choices: M.LayerId[], finalReminder = false) {
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
		voteCast: (choice: M.LayerId) => `Vote cast for ${DH.toShortLayerNameFromId(choice)}`,
		start: {
			noVoteConfigured: `No vote is currently configured`,
			voteAlreadyInProgress: `A vote is already in progress`,
		},
	},
	queue: {
		lowLayerCount(count: number) {
			return `WARNING: only ${count} items in the queue. Consider adding some more`
		},
		votePending: `Vote is pending`,
		empty: `WARNING: Queue is empty. Please add to it`,
		showNext(layerQueue: M.LayerList, parts: M.UserPart) {
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
						setByDisplay = `Set by ${parts.users.find(user => user.discordId === userId)}`
					}
					break
				default:
					assertNever(item.source)
			}

			const queueCountDisplay = `(${layerQueue.length} in queue)`

			if (!item) return `Next layer not configured ${queueCountDisplay}`
			if (item.vote) {
				if (item.layerId) {
					return `Next layer (Chosen via vote):\n${DH.toShortLayerNameFromId(item.layerId)} (${setByDisplay}) ${queueCountDisplay}`
				} else {
					return {
						msg: [
							'Upcoming vote:',
							...voteChoicesLines(item.vote.choices, item.vote.defaultChoice),
							`${setByDisplay} ${queueCountDisplay}`,
						],
						repeat: 3,
					}
				}
			}
			// this shouldn't be possible
			if (!item.layerId) return `No next layer set ${queueCountDisplay}`

			return `Next layer: ${DH.toShortLayerNameFromId(item.layerId)} (${setByDisplay}) ${queueCountDisplay}`
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
}

type WarnNode = {
	[key: string]: WarnNode | WarnOptions | ((...args: any[]) => WarnOptions)
}

type MessageOutput = string
type MessageNode = {
	[key: string]: MessageNode | MessageOutput | ((...args: any[]) => MessageOutput)
}

function voteChoicesLines(choices: M.LayerId[], defaultLayer: M.LayerId) {
	return choices.map((c, index) => {
		const isDefault = c === defaultLayer
		return `${index + 1}. ${DH.toShortLayerNameFromId(c)} ${isDefault ? ' (Default)' : ''}`
	})
}
