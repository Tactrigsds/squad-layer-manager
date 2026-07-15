import { BmFlagMultiSelect, BmFlagOrColorSelect, FlagPriorityMap } from '@/components/bm-flag-picker'
import type { ComboBoxOption } from '@/components/combo-box/combo-box'
import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { DiscordMemberSelect, DiscordRoleSelect } from '@/components/discord-picker'
import LayerGenerationConfigEditor from '@/components/layer-generation-config-editor'
import LayerTableConfigEditor from '@/components/layer-table-config-editor'
import { GenerationPoolFiltersPanel, MainPoolFiltersPanel, RepeatRulesPanel } from '@/components/pool-config-panels'
import type { PoolConfigApi } from '@/components/pool-config-panels.helpers'
import { StickyGroup } from '@/components/sticky-group'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebounced } from '@/hooks/use-debounce'
import * as Obj from '@/lib/object'
import type { SettingsGroup } from '@/lib/settings-groups'
import { splitByGroups } from '@/lib/settings-groups'
import { humanize, settingLabel } from '@/lib/settings-labels'
import * as SettingsNav from '@/lib/settings-nav'
import * as Templating from '@/lib/templating'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as AAR from '@/models/admin-action-reasons.models'
import type * as BM from '@/models/battlemetrics.models'
import type * as LP from '@/models/labeled-presets.models'
import * as LC from '@/models/layer-columns'
import * as SETTINGS from '@/models/settings.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as SettingsClient from '@/systems/settings.client'
import * as UsersClient from '@/systems/users.client'
import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'
import { z } from 'zod'
import { MessagePreviewBox } from './warn-reasons-sub'

// The form is driven off the JSON-Schema projection of a Zod schema (input mode), edited in the encoded/input shape
// (e.g. HumanTime fields as '5m' strings). Custom widgets are matched by path for the flag + rbac config.
//
// Data flow is inverted from a plain controlled form: instead of a `value` prop we hand each field a `value$`
// (a BehaviorSubject-like state observable it reads via `.getValue()`) and a `reset$` signal. Native text/number
// inputs stay *uncontrolled* (seeded from `value$.getValue()`, edits debounced upward) so typing never round-trips
// through React state; `reset$` is emitted after any structural or programmatic change so those uncontrolled inputs
// re-read their current value. Composite widgets (selects, switches, pickers) render controlled off a small local
// mirror of `value$` that only re-syncs on emissions/`reset$`.

type Node = any
type Path = (string | number)[]

// a BehaviorSubject-like handle: subscribable, plus a synchronous `.getValue()` for the current value
type ValueState<T = any> = Rx.Observable<T> & { getValue: () => T }

const DEBOUNCE_MS = 250

// -------- state plumbing --------

// derive a child value-state scoped to `key` of the parent. distinctUntilChanged keeps copy-on-write siblings quiet.
function scopeValue(parent$: ValueState, key: string | number): ValueState {
	const child$ = parent$.pipe(Rx.map((v: any) => v?.[key]), Rx.distinctUntilChanged()) as ValueState
	child$.getValue = () => (parent$.getValue() as any)?.[key]
	return child$
}

// current value of a field, re-read on both emissions and reset$. For widgets that render controlled.
function useFieldValue<T>(value$: ValueState<T>, reset$: Rx.Observable<void>): T {
	const [v, setV] = React.useState<T>(() => value$.getValue())
	React.useEffect(() => {
		const sub = new Rx.Subscription()
		sub.add(value$.subscribe(setV))
		sub.add(reset$.subscribe(() => setV(value$.getValue())))
		return () => sub.unsubscribe()
	}, [value$, reset$])
	return v
}

// run `fn` whenever reset$ fires (used by uncontrolled inputs to re-read their DOM value)
function useReset(reset$: Rx.Observable<void>, fn: () => void) {
	const fnRef = React.useRef(fn)
	fnRef.current = fn
	React.useEffect(() => {
		const sub = reset$.subscribe(() => fnRef.current())
		return () => sub.unsubscribe()
	}, [reset$])
}

// -------- schema helpers --------

function stripNullable(node: Node): { inner: Node; nullable: boolean } {
	if (node?.anyOf) {
		const nulls = node.anyOf.filter((b: Node) => b.type === 'null')
		const others = node.anyOf.filter((b: Node) => b.type !== 'null')
		if (nulls.length && others.length) {
			return { inner: others.length === 1 ? others[0] : { anyOf: others }, nullable: true }
		}
	}
	return { inner: node, nullable: false }
}

// HumanTime and similar accept `string | number`; we edit them as the string form
function isStringOrNumber(node: Node): boolean {
	if (!node?.anyOf || node.anyOf.length !== 2) return false
	const types = new Set(node.anyOf.map((b: Node) => b.type))
	return types.has('string') && types.has('number')
}

// a discriminated union (Zod z.discriminatedUnion) projects to `oneOf`/`anyOf` of object branches that each pin one
// property to a `const` (the discriminator). Returns those branches + the discriminator key so we can render a variant
// picker instead of falling back to a raw-json editor.
function discriminatedUnion(node: Node): { branches: Node[]; discriminator: string } | null {
	const branches: Node[] | undefined = node?.oneOf ?? node?.anyOf
	if (!branches || branches.length < 2) return null
	if (!branches.every((b: Node) => b?.type === 'object' && b.properties)) return null
	const constKeys = Object.keys(branches[0].properties).filter((k) => branches[0].properties[k]?.const !== undefined)
	const discriminator = constKeys.find((k) => branches.every((b: Node) => b.properties?.[k]?.const !== undefined))
	if (!discriminator) return null
	return { branches, discriminator }
}

function emptyValue(node: Node): unknown {
	const { inner, nullable } = stripNullable(node)
	if (nullable) return null
	if (inner.const !== undefined) return inner.const
	if (inner.default !== undefined) return structuredClone(inner.default)
	if (inner.enum) return inner.enum[0]
	const du = discriminatedUnion(inner)
	if (du) return emptyValue(du.branches[0])
	if (isStringOrNumber(inner)) return '0s'
	switch (inner.type) {
		case 'string':
			return ''
		case 'integer':
		case 'number':
			return 0
		case 'boolean':
			return false
		case 'array':
			return []
		case 'object': {
			if (!inner.properties) return {}
			const obj: Record<string, unknown> = {}
			for (const key of Object.keys(inner.properties)) obj[key] = emptyValue(inner.properties[key])
			return obj
		}
		default:
			return null
	}
}

// granted permissions include the "*" wildcard; denials are stored with a "!" prefix but edited without it in a separate select
function permOption(p: string): ComboBoxOption<string> {
	const def = RBAC.PERMISSION_DEFINITION[p as keyof typeof RBAC.PERMISSION_DEFINITION]
	return { value: p, description: def?.description }
}
const GRANT_PERM_OPTIONS: ComboBoxOption<string>[] = [
	{ value: '*', description: 'Grants every permission (full access to everything)' },
	...RBAC.ROLE_GRANTABLE_PERMISSION_TYPE.options.map(permOption),
]
const DENY_PERM_OPTIONS: ComboBoxOption<string>[] = RBAC.ROLE_GRANTABLE_PERMISSION_TYPE.options.map(permOption)

// editor for a role's permission expression list: granted perms and denied perms (!-prefixed) in two separate selects
function PermissionExpressionEditor({ value, onChange }: { value: string[] | undefined; onChange: (v: string[]) => void }) {
	const all = value ?? []
	const granted = all.filter((v) => !v.startsWith('!'))
	const denied = all.filter((v) => v.startsWith('!')).map((v) => v.slice(1))

	function setGranted(next: string[]) {
		onChange([...next, ...denied.map((p) => `!${p}`)])
	}
	function setDenied(next: string[]) {
		onChange([...granted, ...next.map((p) => `!${p}`)])
	}

	return (
		<div className="space-y-2">
			<div className="space-y-1">
				<label className="text-xs text-muted-foreground">Granted</label>
				<ComboBoxMulti
					title="Permission"
					values={granted}
					options={GRANT_PERM_OPTIONS}
					onSelect={(next) => setGranted(typeof next === 'function' ? next(granted) : next)}
				/>
			</div>
			<div className="space-y-1">
				<label className="text-xs text-muted-foreground">Denied (takes precedence)</label>
				<ComboBoxMulti
					title="Denied permission"
					values={denied}
					options={DENY_PERM_OPTIONS}
					onSelect={(next) => setDenied(typeof next === 'function' ? next(denied) : next)}
				/>
			</div>
		</div>
	)
}

// -------- rbac cross-field wiring --------

// the draft's custom message variables (rbac-style sibling read), so the reason preview can render templates
const MessageVarsContext = React.createContext<Record<string, string>>({})

function useMessageVars(value$: ValueState): Record<string, string> {
	const read = (v: any): Record<string, string> =>
		Object.fromEntries(
			((v?.messageVariables ?? []) as { name?: string; value?: string }[]).flatMap(mv => mv.name ? [[mv.name, mv.value ?? '']] : []),
		)
	const [vars, setVars] = React.useState(() => read(value$.getValue()))
	React.useEffect(() => {
		const sub = value$.subscribe((v) =>
			setVars((prev) => {
				const next = read(v)
				const same = Object.keys(prev).length === Object.keys(next).length && Object.entries(next).every(([k, val]) => prev[k] === val)
				return same ? prev : next
			})
		)
		return () => sub.unsubscribe()
	}, [value$])
	return vars
}

// per-form options. `idPrefix` scopes the DOM ids / URL-fragment anchors so multiple forms on the settings page (global
// settings + one per server) don't collide; it stays `setting:*` so the TOC scroll-spy and hash nav still match.
const FormOptionsContext = React.createContext<{ idPrefix: string }>({ idPrefix: 'setting:' })

// the user's write grant over the settings being edited; leaves outside it render dimmed + inert (see LeafField)
const WRITE_ACCESS_ALL: RBAC.SettingsWriteAccess = { kind: 'all' }
const WriteAccessContext = React.createContext<RBAC.SettingsWriteAccess>(WRITE_ACCESS_ALL)

// the current draft's schema issues, normalized to dotted path strings. Each leaf field claims the issues at or below
// its own path (below-leaf paths -- array items, record entries -- have no dedicated field UI of their own).
type NormalizedIssue = { path: string; message: string }
const ValidationContext = React.createContext<NormalizedIssue[]>([])

function issuesForField(all: NormalizedIssue[], pathStr: string): NormalizedIssue[] {
	return all.filter((i) => i.path === pathStr || i.path.startsWith(pathStr + '.'))
}

const MAX_SHOWN_FIELD_ISSUES = 5

function FieldIssues({ issues, pathStr }: { issues: NormalizedIssue[]; pathStr: string }) {
	if (issues.length === 0) return null
	return (
		<div className="space-y-0.5 pt-0.5">
			{issues.slice(0, MAX_SHOWN_FIELD_ISSUES).map((iss, i) => (
				// oxlint-disable-next-line no-array-index-key
				<p key={i} className="flex items-start gap-1 text-xs font-medium text-destructive">
					<Icons.CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
					<span className="min-w-0 wrap-break-word">
						{iss.path !== pathStr && <code className="mr-1 text-[10px] opacity-70">{iss.path.slice(pathStr.length + 1)}</code>}
						{iss.message}
					</span>
				</p>
			))}
			{issues.length > MAX_SHOWN_FIELD_ISSUES && (
				<p className="text-xs text-destructive/80">+{issues.length - MAX_SHOWN_FIELD_ISSUES} more</p>
			)}
		</div>
	)
}

// the last-saved (persisted) baseline the draft was seeded from, so any field can offer "reset to saved" alongside
// "reset to default". Held at the root and indexed per-field by path (see `getAtPath`); only changes on save/refetch, so
// per-keystroke edits don't churn it. `undefined` while the settings are still loading.
const SavedRootContext = React.createContext<{ saved: any }>({ saved: undefined })

