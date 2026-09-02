import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import * as RC from '@/components/feed/render-context'
import { renderStatic } from '@/components/feed/static-render'
import HistoryAdvancedEditor from '@/components/history-advanced-editor'
import HistoryEvents from '@/components/history-events'
import HistoryQueryBar, { HistoryQueryBounds } from '@/components/history-query-bar'
import * as HistoryTemplates from '@/components/history/templates'
import { useHistoryRenderCtx } from '@/components/history/use-history-render-ctx'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import TabsList from '@/components/ui/tabs-list'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as HistoryFrame from '@/frames/history.frame'
import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as HistoryMsgs from '@/messages/history.messages'
import * as I18n from '@/messages/i18n'
import * as HQ from '@/models/history.models'
import type * as MH from '@/models/match-history.models'
import * as RPC from '@/orpc.client'
import { GlobalSettingsStore } from '@/systems/client-only-settings.client'
import * as HistoryClient from '@/systems/history.client'
import { tr } from '@/systems/messages.client'
import * as UsersClient from '@/systems/users.client'

export type HistoryPageProps = {
	stores: HistoryFrame.KeyProp
	// the query the url holds, which is the one the results answer
	executed: HQ.Query
	onRun: (query: HQ.Query) => void
}

type QueryRes = Awaited<ReturnType<typeof RPC.orpc.history.query.call>>
type OkRes = Extract<QueryRes, { code: 'ok' }>

function okOf<T extends OkRes['type']>(res: QueryRes | undefined, type: T): Extract<OkRes, { type: T }> | undefined {
	return res && res.code === 'ok' && res.type === type ? (res as Extract<OkRes, { type: T }>) : undefined
}

// both modifiers run (see onKeyDown); this is only which one to show
const RUN_MODIFIER = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '\u2318' : 'Ctrl'

// the saved query the page is working on: what Save updates rather than duplicates
type SavedAs = { id: string; name: string; visibility: 'private' | 'shared' }

