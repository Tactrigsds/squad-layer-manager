import { BmFlagMultiSelect, BmFlagSelect } from '@/components/bm-flag-picker'
import ComboBox, { type ComboBoxHandle, type ComboBoxOption } from '@/components/combo-box/combo-box'
import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { LOADING } from '@/components/combo-box/constants.ts'
import { DiscordMemberSelect, DiscordRoleSelect } from '@/components/discord-picker'
import LayerGenerationConfigEditor from '@/components/layer-generation-config-editor'
import LayerTableConfigEditor from '@/components/layer-table-config-editor'
import { GenerationPoolFiltersPanel, MainPoolFiltersPanel, RepeatRulesPanel } from '@/components/pool-config-panels'
import type { PoolConfigApi } from '@/components/pool-config-panels.helpers'
import { StickyGroup } from '@/components/sticky-group'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebounced } from '@/hooks/use-debounce'
import { createId } from '@/lib/id'
import * as Obj from '@/lib/object'
import type { SettingsGroup } from '@/lib/settings-groups'
import { HIDDEN_GLOBAL_SETTINGS_KEYS, LOCAL_JSON_EDITOR_PATHS, splitAdvanced, splitByGroups } from '@/lib/settings-groups'
import { humanize, settingLabel } from '@/lib/settings-labels'
import * as SettingsNav from '@/lib/settings-nav'
import * as Templating from '@/lib/templating'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as Zod from '@/lib/zod'
import * as ZusUtils from '@/lib/zustand'
import * as AAR from '@/models/admin-action-reasons.models'
import type * as BM from '@/models/battlemetrics.models'
import * as CMD from '@/models/command.models'
import type * as LP from '@/models/labeled-presets.models'
import * as LC from '@/models/layer-columns'
import * as PG from '@/models/player-groupings.models'
import * as PermRows from '@/models/rbac-perm-rows'
import * as SETTINGS from '@/models/settings.models'
import type * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ConfigClient from '@/systems/config.client'
import * as DndKit from '@/systems/dndkit.client'
import * as SettingsClient from '@/systems/settings.client'
import * as UsersClient from '@/systems/users.client'
import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'
import { z } from 'zod'
import type SchemaJsonEditorComponent from './schema-json-editor'
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

// the whole settings document being edited, so a bespoke field can read a sibling it isn't scoped to (e.g. the admin
// list sftp editor copying connection details from `connections.sftp`). Null when unset (e.g. tests).
const RootValueContext = React.createContext<ValueState | null>(null)

// the root document's onChange, so a bespoke field can write siblings it isn't scoped to. The command-prefix editor
// uses it to propagate a prefix rename across every command string / timeout alias that uses that prefix.
const RootOnChangeContext = React.createContext<((next: any) => void) | null>(null)

// the zod schema of the whole document, so a field can resolve the sub-schema at its own path for its scoped JSON
// editor (the json-schema projection the form walks can't be handed back to zod for parsing)
const RootSchemaContext = React.createContext<z.ZodType | null>(null)

// paths that render inside their section's "Advanced" disclosure (see settings-groups.ts). Empty for forms that
// declare none.
const NO_ADVANCED_PATHS: ReadonlySet<string> = new Set()
const AdvancedPathsContext = React.createContext<ReadonlySet<string>>(NO_ADVANCED_PATHS)

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

type PlayerGroupingsValue = Record<string, PG.Grouping | undefined>

// Drag ids must be unique across every grouping card mounted at once, and a rule has nothing of its own to be named by
// (its position IS its priority), so grouping + index identifies it. JSON-encoded because a grouping id is free text
// and could contain whatever delimiter we picked.
function ruleDragId(groupingId: string, idx: number): string {
	return JSON.stringify([groupingId, idx])
}

function parseRuleDragId(id: string): { groupingId: string; idx: number } {
	const [groupingId, idx] = JSON.parse(id) as [string, number]
	return { groupingId, idx }
}

// A group's color defaults to a reference to the first of its flags that has one, so picking flags is usually all an
// operator has to do and the color keeps tracking battlemetrics afterwards. An entry that already exists is left alone.
// Half-finished rules must not leave an entry behind: a placeholder written before a flag is picked would count as
// existing and block the seeding it is standing in for. A reference to a flag the group no longer carries is dropped
// rather than kept, since the picker would not offer that flag any more.
function syncedGroups(grouping: PG.Grouping, orgFlags: BM.PlayerFlag[] | undefined): Record<string, PG.Group> {
	const groups: Record<string, PG.Group> = {}
	for (const rule of grouping.rules) {
		if (!rule.group || groups[rule.group]) continue
		const existing = grouping.groups?.[rule.group]
		if (existing && (existing.color.type === 'custom' || PG.getGroupFlags(grouping, rule.group).includes(existing.color.flag))) {
			groups[rule.group] = existing
			continue
		}
		const derived = PG.defaultGroupColor(grouping, rule.group, orgFlags)
		if (derived) groups[rule.group] = { color: derived }
	}
	return groups
}

// bespoke editor for `playerGroupings`. Each grouping is an ordered rule list (first match wins), so priority is row
// position rather than a number. Group colors are derived from the rules' flags and kept in a secondary section.
function PlayerGroupingsField({ value$, reset$, onChange }: OverrideProps) {
	const value = (useFieldValue(value$, reset$) as PlayerGroupingsValue) ?? {}
	const groupingIds = Object.keys(value)
	const orgFlags = BattlemetricsClient.useOrgFlags()
	// the union across running servers -- fetched once here rather than per rule row
	const adminGroupsQuery = useQuery(RPC.orpc.squadServer.listAdminListGroups.queryOptions({ staleTime: 60_000 }))
	const adminGroupOptions: ComboBoxOption<string>[] | typeof LOADING = adminGroupsQuery.data
		? adminGroupsQuery.data.map((name) => ({ value: name, label: name }))
		: LOADING

	// `quiet` skips reset$: use it for edits driven by an uncontrolled input (the group name), where re-emitting would
	// clobber an in-flight keystroke. Structural edits leave it off so inputs re-seed after re-indexing.
	const update = React.useCallback((fn: (v: PlayerGroupingsValue) => PlayerGroupingsValue, quiet?: boolean) => {
		onChange(fn((value$.getValue() as PlayerGroupingsValue) ?? {}))
		if (!quiet) reset$.next()
	}, [onChange, value$, reset$])

	// every rule edit re-syncs the group map, so a group can never outlive the last rule naming it
	const updateGrouping = React.useCallback((id: string, fn: (g: PG.Grouping) => PG.Grouping, quiet?: boolean) => {
		update((v) => {
			const next = fn(v[id] ?? PG.EMPTY_GROUPING)
			return { ...v, [id]: { ...next, groups: syncedGroups(next, orgFlags) } }
		}, quiet)
	}, [update, orgFlags])

	const [newGrouping, setNewGrouping] = React.useState('')
	const trimmedNew = newGrouping.trim()
	const canAdd = trimmedNew.length > 0 && !(trimmedNew in value)
	function addGrouping() {
		if (!canAdd) return
		update((v) => ({ ...v, [trimmedNew]: PG.EMPTY_GROUPING }))
		setNewGrouping('')
	}
	function removeGrouping(id: string) {
		update((v) => {
			const next = { ...v }
			delete next[id]
			return next
		})
	}

	return (
		<div className="space-y-4">
			{groupingIds.length === 0 && (
				<p className="text-xs text-muted-foreground">
					No groupings defined. A grouping is one way of sorting players into groups; the players panel and activity charts pick between
					them by name.
				</p>
			)}
			{groupingIds.map((id) => (
				<GroupingCard
					key={id}
					groupingId={id}
					grouping={value[id] ?? PG.EMPTY_GROUPING}
					value$={scopeValue(value$, id)}
					reset$={reset$}
					orgFlags={orgFlags}
					adminGroupOptions={adminGroupOptions}
					onUpdate={updateGrouping}
					onRemove={removeGrouping}
				/>
			))}
			<div className="flex max-w-sm items-center gap-2">
				<Input
					placeholder="New grouping name"
					value={newGrouping}
					onChange={(e) => setNewGrouping(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault()
							addGrouping()
						}
					}}
				/>
				<Button type="button" variant="outline" size="sm" disabled={!canAdd} onClick={addGrouping}>
					<Icons.Plus className="mr-1 h-4 w-4" />Add grouping
				</Button>
			</div>
		</div>
	)
}

// a thin gap between/around rows that highlights while a rule is dragged over it (invisible but layout-occupying otherwise)
function RuleDropSeparator({ position, groupingId, idx }: { position: 'before' | 'after'; groupingId: string; idx: number }) {
	const drop = DndKit.useDroppable({
		type: 'relative-to-drag-item',
		slots: [{ position, dragItem: { type: 'grouping-rule', id: ruleDragId(groupingId, idx) } }],
	})
	return <li ref={drop.ref} data-over={drop.isDropTarget} className="my-0.5 h-1 rounded bg-primary data-[over=false]:invisible" />
}

