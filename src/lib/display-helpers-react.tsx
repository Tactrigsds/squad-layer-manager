import * as M from '@/models'
import * as DH from './display-helpers'

export function getTeamsDisplay(
	partialLayer: Partial<M.MiniLayer>,
	teamParity: number,
	displayLayersNormalized: boolean,
	withBackfilledStyles?: Record<keyof M.MiniLayer, string | undefined>,
) {
	let team1Color: string | undefined = undefined
	let team2Color: string | undefined = undefined
	if (typeof teamParity === 'number' && !displayLayersNormalized) {
		const colors = ['teal', 'coral']
		team1Color = colors[teamParity]
		team2Color = colors[(teamParity + 1) % 2]
	} else if (displayLayersNormalized) {
		// Colors specifically for (1) and (2) normalized team labels
		team1Color = '#9932CC' // purple
		team2Color = '#00BFFF' // deep sky blue
	}

	const subfaction1 = partialLayer.SubFac_1 !== undefined ? DH.toShortSubfaction(partialLayer.SubFac_1) : undefined
	const subFaction2 = partialLayer.SubFac_2 !== undefined ? DH.toShortSubfaction(partialLayer.SubFac_2) : undefined

	const teamElts = [
		<span>
			<span className={withBackfilledStyles?.Faction_1}>{partialLayer.Faction_1}</span>
			{subfaction1
				? (
					<span className={withBackfilledStyles?.SubFac_1}>
						{` ${subfaction1}`}
					</span>
				)
				: ''}
			<span
				title={`Team ${displayLayersNormalized ? '1' : teamParity === 1 ? 'B' : 'A'}`}
				className="font-mono text-sm"
				style={{ color: team1Color }}
			>
				{displayLayersNormalized ? '(1)' : teamParity === 1 ? '(B)' : '(A)'}
			</span>
		</span>,
		<span>
			<span className={withBackfilledStyles?.Faction_2}>{partialLayer.Faction_2}</span>
			{subFaction2
				? (
					<span className={withBackfilledStyles?.SubFac_2}>
						{` ${subFaction2}`}
					</span>
				)
				: ''}
			<span
				title={`Team ${displayLayersNormalized ? '2' : teamParity === 1 ? 'A' : 'B'}`}
				className="font-mono text-sm"
				style={{ color: team2Color }}
			>
				{displayLayersNormalized ? '(2)' : teamParity === 1 ? '(A)' : '(B)'}
			</span>
		</span>,
	]

	const swapTeamOffset = Number(displayLayersNormalized && teamParity === 1)

	return [
		teamElts[swapTeamOffset],
		teamElts[(swapTeamOffset + 1) % 2],
	]
}
