import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { getMiniLayerFromId } from '@/models'
import * as M from '@/models'

type VoteTallyProps = {
	voteState: M.VoteStateWithVoteData
}

export default function VoteTallyDisplay({ voteState }: VoteTallyProps) {
	const tally = M.tallyVotes(voteState)
	const options = Array.from(tally.totals)
		.map(([layerId, voteCount]) => {
			const layer = getMiniLayerFromId(layerId)
			const index = voteState.choices.findIndex((choice) => choice === layerId)
			return {
				id: layerId,
				index,
				percentage: tally.percentages.get(layerId),
				name: `${layer.Level} ${layer.Gamemode} (${layer.Faction_1} vs ${layer.Faction_2})`,
				votes: voteCount,
				isWinner: voteState.code === 'ended:winner' && voteState.winner === layerId,
			}
		})
		.sort((a, b) => a.index - b.index)

	return (
		<Card className="mx-auto w-full max-w-md">
			<CardHeader>
				<CardTitle className="">{voteState.code}</CardTitle>
			</CardHeader>
			<CardContent>
				{options.map((option) => (
					<div key={option.id} className="mb-4">
						<div className="mb-2 flex items-center justify-between space-x-1">
							<span className={`font-semibold ${option.isWinner ? 'text-green-600' : ''}`}>
								{option.index + 1}. {option.name}
								{option.isWinner && ' ★'}
							</span>
							<span className="text-sm text-gray-500">
								{option.votes} vote{option.votes !== 1 ? 's' : ''} ({option.percentage?.toFixed(1) ?? 0}%)
							</span>
						</div>
						<Progress value={option.percentage ?? 0} className={`h-2 ${option.isWinner ? 'bg-green-100' : ''}`} />
					</div>
				))}
				<div className="mt-4 text-center text-sm text-gray-500">Total Votes: {tally.totalVotes}</div>
			</CardContent>
		</Card>
	)
}
