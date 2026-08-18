import React from 'react'

import { TeamIndicator } from '@/components/teams-display'
import * as DH from '@/lib/display-helpers'
import * as TUT_Msgs from '@/messages/tutorials.messages'
import { tr } from '@/systems/messages.client'

// Rich card bodies for tour steps whose point is visual: the team color coding is shown with the app's own
// marks/colors instead of being described. Strings stay in TUT_Msgs. Spans throughout: the card body is a <p>.

export function TeamSlotsBody() {
	return (
		<span className="flex flex-col gap-1.5">
			<span>{tr.text(TUT_Msgs.teamSlotsIntro())}</span>
			<span className="flex items-baseline gap-1.5">
				<TeamIndicator team={1} />
				<span>{tr.text(TUT_Msgs.teamSlotsTeam1())}</span>
			</span>
			<span className="flex items-baseline gap-1.5">
				<TeamIndicator team={2} />
				<span>{tr.text(TUT_Msgs.teamSlotsTeam2())}</span>
			</span>
			<span>{tr.text(TUT_Msgs.teamSlotsSwap())}</span>
		</span>
	)
}

export function TeamNormalizeBody() {
	return (
		<span className="flex flex-col gap-1.5">
			<span>{tr.text(TUT_Msgs.teamNormalizeIntro())}</span>
			<span className="flex items-baseline gap-3 font-mono">
				<span style={{ color: DH.TEAM_COLORS.teamA }}>{tr.text(TUT_Msgs.teamALabel())}</span>
				<span style={{ color: DH.TEAM_COLORS.teamB }}>{tr.text(TUT_Msgs.teamBLabel())}</span>
			</span>
			<span>{tr.text(TUT_Msgs.teamNormalizeOutro())}</span>
		</span>
	)
}
