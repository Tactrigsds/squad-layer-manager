// static-render calls these components directly, so the react compiler must not inject its memo-cache hook
'use no memo'

// The history page's player and match result rows, as inert jsx. No interactivity of their own; the
// layer-info opener rides the shared delegated handlers. Same idiom as the feed's rows.

import React from 'react'

import * as Atoms from '@/components/feed/atoms'
import * as HistoryMsgs from '@/messages/history.messages'
import * as I18n from '@/messages/i18n'
import type * as HQ from '@/models/history.models'
import type * as MH from '@/models/match-history.models'

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const CELL = 'px-2 py-1 whitespace-nowrap'
const NUM_CELL = `${CELL} text-right tabular-nums`

export function PlayerRow(props: { row: HQ.PlayerRow }) {
	const { row } = props
	return (
		<tr className="border-b border-border hover:bg-accent/30 text-xs">
			<td className={CELL}>
				<span className="font-medium">{row.username ?? row.playerId}</span>
				{row.steamId && <span className="text-muted-foreground ml-2">{row.steamId}</span>}
			</td>
			<td className={NUM_CELL}>{row.matches}</td>
			<td className={NUM_CELL}>{row.kills}</td>
			<td className={NUM_CELL}>{row.deaths}</td>
			<td className={NUM_CELL}>{row.teamkills}</td>
			<td className={NUM_CELL}>{row.chatMessages}</td>
			<td className={CELL}>{dateTime.format(row.lastSeen)}</td>
		</tr>
	)
}

function outcomeText(details: MH.MatchDetails): string {
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

export function MatchRow(props: { details: MH.MatchDetails; displayTeamsNormalized: boolean }) {
	const { details } = props
	const time = details.startTime ?? (details.status === 'post-game' && details.endTime !== 'unknown' ? details.endTime : undefined)
	return (
		<tr className="border-b border-border hover:bg-accent/30 text-xs">
			<td className={CELL}>{time ? dateTime.format(time) : ''}</td>
			<td className={CELL}>{details.serverId}</td>
			<td className="px-2 py-1">
				<Atoms.ShortLayerName
					normalized={props.displayTeamsNormalized}
					layerId={details.layerId}
					teamParity={details.ordinal % 2}
					className="text-xs"
				/>
			</td>
			<td className={CELL}>{outcomeText(details)}</td>
			<td className={CELL}>{details.layerSource.type}</td>
		</tr>
	)
}
