import { useQuery } from '@tanstack/react-query'
import React from 'react'

import * as RC from '@/components/feed/render-context'
import { useHistoryRenderCtx } from '@/components/history/use-history-render-ctx'
import { Button } from '@/components/ui/button'
import * as Zus from '@/lib/zustand'
import * as HistoryMsgs from '@/messages/history.messages'
import * as I18n from '@/messages/i18n'
import type * as HQ from '@/models/history.models'
import type * as MH from '@/models/match-history.models'
import * as RPC from '@/orpc.client'
import { GlobalSettingsStore } from '@/systems/client-only-settings.client'
import * as HistoryClient from '@/systems/history.client'
import { tr } from '@/systems/messages.client'

// An events result feed: server-rendered rows accumulated in the dom, newest first, paging backwards on
// demand. Used by the history page and by the frameless player-details window.

type QueryRes = Awaited<ReturnType<typeof RPC.orpc.history.query.call>>
type EventsPage = Extract<QueryRes, { code: 'ok'; type: 'events' }>

export default function HistoryEvents(props: { query: HQ.Query; showTotal?: boolean; className?: string }) {
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, (s) => s.displayTeamsNormalized)
	const render = React.useMemo(() => ({ displayTeamsNormalized, locale: I18n.getAmbientLocale() }), [displayTeamsNormalized])

	const key = React.useMemo(() => JSON.stringify([props.query, render]), [props.query, render])
	const [extra, setExtra] = React.useState<{ key: string; pages: EventsPage[] }>({ key, pages: [] })
	if (extra.key !== key) setExtra({ key, pages: [] })
	const first = useQuery(HistoryClient.queryPageBase({ query: props.query, render, includeMatchBoundaries: true }))

	const okPages = React.useMemo(() => {
		const pages: EventsPage[] = []
		for (const page of [first.data, ...extra.pages]) {
			if (page && page.code === 'ok' && page.type === 'events') pages.push(page)
		}
		return pages
	}, [first.data, extra.pages])

	const rows = React.useMemo(() => okPages.flatMap((page) => page.rowsHtml), [okPages])
	const matches = React.useMemo(() => okPages.flatMap((page) => page.matches), [okPages])
	const nextCursor = okPages.at(-1)?.nextCursor
	const total = okPages[0]?.total
	const failure = first.data && first.data.code !== 'ok' ? first.data : undefined

	const [loadingMore, setLoadingMore] = React.useState(false)
	const loadMore = async () => {
		if (!nextCursor) return
		setLoadingMore(true)
		try {
			const res = await RPC.queryClient.fetchQuery(
				HistoryClient.queryPageBase({ query: props.query, cursor: nextCursor, render, includeMatchBoundaries: true }),
			)
			setExtra((prev) => (prev.key === key && res.code === 'ok' ? { key, pages: [...prev.pages, res as EventsPage] } : prev))
		} finally {
			setLoadingMore(false)
		}
	}

	return (
		<div className={props.className ?? 'flex min-h-0 flex-col gap-1'}>
			{failure && (
				<div className="text-xs text-destructive">
					{tr.text(
						HistoryMsgs.queryFailed(
							'message' in failure && typeof failure.message === 'string' ? `${failure.code}: ${failure.message}` : failure.code,
						),
					)}
				</div>
			)}
			{first.data?.code === 'ok' && first.data.unrecognisedLayerMatches > 0 && (
				<div className="text-xs text-muted-foreground">
					{tr.text(HistoryMsgs.unrecognisedLayers(first.data.unrecognisedLayerMatches))}
				</div>
			)}
			{(props.showTotal ?? true) && total !== undefined && (
				<div className="text-xs text-muted-foreground">{tr.text(HistoryMsgs.results(total))}</div>
			)}
			{first.data?.code === 'ok' && rows.length === 0 && (
				<div className="text-xs text-muted-foreground">{tr.text(HistoryMsgs.noResults())}</div>
			)}
			<div className="min-h-0 overflow-y-auto">
				<SsrRows rows={rows} matches={matches} />
				{nextCursor && (
					<Button variant="outline" size="sm" className="my-2" disabled={loadingMore} onClick={() => void loadMore()}>
						{tr.text(HistoryMsgs.loadMore())}
					</Button>
				)}
			</div>
		</div>
	)
}

// All rows live in the dom at once, deliberately: content-visibility keeps offscreen ones unrendered, so
// appending a page costs its parse and nothing else. Append-only between resets, so open disclosures and
// scroll position survive loading more.
function SsrRows(props: { rows: string[]; matches: MH.MatchDetails[] }) {
	const ctx = useHistoryRenderCtx(props.matches)
	const hostRef = React.useRef<HTMLDivElement | null>(null)
	const renderedRef = React.useRef<{ count: number; first: string | undefined }>({ count: 0, first: undefined })

	React.useLayoutEffect(() => {
		const host = hostRef.current
		if (!host) return
		const rendered = renderedRef.current
		if (props.rows.length < rendered.count || (rendered.count > 0 && props.rows[0] !== rendered.first)) {
			host.replaceChildren()
			rendered.count = 0
		}
		if (props.rows.length > rendered.count) {
			host.insertAdjacentHTML('beforeend', props.rows.slice(rendered.count).join(''))
			rendered.count = props.rows.length
		}
		rendered.first = props.rows[0]
	}, [props.rows])

	return (
		<div
			ref={hostRef}
			{...{ [RC.SCOPE_ATTR]: ctx.scopeId }}
			className="flex flex-col [&>*]:[content-visibility:auto] [&>*]:[contain-intrinsic-size:auto_29px]"
		/>
	)
}