export default function HistoryPage(props: HistoryPageProps) {
	const draft = Zus.useStore(props.stores.history, (s) => s.draft)
	const canRun = Zus.useStore(props.stores.history, HistoryFrame.Sel.canRun)
	const [savedAs, setSavedAs] = React.useState<SavedAs | null>(null)
	// a query arriving from anywhere but the user's own editing is a different query, so it saves as its own
	const runFresh = (query: HQ.Query) => {
		setSavedAs(null)
		props.onRun(query)
	}

	const run = () => {
		const state = Zus.resolveStore<HistoryFrame.Store>(props.stores.history).getState()
		if (!HistoryFrame.Sel.canRun(state)) return
		const query = HistoryFrame.Sel.builtQuery(state)
		HistoryClient.pushRecent(query)
		props.onRun(query)
	}

	// Runs from anywhere on the page, which is why it listens on the document rather than on the page's own
	// element: nothing is focused after a load or a click on dead space, so the key event targets `body` and
	// never reaches a handler mounted inside the tree.
	const runRef = React.useRef(run)
	runRef.current = run
	React.useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return
			e.preventDefault()
			runRef.current()
		}
		document.addEventListener('keydown', onKeyDown)
		return () => document.removeEventListener('keydown', onKeyDown)
	}, [])

	const set = (patch: Partial<HQ.Query>) => HistoryFrame.Actions.setDraft(props.stores, patch)

	// a result-type switch is a view switch, so it runs immediately -- unless the draft cannot run, in which
	// case it is still a switch of what is being built, and the results say so rather than answering the
	// previous type (see canRun below)
	const switchType = (type: HQ.ResultType) => {
		set({ type })
		const state = Zus.resolveStore<HistoryFrame.Store>(props.stores.history).getState()
		if (!HistoryFrame.Sel.canRun(state)) return
		props.onRun({ ...HistoryFrame.Sel.builtQuery(state), type })
	}
	const executedKey = React.useMemo(() => JSON.stringify(props.executed), [props.executed])
	// a type switched while the draft could not run stays pending until Run catches the page up, so the
	// results never answer a type other than the one the tabs name
	const resultsPending = !canRun || props.executed.type !== draft.type

	// a button rather than a tab strip: the control has no fixed home (the rail it sits in does not exist in
	// advanced mode), and a tab strip that moves reads as two different controls. Labelled with the mode it
	// switches to, which is the only thing a one-shot toggle can usefully say.
	const target = draft.mode === 'basic' ? 'advanced' : 'basic'
	const modeToggle = (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button variant="outline" size="sm" onClick={() => HistoryFrame.Actions.setMode(props.stores, target)}>
					<Icons.SlidersHorizontal className="mr-1 h-3 w-3" />
					{tr.text(target === 'advanced' ? HistoryMsgs.modeAdvanced() : HistoryMsgs.modeBasic())}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{tr.text(target === 'advanced' ? HistoryMsgs.switchToAdvanced() : HistoryMsgs.switchToBasic())}</TooltipContent>
		</Tooltip>
	)
	const runButton = (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button size="sm" className="w-full" onClick={run}>
					{tr.text(HistoryMsgs.run())}
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				<KbdGroup>
					<Kbd>{RUN_MODIFIER}</Kbd>
					<Kbd>Enter</Kbd>
				</KbdGroup>
			</TooltipContent>
		</Tooltip>
	)

	return (
		// Basic mode builds in a rail, so the results keep the full height of the page: a query that grows
		// another field pushes the rail's own scroll rather than the result rows down. Advanced mode has no
		// rail at all -- the tree editor wants the width -- so what the rail carries is redistributed: its
		// buttons to the results toolbar, and the bounds above the editor, since those apply in both modes.
		// w-full: without it the row sizes to its content, so widening the rail grows the page instead of
		// taking the space from the results
		<div className="flex h-full min-h-0 w-full gap-2 p-2">
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<div className="flex flex-wrap items-center gap-2">
					<TabsList
						options={[
							{ value: 'events', label: tr.text(HistoryMsgs.tabEvents()) },
							{ value: 'players', label: tr.text(HistoryMsgs.tabPlayers()) },
							{ value: 'matches', label: tr.text(HistoryMsgs.tabMatches()) },
						]}
						active={draft.type}
						setActive={switchType}
					/>
					{draft.mode === 'advanced' && modeToggle}
					<div className="grow" />
					<RecentMenu onRun={runFresh} />
					<SavedMenu
						onRun={runFresh}
						onLoadOwn={(saved, query) => {
							setSavedAs(saved)
							props.onRun(query)
						}}
					/>
					<SaveControl stores={props.stores} savedAs={savedAs} setSavedAs={setSavedAs} />
					<CopyLinkButton />
					{draft.mode === 'advanced' && <span className="w-20">{runButton}</span>}
				</div>
				{draft.mode === 'advanced' && (
					<>
						<div key={executedKey}>
							<HistoryQueryBounds draft={draft} set={set} />
						</div>
						<HistoryAdvancedEditor stores={props.stores} />
					</>
				)}
				{/* the results answer the executed query, so they are shown only while it is the type the tabs name */}
				{resultsPending ? (
					<div className="text-xs text-muted-foreground">
						{tr.text(canRun ? HistoryMsgs.runToSeeResults() : HistoryMsgs.unfinishedFilter())}
					</div>
				) : (
					<Results query={props.executed} onRun={props.onRun} />
				)}
			</div>

			{draft.mode === 'basic' && (
				<RailResizer>
					<div className="flex items-center gap-2">
						{modeToggle}
						<span className="min-w-0 flex-1">{runButton}</span>
					</div>
					{/* keyed on the executed query so uncontrolled inputs remount when a new query loads via the url */}
					<div key={executedKey} className="min-h-0 flex-1 overflow-y-auto pr-1">
						<HistoryQueryBar draft={draft} set={set} />
					</div>
				</RailResizer>
			)}
		</div>
	)
}

/**
 * The builder rail, with a drag handle on its inner edge.
 *
 * Resizable because its contents are not: a layer id, a chat needle or a long field label all want more room
 * than any one default gives them, and the alternative is picking a width that clips one of them. The width
 * is per browser rather than per query, so it rides in localStorage rather than the url.
 *
 * Pointer capture rather than window listeners: the drag keeps receiving moves when the pointer leaves the
 * handle, and releases on its own if the gesture is cancelled.
 */
