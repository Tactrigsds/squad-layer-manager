import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import ComboBox from '@/components/combo-box/combo-box'
import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { LOADING } from '@/components/combo-box/constants'
import { LayerFilterPicker } from '@/components/history-advanced-editor'
import * as QF from '@/components/history/query-fields'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as HistoryMsgs from '@/messages/history.messages'
import type * as HQ from '@/models/history.models'
import * as L from '@/models/layer'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as HistoryClient from '@/systems/history.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

// The query builder's rail: a scope block every query has (server, time, player, user), then the optional
// fields for the current result type, then a "+ Filter" menu offering the rest.
//
// Which optional fields are listed is the result type's default set, plus anything currently set. A set
// field stays listed after a type switch because the filter itself carries across: the results answer with
// it applied, so the rail has to keep admitting to it.

type Set = (patch: Partial<HQ.Query>) => void

const ANY = '$any'

export default function HistoryQueryBar(props: { draft: HQ.Query; set: Set }) {
	const { draft, set } = props
	// fields "+ Filter" has added that hold no value yet, so nothing else can infer they should be listed
	const [extra, setExtra] = React.useState<readonly QF.FieldKey[]>([])
	const groups = QF.visibleFields(draft, extra)
	const shown = groups.flatMap((g) => g.fields.map((f) => f.key))

	return (
		<div className="flex flex-col gap-3">
			<ScopeBlock draft={draft} set={set} />
			{groups.map((group) => (
				<section key={group.group} className="flex flex-col gap-1">
					<GroupHeading>{groupLabel(group.group)}</GroupHeading>
					{group.fields.map((field) => (
						<FieldRow
							key={field.key}
							field={field}
							draft={draft}
							set={set}
							onRemove={() => setExtra((prev) => prev.filter((k) => k !== field.key))}
						/>
					))}
				</section>
			))}
			<AddFilterMenu draft={draft} shown={shown} onPick={(key) => setExtra((prev) => [...prev, key])} />
		</div>
	)
}

function GroupHeading(props: { children: React.ReactNode }) {
	return <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{props.children}</h3>
}

// -------- scope --------

function ScopeBlock(props: { draft: HQ.Query; set: Set }) {
	const { draft, set } = props
	return (
		<section className="flex flex-col gap-1">
			<GroupHeading>{tr.text(HistoryMsgs.groupScope())}</GroupHeading>
			<Field label={tr.text(HistoryMsgs.fieldServer())}>
				<ServerSelect draft={draft} set={set} />
			</Field>
			<Field label={tr.text(HistoryMsgs.fieldTime())}>
				<TimeRange draft={draft} set={set} />
			</Field>
			<Field label={tr.text(HistoryMsgs.fieldPlayer())}>
				<PlayerPicker value={draft.player} onSelect={(player) => set({ player })} />
			</Field>
			<Field label={tr.text(HistoryMsgs.fieldUser())}>
				<UserPicker value={draft.user} onSelect={(user) => set({ user })} />
			</Field>
		</section>
	)
}

/**
 * The bounds alone, for advanced mode, which has no rail to carry the scope block.
 *
 * Server and time only: they are applied outside the tree, so they mean the same thing in either mode, where
 * the rest of the scope block is basic-mode fields the tree replaces (see queryFilterNode). Showing those
 * here would offer a control the query then ignores.
 */
export function HistoryQueryBounds(props: { draft: HQ.Query; set: Set }) {
	const { draft, set } = props
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
			<Field className="w-56" label={tr.text(HistoryMsgs.fieldServer())}>
				<ServerSelect draft={draft} set={set} />
			</Field>
			<Field className="w-max" label={tr.text(HistoryMsgs.fieldTime())}>
				<TimeRange draft={draft} set={set} />
			</Field>
		</div>
	)
}

function ServerSelect(props: { draft: HQ.Query; set: Set }) {
	const servers = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers)
	return (
		<Select value={props.draft.server ?? ANY} onValueChange={(v) => props.set({ server: v === ANY ? undefined : v })}>
			<SelectTrigger className="h-7 w-full text-xs">
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
	)
}

