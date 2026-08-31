import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import { SERVER_EVENT_TYPE } from '$root/drizzle/enums'
import { renderStatic } from '@/components/feed/static-render'
import HistoryAdvancedEditor, { LayerFilterPicker } from '@/components/history-advanced-editor'
import HistoryEvents from '@/components/history-events'
import * as HistoryTemplates from '@/components/history/templates'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import TabsList from '@/components/ui/tabs-list'
import * as HistoryFrame from '@/frames/history.frame'
import * as Zus from '@/lib/zustand'
import * as HistoryMsgs from '@/messages/history.messages'
import * as HQ from '@/models/history.models'
import type * as RPC from '@/orpc.client'
import { GlobalSettingsStore } from '@/systems/client-only-settings.client'
import * as HistoryClient from '@/systems/history.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'
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

export default function HistoryPage(props: HistoryPageProps) {
	const draft = Zus.useStore(props.stores.history, (s) => s.draft)
	const canRun = Zus.useStore(props.stores.history, HistoryFrame.Sel.canRun)
	const [saveOpen, setSaveOpen] = React.useState(false)

	const run = () => {
		const state = Zus.resolveStore<HistoryFrame.Store>(props.stores.history).getState()
		const query = HistoryFrame.Sel.builtQuery(state)
		HistoryClient.pushRecent(query)
		props.onRun(query)
	}

	const set = (patch: Partial<HQ.Query>) => HistoryFrame.Actions.setDraft(props.stores, patch)

	// a result-type switch is a view switch, so it runs immediately with the current draft
	const switchType = (type: HQ.ResultType) => {
		set({ type })
		const state = Zus.resolveStore<HistoryFrame.Store>(props.stores.history).getState()
		props.onRun({ ...HistoryFrame.Sel.builtQuery(state), type })
	}
	const executedKey = React.useMemo(() => JSON.stringify(props.executed), [props.executed])

	return (
		<div className="flex h-full min-h-0 flex-col gap-2 p-2">
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
				<TabsList
					options={[
						{ value: 'basic', label: tr.text(HistoryMsgs.modeBasic()) },
						{ value: 'advanced', label: tr.text(HistoryMsgs.modeAdvanced()) },
					]}
					active={draft.mode}
					setActive={(mode) => HistoryFrame.Actions.setMode(props.stores, mode)}
				/>
				<div className="grow" />
				<RecentMenu onRun={props.onRun} />
				<SavedMenu onRun={props.onRun} />
				<Button variant="outline" size="sm" onClick={() => setSaveOpen(true)}>
					{tr.text(HistoryMsgs.save())}
				</Button>
				<Button size="sm" disabled={!canRun} onClick={run}>
					{tr.text(HistoryMsgs.run())}
				</Button>
			</div>

			{/* keyed on the executed query so uncontrolled inputs remount when a new query loads via the url */}
			<div key={executedKey} className="flex flex-wrap items-end gap-2">
				<CommonFields stores={props.stores} draft={draft} set={set} />
				{draft.mode === 'basic' && <BasicFields draft={draft} set={set} />}
			</div>
			{draft.mode === 'advanced' && <HistoryAdvancedEditor stores={props.stores} />}

			<Results query={props.executed} onRun={props.onRun} />
			<SaveDialog stores={props.stores} open={saveOpen} onOpenChange={setSaveOpen} />
		</div>
	)
}

function Field(props: { label: string; children: React.ReactNode }) {
	return (
		<label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
			{props.label}
			{props.children}
		</label>
	)
}