function RailResizer(props: { children: React.ReactNode }) {
	const [width, setWidth] = React.useState(HistoryClient.loadRailWidth)
	const dragFrom = React.useRef<{ x: number; width: number } | null>(null)

	return (
		<aside className="flex shrink-0 flex-col gap-2" style={{ width }}>
			<div className="flex min-h-0 flex-1 gap-2">
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label={tr.text(HistoryMsgs.resizeBuilder())}
					className="-ml-1 w-1.5 shrink-0 cursor-col-resize rounded-full bg-transparent transition-colors hover:bg-border"
					onPointerDown={(e) => {
						dragFrom.current = { x: e.clientX, width }
						e.currentTarget.setPointerCapture(e.pointerId)
					}}
					onPointerMove={(e) => {
						const from = dragFrom.current
						if (!from) return
						// the rail is on the right, so dragging left widens it
						const next = from.width + (from.x - e.clientX)
						setWidth(Math.min(HistoryClient.RAIL_WIDTH.max, Math.max(HistoryClient.RAIL_WIDTH.min, next)))
					}}
					onPointerUp={(e) => {
						dragFrom.current = null
						e.currentTarget.releasePointerCapture(e.pointerId)
						HistoryClient.saveRailWidth(width)
					}}
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-2 border-l pl-2">{props.children}</div>
			</div>
		</aside>
	)
}

function CopyLinkButton() {
	const [copied, setCopied] = React.useState(false)
	React.useEffect(() => {
		if (!copied) return
		const timer = setTimeout(() => setCopied(false), 1500)
		return () => clearTimeout(timer)
	}, [copied])
	return (
		<Button
			variant="ghost"
			size="icon"
			className="h-8 w-8"
			title={tr.text(copied ? HistoryMsgs.linkCopied() : HistoryMsgs.copyLink())}
			onClick={() => {
				void navigator.clipboard.writeText(window.location.href).then(() => setCopied(true))
			}}
		>
			{copied ? <Icons.Check className="h-4 w-4" /> : <Icons.Link className="h-4 w-4" />}
		</Button>
	)
}

// -------- results --------

function Results(props: { query: HQ.Query; onRun: (query: HQ.Query) => void }) {
	switch (props.query.type) {
		case 'events':
			return <HistoryEvents query={props.query} onReorder={(order) => props.onRun({ ...props.query, order })} />
		case 'players':
			return <PlayersResults query={props.query} onRun={props.onRun} />
		case 'matches':
			return <MatchesResults query={props.query} />
	}
}

function ResultNotices(props: { res: QueryRes | undefined }) {
	const res = props.res
	if (!res) return null
	if (res.code !== 'ok') {
		const message = 'message' in res && typeof res.message === 'string' ? `${res.code}: ${res.message}` : res.code
		return <div className="text-xs text-destructive">{tr.text(HistoryMsgs.queryFailed(message))}</div>
	}
	if (res.unrecognisedLayerMatches > 0) {
		return <div className="text-xs text-muted-foreground">{tr.text(HistoryMsgs.unrecognisedLayers(res.unrecognisedLayerMatches))}</div>
	}
	return null
}

function usePagedQuery(query: HQ.Query) {
	const key = React.useMemo(() => JSON.stringify(query), [query])
	const [page, setPageState] = React.useState<{ key: string; page: number }>({ key, page: 0 })
	if (page.key !== key) setPageState({ key, page: 0 })
	const res = useQuery(HistoryClient.queryPageBase({ query, page: page.page }))
	return { res: res.data, page: page.page, setPage: (next: number) => setPageState({ key, page: next }) }
}

function Pager(props: { page: number; pageSize: number; total: number | undefined; setPage: (page: number) => void }) {
	const total = props.total ?? 0
	const lastPage = Math.max(0, Math.ceil(total / props.pageSize) - 1)
	if (lastPage === 0) return null
	return (
		<div className="flex items-center gap-1 text-xs">
			<Button variant="ghost" size="icon" className="h-6 w-6" disabled={props.page === 0} onClick={() => props.setPage(props.page - 1)}>
				<Icons.ChevronLeft className="h-3 w-3" />
			</Button>
			<span className="tabular-nums">
				{props.page + 1}/{lastPage + 1}
			</span>
			<Button
				variant="ghost"
				size="icon"
				className="h-6 w-6"
				disabled={props.page >= lastPage}
				onClick={() => props.setPage(props.page + 1)}
			>
				<Icons.ChevronRight className="h-3 w-3" />
			</Button>
		</div>
	)
}