function getAtPath(root: any, path: Path): unknown {
	let cur = root
	for (const key of path) {
		if (cur === null || cur === undefined) return undefined
		cur = cur[key as any]
	}
	return cur
}

// the env-configured SUPER_USERS/SUPER_ROLES bootstrap: shown read-only at the top of the rbac section so admins know
// these grants exist, and that they can only be changed via the environment, not from this page
function RbacSuperCallout() {
	const superRes = useQuery(RPC.orpc.rbac.getSuperConfig.queryOptions({ staleTime: Infinity }))
	const superConfig = superRes.data?.code === 'ok' ? superRes.data : undefined
	const rolesRes = useQuery(RPC.orpc.rbac.listGuildRoles.queryOptions({ staleTime: Infinity }))
	const guildRoles = rolesRes.data?.code === 'ok' ? rolesRes.data.roles : []
	const userIds = (superConfig?.superUsers ?? []).map(BigInt)
	const usersRes = UsersClient.useUsers(userIds, { enabled: userIds.length > 0 })
	const userMap = new Map((usersRes.data?.code === 'ok' ? usersRes.data.users : []).map((u) => [String(u.discordId), u]))

	if (!superConfig || (superConfig.superUsers.length === 0 && superConfig.superRoles.length === 0)) return null

	return (
		<div className="space-y-2 rounded-md border border-info/40 bg-info/10 p-3">
			<p className="flex items-center gap-1.5 text-sm font-medium">
				<Icons.ShieldCheck className="h-4 w-4 shrink-0" />
				Super users & roles
			</p>
			<p className="text-xs text-muted-foreground">
				Configured through the SUPER_USERS / SUPER_ROLES environment variables. They always hold every permission (including unlimited kick
				timeouts) and cannot be modified from this page.
			</p>
			{superConfig.superUsers.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-muted-foreground">Users:</span>
					{superConfig.superUsers.map((id) => (
						<span key={id} className="rounded border bg-background px-1.5 py-0.5 text-xs" title={id}>
							{userMap.get(id)?.displayName ?? <span className="font-mono">{id}</span>}
						</span>
					))}
				</div>
			)}
			{superConfig.superRoles.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-muted-foreground">Discord roles:</span>
					{superConfig.superRoles.map((id) => {
						const role = guildRoles.find((r) => r.id === id)
						return (
							<span key={id} className="flex items-center gap-1.5 rounded border bg-background px-1.5 py-0.5 text-xs" title={id}>
								{role
									? (
										<>
											<span className="h-2 w-2 shrink-0 rounded-full border" style={{ backgroundColor: role.color ?? 'transparent' }} />
											{role.name}
										</>
									)
									: <span className="font-mono">{id}</span>}
							</span>
						)
					})}
				</div>
			)}
		</div>
	)
}

// extra read-only content injected at the top of specific sections (below the description, above the fields)
function sectionExtraFor(path: Path): React.FC | undefined {
	if (path.length === 1 && path[0] === 'rbac') return RbacSuperCallout
	return undefined
}

// -------- override widgets (matched by path) --------

type OverrideProps = { value$: ValueState; reset$: Rx.Subject<void>; onChange: (v: any) => void; path: Path }

function FlagMultiSelectField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$, reset$)
	return <BmFlagMultiSelect value={value ?? []} onChange={onChange} />
}

type FlagGrouping = BM.PlayerFlagGrouping
type FlagGroupingsValue = { modeIds?: string[]; groupings?: FlagGrouping[] }

function newFlagGrouping(): FlagGrouping {
	return { label: '', modeIds: [], associations: {}, color: '' }
}

// bespoke editor for `playerFlagGroupings`: display modes are declared upfront (as chips), and each grouping picks its
// modes from that declared list (dropdown) plus a label, color and priority-ordered flag associations.
function PlayerFlagGroupingsField({ value$, reset$, onChange }: OverrideProps) {
	const value = (useFieldValue(value$, reset$) as FlagGroupingsValue) ?? {}
	const modeIds = value.modeIds ?? []
	const groupings = value.groupings ?? []

	// `quiet` skips reset$: use it for the uncontrolled label input, where re-emitting would clobber an in-flight keystroke.
	// Structural edits (add/remove modes or groupings) leave it off so the label inputs re-seed after re-indexing.
	const update = React.useCallback((fn: (v: FlagGroupingsValue) => FlagGroupingsValue, quiet?: boolean) => {
		onChange(fn((value$.getValue() as FlagGroupingsValue) ?? {}))
		if (!quiet) reset$.next()
	}, [onChange, value$, reset$])

	const [newMode, setNewMode] = React.useState('')
	const trimmedMode = newMode.trim()
	const canAddMode = trimmedMode.length > 0 && !modeIds.includes(trimmedMode)
	function addMode() {
		if (!canAddMode) return
		update((v) => ({ ...v, modeIds: [...(v.modeIds ?? []), trimmedMode] }))
		setNewMode('')
	}
	// removing a mode also strips it from every grouping that referenced it
	function removeMode(id: string) {
		update((v) => ({
			...v,
			modeIds: (v.modeIds ?? []).filter((m) => m !== id),
			groupings: (v.groupings ?? []).map((g) => ({ ...g, modeIds: g.modeIds.filter((m) => m !== id) })),
		}))
	}

	function addGrouping() {
		update((v) => ({ ...v, groupings: [...(v.groupings ?? []), newFlagGrouping()] }))
	}
	function removeGrouping(idx: number) {
		update((v) => ({ ...v, groupings: (v.groupings ?? []).filter((_, i) => i !== idx) }))
	}
	function changeGrouping(idx: number, patch: Partial<FlagGrouping>, quiet?: boolean) {
		update((v) => ({ ...v, groupings: (v.groupings ?? []).map((g, i) => i === idx ? { ...g, ...patch } : g) }), quiet)
	}

	const modeOptions: ComboBoxOption<string>[] = modeIds.map((id) => ({ value: id, label: id }))

	return (
		<div className="space-y-4">
			<div className="space-y-1.5">
				<Label className="text-sm font-medium">Grouping modes</Label>
				<p className="text-xs text-muted-foreground">Declared upfront; each grouping and the players panel select from these.</p>
				<div className="flex flex-wrap items-center gap-1.5">
					{modeIds.length === 0 && <span className="text-xs text-muted-foreground">No modes defined.</span>}
					{modeIds.map((id) => (
						<span key={id} className="flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-xs">
							{id}
							<button type="button" className="text-destructive" aria-label={`Remove mode ${id}`} onClick={() => removeMode(id)}>
								<Icons.X className="h-3 w-3" />
							</button>
						</span>
					))}
				</div>
				<div className="flex max-w-sm items-center gap-2">
					<Input
						placeholder="New mode id"
						value={newMode}
						onChange={(e) => setNewMode(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault()
								addMode()
							}
						}}
					/>
					<Button type="button" variant="outline" size="sm" disabled={!canAddMode} onClick={addMode}>Add mode</Button>
				</div>
			</div>

			<div className="space-y-2">
				<Label className="text-sm font-medium">Groupings</Label>
				{groupings.length === 0 && <p className="text-xs text-muted-foreground">No groupings defined.</p>}
				{groupings.map((g, idx) => (
					// oxlint-disable-next-line no-array-index-key
					<div key={idx} className="space-y-3 rounded-md border p-3">
						<div className="flex items-start gap-2">
							<div className="flex-1 space-y-1">
								<Label className="text-xs text-muted-foreground">Label</Label>
								<TextInputField
									value$={scopeValue(scopeValue(scopeValue(value$, 'groupings'), idx), 'label')}
									reset$={reset$}
									onChange={(next) => changeGrouping(idx, { label: (next as string) ?? '' }, true)}
									numeric={false}
									placeholder="Grouping label"
								/>
							</div>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="mt-6 h-6 w-6 shrink-0 text-destructive"
								aria-label="Remove grouping"
								onClick={() => removeGrouping(idx)}
							>
								<Icons.X className="h-4 w-4" />
							</Button>
						</div>
						<div className="space-y-1">
							<Label className="text-xs text-muted-foreground">Modes</Label>
							<ComboBoxMulti
								title="Mode"
								values={g.modeIds}
								options={modeOptions}
								onSelect={(next) => changeGrouping(idx, { modeIds: typeof next === 'function' ? next(g.modeIds) : next })}
							/>
						</div>
						<div className="space-y-1">
							<Label className="text-xs text-muted-foreground">Color</Label>
							<BmFlagOrColorSelect value={g.color ?? ''} onChange={(next) => changeGrouping(idx, { color: next })} />
						</div>
						<div className="space-y-1">
							<Label className="text-xs text-muted-foreground">Flags</Label>
							<FlagPriorityMap value={g.associations ?? {}} onChange={(next) => changeGrouping(idx, { associations: next })} />
						</div>
					</div>
				))}
				<Button type="button" variant="outline" size="sm" onClick={addGrouping}>
					<Icons.Plus className="mr-1 h-4 w-4" />Add grouping
				</Button>
			</div>
		</div>
	)
}
function PasswordField({ value$, reset$, onChange }: OverrideProps) {
	return <TextInputField value$={value$} reset$={reset$} onChange={onChange} numeric={false} secret placeholder="Password" />
}
// bespoke editor for the layer-table config (column order/visibility, default sort, extra menu items, default filters)
function LayerTableField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$, reset$)
	return (
		<LayerTableConfigEditor
			value={value ?? { orderedColumns: [], defaultSortBy: { type: 'random' } }}
			onChange={onChange}
			reset$={reset$}
		/>
	)
}
// bespoke editor for the weighted-random layer generation config (pick order + per-value / per-matchup weights)
function LayerGenerationField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$, reset$)
	return (
		<LayerGenerationConfigEditor
			value={value ?? LC.LayerGenerationConfigSchema.parse({})}
			onChange={onChange}
			reset$={reset$}
		/>
	)
}

// shared table shell for label/message/aliases preset lists (admin action reasons, broadcasts)
type PresetRowProps = {
	idx: number
	parent$: ValueState
	reset$: Rx.Subject<void>
	parentOnChange: (v: any[]) => void
	onRemove: () => void
}

function PresetTableField(
	{ value$, reset$, onChange, headers, newRow, Row }: {
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: any[]) => void
		headers: React.ReactNode
		newRow: () => object
		Row: React.ComponentType<PresetRowProps>
	},
) {
	const value = (useFieldValue(value$, reset$) as object[] | undefined) ?? []

	// structural edits emit reset$ so the rows' uncontrolled inputs re-read after re-indexing
	function structural(next: object[]) {
		onChange(next)
		reset$.next()
	}

	return (
		<div className="space-y-1.5">
			{value.length > 0 && (
				<Table>
					<TableHeader>
						<TableRow>{headers}</TableRow>
					</TableHeader>
					<TableBody>
						{value.map((_, idx) => (
							<Row
								// rows have no stable id, same as ArrayField items
								// oxlint-disable-next-line no-array-index-key
								key={idx}
								idx={idx}
								parent$={value$}
								reset$={reset$}
								parentOnChange={onChange}
								onRemove={() => structural(((value$.getValue() as object[]) ?? []).filter((_, i) => i !== idx))}
							/>
						))}
					</TableBody>
				</Table>
			)}
			<Button
				type="button"
				size="sm"
				variant="outline"
				onClick={() => structural([...((value$.getValue() as object[]) ?? []), newRow()])}
			>
				<Icons.Plus className="h-4 w-4" />
				Add
			</Button>
		</div>
	)
}

function AdminActionReasonsField({ value$, reset$, onChange }: OverrideProps) {
	return (
		<PresetTableField
			value$={value$}
			reset$={reset$}
			onChange={onChange}
			headers={
				<>
					<TableHead className="w-[11rem]">Label</TableHead>
					<TableHead>Texts</TableHead>
					<TableHead className="w-[10rem]">Aliases</TableHead>
					<TableHead className="w-8" />
				</>
			}
			newRow={() => ({ label: '', aliases: [], actionTexts: {} })}
			Row={AdminActionReasonRow}
		/>
	)
}

