import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { getMiniLayerFromId } from '@/models'
import type { LayerId } from '@/models'

type VoteTallyProps = {
	totals: Map<LayerId, number>
	choice: LayerId
	votes: number
}

export default function VoteTallyDisplay({ totals, choice, votes }: VoteTallyProps) {
	const totalVotes = Array.from(totals.values()).reduce((sum, count) => sum + count, 0)

	// Convert Map entries to array and sort by vote count descending
	const sortedOptions = Array.from(totals.entries())
		.sort(([, a], [, b]) => b - a)
		.map(([layerId, voteCount]) => {
			const layer = getMiniLayerFromId(layerId)
			return {
				id: layerId,
				name: `${layer.Level} ${layer.Gamemode} (${layer.Faction_1} vs ${layer.Faction_2})`,
				votes: voteCount,
				isWinner: layerId === choice,
			}
		})

	return (
		<Card className="w-full max-w-md mx-auto">
			<CardHeader>
				<CardTitle className="text-2xl font-bold text-center">Live Vote Results</CardTitle>
			</CardHeader>
			<CardContent>
				{sortedOptions.map((option) => (
					<div key={option.id} className="mb-4">
						<div className="flex justify-between items-center mb-2">
							<span className={`font-semibold ${option.isWinner ? 'text-green-600' : ''}`}>
								{option.name}
								{option.isWinner && ' ★'}
							</span>
							<span className="text-sm text-gray-500">
								{option.votes} vote{option.votes !== 1 ? 's' : ''}
							</span>
						</div>
						<Progress
							value={totalVotes > 0 ? (option.votes / totalVotes) * 100 : 0}
							className={`h-2 ${option.isWinner ? 'bg-green-100' : ''}`}
						/>
					</div>
				))}
				<div className="mt-4 text-center text-sm text-gray-500">Total Votes: {totalVotes}</div>
			</CardContent>
		</Card>
	)
}