function Field(props: { label: string; className?: string; children: React.ReactNode }) {
	return (
		<label className={cn('flex items-center gap-2 text-xs text-muted-foreground', props.className)}>
			<span className="w-16 shrink-0 truncate">{props.label}</span>
			<span className="min-w-0 flex-1">{props.children}</span>
		</label>
	)
}

const PRESETS = [
	{ key: '24h', ms: 24 * 60 * 60_000, label: () => tr.text(HistoryMsgs.timeLast24h()) },
	{ key: '7d', ms: 7 * 24 * 60 * 60_000, label: () => tr.text(HistoryMsgs.timeLast7d()) },
	{ key: '30d', ms: 30 * 24 * 60 * 60_000, label: () => tr.text(HistoryMsgs.timeLast30d()) },
] as const

// A preset resolves to absolute bounds at pick time rather than staying relative: the query is a url that is
// also saved and shared, and a saved "last 7 days" would answer a different question every time it was run.
function TimeRange(props: { draft: HQ.Query; set: Set }) {
	const { draft, set } = props
	const [custom, setCustom] = React.useState(false)
	const showCustom = custom || (draft.from !== undefined && !matchedPreset(draft))

	if (showCustom) {
		return (
			<div className="flex items-center gap-1">
				<Input
					type="datetime-local"
					className="h-7 w-max text-xs"
					defaultValue={toDatetimeLocal(draft.from)}
					onChange={(e) => set({ from: e.target.value === '' ? undefined : new Date(e.target.value).getTime() })}
				/>
				<Input
					type="datetime-local"
					className="h-7 w-max text-xs"
					defaultValue={toDatetimeLocal(draft.to)}
					onChange={(e) => set({ to: e.target.value === '' ? undefined : new Date(e.target.value).getTime() })}
				/>
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7"
					title={tr.text(HistoryMsgs.clearFilter())}
					onClick={() => {
						setCustom(false)
						set({ from: undefined, to: undefined })
					}}
				>
					<Icons.X className="h-3 w-3" />
				</Button>
			</div>
		)
	}

	const current = matchedPreset(draft)?.key ?? ANY
	return (
		<Select
			value={current}
			onValueChange={(v) => {
				if (v === 'custom') {
					setCustom(true)
					return
				}
				const preset = PRESETS.find((p) => p.key === v)
				set(preset ? { from: Date.now() - preset.ms, to: undefined } : { from: undefined, to: undefined })
			}}
		>
			<SelectTrigger className="h-7 w-max text-xs">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ANY}>{tr.text(HistoryMsgs.timeAny())}</SelectItem>
				{PRESETS.map((preset) => (
					<SelectItem key={preset.key} value={preset.key}>
						{preset.label()}
					</SelectItem>
				))}
				<SelectItem value="custom">{tr.text(HistoryMsgs.timeCustom())}</SelectItem>
			</SelectContent>
		</Select>
	)
}

// a preset's `from` drifts from `now - ms` the moment it is set, so it is recognised within a minute's slack
const PRESET_SLACK_MS = 60_000

function matchedPreset(query: HQ.Query) {
	if (query.from === undefined || query.to !== undefined) return undefined
	const age = Date.now() - query.from
	return PRESETS.find((p) => Math.abs(age - p.ms) < PRESET_SLACK_MS)
}