function BroadcastsField({ value$, reset$, onChange }: OverrideProps) {
	return (
		<PresetTableField
			value$={value$}
			reset$={reset$}
			onChange={onChange}
			headers={
				<>
					<TableHead className="w-[11rem]">Label</TableHead>
					<TableHead>Message</TableHead>
					<TableHead className="w-[10rem]">Aliases</TableHead>
					<TableHead className="w-8" />
				</>
			}
			newRow={() => ({ label: '', message: '', aliases: [] })}
			Row={BroadcastRow}
		/>
	)
}

function AdminActionReasonRow({ idx, parent$, reset$, parentOnChange, onRemove }: PresetRowProps) {
	const row$ = React.useMemo(() => scopeValue(parent$, idx), [parent$, idx])
	const label$ = React.useMemo(() => scopeValue(row$, 'label'), [row$])
	const aliases$ = React.useMemo(() => scopeValue(row$, 'aliases'), [row$])
	const actionTexts$ = React.useMemo(() => scopeValue(row$, 'actionTexts'), [row$])
	// the set of actions this reason carries text for; keys are added/removed structurally (emits reset$)
	const actionTexts = (useFieldValue(actionTexts$, reset$) as Partial<Record<AAR.AdminActionType, string>> | undefined) ?? {}
	const presentActions = AAR.ADMIN_ACTION_TYPE.options.filter((a) => actionTexts[a] !== undefined)
	const remainingActions = AAR.ADMIN_ACTION_TYPE.options.filter((a) => actionTexts[a] === undefined)

	const setField = (key: keyof AAR.AdminActionReason) => (v: any) => {
		const arr = [...((parent$.getValue() as AAR.AdminActionReason[]) ?? [])]
		arr[idx] = { ...arr[idx], [key]: v }
		parentOnChange(arr)
	}
	// non-structural: text edit within an existing action key (no reset$; the textarea stays mounted)
	const setActionText = (action: AAR.AdminActionType) => (v: string) => {
		const arr = [...((parent$.getValue() as AAR.AdminActionReason[]) ?? [])]
		arr[idx] = { ...arr[idx], actionTexts: { ...arr[idx].actionTexts, [action]: v } }
		parentOnChange(arr)
	}
	// structural: adding/removing an action key mounts/unmounts a textarea, so re-seed uncontrolled inputs via reset$
	const addAction = (action: AAR.AdminActionType) => {
		const arr = [...((parent$.getValue() as AAR.AdminActionReason[]) ?? [])]
		arr[idx] = { ...arr[idx], actionTexts: { ...arr[idx].actionTexts, [action]: '' } }
		parentOnChange(arr)
		reset$.next()
	}
	const removeAction = (action: AAR.AdminActionType) => {
		const arr = [...((parent$.getValue() as AAR.AdminActionReason[]) ?? [])]
		const nextTexts = { ...arr[idx].actionTexts }
		delete nextTexts[action]
		arr[idx] = { ...arr[idx], actionTexts: nextTexts }
		parentOnChange(arr)
		reset$.next()
	}

	return (
		<TableRow>
			<TableCell className="align-top">
				<TextInputField value$={label$} reset$={reset$} onChange={setField('label')} numeric={false} placeholder="Label" />
			</TableCell>
			<TableCell className="align-top">
				<div className="space-y-1.5">
					{presentActions.length === 0 && (
						<p className="text-xs text-destructive">Add text for at least one action, otherwise this reason can never be used.</p>
					)}
					{presentActions.map((action) => {
						const text$ = scopeValue(actionTexts$, action)
						return (
							<div key={action} className="rounded-md border">
								<div className="flex items-center justify-between px-2 pt-1">
									<span className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
										{AAR.ADMIN_ACTIONS[action].displayName}
									</span>
									<Button
										type="button"
										size="icon"
										variant="ghost"
										className="h-5 w-5 text-destructive"
										title={`Remove ${AAR.ADMIN_ACTIONS[action].displayName} text (this reason will no longer be available for that action)`}
										onClick={() => removeAction(action)}
									>
										<Icons.X className="h-3.5 w-3.5" />
									</Button>
								</div>
								<TextAreaCell
									value$={text$}
									reset$={reset$}
									onChange={setActionText(action)}
									placeholder={`Sent when performing ${AAR.ADMIN_ACTIONS[action].displayName}`}
								/>
							</div>
						)
					})}
					{remainingActions.length > 0 && (
						<Select value="" onValueChange={(a) => addAction(a as AAR.AdminActionType)}>
							<SelectTrigger className="h-8">
								<SelectValue placeholder="Add action text…" />
							</SelectTrigger>
							<SelectContent>
								{remainingActions.map((a) => <SelectItem key={a} value={a}>{AAR.ADMIN_ACTIONS[a].displayName}</SelectItem>)}
							</SelectContent>
						</Select>
					)}
				</div>
			</TableCell>
			<TableCell className="align-top">
				<AliasesCell value$={aliases$} reset$={reset$} onChange={setField('aliases')} />
			</TableCell>
			<TableCell className="align-top">
				<div className="flex flex-col gap-1">
					<ReasonPreviewButton row$={row$} reset$={reset$} />
					<Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={onRemove}>
						<Icons.X className="h-4 w-4" />
					</Button>
				</div>
			</TableCell>
		</TableRow>
	)
}

// the verbatim rendered text each applicable context delivers in-game (squad contexts get the @Squad1 tag),
// with the given custom message variables applied. timeouts are shown with a 2h sample duration, and again with
// the remaining duration (what enforcement re-renders on rejoin) so {{#duration}} sections can be checked both ways
function reasonPreviewEntries(reason: AAR.AdminActionReason, customVars: Record<string, string>): { context: string; text: string }[] {
	const applied = (action: AAR.AdminActionType, opts?: { squadTag?: string; duration?: string }) =>
		AAR.formatAppliedReason(action, reason, {
			squadTag: opts?.squadTag,
			vars: { ...customVars, ...(action === 'timeout' ? { duration: opts?.duration ?? '' } : {}) },
		})
	const entries: { context: string; text: string }[] = []
	// one entry per action the reason carries text for; squad-directed actions get the @Squad1 tag
	for (const action of AAR.ADMIN_ACTION_TYPE.options) {
		if (reason.actionTexts[action] === undefined) continue
		if (action === 'warn') {
			entries.push({ context: 'Warn', text: applied('warn') })
			entries.push({ context: 'Warn squad', text: applied('warn', { squadTag: '@Squad1' }) })
			continue
		}
		if (action === 'timeout') {
			entries.push({ context: 'Timeout', text: applied('timeout', { duration: '2h' }) })
			entries.push({ context: 'Timeout (expired)', text: applied('timeout', { duration: '' }) })
			continue
		}
		const squadTag = AAR.ADMIN_ACTIONS[action].targetKind === 'squad' ? '@Squad1' : undefined
		entries.push({ context: AAR.ADMIN_ACTIONS[action].displayName, text: applied(action, { squadTag }) })
	}
	return entries
}

// message templates are rendered with Mustache (see src/lib/templating.ts); link to its syntax so authors know which
// {{...}} features are actually supported (plain variable substitution, not Handlebars helpers/expressions)
const TEMPLATE_SYNTAX_URL = 'https://mustache.github.io/mustache.5.html'

function TemplateSyntaxHint() {
	return (
		<p className="text-xs text-muted-foreground">
			Supports{' '}
			<a href={TEMPLATE_SYNTAX_URL} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
				{'{{variable}}'} syntax
			</a>.
		</p>
	)
}

function ReasonPreviewButton({ row$, reset$ }: { row$: ValueState; reset$: Rx.Subject<void> }) {
	const raw = useFieldValue(row$, reset$) as Partial<AAR.AdminActionReason> | undefined
	const customVars = React.useContext(MessageVarsContext)
	// tolerate incomplete draft rows so the preview shows the message shape while it's being written
	const actionTexts = Object.fromEntries(
		Object.entries(raw?.actionTexts ?? {}).map(([action, text]) => [action, (text ?? '').trim() || '<action text>']),
	) as Partial<Record<AAR.AdminActionType, string>>
	const reason: AAR.AdminActionReason = {
		label: raw?.label?.trim() || '<label>',
		aliases: raw?.aliases ?? [],
		actionTexts,
	}
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button type="button" size="icon" variant="ghost" className="h-8 w-8" title="Preview the delivered in-game messages">
					<Icons.Eye className="h-4 w-4" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-96 space-y-2" align="end">
				<p className="text-xs text-muted-foreground">
					In-game text delivered for each applicable action (timeouts shown with a 2h sample duration, and as re-delivered once it has run
					out).
				</p>
				<TemplateSyntaxHint />
				{reasonPreviewEntries(reason, customVars).map((entry) => (
					<div key={entry.context} className="space-y-1">
						<p className="text-xs font-medium">{entry.context}</p>
						<MessagePreviewBox>{entry.text}</MessagePreviewBox>
					</div>
				))}
			</PopoverContent>
		</Popover>
	)
}

function BroadcastRow({ idx, parent$, reset$, parentOnChange, onRemove }: PresetRowProps) {
	const row$ = React.useMemo(() => scopeValue(parent$, idx), [parent$, idx])
	const label$ = React.useMemo(() => scopeValue(row$, 'label'), [row$])
	const message$ = React.useMemo(() => scopeValue(row$, 'message'), [row$])
	const aliases$ = React.useMemo(() => scopeValue(row$, 'aliases'), [row$])

	const setField = (key: 'label' | 'message' | 'aliases') => (v: any) => {
		const arr = [...((parent$.getValue() as LP.BroadcastPreset[]) ?? [])]
		arr[idx] = { ...arr[idx], [key]: v }
		parentOnChange(arr)
	}

	return (
		<TableRow>
			<TableCell className="align-top">
				<TextInputField value$={label$} reset$={reset$} onChange={setField('label')} numeric={false} placeholder="Label" />
			</TableCell>
			<TableCell className="align-top">
				<div className="rounded-md border">
					<TextAreaCell value$={message$} reset$={reset$} onChange={setField('message')} placeholder="Broadcast text sent to all players" />
				</div>
			</TableCell>
			<TableCell className="align-top">
				<AliasesCell value$={aliases$} reset$={reset$} onChange={setField('aliases')} />
			</TableCell>
			<TableCell className="align-top">
				<div className="flex flex-col gap-1">
					<BroadcastPreviewButton row$={row$} reset$={reset$} />
					<Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={onRemove}>
						<Icons.X className="h-4 w-4" />
					</Button>
				</div>
			</TableCell>
		</TableRow>
	)
}

// previews the broadcast as delivered in-game, rendering {{label}} plus the draft's custom message variables the
// same way broadcastAction does at runtime
function BroadcastPreviewButton({ row$, reset$ }: { row$: ValueState; reset$: Rx.Subject<void> }) {
	const raw = useFieldValue(row$, reset$) as Partial<LP.BroadcastPreset> | undefined
	const customVars = React.useContext(MessageVarsContext)
	const message = raw?.message?.trim() || '<broadcast text>'
	const rendered = Templating.renderTemplate(message, { ...customVars, label: raw?.label?.trim() ?? '' })
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button type="button" size="icon" variant="ghost" className="h-8 w-8" title="Preview the delivered in-game broadcast">
					<Icons.Eye className="h-4 w-4" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-96 space-y-2" align="end">
				<p className="text-xs text-muted-foreground">Broadcast text delivered to all players.</p>
				<TemplateSyntaxHint />
				<MessagePreviewBox>{rendered}</MessagePreviewBox>
			</PopoverContent>
		</Popover>
	)
}

