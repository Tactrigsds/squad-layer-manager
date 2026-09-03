// static-render calls these components directly, so the react compiler must not inject its memo-cache hook
'use no memo'

// The history page's player and match result rows, as inert jsx. No interactivity of their own; the
// layer-info opener rides the shared delegated handlers. Same idiom as the feed's rows.

import React from 'react'

import * as Atoms from '@/components/feed/atoms'
import { Icon } from '@/components/feed/icons'
import * as MatchSummary from '@/components/feed/match-summary'
import * as RC from '@/components/feed/render-context'
import * as SM_Msgs from '@/messages/squad.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import type * as HQ from '@/models/history.models'
import type * as MH from '@/models/match-history.models'
import { tr } from '@/systems/messages.client'

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

// align-top so a row whose events are expanded keeps its own columns beside the first of them, rather than
// centring them against the whole expansion
const CELL = 'px-2 py-1 align-top whitespace-nowrap'
const NUM_CELL = `${CELL} text-right tabular-nums`
const ID_CELL = `${CELL} font-mono text-muted-foreground`

/**
 * A results row and the panel that shows the events behind its count.
 *
 * Two sibling rows rather than a disclosure inside a cell: the events want the width of the whole table, and
 * anything inside a cell makes that cell's column grow to fit them. Rendered hidden and inert -- the row
 * names itself with a key, and interactions.ts fills and reveals the panel (see ROW_EVENTS_ATTR).
 */
function ExpandableRow(props: { rowKey: string; count: number; columns: number; menu: RC.MenuTarget; children: React.ReactNode }) {
	// the whole row rather than the name in it: every cell of a results row is about the same subject, so
	// there is nowhere in one where the row's menu is the wrong answer
	const menu = RC.menuAttrs(props.menu)
	// no events, no panel: a chevron that opens an empty tray is worse than no chevron
	if (props.count === 0) {
		return (
			<tr className="border-b border-border hover:bg-accent/30 text-xs" {...menu}>
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
				{...menu}
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

// the player details window's CopyIdButton, minus its hooks: the click and the "Copied!" feedback ride the
// delegated handlers (see interactions.ts), and the kind label stays in the column header rather than the cell
function CopyId(props: { kind: SM_Msgs.IdKind; id: string }) {
	return (
		<button
			type="button"
			className="inline-flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
			title={tr.text(SM_Msgs.copyIdHint(props.kind))}
			{...RC.copyAttrs(props.id)}
		>
			<span className="font-mono">{props.id}</span>
			<Icon name="Copy" className="h-3 w-3" />
		</button>
	)
}

// chevron, the row's own columns, then the events count: PLAYER_ROW_COLUMNS counts all three groups
export const PLAYER_ROW_COLUMNS = 8

export function PlayerRow(props: { row: HQ.PlayerRow }) {
	const { row } = props
	return (
		<ExpandableRow
			rowKey={`player:${row.playerId}`}
			count={row.events}
			columns={PLAYER_ROW_COLUMNS}
			menu={{ kind: 'player', playerId: row.playerId }}
		>
			<td className={CELL}>
				{/* what the feed's player names open, minus the group colour: a results row spans servers and
				    matches, so there is no roster to colour it against. The menu is on the row */}
				<button
					type="button"
					className="font-medium hover:underline"
					{...RC.windowAttrs({
						windowId: WINDOW_ID.enum['player-details'],
						arg: { playerId: row.playerId },
						frame: 'attach',
						preload: true,
					})}
				>
					{row.username ?? row.playerId}
				</button>
			</td>
			<td className={ID_CELL}>{row.steamId && <CopyId kind="steam" id={row.steamId} />}</td>
			<td className={ID_CELL}>
				<CopyId kind="eos" id={row.playerId} />
			</td>
			<td className={NUM_CELL}>{row.matches}</td>
			<td className={NUM_CELL}>{row.chatMessages}</td>
			<td className={CELL}>{dateTime.format(row.lastSeen)}</td>
		</ExpandableRow>
	)
}

export const MATCH_ROW_COLUMNS = 9

export function MatchRow(props: { details: MH.MatchDetails; displayTeamsNormalized: boolean; events: number }) {
	const { details } = props
	const time = MatchSummary.matchTime(details)
	return (
		<ExpandableRow
			rowKey={`match:${details.historyEntryId}`}
			count={props.events}
			columns={MATCH_ROW_COLUMNS}
			menu={{ kind: 'layer', layerIds: [details.layerId], historyEntryIds: [details.historyEntryId] }}
		>
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
			<td className={CELL}>{MatchSummary.outcomeText(details)}</td>
			<td className={CELL}>{MatchSummary.ticketDiffText(details)}</td>
			<td className={CELL}>{MatchSummary.durationText(details)}</td>
			<td className={CELL}>{details.layerSource.type}</td>
		</ExpandableRow>
	)
}
