import * as M from '@/models'
import * as DH from './display-helpers'

export function getTeamsDisplay(
	partialLayer: ReturnType<typeof M.getLayerDetailsFromUnvalidated>,
	normTeamOffset?: 0 | 1,
	displayLayersNormalized?: boolean,
) {
	const subfaction1 = partialLayer.SubFac_1 !== undefined ? DH.toShortSubfaction(partialLayer.SubFac_1) : undefined
	const subFaction2 = partialLayer.SubFac_2 !== undefined ? DH.toShortSubfaction(partialLayer.SubFac_2) : undefined

	let team1Color: string | undefined = undefined
	let team2Color: string | undefined = undefined
	if (typeof normTeamOffset === 'number' && !displayLayersNormalized) {
		const colors = ['teal', 'coral']
		team1Color = colors[normTeamOffset]
		team2Color = colors[(normTeamOffset + 1) % 2]
	} else if (displayLayersNormalized) {
		// Colors specifically for (1) and (2) normalized team labels
		team1Color = '#9932CC' // purple
		team2Color = '#00BFFF' // deep sky blue
	}

	const teamElts = [
		<span>
			{partialLayer.Faction_1}
			{subfaction1 ? ` ${subfaction1}` : ''}
			<span
				title={`Team ${displayLayersNormalized ? '1' : normTeamOffset === 1 ? 'B' : 'A'}`}
				className="font-mono text-sm"
				style={{ color: team1Color }}
			>
				{displayLayersNormalized ? '(1)' : normTeamOffset === 1 ? '(B)' : '(A)'}
			</span>
		</span>,
		<span>
			{partialLayer.Faction_2}
			{subFaction2 ? ` ${subFaction2}` : ''}
			<span
				title={`Team ${displayLayersNormalized ? '2' : normTeamOffset === 1 ? 'A' : 'B'}`}
				className="font-mono text-sm"
				style={{ color: team2Color }}
			>
				{displayLayersNormalized ? '(2)' : normTeamOffset === 1 ? '(A)' : '(B)'}
			</span>
		</span>,
	]

	const swapTeamOffset = Number(displayLayersNormalized && normTeamOffset === 1)

	return [
		teamElts[swapTeamOffset],
		teamElts[(swapTeamOffset + 1) % 2],
	]
}