// minimally-styled uncontrolled textarea cell: seeded from value$, edits debounced upward, re-read on reset$
function TextAreaCell(
	{ value$, reset$, onChange, placeholder }: {
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: string) => void
		placeholder?: string
	},
) {
	const ref = React.useRef<HTMLTextAreaElement>(null)
	const format = (v: any) => v === null || v === undefined ? '' : String(v)
	const push = useDebounced<string>({ delay: DEBOUNCE_MS, onChange })
	useReset(reset$, () => {
		const formatted = format(value$.getValue())
		if (ref.current && ref.current.value !== formatted) {
			ref.current.value = formatted
			push(formatted)
		}
	})
	return (
		<Textarea
			ref={ref}
			rows={2}
			placeholder={placeholder}
			className="min-h-9 resize-y rounded-none border-0 shadow-none focus-visible:ring-0 px-2 py-1 font-mono text-xs"
			defaultValue={format(value$.getValue())}
			onChange={(e) => push(e.currentTarget.value)}
		/>
	)
}

// aliases are edited as space/comma-separated text in a single cell and stored as string[] (aliases can't
// contain whitespace, so the separators are unambiguous)
function AliasesCell(
	{ value$, reset$, onChange }: { value$: ValueState; reset$: Rx.Subject<void>; onChange: (v: string[]) => void },
) {
	const ref = React.useRef<HTMLInputElement>(null)
	const format = (v: string[] | undefined) => (v ?? []).join(' ')
	const parse = (text: string) => text.split(/[,\s]+/).filter(Boolean)
	const push = useDebounced<string[]>({ delay: DEBOUNCE_MS, onChange })
	useReset(reset$, () => {
		const formatted = format(value$.getValue())
		if (ref.current && ref.current.value !== formatted) {
			ref.current.value = formatted
			push(parse(formatted))
		}
	})
	return (
		<Input
			ref={ref}
			defaultValue={format(value$.getValue())}
			placeholder="tk afk"
			onChange={(e) => push(parse(e.currentTarget.value))}
		/>
	)
}

// copy-on-write set at a nested path (arrays stay arrays)
function setAtPath(root: any, path: Path, value: unknown): any {
	if (path.length === 0) return value
	const [head, ...rest] = path
	const base = root ?? (typeof head === 'number' ? [] : {})
	const copy: any = Array.isArray(base) ? [...base] : { ...base }
	copy[head as any] = setAtPath(base?.[head as any], rest, value)
	return copy
}

// hook: current value at a nested path of value$, kept in sync on emissions and reset$
function usePathValue(value$: ValueState, reset$: Rx.Observable<void>, path: Path): unknown {
	const key = JSON.stringify(path)
	const [v, setV] = React.useState<unknown>(() => getAtPath(value$.getValue(), path))
	React.useEffect(() => {
		const p = JSON.parse(key) as Path
		const sub = new Rx.Subscription()
		sub.add(value$.subscribe((root) => setV(getAtPath(root, p))))
		sub.add(reset$.subscribe(() => setV(getAtPath(value$.getValue(), p))))
		return () => sub.unsubscribe()
	}, [value$, reset$, key])
	return v
}

// PoolConfigApi over the form's draft observable, so the settings page renders the same pool-configuration UI as the
// dashboard popover. Paths are relative to the pool object this override is mounted on (queue.mainPool / generationPool).
function usePoolConfigApi({ value$, reset$, onChange }: OverrideProps): PoolConfigApi {
	const [resetKey, setResetKey] = React.useState(0)
	useReset(reset$, () => setResetKey((k) => k + 1))
	return {
		// oxlint-disable-next-line rules-of-hooks -- stable call site inside the panel components
		useValue: (path) => usePathValue(value$, reset$, path),
		getValue: (path) => getAtPath(value$.getValue(), path),
		set: (path, value) => onChange(setAtPath(value$.getValue(), path, value)),
		// the settings page gates edit access via the server-settings:* perms; out-of-grant writes are rejected server-side
		writeDenied: null,
		resetKey,
	}
}

// server settings reference the global settings' named admin list sources; pick from the defined names instead of
// typing them. Unknown/stale names stay selectable so they remain visible and removable.
function AdminListSourceNamesField({ value$, reset$, onChange }: OverrideProps) {
	const value = (useFieldValue(value$, reset$) as string[] | undefined) ?? []
	const names = ZusUtils.useStore(SettingsClient.PublicSettingsStore, (s) => s?.adminListSourceNames) ?? []
	const options = [...new Set([...names, ...value])]
	return (
		<div className="space-y-1">
			<ComboBoxMulti
				title="Admin list source"
				values={value}
				options={options}
				onSelect={(next) => onChange(typeof next === 'function' ? next(value) : next)}
			/>
			{names.length === 0 && (
				<p className="text-xs text-muted-foreground">
					No named sources are defined yet; add them under Global Settings → Admin List Sources.
				</p>
			)}
		</div>
	)
}

function MainPoolField(props: OverrideProps) {
	const api = usePoolConfigApi(props)
	return (
		<div className="space-y-6">
			<MainPoolFiltersPanel api={api} />
			<RepeatRulesPanel poolId="mainPool" api={api} />
		</div>
	)
}

function GenerationPoolField(props: OverrideProps) {
	const api = usePoolConfigApi(props)
	return (
		<div className="space-y-6">
			<GenerationPoolFiltersPanel api={api} />
			<RepeatRulesPanel poolId="generationPool" api={api} />
		</div>
	)
}

// -------- rbac settings-grant pickers --------

// every dotted object path in a settings schema, in declaration order: the paths a settings grant may address.
// Stops at arrays/records since grants target the static object tree, not indices or dynamic keys.
function enumerateGrantPaths(node: Node, prefix = ''): string[] {
	const { inner } = stripNullable(node)
	if (inner?.type !== 'object' || !inner.properties || (inner.additionalProperties && typeof inner.additionalProperties === 'object')) {
		return []
	}
	const out: string[] = []
	for (const [key, child] of Object.entries(inner.properties as Record<string, Node>)) {
		const p = prefix ? `${prefix}.${key}` : key
		out.push(p, ...enumerateGrantPaths(child, p))
	}
	return out
}

let cachedGlobalGrantPaths: string[] | undefined
function globalGrantPathOptions(): string[] {
	cachedGlobalGrantPaths ??= enumerateGrantPaths(z.toJSONSchema(SETTINGS.GlobalSettingsSchema, { io: 'input', unrepresentable: 'any' }))
	return cachedGlobalGrantPaths
}

// connections is excluded: it's gated by server-settings:write-sensitive, never by path grants
let cachedServerGrantPaths: string[] | undefined
function serverGrantPathOptions(): string[] {
	cachedServerGrantPaths ??= enumerateGrantPaths(z.toJSONSchema(SETTINGS.ServerSettingsSchema, { io: 'input', unrepresentable: 'any' }))
		.filter((p) => p !== 'connections' && !p.startsWith('connections.'))
	return cachedServerGrantPaths
}

// -------- consolidated rbac editor --------
//
// The whole `rbac` node renders as one master-detail editor: pick a role on the left, edit everything about it on the
// right. This mirrors the persisted shape, where each role is one object under `roles[roleId]` holding its permissions,
// timeout cap, settings grants and assignments.

const SERVER_GRANT_ACCESS_OPTIONS = ['read', 'write', 'write-sensitive'] as const
const VALID_ROLE_ID = /^[a-z0-9-]{3,32}$/

type ServerGrant = { access: string; serverIds?: string[]; paths?: string[] }
type RoleAssignmentsValue = { discordRoleIds?: (string | number)[]; discordUserIds?: (string | number)[]; everyMember?: boolean }
type RoleConfig = {
	permissions?: string[]
	maxTimeout?: string
	globalSettingsGrants?: string[]
	serverSettingsGrants?: ServerGrant[]
	assignments?: RoleAssignmentsValue
}
type RbacValue = { roles?: Record<string, RoleConfig> }

// apply `fn` to the whole rbac object, then poke reset$ so any uncontrolled inputs (the timeout duration field) re-read.
// `quiet` skips reset$ for edits driven by an uncontrolled input, where re-emitting would clobber an in-flight keystroke.
type RbacUpdate = (fn: (rbac: RbacValue) => RbacValue, quiet?: boolean) => void

// set/replace one role's config immutably
function withRoleConfig(rbac: RbacValue, roleId: string, fn: (cfg: RoleConfig) => RoleConfig): RbacValue {
	const roles = { ...(rbac.roles ?? {}) }
	roles[roleId] = fn(roles[roleId] ?? {})
	return { ...rbac, roles }
}

// set a config field, dropping it when empty so the persisted role stays free of empty maps/arrays
function setRoleField<K extends keyof RoleConfig>(cfg: RoleConfig, key: K, val: RoleConfig[K] | undefined): RoleConfig {
	const next = { ...cfg }
	if (val === undefined || (Array.isArray(val) && val.length === 0)) delete next[key]
	else next[key] = val as RoleConfig[K]
	return next
}

// merge into a role's assignments, dropping the whole `assignments` object once nothing is assigned
function withAssignments(cfg: RoleConfig, patch: Partial<RoleAssignmentsValue>): RoleConfig {
	const a: RoleAssignmentsValue = { ...cfg.assignments, ...patch }
	const empty = (a.discordRoleIds?.length ?? 0) === 0 && (a.discordUserIds?.length ?? 0) === 0 && !a.everyMember
	return setRoleField(cfg, 'assignments', empty ? undefined : a)
}

function isRoleAssigned(cfg: RoleConfig | undefined): boolean {
	const a = cfg?.assignments
	return !!a && ((a.discordRoleIds?.length ?? 0) > 0 || (a.discordUserIds?.length ?? 0) > 0 || !!a.everyMember)
}

function withRoleRemoved(rbac: RbacValue, roleId: string): RbacValue {
	const roles = { ...(rbac.roles ?? {}) }
	delete roles[roleId]
	return { ...rbac, roles }
}

function withRoleRenamed(rbac: RbacValue, oldId: string, newId: string): RbacValue {
	const roles: Record<string, RoleConfig> = {}
	for (const [k, v] of Object.entries(rbac.roles ?? {})) roles[k === oldId ? newId : k] = v
	return { ...rbac, roles }
}