// sentinel option: leaves the list and lets a name be typed instead
const ADD_NEW_GROUP = '__add-new-group__'

function RuleRow(
	{
		rule,
		idx,
		groupingId,
		groupNames,
		groupColors,
		usedFlags,
		usedAdminGroups,
		adminGroupOptions,
		value$,
		reset$,
		onReplace,
		onChange,
		onRemove,
	}: {
		rule: PG.GroupRule
		idx: number
		groupingId: string
		groupNames: string[]
		groupColors: Record<string, string>
		usedFlags: string[]
		usedAdminGroups: string[]
		adminGroupOptions: ComboBoxOption<string>[] | typeof LOADING
		value$: ValueState
		reset$: Rx.Subject<void>
		onReplace: (idx: number, rule: PG.GroupRule) => void
		onChange: (idx: number, patch: Partial<PG.GroupRule>, quiet?: boolean) => void
		onRemove: () => void
	},
) {
	const drag = DndKit.useDraggable({ type: 'grouping-rule', id: ruleDragId(groupingId, idx) }, { feedback: 'default' })
	// Several rules feeding one group is the norm, so once the grouping names any group, picking from the list is the
	// common case and typing is the exception. Which mode a row is in has to be sticky, never derived from whether the
	// name exists yet: group names come from the rules themselves, so a half-typed name is already an "existing" group
	// and the field would turn into a combo box under the keystroke that created it.
	const [namingNewGroup, setNamingNewGroup] = React.useState(groupNames.length === 0)
	// switching source discards the old source's field: the variants share only `group`, and a stale `flag` sitting on an
	// admin-list rule would be written straight back out again
	function setSource(type: PG.GroupRuleSource) {
		if (type === rule.type) return
		onReplace(idx, type === 'battlemetrics' ? { type, flag: '', group: rule.group } : { type, adminGroup: '', group: rule.group })
	}
	return (
		<li
			ref={drag.ref}
			data-dragging={drag.isDragging}
			className="grid grid-cols-[auto_1.5rem_7rem_minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-background data-[dragging=true]:opacity-40"
		>
			<button type="button" ref={drag.handleRef} className="cursor-grab rounded text-muted-foreground" aria-label="Drag to reorder">
				<Icons.GripVertical className="h-4 w-4" />
			</button>
			<span className="text-xs tabular-nums text-muted-foreground">{idx + 1}.</span>
			<Select value={rule.type} onValueChange={(next) => setSource(next as PG.GroupRuleSource)}>
				<SelectTrigger className="h-8" aria-label="Rule source">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{PG.GROUP_RULE_SOURCES.map((source) => <SelectItem key={source} value={source}>{PG.GROUP_RULE_SOURCE_LABELS[source]}
					</SelectItem>)}
				</SelectContent>
			</Select>
			{rule.type === 'battlemetrics'
				? (
					<BmFlagSelect
						value={rule.flag || undefined}
						exclude={usedFlags}
						onChange={(flag) => onChange(idx, { flag })}
					/>
				)
				: (
					<ComboBox
						title="Admin group"
						value={rule.adminGroup || undefined}
						options={adminGroupOptions === LOADING
							? LOADING
							: adminGroupOptions.filter((o) => o.value === rule.adminGroup || !usedAdminGroups.includes(o.value))}
						onSelect={(adminGroup) => {
							if (adminGroup) onChange(idx, { adminGroup })
						}}
					/>
				)}
			<Icons.ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			{namingNewGroup
				? (
					<div className="flex min-w-0 items-center gap-1">
						<TextInputField
							value$={scopeValue(scopeValue(scopeValue(value$, 'rules'), idx), 'group')}
							reset$={reset$}
							onChange={(next) => onChange(idx, { group: (next as string) ?? '' }, true)}
							numeric={false}
							placeholder="Group name"
						/>
						{groupNames.length > 0 && (
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="h-6 w-6 shrink-0"
								title="Pick an existing group instead"
								aria-label="Pick an existing group instead"
								onClick={() => setNamingNewGroup(false)}
							>
								<Icons.List className="h-4 w-4" />
							</Button>
						)}
					</div>
				)
				: (
					<ComboBox
						title="Group"
						value={rule.group || undefined}
						options={[
							...groupNames.map((name): ComboBoxOption<string> => ({
								value: name,
								label: <span style={{ color: groupColors[name] }}>{name}</span>,
							})),
							{ value: ADD_NEW_GROUP, label: <span className="text-muted-foreground">Add new group...</span>, keywords: ['new'] },
						]}
						onSelect={(next) => {
							if (!next) return
							if (next === ADD_NEW_GROUP) setNamingNewGroup(true)
							else onChange(idx, { group: next })
						}}
					/>
				)}
			<Button
				type="button"
				size="icon"
				variant="ghost"
				className="h-6 w-6 text-destructive"
				aria-label="Remove rule"
				onClick={onRemove}
			>
				<Icons.X className="h-4 w-4" />
			</Button>
		</li>
	)
}

function GroupingCard(
	{ groupingId, grouping, value$, reset$, orgFlags, adminGroupOptions, onUpdate, onRemove }: {
		groupingId: string
		grouping: PG.Grouping
		value$: ValueState
		reset$: Rx.Subject<void>
		orgFlags: BM.PlayerFlag[] | undefined
		adminGroupOptions: ComboBoxOption<string>[] | typeof LOADING
		onUpdate: (id: string, fn: (g: PG.Grouping) => PG.Grouping, quiet?: boolean) => void
		onRemove: (id: string) => void
	},
) {
	const rules = grouping.rules ?? []
	// a rule the operator is still filling in names no group yet, and an unnamed color row is just noise
	const groupNames = PG.getGroupNames(grouping).filter(Boolean)
	const groupColors = Object.fromEntries(groupNames.map((name) => [name, PG.getGroupColor(grouping, name, orgFlags)]))

	function changeRule(idx: number, patch: Partial<PG.GroupRule>, quiet?: boolean) {
		onUpdate(groupingId, (g) => ({ ...g, rules: g.rules.map((r, i) => i === idx ? { ...r, ...patch } as PG.GroupRule : r) }), quiet)
	}
	function replaceRule(idx: number, rule: PG.GroupRule) {
		onUpdate(groupingId, (g) => ({ ...g, rules: g.rules.map((r, i) => i === idx ? rule : r) }))
	}
	function addRule() {
		onUpdate(groupingId, (g) => ({ ...g, rules: [...g.rules, { type: 'battlemetrics', flag: '', group: '' }] }))
	}
	function removeRule(idx: number) {
		onUpdate(groupingId, (g) => ({ ...g, rules: g.rules.filter((_, i) => i !== idx) }))
	}
	// `quiet` for the custom-color text field only, so an in-flight keystroke is not clobbered
	function setGroupColor(group: string, color: PG.GroupColor, quiet?: boolean) {
		onUpdate(groupingId, (g) => ({ ...g, groups: { ...g.groups, [group]: { color } } }), quiet)
	}

	// drag-to-reorder via the shared dnd-kit provider (see dndkit.client), matching the layer-table column editor. The
	// handler is registered once and reads the latest state off a ref; every grouping card registers one, so a drop
	// belonging to another card's list has to be ignored.
	const stateRef = React.useRef({ groupingId, onUpdate })
	stateRef.current = { groupingId, onUpdate }
	DndKit.useDragEnd(React.useCallback((evt) => {
		const { active, over } = evt
		if (active.type !== 'grouping-rule' || !over) return
		const slot = over.slots.find((s) => s.dragItem.type === 'grouping-rule')
		if (!slot) return
		// the separators only ever register before/after; 'on' would mean dropping onto a rule itself, which reorders nothing
		const position = slot.position
		if (position === 'on') return
		const from = parseRuleDragId(active.id)
		// find() can't narrow the element, so the id is still the union's string | number here
		const to = parseRuleDragId(String(slot.dragItem.id))
		const { groupingId, onUpdate } = stateRef.current
		if (from.groupingId !== groupingId || to.groupingId !== groupingId) return
		onUpdate(groupingId, (g) => ({ ...g, rules: PG.moveRule(g.rules, from.idx, to.idx, position) }))
	}, []))

	return (
		<div className="space-y-3 rounded-md border p-3">
			<div className="flex items-center justify-between gap-2">
				<span className="text-sm font-medium">{groupingId}</span>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="h-6 w-6 shrink-0 text-destructive"
					aria-label={`Remove grouping ${groupingId}`}
					onClick={() => onRemove(groupingId)}
				>
					<Icons.X className="h-4 w-4" />
				</Button>
			</div>

			<div className="space-y-1.5">
				<Label className="text-xs text-muted-foreground">Rules</Label>
				<p className="text-xs text-muted-foreground">
					A player joins the group of the first rule whose flag they carry. Drag to reorder; priority is top to bottom.
				</p>
				{rules.length === 0 && <p className="text-xs text-muted-foreground">No rules yet.</p>}
				{rules.length > 0 && (
					// column headers, aligned to the same grid template as RuleRow
					<div className="grid grid-cols-[auto_1.5rem_7rem_minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 px-0 text-xs font-medium text-muted-foreground">
						<span />
						<span />
						<span />
						<span>Flag</span>
						<span />
						<span>Mapped grouping</span>
						<span />
					</div>
				)}
				<ol>
					{rules.map((rule, idx) => (
						// oxlint-disable-next-line no-array-index-key
						<React.Fragment key={idx}>
							<RuleDropSeparator position="before" groupingId={groupingId} idx={idx} />
							<RuleRow
								rule={rule}
								idx={idx}
								groupingId={groupingId}
								groupNames={groupNames}
								groupColors={groupColors}
								usedFlags={rules.flatMap((r) => r.type === 'battlemetrics' ? [r.flag] : [])}
								usedAdminGroups={rules.flatMap((r) => r.type === 'admin-list' ? [r.adminGroup] : [])}
								adminGroupOptions={adminGroupOptions}
								value$={value$}
								reset$={reset$}
								onReplace={replaceRule}
								onChange={changeRule}
								onRemove={() => removeRule(idx)}
							/>
						</React.Fragment>
					))}
					{rules.length > 0 && <RuleDropSeparator position="after" groupingId={groupingId} idx={rules.length - 1} />}
				</ol>
				<Button type="button" variant="outline" size="sm" onClick={addRule}>
					<Icons.Plus className="mr-1 h-4 w-4" />Add rule
				</Button>
			</div>

			{groupNames.length > 0 && (
				<details>
					<summary className="cursor-pointer text-xs text-muted-foreground">Colors ({groupNames.length})</summary>
					<p className="mt-1 text-xs text-muted-foreground">
						Following a flag keeps the color in step with battlemetrics.
					</p>
					<ul className="mt-1.5 space-y-1">
						{groupNames.map((group) => {
							const color = grouping.groups?.[group]?.color
							const resolved = PG.getGroupColor(grouping, group, orgFlags)
							return (
								<li key={group} className="grid grid-cols-[1.25rem_minmax(0,8rem)_minmax(0,1fr)_auto_7rem] items-center gap-2">
									<span className="h-5 w-5 shrink-0 rounded border" style={{ backgroundColor: resolved }} />
									<span className="min-w-0 truncate text-xs" title={group}>{group}</span>
									<BmFlagSelect
										title="Color from flag"
										value={color?.type === 'flag' ? color.flag : undefined}
										only={PG.getGroupFlags(grouping, group)}
										onChange={(flag) => setGroupColor(group, { type: 'flag', flag })}
									/>
									<span className="text-xs text-muted-foreground">or</span>
									<Input
										key={`${group}:${color?.type === 'custom' ? color.color : ''}`}
										className="h-8 font-mono"
										placeholder="#rrggbb"
										defaultValue={color?.type === 'custom' ? color.color : ''}
										onChange={(e) => setGroupColor(group, { type: 'custom', color: e.target.value }, true)}
									/>
								</li>
							)
						})}
					</ul>
				</details>
			)}
		</div>
	)
}
// -------- command prefixes editor --------