function toDatetimeLocal(value: number | undefined): string {
	if (value === undefined) return ''
	return new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

// Searches names through the trigram index, but any text is a valid value: the engine reads a ref as an eos
// id, a steam64, or a name substring (resolvePlayerRefs), so a needle nobody picked from the list still runs.
function PlayerPicker(props: { value: string | undefined; onSelect: (value: string | undefined) => void }) {
	const [needle, setNeedle] = React.useState('')
	const trimmed = needle.trim()
	const search = useQuery(HistoryClient.playerSearchBase(trimmed))
	const selectedInfo = useQuery(HistoryClient.playerInfoBase(props.value))

	const options = React.useMemo(() => {
		const found = search.data?.code === 'ok' ? search.data.players : []
		const list = found.map((p) => ({ value: p.eosId, label: p.username ?? p.eosId }))
		// the typed needle itself, so a name with no exact row (or a pasted id) is still selectable
		if (trimmed !== '' && !list.some((o) => o.label === trimmed)) {
			list.unshift({ value: trimmed, label: tr.text(HistoryMsgs.filterByTyped(trimmed)) })
		}
		// keep the current value in the list, or the combo-box cannot render its own selection
		if (props.value !== undefined && !list.some((o) => o.value === props.value)) {
			const name = selectedInfo.data?.code === 'ok' ? selectedInfo.data.username : undefined
			list.unshift({ value: props.value, label: name ?? props.value })
		}
		return list
	}, [search.data, trimmed, props.value, selectedInfo.data])

	const loading = trimmed.length >= HistoryClient.MIN_PLAYER_NEEDLE && search.isFetching
	return (
		<ComboBox
			title={tr.text(HistoryMsgs.fieldPlayer())}
			placeholder={tr.text(HistoryMsgs.playerSearchPlaceholder())}
			searchPlaceholder={tr.text(HistoryMsgs.playerSearchHint())}
			emptyMessage={
				trimmed.length > 0 && trimmed.length < HistoryClient.MIN_PLAYER_NEEDLE ? tr.text(HistoryMsgs.playerSearchShort()) : undefined
			}
			allowEmpty
			className="w-full"
			inputValue={needle}
			setInputValue={setNeedle}
			value={props.value}
			options={loading ? LOADING : options}
			onSelect={(v) => props.onSelect(v ?? undefined)}
		/>
	)
}

// The user counterpart to PlayerPicker. Same shape, but no minimum needle and no trigram index behind it:
// an install has hundreds of users where it has hundreds of thousands of players.
function UserPicker(props: { value: string | undefined; onSelect: (value: string | undefined) => void }) {
	const [needle, setNeedle] = React.useState('')
	const trimmed = needle.trim()
	const search = useQuery(HistoryClient.userSearchBase(trimmed))
	const selectedInfo = useQuery(HistoryClient.userInfoBase(props.value))

	const options = React.useMemo(() => {
		const found = search.data?.code === 'ok' ? search.data.users : []
		const list = found.map((u) => ({ value: u.userId, label: u.name }))
		if (trimmed !== '' && !list.some((o) => o.label === trimmed)) {
			list.unshift({ value: trimmed, label: tr.text(HistoryMsgs.filterByTyped(trimmed)) })
		}
		if (props.value !== undefined && !list.some((o) => o.value === props.value)) {
			const name = selectedInfo.data?.code === 'ok' ? selectedInfo.data.name : undefined
			list.unshift({ value: props.value, label: name ?? props.value })
		}
		return list
	}, [search.data, trimmed, props.value, selectedInfo.data])

	return (
		<ComboBox
			title={tr.text(HistoryMsgs.fieldUser())}
			placeholder={tr.text(HistoryMsgs.userSearchPlaceholder())}
			searchPlaceholder={tr.text(HistoryMsgs.userSearchHint())}
			allowEmpty
			className="w-full"
			inputValue={needle}
			setInputValue={setNeedle}
			value={props.value}
			options={trimmed !== '' && search.isFetching ? LOADING : options}
			onSelect={(v) => props.onSelect(v ?? undefined)}
		/>
	)
}

// -------- fields --------

function AddFilterMenu(props: { draft: HQ.Query; shown: readonly QF.FieldKey[]; onPick: (key: QF.FieldKey) => void }) {
	const groups = QF.addableGroups(props.draft, props.shown)
	if (groups.length === 0) return null
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="sm" className="h-7 w-full border-dashed text-xs font-normal text-muted-foreground">
					<Icons.Plus className="mr-1 h-3 w-3" />
					{tr.text(HistoryMsgs.addFilter())}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="max-h-96 overflow-y-auto">
				{groups.map((group, i) => (
					<React.Fragment key={group.group}>
						{i > 0 && <DropdownMenuSeparator />}
						<DropdownMenuLabel className="text-2xs uppercase text-muted-foreground">{groupLabel(group.group)}</DropdownMenuLabel>
						{group.fields.map((field) => (
							<DropdownMenuItem key={field.key} onClick={() => props.onPick(field.key)}>
								{fieldLabel(field.key)}
							</DropdownMenuItem>
						))}
					</React.Fragment>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// A newly added field does not open its own editor: the dropdown that added it holds focus for the length of
// its exit animation and dismisses any popover opened before that, so auto-opening means racing a duration
// this component cannot see. The row reads "Any" until it is clicked, which says the same thing.
function FieldRow(props: { field: QF.FieldDef; draft: HQ.Query; set: Set; onRemove: () => void }) {
	const { field, draft, set } = props
	const [open, setOpen] = React.useState(false)
	const summary = fieldSummary(draft, field.key)
	const isSet = QF.isSet(draft, field.key)

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<div className="flex items-center gap-2 text-xs">
				<span className="w-16 shrink-0 truncate text-muted-foreground">{fieldLabel(field.key)}</span>
				<PopoverTrigger asChild>
					<button
						type="button"
						className="flex h-7 min-w-0 flex-1 items-center rounded-md border border-input bg-transparent px-2 text-left hover:bg-accent"
					>
						<span className={cn('truncate', !isSet && 'text-muted-foreground')}>{summary ?? tr.text(HistoryMsgs.anyOption())}</span>
					</button>
				</PopoverTrigger>
				<button
					type="button"
					className="shrink-0 text-muted-foreground hover:text-foreground"
					title={tr.text(HistoryMsgs.clearFilter())}
					onClick={() => {
						set(QF.clearPatch(field.key))
						setOpen(false)
						props.onRemove()
					}}
				>
					<Icons.X className="h-3 w-3" />
				</button>
			</div>
			<PopoverContent className="w-auto p-2" align="start">
				<FieldControl field={field} draft={draft} set={set} onDone={() => setOpen(false)} />
			</PopoverContent>
		</Popover>
	)
}

function FieldControl(props: { field: QF.FieldDef; draft: HQ.Query; set: Set; onDone: () => void }) {
	const { field, draft, set } = props
	const control = field.control
	switch (control.kind) {
		case 'multi-enum':
			return (
				<ComboBoxMulti
					title={fieldLabel(field.key)}
					className="w-72"
					values={draft.types ?? []}
					options={control.options as string[]}
					onSelect={(update) => {
						const next = typeof update === 'function' ? update(draft.types ?? []) : update
						set({ types: next as HQ.Query['types'] })
					}}
				/>
			)
		case 'enum':
			return (
				<ComboBox
					title={fieldLabel(field.key)}
					allowEmpty
					className="w-52"
					value={draft[field.key as 'variant' | 'outcome' | 'setBy']}
					options={control.options as string[]}
					onSelect={(v) => {
						set({ [field.key]: v ?? undefined })
						props.onDone()
					}}
				/>
			)
		case 'text':
			return (
				<Input
					autoFocus
					className="h-7 w-52 text-xs"
					defaultValue={(draft[field.key as 'chat' | 'damageSource'] as string | undefined) ?? ''}
					onChange={(e) => set({ [field.key]: e.target.value || undefined })}
				/>
			)
		case 'layer-part':
			return (
				<ComboBox
					title={fieldLabel(field.key)}
					allowEmpty
					className="w-52"
					value={draft[field.key as 'map' | 'gamemode' | 'faction']}
					options={L.StaticLayerComponents[control.part] as unknown as string[]}
					onSelect={(v) => {
						set({ [field.key]: v ?? undefined })
						props.onDone()
					}}
				/>
			)
		case 'saved-filter':
			return (
				<LayerFilterPicker
					value={draft.layer?.type === 'included-in' ? draft.layer.filterId : undefined}
					onSelect={(filterId) => {
						set({ layer: filterId ? { type: 'included-in', filterId } : undefined })
						props.onDone()
					}}
				/>
			)
		case 'number':
			return (
				<Input
					autoFocus
					type="number"
					min={1}
					className="h-7 w-24 text-xs"
					defaultValue={draft.minMatches ?? ''}
					onChange={(e) => set({ minMatches: e.target.value === '' ? undefined : Number(e.target.value) })}
				/>
			)
		case 'number-range':
			return (
				<div className="flex items-center gap-1">
					<NumberBound
						label={tr.text(HistoryMsgs.rangeFrom())}
						value={draft.ticketDiffMin}
						onChange={(ticketDiffMin) => set({ ticketDiffMin })}
					/>
					<NumberBound
						label={tr.text(HistoryMsgs.rangeTo())}
						value={draft.ticketDiffMax}
						onChange={(ticketDiffMax) => set({ ticketDiffMax })}
					/>
				</div>
			)
		default:
			assertNever(control)
	}
}

function NumberBound(props: { label: string; value: number | undefined; onChange: (value: number | undefined) => void }) {
	return (
		<label className="flex flex-col gap-0.5 text-2xs text-muted-foreground">
			{props.label}
			<Input
				type="number"
				min={0}
				className="h-7 w-20 text-xs"
				defaultValue={props.value ?? ''}
				onChange={(e) => props.onChange(e.target.value === '' ? undefined : Number(e.target.value))}
			/>
		</label>
	)
}

// -------- labels --------

function groupLabel(group: QF.FieldGroup): string {
	switch (group) {
		case 'events':
			return tr.text(HistoryMsgs.groupEvents())
		case 'match':
			return tr.text(HistoryMsgs.groupMatch())
		case 'layer':
			return tr.text(HistoryMsgs.groupLayer())
		case 'players':
			return tr.text(HistoryMsgs.groupPlayers())
		default:
			assertNever(group)
	}
}

function fieldLabel(key: QF.FieldKey): string {
	switch (key) {
		case 'types':
			return tr.text(HistoryMsgs.fieldEventTypes())
		case 'variant':
			return tr.text(HistoryMsgs.fieldVariant())
		case 'damageSource':
			return tr.text(HistoryMsgs.fieldDamageSource())
		case 'chat':
			return tr.text(HistoryMsgs.fieldChat())
		case 'outcome':
			return tr.text(HistoryMsgs.fieldOutcome())
		case 'setBy':
			return tr.text(HistoryMsgs.fieldSetBy())
		case 'ticketDiff':
			return tr.text(HistoryMsgs.fieldTicketDiff())
		case 'map':
			return tr.text(HistoryMsgs.fieldMap())
		case 'gamemode':
			return tr.text(HistoryMsgs.fieldGamemode())
		case 'faction':
			return tr.text(HistoryMsgs.fieldFaction())
		case 'layer':
			return tr.text(HistoryMsgs.fieldLayer())
		case 'minMatches':
			return tr.text(HistoryMsgs.fieldMinMatches())
		default:
			assertNever(key)
	}
}

function LayerFilterName(props: { filterId: string }) {
	const entities = FilterEntityClient.useFilterEntities()
	return <span>{entities.get(props.filterId)?.name ?? props.filterId}</span>
}

function fieldSummary(query: HQ.Query, key: QF.FieldKey): React.ReactNode {
	switch (key) {
		case 'types': {
			const types = query.types ?? []
			return types.length <= 2 ? types.join(', ') : `${types.length} types`
		}
		case 'ticketDiff': {
			const { ticketDiffMin: min, ticketDiffMax: max } = query
			if (min !== undefined && max !== undefined) return `${min}–${max}`
			if (min !== undefined) return `≥ ${min}`
			if (max !== undefined) return `≤ ${max}`
			return undefined
		}
		case 'layer':
			return query.layer?.type === 'included-in' && query.layer.filterId ? (
				<LayerFilterName filterId={query.layer.filterId} />
			) : undefined
		case 'minMatches':
			return query.minMatches === undefined ? undefined : `≥ ${query.minMatches}`
		default:
			return query[key] as string | undefined
	}
}
