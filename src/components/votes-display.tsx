import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useSquadServerStatus } from '@/hooks/use-squad-server-status'
import * as DH from '@/lib/display-helpers'
import { assertNever } from '@/lib/typeGuards'
import * as M from '@/models'

type VoteTallyProps = {
	voteState: M.VoteStateWithVoteData
	playerCount: number
}

export default function VoteTallyDisplay({ voteState, playerCount }: VoteTallyProps) {
	const tally = M.tallyVotes(voteState, playerCount)
	const options = Array.from(tally.totals)
		.map(([layerId, voteCount]) => {
			const index = voteState.choices.findIndex((choice) => choice === layerId)
			return {
				id: layerId,
				index,
				percentage: tally.percentages.get(layerId),
				name: DH.toShortLayerNameFromId(layerId),
				votes: voteCount,
				isWinner: voteState.code === 'ended:winner' && voteState.winner === layerId,
			}
		})
		.sort((a, b) => a.index - b.index)

	const statusRes = useSquadServerStatus()
	if (statusRes?.code !== 'ok') return null
	const status = statusRes.data
	const totalVoteDisplay = tally.turnoutPercentage !== null ? ` (${tally.turnoutPercentage.toFixed(1)}%)` : null
	let statusDisplay: string
	switch (voteState.code) {
		case 'ended:winner':
		case 'ended:aborted':
		case 'ended:insufficient-votes':
			statusDisplay = 'Vote has ended.'
			break
		case 'in-progress':
			statusDisplay = 'Vote in progress...'
			break
		default:
			assertNever(voteState)
	}

	return (
		<Card className='mx-auto w-full max-w-md'>
			<CardHeader>
				<CardTitle className=''>{statusDisplay}</CardTitle>
			</CardHeader>
			<CardContent className='space-y-6'>
				{options.map((option) => (
					<div key={option.id} className='mb-4'>
						<div className='mb-2 flex flex-col items-start justify-between space-y-1'>
							<span className={`text-nowrap font-semibold ${option.isWinner ? 'text-green-600' : ''}`}>
								{option.index + 1}. {option.name}
								{option.isWinner && ' ★'}
							</span>
							<span className='text-sm text-gray-500'>
								{option.votes} vote{option.votes !== 1 ? 's' : ''} ({option.percentage?.toFixed(1) ?? 0}%)
							</span>
						</div>
						<Progress value={option.percentage ?? 0} className='h-2 data-[winner]bg-green-100' data-winner={option.isWinner} />
					</div>
				))}
				<div className='mt-4 text-center text-sm text-gray-500'>
					Received: {tally.totalVotes} of {status?.playerCount} votes{totalVoteDisplay}
				</div>
			</CardContent>
		</Card>
	)
}