function RbacBody({ value$, reset$, onChange }: { value$: ValueState; reset$: Rx.Subject<void>; onChange: (v: any) => void }) {
	const rbac = (useFieldValue(value$, reset$) as RbacValue) ?? {}
	const roleIds = Object.keys(rbac.roles ?? {})
	const issues = React.useContext(ValidationContext).filter((i) => i.path.startsWith('rbac.'))

	const [selected, setSelected] = React.useState<string | null>(roleIds[0] ?? null)
	React.useEffect(() => {
		if (selected && roleIds.includes(selected)) return
		setSelected(roleIds[0] ?? null)
	}, [selected, roleIds])

	// `quiet` skips reset$: use it for edits driven by an uncontrolled input (the timeout duration field), where re-emitting
	// would clobber an in-flight keystroke. Structural edits (add/remove/rename/toggles) leave it off so inputs re-seed.
	const update = React.useCallback<RbacUpdate>((fn, quiet) => {
		onChange(fn((value$.getValue() as RbacValue) ?? {}))
		if (!quiet) reset$.next()
	}, [onChange, value$, reset$])

	const [newRole, setNewRole] = React.useState('')
	const canAdd = VALID_ROLE_ID.test(newRole) && !(newRole in (rbac.roles ?? {}))
	function addRole() {
		if (!canAdd) return
		update((r) => ({ ...r, roles: { ...(r.roles ?? {}), [newRole]: { permissions: [] } } }))
		setSelected(newRole)
		setNewRole('')
	}
	// explicit empty roles (not undefined) so it stays cleared rather than re-triggering the schema's preset default
	function clearAll() {
		update((r) => ({ ...r, roles: {} }))
		setSelected(null)
	}

	return (
		<div className="space-y-3">
			{issues.length > 0 && (
				<div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 space-y-0.5">
					{issues.map((i, n) => (
						// oxlint-disable-next-line no-array-index-key
						<p key={n} className="flex items-start gap-1.5 text-xs text-destructive">
							<Icons.TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
							<span>
								<code className="text-[10px]">{i.path}</code> {i.message}
							</span>
						</p>
					))}
				</div>
			)}
			{roleIds.length > 0 && (
				<div className="flex items-center justify-between">
					<p className="text-xs text-muted-foreground">{roleIds.length} role{roleIds.length === 1 ? '' : 's'} defined</p>
					<Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={clearAll}>
						<Icons.Trash2 className="mr-1 h-4 w-4" />
						Clear all
					</Button>
				</div>
			)}
			<div className="grid grid-cols-[minmax(160px,14rem)_1fr] gap-4">
				<div className="sticky top-2 self-start max-h-[70vh] overflow-y-auto space-y-2 pr-1">
					<div className="space-y-1">
						{roleIds.length === 0 && <p className="text-xs text-muted-foreground">No roles defined yet.</p>}
						{roleIds.map((id) => (
							<button
								key={id}
								type="button"
								onClick={() => setSelected(id)}
								className={cn(
									'flex w-full items-center gap-1.5 rounded-md border px-2 py-1.5 text-left font-mono text-sm',
									id === selected ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent/50',
								)}
							>
								<span className="truncate">{id}</span>
								{!isRoleAssigned(rbac.roles?.[id]) && (
									<Tooltip>
										<TooltipTrigger asChild>
											<Icons.TriangleAlert className="ml-auto h-3 w-3 shrink-0 text-amber-600 dark:text-amber-500" />
										</TooltipTrigger>
										<TooltipContent>No assignments, so this role is never granted to anyone</TooltipContent>
									</Tooltip>
								)}
							</button>
						))}
					</div>
					<div className="flex items-center gap-1.5 pt-1">
						<Input
							className="h-8 font-mono"
							placeholder="new-role-id"
							value={newRole}
							onChange={(e) => setNewRole(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault()
									addRole()
								}
							}}
						/>
						<Button type="button" size="icon" variant="outline" className="h-8 w-8 shrink-0" disabled={!canAdd} onClick={addRole}>
							<Icons.Plus className="h-4 w-4" />
						</Button>
					</div>
				</div>
				{selected
					? (
						<RoleDetail
							key={selected}
							roleId={selected}
							rbac={rbac}
							value$={value$}
							reset$={reset$}
							update={update}
							assigned={isRoleAssigned(rbac.roles?.[selected])}
						/>
					)
					: <p className="self-start text-sm text-muted-foreground">Select or add a role to configure it.</p>}
			</div>
		</div>
	)
}

function RoleSubsection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
	return (
		<section className="space-y-1.5">
			<h4 className="text-sm font-semibold">{title}</h4>
			{description && <p className="text-xs text-muted-foreground">{description}</p>}
			{children}
		</section>
	)
}

function RoleDetail(
	{ roleId, rbac, value$, reset$, update, assigned }: {
		roleId: string
		rbac: RbacValue
		value$: ValueState
		reset$: Rx.Subject<void>
		update: RbacUpdate
		assigned: boolean
	},
) {
	const [renaming, setRenaming] = React.useState(false)
	const cfg = rbac.roles?.[roleId] ?? {}
	// scoped value-state for the timeout duration field so it can reuse the uncontrolled TextInputField
	const timeout$ = React.useMemo(() => scopeValue(scopeValue(scopeValue(value$, 'roles'), roleId), 'maxTimeout'), [value$, roleId])
	const hasTimeout = cfg.maxTimeout !== undefined

	return (
		<div className="min-w-0 space-y-4 rounded-md border p-3">
			<div className="flex items-center gap-2">
				{renaming
					? (
						<Input
							autoFocus
							className="h-8 max-w-[16rem] font-mono"
							defaultValue={roleId}
							onBlur={(e) => {
								const next = e.target.value.trim()
								setRenaming(false)
								if (next && next !== roleId && VALID_ROLE_ID.test(next) && !(next in (rbac.roles ?? {}))) {
									update((r) => withRoleRenamed(r, roleId, next))
								}
							}}
							onKeyDown={(e) => {
								if (e.key === 'Enter') e.currentTarget.blur()
								if (e.key === 'Escape') setRenaming(false)
							}}
						/>
					)
					: (
						<>
							<h3 className="font-mono text-base font-semibold">{roleId}</h3>
							<Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => setRenaming(true)}>
								<Icons.Pencil className="h-3.5 w-3.5" />
							</Button>
						</>
					)}
				<Button
					type="button"
					size="sm"
					variant="ghost"
					className="ml-auto text-destructive"
					onClick={() => update((r) => withRoleRemoved(r, roleId))}
				>
					<Icons.Trash2 className="mr-1 h-4 w-4" />
					Delete role
				</Button>
			</div>

			<RoleSubsection
				title="Global Permissions"
				description="Global-scope permissions. Settings permissions granted here are unrestricted (all servers / all settings); use the grants below to restrict them."
			>
				<PermissionExpressionEditor
					value={cfg.permissions}
					onChange={(v) => update((r) => withRoleConfig(r, roleId, (c) => ({ ...c, permissions: v })))}
				/>
			</RoleSubsection>

			<RoleSubsection
				title="Kick timeouts"
				description="The maximum kick-timeout duration this role may issue (e.g. 2h). Super users/roles are unlimited."
			>
				<div className="flex items-center gap-3">
					<div className="flex items-center gap-2">
						<Switch
							checked={hasTimeout}
							onCheckedChange={(on) =>
								update((r) => withRoleConfig(r, roleId, (c) => setRoleField(c, 'maxTimeout', on ? '1h' : undefined)))}
						/>
						<span className="text-sm">May issue kick timeouts</span>
					</div>
					{hasTimeout && (
						<div className="w-32">
							<TextInputField
								value$={timeout$}
								reset$={reset$}
								onChange={(v) =>
									update((r) => withRoleConfig(r, roleId, (c) => setRoleField(c, 'maxTimeout', (v as string) || '1h')), true)}
								numeric={false}
								placeholder="2h"
							/>
						</div>
					)}
				</div>
			</RoleSubsection>

			<RoleSubsection
				title="Global settings grants"
				description='Dotted setting paths this role may edit (e.g. "vote.voteDuration", or "vote" for the whole section). Any grant also lets the role view global settings.'
			>
				<ComboBoxMulti
					title="setting path"
					className="w-full max-w-[28rem] font-mono"
					values={cfg.globalSettingsGrants ?? []}
					options={globalGrantPathOptions()}
					onSelect={(next) =>
						update((r) =>
							withRoleConfig(r, roleId, (c) => {
								const resolved = typeof next === 'function' ? next(c.globalSettingsGrants ?? []) : next
								return setRoleField(c, 'globalSettingsGrants', resolved)
							})
						)}
				/>
			</RoleSubsection>

			<RoleSubsection
				title="Server settings grants"
				description="Per-server restricted read/write grants. Any grant also lets the role view the server's non-sensitive settings."
			>
				<RoleServerGrantsEditor roleId={roleId} grants={cfg.serverSettingsGrants ?? []} update={update} />
			</RoleSubsection>

			<RoleSubsection title="Assignments" description="Which Discord roles, users, or members are granted this role.">
				<RoleAssignmentsEditor roleId={roleId} cfg={cfg} update={update} assigned={assigned} />
			</RoleSubsection>
		</div>
	)
}

function RoleServerGrantsEditor(
	{ roleId, grants, update }: { roleId: string; grants: ServerGrant[]; update: RbacUpdate },
) {
	const servers = ZusUtils.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers) ?? []
	const serverOptions: ComboBoxOption<string>[] = servers.map((s) => ({
		value: s.id,
		label: `${s.displayName} (${s.id})`,
		keywords: [s.displayName],
	}))

	function setGrants(next: ServerGrant[]) {
		update((r) => withRoleConfig(r, roleId, (c) => setRoleField(c, 'serverSettingsGrants', next)))
	}
	function patch(idx: number, patch: Partial<ServerGrant>) {
		setGrants(grants.map((g, i) => (i === idx ? { ...g, ...patch } : g)))
	}

	return (
		<div className="space-y-2">
			{grants.length === 0 && <p className="text-xs text-muted-foreground">No server grants.</p>}
			{grants.map((grant, idx) => {
				const options = grant.serverIds?.some((id) => !servers.some((s) => s.id === id))
					? [...grant.serverIds.filter((id) => !servers.some((s) => s.id === id)).map((id) => ({ value: id })), ...serverOptions]
					: serverOptions
				return (
					// oxlint-disable-next-line no-array-index-key
					<div key={idx} className="space-y-2 rounded-md border p-2">
						<div className="flex items-center gap-2">
							<Select value={grant.access} onValueChange={(v) => patch(idx, { access: v, ...(v !== 'write' ? { paths: [] } : {}) })}>
								<SelectTrigger className="h-8 w-48">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{SERVER_GRANT_ACCESS_OPTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
								</SelectContent>
							</Select>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="ml-auto h-8 w-8 text-destructive"
								onClick={() => setGrants(grants.filter((_, i) => i !== idx))}
							>
								<Icons.X className="h-4 w-4" />
							</Button>
						</div>
						<div className="space-y-1">
							<label className="text-xs text-muted-foreground">Servers (empty = all)</label>
							<ComboBoxMulti
								title="server"
								className="w-full max-w-[28rem]"
								values={grant.serverIds ?? []}
								options={options}
								onSelect={(next) => patch(idx, { serverIds: typeof next === 'function' ? next(grant.serverIds ?? []) : next })}
							/>
						</div>
						{grant.access === 'write' && (
							<div className="space-y-1">
								<label className="text-xs text-muted-foreground">Setting paths (empty = all non-sensitive)</label>
								<ComboBoxMulti
									title="setting path"
									className="w-full max-w-[28rem] font-mono"
									values={grant.paths ?? []}
									options={serverGrantPathOptions()}
									onSelect={(next) => patch(idx, { paths: typeof next === 'function' ? next(grant.paths ?? []) : next })}
								/>
							</div>
						)}
					</div>
				)
			})}
			<Button
				type="button"
				size="sm"
				variant="outline"
				onClick={() => setGrants([...grants, { access: 'write', serverIds: [], paths: [] }])}
			>
				<Icons.Plus className="mr-1 h-4 w-4" />
				Add grant
			</Button>
		</div>
	)
}

function RoleAssignmentsEditor(
	{ roleId, cfg, update, assigned }: { roleId: string; cfg: RoleConfig; update: RbacUpdate; assigned: boolean },
) {
	const roleAssignIds = (cfg.assignments?.discordRoleIds ?? []).map(String)
	const userAssignIds = (cfg.assignments?.discordUserIds ?? []).map(String)

	// replace `oldId` with `nextId` in one of the assignment id lists; '' as oldId adds, '' as nextId removes
	function changeAssignment(bucket: 'discordRoleIds' | 'discordUserIds', oldId: string, nextId: string) {
		if (nextId === oldId) return
		update((r) =>
			withRoleConfig(r, roleId, (c) => {
				const cur = (c.assignments?.[bucket] ?? []).map(String).filter((id) => id !== oldId)
				if (nextId && !cur.includes(nextId)) cur.push(nextId)
				return withAssignments(c, { [bucket]: cur })
			})
		)
	}
	const changeDiscordRole = (oldId: string, nextId: string) => changeAssignment('discordRoleIds', oldId, nextId)
	const changeDiscordUser = (oldId: string, nextId: string) => changeAssignment('discordUserIds', oldId, nextId)

	return (
		<div className="space-y-3">
			{!assigned && (
				<p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
					<Icons.TriangleAlert className="h-3 w-3 shrink-0" />
					This role has no assignments, so it is never granted to anyone.
				</p>
			)}
			<div className="flex items-center gap-2">
				<Switch
					checked={!!cfg.assignments?.everyMember}
					onCheckedChange={(on) => update((r) => withRoleConfig(r, roleId, (c) => withAssignments(c, { everyMember: on })))}
				/>
				<span className="text-sm">Granted to every server member</span>
			</div>

			<div className="space-y-1.5">
				<label className="text-xs text-muted-foreground">Discord roles</label>
				{roleAssignIds.map((id) => (
					<div key={id} className="flex items-center gap-2">
						<div className="min-w-0 flex-1 max-w-[24rem]">
							<DiscordRoleSelect value={id} onChange={(next) => changeDiscordRole(id, next)} />
						</div>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-8 w-8 text-destructive"
							onClick={() => changeDiscordRole(id, '')}
						>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
				))}
				<div className="max-w-[24rem]">
					<DiscordRoleSelect value="" onChange={(next) => next && changeDiscordRole('', next)} />
				</div>
			</div>

			<div className="space-y-1.5">
				<label className="text-xs text-muted-foreground">Discord users</label>
				{userAssignIds.map((id) => (
					<div key={id} className="flex items-center gap-2">
						<div className="min-w-0 flex-1 max-w-[24rem]">
							<DiscordMemberSelect value={id} onChange={(next) => changeDiscordUser(id, next)} />
						</div>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-8 w-8 text-destructive"
							onClick={() => changeDiscordUser(id, '')}
						>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
				))}
				<div className="max-w-[24rem]">
					<DiscordMemberSelect value="" onChange={(next) => next && changeDiscordUser('', next)} />
				</div>
			</div>
		</div>
	)
}

