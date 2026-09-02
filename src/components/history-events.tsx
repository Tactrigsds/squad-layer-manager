import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import * as RC from '@/components/feed/render-context'
import { useHistoryRenderCtx } from '@/components/history/use-history-render-ctx'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import * as Zus from '@/lib/zustand'
import * as HistoryMsgs from '@/messages/history.messages'
import * as I18n from '@/messages/i18n'
import * as HQ from '@/models/history.models'
import type * as MH from '@/models/match-history.models'
import * as RPC from '@/orpc.client'
import { GlobalSettingsStore } from '@/systems/client-only-settings.client'
import * as HistoryClient from '@/systems/history.client'
import { tr } from '@/systems/messages.client'

// An events result feed: server-rendered rows accumulated in the dom, newest first, paging backwards on
// demand. Used by the history page and by the frameless player-details window.

type QueryRes = Awaited<ReturnType<typeof RPC.orpc.history.query.call>>
type EventsPage = Extract<QueryRes, { code: 'ok'; type: 'events' }>

export default function HistoryEvents(props: {
	query: HQ.Query
	showTotal?: boolean
	className?: string
	// re-runs the query from the other end of the range. Omitted where the caller has no way to run one (the
	// player details window shows a fixed slice), which is also what hides the control.
	onReorder?: (order: 'newest' | 'oldest') => void
}) {
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
			<div className="flex items-center gap-2">
				{(props.showTotal ?? true) && total !== undefined && (
					<div className="text-xs text-muted-foreground">{tr.text(HistoryMsgs.results(total))}</div>
				)}
				{props.onReorder && <OrderToggle order={props.query.order ?? 'newest'} onReorder={props.onReorder} />}
			</div>
			{first.data?.code === 'ok' && rows.length === 0 && (
				<div className="text-xs text-muted-foreground">{tr.text(HistoryMsgs.noResults())}</div>
			)}
			{first.isPending && (
				<div className="flex items-center justify-center py-8">
					<Spinner className="size-5 text-muted-foreground" />
				</div>
			)}
			<div className="min-h-0 overflow-y-auto" hidden={first.isPending}>
				<SsrRows rows={rows} matches={matches} serverId={HQ.soleServerId(props.query)} />
				{nextCursor && (
					<Button variant="outline" size="sm" className="my-2" disabled={loadingMore} onClick={() => void loadMore()}>
						{tr.text(HistoryMsgs.loadMore())}
					</Button>
				)}
			</div>
		</div>
	)
}

// Labelled with the order in effect rather than the one it switches to: unlike a mode switch, this reads as
// a description of what is on screen, and the arrow says which way it runs.
function OrderToggle(props: { order: 'newest' | 'oldest'; onReorder: (order: 'newest' | 'oldest') => void }) {
	const newest = props.order === 'newest'
	return (
		<Button
			variant="ghost"
			size="sm"
			className="h-6 px-2 text-xs font-normal text-muted-foreground"
			onClick={() => props.onReorder(newest ? 'oldest' : 'newest')}
		>
			{newest ? <Icons.ArrowDown className="mr-1 h-3 w-3" /> : <Icons.ArrowUp className="mr-1 h-3 w-3" />}
			{tr.text(newest ? HistoryMsgs.orderNewest() : HistoryMsgs.orderOldest())}
		</Button>
	)
}

// All rows live in the dom at once, deliberately: content-visibility keeps offscreen ones unrendered, so
// appending a page costs its parse and nothing else. Append-only between resets, so open disclosures and
// scroll position survive loading more.
function SsrRows(props: { rows: string[]; matches: MH.MatchDetails[]; serverId?: string }) {
	const ctx = useHistoryRenderCtx(props.matches, { serverId: props.serverId })
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
			role="region"
			aria-label={tr.text(HistoryMsgs.eventResults())}
			{...{ [RC.SCOPE_ATTR]: ctx.scopeId }}
			className="flex flex-col [&>*]:[content-visibility:auto] [&>*]:[contain-intrinsic-size:auto_29px]"
		/>
	)
}