// rows are inert templates walked straight to dom (see static-render.ts)
function DomRowsBody(props: { rows: React.ReactNode[]; scopeId?: string }) {
	const ref = React.useRef<HTMLTableSectionElement | null>(null)
	React.useLayoutEffect(() => {
		const body = ref.current
		if (!body) return
		body.replaceChildren(...props.rows.flatMap((row) => renderStatic(row) ?? []))
	})
	// the scope lives on the body rather than around the table: a row's disclosure resolves it by walking up
	return <tbody ref={ref} {...(props.scopeId ? { [RC.SCOPE_ATTR]: props.scopeId } : {})} />
}

// The events behind one results row, fetched as rendered html and handed to the row's disclosure. The same
// query the results answered, narrowed to that row, so what opens is a subset of what was counted.
function useRowEvents(query: HQ.Query, matches: MH.MatchDetails[]) {
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, (s) => s.displayTeamsNormalized)
	const loadRowEvents = React.useCallback(
		async (key: string, cursor?: unknown) => {
			const separator = key.indexOf(':')
			const kind = key.slice(0, separator)
			const id = key.slice(separator + 1)
			const narrowed =
				kind === 'player' ? HQ.eventsForPlayer(query, id) : kind === 'match' ? HQ.eventsForMatch(query, Number(id)) : undefined
			if (!narrowed) return { rows: [] }
			const res = await RPC.queryClient.fetchQuery(
				HistoryClient.queryPageBase({
					query: narrowed,
					cursor: cursor as HistoryClient.QueryPageInput['cursor'],
					render: { displayTeamsNormalized, locale: I18n.getAmbientLocale() },
				}),
			)
			if (res.code !== 'ok' || res.type !== 'events') throw new Error(res.code)
			return { rows: res.rowsHtml, nextCursor: res.nextCursor }
		},
		[query, displayTeamsNormalized],
	)
	return useHistoryRenderCtx(matches, { loadRowEvents, serverId: HQ.soleServerId(query) })
}

const HEADER_CELL = 'px-2 py-1 text-left font-medium'

function PlayersResults(props: { query: HQ.Query; onRun: (query: HQ.Query) => void }) {
	const { res, page, setPage } = usePagedQuery(props.query)
	const ok = okOf(res, 'players')
	// a players page has no matches of its own, so a row's events resolve their server frame from nothing;
	// the rows they open still name their match, which is all the feed row needs
	const rowCtx = useRowEvents(props.query, EMPTY_MATCHES)
	const sort = props.query.sort ?? { column: 'matches' as const, dir: 'desc' as const }

	const sortHeader = (column: HQ.PlayerSortColumn, label: string) => (
		<th
			className={`${HEADER_CELL} cursor-pointer select-none text-right`}
			onClick={() =>
				props.onRun({ ...props.query, sort: { column, dir: sort.column === column && sort.dir === 'desc' ? 'asc' : 'desc' } })
			}
		>
			{label}
			{sort.column === column && (sort.dir === 'desc' ? ' ↓' : ' ↑')}
		</th>
	)

	return (
		<div className="flex min-h-0 flex-col gap-1">
			<ResultNotices res={res} />
			{ok && <div className="text-xs text-muted-foreground">{tr.text(HistoryMsgs.results(ok.total))}</div>}
			<div className="min-h-0 overflow-y-auto">
				<table aria-label={tr.text(HistoryMsgs.playerResults())} className="w-full border-collapse text-xs">
					<thead className="sticky top-0 bg-background text-muted-foreground">
						<tr className="border-b border-border">
							<th className={`${HEADER_CELL} w-6`} />
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colPlayer())}</th>
							{sortHeader('matches', tr.text(HistoryMsgs.colMatches()))}
							{sortHeader('kills', tr.text(HistoryMsgs.colKills()))}
							{sortHeader('deaths', tr.text(HistoryMsgs.colDeaths()))}
							{sortHeader('teamkills', tr.text(HistoryMsgs.colTeamkills()))}
							{sortHeader('chatMessages', tr.text(HistoryMsgs.colChat()))}
							{sortHeader('lastSeen', tr.text(HistoryMsgs.colLastSeen()))}
							<th className={`${HEADER_CELL} text-right`}>{tr.text(HistoryMsgs.colEvents())}</th>
						</tr>
					</thead>
					<DomRowsBody
						scopeId={rowCtx.scopeId}
						rows={(ok?.rows ?? []).map((row) => (
							<HistoryTemplates.PlayerRow key={row.playerId} row={row} />
						))}
					/>
				</table>
			</div>
			<Pager page={page} pageSize={HQ.PAGE_SIZES.players} total={ok?.total} setPage={setPage} />
		</div>
	)
}