function toDatetimeLocal(value: number | undefined): string {
	if (value === undefined) return ''
	return new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function CommonFields(props: { stores: HistoryFrame.KeyProp; draft: HQ.Query; set: (patch: Partial<HQ.Query>) => void }) {
	const { draft, set } = props
	const servers = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers)
	const ANY = '$any'
	return (
		<>
			<Field label={tr.text(HistoryMsgs.fieldServer())}>
				<Select value={draft.server ?? ANY} onValueChange={(v) => set({ server: v === ANY ? undefined : v })}>
					<SelectTrigger className="h-7 w-max text-xs">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ANY}>{tr.text(HistoryMsgs.anyOption())}</SelectItem>
						{servers?.map((server) => (
							<SelectItem key={server.id} value={server.id}>
								{server.displayName}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
			<Field label={tr.text(HistoryMsgs.fieldFrom())}>
				<Input
					type="datetime-local"
					className="h-7 w-max text-xs"
					defaultValue={toDatetimeLocal(draft.from)}
					onChange={(e) => set({ from: e.target.value === '' ? undefined : new Date(e.target.value).getTime() })}
				/>
			</Field>
			<Field label={tr.text(HistoryMsgs.fieldTo())}>
				<Input
					type="datetime-local"
					className="h-7 w-max text-xs"
					defaultValue={toDatetimeLocal(draft.to)}
					onChange={(e) => set({ to: e.target.value === '' ? undefined : new Date(e.target.value).getTime() })}
				/>
			</Field>
			<Field label={tr.text(HistoryMsgs.fieldPlayer())}>
				<Input
					className="h-7 w-52 text-xs"
					placeholder={tr.text(HistoryMsgs.playerPlaceholder())}
					defaultValue={draft.player ?? ''}
					onChange={(e) => set({ player: e.target.value || undefined })}
				/>
			</Field>
		</>
	)
}

function BasicFields(props: { draft: HQ.Query; set: (patch: Partial<HQ.Query>) => void }) {
	const { draft, set } = props
	const ANY = '$any'
	const types = draft.types ?? []
	return (
		<>
			{draft.type === 'events' && (
				<>
					<Field label={tr.text(HistoryMsgs.fieldEventTypes())}>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="outline" size="sm" className="h-7 max-w-56 truncate px-2 text-xs font-normal">
									{types.length > 0 ? types.join(', ') : tr.text(HistoryMsgs.anyOption())}
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent className="max-h-80 overflow-y-auto">
								{SERVER_EVENT_TYPE.options.map((type) => (
									<DropdownMenuCheckboxItem
										key={type}
										checked={types.includes(type)}
										onCheckedChange={(checked) => set({ types: checked ? [...types, type] : types.filter((t) => t !== type) })}
										onSelect={(e) => e.preventDefault()}
									>
										{type}
									</DropdownMenuCheckboxItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					</Field>
					<Field label={tr.text(HistoryMsgs.fieldVariant())}>
						<Select
							value={draft.variant ?? ANY}
							onValueChange={(v) => set({ variant: v === ANY ? undefined : (v as HQ.Query['variant']) })}
						>
							<SelectTrigger className="h-7 w-max text-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ANY}>{tr.text(HistoryMsgs.anyOption())}</SelectItem>
								{HQ.EVENT_VARIANTS.map((variant) => (
									<SelectItem key={variant} value={variant}>
										{variant}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					<Field label={tr.text(HistoryMsgs.fieldDamageSource())}>
						<Input
							className="h-7 w-40 text-xs"
							defaultValue={draft.damageSource ?? ''}
							onChange={(e) => set({ damageSource: e.target.value || undefined })}
						/>
					</Field>
					<Field label={tr.text(HistoryMsgs.fieldChat())}>
						<Input
							className="h-7 w-40 text-xs"
							defaultValue={draft.chat ?? ''}
							onChange={(e) => set({ chat: e.target.value || undefined })}
						/>
					</Field>
				</>
			)}
			{draft.type === 'players' && (
				<>
					<Field label={tr.text(HistoryMsgs.fieldName())}>
						<Input
							className="h-7 w-40 text-xs"
							defaultValue={draft.name ?? ''}
							onChange={(e) => set({ name: e.target.value || undefined })}
						/>
					</Field>
					<Field label={tr.text(HistoryMsgs.fieldMinMatches())}>
						<Input
							type="number"
							min={1}
							className="h-7 w-20 text-xs"
							defaultValue={draft.minMatches ?? ''}
							onChange={(e) => set({ minMatches: e.target.value === '' ? undefined : Number(e.target.value) })}
						/>
					</Field>
				</>
			)}
			{draft.type === 'matches' && (
				<>
					<Field label={tr.text(HistoryMsgs.fieldOutcome())}>
						<Select
							value={draft.outcome ?? ANY}
							onValueChange={(v) => set({ outcome: v === ANY ? undefined : (v as HQ.Query['outcome']) })}
						>
							<SelectTrigger className="h-7 w-max text-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ANY}>{tr.text(HistoryMsgs.anyOption())}</SelectItem>
								{HQ.MATCH_OUTCOMES.map((outcome) => (
									<SelectItem key={outcome} value={outcome}>
										{outcome}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					<Field label={tr.text(HistoryMsgs.fieldSetBy())}>
						<Select
							value={draft.setBy ?? ANY}
							onValueChange={(v) => set({ setBy: v === ANY ? undefined : (v as HQ.Query['setBy']) })}
						>
							<SelectTrigger className="h-7 w-max text-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ANY}>{tr.text(HistoryMsgs.anyOption())}</SelectItem>
								{HQ.SET_BY_TYPES.map((setBy) => (
									<SelectItem key={setBy} value={setBy}>
										{setBy}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
				</>
			)}
			<Field label={tr.text(HistoryMsgs.fieldLayer())}>
				<LayerFilterPicker
					value={draft.layer?.type === 'included-in' ? draft.layer.filterId : undefined}
					onSelect={(filterId) => set({ layer: filterId ? { type: 'included-in', filterId } : undefined })}
				/>
			</Field>
		</>
	)
}

// -------- results --------

function Results(props: { query: HQ.Query; onRun: (query: HQ.Query) => void }) {
	switch (props.query.type) {
		case 'events':
			return <HistoryEvents query={props.query} />
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
function DomRowsBody(props: { rows: React.ReactNode[] }) {
	const ref = React.useRef<HTMLTableSectionElement | null>(null)
	React.useLayoutEffect(() => {
		const body = ref.current
		if (!body) return
		body.replaceChildren(...props.rows.flatMap((row) => renderStatic(row) ?? []))
	})
	return <tbody ref={ref} />
}

const HEADER_CELL = 'px-2 py-1 text-left font-medium'

function PlayersResults(props: { query: HQ.Query; onRun: (query: HQ.Query) => void }) {
	const { res, page, setPage } = usePagedQuery(props.query)
	const ok = okOf(res, 'players')
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
				<table className="w-full border-collapse text-xs">
					<thead className="sticky top-0 bg-background text-muted-foreground">
						<tr className="border-b border-border">
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colPlayer())}</th>
							{sortHeader('matches', tr.text(HistoryMsgs.colMatches()))}
							{sortHeader('kills', tr.text(HistoryMsgs.colKills()))}
							{sortHeader('deaths', tr.text(HistoryMsgs.colDeaths()))}
							{sortHeader('teamkills', tr.text(HistoryMsgs.colTeamkills()))}
							{sortHeader('chatMessages', tr.text(HistoryMsgs.colChat()))}
							{sortHeader('lastSeen', tr.text(HistoryMsgs.colLastSeen()))}
						</tr>
					</thead>
					<DomRowsBody
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

function MatchesResults(props: { query: HQ.Query }) {
	const { res, page, setPage } = usePagedQuery(props.query)
	const ok = okOf(res, 'matches')
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, (s) => s.displayTeamsNormalized)

	return (
		<div className="flex min-h-0 flex-col gap-1">
			<ResultNotices res={res} />
			{ok && <div className="text-xs text-muted-foreground">{tr.text(HistoryMsgs.results(ok.total))}</div>}
			<div className="min-h-0 overflow-y-auto">
				<table className="w-full border-collapse text-xs">
					<thead className="sticky top-0 bg-background text-muted-foreground">
						<tr className="border-b border-border">
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colTime())}</th>
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colServer())}</th>
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colLayer())}</th>
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colOutcome())}</th>
							<th className={HEADER_CELL}>{tr.text(HistoryMsgs.colSetBy())}</th>
						</tr>
					</thead>
					<DomRowsBody
						rows={(ok?.matches ?? []).map((m) => (
							<HistoryTemplates.MatchRow key={m.historyEntryId} details={m} displayTeamsNormalized={displayTeamsNormalized} />
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
	if (query.server) parts.push(query.server)
	if (query.player) parts.push(query.player)
	if (query.chat) parts.push(`"${query.chat}"`)
	if (query.types && query.types.length > 0) parts.push(query.types.join(', '))
	if (query.mode === 'advanced') parts.push(tr.text(HistoryMsgs.modeAdvanced()).toLowerCase())
	return parts.join(' · ')
}

function SavedMenu(props: { onRun: (query: HQ.Query) => void }) {
	const saved = useQuery(HistoryClient.savedQueriesBase())
	const me = UsersClient.useLoggedInUser()
	const deleteQuery = HistoryClient.useDeleteSavedQuery()
	const setRetain = HistoryClient.useSetRetain()
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
							<button type="button" className="grow truncate text-left" onClick={() => props.onRun(query.query)}>
								<span className="font-medium">{query.name}</span>
								{!mine && query.ownerName && (
									<span className="ml-2 text-muted-foreground">{tr.text(HistoryMsgs.sharedBy(query.ownerName))}</span>
								)}
							</button>
							{query.query.type === 'events' && (
								<Switch
									checked={query.retain}
									title={tr.text(HistoryMsgs.retainResults())}
									onCheckedChange={(retain) => setRetain.mutate({ id: query.id, retain })}
								/>
							)}
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

function SaveDialog(props: { stores: HistoryFrame.KeyProp; open: boolean; onOpenChange: (open: boolean) => void }) {
	const save = HistoryClient.useSaveQuery()
	const [name, setName] = React.useState('')
	const [shared, setShared] = React.useState(false)

	const submit = () => {
		const state = Zus.resolveStore<HistoryFrame.Store>(props.stores.history).getState()
		save.mutate(
			{ name: name.trim(), visibility: shared ? 'shared' : 'private', query: HistoryFrame.Sel.builtQuery(state) },
			{ onSuccess: () => props.onOpenChange(false) },
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
