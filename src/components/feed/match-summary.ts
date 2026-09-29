// One match's numbers as text, shared by the history page's match rows and by the tooltip on an event row's
// id badge. Both restate the same match, so they say it the same way.

import { assertNever } from '@/lib/type-guards'
import * as MsgFmt from '@/messages/format'
import * as HistoryMsgs from '@/messages/history.messages'
import * as I18n from '@/messages/i18n'
import * as LL_Msgs from '@/messages/layer-list.messages'
import type * as LL from '@/models/layer-list.models'
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

// The scoreline, over both sides, matching the match.kills and match.killDiff columns the filters compile to.
// Blank on a match with no tally, which is also what those filters can never match.
export function killsText(details: MH.MatchDetails): string {
	const stats = details.combatStats
	return stats ? String(stats.team1.kills + stats.team2.kills) : ''
}

export function killDiffText(details: MH.MatchDetails): string {
	const stats = details.combatStats
	return stats ? String(Math.abs(stats.team1.kills - stats.team2.kills)) : ''
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

// display names by id, for what a layer source names: users by discord id, players by steam id, plugins by id
export type SetByNames = { users: Record<string, string>; players: Record<string, string>; plugins: Record<string, string> }

// who set the match's layer: the user, the requesting users or players, or the plugin, falling back to their ids
export function setByText(source: LL.Source, names: SetByNames): string {
	switch (source.type) {
		case 'manual':
			return names.users[source.userId.toString()] ?? source.userId.toString()
		case 'plugin':
			return names.plugins[source.pluginId] ?? source.pluginId
		case 'layer-request': {
			const requesters = source.requesters.flatMap((r) => {
				const discordId = r.discordId?.toString()
				const name = (discordId && names.users[discordId]) || (r.steamId && names.players[r.steamId]) || discordId || r.steamId
				return name ? [name] : []
			})
			return requesters.length > 0 ? MsgFmt.formatList(requesters) : I18n.ambient.text(HistoryMsgs.setByLayerRequest())
		}
		case 'gameserver':
		case 'generated':
		case 'unknown':
		case 'ingame-vote':
			return LL_Msgs.sourceNames[source.type]
		default:
			assertNever(source)
	}
}