// a small "?" affordance that reveals a longer explanation on hover, so compact editors can drop verbose inline descriptions
function HelpTip({ text }: { text: string }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Help">
					<Icons.CircleHelp className="h-3.5 w-3.5" />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs">{text}</TooltipContent>
		</Tooltip>
	)
}

// which allowed prefix an inline command string uses: the longest one it starts with (so "!!" wins over "!")
function prefixUsedBy(str: string, prefixes: string[]): string | undefined {
	let best: string | undefined
	for (const p of prefixes) if (p && str.startsWith(p) && (best === undefined || p.length > best.length)) best = p
	return best
}

// re-point an inline string from `oldPrefix` to `newPrefix`
function repointPrefix(str: string, oldPrefix: string, newPrefix: string): string {
	return newPrefix + str.slice(oldPrefix.length)
}

type CommandsMap = Record<string, { strings?: string[] } | undefined>
type AliasList = { alias: string; command: string }[]

function mapCommandStrings(commands: CommandsMap, fn: (s: string) => string): CommandsMap {
	const out: CommandsMap = {}
	for (const [id, cmd] of Object.entries(commands)) out[id] = { ...cmd, strings: (cmd?.strings ?? []).map(fn) }
	return out
}

// the command string an alias's expansion starts with (its remaining words are arguments, which carry no prefix)
function aliasCommandWord(command: string): string {
	return command.trim().split(/\s+/)[0] ?? ''
}

// re-points the leading command string of an alias's expansion, leaving its arguments and spacing untouched
function repointCommandText(command: string, oldPrefix: string, newPrefix: string, prefixes: string[]): string {
	const match = /^(\s*)(\S+)([\s\S]*)$/.exec(command)
	if (!match || prefixUsedBy(match[2], prefixes) !== oldPrefix) return command
	return match[1] + repointPrefix(match[2], oldPrefix, newPrefix) + match[3]
}

// one editable prefix. The char input is committed on blur/Enter (not per keystroke) because committing propagates a
// rewrite across every string using it; re-seeded by remounting (its key includes the committed value).
function PrefixRow(
	{ index, prefix, isDefault, usage, onCommit, onSetDefault, onRemove }: {
		index: number
		prefix: string
		isDefault: boolean
		usage: number
		onCommit: (next: string) => void
		onSetDefault: () => void
		onRemove: () => void
	},
) {
	const [draft, setDraft] = React.useState(prefix)
	const invalid = !CMD.isValidPrefix(draft.trim())
	// discard an invalid edit on blur (reverting to the committed value) rather than propagating a bad prefix into every string
	const commit = () => {
		const next = draft.trim()
		if (!CMD.isValidPrefix(next)) {
			setDraft(prefix)
			return
		}
		onCommit(next)
	}
	const removable = !isDefault && usage === 0
	return (
		<div className="flex items-center gap-2 rounded-md border px-2 py-1.5">
			<span className="text-xs text-muted-foreground tabular-nums">#{index + 1}</span>
			<Input
				aria-label={`Prefix ${index + 1}`}
				className={cn('h-7 w-16 font-mono text-sm', invalid && 'border-destructive focus-visible:ring-destructive')}
				title={invalid ? CMD.PREFIX_ERROR : undefined}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault()
						e.currentTarget.blur()
					}
				}}
			/>
			<label className="flex items-center gap-1 text-xs text-muted-foreground">
				<input type="radio" checked={isDefault} onChange={onSetDefault} aria-label={`Make prefix ${index + 1} the default`} />
				Default
			</label>
			<span className="whitespace-nowrap text-xs text-muted-foreground">{usage} {usage === 1 ? 'use' : 'uses'}</span>
			<Button
				type="button"
				size="icon"
				variant="ghost"
				className="h-6 w-6 shrink-0 text-destructive disabled:opacity-40"
				aria-label={`Remove prefix ${index + 1}`}
				disabled={!removable}
				title={isDefault ? 'The default prefix cannot be removed' : usage > 0 ? `${usage} strings still use this prefix` : undefined}
				onClick={onRemove}
			>
				<Icons.X className="h-4 w-4" />
			</Button>
		</div>
	)
}

