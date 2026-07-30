import * as DH from '@/lib/display-helpers'
import * as BAL from '@/models/balance-triggers.models'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import { def, raw, t, type TString } from '@/models/messages.models'

// The warn and the web alert render the same sentence. Before, they were two functions with two different parameter
// lists (the warn took `opts.isCurrent`, the other a bare `qualifyAsCurrent` boolean) and one called the other; now
// the arguments are declared once and both targets read the text the factory built.
// Still assembles its text in JavaScript, so it takes no locale yet and renders in English. `pnpm script
// src/scripts/extract-messages.ts` counts what is left.
export const showEvent = def((event: BAL.BalanceTriggerEvent, referenceMatch: MH.MatchDetails, opts?: { isCurrent?: boolean }) => {
	function build() {
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
				opts?.isCurrent ? 'current ' : ''
			}${strongerTeamFaction})`
		}

		return event.evaluationResult!.messageTemplate.replace('{{strongerTeam}}', strongerTeamFormatted)
	}

	// the template is configuration, so what it renders to is a value rather than prose this module owns
	return raw(build())
})

// Keyed reference data rather than messages: there is no target axis for a lookup table, so these stay plain consts.
export const descriptions = {
	'150x2': t('2 consecutive games of a Team winning by 150+ tickets'),
	'200x2': t('2 consecutive games of a Team winning by 200+ tickets'),
	RWS5: t('5 consecutive games of a team winning by any number of tickets'),
	'RAM3+': t('a rolling average of 125+ tickets across any streak of 3 or more games(utilizing the max of all options).'),
} satisfies Record<BAL.TriggerId, TString>

// A representative alert body, for previewing a trigger's level in the settings editor. The real text is built
// per event (RAM3+'s names the window it actually found), so these are samples rather than the live template.
export const sampleMessages = {
	'150x2': t('Team A(USA) has won 2 games by 150+ tickets.'),
	'200x2': t('Team A(USA) has won 2 games by 200+ tickets.'),
	RWS5: t('Team A(USA) has won five games in a row.'),
	'RAM3+': t('Team A(USA) has been winning for 4 games with an average of (125+)(163.50) tickets'),
} satisfies Record<BAL.TriggerId, TString>

// -------- the levels editor --------

// a trigger with no level configured is not evaluated at all
export const levelOff = def('Off')

export const levelPickerLabel = def('{triggerName} level', (triggerName: string) => ({ triggerName }))
