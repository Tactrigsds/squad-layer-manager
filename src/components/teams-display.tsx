import * as L from '@/models/layer'
import type * as SM from '@/models/squad.models'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as Zus from 'zustand'
import * as DH from '../lib/display-helpers'
import { cn } from '../lib/utils'

export function TeamIndicator(props: { team: keyof typeof DH.TEAM_COLORS }) {
	return <span className="font-mono text" style={{ color: DH.TEAM_COLORS[props.team] }}>({props.team[props.team.length - 1]})</span>
}

export function getTeamsDisplay(
	_partialLayer: Partial<L.KnownLayer> | L.LayerId,
	teamParity: number | undefined,
	_displayLayersNormalized: boolean,
	withBackfilledStyles?: Record<keyof L.KnownLayer, string | undefined>,
	includeUnits: boolean = true,
) {
	const partialLayer = typeof _partialLayer === 'string' ? L.toLayer(_partialLayer) : _partialLayer
	let team1Color: string | undefined = undefined
	let team2Color: string | undefined = undefined
	const displayLayersNormalized = teamParity !== undefined && _displayLayersNormalized
	let _teamParity = teamParity ?? 0
	if (!displayLayersNormalized) {
		const colors = [DH.TEAM_COLORS.teamA, DH.TEAM_COLORS.teamB]
		team1Color = colors[_teamParity % 2]
		team2Color = colors[(_teamParity + 1) % 2]
	} else if (displayLayersNormalized) {
		// Colors specifically for (1) and (2) normalized team labels
		team2Color = DH.TEAM_COLORS.team2
		team1Color = DH.TEAM_COLORS.team1
	}

	const subfaction1 = includeUnits && partialLayer.Unit_1 !== undefined ? DH.toShortUnit(partialLayer.Unit_1) : undefined
	const subFaction2 = includeUnits && partialLayer.Unit_2 !== undefined ? DH.toShortUnit(partialLayer.Unit_2) : undefined

	const teamElts = [
		<span key="team1">
			<span className={cn(withBackfilledStyles?.Faction_1, withBackfilledStyles?.Alliance_1)}>{partialLayer.Faction_1}</span>
			{subfaction1
				? (
					<span className={cn(withBackfilledStyles?.Unit_1, withBackfilledStyles?.Alliance_1)}>
						{` ${subfaction1}`}
					</span>
				)
				: ''}
			<span
				title={`Team ${displayLayersNormalized ? '1' : _teamParity % 2 === 1 ? 'B' : 'A'}`}
				className="font-mono "
				style={{ color: team1Color }}
			>
				{displayLayersNormalized ? '(1)' : _teamParity % 2 === 1 ? '(B)' : '(A)'}
			</span>
		</span>,
		<span key="team2">
			<span className={cn(withBackfilledStyles?.Faction_2, withBackfilledStyles?.Alliance_2)}>{partialLayer.Faction_2}</span>
			{subFaction2
				? (
					<span className={cn(withBackfilledStyles?.Unit_2, withBackfilledStyles?.Alliance_2)}>
						{` ${subFaction2}`}
					</span>
				)
				: ''}
			<span
				title={`Team ${displayLayersNormalized ? '2' : _teamParity % 2 === 1 ? 'A' : 'B'}`}
				className="font-mono"
				style={{ color: team2Color }}
			>
				{displayLayersNormalized ? '(2)' : _teamParity % 2 === 1 ? '(A)' : '(B)'}
			</span>
		</span>,
	]

	const swapTeamOffset = Number(displayLayersNormalized && _teamParity % 2 === 1)

	return [
		teamElts[swapTeamOffset],
		teamElts[(swapTeamOffset + 1) % 2],
	]
}

export function TeamFactionDisplay(
	props: { parity: number; layer: L.UnvalidatedLayer | L.LayerId; team: SM.TeamId; includeUnits?: boolean },
) {
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, s => s.displayTeamsNormalized)
	const partialLayer = typeof props.layer === 'string' ? L.toLayer(props.layer) : props.layer

	// Determine which team we're displaying (1 or 2)
	const isTeam1 = props.team === 1

	// Get faction  based on team
	const faction = isTeam1 ? partialLayer.Faction_1 : partialLayer.Faction_2

	// Get unit based on team
	const unit = [partialLayer.Unit_1, partialLayer.Unit_2][props.team - 1]
	const shortUnit = unit !== undefined ? DH.toShortUnit(unit) : undefined

	let attrs = [
		{
			color: [DH.TEAM_COLORS.team1, DH.TEAM_COLORS.team2][props.team - 1],
			label: ['(1)', '(2)'][props.team - 1],
			title: ['Team 1', 'Team 2'][props.team - 1],
		},
		{
			color: [DH.TEAM_COLORS.teamA, DH.TEAM_COLORS.teamB][(props.parity + props.team - 1) % 2],
			label: ['(A)', '(B)'][(props.parity + props.team - 1) % 2],
			title: ['Team A', 'Team B'][(props.parity + props.team - 1) % 2],
		},
	] as const satisfies { label: string; color: string; title: string }[]

	if (displayTeamsNormalized) attrs.reverse()

	return (
		<span className="flex flex-nowrap items-center">
			<span title={attrs[0].title} style={{ color: attrs[0].color }} className="font-semibold">
				{faction}
				{props.includeUnits && shortUnit && (
					<span className="font-semibold">
						{` ${shortUnit}`}
					</span>
				)}
			</span>
			{
				/*<span
			 	title={attrs[1].title}
			 	className="font-mono text-sm"
			 	style={{ color: attrs[1].color }}
			 >
			 	{attrs[1].label}
			// </span>*/
			}
		</span>
	)
}

export function MatchTeamDisplay(props: { matchId: number; teamId: SM.TeamId }) {
	const match = MatchHistoryClient.useRecentMatches().find(m => m.historyEntryId === props.matchId)
	if (!match) return null
	return <TeamFactionDisplay parity={match.historyEntryId} team={props.teamId} layer={match.layerId} />
}