// bespoke editor for `allowedPrefixes`: prefixes are numbered so they have their own identity. Editing a prefix's
// characters propagates the change to every command string and timeout alias that uses it; one prefix is marked the
// default (new commands seed from it); a prefix in use can't be removed. Reads/writes siblings via the root contexts.
function AllowedPrefixesField({ value$, reset$ }: OverrideProps) {
	const root$ = React.useContext(RootValueContext) ?? EMPTY_ROOT_VALUE$
	const rootOnChange = React.useContext(RootOnChangeContext)
	const root = (useFieldValue(root$, reset$) as
		| { defaultPrefix?: string; commands?: CommandsMap; commandAliases?: AliasList }
		| undefined) ?? {}
	const prefixes = (useFieldValue(value$, reset$) as string[] | undefined) ?? []
	const commands = root.commands ?? {}
	const aliases = root.commandAliases ?? []
	const defaultPrefix = root.defaultPrefix ?? prefixes[0] ?? ''

	const [newPrefix, setNewPrefix] = React.useState('')

	function writeRoot(patch: Record<string, unknown>) {
		const cur = (root$.getValue() as Record<string, unknown>) ?? {}
		rootOnChange?.({ ...cur, ...patch })
		reset$.next()
	}

	// an alias counts twice over: once for the shortcut, once for the command string it expands to
	function usageOf(prefix: string): number {
		let n = 0
		for (const cmd of Object.values(commands)) for (const s of cmd?.strings ?? []) if (prefixUsedBy(s, prefixes) === prefix) n++
		for (const a of aliases) {
			if (prefixUsedBy(a.alias, prefixes) === prefix) n++
			if (prefixUsedBy(aliasCommandWord(a.command), prefixes) === prefix) n++
		}
		return n
	}

	function commitEdit(idx: number, next: string) {
		const oldPrefix = prefixes[idx]
		if (!next || next === oldPrefix || !CMD.isValidPrefix(next)) return
		const nextPrefixes = prefixes.map((p, i) => (i === idx ? next : p))
		// target by the OLD prefix list so longest-match stays stable while rewriting
		const nextCommands = mapCommandStrings(
			commands,
			(s) => (prefixUsedBy(s, prefixes) === oldPrefix ? repointPrefix(s, oldPrefix, next) : s),
		)
		const nextAliases = aliases.map((a) => ({
			...a,
			alias: prefixUsedBy(a.alias, prefixes) === oldPrefix ? repointPrefix(a.alias, oldPrefix, next) : a.alias,
			command: repointCommandText(a.command, oldPrefix, next, prefixes),
		}))
		writeRoot({
			allowedPrefixes: nextPrefixes,
			commands: nextCommands,
			commandAliases: nextAliases,
			defaultPrefix: defaultPrefix === oldPrefix ? next : defaultPrefix,
		})
	}

	const newTrimmed = newPrefix.trim()
	const newInvalid = newTrimmed !== '' && !CMD.isValidPrefix(newTrimmed)
	const newDuplicate = newTrimmed !== '' && prefixes.includes(newTrimmed)
	function addPrefix() {
		if (!newTrimmed || newInvalid || newDuplicate) return
		writeRoot({ allowedPrefixes: [...prefixes, newTrimmed] })
		setNewPrefix('')
	}

	function removePrefix(idx: number) {
		const p = prefixes[idx]
		if (p === defaultPrefix || usageOf(p) > 0) return
		writeRoot({ allowedPrefixes: prefixes.filter((_, i) => i !== idx) })
	}

	return (
		<div className="space-y-2">
			<p className="text-xs text-muted-foreground">
				Editing a prefix updates every command string and alias that uses it. The default prefix seeds new commands.
			</p>
			<div className="flex flex-wrap items-center gap-3">
				{prefixes.map((p, idx) => (
					<PrefixRow
						// key carries the committed value so the row's uncontrolled draft re-seeds on external change; idx keeps it unique across duplicate prefixes
						// oxlint-disable-next-line no-array-index-key
						key={`${idx}:${p}`}
						index={idx}
						prefix={p}
						isDefault={p === defaultPrefix}
						usage={usageOf(p)}
						onCommit={(next) => commitEdit(idx, next)}
						onSetDefault={() => writeRoot({ defaultPrefix: p })}
						onRemove={() => removePrefix(idx)}
					/>
				))}
				<div className="flex items-center gap-2">
					<Input
						aria-label="New prefix"
						className={cn(
							'h-7 w-16 font-mono text-sm',
							(newInvalid || newDuplicate) && 'border-destructive focus-visible:ring-destructive',
						)}
						title={newInvalid ? CMD.PREFIX_ERROR : newDuplicate ? 'That prefix already exists' : undefined}
						placeholder="$"
						value={newPrefix}
						onChange={(e) => setNewPrefix(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault()
								addPrefix()
							}
						}}
					/>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={!newTrimmed || newInvalid || newDuplicate}
						onClick={addPrefix}
					>
						Add prefix
					</Button>
				</div>
			</div>
		</div>
	)
}

// bespoke editor for a command's `strings` array (inline-prefixed, short): lays the inputs out horizontally so they
// don't each hog a full row. Each string is an uncontrolled TextInputField scoped to its index (re-seeds on reset$).
function CommandStringsField({ value$, reset$, onChange }: OverrideProps) {
	const strings = (useFieldValue(value$, reset$) as string[] | undefined) ?? []
	function structural(next: string[]) {
		onChange(next)
		reset$.next()
	}
	return (
		<div className="flex flex-wrap items-center gap-2">
			{strings.map((_, idx) => (
				// oxlint-disable-next-line no-array-index-key
				<div key={idx} className="flex items-center gap-1">
					<div className="w-40">
						<TextInputField
							value$={scopeValue(value$, idx)}
							reset$={reset$}
							numeric={false}
							placeholder="prefix + command"
							onChange={(v) => onChange(((value$.getValue() as string[]) ?? []).map((s, i) => (i === idx ? (v ?? '') : s)))}
						/>
					</div>
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className="h-6 w-6 shrink-0 text-destructive"
						aria-label={`Remove string ${idx + 1}`}
						onClick={() => structural(strings.filter((_, i) => i !== idx))}
					>
						<Icons.X className="h-4 w-4" />
					</Button>
				</div>
			))}
			<Button type="button" variant="outline" size="sm" onClick={() => structural([...strings, ''])}>
				<Icons.Plus className="mr-1 h-4 w-4" />Add
			</Button>
		</div>
	)
}

// compact editor for a single command (`commands.<id>`): collapses the strings/scopes/enabled sub-sections into a
// couple of tight rows, moving their descriptions into `?` tooltips. The command name + reset come from the LeafField
// shell. Schema issues (e.g. a string missing an allowed prefix) still surface under the card via the field's issues.
function CommandCard({ value$, reset$, onChange }: OverrideProps) {
	const cfg = (useFieldValue(value$, reset$) as { scopes?: CMD.CommandScope[]; enabled?: boolean; quickReference?: boolean }) ?? {}
	const scopes = cfg.scopes ?? []
	const enabled = cfg.enabled ?? true
	const quickReference = cfg.quickReference ?? false
	const strings$ = React.useMemo(() => scopeValue(value$, 'strings'), [value$])
	function patch(p: Record<string, unknown>) {
		onChange({ ...((value$.getValue() as Record<string, unknown>) ?? {}), ...p })
	}
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
					Strings <HelpTip text="Command strings that trigger this command. Each must start with one of the allowed prefixes." />
				</span>
				<CommandStringsField value$={strings$} reset$={reset$} onChange={(v) => patch({ strings: v })} path={[]} />
			</div>
			<div className="flex flex-wrap items-center gap-4">
				<div className="flex items-center gap-2">
					<span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
						Scopes <HelpTip text="Chat scopes this command is available in (admin and/or public chats)." />
					</span>
					<ComboBoxMulti
						title="Scope"
						values={scopes}
						options={CMD.COMMAND_SCOPES.options.map((scope) => ({ value: scope, label: CMD.COMMAND_SCOPE_LABELS[scope] }))}
						onSelect={(next) => patch({ scopes: (typeof next === 'function' ? next(scopes) : next) })}
					/>
				</div>
				<label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
					<Switch checked={enabled} onCheckedChange={(v) => patch({ enabled: v })} />
					Enabled
				</label>
				<label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
					<Checkbox checked={quickReference} onCheckedChange={(v) => patch({ quickReference: v === true })} />
					<span className="flex items-center gap-1">
						Quick Reference
						<HelpTip text="Show this command on the commands page's quick reference, and in the in-game help command's default listing." />
					</span>
				</label>
			</div>
		</div>
	)
}

// what an alias's command text points at, for the status column. `undefined` means there's nothing useful to say:
// either the text is still empty, or its args are malformed, which surfaces as a schema issue under the field instead.
type AliasStatus = { broken: boolean; label: string; title: string }
function aliasStatus(command: string, commands: CMD.CommandConfigs | undefined): AliasStatus | undefined {
	if (!commands || command.trim() === '') return undefined
	const res = CMD.resolveAliasCommand(command, commands)
	if (res.code === 'err:invalid-args') return undefined
	if (res.code === 'err:unknown-command') return { broken: true, label: 'Unavailable', title: res.msg }
	if (!commands[res.cmdId].enabled) {
		return { broken: true, label: 'Disabled', title: `The "${res.cmdId}" command is disabled, so this alias does nothing.` }
	}
	return { broken: false, label: res.cmdId, title: `Runs the "${res.cmdId}" command.` }
}

// bespoke editor for `commandAliases`: an alias is just a shortcut string and the full command it runs, so the row is
// two text fields plus a status showing which command it resolves to (and whether that command is usable).
function CommandAliasesField({ value$, reset$, onChange }: OverrideProps) {
	return (
		<PresetTableField
			value$={value$}
			reset$={reset$}
			onChange={onChange}
			headers={
				<>
					<TableHead className="w-[12rem]">Alias</TableHead>
					<TableHead>Full command</TableHead>
					<TableHead className="w-[9rem]">Runs</TableHead>
					<TableHead className="w-8" />
				</>
			}
			newRow={() => ({ alias: '', command: '' })}
			Row={CommandAliasRow}
		/>
	)
}

