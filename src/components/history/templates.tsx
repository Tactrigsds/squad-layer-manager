// static-render calls these components directly, so the react compiler must not inject its memo-cache hook
'use no memo'

// The history page's player and match result rows, as inert jsx. No interactivity of their own; the
// layer-info opener rides the shared delegated handlers. Same idiom as the feed's rows.

import React from 'react'

import * as Atoms from '@/components/feed/atoms'
import * as RC from '@/components/feed/render-context'
import * as HistoryMsgs from '@/messages/history.messages'
import * as I18n from '@/messages/i18n'
import type * as HQ from '@/models/history.models'
import type * as MH from '@/models/match-history.models'

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

// align-top so a row whose events are expanded keeps its own columns beside the first of them, rather than
// centring them against the whole expansion
const CELL = 'px-2 py-1 align-top whitespace-nowrap'
const NUM_CELL = `${CELL} text-right tabular-nums`

/**
 * The count of events behind a results row, as a disclosure that shows them.
 *
 * A native details, so the row stays inert: it names itself with a key and leaves an empty slot, and the
 * page fills the slot through the render ctx on hover or on open (see interactions.ts).
 */
function EventsCell(props: { rowKey: string; count: number }) {
	if (props.count === 0) return <td className={NUM_CELL}>0</td>
	return (
		<td className={NUM_CELL}>
			<details {...{ [RC.ROW_EVENTS_ATTR]: props.rowKey }}>
				<summary className="cursor-pointer tabular-nums">{props.count}</summary>
				<div {...{ [RC.ROW_EVENTS_SLOT_ATTR]: '' }} className="mt-1 flex flex-col gap-0.5 text-left font-normal" />
			</details>
		</td>
	)
}

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
			<EventsCell rowKey={`player:${row.playerId}`} count={row.events} />
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

// unsigned, matching the match.ticketDiff column the filter compiles to: which side won is the outcome's
// question, and this one is only ever asked as "a blowout" or "a close game"
function ticketDiffText(details: MH.MatchDetails): string {
	if (details.status !== 'post-game') return ''
	const outcome = details.outcome
	if (outcome.type !== 'team1' && outcome.type !== 'team2') return ''
	return String(Math.abs(outcome.team1Tickets - outcome.team2Tickets))
}

export function MatchRow(props: { details: MH.MatchDetails; displayTeamsNormalized: boolean; events: number }) {
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
			<td className={CELL}>{ticketDiffText(details)}</td>
			<td className={CELL}>{details.layerSource.type}</td>
			<EventsCell rowKey={`match:${details.historyEntryId}`} count={props.events} />
		</tr>
	)
}
