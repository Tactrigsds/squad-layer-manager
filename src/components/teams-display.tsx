import * as L from '@/models/layer'

import * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import * as MatchHistoryClient from '@/systems.client/match-history.client'

import * as Zus from 'zustand'
import * as DH from '../lib/display-helpers'

export function TeamIndicator(props: { team: 'A' | 'B' | SM.TeamId }) {
	return <span className="font-mono text" style={{ color: DH.TEAM_COLORS[`team${props.team}`] }}>({props.team})</span>
}

export function getTeamsDisplay(
	_partialLayer: L.UnvalidatedLayer | L.LayerId,
	_teamParity: number | undefined,
	displayLayersNormalized: boolean,
	withBackfilledStyles?: Record<keyof L.KnownLayer, string | undefined>,
	includeUnits: boolean = true,
) {
	const teamParity = _teamParity ?? 0

	const teams = [
		<TeamFactionDisplay
			key="1"
			parity={teamParity ?? 0}
			includeUnits={includeUnits}
			layer={_partialLayer}
			team={1}
			showAltTeamIndicator={true}
		/>,
		<TeamFactionDisplay
			key="2"
			parity={teamParity ?? 0}
			includeUnits={includeUnits}
			layer={_partialLayer}
			team={2}
			showAltTeamIndicator={true}
		/>,
	]

	if (teamParity % 2 === 1 && displayLayersNormalized) teams.reverse()
	return teams
}

export function TeamFactionDisplay(
	props: { parity: number; layer: L.UnvalidatedLayer | L.LayerId; team: SM.TeamId; includeUnits?: boolean; showAltTeamIndicator?: boolean },
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
			id: props.team,
		},
		{
			color: [DH.TEAM_COLORS.teamA, DH.TEAM_COLORS.teamB][(props.parity + props.team - 1) % 2],
			label: ['(A)', '(B)'][(props.parity + props.team - 1) % 2],
			title: ['Team A', 'Team B'][(props.parity + props.team - 1) % 2],
			id: MH.getNormedTeamId(props.team, props.parity),
		},
	] as const satisfies { label: string; color: string; title: string; id: 'A' | 'B' | SM.TeamId }[]

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
				{props.showAltTeamIndicator && <TeamIndicator team={attrs[1].id} />}
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

export function MatchTeamDisplay(props: { matchId: number; teamId: SM.TeamId; includeUnits?: boolean; showAltTeamIndicator?: boolean }) {
	const match = MatchHistoryClient.useRecentMatches().find(m => m.historyEntryId === props.matchId)
	if (!match) return null
	return (
		<TeamFactionDisplay
			parity={match.ordinal}
			team={props.teamId}
			layer={match.layerId}
			includeUnits={props.includeUnits}
			showAltTeamIndicator={props.showAltTeamIndicator}
		/>
	)
}
