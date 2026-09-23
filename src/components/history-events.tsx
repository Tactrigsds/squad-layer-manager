import { useIsFetching, useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import { localTimeZone } from '@/components/feed/format'
import * as RC from '@/components/feed/render-context'
import * as Selection from '@/components/feed/selection'
import { useHistoryRenderCtx } from '@/components/history/use-history-render-ctx'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import * as Zus from '@/lib/zustand'
import * as HistoryMsgs from '@/messages/history.messages'
import * as I18n from '@/messages/i18n'
import * as HQ from '@/models/history.models'
import * as RPC from '@/orpc.client'
import { GlobalSettingsStore } from '@/systems/client-only-settings.client'
import * as HistoryClient from '@/systems/history.client'
import { tr } from '@/systems/messages.client'

// An events result feed: server-rendered rows accumulated in the dom, newest first, paging backwards on
// demand. Used by the history page and by the frameless player-details window.

type QueryRes = Awaited<ReturnType<typeof RPC.orpc.history.query.call>>
type EventsPage = Extract<QueryRes, { code: 'ok'; type: 'events' }>

type ExtraPages = { key: string; pages: EventsPage[] }

const NO_NEXT_PAGE = ['history-events', 'no-next-page']
const NO_PAGES: EventsPage[] = []

export default function HistoryEvents(props: {
	query: HQ.Query
	showTotal?: boolean
	className?: string
	// re-runs the query from the other end of the range. Omitted where the caller has no way to run one (the
	// player details window shows a fixed slice), which is also what hides the control.
	onReorder?: (order: 'newest' | 'oldest') => void
	// The selection, held by the caller (the history page keeps it in the url). A value that arrives from
	// outside, rather than from a drag here, is loaded and scrolled to. Omitted, the rows still select, but nothing
	// outside knows.
	selection?: {
		value: HQ.RowSelectionParam | undefined
		onChange: (selection: HQ.RowSelectionParam | undefined) => void
	}
	// offers a link to selected rows, as `query` on the history page
	linkable?: boolean
}) {
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, (s) => s.displayTeamsNormalized)
	const render = React.useMemo(() => ({ displayTeamsNormalized, locale: I18n.getAmbientLocale() }), [displayTeamsNormalized])

	const key = React.useMemo(() => JSON.stringify([props.query, render]), [props.query, render])
	// the pages past the first, which "load more" and a reveal both append to from outside a render
	const [extraStore] = React.useState(() => Zus.createStore<ExtraPages>(() => ({ key, pages: [] })))
	const extraPages = Zus.useStore(extraStore, (s) => (s.key === key ? s.pages : NO_PAGES))
	React.useLayoutEffect(() => {
		if (extraStore.getState().key !== key) extraStore.setState({ key, pages: [] })
	}, [extraStore, key])
	const first = useQuery(HistoryClient.queryPageBase({ query: props.query, render, includeMatchBoundaries: true }))

	const okPages = React.useMemo(() => {
		const pages: EventsPage[] = []
		for (const page of [first.data, ...extraPages]) {
			if (page && page.code === 'ok' && page.type === 'events') pages.push(page)
		}
		return pages
	}, [first.data, extraPages])

	const rows = React.useMemo(() => okPages.flatMap((page) => page.rowsHtml), [okPages])
	const matches = React.useMemo(() => okPages.flatMap((page) => page.matches), [okPages])
	const nextCursor = okPages.at(-1)?.nextCursor
	const total = okPages[0]?.total
	const failure = HistoryClient.queryFailure(first.data, first.error)

	// in flight for as long as react-query says the next page is, which also makes a second call while it is a
	// no-op: fetchQuery hands back the same request
	const nextPage = nextCursor
		? HistoryClient.queryPageBase({ query: props.query, cursor: nextCursor, render, includeMatchBoundaries: true })
		: undefined
	const loadingMore = useIsFetching({ queryKey: nextPage?.queryKey ?? NO_NEXT_PAGE, exact: true }) > 0
	const loadMore = async () => {
		if (!nextPage) return
		const res = await RPC.queryClient.fetchQuery(nextPage)
		const prev = extraStore.getState()
		// a response to a cursor already appended (two callers asked for the same page) or to a query since replaced
		if (res.code !== 'ok' || prev.key !== key || prev.pages.includes(res as EventsPage)) return
		extraStore.setState({ key, pages: [...prev.pages, res as EventsPage] })
	}

	const linkToRows = HistoryClient.useRowsLink(() => ({ query: props.query }))
	// the server's, since the rows here arrived as markup with no events behind them
	const selectionText = React.useCallback(
		async (selection: RC.RowSelection) => {
			const res = await RPC.orpc.history.selectionText.call({
				query: props.query,
				sel: [selection.anchor, selection.head],
				render,
				timeZone: localTimeZone(),
			})
			return res.code === 'ok' ? { text: res.text, count: res.count } : undefined
		},
		[props.query, render],
	)
	const hostRef = React.useRef<HTMLDivElement | null>(null)
	const ctx = useHistoryRenderCtx(matches, {
		serverId: HQ.soleServerId(props.query),
		linkToRows: props.linkable ? linkToRows : undefined,
		selectionText,
	})
	// A selection that arrived from the caller rather than from a drag here, until it has been scrolled to. A ref
	// rather than state: it only ever changes alongside a render that happens anyway (the prop arriving, a page of
	// rows landing), which is when the effect below reads it.
	const reveal = React.useRef<RC.RowSelection | null>(null)
	const parkReveal = React.useCallback((selection: RC.RowSelection | null) => {
		reveal.current = selection
	}, [])
	useSyncedSelection(ctx.scopeId, props.selection, parkReveal)

	// A selection from outside may end past the pages loaded so far, so pages load until both of its ends are
	// in, and then the first selected row is scrolled to. Bounded, since an end that is not in the results at
	// all (a link to rows the query no longer matches) would otherwise page through all of them.
	React.useEffect(() => {
		const host = hostRef.current
		if (!reveal.current || !host || first.isPending) return
		const selected = Selection.selectedRows(host, reveal.current)
		if (selected.length > 0) {
			reveal.current = null
			Selection.revealRow(selected[0])
			return
		}
		if (nextPage && okPages.length < REVEAL_MAX_PAGES) {
			void loadMore()
			return
		}
		reveal.current = null
	})

	return (
		<div className={props.className ?? 'flex min-h-0 flex-col gap-1'}>
			{failure && <div className="text-xs text-destructive">{tr.text(HistoryMsgs.queryFailed(failure))}</div>}
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
				<SsrRows rows={rows} ctx={ctx} hostRef={hostRef} />
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
function SsrRows(props: { rows: string[]; ctx: RC.RenderCtx; hostRef: React.RefObject<HTMLDivElement | null> }) {
	const hostRef = props.hostRef
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
		Selection.paint(host)
	}, [props.rows, hostRef])

	return (
		<div
			ref={hostRef}
			role="region"
			aria-label={tr.text(HistoryMsgs.eventResults())}
			{...{ [RC.SCOPE_ATTR]: props.ctx.scopeId, [RC.SELECTABLE_ATTR]: props.ctx.scopeId }}
			className={`flex flex-col [&>*]:[content-visibility:auto] [&>*]:[contain-intrinsic-size:auto_29px] ${Selection.HOST_CLASS}`}
		/>
	)
}

