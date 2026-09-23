// Players and matches results as a table of plain values, for their text and csv forms: one column per column of
// the table the page draws (see templates.tsx), from the same helpers its cells use.

import { createElement } from 'react'

import * as Atoms from '@/components/feed/atoms'
import { formatDateTimeIn } from '@/components/feed/format'
import * as MatchSummary from '@/components/feed/match-summary'
import * as RowText from '@/components/feed/row-text'
import * as HistoryMsgs from '@/messages/history.messages'
import * as I18n from '@/messages/i18n'
import type * as HQ from '@/models/history.models'
import type * as MH from '@/models/match-history.models'

export type Table = { headers: string[]; rows: string[][]; numeric: boolean[] }
export type TableOpts = { timeZone: string; displayTeamsNormalized: boolean }

type Column<R> = { header: string; numeric?: boolean; value: (row: R) => string }

function table<R>(columns: Column<R>[], rows: R[]): Table {
	return {
		headers: columns.map((c) => c.header),
		rows: rows.map((row) => columns.map((c) => c.value(row))),
		numeric: columns.map((c) => c.numeric ?? false),
	}
}

const text = (msg: Parameters<typeof I18n.ambient.text>[0]) => I18n.ambient.text(msg)

export function playersTable(rows: HQ.PlayerRow[], opts: TableOpts): Table {
	return table<HQ.PlayerRow>(
		[
			{ header: text(HistoryMsgs.colPlayer()), value: (r) => r.username ?? r.playerId },
			{ header: text(HistoryMsgs.colSteamId()), value: (r) => r.steamId ?? '' },
			{ header: text(HistoryMsgs.colEosId()), value: (r) => r.playerId },
			{ header: text(HistoryMsgs.colMatches()), numeric: true, value: (r) => String(r.matches) },
			{ header: text(HistoryMsgs.colChat()), numeric: true, value: (r) => String(r.chatMessages) },
			{ header: text(HistoryMsgs.colLastSeen()), value: (r) => formatDateTimeIn(r.lastSeen, opts.timeZone) },
			{ header: text(HistoryMsgs.colEvents()), numeric: true, value: (r) => String(r.events) },
		],
		rows,
	)
}

export type MatchRow = { details: MH.MatchDetails; events: number }

export function matchesTable(rows: MatchRow[], opts: TableOpts): Table {
	return table<MatchRow>(
		[
			{
				header: text(HistoryMsgs.colTime()),
				value: ({ details }) => {
					const time = MatchSummary.matchTime(details)
					return time ? formatDateTimeIn(time.getTime(), opts.timeZone) : ''
				},
			},
			{ header: text(HistoryMsgs.colServer()), value: ({ details }) => details.serverId },
			{
				header: text(HistoryMsgs.colLayer()),
				value: ({ details }) =>
					RowText.nodeText(
						createElement(Atoms.ShortLayerName, {
							normalized: opts.displayTeamsNormalized,
							layerId: details.layerId,
							teamParity: details.ordinal % 2,
						}),
					),
			},
			{ header: text(HistoryMsgs.colOutcome()), value: ({ details }) => MatchSummary.outcomeText(details) },
			{ header: text(HistoryMsgs.colTicketDiff()), numeric: true, value: ({ details }) => MatchSummary.ticketDiffText(details) },
			{ header: text(HistoryMsgs.colKills()), numeric: true, value: ({ details }) => MatchSummary.killsText(details) },
			{ header: text(HistoryMsgs.colKillDiff()), numeric: true, value: ({ details }) => MatchSummary.killDiffText(details) },
			{ header: text(HistoryMsgs.colDuration()), numeric: true, value: ({ details }) => MatchSummary.durationText(details) },
			{ header: text(HistoryMsgs.colSetBy()), value: ({ details }) => details.layerSource.type },
			{ header: text(HistoryMsgs.colEvents()), numeric: true, value: ({ events }) => String(events) },
		],
		rows,
	)
}

/** Aligned columns under a header and a rule, numbers to the right. */
export function tableText(t: Table): string {
	const widths = t.headers.map((header, i) => Math.max(header.length, ...t.rows.map((row) => row[i].length)))
	const line = (cells: string[]) =>
		cells
			.map((cell, i) => (t.numeric[i] ? cell.padStart(widths[i]) : cell.padEnd(widths[i])))
			.join('  ')
			.trimEnd()
	return [line(t.headers), widths.map((w) => '-'.repeat(w)).join('  '), ...t.rows.map(line)].join('\n')
}

// A text cell a spreadsheet would read as a formula. Player names are chosen by players, so a name like
// `=HYPERLINK(...)` would otherwise run when the file is opened; the leading quote keeps it text.
const FORMULA_START = /^[=+\-@\t\r]/

/** RFC 4180: a header row, quoted cells where they need it, CRLF line ends. */
export function tableCsv(t: Table): string {
	const cell = (value: string, numeric: boolean) => {
		const safe = !numeric && FORMULA_START.test(value) ? `'${value}` : value
		return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
	}
	const line = (cells: string[], header = false) => cells.map((c, i) => cell(c, !header && t.numeric[i])).join(',')
	return [line(t.headers, true), ...t.rows.map((row) => line(row))].join('\r\n')
}
