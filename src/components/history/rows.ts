// The history page's player and match result rows, built as dom with no interactivity of their own (the
// layer-info opener rides the shared delegated handlers). Same reasoning and idiom as the feed's rows.

import * as Atoms from '@/components/feed/atoms'
import * as Dom from '@/lib/dom'
import * as HistoryMsgs from '@/messages/history.messages'
import type * as HQ from '@/models/history.models'
import type * as MH from '@/models/match-history.models'
import { tr } from '@/systems/messages.client'

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const CELL = 'px-2 py-1 whitespace-nowrap'
const NUM_CELL = `${CELL} text-right tabular-nums`

export function buildPlayerRow(row: HQ.PlayerRow): HTMLElement {
	return Dom.el(
		'tr',
		{ class: 'border-b border-border hover:bg-accent/30 text-xs' },
		Dom.el(
			'td',
			{ class: CELL },
			Dom.el('span', { class: 'font-medium' }, row.username ?? row.playerId),
			row.steamId && Dom.el('span', { class: 'text-muted-foreground ml-2' }, row.steamId),
		),
		Dom.el('td', { class: NUM_CELL }, row.matches),
		Dom.el('td', { class: NUM_CELL }, row.kills),
		Dom.el('td', { class: NUM_CELL }, row.deaths),
		Dom.el('td', { class: NUM_CELL }, row.teamkills),
		Dom.el('td', { class: NUM_CELL }, row.chatMessages),
		Dom.el('td', { class: CELL }, dateTime.format(row.lastSeen)),
	)
}

function outcomeText(details: MH.MatchDetails): string {
	if (details.status !== 'post-game') return ''
	const outcome = details.outcome
	switch (outcome.type) {
		case 'team1':
			return `${tr.text(HistoryMsgs.outcomeTeam1())} ${outcome.team1Tickets}:${outcome.team2Tickets}`
		case 'team2':
			return `${tr.text(HistoryMsgs.outcomeTeam2())} ${outcome.team1Tickets}:${outcome.team2Tickets}`
		case 'draw':
			return tr.text(HistoryMsgs.outcomeDraw())
		case 'unknown':
			return ''
	}
}

export function buildMatchRow(details: MH.MatchDetails, displayTeamsNormalized: boolean): HTMLElement {
	const time = details.startTime ?? (details.status === 'post-game' && details.endTime !== 'unknown' ? details.endTime : undefined)
	return Dom.el(
		'tr',
		{ class: 'border-b border-border hover:bg-accent/30 text-xs' },
		Dom.el('td', { class: CELL }, time ? dateTime.format(time) : ''),
		Dom.el('td', { class: CELL }, details.serverId),
		Dom.el(
			'td',
			{ class: 'px-2 py-1' },
			Atoms.shortLayerName({
				normalized: displayTeamsNormalized,
				layerId: details.layerId,
				teamParity: details.ordinal % 2,
				className: 'text-xs',
			}),
		),
		Dom.el('td', { class: CELL }, outcomeText(details)),
		Dom.el('td', { class: CELL }, details.layerSource.type),
	)
}