function CommandAliasRow({ idx, parent$, reset$, parentOnChange, onRemove }: PresetRowProps) {
	const row$ = React.useMemo(() => scopeValue(parent$, idx), [parent$, idx])
	const alias$ = React.useMemo(() => scopeValue(row$, 'alias'), [row$])
	const command$ = React.useMemo(() => scopeValue(row$, 'command'), [row$])
	const root$ = React.useContext(RootValueContext) ?? EMPTY_ROOT_VALUE$
	// the command text is read reactively so the status follows the input (a debounce behind it, like every other field)
	const command = (useFieldValue(command$, reset$) as string | undefined) ?? ''
	const commands = ((useFieldValue(root$, reset$) as { commands?: CMD.CommandConfigs } | undefined) ?? {}).commands
	const status = aliasStatus(command, commands)

	const setField = (key: 'alias' | 'command') => (v: any) => {
		const arr = [...((parent$.getValue() as CMD.CommandAlias[]) ?? [])]
		arr[idx] = { ...arr[idx], [key]: v ?? '' }
		parentOnChange(arr)
	}

	return (
		<TableRow>
			<TableCell className="align-top">
				<TextInputField value$={alias$} reset$={reset$} onChange={setField('alias')} numeric={false} placeholder="/rules" />
			</TableCell>
			<TableCell className="align-top">
				<TextInputField
					value$={command$}
					reset$={reset$}
					onChange={setField('command')}
					numeric={false}
					placeholder="/broadcast Read the rules"
				/>
			</TableCell>
			<TableCell className="align-top">
				{status && (
					<Badge variant={status.broken ? 'destructive' : 'outline'} className="font-mono text-xs" title={status.title}>
						{status.label}
					</Badge>
				)}
			</TableCell>
			<TableCell className="align-top">
				<Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={onRemove}>
					<Icons.X className="h-4 w-4" />
				</Button>
			</TableCell>
		</TableRow>
	)
}

function PasswordField({ value$, reset$, onChange }: OverrideProps) {
	return <TextInputField value$={value$} reset$={reset$} onChange={onChange} numeric={false} secret placeholder="Password" />
}

