import * as DH from '@/lib/display-helpers'
import type * as Msgs from '@/messages/shared'
import * as BAL from '@/models/balance-triggers.models'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'

export const WARNS = {
	showEvent(event: BAL.BalanceTriggerEvent, match: MH.MatchDetails, opts?: { isCurrent?: boolean }) {
		return {
			msg: GENERAL.showEvent(event, match, !!opts?.isCurrent),
		}
	},
} satisfies Msgs.WarnNode

export const GENERAL = {
	showEvent(event: BAL.BalanceTriggerEvent, referenceMatch: MH.MatchDetails, qualifyAsCurrent: boolean) {
		if (!BAL.isKnownEventInstance(event)) {
			const result = event.evaluationResult as BAL.EvaluationResultBase<any>
			return result.messageTemplate.replace('{{strongerTeam}}', result.strongerTeam)
		}

		const currentLayerPartial = L.toLayer(referenceMatch.layerId)
		let strongerTeamFormatted: string
		const strongerTeamFaction = currentLayerPartial?.[MH.getTeamNormalizedFactionProp(referenceMatch.ordinal, event.strongerTeam)]
		if (!strongerTeamFaction) {
			strongerTeamFormatted = DH.toFormattedNormalizedTeam(event.strongerTeam)
		} else {
			strongerTeamFormatted = `${DH.toFormattedNormalizedTeam(event.strongerTeam)}(${
				qualifyAsCurrent ? 'current ' : ''
			}${strongerTeamFaction})`
		}

		return event.evaluationResult!.messageTemplate.replace('{{strongerTeam}}', strongerTeamFormatted)
	},
	descriptions: {
		'150x2': '2 consecutive games of a Team winning by 150+ tickets',
		'200x2': '2 consecutive games of a Team winning by 200+ tickets',
		RWS5: '5 consecutive games of a team winning by any number of tickets',
		'RAM3+': 'a rolling average of 125+ tickets across any streak of 3 or more games(utilizing the max of all options).',
	} satisfies Record<BAL.TriggerId, string>,
	// A representative alert body, for previewing a trigger's level in the settings editor. The real text is built
	// per event (RAM3+'s names the window it actually found), so these are samples rather than the live template.
	sampleMessages: {
		'150x2': 'Team A(USA) has won 2 games by 150+ tickets.',
		'200x2': 'Team A(USA) has won 2 games by 200+ tickets.',
		RWS5: 'Team A(USA) has won five games in a row.',
		'RAM3+': 'Team A(USA) has been winning for 4 games with an average of (125+)(163.50) tickets',
	} satisfies Record<BAL.TriggerId, string>,
}
