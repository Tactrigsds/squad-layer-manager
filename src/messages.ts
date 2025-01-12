import * as M from '@/models'
import * as DH from '@/lib/display-helpers'
import { CommandConfig } from './server/config'

export const BROADCASTS = {
	vote: {
		started(choices: M.LayerId[], defaultLayer: M.LayerId) {
			return `Vote for the next layer:\n${voteChoicesLines(choices, defaultLayer).join('\n')}`
		},
		winnerSelected(tally: M.Tally, winner: M.LayerId) {
			const leaderText = tally.leaders.length > 1 ? `\nWinner was randomly selected from ${tally.leaders.length} tied choices` : ''

			const resultsText = Array.from(tally.totals.entries())
				.map(([choice, votes]) => {
					const isWinner = choice === winner
					const layerName = DH.toShortLayerNameFromId(choice)
					return `${isWinner ? '**' : ''}${layerName}: ${votes} vote${votes === 1 ? '' : 's'}${isWinner ? '**' : ''}`
				})
				.join('\n')

			return `Vote has ended. Winner: ${DH.toShortLayerNameFromId(winner)}.${leaderText}\nResults:\n${resultsText}`
		},
		insufficientVotes: (defaultChoice: M.LayerId) => {
			return `Vote has ended!\nNot enough votes received to decide outcome.\nDefaulting to ${DH.toShortLayerNameFromId(defaultChoice)}`
		},
		aborted(defaultLayer: M.LayerId) {
			return `Vote has been aborted. Defaulting to ${DH.toShortLayerNameFromId(defaultLayer)} for now`
		},
		voteReminder(timeLeftSeconds: number, choices: M.LayerId[]) {
			const choicesText = choices.map((c, index) => `${index + 1}. ${DH.toShortLayerNameFromId(c)}`).join('\n')
			return `Vote for the next layer:\n${choicesText}\nTime remaining: ${timeLeftSeconds} seconds`
		},
	},
} satisfies StringTemplateNode

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
} satisfies WarnNode

type WarnOutput = string | string[] | { msg: string | string[]; repeat: number }
type WarnNode = {
	[key: string]: WarnNode | WarnOutput | ((...args: any[]) => WarnOutput)
}

type StringTemplateNode = {
	[key: string]: StringTemplateNode | string | ((...args: any[]) => string)
}

function voteChoicesLines(choices: M.LayerId[], defaultLayer: M.LayerId) {
	return choices.map((c, index) => {
		const isDefault = c === defaultLayer
		return `${index + 1}. ${DH.toShortLayerNameFromId(c)} ${isDefault ? ' (Default)' : ''}`
	})
}