// the server-agent's shared secret: masked by default, with generate-a-new-token and copy-to-clipboard affordances. The
// input is uncontrolled (seeded from value$, debounced upward, re-read on reset$), same as TextInputField.
function ServerAgentTokenField({ value$, reset$, onChange }: OverrideProps) {
	const ref = React.useRef<HTMLInputElement>(null)
	const [show, setShow] = React.useState(false)
	const [copied, setCopied] = React.useState(false)
	const copiedTimeout = React.useRef<ReturnType<typeof setTimeout>>(null)
	const push = useDebounced<any>({ delay: DEBOUNCE_MS, onChange })
	const repoUrl = ZusUtils.useStore(ConfigClient.Store, (s) => s?.repoUrl)
	const docUrl = repoUrl ? `${repoUrl}/blob/HEAD/docs/CONFIGURING.md#server-agent` : undefined
	const format = (v: any) => v === null || v === undefined ? '' : String(v)
	useReset(reset$, () => {
		const formatted = format(value$.getValue())
		if (ref.current && ref.current.value !== formatted) ref.current.value = formatted
	})

	function generate() {
		const token = createId(32)
		if (ref.current) ref.current.value = token
		setShow(true)
		onChange(token)
	}
	function copy() {
		const cur = ref.current?.value ?? ''
		if (!cur) return
		void navigator.clipboard.writeText(cur)
		setCopied(true)
		if (copiedTimeout.current) clearTimeout(copiedTimeout.current)
		copiedTimeout.current = setTimeout(() => setCopied(false), 1500)
	}
	React.useEffect(() => () => {
		if (copiedTimeout.current) clearTimeout(copiedTimeout.current)
	}, [])

	return (
		<div className="space-y-1.5">
			<InputGroup>
				{/* a bare input (not InputGroupInput, whose custom Input wraps the control in a div that breaks the flex row) */}
				<input
					ref={ref}
					data-slot="input-group-control"
					type={show ? 'text' : 'password'}
					defaultValue={format(value$.getValue())}
					placeholder="Server agent token"
					autoComplete="off"
					spellCheck={false}
					onChange={(e) => push(e.currentTarget.value)}
					className="flex-1 min-w-0 bg-transparent px-3 py-1 font-mono text-sm outline-none placeholder:text-muted-foreground placeholder:font-sans"
				/>
				<InputGroupAddon align="inline-end">
					<InputGroupButton
						size="icon-xs"
						aria-label={show ? 'Hide token' : 'Show token'}
						onClick={() => setShow((s) => !s)}
					>
						{show ? <Icons.EyeOff /> : <Icons.Eye />}
					</InputGroupButton>
					<InputGroupButton size="icon-xs" aria-label="Copy token" onClick={copy}>
						{copied ? <Icons.Check /> : <Icons.Copy />}
					</InputGroupButton>
					<InputGroupButton size="xs" onClick={generate}>
						<Icons.RefreshCw />Generate
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
			<p className="text-xs text-muted-foreground">
				The server agent authenticates with this token, so treat it like a password.{' '}
				{docUrl && (
					<a href={docUrl} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
						Server agent setup guide
					</a>
				)}
			</p>
		</div>
	)
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

const ADMIN_SOURCE_TYPE_OPTIONS: { value: SM.AdminListSourceType; label: string }[] = [
	{ value: 'remote', label: 'Remote URL' },
	{ value: 'local', label: 'Local file' },
	{ value: 'ftp', label: 'FTP' },
	{ value: 'sftp', label: 'SFTP' },
]

const ADMIN_SOURCE_STRING_PLACEHOLDER: Record<'remote' | 'local' | 'ftp', string> = {
	remote: 'https://host/admins.cfg',
	local: 'path/to/Admins.cfg',
	ftp: 'ftp://user:password@host:21/admins.cfg',
}

function defaultAdminSource(type: SM.AdminListSourceType): SM.AdminListSource {
	if (type === 'sftp') return { type: 'sftp', host: '', port: 22, username: '', password: '', filePath: '' }
	return { type, source: '' }
}

// a never-emitting stand-in so useFieldValue can be called unconditionally when there is no root document (e.g. tests)
const EMPTY_ROOT_VALUE$ = new Rx.BehaviorSubject<any>(undefined) as unknown as ValueState

// bespoke editor for a server's `adminListSources` (a discriminated union of remote/local/ftp/sftp). sftp holds its own
// connection details, with a shortcut to copy them from the server's sftp log connection when one is configured.
function AdminListSourcesField({ value$, reset$, onChange }: OverrideProps) {
	const value = (useFieldValue(value$, reset$) as SM.AdminListSource[] | undefined) ?? []
	const root$ = React.useContext(RootValueContext) ?? EMPTY_ROOT_VALUE$
	const connType$ = React.useMemo(() => scopeValue(scopeValue(root$, 'connections'), 'type'), [root$])
	const canCopyFromLog = useFieldValue(connType$, reset$) === 'sftp'

	// `quiet` skips reset$ so an in-flight keystroke in an uncontrolled field isn't clobbered; structural edits (add/remove,
	// type change) leave it off so the fields re-seed after re-indexing.
	const update = React.useCallback((fn: (v: SM.AdminListSource[]) => SM.AdminListSource[], quiet?: boolean) => {
		onChange(fn((value$.getValue() as SM.AdminListSource[] | undefined) ?? []))
		if (!quiet) reset$.next()
	}, [onChange, value$, reset$])

	const patch = (idx: number, p: Partial<SM.AdminListSource>, quiet?: boolean) =>
		update((v) => v.map((s, i) => i === idx ? { ...s, ...p } as SM.AdminListSource : s), quiet)

	function copyFromLog(idx: number) {
		const connections = (root$.getValue() as { connections?: { type?: string; sftp?: any } } | undefined)?.connections
		if (!connections || connections.type !== 'sftp') return
		const sftp = connections.sftp
		patch(idx, { host: sftp.host, port: sftp.port, username: sftp.username, password: sftp.password })
	}

	return (
		<div className="space-y-2">
			{value.length === 0 && <p className="text-xs text-muted-foreground">No admin list sources.</p>}
			{value.map((source, idx) => (
				// oxlint-disable-next-line no-array-index-key
				<div key={idx} className="space-y-3 rounded-md border p-3">
					<div className="flex items-center gap-2">
						<Select
							value={source.type}
							onValueChange={(t) => update((v) => v.map((s, i) => i === idx ? defaultAdminSource(t as SM.AdminListSourceType) : s))}
						>
							<SelectTrigger className="w-40">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{ADMIN_SOURCE_TYPE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
							</SelectContent>
						</Select>
						<div className="flex-1" />
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-6 w-6 shrink-0 text-destructive"
							aria-label="Remove admin list source"
							onClick={() => update((v) => v.filter((_, i) => i !== idx))}
						>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
					{source.type === 'sftp'
						? (
							<div className="space-y-3">
								<div className="grid grid-cols-[1fr_7rem] gap-2">
									<div className="space-y-1">
										<Label className="text-xs text-muted-foreground">Host</Label>
										<TextInputField
											value$={scopeValue(scopeValue(value$, idx), 'host')}
											reset$={reset$}
											onChange={(next) => patch(idx, { host: (next as string) ?? '' }, true)}
											numeric={false}
											placeholder="sftp.host.com"
										/>
									</div>
									<div className="space-y-1">
										<Label className="text-xs text-muted-foreground">Port</Label>
										<TextInputField
											value$={scopeValue(scopeValue(value$, idx), 'port')}
											reset$={reset$}
											onChange={(next) => patch(idx, { port: typeof next === 'number' ? next : 22 }, true)}
											numeric
											placeholder="22"
										/>
									</div>
								</div>
								<div className="grid grid-cols-2 gap-2">
									<div className="space-y-1">
										<Label className="text-xs text-muted-foreground">Username</Label>
										<TextInputField
											value$={scopeValue(scopeValue(value$, idx), 'username')}
											reset$={reset$}
											onChange={(next) => patch(idx, { username: (next as string) ?? '' }, true)}
											numeric={false}
										/>
									</div>
									<div className="space-y-1">
										<Label className="text-xs text-muted-foreground">Password</Label>
										<TextInputField
											value$={scopeValue(scopeValue(value$, idx), 'password')}
											reset$={reset$}
											onChange={(next) => patch(idx, { password: (next as string) ?? '' }, true)}
											numeric={false}
											secret
										/>
									</div>
								</div>
								<div className="space-y-1">
									<Label className="text-xs text-muted-foreground">File path</Label>
									<TextInputField
										value$={scopeValue(scopeValue(value$, idx), 'filePath')}
										reset$={reset$}
										onChange={(next) => patch(idx, { filePath: (next as string) ?? '' }, true)}
										numeric={false}
										placeholder="/SquadGame/Saved/Admins.cfg"
									/>
								</div>
								{canCopyFromLog && (
									<Button type="button" variant="outline" size="sm" onClick={() => copyFromLog(idx)}>
										<Icons.Copy className="mr-1 h-4 w-4" />Copy connection from log source
									</Button>
								)}
							</div>
						)
						: (
							<div className="space-y-1">
								<Label className="text-xs text-muted-foreground">
									{source.type === 'remote' ? 'URL' : source.type === 'local' ? 'File path' : 'FTP URI'}
								</Label>
								<TextInputField
									value$={scopeValue(scopeValue(value$, idx), 'source')}
									reset$={reset$}
									onChange={(next) => patch(idx, { source: (next as string) ?? '' }, true)}
									numeric={false}
									placeholder={ADMIN_SOURCE_STRING_PLACEHOLDER[source.type]}
								/>
							</div>
						)}
				</div>
			))}
			<Button type="button" variant="outline" size="sm" onClick={() => update((v) => [...v, defaultAdminSource('remote')])}>
				<Icons.Plus className="mr-1 h-4 w-4" />Add source
			</Button>
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

const VALID_ROLE_ID = /^[a-z0-9-]{3,32}$/

type RoleAssignmentsValue = PermRows.RoleAssignmentsValue
type RoleConfig = PermRows.RoleConfig
type RbacValue = PermRows.RbacValue

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
	// scoped value-state for the timeout duration cell so it can reuse the uncontrolled TextInputField
	const timeout$ = React.useMemo(() => scopeValue(scopeValue(scopeValue(value$, 'roles'), roleId), 'maxTimeout'), [value$, roleId])

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
				title="Permissions"
				description="Everything this role may do. Each row is one permission; its Scope narrows the permission to specific servers, settings or a duration cap. Leave a scope empty to grant it unrestricted."
			>
				<RolePermissionsTable roleId={roleId} cfg={cfg} timeout$={timeout$} reset$={reset$} update={update} />
			</RoleSubsection>

			<RoleSubsection title="Assignments" description="Which Discord roles, users, or members are granted this role.">
				<RoleAssignmentsEditor roleId={roleId} cfg={cfg} update={update} assigned={assigned} />
			</RoleSubsection>
		</div>
	)
}

// one row = one permission the role holds. The five persisted fields are projected to rows on read and distributed back
// on write by PermRows, so this component only ever deals in rows.
function RolePermissionsTable(
	{ roleId, cfg, timeout$, reset$, update }: {
		roleId: string
		cfg: RoleConfig
		timeout$: ValueState
		reset$: Rx.Subject<void>
		update: RbacUpdate
	},
) {
	const rows = PermRows.rowsFromConfig(cfg)

	// `quiet` is threaded through for the timeout duration cell, whose uncontrolled input would be clobbered by a reset$
	function setRows(next: PermRows.PermRow[], quiet?: boolean) {
		update((r) => withRoleConfig(r, roleId, (c) => PermRows.configFromRows(c, next)), quiet)
	}
	function patchRow(id: string, patch: Partial<PermRows.PermRow>, quiet?: boolean) {
		setRows(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)), quiet)
	}

	const wildcarded = rows.some((r) => r.type === PermRows.ALL_PERMISSIONS && r.effect === 'allow')

	// a second row of the same permission only means something when it can carry different scope args; the rest would
	// just collapse on save, so offering them is a lie
	const addOptions: ComboBoxOption<string>[] = PermRows.ADDABLE_TYPES.map((type) => {
		const repeatable = PermRows.rowScope(type) === 'server-settings' || PermRows.rowScope(type) === 'server-settings-write'
		const taken = !repeatable && rows.some((r) => r.type === type && r.effect === 'allow')
		return { value: type, description: PermRows.permDescription(type), disabled: taken }
	})

	return (
		<div className="space-y-2">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-[7.5rem]">Effect</TableHead>
						<TableHead className="w-[16rem]">Permission</TableHead>
						<TableHead>Scope</TableHead>
						<TableHead className="w-10" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.length === 0 && (
						<TableRow>
							<TableCell colSpan={4} className="text-xs text-muted-foreground">
								This role grants nothing yet.
							</TableCell>
						</TableRow>
					)}
					{rows.map((row) => {
						// `*` already grants every permission, so the allow rows under it are redundant. Deny still wins over it.
						const subsumed = wildcarded && row.effect === 'allow' && row.type !== PermRows.ALL_PERMISSIONS
						return (
							<TableRow key={row.id} className={cn(subsumed && 'opacity-50')}>
								<TableCell className="align-top">
									<Select
										value={row.effect}
										disabled={!PermRows.canDeny(row.type)}
										onValueChange={(v) => patchRow(row.id, { effect: v as PermRows.Effect })}
									>
										<SelectTrigger className="h-8">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="allow">Allow</SelectItem>
											<SelectItem value="deny">Deny</SelectItem>
										</SelectContent>
									</Select>
								</TableCell>
								<TableCell className="align-top">
									<div className="flex items-start gap-1">
										<code className="text-xs leading-8">{row.type === PermRows.ALL_PERMISSIONS ? 'All permissions (*)' : row.type}</code>
										{PermRows.permDescription(row.type) && <HelpTip text={PermRows.permDescription(row.type)!} />}
										{subsumed && (
											<Tooltip>
												<TooltipTrigger asChild>
													<Icons.Info className="mt-2 h-3 w-3 shrink-0 text-muted-foreground" />
												</TooltipTrigger>
												<TooltipContent>Already granted by the wildcard row above</TooltipContent>
											</Tooltip>
										)}
									</div>
								</TableCell>
								<TableCell className="align-top">
									<PermScopeCell row={row} timeout$={timeout$} reset$={reset$} onPatch={patchRow} />
								</TableCell>
								<TableCell className="align-top">
									{
										/* a trash can, not an X: the scope cell's own X drops a single scope value, and the two end up close
									    enough that reusing the icon for "remove the whole permission" would be a trap */
									}
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												size="icon"
												variant="ghost"
												className="h-8 w-8 text-destructive"
												onClick={() => setRows(rows.filter((r) => r.id !== row.id))}
											>
												<Icons.Trash2 className="h-4 w-4" />
											</Button>
										</TooltipTrigger>
										<TooltipContent>Remove this permission</TooltipContent>
									</Tooltip>
								</TableCell>
							</TableRow>
						)
					})}
				</TableBody>
			</Table>
			<ComboBox
				title="permission"
				placeholder="Add permission..."
				className="w-[20rem]"
				value={undefined}
				options={addOptions}
				onSelect={(type) => type && setRows([...rows, PermRows.newRow(type)])}
			/>
		</div>
	)
}

