import React from 'react'

import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Zus from '@/lib/zustand'
import type * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import { GlobalSettingsStore } from '@/systems/client-only-settings.client'
import * as MatchHistoryClient from '@/systems/match-history.client'

import * as Atoms from './feed/atoms'
import { useDomContent } from './feed/dom-content'

export function getTeamsDisplay(
	partialLayer: L.UnvalidatedLayer | L.LayerId,
	teamParity: number | undefined,
	displayLayersNormalized: boolean,
	extraStyles?: Record<keyof L.KnownLayer, string | undefined>,
	includeUnits: boolean = true,
) {
	const parity = teamParity ?? 0
	return MH.getDisplayedTeamOrder(parity, displayLayersNormalized).map((normedTeam) => {
		const team = MH.getDenormedTeamId(normedTeam, parity)
		return (
			<TeamFactionDisplay
				key={team}
				parity={parity}
				includeUnits={includeUnits}
				layer={partialLayer}
				team={team}
				showAltTeamIndicator={true}
				normalized={displayLayersNormalized}
				extraStyles={extraStyles}
			/>
		)
	})
}

/** A team's faction and unit. The markup is Atoms.teamFactionDisplay's; this resolves the setting and mounts it. */
export function TeamFactionDisplay(props: {
	className?: string
	parity: number
	layer: L.UnvalidatedLayer | L.LayerId
	team: SM.TeamId
	includeUnits?: boolean
	showAltTeamIndicator?: boolean
	// Names the team ahead of its faction -- "Team A(current PLA)" rather than "PLA". Only for a header sitting over
	// the live roster, which is what makes "current" true.
	leadWithTeamName?: boolean
	extraStyles?: Record<keyof L.KnownLayer, string | undefined>
	// overrides the global displayTeamsNormalized setting, for a surface showing what the other rendering looks like
	normalized?: boolean
}) {
	const globalNormalized = Zus.useStore(GlobalSettingsStore, (s) => s.displayTeamsNormalized)
	const { className, parity, layer, team, includeUnits, showAltTeamIndicator, leadWithTeamName, extraStyles, normalized } = props
	const node = React.useMemo(
		() =>
			Atoms.teamFactionDisplay({
				className,
				parity,
				layer,
				team,
				includeUnits,
				showAltTeamIndicator,
				leadWithTeamName,
				extraStyles,
				normalized: normalized ?? globalNormalized,
			}),
		[className, parity, layer, team, includeUnits, showAltTeamIndicator, leadWithTeamName, extraStyles, normalized, globalNormalized],
	)
	const ref = useDomContent<HTMLSpanElement>(node)
	return <span ref={ref} className="contents" />
}

export function MatchTeamDisplay(props: {
	matchId?: number
	teamId: SM.TeamId | MH.NormedTeamId
	includeUnits?: boolean
	showAltTeamIndicator?: boolean
	leadWithTeamName?: boolean
	className?: string
	stores: SquadServerFrame.KeyProp
}) {
	const recentMatches = MatchHistoryClient.useRecentMatches(props.stores.squadServer.serverId)
	let match: MH.MatchDetails | undefined
	if (props.matchId === undefined) {
		match = recentMatches[recentMatches.length - 1]
		if (!match?.isCurrentMatch) return null
	} else {
		match = recentMatches.find((m) => m.historyEntryId === props.matchId)
	}
	if (!match) return null
	return (
		<TeamFactionDisplay
			className={props.className}
			parity={match.ordinal}
			team={MH.getDenormedTeamId(props.teamId, match.ordinal)}
			layer={match.layerId}
			includeUnits={props.includeUnits}
			showAltTeamIndicator={props.showAltTeamIndicator}
			leadWithTeamName={props.leadWithTeamName}
		/>
	)
}