const REVEAL_MAX_PAGES = 20

/**
 * Keeps a scope's selection and the caller's copy of it in step, both ways. A selection that arrives from the
 * caller is handed to `onArrived`.
 */
function useSyncedSelection(
	scopeId: string,
	selection: Parameters<typeof HistoryEvents>[0]['selection'],
	onArrived: (selection: RC.RowSelection | null) => void,
) {
	const value = selection?.value
	const anchor = value?.[0]
	const head = value?.[1]

	React.useLayoutEffect(() => {
		const current = Selection.get(scopeId)
		if (current?.anchor === anchor && current?.head === head) return
		const next = anchor !== undefined && head !== undefined ? { anchor, head } : undefined
		Selection.set(scopeId, next)
		onArrived(next ?? null)
	}, [scopeId, anchor, head, onArrived])

	const onChangeRef = React.useRef(selection?.onChange)
	onChangeRef.current = selection?.onChange
	const valueRef = React.useRef(value)
	valueRef.current = value
	React.useEffect(
		() =>
			Selection.SelectionStore.subscribe((state, prev) => {
				const next = state.byHost[scopeId]
				if (next === prev.byHost[scopeId]) return
				const known = valueRef.current
				if (known?.[0] === next?.anchor && known?.[1] === next?.head) return
				onChangeRef.current?.(next ? [next.anchor, next.head] : undefined)
			}),
		[scopeId],
	)

	// the scope outlives its selection
	React.useEffect(() => () => Selection.set(scopeId, undefined), [scopeId])
}
