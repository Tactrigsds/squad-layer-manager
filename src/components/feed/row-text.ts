// Feed rows as plain text: what copying a selection puts on the clipboard, and what SLM quotes back into discord.
//
// The one implementation. It walks the same inert row templates the feed renders from, the way static-render.ts
// does, so the activity log runs it over the events it holds and the server over a history query's. Each row's
// first line leads with its full timestamp; what the row holds below that (a burst's members, an app event's list
// of changes) follows as indented lines, collapsed disclosures included.

import { createElement, Fragment, type ReactElement, type ReactNode } from 'react'

import * as CHAT_Msgs from '@/messages/chat.messages'
import * as I18n from '@/messages/i18n'
import type * as CHAT from '@/models/chat.models'

import { formatDateTimeIn } from './format'
import * as RC from './render-context'
import { Row } from './rows'

export type TextOpts = {
	timeZone: string
	// name each row's match, for text drawn from a query that spans several
	withMatchIds?: boolean
}

const BLOCK_TAGS = new Set(['div', 'p', 'li', 'pre', 'details', 'summary', 'tr', 'ul', 'ol'])
// Pieces a template sets apart by css rather than by a space in the markup: the items of a flex or grid with a gap,
// an element with a margin on either side, and an icon between two words. Anything else joins the way the markup
// has it, so a layer's Map_Gamemode_v1, drawn as three spans, stays one word.
const GAP_CLASS = /(^|\s)gap(-x)?-(?!0(\s|$))/
const LEADING_MARGIN_CLASS = /(^|\s)(ml|ms|mx)-(?!0(\s|$))/
const TRAILING_MARGIN_CLASS = /(^|\s)(mr|me|mx)-(?!0(\s|$))/

type Line = { text: string; time?: number; matchId?: number }

export function eventsText(ctx: RC.RenderCtx, events: readonly CHAT.EventEnriched[], opts: TextOpts): string {
	const out: string[] = []
	for (const event of events) {
		const previous = opts.withMatchIds ? RC.setRowMatchId(event.matchId ?? undefined) : undefined
		let lines: Line[]
		try {
			lines = rowLines(createElement(Row, { ctx, event }))
		} finally {
			if (opts.withMatchIds) RC.setRowMatchId(previous)
		}
		lines.forEach((line, i) => {
			let text = i === 0 ? '' : '  '
			if (line.time !== undefined) text += `${formatDateTimeIn(line.time, opts.timeZone)} `
			text += line.text
			if (line.matchId !== undefined) text += ` ${I18n.ambient.text(CHAT_Msgs.matchSuffix(line.matchId))}`
			out.push(text)
		})
	}
	return out.join('\n')
}

/** Any inert template piece as one line of text, the way a row's line reads it: a layer's name, say. */
export function nodeText(node: ReactNode): string {
	return rowLines(node)
		.map((line) => line.text)
		.join(' ')
}

function rowLines(root: ReactNode): Line[] {
	const lines: Line[] = []
	let current: Line = { text: '' }
	// A block boundary only breaks the line once it has text: an EventLine's time and its text column are
	// sibling blocks of one line.
	const breakLine = () => {
		if (current.text.trim() === '') return
		lines.push(current)
		current = { text: '' }
	}
	const separate = () => {
		if (/\S$/.test(current.text)) current.text += ' '
	}
	// `gap` is set while walking the items of a gapped parent, and says whether one has been drawn yet: the gap only
	// goes between them. Fragments and components draw no box of their own, so the items are whatever they resolve to.
	type Gap = { started: boolean }
	const nextItem = (gap: Gap | null) => {
		if (!gap) return
		if (gap.started) separate()
		gap.started = true
	}
	const walk = (node: ReactNode, gap: Gap | null) => {
		if (node === null || node === undefined || typeof node === 'boolean' || node === '') return
		if (typeof node === 'string' || typeof node === 'number') {
			nextItem(gap)
			current.text += String(node)
			return
		}
		if (Array.isArray(node)) {
			for (const child of node) walk(child, gap)
			return
		}
		if (typeof node !== 'object' || !('type' in node)) return
		const element = node as ReactElement<Record<string, unknown>>
		const { type, props } = element
		if (type === Fragment) return walk(props.children as ReactNode, gap)
		if (typeof type === 'function') return walk((type as (props: unknown) => ReactNode)(props), gap)
		if (typeof type !== 'string') return
		// chrome rather than content: icons, copy buttons. The time and match id are read off their elements and
		// restated in full.
		if (props[RC.COPY_ATTR] !== undefined) return
		if (type === 'svg' || props.dangerouslySetInnerHTML !== undefined) {
			separate()
			return
		}
		const time = props[RC.TIP_TIME_ATTR]
		if (time !== undefined) {
			breakLine()
			current.time = Number(time)
			return
		}
		const matchId = props[RC.TIP_MATCH_ATTR]
		if (matchId !== undefined) {
			current.matchId = Number(matchId)
			return
		}
		const className = typeof props.className === 'string' ? props.className : ''
		const block = BLOCK_TAGS.has(type)
		if (block) breakLine()
		else {
			nextItem(gap)
			if (LEADING_MARGIN_CLASS.test(className)) separate()
		}
		walk(props.children as ReactNode, GAP_CLASS.test(className) ? { started: false } : null)
		if (block) breakLine()
		else if (TRAILING_MARGIN_CLASS.test(className)) separate()
	}
	walk(root, null)
	breakLine()
	for (const line of lines) line.text = line.text.replace(/\s+/g, ' ').trim()
	return lines
}