// the Scope cell is a switch over the permission's scope kind, so a new permission needs no new editor: it inherits the
// cell for whichever scope it declares in PERMISSION_DEFINITION.
function PermScopeCell(
	{ row, timeout$, reset$, onPatch }: {
		row: PermRows.PermRow
		timeout$: ValueState
		reset$: Rx.Subject<void>
		onPatch: (id: string, patch: Partial<PermRows.PermRow>, quiet?: boolean) => void
	},
) {
	const servers = ZusUtils.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers) ?? []

	// a denial is unrestricted by construction: the expression grammar carries no args
	if (row.effect === 'deny') return <span className="text-xs leading-8 text-muted-foreground">Everything</span>

	const scope = PermRows.rowScope(row.type)
	switch (scope) {
		case 'all':
		case 'global':
			return <span className="text-xs leading-8 text-muted-foreground">{scope === 'all' ? 'Everything' : '—'}</span>

		case 'timeout':
			return (
				<div className="flex items-center gap-2">
					<span className="text-xs text-muted-foreground">up to</span>
					<div className="w-24">
						<TextInputField
							value$={timeout$}
							reset$={reset$}
							onChange={(v) => onPatch(row.id, { maxTimeout: (v as string) || PermRows.DEFAULT_MAX_TIMEOUT }, true)}
							numeric={false}
							placeholder="2h"
						/>
					</div>
				</div>
			)

		case 'global-settings-write':
			return (
				<ScopeValueRows
					title="setting path"
					mono
					emptyLabel="All settings"
					values={row.paths ?? []}
					options={globalGrantPathOptions()}
					onChange={(paths) => onPatch(row.id, { paths })}
				/>
			)

		case 'server-settings':
			return (
				<ScopeValueRows
					title="server"
					emptyLabel="All servers"
					values={row.serverIds ?? []}
					options={serverOptionsFor(servers, row.serverIds ?? [])}
					onChange={(serverIds) => onPatch(row.id, { serverIds })}
				/>
			)

		case 'server-settings-write':
			return (
				// two independent lists in one cell, so they get more room between them than the rows within each
				<div className="space-y-3">
					<ScopeValueRows
						title="server"
						emptyLabel="All servers"
						values={row.serverIds ?? []}
						options={serverOptionsFor(servers, row.serverIds ?? [])}
						onChange={(serverIds) => onPatch(row.id, { serverIds })}
					/>
					<ScopeValueRows
						title="setting path"
						mono
						emptyLabel="All non-sensitive settings"
						values={row.paths ?? []}
						options={serverGrantPathOptions()}
						onChange={(paths) => onPatch(row.id, { paths })}
					/>
				</div>
			)

		default:
			return assertNever(scope)
	}
}

// unknown ids (a server that has since been deleted) stay selectable so opening the editor can't silently drop a grant
function serverOptionsFor(servers: { id: string; displayName: string }[], selected: string[]): ComboBoxOption<string>[] {
	const known: ComboBoxOption<string>[] = servers.map((s) => ({
		value: s.id,
		label: `${s.displayName} (${s.id})`,
		keywords: [s.displayName],
	}))
	const unknown = selected.filter((id) => !servers.some((s) => s.id === id)).map((id) => ({ value: id }))
	return [...unknown, ...known]
}