function overrideFor(path: Path, node: Node): React.FC<OverrideProps> | undefined {
	const last = path[path.length - 1]
	// the global `adminListSources` is a name-keyed record of source definitions (rendered generically); the
	// per-server one is an array of names referencing it, which gets the picker
	if (path.length === 1 && last === 'adminListSources' && stripNullable(node).inner.type === 'array') {
		return AdminListSourceNamesField
	}
	if (path.length === 1 && last === 'adminActionReasons') return AdminActionReasonsField
	if (path.length === 1 && last === 'broadcasts') return BroadcastsField
	if (path.length === 1 && last === 'layerTable') return LayerTableField
	if (path.length === 1 && last === 'layerGeneration') return LayerGenerationField
	if (path.length === 1 && last === 'playerFlagsRequiringNote') return FlagMultiSelectField
	if (path.length === 1 && last === 'playerFlagGroupings') return PlayerFlagGroupingsField
	// the entire `rbac` subtree is rendered by RbacBody (see FieldControl), so no per-field rbac overrides are needed here
	// server settings: the pool configuration reuses the dashboard popover's panels; connection passwords are masked
	if (path.length === 2 && path[0] === 'queue' && last === 'mainPool') return MainPoolField
	if (path.length === 2 && path[0] === 'queue' && last === 'generationPool') return GenerationPoolField
	if (last === 'password') return PasswordField
	return undefined
}

// -------- leaf controls --------

// uncontrolled text/number input: seeded from value$, edits debounced upward, re-read on reset$
function TextInputField(
	{ value$, reset$, onChange, numeric, secret, placeholder }: {
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: any) => void
		numeric: boolean
		secret?: boolean
		placeholder?: string
	},
) {
	const ref = React.useRef<HTMLInputElement>(null)
	const format = (v: any) => v === null || v === undefined ? '' : String(v)
	const push = useDebounced<any>({ delay: DEBOUNCE_MS, onChange })
	useReset(reset$, () => {
		const cur = value$.getValue()
		const formatted = format(cur)
		// only touch the DOM when it actually diverges (an in-flight edit, or a value changed elsewhere). Re-pushing the
		// current value supersedes any pending debounced edit so a reset can't be resurrected by a late-firing keystroke.
		if (ref.current && ref.current.value !== formatted) {
			ref.current.value = formatted
			push(numeric ? (formatted === '' ? '' : Number(formatted)) : formatted)
		}
	})
	return (
		<Input
			ref={ref}
			type={secret ? 'password' : numeric ? 'number' : 'text'}
			placeholder={placeholder}
			defaultValue={format(value$.getValue())}
			onChange={(e) => push(numeric ? (e.currentTarget.value === '' ? '' : e.currentTarget.valueAsNumber) : e.currentTarget.value)}
		/>
	)
}

function SelectField(
	{ value$, reset$, onChange, options }: { value$: ValueState; reset$: Rx.Subject<void>; onChange: (v: any) => void; options: string[] },
) {
	const value = useFieldValue(value$, reset$)
	return (
		<Select value={value ?? ''} onValueChange={onChange}>
			<SelectTrigger className="w-full">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((opt) => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}
			</SelectContent>
		</Select>
	)
}

function SwitchField({ value$, reset$, onChange }: { value$: ValueState; reset$: Rx.Subject<void>; onChange: (v: any) => void }) {
	const value = useFieldValue(value$, reset$)
	return <Switch checked={!!value} onCheckedChange={onChange} />
}

// discriminated union: a variant picker keyed to the discriminator const, plus the active branch's object fields
// (the discriminator field itself is chosen by the picker, so it isn't rendered as an editable property).
function DiscriminatedUnionField(
	{ path, value$, reset$, onChange, branches, discriminator }: {
		path: Path
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: any) => void
		branches: Node[]
		discriminator: string
	},
) {
	const value = useFieldValue(value$, reset$) as any
	const branchFor = (constVal: string) => branches.find((b) => String(b.properties[discriminator].const) === constVal)
	const active = value?.[discriminator]
	const branch = branchFor(String(active)) ?? branches[0]
	// hide the discriminator from the rendered fields; it's set by the picker (and carried in the value)
	const branchProps = Object.fromEntries(Object.entries(branch.properties).filter(([k]) => k !== discriminator))
	const branchNode: Node = { ...branch, properties: branchProps }
	return (
		<div className="space-y-2">
			<Select
				value={String(active ?? '')}
				onValueChange={(next) => {
					const b = branchFor(next)
					if (b) {
						onChange(emptyValue(b))
						reset$.next()
					}
				}}
			>
				<SelectTrigger className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{branches.map((b) => {
						const opt = String(b.properties[discriminator].const)
						return <SelectItem key={opt} value={opt}>{settingLabel([...path, discriminator, opt], opt)}</SelectItem>
					})}
				</SelectContent>
			</Select>
			<ObjectField node={branchNode} path={path} value$={value$} reset$={reset$} onChange={onChange} />
		</div>
	)
}

function EnumArrayField(
	{ value$, reset$, onChange, options }: { value$: ValueState; reset$: Rx.Subject<void>; onChange: (v: any) => void; options: string[] },
) {
	const value = useFieldValue(value$, reset$) as any[]
	return (
		<ComboBoxMulti
			title="Value"
			values={value ?? []}
			options={options}
			onSelect={(next) => onChange(typeof next === 'function' ? next(value ?? []) : next)}
		/>
	)
}

// nullable scalar: an "unset" checkbox toggles between null and the field's empty value; the inner control reads value$
function NullableField(
	{ inner, value$, reset$, onChange, children }: {
		inner: Node
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: any) => void
		children: React.ReactNode
	},
) {
	const value = useFieldValue(value$, reset$)
	const isNull = value === null || value === undefined
	return (
		<div className="flex items-center gap-2">
			<label className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
				<Checkbox
					checked={isNull}
					onCheckedChange={(c) => {
						onChange(c ? null : emptyValue(inner))
						reset$.next()
					}}
				/>
				unset
			</label>
			{!isNull && <div className="flex-1 min-w-0">{children}</div>}
		</div>
	)
}

function wrapNullable(
	nullable: boolean,
	child: React.ReactNode,
	inner: Node,
	value$: ValueState,
	reset$: Rx.Subject<void>,
	onChange: (v: any) => void,
): React.ReactNode {
	if (!nullable) return child
	return (
		<NullableField inner={inner} value$={value$} reset$={reset$} onChange={onChange}>
			{child}
		</NullableField>
	)
}

// placeholder for a text/number input: the schema default when there is one (doubles as a format hint, e.g. '5m'),
// an example duration for HumanTime fields without one, otherwise the humanized field name
function placeholderFor(node: Node, inner: Node, path: Path): string | undefined {
	const def = effectiveDefault(node)
	if (def.has && def.value !== '' && (typeof def.value === 'string' || typeof def.value === 'number')) return String(def.value)
	if (isStringOrNumber(inner)) return 'e.g. 30m'
	const last = path[path.length - 1]
	return typeof last === 'string' ? humanize(last) : undefined
}

function FieldControl(
	{ node, path, value$, reset$, onChange }: {
		node: Node
		path: Path
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: any) => void
	},
) {
	const Override = overrideFor(path, node)
	if (Override) return <Override value$={value$} reset$={reset$} onChange={onChange} path={path} />

	// the whole rbac subtree renders as one consolidated per-role editor (kept inside the standard section shell so its
	// header + super-users callout + reset controls are preserved)
	if (path.length === 1 && path[0] === 'rbac') return <RbacBody value$={value$} reset$={reset$} onChange={onChange} />

	const { inner, nullable } = stripNullable(node)

	// discriminated union -> variant picker + active branch fields
	const du = discriminatedUnion(inner)
	if (du) {
		return (
			<DiscriminatedUnionField
				path={path}
				value$={value$}
				reset$={reset$}
				onChange={onChange}
				branches={du.branches}
				discriminator={du.discriminator}
			/>
		)
	}

	// enum -> select
	if (inner.enum && inner.type !== 'array') {
		return wrapNullable(
			nullable,
			<SelectField value$={value$} reset$={reset$} onChange={onChange} options={inner.enum} />,
			inner,
			value$,
			reset$,
			onChange,
		)
	}

	// string | number (HumanTime etc.) -> text input
	if (isStringOrNumber(inner)) {
		return wrapNullable(
			nullable,
			<TextInputField
				value$={value$}
				reset$={reset$}
				onChange={onChange}
				numeric={false}
				placeholder={placeholderFor(node, inner, path)}
			/>,
			inner,
			value$,
			reset$,
			onChange,
		)
	}

	if (inner.type === 'boolean') {
		return <SwitchField value$={value$} reset$={reset$} onChange={onChange} />
	}

	if (inner.type === 'integer' || inner.type === 'number') {
		return wrapNullable(
			nullable,
			<TextInputField value$={value$} reset$={reset$} onChange={onChange} numeric placeholder={placeholderFor(node, inner, path)} />,
			inner,
			value$,
			reset$,
			onChange,
		)
	}

	if (inner.type === 'string') {
		return wrapNullable(
			nullable,
			<TextInputField
				value$={value$}
				reset$={reset$}
				onChange={onChange}
				numeric={false}
				placeholder={placeholderFor(node, inner, path)}
			/>,
			inner,
			value$,
			reset$,
			onChange,
		)
	}

	if (inner.type === 'array') {
		return <ArrayField node={inner} path={path} value$={value$} reset$={reset$} onChange={onChange} />
	}

	if (inner.type === 'object') {
		if (inner.additionalProperties && typeof inner.additionalProperties === 'object') {
			return <RecordField node={inner} path={path} value$={value$} reset$={reset$} onChange={onChange} />
		}
		return <ObjectField node={inner} path={path} value$={value$} reset$={reset$} onChange={onChange} />
	}

	// fallback for anything the walker can't render structurally
	return <JsonFallback value$={value$} reset$={reset$} onChange={onChange} />
}

