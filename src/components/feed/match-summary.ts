// One match's numbers as text, shared by the history page's match rows and by the tooltip on an event row's
// id badge. Both restate the same match, so they say it the same way.

import * as HistoryMsgs from '@/messages/history.messages'
import * as I18n from '@/messages/i18n'
import type * as MH from '@/models/match-history.models'

export function outcomeText(details: MH.MatchDetails): string {
	if (details.status !== 'post-game') return ''
	const outcome = details.outcome
	switch (outcome.type) {
		case 'team1':
			return `${I18n.ambient.text(HistoryMsgs.outcomeTeam1())} ${outcome.team1Tickets}:${outcome.team2Tickets}`
		case 'team2':
			return `${I18n.ambient.text(HistoryMsgs.outcomeTeam2())} ${outcome.team1Tickets}:${outcome.team2Tickets}`
		case 'draw':
			return I18n.ambient.text(HistoryMsgs.outcomeDraw())
		case 'unknown':
			return ''
	}
}

// unsigned, matching the match.ticketDiff column the filter compiles to: which side won is the outcome's
// question, and this one is only ever asked as "a blowout" or "a close game"
export function ticketDiffText(details: MH.MatchDetails): string {
	if (details.status !== 'post-game') return ''
	const outcome = details.outcome
	if (outcome.type !== 'team1' && outcome.type !== 'team2') return ''
	return String(Math.abs(outcome.team1Tickets - outcome.team2Tickets))
}

// whole minutes, floored to agree with the filter, which divides the two epochs in sql. Blank for a match
// still running or one whose end the app never saw, which is also what the filter can never match.
export function durationText(details: MH.MatchDetails): string {
	if (details.status !== 'post-game' || details.endTime === 'unknown' || !details.startTime) return ''
	return String(Math.floor((details.endTime.getTime() - details.startTime.getTime()) / 60_000))
}

// when the match happened, as the results table dates it: the end where one was recorded, the start otherwise
export function matchTime(details: MH.MatchDetails): Date | undefined {
	return details.startTime ?? (details.status === 'post-game' && details.endTime !== 'unknown' ? details.endTime : undefined)
}