// One dropdown per selected value rather than a single multi-select: the values here are long (dotted setting paths,
// `Display Name (server-id)`) and a combined trigger could only show them comma-joined and ellipsed, which truncated
// exactly the tail that distinguishes them.
function ScopeValueRows(
	{ title, values, options, onChange, emptyLabel, mono }: {
		title: string
		values: string[]
		options: (ComboBoxOption<string> | string)[]
		onChange: (next: string[]) => void
		// an empty scope means unrestricted, which reads as a bug unless it's spelled out
		emptyLabel: string
		mono?: boolean
	},
) {
	// the not-yet-chosen row that `Add` opens. It lives here rather than in `values` so an abandoned Add can't write an
	// empty entry back to the settings draft.
	const [adding, setAdding] = React.useState(false)
	// Add is one intent, so it opens the dropdown it just swapped itself out for rather than asking for a second click.
	// Driven off the transition, not a callback ref: the imperative handle is rebuilt whenever the popover's own `open`
	// changes, which would re-fire a ref callback and reopen a box the user had just dismissed.
	const pendingRef = React.useRef<ComboBoxHandle>(null)
	React.useEffect(() => {
		if (adding) pendingRef.current?.focus()
	}, [adding])
	const normalized: ComboBoxOption<string>[] = options.map((o) => (typeof o === 'string' ? { value: o } : o))
	const selected = new Set(values)
	const exhausted = normalized.every((o) => selected.has(o.value))

	// a value already used in a sibling row would be a no-op grant, so only the row holding it may keep it
	function optionsFor(own?: string): ComboBoxOption<string>[] {
		return normalized.map((o) => (o.value !== own && selected.has(o.value) ? { ...o, disabled: true } : o))
	}
	const boxClass = cn('w-full max-w-[22rem]', mono && 'font-mono')

	return (
		<div className="space-y-1">
			{values.length === 0 && !adding && <p className="text-xs leading-8 text-muted-foreground">{emptyLabel}</p>}
			{values.map((value, idx) => (
				<div key={value} className="flex items-center gap-1">
					<ComboBox
						title={title}
						className={boxClass}
						value={value}
						options={optionsFor(value)}
						onSelect={(next) => next && onChange(values.map((v, i) => (i === idx ? next : v)))}
					/>
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className="h-8 w-8 shrink-0 text-destructive"
						onClick={() => onChange(values.filter((_, i) => i !== idx))}
					>
						<Icons.X className="h-4 w-4" />
					</Button>
				</div>
			))}
			{
				/* Add swaps itself out for the empty dropdown rather than sitting disabled above it, so the control you clicked is
			    the control you then pick from. It comes back once the pick lands (or the X cancels). */
			}
			{adding
				? (
					<div className="flex items-center gap-1">
						<ComboBox
							ref={pendingRef}
							title={title}
							className={boxClass}
							placeholder={`Select ${title}...`}
							value={undefined}
							options={optionsFor()}
							onSelect={(next) => {
								if (next) onChange([...values, next])
								setAdding(false)
							}}
						/>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-8 w-8 shrink-0 text-destructive"
							onClick={() => setAdding(false)}
						>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
				)
				: (
					// exhausted is a different story from adding: the button stays, disabled, to say there's nothing left to pick
					<Button type="button" size="sm" variant="outline" className="h-7" disabled={exhausted} onClick={() => setAdding(true)}>
						<Icons.Plus className="mr-1 h-3.5 w-3.5" />
						Add {title}
					</Button>
				)}
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

function overrideFor(path: Path, _node: Node): React.FC<OverrideProps> | undefined {
	const last = path[path.length - 1]
	if (path.length === 1 && last === 'adminListSources') return AdminListSourcesField
	if (path.length === 1 && last === 'allowedPrefixes') return AllowedPrefixesField
	// each command renders as one compact card (which itself renders the strings sub-editor), so there's no separate strings override
	if (path.length === 2 && path[0] === 'commands') return CommandCard
	if (path.length === 1 && last === 'commandAliases') return CommandAliasesField
	if (path.length === 1 && last === 'adminActionReasons') return AdminActionReasonsField
	if (path.length === 1 && last === 'broadcasts') return BroadcastsField
	if (path.length === 1 && last === 'layerTable') return LayerTableField
	if (path.length === 1 && last === 'layerGeneration') return LayerGenerationField
	if (path.length === 1 && last === 'playerFlagsRequiringNote') return FlagMultiSelectField
	if (path.length === 1 && last === 'playerGroupings') return PlayerGroupingsField
	// the entire `rbac` subtree is rendered by RbacBody (see FieldControl), so no per-field rbac overrides are needed here
	// server settings: the pool configuration reuses the dashboard popover's panels; connection passwords are masked
	if (path.length === 2 && path[0] === 'queue' && last === 'mainPool') return MainPoolField
	if (path.length === 2 && path[0] === 'queue' && last === 'generationPool') return GenerationPoolField
	if (path.length === 2 && path[0] === 'connections' && last === 'token') return ServerAgentTokenField
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

	const value = (useFieldValue(value$, reset$) as any[]) ?? []

	// array of enum -> multi-select
	if (inner.enum && inner.type !== 'array' && inner.type !== 'object') {
		return <EnumArrayField value$={value$} reset$={reset$} onChange={onChange} options={inner.enum} />
	}

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
	const { normal, advanced } = splitAdvanced(Object.keys(props), path.join('.'), React.useContext(AdvancedPathsContext))
	const field = (key: string) => (
		<Field key={key} name={key} node={props[key]} path={[...path, key]} parent$={value$} parentOnChange={onChange} reset$={reset$} />
	)
	return (
		<div className="space-y-3">
			{normal.map((key) => field(key))}
			{advanced.length > 0 && (
				<AdvancedDisclosure paths={advanced.map((key) => [...path, key].join('.'))}>
					{advanced.map((key) => field(key))}
				</AdvancedDisclosure>
			)}
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

// -------- advanced disclosure --------

// The collapsed tail of a section: the fields most installs never touch (see settings-groups.ts). `paths` are the
// dotted paths it holds, so it can open itself when one of them is navigated to (the TOC lists advanced settings like
// any other) or when one of them fails validation, which must never be hidden behind a collapsed row.
function AdvancedDisclosure({ paths, children }: { paths: string[]; children: React.ReactNode }) {
	const [expanded, setExpanded] = React.useState(false)
	const { idPrefix } = React.useContext(FormOptionsContext)
	const covers = React.useCallback((candidate: string, prefix: string) => {
		return paths.some((p) => {
			const full = `${prefix}${p}`
			return candidate === full || candidate.startsWith(`${full}.`)
		})
	}, [paths])

	React.useEffect(() => SettingsNav.onAnchorNavigate((id) => covers(id, idPrefix) && setExpanded(true)), [covers, idPrefix])

	const hasIssue = React.useContext(ValidationContext).some((i) => covers(i.path, ''))
	const open = expanded || hasIssue
	return (
		<div className="rounded-md border border-dashed">
			<button
				type="button"
				className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={open}
			>
				<Icons.ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
				Advanced
				<span className="opacity-60">({paths.length})</span>
				{hasIssue && <Icons.TriangleAlert className="h-3 w-3 text-destructive" />}
			</button>
			{open && <div className="space-y-3 border-t px-2 py-3">{children}</div>}
		</div>
	)
}

// -------- scoped json editor --------

// lazily loaded so a settings visit that never opens a JSON editor doesn't pay for the CodeMirror bundle. The `as`
// casts restore the generic component signature React.lazy erases (same as the page-level editor in routes/settings).
const SchemaJsonEditor = React.lazy(
	() => import('@/components/schema-json-editor') as unknown as Promise<{ default: React.FC<any> }>,
) as unknown as typeof SchemaJsonEditorComponent

// which editor a field with a scoped JSON editor is currently showing, mirroring the page-level section modes
type FieldMode = 'gui' | 'json'

// the sub-schema for this field's scoped JSON editor, or undefined when it doesn't offer one
function useLocalJsonSchema(pathStr: string): z.ZodType | undefined {
	const rootSchema = React.useContext(RootSchemaContext)
	return React.useMemo(
		// splitting pathStr rather than taking the path array keeps this memo stable: the array is rebuilt every render.
		// Only the declared paths are split, and those have no dots inside a segment.
		() => (rootSchema && LOCAL_JSON_EDITOR_PATHS.has(pathStr) ? Zod.schemaAtPath(rootSchema, pathStr.split('.')) : undefined),
		[rootSchema, pathStr],
	)
}

// the GUI/JSON segmented control the settings-page section headers use, scaled down to sit in a field's header row.
// `ml-auto` pins it to the right end of that row, where the page-level control sits in its own header.
function LocalModeToggle({ mode, onSelect }: { mode: FieldMode; onSelect: (next: FieldMode) => void }) {
	return (
		<div className="ml-auto flex items-center rounded-md border p-0.5">
			{(['gui', 'json'] as const).map((option) => (
				<Button
					key={option}
					type="button"
					size="sm"
					variant={mode === option ? 'secondary' : 'ghost'}
					className="h-5 px-1.5 text-[10px]"
					onClick={() => onSelect(option)}
				>
					{option === 'gui' ? 'GUI' : 'JSON'}
				</Button>
			))}
		</div>
	)
}

// The form's drafts hold the input/encoded shape, but the editor validates through the sub-schema, which yields the
// decoded shape (e.g. HumanTime as milliseconds). Encode back where the schema allows it; a subtree carrying a
// one-way transform can't encode at all, and its output shape is its input shape anyway.
function toInputShape(schema: z.ZodType, decoded: unknown): unknown {
	try {
		return schema.encode(decoded)
	} catch {
		return decoded
	}
}

// A JSON editor over one subtree of the form, swapped in for that field's widget. The editor owns its buffer while
// open: handing our own edits straight back as `value` would re-sync the document mid-keystroke, so it's only re-seeded
// on reset$, which is exactly the programmatic-change signal the uncontrolled inputs re-read on. Re-seeding remounts it
// rather than passing a new `value`, because the editor re-syncs only when `value` differs from what it last synced,
// and a reset typically restores the very value it was seeded with (leaving the user's edits sitting in the buffer).
function LocalJsonField(
	{ schema, label, domId, value$, reset$, onChange }: {
		schema: z.ZodType
		label: string
		// the field's own anchor, which the editor renders inside: the scroll target once the editor is up
		domId: string
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: any) => void
	},
) {
	const [seed, setSeed] = React.useState(() => ({ value: value$.getValue(), nonce: 0 }))
	useReset(reset$, () => setSeed((prev) => ({ value: value$.getValue(), nonce: prev.nonce + 1 })))
	const onValidChange = React.useCallback((v: unknown) => {
		if (v === null) return
		onChange(toInputShape(schema, v))
	}, [schema, onChange])
	// only the first mount scrolls: re-seeding after a reset remounts the editor, and yanking the viewport for that
	// would be a surprise. This component only exists while the field is in JSON mode, so the ref resets on reopen.
	const broughtIntoView = React.useRef(false)
	const onReady = React.useCallback(() => {
		if (broughtIntoView.current) return
		broughtIntoView.current = true
		SettingsNav.scrollToAnchorSettled(domId)
	}, [domId])
	return (
		<React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading editor…</p>}>
			<SchemaJsonEditor
				key={seed.nonce}
				schema={schema}
				value={seed.value}
				onValidChange={onValidChange}
				onReady={onReady}
				minHeightPx={320}
				label={label}
			/>
		</React.Suspense>
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
	const jsonSchema = useLocalJsonSchema(pathStr)
	const [mode, setMode] = React.useState<FieldMode>('gui')
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
					{jsonSchema && writable && <LocalModeToggle mode={mode} onSelect={setMode} />}
				</div>
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
				{SectionExtra && <SectionExtra />}
				<FieldIssues issues={sectionIssues} pathStr={pathStr} />
				{jsonSchema && mode === 'json'
					? (
						<LocalJsonField
							schema={jsonSchema}
							label={settingLabel(path, name)}
							domId={domId}
							value$={value$}
							reset$={reset$}
							onChange={onChange}
						/>
					)
					: <FieldControl node={node} path={path} value$={value$} reset$={reset$} onChange={onChange} />}
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
	const jsonSchema = useLocalJsonSchema(pathStr)
	const [mode, setMode] = React.useState<FieldMode>('gui')
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
					{jsonSchema && writable && <LocalModeToggle mode={mode} onSelect={setMode} />}
				</div>
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
				<FieldIssues issues={fieldIssues} pathStr={pathStr} />
			</div>
			<div className={cn(isBoolean && 'shrink-0 flex items-center gap-1')} inert={!writable}>
				{isBoolean && controls}
				{jsonSchema && mode === 'json'
					? (
						<LocalJsonField
							schema={jsonSchema}
							label={settingLabel(path, name)}
							domId={domId}
							value$={value$}
							reset$={reset$}
							onChange={onChange}
						/>
					)
					: <FieldControl node={node} path={path} value$={value$} reset$={reset$} onChange={onChange} />}
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
	// keys managed inline by a sibling editor render no field of their own (e.g. defaultPrefix, chosen via the
	// "default" markers in the allowedPrefixes editor)
	if (path.length === 1 && HIDDEN_GLOBAL_SETTINGS_KEYS.has(name)) return null
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
	const advancedPaths = React.useContext(AdvancedPathsContext)
	const field = (key: string) => (
		<Field key={key} name={key} node={props[key]} path={[key]} parent$={value$} parentOnChange={onChange} reset$={reset$} />
	)
	// each group carries its own advanced tail, so a rarely-touched setting stays with the settings it belongs to
	const renderKeys = (keys: string[]) => {
		const { normal, advanced } = splitAdvanced(keys, '', advancedPaths)
		return (
			<>
				{normal.map((key) => field(key))}
				{advanced.length > 0 && <AdvancedDisclosure paths={advanced}>{advanced.map((key) => field(key))}</AdvancedDisclosure>}
			</>
		)
	}
	return (
		<div className="space-y-6">
			{grouped.map(({ group, keys }) => (
				<GroupSection key={group.slug} slug={group.slug} label={group.label}>
					{renderKeys(keys)}
				</GroupSection>
			))}
			{renderKeys(ungrouped)}
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
	{
		schema,
		value$,
		reset$,
		onChange,
		saved,
		idPrefix = 'setting:',
		groups,
		priorityKeys,
		advancedPaths = NO_ADVANCED_PATHS,
		issues,
		writeAccess = WRITE_ACCESS_ALL,
	}: {
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
		// dotted paths of the fields that render inside their section's collapsed "Advanced" disclosure (see settings-groups.ts)
		advancedPaths?: ReadonlySet<string>
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
			<RootValueContext.Provider value={value$}>
				<RootOnChangeContext.Provider value={onChange}>
					<RootSchemaContext.Provider value={schema}>
						<AdvancedPathsContext.Provider value={advancedPaths}>
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
						</AdvancedPathsContext.Provider>
					</RootSchemaContext.Provider>
				</RootOnChangeContext.Provider>
			</RootValueContext.Provider>
		</FormOptionsContext.Provider>
	)
}