function ArrayField(
	{ node, path, value$, reset$, onChange }: {
		node: Node
		path: Path
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: any[]) => void
	},
) {
	const items: Node = node.items ?? {}
	const { inner } = stripNullable(items)

	// array of enum -> multi-select
	if (inner.enum && inner.type !== 'array' && inner.type !== 'object') {
		return <EnumArrayField value$={value$} reset$={reset$} onChange={onChange} options={inner.enum} />
	}

	const value = (useFieldValue(value$, reset$) as any[]) ?? []
	const isPrimitive = inner.type === 'string' || inner.type === 'integer' || inner.type === 'number' || isStringOrNumber(inner)

	// structural edits emit reset$ so uncontrolled item inputs re-read after re-indexing
	function structural(next: any[]) {
		onChange(next)
		reset$.next()
	}

	return (
		<div className="space-y-1.5">
			{value.length === 0 && <p className="text-xs text-muted-foreground">Empty.</p>}
			{value.map((_, idx) => (
				// list items have no stable id (primitives / freshly-added objects), so index is the pragmatic key here
				<ArrayItem
					// oxlint-disable-next-line no-array-index-key
					key={idx}
					items={items}
					path={path}
					idx={idx}
					parent$={value$}
					reset$={reset$}
					parentOnChange={onChange}
					isPrimitive={isPrimitive}
					onRemove={() => structural(((value$.getValue() as any[]) ?? []).filter((_, i) => i !== idx))}
				/>
			))}
			<Button
				type="button"
				size="sm"
				variant="outline"
				onClick={() => structural([...((value$.getValue() as any[]) ?? []), emptyValue(items)])}
			>
				<Icons.Plus className="h-4 w-4" />
				Add
			</Button>
		</div>
	)
}

function ArrayItem(
	{ items, path, idx, parent$, reset$, parentOnChange, isPrimitive, onRemove }: {
		items: Node
		path: Path
		idx: number
		parent$: ValueState
		reset$: Rx.Subject<void>
		parentOnChange: (v: any[]) => void
		isPrimitive: boolean
		onRemove: () => void
	},
) {
	const value$ = React.useMemo(() => scopeValue(parent$, idx), [parent$, idx])
	const onChange = React.useCallback((v: any) => {
		const arr = [...((parent$.getValue() as any[]) ?? [])]
		arr[idx] = v
		parentOnChange(arr)
	}, [parentOnChange, parent$, idx])
	return (
		<div className={cn('flex gap-2', isPrimitive ? 'items-center' : 'items-start')}>
			<div className={cn('flex-1 min-w-0', !isPrimitive && 'border rounded-md p-2')}>
				<FieldControl node={items} path={[...path, idx]} value$={value$} reset$={reset$} onChange={onChange} />
			</div>
			<Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive shrink-0" onClick={onRemove}>
				<Icons.X className="h-4 w-4" />
			</Button>
		</div>
	)
}

function RecordField(
	{ node, path, value$, reset$, onChange }: {
		node: Node
		path: Path
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: Record<string, any>) => void
	},
) {
	const valueNode: Node = node.additionalProperties
	// when the schema constrains keys to a known set (z.partialRecord / propertyNames enum), the key becomes a fixed picker
	// rather than free text, so only known keys can be added
	const keyEnum: string[] | undefined = node.propertyNames?.enum
	const [newKey, setNewKey] = React.useState('')
	const value = (useFieldValue(value$, reset$) as Record<string, any>) ?? {}
	const entries = Object.entries(value)

	// structural edits emit reset$ so uncontrolled entry inputs re-read
	function structural(next: Record<string, any>) {
		onChange(next)
		reset$.next()
	}

	function rename(oldKey: string, nextKey: string) {
		const cur = (value$.getValue() as Record<string, any>) ?? {}
		if (nextKey === oldKey || nextKey in cur) return
		const next: Record<string, any> = {}
		for (const [k, v] of Object.entries(cur)) next[k === oldKey ? nextKey : k] = v
		structural(next)
	}

	function add(key: string) {
		const cur = (value$.getValue() as Record<string, any>) ?? {}
		if (!key || key in cur) return
		structural({ ...cur, [key]: emptyValue(valueNode) })
		setNewKey('')
	}

	function remove(key: string) {
		const next = { ...((value$.getValue() as Record<string, any>) ?? {}) }
		delete next[key]
		structural(next)
	}

	const remainingKeys = keyEnum?.filter((k) => !(k in value)) ?? []

	return (
		<div className="space-y-2">
			{entries.length === 0 && <p className="text-xs text-muted-foreground">No entries.</p>}
			{entries.map(([key]) => (
				<RecordEntry
					key={key}
					valueNode={valueNode}
					path={path}
					entryKey={key}
					fixedKey={!!keyEnum}
					parent$={value$}
					reset$={reset$}
					parentOnChange={onChange}
					onRename={(next) => rename(key, next)}
					onRemove={() => remove(key)}
				/>
			))}
			{keyEnum
				? (remainingKeys.length > 0 && (
					<Select value="" onValueChange={add}>
						<SelectTrigger className="h-8 max-w-[16rem]">
							<SelectValue placeholder="Add…" />
						</SelectTrigger>
						<SelectContent>
							{remainingKeys.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
						</SelectContent>
					</Select>
				))
				: (
					<div className="flex items-center gap-2">
						<Input
							className="font-mono h-8 max-w-[16rem]"
							placeholder="new key"
							value={newKey}
							onChange={(e) => setNewKey(e.target.value)}
						/>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={!newKey.trim() || newKey.trim() in value}
							onClick={() => add(newKey.trim())}
						>
							<Icons.Plus className="h-4 w-4" />
							Add
						</Button>
					</div>
				)}
		</div>
	)
}

function RecordEntry(
	{ valueNode, path, entryKey, fixedKey, parent$, reset$, parentOnChange, onRename, onRemove }: {
		valueNode: Node
		path: Path
		entryKey: string
		fixedKey: boolean
		parent$: ValueState
		reset$: Rx.Subject<void>
		parentOnChange: (v: Record<string, any>) => void
		onRename: (next: string) => void
		onRemove: () => void
	},
) {
	const value$ = React.useMemo(() => scopeValue(parent$, entryKey), [parent$, entryKey])
	const onChange = React.useCallback(
		(v: any) => parentOnChange({ ...((parent$.getValue() as Record<string, any>) ?? {}), [entryKey]: v }),
		[parentOnChange, parent$, entryKey],
	)
	return (
		<div className="border rounded-md p-2 space-y-1.5">
			<div className="flex items-center gap-2">
				{fixedKey
					? <span className="font-mono text-sm">{entryKey}</span>
					: (
						<Input
							className="font-mono h-8 max-w-[16rem]"
							defaultValue={entryKey}
							onBlur={(e) => onRename(e.target.value.trim())}
						/>
					)}
				<Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive ml-auto" onClick={onRemove}>
					<Icons.X className="h-4 w-4" />
				</Button>
			</div>
			<FieldControl node={valueNode} path={[...path, entryKey]} value$={value$} reset$={reset$} onChange={onChange} />
		</div>
	)
}

function ObjectField(
	{ node, path, value$, reset$, onChange }: {
		node: Node
		path: Path
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: Record<string, any>) => void
	},
) {
	const props: Record<string, Node> = node.properties ?? {}
	return (
		<div className="space-y-3">
			{Object.entries(props).map(([key, childNode]) => (
				<Field key={key} name={key} node={childNode} path={[...path, key]} parent$={value$} parentOnChange={onChange} reset$={reset$} />
			))}
		</div>
	)
}

// the value a field falls back to. For prefaulted object sections the node default is often a bare {}, so we reconstruct
// from child defaults to get the real nested default (used for both the "Default:" hint and reset-to-default). A key the
// object's own default already provides wins over the child default (it's the more specific value, e.g. rbac's preset).
const defaultCache = new WeakMap<object, { has: boolean; value: unknown }>()
function effectiveDefault(node: Node): { has: boolean; value: unknown } {
	if (node && typeof node === 'object' && defaultCache.has(node)) return defaultCache.get(node)!
	const { inner } = stripNullable(node)
	const explicit = node?.default !== undefined ? node.default : inner?.default
	let result: { has: boolean; value: unknown }
	if (inner?.type === 'object' && inner.properties) {
		const base = explicit && typeof explicit === 'object' && !Array.isArray(explicit) ? { ...explicit } : {}
		let has = explicit !== undefined
		for (const key of Object.keys(inner.properties)) {
			if (key in base) continue
			const d = effectiveDefault(inner.properties[key])
			if (d.has) {
				;(base as Record<string, unknown>)[key] = d.value
				has = true
			}
		}
		result = { has, value: base }
	} else if (explicit !== undefined) {
		result = { has: true, value: explicit }
	} else {
		result = { has: false, value: undefined }
	}
	if (node && typeof node === 'object') defaultCache.set(node, result)
	return result
}

function formatDefaultValue(val: unknown): string {
	if (val === null) return 'unset'
	if (typeof val === 'boolean') return val ? 'on' : 'off'
	if (typeof val === 'string') return val === '' ? '(empty)' : val
	if (typeof val === 'number') return String(val)
	return JSON.stringify(val)
}

function isScalarNode(inner: Node): boolean {
	if (inner?.enum && inner.type !== 'array') return true
	if (isStringOrNumber(inner)) return true
	return inner?.type === 'string' || inner?.type === 'number' || inner?.type === 'integer' || inner?.type === 'boolean'
}

// a ghost icon button with a tooltip that still shows when the button is disabled: the wrapping span keeps receiving
// hover events even though the disabled button sets `pointer-events-none`.
function TooltipButton(
	{ disabled, tooltip, onClick, children }: {
		disabled: boolean
		tooltip: string
		onClick: () => void
		children: React.ReactNode
	},
) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="inline-flex">
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className="h-6 w-6 shrink-0 text-muted-foreground"
						disabled={disabled}
						onClick={onClick}
					>
						{children}
					</Button>
				</span>
			</TooltipTrigger>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	)
}

// the per-field reset affordances: reset-to-saved (undo local edits back to the persisted baseline) and, when the field
// has a schema default, a "default: <value>" hint plus reset-to-default. Both buttons stay mounted and disable when the
// current value already matches their target, so the affordance is discoverable and its tooltip explains the state.
function FieldResetControls(
	{ value$, reset$, onChange, node, path, showDefaultLabel }: {
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: any) => void
		node: Node
		path: Path
		showDefaultLabel: boolean
	},
) {
	const value = useFieldValue(value$, reset$)
	const { saved } = React.useContext(SavedRootContext)
	const def = effectiveDefault(node)
	const savedValue = getAtPath(saved, path)
	const canResetSaved = saved !== undefined && !Obj.deepEqual(value, savedValue)
	const canResetDefault = def.has && !Obj.deepEqual(value, def.value)

	function resetTo(v: unknown) {
		onChange(structuredClone(v))
		reset$.next()
	}

	return (
		<div className="flex items-center gap-1 shrink-0">
			<TooltipButton
				disabled={!canResetSaved}
				tooltip={canResetSaved ? 'Reset to saved value' : 'Already matches the saved value'}
				onClick={() => resetTo(savedValue)}
			>
				<Icons.RotateCcw className="h-3.5 w-3.5" />
			</TooltipButton>
			{def.has && (
				<>
					{showDefaultLabel && (
						<span className="text-xs text-muted-foreground max-w-[12rem] truncate" title={formatDefaultValue(def.value)}>
							default: {formatDefaultValue(def.value)}
						</span>
					)}
					<TooltipButton
						disabled={!canResetDefault}
						tooltip={canResetDefault ? `Reset to default (${formatDefaultValue(def.value)})` : 'Already matches the default'}
						onClick={() => resetTo(def.value)}
					>
						<Icons.CornerDownLeft className="h-3.5 w-3.5" />
					</TooltipButton>
				</>
			)}
		</div>
	)
}

// an anchor to this field's fragment; shown on hover of its labeled row (the row carries `group`)
function AnchorLink({ domId }: { domId: string }) {
	return (
		<a
			href={`#${domId}`}
			className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
			title="Link to this setting"
			aria-label="Link to this setting"
			onClick={(e) => {
				e.preventDefault()
				SettingsNav.navigateToAnchor(domId)
			}}
		>
			<Icons.Link className="h-3 w-3" />
		</a>
	)
}

