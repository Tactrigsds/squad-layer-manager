import * as M from '@/models'
import * as DH from '@/lib/display-helpers'
import * as RBAC from '@/rbac.models'
import { CommandConfig } from './server/config'
import { WarnOptions } from './lib/rcon/squad-rcon'
import { formatDuration } from 'date-fns'

export const BROADCASTS = {
	vote: {
		started(choices: M.LayerId[], defaultLayer: M.LayerId, duration: number) {
			const minutes = Math.floor(duration / 1000 / 60)
			const seconds = Math.round((duration / 1000) % 60)
			const fullText = `Vote for the next layer:\n${voteChoicesLines(choices, defaultLayer).join('\n')}\n You have ${formatDuration({ seconds, minutes })} to vote`
			return fullText.split('\n')
		},
		winnerSelected(tally: M.Tally, winner: M.LayerId) {
			const resultsText = Array.from(tally.totals.entries())
				.sort((a, b) => b[1] - a[1])
				.map(([choice, votes]) => {
					const isWinner = choice === winner
					const layerName = DH.toShortLayerNameFromId(choice)
					return `${votes} votes - (${tally.percentages.get(choice)}%) ${isWinner ? '[WINNER] ' : ''}${layerName}`
				})
			const randomChoiceExplanation = tally.leaders.length > 1 ? `\n(Winner randomly selected - ${tally.leaders.length} way tie)` : ''
			const fullText = `Vote has ended:\n${resultsText.join('\n')}${randomChoiceExplanation}`
			return fullText.split('\n')
		},
		insufficientVotes: (defaultChoice: M.LayerId) => {
			return `Vote has ended!\nNot enough votes received to decide outcome.\nDefaulting to ${DH.toShortLayerNameFromId(defaultChoice)}`
		},
		aborted(defaultLayer: M.LayerId) {
			return `Vote has been aborted. Defaulting to ${DH.toShortLayerNameFromId(defaultLayer)} for now`
		},
		voteReminder(timeLeft: number, choices: M.LayerId[]) {
			const minutes = Math.floor(timeLeft / 1000 / 60)
			const seconds = Math.round((timeLeft / 1000) % 60)
			const choicesText = choices.map((c, index) => `${index + 1}. ${DH.toShortLayerNameFromId(c)}`).join('\n')
			const fullText = `${formatDuration({ minutes, seconds })} to cast your vote! Choices:\n${choicesText}\n`
			return fullText.split('\n')
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
		empty: `WARNING: Queue is empty. Please add to it`,
		showNext(item: M.LayerListItem | null) {
			if (!item) return `Next layer not configured`
			if (item.vote) {
				if (item.layerId) {
					return `Next layer (Chosen via vote):\n${DH.toShortLayerNameFromId(item.layerId)}`
				} else {
					return { msg: ['Upcoming vote:', ...voteChoicesLines(item.vote.choices, item.vote.defaultChoice)], repeat: 3 }
				}
			}
			// this shouldn't be possible
			if (!item.layerId) return `No next layer set`

			return `Next layer: ${DH.toShortLayerNameFromId(item.layerId)}`
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
			const groupsJoined = groups.map((g) => g.join('\n'))

			return { msg: groupsJoined, repeat: 3 }
		},
	},
	permissionDenied(res: RBAC.PermissionDeniedResponse) {
		return `Permission denied. You need ${res.check} of the following ${res.permits.map((p) => p.type).join(', ')}`
	},
} satisfies WarnNode

type WarnNode = {
	[key: string]: WarnNode | WarnOptions | ((...args: any[]) => WarnOptions)
}

type MessageOutput = string | string[]
type MessageNode = {
	[key: string]: MessageNode | MessageOutput | ((...args: any[]) => MessageOutput)
}

function voteChoicesLines(choices: M.LayerId[], defaultLayer: M.LayerId) {
	return choices.map((c, index) => {
		const isDefault = c === defaultLayer
		return `${index + 1}. ${DH.toShortLayerNameFromId(c)} ${isDefault ? ' (Default)' : ''}`
	})
}