const EMPTY_MATCHES: MH.MatchDetails[] = []

function MatchesResults(props: { query: HQ.Query }) {
	const { res, page, setPage } = usePagedQuery(props.query)
	const ok = okOf(res, 'matches')
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, (s) => s.displayTeamsNormalized)
	const rowCtx = useRowEvents(props.query, ok?.matches ?? EMPTY_MATCHES)

	return (
		<div className="flex min-h-0 flex-col gap-1">
			<ResultNotices res={res} />
			{ok && <div className="text-xs text-muted-foreground">{tr.text(HistoryMsgs.results(ok.total))}</div>}
			<div className="min-h-0 overflow-y-auto">
				<table aria-label={tr.text(HistoryMsgs.matchResults())} className="w-full border-collapse text-xs">
					<thead className="sticky top-0 bg-background text-muted-foreground">
						<tr className="border-b border-border">
							<th className={`${HEADER_CELL} w-6`} />
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colTime())}</th>
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colServer())}</th>
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colLayer())}</th>
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colOutcome())}</th>
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colTicketDiff())}</th>
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colDuration())}</th>
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colSetBy())}</th>
							<th className={`${HEADER_CELL} text-right`}>{tr.text(HistoryMsgs.colEvents())}</th>
						</tr>
					</thead>
					<DomRowsBody
						scopeId={rowCtx.scopeId}
						rows={(ok?.matches ?? []).map((m) => (
							<HistoryTemplates.MatchRow
								key={m.historyEntryId}
								details={m}
								displayTeamsNormalized={displayTeamsNormalized}
								events={ok?.eventCounts[m.historyEntryId] ?? 0}
							/>
						))}
					/>
				</table>
			</div>
			<Pager page={page} pageSize={HQ.PAGE_SIZES.matches} total={ok?.total} setPage={setPage} />
		</div>
	)
}

// -------- saved and recent queries --------

