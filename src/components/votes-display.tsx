import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import * as DH from '@/lib/display-helpers'
import { assertNever } from '@/lib/type-guards'
import * as V_Msgs from '@/messages/vote.messages'
import type * as LL from '@/models/layer-list.models'
import * as V from '@/models/vote.models'
import { tr } from '@/systems/messages.client'
import * as SquadServerClient from '@/systems/squad-server.client'

type VoteTallyProps = {
	voteState: V.VoteStateWithVoteData
	voteItem: LL.VoteItem
	playerCount: number
	serverId: string
}

export default function VoteTallyDisplay({ voteState, voteItem, playerCount, serverId }: VoteTallyProps) {
	const tally = V.tallyVotes(voteState, playerCount)
	const options = Array.from(tally.totals)
		.map(([itemId, voteCount]) => {
			const index = voteState.choiceIds.findIndex((id) => id === itemId)
			const choice = voteItem.choices.find((c) => c.itemId === itemId)
			return {
				id: itemId,
				index,
				percentage: tally.percentages.get(itemId),
				name: choice ? DH.toShortLayerNameFromId(choice.layerId) : tr.text(V_Msgs.unknownChoice()),
				votes: voteCount,
				isWinner: voteState.code === 'ended:winner' && voteState.winnerId === itemId,
			}
		})
		.sort((a, b) => a.index - b.index)

	const serverInfoRes = SquadServerClient.useServerInfoRes(serverId)
	if (serverInfoRes?.code !== 'ok') return null
	const serverInfo = serverInfoRes.data
	let statusDisplay: string
	switch (voteState.code) {
		case 'ended:winner':
		case 'ended:aborted':
		case 'ended:insufficient-votes':
			statusDisplay = tr.text(V_Msgs.voteEnded())
			break
		case 'in-progress':
			statusDisplay = tr.text(V_Msgs.voteInProgress())
			break
		default:
			assertNever(voteState)
	}

	return (
		<Card className="mx-auto w-full">
			<CardHeader>
				<CardTitle className="">{statusDisplay}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-6">
				{options.map((option) => (
					<div key={option.id} className="mb-4">
						<div className="mb-2 flex flex-col items-start justify-between space-y-1">
							<span className={`text-nowrap font-semibold ${option.isWinner ? 'text-ok' : ''}`}>
								{option.index + 1}. {option.name}
								{option.isWinner && ' ★'}
							</span>
							<span className="text-sm text-text-3">{tr.text(V_Msgs.choiceVotes(option.votes, option.percentage ?? 0))}</span>
						</div>
						<Progress value={option.percentage ?? 0} className="h-2 data-[winner]bg-green-100" data-winner={option.isWinner} />
					</div>
				))}
				<div className="mt-4 text-center text-sm text-text-3">
					{tr.text(V_Msgs.turnout(tally.totalVotes, serverInfo?.playerCount ?? 0, tally.turnoutPercentage))}
				</div>
			</CardContent>
		</Card>
	)
}