// a nested object section: titled fieldset. `useIsModified` keeps the reset affordance live without re-rendering
// the whole subtree on every descendant edit.
function SectionField(
	{ name, node, path, value$, reset$, onChange }: {
		name: string
		node: Node
		path: Path
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: any) => void
	},
) {
	const { inner } = stripNullable(node)
	const description: string | undefined = node.description ?? inner.description
	const pathStr = path.join('.')
	const { idPrefix } = React.useContext(FormOptionsContext)
	const domId = `${idPrefix}${pathStr}`
	// the header pins to the top of the scroll column (stacking under any ancestor section headers) while this section
	// is in view. StickyGroup handles the offset math + z-index; the ref'd element must sit before the section body.
	const headerRef = React.useRef<HTMLDivElement>(null)
	// only issues sitting exactly at the section path (object-level refines) -- descendants are claimed by their leaves
	const sectionIssues = React.useContext(ValidationContext).filter((i) => i.path === pathStr)
	const SectionExtra = sectionExtraFor(path)
	// leaves dim themselves individually; the section only needs its own bulk-reset controls neutralized
	const writable = RBAC.settingsPathOverlaps(React.useContext(WriteAccessContext), path)
	return (
		<fieldset
			id={domId}
			data-settings-error={sectionIssues.length > 0 || undefined}
			className={cn('border rounded-md px-3 pb-3 pt-0 space-y-3 scroll-mt-2', sectionIssues.length > 0 && 'border-destructive')}
		>
			<StickyGroup stickyRef={headerRef}>
				<div ref={headerRef} className="group flex items-center gap-2 -mx-3 rounded-t-md border-b bg-card px-3 py-2">
					<legend className="px-1 text-sm font-semibold">{settingLabel(path, name)}</legend>
					<code className="text-[10px] text-muted-foreground">{pathStr}</code>
					{/* a whole section's default is usually a bulky object, so omit the inline "default:" hint (tooltip carries it) */}
					<span className="contents" inert={!writable}>
						<FieldResetControls value$={value$} reset$={reset$} onChange={onChange} node={node} path={path} showDefaultLabel={false} />
					</span>
					<AnchorLink domId={domId} />
				</div>
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
				{SectionExtra && <SectionExtra />}
				<FieldIssues issues={sectionIssues} pathStr={pathStr} />
				<FieldControl node={node} path={path} value$={value$} reset$={reset$} onChange={onChange} />
			</StickyGroup>
		</fieldset>
	)
}

// a single labeled leaf field (scalar, array, record, or override widget).
function LeafField(
	{ name, node, path, value$, reset$, onChange, hasOverride }: {
		name: string
		node: Node
		path: Path
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: any) => void
		hasOverride: boolean
	},
) {
	const { inner } = stripNullable(node)
	const description: string | undefined = node.description ?? inner.description
	const pathStr = path.join('.')
	const { idPrefix } = React.useContext(FormOptionsContext)
	const domId = `${idPrefix}${pathStr}`

	const isBoolean = inner.type === 'boolean'
	const fieldIssues = issuesForField(React.useContext(ValidationContext), pathStr)
	const hasError = fieldIssues.length > 0
	// loose overlap: a grant pointing inside this field's subtree still permits editing part of it, so the field stays
	// active and the save panel's exact per-path check flags anything outside the grant
	const writable = RBAC.settingsPathOverlaps(React.useContext(WriteAccessContext), path)
	// the inline "default: <value>" hint only reads well for scalars; complex/override fields still get the reset buttons
	const showDefaultLabel = !hasOverride && isScalarNode(inner)
	const controls = (
		<span className="contents" inert={!writable}>
			<FieldResetControls value$={value$} reset$={reset$} onChange={onChange} node={node} path={path} showDefaultLabel={showDefaultLabel} />
		</span>
	)
	return (
		<div
			id={domId}
			data-settings-error={hasError || undefined}
			className={cn(
				// the -mx-2/px-2 gutter + vertical padding give the anchor-highlight ring consistent breathing room on
				// every side without shifting the content column
				'space-y-1 scroll-mt-2 rounded-md -mx-2 px-2 py-1.5',
				isBoolean && 'flex items-center justify-between space-y-0 gap-4',
				hasError && 'border-l-2 border-destructive',
				!writable && 'opacity-60',
			)}
		>
			<div className={cn(isBoolean && 'min-w-0')}>
				<div className="group flex items-center gap-1.5">
					<Label className={cn('text-sm', hasError && 'text-destructive')}>{settingLabel(path, name)}</Label>
					<code className="text-[10px] text-muted-foreground">{pathStr}</code>
					{!writable && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Icons.Lock className="h-3 w-3 text-muted-foreground" />
							</TooltipTrigger>
							<TooltipContent>You are not permitted to modify this setting</TooltipContent>
						</Tooltip>
					)}
					{!isBoolean && controls}
					<AnchorLink domId={domId} />
				</div>
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
				<FieldIssues issues={fieldIssues} pathStr={pathStr} />
			</div>
			<div className={cn(isBoolean && 'shrink-0 flex items-center gap-1')} inert={!writable}>
				{isBoolean && controls}
				<FieldControl node={node} path={path} value$={value$} reset$={reset$} onChange={onChange} />
			</div>
		</div>
	)
}

// dispatches a schema property to a section or leaf renderer, deriving its scoped value$ + onChange.
function Field(
	{ name, node, path, parent$, parentOnChange, reset$ }: {
		name: string
		node: Node
		path: Path
		parent$: ValueState
		parentOnChange: (v: Record<string, any>) => void
		reset$: Rx.Subject<void>
	},
) {
	const value$ = React.useMemo(() => scopeValue(parent$, name), [parent$, name])
	const onChange = React.useCallback(
		(v: any) => parentOnChange({ ...((parent$.getValue() as Record<string, any>) ?? {}), [name]: v }),
		[parentOnChange, parent$, name],
	)
	const { inner } = stripNullable(node)
	const hasOverride = !!overrideFor(path, node)
	const isSection = !hasOverride
		&& inner.type === 'object'
		&& !!inner.properties
		&& !(inner.additionalProperties && typeof inner.additionalProperties === 'object')

	if (isSection) return <SectionField name={name} node={node} path={path} value$={value$} reset$={reset$} onChange={onChange} />
	return <LeafField name={name} node={node} path={path} value$={value$} reset$={reset$} onChange={onChange} hasOverride={hasOverride} />
}

// a presentation-only grouping of top-level fields: a prominent sticky header + anchor, no value/reset semantics of
// its own (the persisted shape is untouched; see settings-groups.ts)
function GroupSection({ slug, label, children }: { slug: string; label: string; children: React.ReactNode }) {
	const { idPrefix } = React.useContext(FormOptionsContext)
	const domId = `${idPrefix}group:${slug}`
	const headerRef = React.useRef<HTMLDivElement>(null)
	return (
		<section id={domId} className="scroll-mt-2 rounded-md -mx-2 px-2 pb-2">
			<StickyGroup stickyRef={headerRef}>
				<div ref={headerRef} className="group flex items-center gap-2 border-b bg-background px-1 py-2">
					<h3 className="text-base font-semibold">{label}</h3>
					<AnchorLink domId={domId} />
				</div>
				<div className="space-y-3 pt-3">{children}</div>
			</StickyGroup>
		</section>
	)
}

// root fields partitioned into the given groups (schema order within each group is the group's key order); keys not
// covered by any group render ungrouped afterwards
function GroupedRootFields(
	{ node, groups, value$, reset$, onChange }: {
		node: Node
		groups: SettingsGroup[]
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: Record<string, any>) => void
	},
) {
	const props: Record<string, Node> = node.properties ?? {}
	const { groups: grouped, ungrouped } = splitByGroups(Object.keys(props), groups)
	return (
		<div className="space-y-6">
			{grouped.map(({ group, keys }) => (
				<GroupSection key={group.slug} slug={group.slug} label={group.label}>
					{keys.map((key) => (
						<Field key={key} name={key} node={props[key]} path={[key]} parent$={value$} parentOnChange={onChange} reset$={reset$} />
					))}
				</GroupSection>
			))}
			{ungrouped.map((key) => (
				<Field key={key} name={key} node={props[key]} path={[key]} parent$={value$} parentOnChange={onChange} reset$={reset$} />
			))}
		</div>
	)
}

function JsonFallback({ value$, reset$, onChange }: { value$: ValueState; reset$: Rx.Subject<void>; onChange: (v: unknown) => void }) {
	const [text, setText] = React.useState(() => JSON.stringify(value$.getValue(), null, 2))
	const [error, setError] = React.useState('')
	useReset(reset$, () => {
		setText(JSON.stringify(value$.getValue(), null, 2))
		setError('')
	})
	return (
		<div className="space-y-1">
			<textarea
				className="w-full font-mono text-xs border rounded-md p-2 min-h-[6rem] bg-background"
				value={text}
				onChange={(e) => {
					setText(e.target.value)
					try {
						onChange(JSON.parse(e.target.value))
						setError('')
					} catch {
						setError('Invalid JSON')
					}
				}}
			/>
			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	)
}

export default function SettingsForm(
	{ schema, value$, reset$, onChange, saved, idPrefix = 'setting:', groups, priorityKeys, issues, writeAccess = WRITE_ACCESS_ALL }: {
		schema: z.ZodType
		value$: Rx.Observable<any> & { getValue: () => any }
		reset$: Rx.Subject<void>
		onChange: (next: any) => void
		// the last-saved baseline the draft was seeded from; powers each field's "reset to saved" button. May be
		// undefined while the settings are still loading.
		saved?: any
		// scopes field DOM ids / URL anchors; defaults to `setting:` (global settings). Server forms pass `setting:server:<id>:`
		idPrefix?: string
		// presentation-level grouping of the top-level keys (see settings-groups.ts); ungrouped keys render after the groups
		groups?: SettingsGroup[]
		// presentation-level ordering (ungrouped forms only): these top-level keys float to the front, in the given order,
		// with the rest following in schema order. Keeps the persisted shape untouched, same rationale as `groups`.
		priorityKeys?: string[]
		// schema issues for the current draft (input-shape safeParse); each leaf field displays the issues under its path
		issues?: readonly z.core.$ZodIssue[]
		// the user's write grant; fields with no overlap render read-only. Defaults to unrestricted.
		writeAccess?: RBAC.SettingsWriteAccess
	},
) {
	const rawJsonSchema = React.useMemo(() => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Node, [schema])
	// float any priorityKeys to the front of the root object's properties (insertion order drives render + reset order)
	const jsonSchema = React.useMemo(() => {
		const props: Record<string, Node> | undefined = rawJsonSchema?.properties
		if (!priorityKeys?.length || !props) return rawJsonSchema
		const ordered: Record<string, Node> = {}
		for (const k of priorityKeys) if (k in props) ordered[k] = props[k]
		for (const k of Object.keys(props)) if (!(k in ordered)) ordered[k] = props[k]
		return { ...rawJsonSchema, properties: ordered }
	}, [rawJsonSchema, priorityKeys])
	const rootPath = React.useMemo<Path>(() => [], [])
	const formOptions = React.useMemo(() => ({ idPrefix }), [idPrefix])
	const savedCtx = React.useMemo(() => ({ saved }), [saved])
	const messageVars = useMessageVars(value$)
	const normIssues = React.useMemo(
		() => (issues ?? []).map((i): NormalizedIssue => ({ path: i.path.map(String).join('.'), message: i.message })),
		[issues],
	)
	return (
		<FormOptionsContext.Provider value={formOptions}>
			<WriteAccessContext.Provider value={writeAccess}>
				<SavedRootContext.Provider value={savedCtx}>
					<MessageVarsContext.Provider value={messageVars}>
						<ValidationContext.Provider value={normIssues}>
							{groups
								? <GroupedRootFields node={jsonSchema} groups={groups} value$={value$} reset$={reset$} onChange={onChange} />
								: <ObjectField node={jsonSchema} path={rootPath} value$={value$} reset$={reset$} onChange={onChange} />}
						</ValidationContext.Provider>
					</MessageVarsContext.Provider>
				</SavedRootContext.Provider>
			</WriteAccessContext.Provider>
		</FormOptionsContext.Provider>
	)
}
