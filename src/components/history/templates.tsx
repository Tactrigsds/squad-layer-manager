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
 * A results row and the panel that shows the events behind its count.
 *
 * Two sibling rows rather than a disclosure inside a cell: the events want the width of the whole table, and
 * anything inside a cell makes that cell's column grow to fit them. Rendered hidden and inert -- the row
 * names itself with a key, and interactions.ts fills and reveals the panel (see ROW_EVENTS_ATTR).
 */
function ExpandableRow(props: { rowKey: string; count: number; columns: number; children: React.ReactNode }) {
	// no events, no panel: a chevron that opens an empty tray is worse than no chevron
	if (props.count === 0) {
		return (
			<tr className="border-b border-border hover:bg-accent/30 text-xs">
				<td className={`${CELL} w-6 text-muted-foreground`} />
				{props.children}
				<td className={NUM_CELL}>0</td>
			</tr>
		)
	}
	return (
		<>
			<tr
				className="border-b border-border hover:bg-accent/30 text-xs cursor-pointer [&[data-open]_.chevron]:rotate-90"
				{...{ [RC.ROW_EVENTS_ATTR]: props.rowKey }}
			>
				<td className={`${CELL} w-6 text-muted-foreground`}>
					<span className="chevron inline-block transition-transform">&#8250;</span>
				</td>
				{props.children}
				<td className={NUM_CELL}>{props.count.toLocaleString()}</td>
			</tr>
			<tr hidden {...{ [RC.ROW_EVENTS_PANEL_ATTR]: props.rowKey }} className="border-b border-border">
				<td colSpan={props.columns} className="px-2 py-1">
					<div {...{ [RC.ROW_EVENTS_SLOT_ATTR]: '' }} className="flex flex-col gap-0.5 pl-6" />
				</td>
			</tr>
		</>
	)
}

// chevron, the row's own columns, then the events count: PLAYER_ROW_COLUMNS counts all three groups
export const PLAYER_ROW_COLUMNS = 9

export function PlayerRow(props: { row: HQ.PlayerRow }) {
	const { row } = props
	return (
		<ExpandableRow rowKey={`player:${row.playerId}`} count={row.events} columns={PLAYER_ROW_COLUMNS}>
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
		</ExpandableRow>
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

export const MATCH_ROW_COLUMNS = 8

export function MatchRow(props: { details: MH.MatchDetails; displayTeamsNormalized: boolean; events: number }) {
	const { details } = props
	const time = details.startTime ?? (details.status === 'post-game' && details.endTime !== 'unknown' ? details.endTime : undefined)
	return (
		<ExpandableRow rowKey={`match:${details.historyEntryId}`} count={props.events} columns={MATCH_ROW_COLUMNS}>
			<td className={CELL}>{time ? dateTime.format(time) : ''}</td>
			<td className={CELL}>{details.serverId}</td>
			<td className="px-2 py-1 align-top">
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
		</ExpandableRow>
	)
}
