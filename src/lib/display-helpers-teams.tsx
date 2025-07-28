import * as L from '@/models/layer'
import * as DH from './display-helpers'
import { cn } from './utils'

export const teamColors = {
	teamA: '#9932CC',
	teamB: '#00BFFF',
	team1: 'teal',
	team2: 'coral',
}

export function TeamIndicator(props: { team: keyof typeof teamColors }) {
	return <span className="font-mono text-sm" style={{ color: teamColors[props.team] }}>({props.team[props.team.length - 1]})</span>
}

export function getTeamsDisplay(
	_partialLayer: Partial<L.KnownLayer> | L.LayerId,
	teamParity: number | undefined,
	_displayLayersNormalized: boolean,
	withBackfilledStyles?: Record<keyof L.KnownLayer, string | undefined>,
) {
	const partialLayer = typeof _partialLayer === 'string' ? L.toLayer(_partialLayer) : _partialLayer
	let team1Color: string | undefined = undefined
	let team2Color: string | undefined = undefined
	const displayLayersNormalized = teamParity !== undefined && _displayLayersNormalized
	teamParity ??= 0
	if (!displayLayersNormalized) {
		const colors = [teamColors.teamA, teamColors.teamB]
		team1Color = colors[teamParity % 2]
		team2Color = colors[(teamParity + 1) % 2]
	} else if (displayLayersNormalized) {
		// Colors specifically for (1) and (2) normalized team labels
		team2Color = teamColors.team2
		team1Color = teamColors.team1
	}

	const subfaction1 = partialLayer.Unit_1 !== undefined ? DH.toShortUnit(partialLayer.Unit_1) : undefined
	const subFaction2 = partialLayer.Unit_2 !== undefined ? DH.toShortUnit(partialLayer.Unit_2) : undefined

	const teamElts = [
		<span>
			<span className={cn(withBackfilledStyles?.Faction_1, withBackfilledStyles?.Alliance_1)}>{partialLayer.Faction_1}</span>
			{subfaction1
				? (
					<span className={cn(withBackfilledStyles?.Unit_1, withBackfilledStyles?.Alliance_1)}>
						{` ${subfaction1}`}
					</span>
				)
				: ''}
			<span
				title={`Team ${displayLayersNormalized ? '1' : teamParity % 2 === 1 ? 'B' : 'A'}`}
				className="font-mono text-sm"
				style={{ color: team1Color }}
			>
				{displayLayersNormalized ? '(1)' : teamParity % 2 === 1 ? '(B)' : '(A)'}
			</span>
		</span>,
		<span>
			<span className={cn(withBackfilledStyles?.Faction_2, withBackfilledStyles?.Alliance_2)}>{partialLayer.Faction_2}</span>
			{subFaction2
				? (
					<span className={cn(withBackfilledStyles?.Unit_2, withBackfilledStyles?.Alliance_2)}>
						{` ${subFaction2}`}
					</span>
				)
				: ''}
			<span
				title={`Team ${displayLayersNormalized ? '2' : teamParity % 2 === 1 ? 'A' : 'B'}`}
				className="font-mono text-sm"
				style={{ color: team2Color }}
			>
				{displayLayersNormalized ? '(2)' : teamParity % 2 === 1 ? '(A)' : '(B)'}
			</span>
		</span>,
	]

	const swapTeamOffset = Number(displayLayersNormalized && teamParity % 2 === 1)

	return [
		teamElts[swapTeamOffset],
		teamElts[(swapTeamOffset + 1) % 2],
	]
}