function RecentMenu(props: { onRun: (query: HQ.Query) => void }) {
	const [recents, setRecents] = React.useState<HistoryClient.Recent[]>([])
	return (
		<DropdownMenu onOpenChange={(open) => open && setRecents(HistoryClient.loadRecents())}>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="sm">
					{tr.text(HistoryMsgs.recentQueries())}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="max-h-80 overflow-y-auto">
				{recents.length === 0 && (
					<div className="px-2 py-1 text-xs text-muted-foreground">{tr.text(HistoryMsgs.noRecentQueries())}</div>
				)}
				{recents.map((recent, i) => (
					<button
						key={i}
						type="button"
						className="block w-full max-w-96 truncate px-2 py-1 text-left text-xs hover:bg-accent"
						onClick={() => props.onRun(recent.query)}
					>
						{describeQuery(recent.query)}
					</button>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function describeQuery(query: HQ.Query): string {
	const parts: string[] = [query.type]
	if (query.servers?.length) parts.push(query.servers.join(', '))
	if (query.players?.length) parts.push(query.players.join(', '))
	if (query.chat) parts.push(`"${query.chat}"`)
	if (query.types && query.types.length > 0) parts.push(query.types.join(', '))
	for (const part of [query.map, query.gamemode, query.faction]) {
		if (part) parts.push(part)
	}
	if (query.mode === 'advanced') parts.push(tr.text(HistoryMsgs.modeAdvanced()).toLowerCase())
	return parts.join(' · ')
}

function SavedMenu(props: { onRun: (query: HQ.Query) => void; onLoadOwn: (saved: SavedAs, query: HQ.Query) => void }) {
	const saved = useQuery(HistoryClient.savedQueriesBase())
	const me = UsersClient.useLoggedInUser()
	const deleteQuery = HistoryClient.useDeleteSavedQuery()
	const queries = saved.data?.code === 'ok' ? saved.data.queries : []

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="sm">
					{tr.text(HistoryMsgs.savedQueries())}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="max-h-96 overflow-y-auto">
				{queries.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">{tr.text(HistoryMsgs.noSavedQueries())}</div>}
				{queries.map((query) => {
					const mine = me !== undefined && query.ownerId === me.discordId
					return (
						<div key={query.id} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-accent">
							<button
								type="button"
								className="grow truncate text-left"
								onClick={() =>
									mine
										? props.onLoadOwn({ id: query.id, name: query.name, visibility: query.visibility }, query.query)
										: props.onRun(query.query)
								}
							>
								<span className="font-medium">{query.name}</span>
								{!mine && query.ownerName && (
									<span className="ml-2 text-muted-foreground">{tr.text(HistoryMsgs.sharedBy(query.ownerName))}</span>
								)}
							</button>
							{mine && (
								<Button
									variant="ghost"
									size="icon"
									className="h-5 w-5"
									title={tr.text(HistoryMsgs.deleteQuery())}
									onClick={() => deleteQuery.mutate({ id: query.id })}
								>
									<Icons.Trash2 className="h-3 w-3" />
								</Button>
							)}
						</div>
					)
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

/**
 * Save, as a split button once the page is working on a saved query the user owns.
 *
 * The association is the page's, not the url's: a saved query loads by navigating, so nothing distinguishes
 * it from any other query once it has loaded, and a reload starts over on plain Save.
 */
function SaveControl(props: { stores: HistoryFrame.KeyProp; savedAs: SavedAs | null; setSavedAs: (saved: SavedAs | null) => void }) {
	const save = HistoryClient.useSaveQuery()
	const [dialogOpen, setDialogOpen] = React.useState(false)
	const savedAs = props.savedAs

	const update = () => {
		if (!savedAs) return
		const state = Zus.resolveStore<HistoryFrame.Store>(props.stores.history).getState()
		save.mutate(
			{ id: savedAs.id, name: savedAs.name, visibility: savedAs.visibility, query: HistoryFrame.Sel.builtQuery(state) },
			{
				onSuccess: (res) => {
					if (res.code !== 'ok') {
						// gone or no longer ours: fall back to plain Save rather than leaving a button that cannot work
						props.setSavedAs(null)
						toast.error(...tr.toast(HistoryMsgs.saveFailed(res.code)))
						return
					}
					toast(...tr.toast(HistoryMsgs.queryUpdated(savedAs.name)))
				},
			},
		)
	}

	return (
		<>
			{savedAs ? (
				<ButtonGroup>
					<Button
						variant="outline"
						size="sm"
						disabled={save.isPending}
						onClick={update}
						title={tr.text(HistoryMsgs.updateQuery(savedAs.name))}
					>
						{tr.text(HistoryMsgs.update())}
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline" size="sm" className="px-1" aria-label={tr.text(HistoryMsgs.moreSaveOptions())}>
								<Icons.ChevronDown className="h-3 w-3" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onSelect={() => setDialogOpen(true)}>{tr.text(HistoryMsgs.saveAsNew())}</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</ButtonGroup>
			) : (
				<Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
					{tr.text(HistoryMsgs.save())}
				</Button>
			)}
			<SaveDialog stores={props.stores} open={dialogOpen} onOpenChange={setDialogOpen} onSaved={props.setSavedAs} />
		</>
	)
}

function SaveDialog(props: {
	stores: HistoryFrame.KeyProp
	open: boolean
	onOpenChange: (open: boolean) => void
	onSaved: (saved: SavedAs) => void
}) {
	const save = HistoryClient.useSaveQuery()
	const [name, setName] = React.useState('')
	const [shared, setShared] = React.useState(false)

	const submit = () => {
		const state = Zus.resolveStore<HistoryFrame.Store>(props.stores.history).getState()
		const visibility = shared ? 'shared' : ('private' as const)
		save.mutate(
			{ name: name.trim(), visibility, query: HistoryFrame.Sel.builtQuery(state) },
			{
				onSuccess: (res) => {
					if (res.code !== 'ok') {
						toast.error(...tr.toast(HistoryMsgs.saveFailed(res.code)))
						return
					}
					// the new query is now the one the page is working on, so the next save updates it
					props.onSaved({ id: res.id, name: name.trim(), visibility })
					props.onOpenChange(false)
				},
			},
		)
	}

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>{tr.text(HistoryMsgs.saveDialogTitle())}</DialogTitle>
				</DialogHeader>
				<Input placeholder={tr.text(HistoryMsgs.queryName())} defaultValue="" onChange={(e) => setName(e.target.value)} />
				<label className="flex items-center gap-2 text-xs">
					<Switch checked={shared} onCheckedChange={setShared} />
					{tr.text(HistoryMsgs.visibilityShared())}
				</label>
				<DialogFooter>
					<Button size="sm" disabled={name.trim() === '' || save.isPending} onClick={submit}>
						{tr.text(HistoryMsgs.save())}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
