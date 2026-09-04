import { useQuery } from '@tanstack/react-query'
import * as TSR from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'
import { HexColorPicker } from 'react-colorful'

import { BmFlagMultiSelect, BmFlagSelect } from '@/components/bm-flag-picker'
import ComboBox, { type ComboBoxOption } from '@/components/combo-box/combo-box'
import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { LOADING } from '@/components/combo-box/constants.ts'
import { DiscordChannelMultiSelect, DiscordChannelSelect, DiscordMemberSelect, DiscordRoleSelect } from '@/components/discord-picker'
import { FilterMultiSelect, FilterSelect } from '@/components/filter-entity-select'
import LayerGenerationConfigEditor from '@/components/layer-generation-config-editor'
import LayerTableConfigEditor from '@/components/layer-table-config-editor'
import { ListEditor } from '@/components/list-editor.tsx'
import { PoolFiltersPanel, RepeatRulesPanel } from '@/components/pool-config-panels'
import type { PoolConfigApi } from '@/components/pool-config-panels.helpers'
import { RichText } from '@/components/rich-text'
import { ServerMultiSelect, ServerSelect } from '@/components/server-select'
import { serverOptionsFor } from '@/components/server-select.helpers.ts'
import { StickyGroup } from '@/components/sticky-group'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import * as Arr from '@/lib/array-utils'
import { createId } from '@/lib/id'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import type { SettingsGroup } from '@/lib/settings-groups'
import { HIDDEN_SETTINGS_KEYS, LOCAL_YAML_EDITOR_PATHS, splitAdvanced, splitByGroups } from '@/lib/settings-groups'
import { humanize, settingLabel } from '@/lib/settings-labels'
import * as SettingsNav from '@/lib/settings-nav'
import * as Templating from '@/lib/templating'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import { z } from '@/lib/zod'
import * as ZodUtils from '@/lib/zod-utils'
import * as Zus from '@/lib/zustand'
import * as AAR_Msgs from '@/messages/admin-action-reasons.messages'
import * as CMD_Msgs from '@/messages/command.messages'
import * as LTag_Msgs from '@/messages/layer-tags.messages'
import * as PG_Msgs from '@/messages/player-groupings.messages'
import * as RBAC_Msgs from '@/messages/rbac.messages'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import * as AAR from '@/models/admin-action-reasons.models'
import type * as BM from '@/models/battlemetrics.models'
import * as CMDH from '@/models/command-help.models'
import * as CMD from '@/models/command.models'
import * as LP from '@/models/labeled-presets.models'
import * as LC from '@/models/layer-columns'
import * as LTag from '@/models/layer-tags.models'
import * as PG from '@/models/player-groupings.models'
import * as PLG from '@/models/plugins.models'
import * as PermRows from '@/models/rbac-perm-rows'
import * as SETTINGS from '@/models/settings.models'
import type * as SM from '@/models/squad.models'
import * as SquadModels from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ConfigClient from '@/systems/config.client'
import * as DndKit from '@/systems/dndkit.client'
import * as MessagesClient from '@/systems/messages.client'
import { tr } from '@/systems/messages.client'
import * as PluginsClient from '@/systems/plugins.client'
import * as SettingsClient from '@/systems/settings.client'
import * as UsersClient from '@/systems/users.client'

import type SchemaYamlEditorComponent from './schema-yaml-editor'
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
//
// The `reset$` pulse is synchronous, so it lands while the inputs still hold their PREVIOUS `value$` bindings,
// before React has re-rendered with the new ones. A structural edit that changes a value's shape or removes a row
// therefore runs the old projection against the new data: a union-shaped field reads the wrong variant, and a
// projection indexed by row position reads an index that no longer exists. Guard the projection (return undefined
// for a row that is gone) rather than deferring the pulse, which the uncontrolled inputs depend on being immediate.

type Node = any
type Path = (string | number)[]

// a trigger with no level configured is not evaluated at all; the picker needs a value to represent that

// a BehaviorSubject-like handle: subscribable, plus a synchronous `.getValue()` for the current value
type ValueState<T = any> = Zus.ValueObservable<T>

const DEBOUNCE_MS = 250

// -------- state plumbing --------

// derive a child value-state scoped to `key` of the parent. distinctUntilChanged keeps copy-on-write siblings quiet.
function scopeValue(parent$: ValueState, key: string | number): ValueState {
	const child$ = parent$.pipe(
		Rx.map((v: any) => v?.[key]),
		Rx.distinctUntilChanged(),
	) as ValueState
	child$.getValue = () => (parent$.getValue() as any)?.[key]
	return child$
}

// derive a child value-state through a projection rather than a key, for a child whose shape in the parent varies
// (a union member). Same contract as scopeValue.
function mapValue<T, U>(parent$: ValueState<T>, project: (v: T) => U): ValueState<U> {
	const child$ = parent$.pipe(Rx.map(project), Rx.distinctUntilChanged()) as ValueState<U>
	child$.getValue = () => project(parent$.getValue())
	return child$
}

// current value of a field, for widgets that render controlled. Takes no reset$: a reset writes the draft, which
// every value state is derived from, so the emission it already causes is the re-read. Uncontrolled inputs are the
// ones the pulse exists for -- see useReset.
function useFieldValue<T>(value$: ValueState<T>): T {
	return Zus.useStore(value$)
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

// the draft's custom message variable definitions (rbac-style sibling read), unresolved so the reason preview can
// re-resolve them per entry with the standard variables (duration, squadName) that entry is showing
const MessageVarsContext = React.createContext<Templating.TemplateVarDef[]>([])

function readMessageVarDefs(v: any): Templating.TemplateVarDef[] {
	return ((v?.messageVariables ?? []) as { name?: string; value?: string }[]).flatMap((mv) =>
		mv.name ? [{ name: mv.name, value: mv.value ?? '' }] : [],
	)
}

// This one feeds a context at the form root, so it must hold its identity while the contents match: a fresh array
// per draft change would re-render the whole form on every keystroke. The selector is memoized per form instance
// rather than at module scope because the settings page mounts one form per section.
function useMessageVars(value$: ValueState): Templating.TemplateVarDef[] {
	const prevRef = React.useRef<Templating.TemplateVarDef[]>([])
	const read = React.useCallback((v: any) => {
		const prev = prevRef.current
		const next = readMessageVarDefs(v)
		const same = prev.length === next.length && next.every((d, i) => prev[i].name === d.name && prev[i].value === d.value)
		if (!same) prevRef.current = next
		return prevRef.current
	}, [])
	return Zus.useStore(value$, read)
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

// the zod schema of the whole document, so a field can resolve the sub-schema at its own path for its scoped YAML
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
				<p className="text-xs text-destructive/80">{tr.text(SETTINGS_Msgs.moreIssues(issues.length - MAX_SHOWN_FIELD_ISSUES))}</p>
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
	const superUsers = superRes.data?.code === 'ok' ? superRes.data.superUsers : []
	const superRoles = superRes.data?.code === 'ok' ? superRes.data.superRoles : []
	const rolesRes = useQuery(RPC.orpc.rbac.listGuildRoles.queryOptions({ staleTime: Infinity }))
	const guildRoles = rolesRes.data?.code === 'ok' ? rolesRes.data.roles : []
	const userIds = superUsers.map(BigInt)
	const usersRes = UsersClient.useUsers(userIds, { enabled: userIds.length > 0 })
	const userMap = new Map((usersRes.data?.code === 'ok' ? usersRes.data.users : []).map((u) => [String(u.discordId), u]))

	if (superUsers.length === 0 && superRoles.length === 0) return null

	return (
		<div className="space-y-2 rounded-md border border-info/40 bg-info/10 p-3">
			<p className="flex items-center gap-1.5 text-sm font-medium">
				<Icons.ShieldCheck className="h-4 w-4 shrink-0" />
				{tr.text(RBAC_Msgs.superUsersAndRoles())}
			</p>
			<p className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.superBlurb())}</p>
			{superUsers.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.superUsersLabel())}</span>
					{superUsers.map((id) => (
						<span key={id} className="rounded border bg-background px-1.5 py-0.5 text-xs" title={id}>
							{userMap.get(id)?.displayName ?? <span className="font-mono">{id}</span>}
						</span>
					))}
				</div>
			)}
			{superRoles.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.superRolesLabel())}</span>
					{superRoles.map((id) => {
						const role = guildRoles.find((r) => r.id === id)
						return (
							<span key={id} className="flex items-center gap-1.5 rounded border bg-background px-1.5 py-0.5 text-xs" title={id}>
								{role ? (
									<>
										<span
											className="h-2 w-2 shrink-0 rounded-full border"
											style={{ backgroundColor: role.color ?? 'transparent' }}
										/>
										{role.name}
									</>
								) : (
									<span className="font-mono">{id}</span>
								)}
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
	const value = useFieldValue(value$)
	return <BmFlagMultiSelect value={value ?? []} onChange={onChange} />
}

// The languages this build ships a catalogue for. A stored tag this build no longer carries stays in the list, so
// the setting shows what it actually holds rather than reading as unset; the runtime already falls back to English
// for it. Each language is named in itself, which is what someone who cannot read the current one needs.
function LocaleField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string | undefined
	const available = MessagesClient.availableLocales()
	const tags = value && !available.includes(value) ? [...available, value] : available
	return (
		<ComboBox
			className="w-min"
			title={tr.text(SETTINGS_Msgs.localePicker())}
			allowEmpty={false}
			value={value}
			options={tags.map((tag) => ({ value: tag, label: MessagesClient.endonym(tag), keywords: [tag] }))}
			onSelect={(tag) => tag !== undefined && onChange(tag)}
		/>
	)
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
	const value = (useFieldValue(value$) as PlayerGroupingsValue) ?? {}
	const groupingIds = Object.keys(value)
	const orgFlags = BattlemetricsClient.useOrgFlags()
	// the union across running servers -- fetched once here rather than per rule row
	const adminGroupsQuery = useQuery(RPC.orpc.squadServer.listAdminListGroups.queryOptions({ staleTime: 60_000 }))
	const adminGroupOptions: ComboBoxOption<string>[] | typeof LOADING = adminGroupsQuery.data
		? adminGroupsQuery.data.map((name) => ({ value: name, label: name }))
		: LOADING

	// `quiet` skips reset$: use it for edits driven by an uncontrolled input (the group name), where re-emitting would
	// clobber an in-flight keystroke. Structural edits leave it off so inputs re-seed after re-indexing.
	const update = (fn: (v: PlayerGroupingsValue) => PlayerGroupingsValue, quiet?: boolean) => {
		onChange(fn((value$.getValue() as PlayerGroupingsValue) ?? {}))
		if (!quiet) reset$.next()
	}

	// every rule edit re-syncs the group map, so a group can never outlive the last rule naming it
	const updateGrouping = (id: string, fn: (g: PG.Grouping) => PG.Grouping, quiet?: boolean) => {
		update((v) => {
			const next = fn(v[id] ?? PG.EMPTY_GROUPING)
			return { ...v, [id]: { ...next, groups: syncedGroups(next, orgFlags) } }
		}, quiet)
	}

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
			{groupingIds.length === 0 && <p className="text-xs text-muted-foreground">{tr.text(PG_Msgs.noGroupings())}</p>}
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
					placeholder={tr.text(PG_Msgs.newGroupingName())}
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
					<Icons.Plus className="mr-1 h-4 w-4" />
					{tr.text(PG_Msgs.addGrouping())}
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

// A rule of the given source with nothing filled in yet, keeping only the group, which every source shares.
function emptyRuleFor(type: PG.GroupRuleSource, group: string): PG.GroupRule {
	switch (type) {
		case 'battlemetrics':
			return { type, flag: '', group }
		case 'admin-list':
			return { type, adminGroup: '', group }
		case 'server-admin':
			return { type, group }
		case 'name-regex':
			return { type, pattern: '', group }
		case 'discord-role':
			return { type, roleId: '', group }
		default:
			return assertNever(type)
	}
}

// What a rule matches on, which is the one part of a row that differs per source. `server-admin` has nothing to
// pick: being an admin is the whole condition, so the cell says so rather than showing an empty control.
function RuleValueField({
	rule,
	idx,
	usedFlags,
	usedAdminGroups,
	usedRoleIds,
	adminGroupOptions,
	value$,
	reset$,
	onChange,
}: {
	rule: PG.GroupRule
	idx: number
	usedFlags: string[]
	usedAdminGroups: string[]
	usedRoleIds: string[]
	adminGroupOptions: ComboBoxOption<string>[] | typeof LOADING
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (idx: number, patch: Partial<PG.GroupRule>, quiet?: boolean) => void
}) {
	switch (rule.type) {
		case 'battlemetrics':
			return <BmFlagSelect value={rule.flag || undefined} exclude={usedFlags} onChange={(flag) => onChange(idx, { flag })} />
		case 'admin-list':
			return (
				<ComboBox
					title={tr.text(PG_Msgs.adminGroupPicker())}
					value={rule.adminGroup || undefined}
					options={
						adminGroupOptions === LOADING
							? LOADING
							: adminGroupOptions.filter((o) => o.value === rule.adminGroup || !usedAdminGroups.includes(o.value))
					}
					onSelect={(adminGroup) => {
						if (adminGroup) onChange(idx, { adminGroup })
					}}
				/>
			)
		case 'server-admin':
			return <span className="text-xs text-muted-foreground">{tr.text(PG_Msgs.serverAdminRuleValue())}</span>
		case 'name-regex':
			return <RulePatternField rule={rule} idx={idx} value$={value$} reset$={reset$} onChange={onChange} />
		case 'discord-role':
			return (
				<DiscordRoleSelect
					value={rule.roleId}
					onChange={(roleId) => {
						if (!usedRoleIds.includes(roleId) || roleId === rule.roleId) onChange(idx, { roleId })
					}}
				/>
			)
		default:
			return assertNever(rule)
	}
}

// Uncontrolled like the group name beside it, for the same reason: re-emitting on every keystroke would clobber the
// one in flight. The pattern is validated as it is typed rather than only on save, since an invalid one is rejected
// by the schema and would otherwise fail the whole settings write with nothing pointing at this row.
function RulePatternField({
	rule,
	idx,
	value$,
	reset$,
	onChange,
}: {
	rule: Extract<PG.GroupRule, { type: 'name-regex' }>
	idx: number
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (idx: number, patch: Partial<PG.GroupRule>, quiet?: boolean) => void
}) {
	const invalid = rule.pattern.trim() !== '' && PG.compilePattern(rule.pattern) === null
	return (
		<div className="min-w-0 space-y-1">
			<TextInputField
				value$={scopeValue(scopeValue(scopeValue(value$, 'rules'), idx), 'pattern')}
				reset$={reset$}
				onChange={(next) => onChange(idx, { pattern: (next as string) ?? '' }, true)}
				numeric={false}
				placeholder={tr.text(PG_Msgs.namePatternPlaceholder())}
			/>
			{invalid && <p className="text-xs text-destructive">{tr.text(PG_Msgs.invalidNamePattern())}</p>}
		</div>
	)
}

function RuleRow({
	rule,
	idx,
	groupingId,
	groupNames,
	groupColors,
	usedFlags,
	usedAdminGroups,
	usedRoleIds,
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
	usedRoleIds: string[]
	adminGroupOptions: ComboBoxOption<string>[] | typeof LOADING
	value$: ValueState
	reset$: Rx.Subject<void>
	onReplace: (idx: number, rule: PG.GroupRule) => void
	onChange: (idx: number, patch: Partial<PG.GroupRule>, quiet?: boolean) => void
	onRemove: () => void
}) {
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
		onReplace(idx, emptyRuleFor(type, rule.group))
	}
	return (
		<li
			ref={drag.ref}
			data-dragging={drag.isDragging}
			className="grid grid-cols-[auto_1.5rem_7rem_minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-background data-[dragging=true]:opacity-40"
		>
			<button
				type="button"
				ref={drag.handleRef}
				className="cursor-grab rounded text-muted-foreground"
				aria-label={tr.text(PG_Msgs.dragToReorder())}
			>
				<Icons.GripVertical className="h-4 w-4" />
			</button>
			<span className="text-xs tabular-nums text-muted-foreground">{idx + 1}.</span>
			<Select value={rule.type} onValueChange={(next) => setSource(next as PG.GroupRuleSource)}>
				<SelectTrigger className="h-8" aria-label={tr.text(PG_Msgs.ruleSource())}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{PG.GROUP_RULE_SOURCES.map((source) => (
						<SelectItem key={source} value={source} title={tr.text(PG_Msgs.groupRuleSourceHints[source])}>
							{tr.text(PG_Msgs.groupRuleSourceLabels[source])}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<RuleValueField
				rule={rule}
				idx={idx}
				usedFlags={usedFlags}
				usedAdminGroups={usedAdminGroups}
				usedRoleIds={usedRoleIds}
				adminGroupOptions={adminGroupOptions}
				value$={value$}
				reset$={reset$}
				onChange={onChange}
			/>
			<Icons.ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			{namingNewGroup ? (
				<div className="flex min-w-0 items-center gap-1">
					<TextInputField
						value$={scopeValue(scopeValue(scopeValue(value$, 'rules'), idx), 'group')}
						reset$={reset$}
						onChange={(next) => onChange(idx, { group: (next as string) ?? '' }, true)}
						numeric={false}
						placeholder={tr.text(PG_Msgs.groupNamePlaceholder())}
					/>
					{groupNames.length > 0 && (
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-6 w-6 shrink-0"
							title={tr.text(PG_Msgs.pickExistingGroup())}
							aria-label={tr.text(PG_Msgs.pickExistingGroup())}
							onClick={() => setNamingNewGroup(false)}
						>
							<Icons.List className="h-4 w-4" />
						</Button>
					)}
				</div>
			) : (
				<ComboBox
					title={tr.text(PG_Msgs.groupPicker())}
					value={rule.group || undefined}
					options={[
						...groupNames.map((name): ComboBoxOption<string> => ({
							value: name,
							label: <span style={{ color: groupColors[name] }}>{name}</span>,
						})),
						{
							value: ADD_NEW_GROUP,
							label: <span className="text-muted-foreground">{tr.text(PG_Msgs.addNewGroup())}</span>,
							keywords: ['new'],
						},
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
				aria-label={tr.text(PG_Msgs.removeRule())}
				onClick={onRemove}
			>
				<Icons.X className="h-4 w-4" />
			</Button>
		</li>
	)
}

function GroupingCard({
	groupingId,
	grouping,
	value$,
	reset$,
	orgFlags,
	adminGroupOptions,
	onUpdate,
	onRemove,
}: {
	groupingId: string
	grouping: PG.Grouping
	value$: ValueState
	reset$: Rx.Subject<void>
	orgFlags: BM.PlayerFlag[] | undefined
	adminGroupOptions: ComboBoxOption<string>[] | typeof LOADING
	onUpdate: (id: string, fn: (g: PG.Grouping) => PG.Grouping, quiet?: boolean) => void
	onRemove: (id: string) => void
}) {
	const rules = grouping.rules ?? []
	// a rule the operator is still filling in names no group yet, and an unnamed color row is just noise
	const groupNames = PG.getGroupNames(grouping).filter(Boolean)
	const groupColors = Object.fromEntries(groupNames.map((name) => [name, PG.getGroupColor(grouping, name, orgFlags)]))

	function changeRule(idx: number, patch: Partial<PG.GroupRule>, quiet?: boolean) {
		onUpdate(groupingId, (g) => ({ ...g, rules: g.rules.map((r, i) => (i === idx ? ({ ...r, ...patch } as PG.GroupRule) : r)) }), quiet)
	}
	function replaceRule(idx: number, rule: PG.GroupRule) {
		onUpdate(groupingId, (g) => ({ ...g, rules: g.rules.map((r, i) => (i === idx ? rule : r)) }))
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
	DndKit.useDragEnd(
		React.useCallback((evt) => {
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
			onUpdate(groupingId, (g) => ({ ...g, rules: Arr.moveItem(g.rules, from.idx, to.idx, position) }))
		}, []),
	)

	return (
		<div className="space-y-3 rounded-md border p-3">
			<div className="flex items-center justify-between gap-2">
				<span className="text-sm font-medium">{groupingId}</span>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="h-6 w-6 shrink-0 text-destructive"
					aria-label={tr.text(PG_Msgs.removeGrouping(groupingId))}
					onClick={() => onRemove(groupingId)}
				>
					<Icons.X className="h-4 w-4" />
				</Button>
			</div>

			<div className="space-y-1.5">
				<Label className="text-xs text-muted-foreground">{tr.text(PG_Msgs.rules())}</Label>
				<p className="text-xs text-muted-foreground">{tr.text(PG_Msgs.rulesBlurb())}</p>
				{rules.length === 0 && <p className="text-xs text-muted-foreground">{tr.text(PG_Msgs.noRules())}</p>}
				{rules.length > 0 && (
					// column headers, aligned to the same grid template as RuleRow
					<div className="grid grid-cols-[auto_1.5rem_7rem_minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 px-0 text-xs font-medium text-muted-foreground">
						<span />
						<span />
						<span />
						<span>{tr.text(PG_Msgs.matchesColumn())}</span>
						<span />
						<span>{tr.text(PG_Msgs.mappedGroupingColumn())}</span>
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
								usedFlags={rules.flatMap((r) => (r.type === 'battlemetrics' ? [r.flag] : []))}
								usedAdminGroups={rules.flatMap((r) => (r.type === 'admin-list' ? [r.adminGroup] : []))}
								usedRoleIds={rules.flatMap((r) => (r.type === 'discord-role' ? [r.roleId] : []))}
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
					<Icons.Plus className="mr-1 h-4 w-4" />
					{tr.text(PG_Msgs.addRule())}
				</Button>
			</div>

			{groupNames.length > 0 && (
				<details>
					<summary className="cursor-pointer text-xs text-muted-foreground">
						{tr.text(PG_Msgs.colorsSummary(groupNames.length))}
					</summary>
					<p className="mt-1 text-xs text-muted-foreground">{tr.text(PG_Msgs.colorsBlurb())}</p>
					<ul className="mt-1.5 space-y-1">
						{groupNames.map((group) => (
							<GroupColorRow
								key={group}
								group={group}
								grouping={grouping}
								orgFlags={orgFlags}
								value$={value$}
								reset$={reset$}
								onSetColor={setGroupColor}
							/>
						))}
					</ul>
				</details>
			)}
		</div>
	)
}

// One group's color: the swatch and the hex code are the same control, and the flag it follows sits after them. The
// hex field always shows the color in effect, flag-derived or not, so editing it is how a group stops tracking.
function GroupColorRow({
	group,
	grouping,
	orgFlags,
	value$,
	reset$,
	onSetColor,
}: {
	group: string
	grouping: PG.Grouping
	orgFlags: BM.PlayerFlag[] | undefined
	value$: ValueState
	reset$: Rx.Subject<void>
	onSetColor: (group: string, color: PG.GroupColor, quiet?: boolean) => void
}) {
	const hexRef = React.useRef<HTMLInputElement>(null)
	const color = grouping.groups?.[group]?.color
	const resolved = PG.getGroupColor(grouping, group, orgFlags)
	const flags = PG.getGroupFlags(grouping, group)

	const seedHex = (hex: string) => {
		if (hexRef.current && hexRef.current.value !== hex) hexRef.current.value = hex
	}
	// the pulse lands before React re-renders, so the new color has to be read off value$ rather than the props. A
	// group the edit removed is gone from it, and has no color left to show.
	useReset(reset$, () => {
		const current = value$.getValue() as PG.Grouping | undefined
		if (current?.groups?.[group]) seedHex(PG.getGroupColor(current, group, orgFlags))
	})

	// `quiet` so a keystroke is not clobbered mid-edit, which also means an edit from anywhere else has to write the
	// uncontrolled input back by hand
	const setCustom = (hex: string, fromHexField?: boolean) => {
		if (!fromHexField) seedHex(hex)
		onSetColor(group, { type: 'custom', color: hex }, true)
	}

	return (
		<li className="grid grid-cols-[minmax(0,8rem)_auto_minmax(0,1fr)] items-center gap-2">
			<span className="min-w-0 truncate text-xs" title={group}>
				{group}
			</span>
			<InputGroup className="h-8 w-[9.5rem]">
				<InputGroupAddon align="inline-start">
					<Popover>
						<PopoverTrigger asChild>
							<InputGroupButton size="icon-xs" title={tr.text(PG_Msgs.pickColor())} aria-label={tr.text(PG_Msgs.pickColor())}>
								<span className="size-4 rounded-sm border" style={{ backgroundColor: resolved }} />
							</InputGroupButton>
						</PopoverTrigger>
						<PopoverContent className="w-auto p-2">
							<HexColorPicker color={resolved} onChange={(c) => setCustom(c)} />
						</PopoverContent>
					</Popover>
				</InputGroupAddon>
				{/* a bare input (not InputGroupInput, whose custom Input wraps the control in a div that breaks the flex row) */}
				<input
					ref={hexRef}
					data-slot="input-group-control"
					defaultValue={resolved}
					maxLength={7}
					autoComplete="off"
					spellCheck={false}
					onChange={(e) => setCustom(e.currentTarget.value.trim(), true)}
					className="w-full min-w-0 bg-transparent py-1 pr-2 font-mono text-xs outline-none"
				/>
			</InputGroup>
			{flags.length > 0 && (
				<span className="flex min-w-0 items-center gap-2">
					<span className="shrink-0 text-xs text-muted-foreground">{tr.text(PG_Msgs.trackingFlag())}</span>
					<BmFlagSelect
						title={tr.text(PG_Msgs.colorFromFlag())}
						placeholder={tr.text(PG_Msgs.trackNoFlag())}
						value={color?.type === 'flag' ? color.flag : undefined}
						only={flags}
						onChange={(flag) => onSetColor(group, { type: 'flag', flag })}
					/>
				</span>
			)}
		</li>
	)
}

// -------- command prefixes editor --------

// a small "?" affordance that reveals a longer explanation on hover, so compact editors can drop verbose inline
// descriptions. `links` render as buttons that jump to (and highlight) another setting by its anchor id.
function HelpTip({ text, links }: { text: string; links?: { label: string; anchor: string }[] }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button type="button" className="text-muted-foreground hover:text-foreground" aria-label={tr.text(SETTINGS_Msgs.help())}>
					<Icons.CircleHelp className="h-3.5 w-3.5" />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs space-y-1.5">
				<p>{text}</p>
				{links && links.length > 0 && (
					<div className="flex flex-wrap gap-x-3 gap-y-1">
						{links.map((link) => (
							<button
								key={link.anchor}
								type="button"
								className="inline-flex items-center gap-1 text-primary underline hover:no-underline"
								onClick={() => SettingsNav.navigateToAnchor(link.anchor)}
							>
								<Icons.ArrowRight className="h-3 w-3 shrink-0" />
								{link.label}
							</button>
						))}
					</div>
				)}
			</TooltipContent>
		</Tooltip>
	)
}

// re-point an inline string from `oldPrefix` to `newPrefix`
function repointPrefix(str: string, oldPrefix: string, newPrefix: string): string {
	return newPrefix + str.slice(oldPrefix.length)
}

type CommandsMap = Record<string, { triggers?: CMD.CommandTrigger[] } | undefined>

// only a trigger's string carries a prefix; its args template is arguments, which never do
function mapTriggerStrings(commands: CommandsMap, fn: (s: string) => string): CommandsMap {
	const out: CommandsMap = {}
	for (const [id, cmd] of Object.entries(commands)) {
		out[id] = { ...cmd, triggers: (cmd?.triggers ?? []).map((t) => CMD.withTriggerString(t, fn(CMD.triggerString(t)))) }
	}
	return out
}

// one editable prefix. The char input is committed on blur/Enter (not per keystroke) because committing propagates a
// rewrite across every string using it; re-seeded by remounting (its key includes the committed value).
function PrefixRow({
	index,
	prefix,
	isDefault,
	usage,
	replyToUnknown,
	onCommit,
	onSetDefault,
	onSetReplyToUnknown,
	onRemove,
}: {
	index: number
	prefix: string
	isDefault: boolean
	usage: number
	replyToUnknown: boolean
	onCommit: (next: string) => void
	onSetDefault: () => void
	onSetReplyToUnknown: (next: boolean) => void
	onRemove: () => void
}) {
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
				aria-label={tr.text(CMD_Msgs.prefixLabel(index + 1))}
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
				<input type="radio" checked={isDefault} onChange={onSetDefault} aria-label={tr.text(CMD_Msgs.makePrefixDefault(index + 1))} />
				{tr.text(CMD_Msgs.defaultPrefix())}
			</label>
			<label
				className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground"
				title={tr.text(CMD_Msgs.replyToUnknownHint())}
			>
				<Checkbox checked={replyToUnknown} onCheckedChange={(v) => onSetReplyToUnknown(v === true)} className="h-3.5 w-3.5" />
				{tr.text(CMD_Msgs.replyToUnknown())}
			</label>
			<span className="whitespace-nowrap text-xs text-muted-foreground">{tr.text(CMD_Msgs.prefixUses(usage))}</span>
			<Button
				type="button"
				size="icon"
				variant="ghost"
				className="h-6 w-6 shrink-0 text-destructive disabled:opacity-40"
				aria-label={tr.text(CMD_Msgs.removePrefix(index + 1))}
				disabled={!removable}
				title={
					isDefault ? tr.text(CMD_Msgs.defaultPrefixNotRemovable()) : usage > 0 ? tr.text(CMD_Msgs.prefixStillUsed(usage)) : undefined
				}
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
	const root = (useFieldValue(root$) as { defaultPrefix?: string; commands?: CommandsMap } | undefined) ?? {}
	const prefixes = (useFieldValue(value$) as CMD.PrefixConfig[] | undefined) ?? []
	const commands = root.commands ?? {}
	const defaultPrefix = root.defaultPrefix ?? prefixes[0]?.prefix ?? ''

	const [newPrefix, setNewPrefix] = React.useState('')

	function writeRoot(patch: Record<string, unknown>) {
		const cur = (root$.getValue() as Record<string, unknown>) ?? {}
		rootOnChange?.({ ...cur, ...patch })
		reset$.next()
	}

	function usageOf(prefix: string): number {
		let n = 0
		for (const cmd of Object.values(commands)) {
			for (const t of cmd?.triggers ?? []) if (CMD.prefixUsedBy(prefixes, CMD.triggerString(t))?.prefix === prefix) n++
		}
		return n
	}

	function commitEdit(idx: number, next: string) {
		const oldPrefix = prefixes[idx].prefix
		if (!next || next === oldPrefix || !CMD.isValidPrefix(next)) return
		const nextPrefixes = prefixes.map((p, i) => (i === idx ? { ...p, prefix: next } : p))
		// target by the OLD prefix list so longest-match stays stable while rewriting
		const nextCommands = mapTriggerStrings(commands, (s) =>
			CMD.prefixUsedBy(prefixes, s)?.prefix === oldPrefix ? repointPrefix(s, oldPrefix, next) : s,
		)
		writeRoot({
			allowedPrefixes: nextPrefixes,
			commands: nextCommands,
			defaultPrefix: defaultPrefix === oldPrefix ? next : defaultPrefix,
		})
	}

	const newTrimmed = newPrefix.trim()
	const newInvalid = newTrimmed !== '' && !CMD.isValidPrefix(newTrimmed)
	const newDuplicate = newTrimmed !== '' && prefixes.some((p) => p.prefix === newTrimmed)
	function addPrefix() {
		if (!newTrimmed || newInvalid || newDuplicate) return
		writeRoot({ allowedPrefixes: [...prefixes, { prefix: newTrimmed, replyToUnknown: true }] })
		setNewPrefix('')
	}

	function removePrefix(idx: number) {
		const { prefix } = prefixes[idx]
		if (prefix === defaultPrefix || usageOf(prefix) > 0) return
		writeRoot({ allowedPrefixes: prefixes.filter((_, i) => i !== idx) })
	}

	return (
		<div className="space-y-2">
			<p className="text-xs text-muted-foreground">{tr.text(CMD_Msgs.prefixesBlurb())}</p>
			<div className="flex flex-wrap items-center gap-3">
				{prefixes.map((p, idx) => (
					<PrefixRow
						// key carries the committed value so the row's uncontrolled draft re-seeds on external change; idx keeps it unique across duplicate prefixes
						// oxlint-disable-next-line no-array-index-key
						key={`${idx}:${p.prefix}`}
						index={idx}
						prefix={p.prefix}
						isDefault={p.prefix === defaultPrefix}
						usage={usageOf(p.prefix)}
						replyToUnknown={p.replyToUnknown}
						onCommit={(next) => commitEdit(idx, next)}
						onSetDefault={() => writeRoot({ defaultPrefix: p.prefix })}
						onSetReplyToUnknown={(next) =>
							writeRoot({ allowedPrefixes: prefixes.map((q, i) => (i === idx ? { ...q, replyToUnknown: next } : q)) })
						}
						onRemove={() => removePrefix(idx)}
					/>
				))}
				<div className="flex items-center gap-2">
					<Input
						aria-label={tr.text(CMD_Msgs.newPrefix())}
						className={cn(
							'h-7 w-16 font-mono text-sm',
							(newInvalid || newDuplicate) && 'border-destructive focus-visible:ring-destructive',
						)}
						title={newInvalid ? CMD.PREFIX_ERROR : newDuplicate ? tr.text(CMD_Msgs.duplicatePrefix()) : undefined}
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
					<Button type="button" variant="outline" size="sm" disabled={!newTrimmed || newInvalid || newDuplicate} onClick={addPrefix}>
						{tr.text(CMD_Msgs.addPrefix())}
					</Button>
				</div>
			</div>
		</div>
	)
}

// The seed for a trigger being given pinned arguments. Correct as-is for a single-argument command; for anything else
// it fails validation immediately, and the message names the arguments the command actually takes, which is the
// fastest way to tell the admin what to write.
const NEW_TRIGGER_ARGS = '{{rest}}'

// bespoke editor for a command's `triggers` array (inline-prefixed, short). A plain trigger is one input; pinning
// arguments to it grows a second one on the same row rather than moving it to a table of its own, since it is still
// just a way of running this command.
function CommandTriggersField({ value$, reset$, onChange, cmdId }: OverrideProps & { cmdId: CMD.CommandId }) {
	const triggers = (useFieldValue(value$) as CMD.CommandTrigger[] | undefined) ?? []
	const root$ = React.useContext(RootValueContext) ?? EMPTY_ROOT_VALUE$
	// scoped rather than read off the root: this field renders once per command, and subscribing each one to the whole
	// document would re-render all of them on every keystroke anywhere in the form
	const requireReasonFor$ = scopeValue(root$, 'requireReasonFor')
	const requireReasonFor = useFieldValue(requireReasonFor$) as AAR.AdminActionType[] | undefined
	const signature = React.useMemo(() => CMD.argTemplateSignature(cmdId, requireReasonFor ?? []), [cmdId, requireReasonFor])
	const current = () => (value$.getValue() as CMD.CommandTrigger[]) ?? []
	function structural(next: CMD.CommandTrigger[]) {
		onChange(next)
		reset$.next()
	}
	const setAt = (idx: number, next: CMD.CommandTrigger) => onChange(current().map((t, i) => (i === idx ? next : t)))

	return (
		<div className="space-y-1">
			{triggers.map((trigger, idx) => {
				const args = CMD.triggerArgs(trigger)
				const trigger$ = scopeValue(value$, idx)
				return (
					// oxlint-disable-next-line no-array-index-key
					<div key={idx} className="flex items-center gap-1">
						<div className="w-40 shrink-0">
							<TextInputField
								value$={mapValue(trigger$, (t) => CMD.triggerString(t ?? ''))}
								reset$={reset$}
								numeric={false}
								placeholder={tr.text(CMD_Msgs.triggerStringPlaceholder())}
								onChange={(v) => setAt(idx, CMD.withTriggerString(current()[idx] ?? '', v ?? ''))}
							/>
						</div>
						{args === undefined ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-6 px-2 text-xs text-muted-foreground"
								title={tr.text(CMD_Msgs.pinArgsHint())}
								onClick={() =>
									structural(current().map((t, i) => (i === idx ? { string: CMD.triggerString(t), args: NEW_TRIGGER_ARGS } : t)))
								}
							>
								{tr.text(CMD_Msgs.pinArgs())}
							</Button>
						) : (
							<>
								<div className="min-w-0 flex-1">
									<TextInputField
										value$={mapValue(trigger$, (t) => CMD.triggerArgs(t ?? '') ?? '')}
										reset$={reset$}
										numeric={false}
										placeholder={tr.text(CMD_Msgs.pinnedArgsPlaceholder())}
										onChange={(v) => {
											const t = current()[idx] ?? ''
											// Unpin's reset pulse reaches this input before it unmounts; taking that for an edit would re-pin the row
											if (CMD.triggerArgs(t) === undefined) return
											setAt(idx, { string: CMD.triggerString(t), args: v ?? '' })
										}}
									/>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-6 px-2 text-xs text-muted-foreground"
									title={tr.text(CMD_Msgs.unpinArgsHint())}
									onClick={() => structural(current().map((t, i) => (i === idx ? CMD.triggerString(t) : t)))}
								>
									{tr.text(CMD_Msgs.unpinArgs())}
								</Button>
							</>
						)}
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-6 w-6 shrink-0 text-destructive"
							aria-label={tr.text(CMD_Msgs.removeTrigger(idx + 1))}
							onClick={() => structural(triggers.filter((_, i) => i !== idx))}
						>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
				)
			})}
			<div className="flex items-center gap-2">
				<Button type="button" variant="outline" size="sm" onClick={() => structural([...current(), ''])}>
					<Icons.Plus className="mr-1 h-4 w-4" />
					{tr.text(CMD_Msgs.addTrigger())}
				</Button>
			</div>
			{/* only where a template is actually being edited: this field renders once per command, and the signature under
			    every one of them buries the commands themselves */}
			{triggers.some((t) => CMD.triggerArgs(t) !== undefined) && (
				<div className="space-y-0.5 text-xs text-muted-foreground">
					{signature.length === 0 ? (
						<span>{tr.text(CMD_Msgs.takesNoArguments())}</span>
					) : (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span>{tr.text(CMD_Msgs.takesArguments())}</span>
							{signature.map(({ ref, arg }) => (
								<span key={ref} className="whitespace-nowrap">
									<code className="rounded bg-muted px-1 py-0.5 font-mono">{ref}</code>
									<span className="ml-1 font-mono">{arg}</span>
								</span>
							))}
						</div>
					)}
					<span>{tr.text(CMD_Msgs.argTemplateHelp())}</span>
				</div>
			)}
		</div>
	)
}

// compact editor for a single command (`commands.<id>`): collapses the triggers/allowedChats/enabled sub-sections into a
// couple of tight rows, moving their descriptions into `?` tooltips. The command name + reset come from the LeafField
// shell. Schema issues (e.g. a trigger missing an allowed prefix) still surface under the card via the field's issues.
function CommandCard({ value$, reset$, onChange, path }: OverrideProps) {
	const cmdId = path[1] as CMD.CommandId
	const cfg = (useFieldValue(value$) as { allowedChats?: CMD.ChatGroup[]; enabled?: boolean; quickReference?: boolean }) ?? {}
	const allowedChats = cfg.allowedChats ?? []
	const enabled = cfg.enabled ?? true
	const quickReference = cfg.quickReference ?? false
	const triggers$ = scopeValue(value$, 'triggers')
	function patch(p: Record<string, unknown>) {
		onChange({ ...((value$.getValue() as Record<string, unknown>) ?? {}), ...p })
	}
	return (
		<div className="space-y-2">
			<div className="space-y-1">
				<span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
					{tr.text(CMD_Msgs.triggers())} <HelpTip text={tr.text(CMD_Msgs.triggersHelp())} />
				</span>
				<CommandTriggersField value$={triggers$} reset$={reset$} onChange={(v) => patch({ triggers: v })} path={[]} cmdId={cmdId} />
			</div>
			<div className="flex flex-wrap items-center gap-4">
				<div className="flex items-center gap-2">
					<span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
						{tr.text(CMD_Msgs.allowedChats())} <HelpTip text={tr.text(CMD_Msgs.allowedChatsHelp())} />
					</span>
					<ComboBoxMulti
						title={tr.text(CMD_Msgs.allowedChats())}
						values={allowedChats}
						options={CMD.CHAT_GROUPS.options.map((group) => ({ value: group, label: tr.text(CMD_Msgs.chatGroupLabels[group]) }))}
						onSelect={(next) => patch({ allowedChats: typeof next === 'function' ? next(allowedChats) : next })}
					/>
				</div>
				<label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
					<Switch checked={enabled} onCheckedChange={(v) => patch({ enabled: v })} />
					{tr.text(CMD_Msgs.enabled())}
				</label>
				<label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
					<Checkbox checked={quickReference} onCheckedChange={(v) => patch({ quickReference: v === true })} />
					<span className="flex items-center gap-1">
						{tr.text(CMD_Msgs.quickReference())}
						<HelpTip text={tr.text(CMD_Msgs.quickReferenceHelp())} />
					</span>
				</label>
			</div>
		</div>
	)
}

function PasswordField({ value$, reset$, onChange }: OverrideProps) {
	return (
		<TextInputField
			value$={value$}
			reset$={reset$}
			onChange={onChange}
			numeric={false}
			secret
			placeholder={tr.text(SETTINGS_Msgs.passwordPlaceholder())}
		/>
	)
}

// the server-agent's shared secret: masked by default, with generate-a-new-token and copy-to-clipboard affordances. The
// input is uncontrolled (seeded from value$, debounced upward, re-read on reset$), same as TextInputField.
function ServerAgentTokenField({ value$, reset$, onChange }: OverrideProps) {
	const ref = React.useRef<HTMLInputElement>(null)
	const [show, setShow] = React.useState(false)
	const [copied, setCopied] = React.useState(false)
	const copiedTimeout = React.useRef<ReturnType<typeof setTimeout>>(null)
	const push = useDebounced<any>({ delay: DEBOUNCE_MS, onChange })
	const repoUrl = Zus.useStore(ConfigClient.Store, (s) => s?.repoUrl)
	const docUrl = repoUrl ? `${repoUrl}/blob/HEAD/docs/server_agent.md` : undefined
	const format = (v: any) => (v === null || v === undefined ? '' : String(v))
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
	React.useEffect(
		() => () => {
			if (copiedTimeout.current) clearTimeout(copiedTimeout.current)
		},
		[],
	)

	return (
		<div className="space-y-1.5">
			<InputGroup>
				{/* a bare input (not InputGroupInput, whose custom Input wraps the control in a div that breaks the flex row) */}
				<input
					ref={ref}
					data-slot="input-group-control"
					type={show ? 'text' : 'password'}
					defaultValue={format(value$.getValue())}
					placeholder={tr.text(SETTINGS_Msgs.serverAgentTokenPlaceholder())}
					autoComplete="off"
					spellCheck={false}
					onChange={(e) => push(e.currentTarget.value)}
					className="flex-1 min-w-0 bg-transparent px-3 py-1 font-mono text-sm outline-none placeholder:text-muted-foreground placeholder:font-sans"
				/>
				<InputGroupAddon align="inline-end">
					<InputGroupButton
						size="icon-xs"
						aria-label={show ? tr.text(SETTINGS_Msgs.hideToken()) : tr.text(SETTINGS_Msgs.showToken())}
						onClick={() => setShow((s) => !s)}
					>
						{show ? <Icons.EyeOff /> : <Icons.Eye />}
					</InputGroupButton>
					<InputGroupButton size="icon-xs" aria-label={tr.text(SETTINGS_Msgs.copyToken())} onClick={copy}>
						{copied ? <Icons.Check /> : <Icons.Copy />}
					</InputGroupButton>
					<InputGroupButton size="xs" onClick={generate}>
						<Icons.RefreshCw />
						{tr.text(SETTINGS_Msgs.generateToken())}
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
			<p className="text-xs text-muted-foreground">
				{tr.text(SETTINGS_Msgs.serverAgentTokenBlurb())}{' '}
				{docUrl && (
					<a href={docUrl} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
						{tr.text(SETTINGS_Msgs.serverAgentSetupGuide())}
					</a>
				)}
			</p>
		</div>
	)
}
// bespoke editor for the layer-table config (column order/visibility, default sort, extra menu items, default filters)
function LayerTableField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$)
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
	const value = useFieldValue(value$)
	return <LayerGenerationConfigEditor value={value ?? LC.LayerGenerationConfigSchema.parse({})} onChange={onChange} reset$={reset$} />
}

// shared table shell for the label/keywords preset lists (admin action reasons)
type PresetRowProps = {
	idx: number
	parent$: ValueState
	reset$: Rx.Subject<void>
	parentOnChange: (v: any[]) => void
	onRemove: () => void
}

function PresetTableField({
	value$,
	reset$,
	onChange,
	headers,
	newRow,
	Row,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any[]) => void
	headers: React.ReactNode
	newRow: () => object
	Row: React.ComponentType<PresetRowProps>
}) {
	const value = (useFieldValue(value$) as object[] | undefined) ?? []

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
				{tr.text(SETTINGS_Msgs.addItem())}
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
					<TableHead className="w-44">{tr.text(AAR_Msgs.labelColumn())}</TableHead>
					<TableHead>{tr.text(AAR_Msgs.textsColumn())}</TableHead>
					<TableHead className="w-8" />
				</>
			}
			newRow={() => ({ label: '', keywords: [], actionTexts: {} })}
			Row={AdminActionReasonRow}
		/>
	)
}

function LayerTagsField({ value$, reset$, onChange }: OverrideProps) {
	return (
		<PresetTableField
			value$={value$}
			reset$={reset$}
			onChange={onChange}
			headers={
				<>
					<TableHead className="w-[12rem]">{tr.text(LTag_Msgs.labelColumn())}</TableHead>
					<TableHead>{tr.text(LTag_Msgs.descriptionColumn())}</TableHead>
					<TableHead className="w-[9rem]">{tr.text(LTag_Msgs.colorColumn())}</TableHead>
					<TableHead className="w-8" />
				</>
			}
			newRow={() => ({ id: '', label: '', description: '', color: LTag.suggestColor([]) })}
			Row={LayerTagRow}
		/>
	)
}

function LayerTagRow({ idx, parent$, reset$, parentOnChange, onRemove }: PresetRowProps) {
	const row$ = scopeValue(parent$, idx)
	const descriptionRef = React.useRef<HTMLTextAreaElement>(null)
	const row = useFieldValue(row$) as LTag.Tag | undefined
	const colorRef = React.useRef<HTMLInputElement>(null)

	const setFields = (patch: Partial<LTag.Tag>) => {
		const arr = [...((parent$.getValue() as LTag.Tag[]) ?? [])]
		arr[idx] = { ...arr[idx], ...patch }
		parentOnChange(arr)
	}

	// a row's id is minted from the label the first time it's committed and is immutable from then on, so a later rename
	// keeps the tag attached to every layer carrying it. Only a row that has never had an id can still take one.
	const commitLabel = (label: string) => {
		const current = (parent$.getValue() as LTag.Tag[] | undefined)?.[idx]
		setFields(current?.id ? { label } : { label, id: label.trim() ? LTag.createTagId(label) : '' })
	}

	const setColor = (color: string) => {
		if (colorRef.current && colorRef.current.value !== color) colorRef.current.value = color
		setFields({ color })
	}

	return (
		<TableRow>
			<TableCell className="align-top">
				<Input
					defaultValue={row?.label ?? ''}
					maxLength={LTag.MAX_LABEL_LENGTH}
					placeholder={tr.text(LTag_Msgs.labelColumn())}
					onBlur={(e) => commitLabel(e.target.value)}
				/>
				{row?.id && <p className="mt-1 font-mono text-2xs text-muted-foreground">{row.id}</p>}
			</TableCell>
			<TableCell className="align-top">
				<Textarea
					ref={descriptionRef}
					defaultValue={row?.description ?? ''}
					maxLength={LTag.MAX_DESCRIPTION_LENGTH}
					className="min-h-8 text-sm"
					placeholder={tr.text(LTag_Msgs.descriptionPlaceholder())}
					onBlur={(e) => setFields({ description: e.target.value })}
				/>
			</TableCell>
			<TableCell className="align-top">
				<div className="flex items-center space-x-1">
					<Popover>
						<PopoverTrigger asChild>
							<button
								type="button"
								title={tr.text(LTag_Msgs.pickColor())}
								className="h-6 w-6 shrink-0 rounded border"
								style={{ backgroundColor: row?.color ?? LTag.DELETED_TAG_COLOR }}
							/>
						</PopoverTrigger>
						<PopoverContent className="w-auto p-2">
							<HexColorPicker color={row?.color ?? LTag.DELETED_TAG_COLOR} onChange={setColor} />
						</PopoverContent>
					</Popover>
					<Input
						ref={colorRef}
						defaultValue={row?.color ?? ''}
						maxLength={7}
						className="w-24 font-mono text-xs"
						onBlur={(e) => setFields({ color: e.target.value.trim() })}
					/>
				</div>
			</TableCell>
			<TableCell className="align-top">
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="h-8 w-8 text-destructive"
					title={tr.text(LTag_Msgs.deleteTag())}
					onClick={onRemove}
				>
					<Icons.X className="h-4 w-4" />
				</Button>
			</TableCell>
		</TableRow>
	)
}

function AdminActionReasonRow({ idx, parent$, reset$, parentOnChange, onRemove }: PresetRowProps) {
	const row$ = React.useMemo(() => scopeValue(parent$, idx), [parent$, idx])
	const label$ = scopeValue(row$, 'label')
	const keywords$ = scopeValue(row$, 'keywords')
	const actionTexts$ = scopeValue(row$, 'actionTexts')
	// the set of actions this reason carries text for; keys are added/removed structurally (emits reset$)
	const actionTexts = (useFieldValue(actionTexts$) as Partial<Record<AAR.AdminActionType, string>> | undefined) ?? {}
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
			<TableCell className="align-top gap-0.5 h-full">
				<TextInputField
					value$={label$}
					reset$={reset$}
					onChange={setField('label')}
					numeric={false}
					placeholder={tr.text(AAR_Msgs.labelPlaceholder())}
				/>
				<KeywordsCell value$={keywords$} reset$={reset$} seedFrom$={label$} onChange={setField('keywords')} />
			</TableCell>
			<TableCell className="align-top">
				<div className="space-y-1.5">
					{presentActions.length === 0 && <p className="text-xs text-destructive">{tr.text(AAR_Msgs.noActionTexts())}</p>}
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
										title={tr.text(AAR_Msgs.removeActionText(AAR.ADMIN_ACTIONS[action].displayName))}
										onClick={() => removeAction(action)}
									>
										<Icons.X className="h-3.5 w-3.5" />
									</Button>
								</div>
								<TextAreaCell
									value$={text$}
									reset$={reset$}
									onChange={setActionText(action)}
									placeholder={tr.text(AAR_Msgs.actionTextPlaceholder(AAR.ADMIN_ACTIONS[action].displayName))}
								/>
							</div>
						)
					})}
					{remainingActions.length > 0 && (
						<Select value="" onValueChange={(a) => addAction(a as AAR.AdminActionType)}>
							<SelectTrigger className="h-8">
								<SelectValue placeholder={tr.text(AAR_Msgs.addActionText())} />
							</SelectTrigger>
							<SelectContent>
								{remainingActions.map((a) => (
									<SelectItem key={a} value={a}>
										{AAR.ADMIN_ACTIONS[a].displayName}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</div>
			</TableCell>
			<TableCell className="align-top">
				<div className="flex flex-col gap-1">
					<Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={onRemove}>
						<Icons.X className="h-4 w-4" />
					</Button>
					<ReasonPreviewButton row$={row$} reset$={reset$} />
				</div>
			</TableCell>
		</TableRow>
	)
}

// the sample squad name the preview substitutes for {{squadName}} in squad-targeted contexts
const PREVIEW_SQUAD_NAME = 'Squad1'

// the verbatim rendered text each applicable context delivers in-game (squad contexts get the @Squad1 tag),
// with the given custom message variables applied. Standard variables (duration, squadName) are resolved per
// entry so custom variables referencing them render as they would at action time. timeouts are shown with a 2h
// sample duration, and again with the remaining duration (what enforcement re-renders on rejoin) so
// {{#duration}} sections can be checked both ways.
function reasonPreviewEntries(reason: AAR.AdminActionReason, varDefs: Templating.TemplateVarDef[]): { context: string; text: string }[] {
	const applied = (action: AAR.AdminActionType, opts?: { audienceTag?: string; extraVars?: Record<string, string> }) =>
		AAR.formatAppliedReason(action, reason, {
			audienceTag: opts?.audienceTag,
			vars: Templating.resolveTemplateVars(varDefs, { squadName: '', ...opts?.extraVars }),
		})
	const entries: { context: string; text: string }[] = []
	// kill/kick/timeout have squad forms delivering the same action text with {{squadName}} set, so a squad entry
	// is added only when it actually renders differently
	const pushSquadVariant = (action: AAR.AdminActionType, extraVars?: Record<string, string>) => {
		const base = applied(action, { extraVars })
		const squad = applied(action, { extraVars: { ...extraVars, squadName: PREVIEW_SQUAD_NAME } })
		if (squad !== base) {
			entries.push({ context: tr.text(AAR_Msgs.previewSquadVariant(AAR.ADMIN_ACTIONS[action].displayName)), text: squad })
		}
	}
	// one entry per action the reason carries text for; squad-directed actions get the @Squad1 tag
	for (const action of AAR.ADMIN_ACTION_TYPE.options) {
		if (reason.actionTexts[action] === undefined) continue
		if (action === 'warn') {
			entries.push({ context: tr.text(AAR_Msgs.previewWarn()), text: applied('warn') })
			entries.push({
				context: tr.text(AAR_Msgs.previewWarnSquad()),
				text: applied('warn', { audienceTag: '@Squad1', extraVars: { squadName: PREVIEW_SQUAD_NAME } }),
			})
			continue
		}
		if (action === 'timeout') {
			entries.push({ context: tr.text(AAR_Msgs.previewTimeout()), text: applied('timeout', { extraVars: { duration: '2h' } }) })
			pushSquadVariant('timeout', { duration: '2h' })
			entries.push({ context: tr.text(AAR_Msgs.previewTimeoutExpired()), text: applied('timeout', { extraVars: { duration: '' } }) })
			continue
		}
		const squadTargeted = AAR.ADMIN_ACTIONS[action].targetKind === 'squad'
		entries.push({
			context: AAR.ADMIN_ACTIONS[action].displayName,
			text: applied(action, {
				audienceTag: squadTargeted ? '@Squad1' : undefined,
				extraVars: squadTargeted ? { squadName: PREVIEW_SQUAD_NAME } : undefined,
			}),
		})
		if (action === 'kill' || action === 'kick') pushSquadVariant(action)
	}
	return entries
}

// message templates are rendered with Mustache (see src/lib/templating.ts), so link its reference rather than
// Handlebars': the two share {{variable}} and {{#section}}, but Handlebars' block helpers ({{#if}}, {{#each}}) are
// not available here, and pointing at docs that advertise them would send authors down a dead end
const TEMPLATE_SYNTAX_URL = 'https://mustache.github.io/mustache.5.html'

// which words are the link is the message's; where it points and how it looks are not
const trWithDocLink = tr.withTags({
	link: (chunks) => (
		<a href={TEMPLATE_SYNTAX_URL} target="_blank" rel="noopener noreferrer">
			{chunks}
		</a>
	),
})

function TemplateSyntaxHint() {
	return (
		<p className="text-xs text-muted-foreground [&_a]:text-info [&_a]:hover:underline">
			{trWithDocLink.richText(AAR_Msgs.templateSyntaxHint())}
		</p>
	)
}

function ReasonPreviewButton({ row$, reset$ }: { row$: ValueState; reset$: Rx.Subject<void> }) {
	const raw = useFieldValue(row$) as Partial<AAR.AdminActionReason> | undefined
	const varDefs = React.useContext(MessageVarsContext)
	// tolerate incomplete draft rows so the preview shows the message shape while it's being written
	const actionTexts = Object.fromEntries(
		Object.entries(raw?.actionTexts ?? {}).map(([action, text]) => [
			action,
			(text ?? '').trim() || tr.text(AAR_Msgs.previewMissingActionText()),
		]),
	) as Partial<Record<AAR.AdminActionType, string>>
	const reason: AAR.AdminActionReason = {
		label: raw?.label?.trim() || tr.text(AAR_Msgs.previewMissingLabel()),
		keywords: raw?.keywords ?? [],
		actionTexts,
	}
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button type="button" size="icon" variant="ghost" className="h-8 w-8" title={tr.text(AAR_Msgs.previewTitle())}>
					<Icons.Eye className="h-4 w-4" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-96 space-y-2" align="end">
				<p className="text-xs text-muted-foreground">{tr.text(AAR_Msgs.previewBlurb())}</p>
				<TemplateSyntaxHint />
				{reasonPreviewEntries(reason, varDefs).map((entry) => (
					<div key={entry.context} className="space-y-1">
						<p className="text-xs font-medium">{entry.context}</p>
						<MessagePreviewBox>{entry.text}</MessagePreviewBox>
					</div>
				))}
			</PopoverContent>
		</Popover>
	)
}

// minimally-styled uncontrolled textarea cell: seeded from value$, edits debounced upward, re-read on reset$
function TextAreaCell({
	value$,
	reset$,
	onChange,
	placeholder,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: string) => void
	placeholder?: string
}) {
	const ref = React.useRef<HTMLTextAreaElement>(null)
	const format = (v: any) => (v === null || v === undefined ? '' : String(v))
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

// Keywords are edited as space/comma-separated text in a single cell and stored as string[] (a keyword can't contain
// whitespace, so the separators are unambiguous). A keyword is required, and typing one out for every reason is busy
// work, so the cell follows `seedFrom$` (the label) for as long as it still holds exactly what that seeded, or nothing
// at all. The first keyword the operator writes themselves stops it -- no dirty flag to keep in sync, since the input's
// own contents already say whether they've taken it over.
function KeywordsCell({
	value$,
	reset$,
	seedFrom$,
	onChange,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	seedFrom$: ValueState
	onChange: (v: string[]) => void
}) {
	const ref = React.useRef<HTMLTextAreaElement>(null)
	const format = (v: string[] | undefined) => (v ?? []).join('\n')
	const parse = (text: string) => text.split(/[,\s]+/).filter(Boolean)
	const push = useDebounced<string[]>({ delay: DEBOUNCE_MS, onChange })
	useReset(reset$, () => {
		const formatted = format(value$.getValue())
		if (ref.current && ref.current.value !== formatted) {
			ref.current.value = formatted
			push(parse(formatted))
		}
	})

	const seedSource = useFieldValue(seedFrom$) as string | undefined
	const lastSeed = React.useRef(LP.keywordFromLabel(seedSource ?? ''))
	React.useEffect(() => {
		const seed = LP.keywordFromLabel(seedSource ?? '')
		const previous = lastSeed.current
		lastSeed.current = seed
		if (seed === previous || !ref.current) return
		const current = ref.current.value.trim()
		if (current !== '' && current !== previous) return
		ref.current.value = seed
		push(parse(seed))
	}, [seedSource, push])

	return (
		<Textarea
			ref={(elt) => {
				ref.current = elt
				if (!elt) return
				const parent = ref.current?.parentElement
				if (!parent) return
				let otherEltsSize = 0
				if (parent) {
					for (const child of parent.children) {
						const childOffsetHeight = (child as HTMLElement).offsetHeight ?? 0
						console.log({ child, offsetHeight: childOffsetHeight, equal: child == elt })
						if (child != elt) otherEltsSize += childOffsetHeight
					}
				}
				if (otherEltsSize > 0) elt.style.height = `${parent.clientHeight - otherEltsSize}px`
			}}
			defaultValue={format(value$.getValue())}
			placeholder={tr.text(AAR_Msgs.keywordsPlaceholder())}
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

// PoolConfigApi over the form's draft observable, so the settings page renders the same pool-configuration UI as the
// dashboard popover. Paths are relative to the pool object this override is mounted on (queue.mainPool).
function usePoolConfigApi({ value$, reset$, onChange }: OverrideProps): PoolConfigApi {
	const [resetKey, setResetKey] = React.useState(0)
	useReset(reset$, () => setResetKey((k) => k + 1))
	return {
		source: value$,
		read: (root, path) => getAtPath(root, path),
		getValue: (path) => getAtPath(value$.getValue(), path),
		set: (path, value) => onChange(setAtPath(value$.getValue(), path, value)),
		// the settings page gates edit access via the server-settings:* perms; out-of-grant writes are rejected server-side
		writeDenied: null,
		resetKey,
	}
}

const PLAYER_PERM_OPTIONS = SquadModels.PLAYER_PERM.options.map((perm) => ({ value: perm }))

const ADMIN_SOURCE_TYPES = ['remote', 'local', 'ftp', 'sftp'] as const satisfies readonly SM.AdminListSourceType[]

function defaultAdminSource(type: SM.AdminListSourceType): SM.AdminListSource {
	if (type === 'sftp') return { type: 'sftp', host: '', port: 22, username: '', password: '', filePath: '' }
	return { type, source: '' }
}

// a never-emitting stand-in so useFieldValue can be called unconditionally when there is no root document (e.g. tests)
const EMPTY_ROOT_VALUE$ = new Rx.BehaviorSubject<any>(undefined) as unknown as ValueState

// Editor for the named admin lists (global settings). Each is a name, one source (remote/local/ftp/sftp) and the
// group permissions that mark an admin *in that list*. The name is what servers and role assignments refer to, so
// renaming one is a breaking edit -- hence the rename is explicit rather than an inline text field that fires per
// keystroke.
// Which of the defined lists apply to this server. A sandbox additionally has one SLM synthesises, which is not
// listed here because there is no source to name -- so say so, rather than leaving the impression that an empty
// selection means the emulated server has no admins.
function ServerAdminListsField({ value$, reset$, onChange }: OverrideProps) {
	const value = (useFieldValue(value$) as string[] | undefined) ?? []
	const root$ = React.useContext(RootValueContext) ?? EMPTY_ROOT_VALUE$
	const connType$ = scopeValue(scopeValue(root$, 'connections'), 'type')
	const isSandbox = useFieldValue(connType$) === 'sandbox'
	const definedLists = useQuery(RPC.orpc.rbac.listAdminListGroups.queryOptions({ staleTime: 60_000 }))
	const available = definedLists.data?.code === 'ok' ? definedLists.data.lists.map((l) => l.listId) : []
	const options = [...new Set([...available, ...value])].sort().map((listId) => ({
		value: listId,
		label: available.includes(listId) ? listId : tr.text(SM_Msgs.adminListNotConfigured(listId)),
	}))

	return (
		<div className="space-y-2">
			<div className="max-w-[28rem]">
				<ComboBoxMulti
					title={tr.text(SM_Msgs.adminListPicker())}
					values={value}
					options={options}
					emptyLabel={tr.text(SM_Msgs.selectAdminLists())}
					chipDisplay
					onSelect={(next) => onChange(typeof next === 'function' ? next(value) : next)}
				/>
			</div>
			{isSandbox && (
				<Alert>
					<Icons.Info className="h-4 w-4" />
					<AlertTitle>{tr.text(SM_Msgs.sandboxAdminListTitle())}</AlertTitle>
					<AlertDescription>{tr.text(SM_Msgs.sandboxAdminListBlurb())}</AlertDescription>
				</Alert>
			)}
		</div>
	)
}

function AdminListsField({ value$, reset$, onChange }: OverrideProps) {
	const value = (useFieldValue(value$) as Record<string, SM.AdminListDef> | undefined) ?? {}
	const names = Object.keys(value)
	const [newName, setNewName] = React.useState('')

	const update = (fn: (v: Record<string, SM.AdminListDef>) => Record<string, SM.AdminListDef>, quiet?: boolean) => {
		onChange(fn((value$.getValue() as Record<string, SM.AdminListDef> | undefined) ?? {}))
		if (!quiet) reset$.next()
	}

	const patchSource = (name: string, p: Partial<SM.AdminListSource>, quiet?: boolean) =>
		update((v) => ({ ...v, [name]: { ...v[name], source: { ...v[name].source, ...p } as SM.AdminListSource } }), quiet)

	const canAdd = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(newName) && !(newName in value)
	function addList() {
		if (!canAdd) return
		update((v) => ({ ...v, [newName]: { source: defaultAdminSource('local'), adminIdentifyingPermissions: [] } }))
		setNewName('')
	}

	return (
		<div className="space-y-3">
			{names.length === 0 && <p className="text-xs text-muted-foreground">{tr.text(SM_Msgs.noAdminLists())}</p>}
			{names.map((name) => {
				const def = value[name]
				const source = def.source
				return (
					<div key={name} className="space-y-2 rounded-md border p-3">
						<div className="flex items-center gap-2">
							<code className="font-mono text-sm font-semibold">{name}</code>
							<Select
								value={source.type}
								onValueChange={(t) =>
									update((v) => ({
										...v,
										[name]: { ...v[name], source: defaultAdminSource(t as SM.AdminListSourceType) },
									}))
								}
							>
								<SelectTrigger className="h-8 w-[9rem]">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{ADMIN_SOURCE_TYPES.map((type) => (
										<SelectItem key={type} value={type}>
											{tr.text(SM_Msgs.adminSourceTypeLabels[type])}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="ml-auto h-7 w-7 text-destructive"
								title={tr.text(SM_Msgs.deleteAdminList(name))}
								onClick={() =>
									update((v) => {
										const next = { ...v }
										delete next[name]
										return next
									})
								}
							>
								<Icons.Trash2 className="h-4 w-4" />
							</Button>
						</div>

						{source.type === 'sftp' ? (
							<div className="grid grid-cols-2 gap-2">
								<Input
									className="h-8"
									placeholder={tr.text(SM_Msgs.sftpHost())}
									defaultValue={source.host}
									onChange={(e) => patchSource(name, { host: e.target.value }, true)}
								/>
								<Input
									className="h-8"
									type="number"
									placeholder="22"
									defaultValue={source.port}
									onChange={(e) => patchSource(name, { port: Number(e.target.value) }, true)}
								/>
								<Input
									className="h-8"
									placeholder={tr.text(SM_Msgs.sftpUsername())}
									defaultValue={source.username}
									onChange={(e) => patchSource(name, { username: e.target.value }, true)}
								/>
								<Input
									className="h-8"
									type="password"
									placeholder={tr.text(SM_Msgs.sftpPassword())}
									defaultValue={source.password}
									onChange={(e) => patchSource(name, { password: e.target.value }, true)}
								/>
								<Input
									className="col-span-2 h-8"
									placeholder={tr.text(SM_Msgs.sftpFilePath())}
									defaultValue={source.filePath}
									onChange={(e) => patchSource(name, { filePath: e.target.value }, true)}
								/>
							</div>
						) : (
							<Input
								className="h-8"
								placeholder={SM_Msgs.adminSourcePlaceholders[source.type]}
								defaultValue={source.source}
								onChange={(e) => patchSource(name, { source: e.target.value }, true)}
							/>
						)}

						<div className="space-y-1">
							<label className="flex items-center gap-1 text-xs text-muted-foreground">
								{tr.text(SM_Msgs.adminIdentifyingPermissions())}
								<HelpTip text={tr.text(SM_Msgs.adminIdentifyingPermissionsHelp())} />
							</label>
							<ComboBoxMulti
								title={tr.text(SM_Msgs.permissionPicker())}
								values={def.adminIdentifyingPermissions}
								options={PLAYER_PERM_OPTIONS}
								emptyLabel={tr.text(SM_Msgs.selectPermissions())}
								chipDisplay
								onSelect={(next) =>
									update((v) => ({
										...v,
										[name]: {
											...v[name],
											adminIdentifyingPermissions: (typeof next === 'function'
												? next(v[name].adminIdentifyingPermissions)
												: next) as SM.PlayerPerm[],
										},
									}))
								}
							/>
						</div>
					</div>
				)
			})}
			<div className="flex items-center gap-1.5">
				<Input
					className="h-8 w-[14rem]"
					placeholder={tr.text(SM_Msgs.newAdminListName())}
					value={newName}
					onChange={(e) => setNewName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key !== 'Enter') return
						e.preventDefault()
						addList()
					}}
				/>
				<Button type="button" size="sm" variant="outline" className="h-8" disabled={!canAdd} onClick={addList}>
					<Icons.Plus className="mr-1 h-4 w-4" />
					{tr.text(SM_Msgs.addAdminList())}
				</Button>
			</div>
		</div>
	)
}

function MainPoolField(props: OverrideProps) {
	const api = usePoolConfigApi(props)
	return (
		<div className="space-y-6">
			<PoolFiltersPanel api={api} />
			<RepeatRulesPanel api={api} />
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
	cachedGlobalGrantPaths ??= enumerateGrantPaths(
		z.toJSONSchema(SETTINGS.GlobalSettingsSchema, { io: 'input', unrepresentable: 'any' }),
	).filter((p) => p !== SETTINGS.COMMENTS_KEY)
	return cachedGlobalGrantPaths
}

// connections is excluded: it's gated by server-settings:write-sensitive, never by path grants
let cachedServerGrantPaths: string[] | undefined
function serverGrantPathOptions(): string[] {
	cachedServerGrantPaths ??= enumerateGrantPaths(
		z.toJSONSchema(SETTINGS.ServerSettingsSchema, { io: 'input', unrepresentable: 'any' }),
	).filter((p) => p !== 'connections' && !p.startsWith('connections.') && p !== SETTINGS.COMMENTS_KEY)
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
	return setRoleField(cfg, 'assignments', isAssignmentEmpty(a) ? undefined : a)
}

function isAssignmentEmpty(a: RoleAssignmentsValue): boolean {
	return (
		(a.discordRoleIds?.length ?? 0) === 0 &&
		(a.discordUserIds?.length ?? 0) === 0 &&
		!a.everyMember &&
		(a.ingameAdminLists?.length ?? 0) === 0 &&
		(a.adminListGroups?.length ?? 0) === 0
	)
}

// "list/group" for the multi-select, which deals in flat strings. Neither an admin list name nor a Squad group name
// may contain a slash, so the first one separates them unambiguously.
function encodeListGroup(listId: string, groupId: string): string {
	return `${listId}/${groupId}`
}

function decodeListGroup(pair: string): { listId: string; groupId: string } | null {
	const idx = pair.indexOf('/')
	if (idx <= 0 || idx === pair.length - 1) return null
	return { listId: pair.slice(0, idx), groupId: pair.slice(idx + 1) }
}

function isRoleAssigned(cfg: RoleConfig | undefined): boolean {
	const a = cfg?.assignments
	return !!a && !isAssignmentEmpty(a)
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
	const rbac = (useFieldValue(value$) as RbacValue) ?? {}
	const roleIds = Object.keys(rbac.roles ?? {})
	const issues = React.useContext(ValidationContext).filter((i) => i.path.startsWith('rbac.'))

	// falls back to the first role while the requested one does not exist, so a rename or delete cannot strand it
	const [requestedRole, setSelected] = React.useState<string | null>(null)
	const selected = requestedRole && roleIds.includes(requestedRole) ? requestedRole : (roleIds[0] ?? null)

	// `quiet` skips reset$: use it for edits driven by an uncontrolled input (the timeout duration field), where re-emitting
	// would clobber an in-flight keystroke. Structural edits (add/remove/rename/toggles) leave it off so inputs re-seed.
	const update = React.useCallback<RbacUpdate>(
		(fn, quiet) => {
			onChange(fn((value$.getValue() as RbacValue) ?? {}))
			if (!quiet) reset$.next()
		},
		[onChange, value$, reset$],
	)

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
					<p className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.roleCount(roleIds.length))}</p>
					<Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={clearAll}>
						<Icons.Trash2 className="mr-1 h-4 w-4" />
						{tr.text(RBAC_Msgs.clearAllRoles())}
					</Button>
				</div>
			)}
			<div className="space-y-3">
				<div className="flex flex-wrap items-center gap-1.5">
					{roleIds.length === 0 && <p className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.noRoles())}</p>}
					{roleIds.map((id) => (
						<button
							key={id}
							type="button"
							onClick={() => setSelected(id)}
							className={cn(
								'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left font-mono text-sm',
								id === selected ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent/50',
							)}
						>
							<span className="max-w-[16rem] truncate">{id}</span>
							{!isRoleAssigned(rbac.roles?.[id]) && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Icons.TriangleAlert className="h-3 w-3 shrink-0 text-warn dark:text-warn" />
									</TooltipTrigger>
									<TooltipContent>{tr.text(RBAC_Msgs.roleUnassignedShort())}</TooltipContent>
								</Tooltip>
							)}
						</button>
					))}
					<div className="flex items-center gap-1.5">
						<Input
							className="h-8 w-[11rem] font-mono"
							placeholder={tr.text(RBAC_Msgs.newRoleId())}
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
				{selected ? (
					<RoleDetail
						key={selected}
						roleId={selected}
						rbac={rbac}
						value$={value$}
						reset$={reset$}
						update={update}
						assigned={isRoleAssigned(rbac.roles?.[selected])}
					/>
				) : (
					<p className="text-sm text-muted-foreground">{tr.text(RBAC_Msgs.selectARole())}</p>
				)}
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

function RoleDetail({
	roleId,
	rbac,
	value$,
	reset$,
	update,
	assigned,
}: {
	roleId: string
	rbac: RbacValue
	value$: ValueState
	reset$: Rx.Subject<void>
	update: RbacUpdate
	assigned: boolean
}) {
	const [renaming, setRenaming] = React.useState(false)
	const cfg = rbac.roles?.[roleId] ?? {}
	// scoped value-states for the timeout / layer-request cells so they can reuse the uncontrolled TextInputField
	const timeout$ = scopeValue(scopeValue(scopeValue(value$, 'roles'), roleId), 'maxTimeout')
	const layerRequests$ = scopeValue(scopeValue(scopeValue(value$, 'roles'), roleId), 'maxLayerRequests')

	return (
		<div className="min-w-0 space-y-4 rounded-md border p-3">
			<div className="flex items-center gap-2">
				{renaming ? (
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
				) : (
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
					{tr.text(RBAC_Msgs.deleteRole())}
				</Button>
			</div>

			<RoleSubsection title={tr.text(RBAC_Msgs.permissions())} description={tr.text(RBAC_Msgs.permissionsBlurb())}>
				<RolePermissionsTable
					roleId={roleId}
					cfg={cfg}
					timeout$={timeout$}
					layerRequests$={layerRequests$}
					reset$={reset$}
					update={update}
				/>
			</RoleSubsection>

			<RoleSubsection title={tr.text(RBAC_Msgs.pluginActions())} description={tr.text(RBAC_Msgs.pluginActionsBlurb())}>
				<RolePluginGrants roleId={roleId} cfg={cfg} update={update} />
			</RoleSubsection>

			<RoleSubsection title={tr.text(RBAC_Msgs.assignments())} description={tr.text(RBAC_Msgs.assignmentsBlurb())}>
				<RoleAssignmentsEditor roleId={roleId} cfg={cfg} update={update} assigned={assigned} />
			</RoleSubsection>
		</div>
	)
}

// What the running plugins define for themselves. Not rows in the permissions table above: that table is keyed by
// permission type alone, and a plugin action needs the plugin's id beside it. Listed from the live declarations so
// an admin picks rather than types, with any grant nothing declares kept and shown as unresolved -- a stopped or
// not-yet-installed plugin must not silently lose the grants an admin made for it.
function RolePluginGrants({ roleId, cfg, update }: { roleId: string; cfg: RoleConfig; update: RbacUpdate }) {
	const plugins = Zus.useStore(PluginsClient.Store, (s) => s.plugins)
	const grants = cfg.pluginGrants ?? []
	const declared = plugins.flatMap((info) => info.permissions.map((decl) => ({ pluginId: info.id, pluginName: info.name, decl })))
	const heldBy = (pluginId: string, name: string) => grants.find((g) => g.pluginId === pluginId && g.permission === name)
	const unresolved = grants.filter((g) => !declared.some((d) => d.pluginId === g.pluginId && d.decl.name === g.permission))

	function setGrants(next: RoleConfig['pluginGrants']) {
		update((r) => withRoleConfig(r, roleId, (c) => ({ ...c, pluginGrants: next })))
	}
	function toggle(pluginId: string, name: string, on: boolean) {
		setGrants(
			on
				? [...grants, { pluginId, permission: name, serverIds: [] }]
				: grants.filter((g) => !(g.pluginId === pluginId && g.permission === name)),
		)
	}
	function setServers(pluginId: string, name: string, serverIds: string[]) {
		setGrants(grants.map((g) => (g.pluginId === pluginId && g.permission === name ? { ...g, serverIds } : g)))
	}

	if (declared.length === 0 && unresolved.length === 0) {
		return <p className="text-sm text-muted-foreground">{tr.text(RBAC_Msgs.noPluginActions())}</p>
	}
	return (
		<div className="space-y-2">
			{declared.map(({ pluginId, pluginName, decl }) => {
				const grant = heldBy(pluginId, decl.name)
				return (
					<div key={`${pluginId}:${decl.name}`} className="flex flex-wrap items-start gap-2">
						<Checkbox className="mt-1" checked={!!grant} onCheckedChange={(v) => toggle(pluginId, decl.name, v === true)} />
						<div className="min-w-0 space-y-0.5">
							<div className="flex flex-wrap items-baseline gap-2">
								<span className="font-mono text-xs">{decl.name}</span>
								<span className="text-xs text-muted-foreground">{pluginName}</span>
							</div>
							<p className="text-xs text-muted-foreground">{decl.description}</p>
							{grant && decl.scope === 'server' && (
								<ServerMultiSelect
									className="max-w-md"
									values={grant.serverIds}
									onChange={(next) => setServers(pluginId, decl.name, next)}
									title={tr.text(RBAC_Msgs.pluginActionServers())}
								/>
							)}
						</div>
					</div>
				)
			})}
			{unresolved.length > 0 && (
				<div className="space-y-1 rounded-md border border-dashed p-2">
					<p className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.pluginActionsUnresolved())}</p>
					{unresolved.map((g) => (
						<div key={`${g.pluginId}:${g.permission}`} className="flex items-center gap-2">
							<code className="text-xs">
								{g.pluginId}:{g.permission}
							</code>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={() => toggle(g.pluginId, g.permission, false)}
							>
								{tr.text(RBAC_Msgs.removeGrant())}
							</Button>
						</div>
					))}
				</div>
			)}
		</div>
	)
}

// one row = one permission the role holds. The five persisted fields are projected to rows on read and distributed back
// on write by PermRows, so this component only ever deals in rows.
function RolePermissionsTable({
	roleId,
	cfg,
	timeout$,
	layerRequests$,
	reset$,
	update,
}: {
	roleId: string
	cfg: RoleConfig
	timeout$: ValueState
	layerRequests$: ValueState
	reset$: Rx.Subject<void>
	update: RbacUpdate
}) {
	const rows = PermRows.rowsFromConfig(cfg)

	// `quiet` is threaded through for the timeout duration cell, whose uncontrolled input would be clobbered by a reset$
	function setRows(next: PermRows.PermRow[], quiet?: boolean) {
		update((r) => withRoleConfig(r, roleId, (c) => PermRows.configFromRows(c, next)), quiet)
	}
	function patchRow(id: string, patch: Partial<PermRows.PermRow>, quiet?: boolean) {
		setRows(
			rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
			quiet,
		)
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
						<TableHead className="w-[7.5rem]">{tr.text(RBAC_Msgs.effectColumn())}</TableHead>
						<TableHead className="w-[16rem]">{tr.text(RBAC_Msgs.permissionColumn())}</TableHead>
						<TableHead>{tr.text(RBAC_Msgs.scopeColumn())}</TableHead>
						<TableHead className="w-10" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.length === 0 && (
						<TableRow>
							<TableCell colSpan={4} className="text-xs text-muted-foreground">
								{tr.text(RBAC_Msgs.noPermissions())}
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
											<SelectItem value="allow">{tr.text(RBAC_Msgs.allow())}</SelectItem>
											<SelectItem value="deny">{tr.text(RBAC_Msgs.deny())}</SelectItem>
										</SelectContent>
									</Select>
								</TableCell>
								<TableCell className="align-top">
									<div className="flex items-start gap-1">
										<code className="text-xs leading-8">
											{row.type === PermRows.ALL_PERMISSIONS ? tr.text(RBAC_Msgs.allPermissions()) : row.type}
										</code>
										{PermRows.permDescription(row.type) && <HelpTip text={PermRows.permDescription(row.type)!} />}
										{subsumed && (
											<Tooltip>
												<TooltipTrigger asChild>
													<Icons.Info className="mt-2 h-3 w-3 shrink-0 text-muted-foreground" />
												</TooltipTrigger>
												<TooltipContent>{tr.text(RBAC_Msgs.subsumedByWildcard())}</TooltipContent>
											</Tooltip>
										)}
									</div>
								</TableCell>
								<TableCell className="align-top">
									<PermScopeCell
										row={row}
										timeout$={timeout$}
										layerRequests$={layerRequests$}
										reset$={reset$}
										onPatch={patchRow}
									/>
								</TableCell>
								<TableCell className="align-top">
									{/* a trash can, not an X: the scope cell's own X drops a single scope value, and the two end up close
									    enough that reusing the icon for "remove the whole permission" would be a trap */}
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
										<TooltipContent>{tr.text(RBAC_Msgs.removePermission())}</TooltipContent>
									</Tooltip>
								</TableCell>
							</TableRow>
						)
					})}
				</TableBody>
			</Table>
			<ComboBox
				title={tr.text(RBAC_Msgs.permissionPicker())}
				placeholder={tr.text(RBAC_Msgs.addPermission())}
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
function PermScopeCell({
	row,
	timeout$,
	layerRequests$,
	reset$,
	onPatch,
}: {
	row: PermRows.PermRow
	timeout$: ValueState
	layerRequests$: ValueState
	reset$: Rx.Subject<void>
	onPatch: (id: string, patch: Partial<PermRows.PermRow>, quiet?: boolean) => void
}) {
	const servers = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers) ?? []

	// a denial is unrestricted by construction: the expression grammar carries no args
	if (row.effect === 'deny') return <span className="text-xs leading-8 text-muted-foreground">{tr.text(RBAC_Msgs.scopeEverything())}</span>

	const scope = PermRows.rowScope(row.type)
	switch (scope) {
		case 'all':
		case 'global':
			return (
				<span className="text-xs leading-8 text-muted-foreground">
					{scope === 'all' ? tr.text(RBAC_Msgs.scopeEverything()) : tr.text(RBAC_Msgs.scopeNone())}
				</span>
			)

		case 'timeout':
			return (
				<div className="flex items-center gap-2">
					<span className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.scopeUpTo())}</span>
					<div className="w-24">
						<TextInputField
							value$={timeout$}
							reset$={reset$}
							onChange={(v) => onPatch(row.id, { maxTimeout: (v as string) || PermRows.DEFAULT_MAX_TIMEOUT }, true)}
							numeric={false}
							placeholder={tr.text(RBAC_Msgs.maxTimeoutPlaceholder())}
						/>
					</div>
				</div>
			)

		case 'layer-requests':
			return (
				<div className="flex items-center gap-2">
					<span className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.scopeUpTo())}</span>
					<div className="w-24">
						<TextInputField
							value$={layerRequests$}
							reset$={reset$}
							onChange={(v) =>
								onPatch(
									row.id,
									{
										maxLayerRequests:
											typeof v === 'number' && Number.isFinite(v) && v >= 1
												? Math.floor(v)
												: PermRows.DEFAULT_MAX_LAYER_REQUESTS,
									},
									true,
								)
							}
							numeric={true}
							placeholder={String(PermRows.DEFAULT_MAX_LAYER_REQUESTS)}
						/>
					</div>
					<span className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.scopeConcurrentRequests())}</span>
				</div>
			)

		case 'global-settings-write':
			return (
				<ScopeValueRows
					kind="setting-path"
					mono
					emptyLabel={tr.text(RBAC_Msgs.scopeAllSettings())}
					values={row.paths ?? []}
					options={globalGrantPathOptions()}
					onChange={(paths) => onPatch(row.id, { paths })}
				/>
			)

		case 'server':
		case 'server-settings':
			return (
				<ScopeValueRows
					kind="server"
					emptyLabel={tr.text(RBAC_Msgs.scopeAllServers())}
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
						kind="server"
						emptyLabel={tr.text(RBAC_Msgs.scopeAllServers())}
						values={row.serverIds ?? []}
						options={serverOptionsFor(servers, row.serverIds ?? [])}
						onChange={(serverIds) => onPatch(row.id, { serverIds })}
					/>
					<ScopeValueRows
						kind="setting-path"
						mono
						emptyLabel={tr.text(RBAC_Msgs.scopeAllNonSensitiveSettings())}
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

// One dropdown per selected value rather than a single multi-select: the values here are long (dotted setting paths,
// `Display Name (server-id)`) and a combined trigger could only show them comma-joined and ellipsed, which truncated
// exactly the tail that distinguishes them.
function ScopeValueRows({
	kind,
	values,
	options,
	onChange,
	emptyLabel,
	mono,
}: {
	kind: RBAC_Msgs.ScopeValueKind
	values: string[]
	options: (ComboBoxOption<string> | string)[]
	onChange: (next: string[]) => void
	// an empty scope means unrestricted, which reads as a bug unless it's spelled out
	emptyLabel: string
	mono?: boolean
}) {
	const labels = RBAC_Msgs.scopeValueLabels[kind]
	const normalized: ComboBoxOption<string>[] = options.map((o) => (typeof o === 'string' ? { value: o } : o))
	const selected = new Set(values)
	const exhausted = normalized.every((o) => selected.has(o.value))

	// a value already used in a sibling row would be a no-op grant, so only the row holding it may keep it
	function optionsFor(own?: string): ComboBoxOption<string>[] {
		return normalized.map((o) => (o.value !== own && selected.has(o.value) ? { ...o, disabled: true } : o))
	}
	const boxClass = cn('w-full max-w-[22rem]', mono && 'font-mono')

	return (
		<ListEditor
			items={values}
			itemKey={(value) => value}
			emptyLabel={emptyLabel}
			addLabel={labels.add}
			addDisabled={exhausted}
			onRemove={(_, idx) => onChange(values.filter((_, i) => i !== idx))}
			renderItem={(value, idx) => (
				<ComboBox
					title={labels.title}
					className={boxClass}
					value={value}
					options={optionsFor(value)}
					onSelect={(next) => next && onChange(values.map((v, i) => (i === idx ? next : v)))}
				/>
			)}
			renderAddControl={({ ref, done }) => (
				<ComboBox
					ref={ref}
					title={labels.title}
					className={boxClass}
					placeholder={labels.select}
					value={undefined}
					options={optionsFor()}
					onSelect={(next) => {
						if (next) onChange([...values, next])
						done()
					}}
				/>
			)}
		/>
	)
}

function RoleAssignmentsEditor({
	roleId,
	cfg,
	update,
	assigned,
}: {
	roleId: string
	cfg: RoleConfig
	update: RbacUpdate
	assigned: boolean
}) {
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
			}),
		)
	}
	const changeDiscordRole = (oldId: string, nextId: string) => changeAssignment('discordRoleIds', oldId, nextId)
	const changeDiscordUser = (oldId: string, nextId: string) => changeAssignment('discordUserIds', oldId, nextId)

	// A group only means something together with the list that defines it, so options and selections are both the pair,
	// encoded as "list/group" for the multi-select. Two lists may define the same group name and they are not the same
	// grant. Already-selected pairs are kept even when their list or group is gone, so opening the editor never
	// silently drops a grant.
	const groupsRes = useQuery(RPC.orpc.rbac.listAdminListGroups.queryOptions({ staleTime: 60_000 }))
	const availableLists = groupsRes.data?.code === 'ok' ? groupsRes.data.lists : []
	const availablePairs = availableLists.flatMap((l) => l.groups.map((g) => encodeListGroup(l.listId, g)))
	const selectedGroups = cfg.assignments?.adminListGroups ?? []
	const selectedPairs = selectedGroups.map((g) => encodeListGroup(g.listId, g.groupId))
	const groupOptions = [...new Set([...availablePairs, ...selectedPairs])].sort().map((pair) => ({
		value: pair,
		label: availablePairs.includes(pair) ? pair : tr.text(RBAC_Msgs.groupNotInAnyList(pair)),
	}))
	const availableListIds = availableLists.map((l) => l.listId)
	const selectedIngameLists = cfg.assignments?.ingameAdminLists ?? []
	const ingameListOptions = [...new Set([...availableListIds, ...selectedIngameLists])].sort().map((listId) => ({
		value: listId,
		label: availableListIds.includes(listId) ? listId : tr.text(SM_Msgs.adminListNotConfigured(listId)),
	}))
	function setGroups(next: string[]) {
		const pairs = next.map(decodeListGroup).filter((p): p is { listId: string; groupId: string } => p !== null)
		update((r) => withRoleConfig(r, roleId, (c) => withAssignments(c, { adminListGroups: pairs })))
	}
	function setIngameLists(next: string[]) {
		update((r) => withRoleConfig(r, roleId, (c) => withAssignments(c, { ingameAdminLists: next })))
	}

	return (
		<div className="space-y-3">
			{!assigned && (
				<p className="flex items-center gap-1 text-xs text-warn dark:text-warn">
					<Icons.TriangleAlert className="h-3 w-3 shrink-0" />
					{tr.text(RBAC_Msgs.roleUnassigned())}
				</p>
			)}
			<div className="flex items-center gap-2">
				<Switch
					checked={!!cfg.assignments?.everyMember}
					onCheckedChange={(on) => update((r) => withRoleConfig(r, roleId, (c) => withAssignments(c, { everyMember: on })))}
				/>
				<span className="text-sm">{tr.text(RBAC_Msgs.everyMember())}</span>
			</div>

			<div className="space-y-1.5">
				<label className="flex items-center gap-1 text-xs text-muted-foreground">
					{tr.text(RBAC_Msgs.ingameAdminsOfLists())}
					<HelpTip
						text={tr.text(RBAC_Msgs.ingameAdminsHelp())}
						links={[{ label: tr.text(RBAC_Msgs.adminListsLink()), anchor: 'setting:adminLists' }]}
					/>
				</label>
				<div className="max-w-[28rem]">
					<ComboBoxMulti
						title={tr.text(SM_Msgs.adminListPicker())}
						values={selectedIngameLists}
						options={ingameListOptions}
						emptyLabel={tr.text(SM_Msgs.selectAdminLists())}
						chipDisplay
						onSelect={(next) => setIngameLists(typeof next === 'function' ? next(selectedIngameLists) : next)}
					/>
				</div>
			</div>

			<div className="space-y-1.5">
				<label className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.discordRoles())}</label>
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
				<label className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.discordUsers())}</label>
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

			<div className="space-y-1.5">
				<label className="flex items-center gap-1 text-xs text-muted-foreground">
					{tr.text(RBAC_Msgs.adminListGroups())}
					<HelpTip
						text={tr.text(RBAC_Msgs.adminListGroupsHelp())}
						links={[{ label: tr.text(RBAC_Msgs.adminListsLink()), anchor: 'setting:adminLists' }]}
					/>
				</label>
				{groupOptions.length === 0 ? (
					<p className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.noAdminListGroups())}</p>
				) : (
					<div className="max-w-[28rem]">
						<ComboBoxMulti
							title={tr.text(RBAC_Msgs.groupPicker())}
							values={selectedPairs}
							options={groupOptions}
							emptyLabel={tr.text(RBAC_Msgs.selectAdminListGroups())}
							chipDisplay
							onSelect={(next) => setGroups(typeof next === 'function' ? next(selectedPairs) : next)}
						/>
					</div>
				)}
			</div>
		</div>
	)
}

// -------- controls a schema asks for by name --------
//
// The overrides below this are chosen by setting path, which a plugin's config has no way to reach. A
// plugin declares the control it wants in its schema instead (see Fields in models/plugins.models), and it
// arrives here as a JSON Schema key.

function PluginFilterField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string | undefined
	return <FilterSelect value={value || null} onChange={(v) => onChange(v ?? '')} />
}

function PluginFilterMultiField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string[] | undefined
	return <FilterMultiSelect values={value ?? []} onChange={onChange} />
}

function PluginServerField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string | undefined
	return <ServerSelect value={value || null} onChange={(v) => onChange(v ?? '')} />
}

function PluginServerMultiField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string[] | undefined
	return <ServerMultiSelect values={value ?? []} onChange={onChange} />
}

function PluginChannelField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string | undefined
	return <DiscordChannelSelect value={value || null} onChange={(v) => onChange(v ?? '')} />
}

function PluginChannelMultiField({ value$, onChange }: OverrideProps) {
	const value = useFieldValue(value$) as string[] | undefined
	return <DiscordChannelMultiSelect values={value ?? []} onChange={onChange} />
}

// uncontrolled and debounced like TextInputField; a template is long enough that a one-line input hides most
// of what has been written
function PluginMultilineField({ value$, reset$, onChange }: OverrideProps) {
	const ref = React.useRef<HTMLTextAreaElement>(null)
	const format = (v: any) => (v === null || v === undefined ? '' : String(v))
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
			rows={3}
			className="resize-y"
			defaultValue={format(value$.getValue())}
			onChange={(e) => push(e.currentTarget.value)}
		/>
	)
}

const DECLARED_CONTROLS: Record<PLG.FieldControl, React.FC<OverrideProps>> = {
	'filter-id': PluginFilterField,
	'filter-ids': PluginFilterMultiField,
	'server-id': PluginServerField,
	'server-ids': PluginServerMultiField,
	'discord-channel-id': PluginChannelField,
	'discord-channel-ids': PluginChannelMultiField,
	multiline: PluginMultilineField,
}

// The overrides are keyed by a command id an admin would otherwise have to know and type by hand, which is why
// the raw record editor was unusable for the one thing it exists for: retuning a trigger that collides. This
// renders a card per command the active plugins actually declare and writes the key itself. A trigger another
// command already owns is dead rather than merely duplicated (see CMD.resolvePluginCommandTriggers), so it is
// flagged on the input that entered it.
function PluginCommandsField({ value$, reset$, onChange }: OverrideProps) {
	const stored = (useFieldValue(value$) as Record<string, CMD.PluginCommandConfig> | undefined) ?? {}
	const plugins = Zus.useStore(PluginsClient.Store, (s) => s.plugins)
	const root$ = React.useContext(RootValueContext) ?? EMPTY_ROOT_VALUE$
	// scoped rather than the whole document: this field renders once, but the root changes on every keystroke anywhere
	const defaultPrefix = (useFieldValue(scopeValue(root$, 'defaultPrefix')) as string | undefined) ?? ''
	const coreCommands = (useFieldValue(scopeValue(root$, 'commands')) as CMD.AnyCommandConfigs | undefined) ?? {}

	// not memoized: `stored` and `coreCommands` are fresh objects every render, so a memo over them would never
	// hit, and this is a flatMap over a handful of commands plus one pass over the trigger namespace
	const declared = plugins.flatMap((info) =>
		info.commands.map((decl) => {
			const id = CMD.pluginCommandId(info.id, decl.name)
			return {
				id,
				pluginName: info.name,
				decl,
				config: CMD.pluginCommandConfig(decl, stored[id], defaultPrefix),
				configured: stored[id] !== undefined,
			}
		}),
	)
	const { conflicts } = CMD.resolvePluginCommandTriggers(coreCommands, declared)
	// an override whose plugin is gone: ignored at runtime, but only an admin can decide it is safe to drop
	const orphans = Object.keys(stored).filter((id) => !declared.some((entry) => entry.id === id))

	function write(next: Record<string, unknown>) {
		onChange(next)
		reset$.next()
	}
	function patch(id: string, base: CMD.CommandConfig, next: Partial<CMD.PluginCommandConfig>) {
		const current = (value$.getValue() as Record<string, unknown>) ?? {}
		// an unconfigured command materializes at its effective config, so editing one field does not silently
		// pin the others at whatever the schema default happens to be
		write({ ...current, [id]: { ...((current[id] as object | undefined) ?? base), ...next } })
	}
	function clear(id: string) {
		const current = { ...((value$.getValue() as Record<string, unknown>) ?? {}) }
		delete current[id]
		write(current)
	}

	if (declared.length === 0 && orphans.length === 0) {
		return <p className="text-sm text-muted-foreground">{tr.text(CMD_Msgs.noPluginCommands())}</p>
	}
	return (
		<div className="space-y-3">
			{declared.map((entry) => (
				<PluginCommandCard
					key={entry.id}
					entry={entry}
					conflicts={conflicts.filter((c) => c.commandId === entry.id)}
					onPatch={(next) => patch(entry.id, entry.config, next)}
					onReset={() => clear(entry.id)}
				/>
			))}
			{orphans.length > 0 && (
				<div className="space-y-1 rounded-md border border-dashed p-2">
					<p className="text-xs text-muted-foreground">{tr.text(CMD_Msgs.pluginCommandOrphans())}</p>
					{orphans.map((id) => (
						<div key={id} className="flex items-center gap-2">
							<code className="text-xs">{id}</code>
							<Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => clear(id)}>
								{tr.text(CMD_Msgs.pluginCommandDropOverride())}
							</Button>
						</div>
					))}
				</div>
			)}
		</div>
	)
}

type PluginCommandEntry = { id: string; pluginName: string; decl: CMD.PluginCommandInfo; config: CMD.CommandConfig; configured: boolean }

function PluginCommandCard({
	entry,
	conflicts,
	onPatch,
	onReset,
}: {
	entry: PluginCommandEntry
	conflicts: CMD.CommandConflict[]
	onPatch: (next: Partial<CMD.PluginCommandConfig>) => void
	onReset: () => void
}) {
	const triggers = entry.config.triggers.map(CMD.triggerString)
	// Only for a declared default. A trigger an admin typed into `pluginCommands` collides against the settings
	// schema, which reports it as a field issue and refuses the save outright -- a better answer than this one,
	// and saying both would be noise. Nothing but this checks what a plugin declares.
	const takenBy = (trigger: string) =>
		entry.configured ? undefined : conflicts.find((c) => c.trigger.toLowerCase() === trigger.toLowerCase())?.ownedBy
	const setTriggers = (next: string[]) => onPatch({ triggers: next })
	return (
		<div className="space-y-2 rounded-md border p-2">
			<div className="flex flex-wrap items-baseline gap-2">
				<span className="text-sm font-medium">{entry.decl.name}</span>
				<span className="text-xs text-muted-foreground">{entry.pluginName}</span>
				<code className="text-[10px] text-muted-foreground">{entry.id}</code>
				<div className="flex-1" />
				{entry.configured && (
					<Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onReset}>
						{tr.text(CMD_Msgs.pluginCommandUseDeclared())}
					</Button>
				)}
			</div>
			<p className="text-xs text-muted-foreground">{entry.decl.description}</p>
			<div className="space-y-1">
				<span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
					{tr.text(CMD_Msgs.triggers())} <HelpTip text={tr.text(CMD_Msgs.triggersHelp())} />
				</span>
				{triggers.map((trigger, idx) => {
					const owner = takenBy(trigger)
					return (
						// oxlint-disable-next-line no-array-index-key
						<div key={idx} className="space-y-0.5">
							<div className="flex items-center gap-1">
								<Input
									className="h-7 w-40 text-xs"
									defaultValue={trigger}
									key={`${entry.configured}:${trigger}`}
									placeholder={tr.text(CMD_Msgs.triggerStringPlaceholder())}
									onBlur={(e) => setTriggers(triggers.map((t, i) => (i === idx ? e.target.value.trim() : t)))}
								/>
								{triggers.length > 1 && (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="h-6 px-2 text-xs"
										onClick={() => setTriggers(triggers.filter((_, i) => i !== idx))}
									>
										<Icons.X className="h-3 w-3" />
									</Button>
								)}
							</div>
							{owner && <p className="text-xs text-warn">{tr.text(CMD_Msgs.pluginTriggerTakenBy(owner))}</p>}
						</div>
					)
				})}
				<Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setTriggers([...triggers, ''])}>
					{tr.text(SETTINGS_Msgs.addEntry())}
				</Button>
			</div>
			<div className="flex flex-wrap items-center gap-4">
				<div className="flex items-center gap-2">
					<span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
						{tr.text(CMD_Msgs.allowedChats())} <HelpTip text={tr.text(CMD_Msgs.allowedChatsHelp())} />
					</span>
					<ComboBoxMulti
						title={tr.text(CMD_Msgs.allowedChats())}
						values={entry.config.allowedChats}
						options={CMD.CHAT_GROUPS.options.map((group) => ({ value: group, label: tr.text(CMD_Msgs.chatGroupLabels[group]) }))}
						onSelect={(next) => onPatch({ allowedChats: typeof next === 'function' ? next(entry.config.allowedChats) : next })}
					/>
				</div>
				<label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
					<Switch checked={entry.config.enabled} onCheckedChange={(v) => onPatch({ enabled: v })} />
					{tr.text(CMD_Msgs.enabled())}
				</label>
				<label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
					<Checkbox checked={entry.config.quickReference} onCheckedChange={(v) => onPatch({ quickReference: v === true })} />
					<span className="flex items-center gap-1">
						{tr.text(CMD_Msgs.quickReference())}
						<HelpTip text={tr.text(CMD_Msgs.quickReferenceHelp())} />
					</span>
				</label>
			</div>
		</div>
	)
}

function overrideFor(path: Path, _node: Node): React.FC<OverrideProps> | undefined {
	const declared = PLG.fieldControl(_node)
	if (declared) return DECLARED_CONTROLS[declared]
	const last = path[path.length - 1]
	// global settings define the lists (a record); a server picks from them (an array of names)
	if (path.length === 1 && last === 'adminLists') return _node.type === 'array' ? ServerAdminListsField : AdminListsField
	if (path.length === 1 && last === 'allowedPrefixes') return AllowedPrefixesField
	if (path.length === 1 && last === 'locale') return LocaleField
	// each command renders as one compact card (which itself renders the strings sub-editor), so there's no separate strings override
	if (path.length === 2 && path[0] === 'commands') return CommandCard
	if (path.length === 1 && last === 'pluginCommands') return PluginCommandsField
	if (path.length === 1 && last === 'adminActionReasons') return AdminActionReasonsField
	if (path.length === 1 && last === 'layerTable') return LayerTableField
	if (path.length === 1 && last === 'layerGeneration') return LayerGenerationField
	if (path.length === 1 && last === 'layerTags') return LayerTagsField
	if (path.length === 1 && last === 'playerFlagsRequiringNote') return FlagMultiSelectField
	if (path.length === 1 && last === 'playerGroupings') return PlayerGroupingsField
	// the entire `rbac` subtree is rendered by RbacBody (see FieldControl), so no per-field rbac overrides are needed here
	// server settings: the pool configuration reuses the dashboard popover's panels; connection passwords are masked
	if (path.length === 2 && path[0] === 'queue' && last === 'mainPool') return MainPoolField
	if (path.length === 2 && path[0] === 'connections' && last === 'token') return ServerAgentTokenField
	if (last === 'password') return PasswordField
	return undefined
}

// -------- leaf controls --------

// uncontrolled text/number input: seeded from value$, edits debounced upward, re-read on reset$
function TextInputField({
	value$,
	reset$,
	onChange,
	numeric,
	secret,
	placeholder,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	numeric: boolean
	secret?: boolean
	placeholder?: string
}) {
	const ref = React.useRef<HTMLInputElement>(null)
	const format = (v: any) => (v === null || v === undefined ? '' : String(v))
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

function SelectField({
	value$,
	reset$,
	onChange,
	options,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	options: string[]
}) {
	const value = useFieldValue(value$)
	return (
		<Select value={value ?? ''} onValueChange={onChange}>
			<SelectTrigger className="w-full">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((opt) => (
					<SelectItem key={opt} value={opt}>
						{opt}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

function SwitchField({ value$, reset$, onChange }: { value$: ValueState; reset$: Rx.Subject<void>; onChange: (v: any) => void }) {
	const value = useFieldValue(value$)
	return <Switch checked={!!value} onCheckedChange={onChange} />
}

// discriminated union: a variant picker keyed to the discriminator const, plus the active branch's object fields
// (the discriminator field itself is chosen by the picker, so it isn't rendered as an editable property).
function DiscriminatedUnionField({
	path,
	value$,
	reset$,
	onChange,
	branches,
	discriminator,
}: {
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	branches: Node[]
	discriminator: string
}) {
	const value = useFieldValue(value$) as any
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
						return (
							<SelectItem key={opt} value={opt}>
								{settingLabel([...path, discriminator, opt], opt)}
							</SelectItem>
						)
					})}
				</SelectContent>
			</Select>
			<ObjectField node={branchNode} path={path} value$={value$} reset$={reset$} onChange={onChange} />
		</div>
	)
}

function EnumArrayField({
	value$,
	reset$,
	onChange,
	options,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	options: string[]
}) {
	const value = useFieldValue(value$) as any[]
	return (
		<ComboBoxMulti
			title={tr.text(SETTINGS_Msgs.enumValuePicker())}
			values={value ?? []}
			options={options}
			onSelect={(next) => onChange(typeof next === 'function' ? next(value ?? []) : next)}
		/>
	)
}

// nullable scalar: an "unset" checkbox toggles between null and the field's empty value; the inner control reads value$
function NullableField({
	inner,
	value$,
	reset$,
	onChange,
	children,
}: {
	inner: Node
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	children: React.ReactNode
}) {
	const value = useFieldValue(value$)
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
				{tr.text(SETTINGS_Msgs.unsetField())}
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
	if (isStringOrNumber(inner)) return tr.text(SETTINGS_Msgs.durationExample())
	const last = path[path.length - 1]
	return typeof last === 'string' ? humanize(last) : undefined
}

function FieldControl({
	node,
	path,
	value$,
	reset$,
	onChange,
}: {
	node: Node
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
}) {
	const Override = overrideFor(path, node)
	// oxlint-disable-next-line react/static-components -- a lookup over module-level components, not one built here
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

function ArrayField({
	node,
	path,
	value$,
	reset$,
	onChange,
}: {
	node: Node
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any[]) => void
}) {
	const items: Node = node.items ?? {}
	const { inner } = stripNullable(items)

	const value = (useFieldValue(value$) as any[]) ?? []

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
			{value.length === 0 && <p className="text-xs text-muted-foreground">{tr.text(SETTINGS_Msgs.emptyList())}</p>}
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
				{tr.text(SETTINGS_Msgs.addItem())}
			</Button>
		</div>
	)
}

function ArrayItem({
	items,
	path,
	idx,
	parent$,
	reset$,
	parentOnChange,
	isPrimitive,
	onRemove,
}: {
	items: Node
	path: Path
	idx: number
	parent$: ValueState
	reset$: Rx.Subject<void>
	parentOnChange: (v: any[]) => void
	isPrimitive: boolean
	onRemove: () => void
}) {
	const value$ = scopeValue(parent$, idx)
	const onChange = (v: any) => {
		const arr = [...((parent$.getValue() as any[]) ?? [])]
		arr[idx] = v
		parentOnChange(arr)
	}
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

function RecordField({
	node,
	path,
	value$,
	reset$,
	onChange,
}: {
	node: Node
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: Record<string, any>) => void
}) {
	const valueNode: Node = node.additionalProperties
	// when the schema constrains keys to a known set (z.partialRecord / propertyNames enum), the key becomes a fixed picker
	// rather than free text, so only known keys can be added
	const keyEnum: string[] | undefined = node.propertyNames?.enum
	const [newKey, setNewKey] = React.useState('')
	const value = (useFieldValue(value$) as Record<string, any>) ?? {}
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
			{entries.length === 0 && <p className="text-xs text-muted-foreground">{tr.text(SETTINGS_Msgs.noEntries())}</p>}
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
			{keyEnum ? (
				remainingKeys.length > 0 && (
					<Select value="" onValueChange={add}>
						<SelectTrigger className="h-8 max-w-[16rem]">
							<SelectValue placeholder={tr.text(SETTINGS_Msgs.addEntry())} />
						</SelectTrigger>
						<SelectContent>
							{remainingKeys.map((k) => (
								<SelectItem key={k} value={k}>
									{k}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)
			) : (
				<div className="flex items-center gap-2">
					<Input
						className="font-mono h-8 max-w-[16rem]"
						placeholder={tr.text(SETTINGS_Msgs.newEntryKey())}
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
						{tr.text(SETTINGS_Msgs.addItem())}
					</Button>
				</div>
			)}
		</div>
	)
}

function RecordEntry({
	valueNode,
	path,
	entryKey,
	fixedKey,
	parent$,
	reset$,
	parentOnChange,
	onRename,
	onRemove,
}: {
	valueNode: Node
	path: Path
	entryKey: string
	fixedKey: boolean
	parent$: ValueState
	reset$: Rx.Subject<void>
	parentOnChange: (v: Record<string, any>) => void
	onRename: (next: string) => void
	onRemove: () => void
}) {
	const value$ = scopeValue(parent$, entryKey)
	const onChange = (v: any) => parentOnChange({ ...((parent$.getValue() as Record<string, any>) ?? {}), [entryKey]: v })
	return (
		<div className="border rounded-md p-2 space-y-1.5">
			<div className="flex items-center gap-2">
				{fixedKey ? (
					<span className="font-mono text-sm">{entryKey}</span>
				) : (
					<Input className="font-mono h-8 max-w-[16rem]" defaultValue={entryKey} onBlur={(e) => onRename(e.target.value.trim())} />
				)}
				<Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive ml-auto" onClick={onRemove}>
					<Icons.X className="h-4 w-4" />
				</Button>
			</div>
			<FieldControl node={valueNode} path={[...path, entryKey]} value$={value$} reset$={reset$} onChange={onChange} />
		</div>
	)
}

function ObjectField({
	node,
	path,
	value$,
	reset$,
	onChange,
}: {
	node: Node
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: Record<string, any>) => void
}) {
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
	const words = SETTINGS_Msgs.defaultValueWords
	if (val === null) return words.unset
	if (typeof val === 'boolean') return val ? words.on : words.off
	if (typeof val === 'string') return val === '' ? words.empty : val
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
function TooltipButton({
	disabled,
	tooltip,
	onClick,
	children,
}: {
	disabled: boolean
	tooltip: string
	onClick: () => void
	children: React.ReactNode
}) {
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
function FieldResetControls({
	value$,
	reset$,
	onChange,
	node,
	path,
	showDefaultLabel,
}: {
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	node: Node
	path: Path
	showDefaultLabel: boolean
}) {
	const value = useFieldValue(value$)
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
				tooltip={canResetSaved ? tr.text(SETTINGS_Msgs.resetToSaved()) : tr.text(SETTINGS_Msgs.alreadySaved())}
				onClick={() => resetTo(savedValue)}
			>
				<Icons.RotateCcw className="h-3.5 w-3.5" />
			</TooltipButton>
			{def.has && (
				<>
					{showDefaultLabel && (
						<span className="text-xs text-muted-foreground max-w-[12rem] truncate" title={formatDefaultValue(def.value)}>
							{tr.text(SETTINGS_Msgs.defaultHint(formatDefaultValue(def.value)))}
						</span>
					)}
					<TooltipButton
						disabled={!canResetDefault}
						tooltip={
							canResetDefault
								? tr.text(SETTINGS_Msgs.resetToDefault(formatDefaultValue(def.value)))
								: tr.text(SETTINGS_Msgs.alreadyDefault())
						}
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
			title={tr.text(SETTINGS_Msgs.linkToSetting())}
			aria-label={tr.text(SETTINGS_Msgs.linkToSetting())}
			onClick={(e) => {
				e.preventDefault()
				SettingsNav.navigateToAnchor(domId)
			}}
		>
			<Icons.Link className="h-3 w-3" />
		</a>
	)
}

// A link from a command's configuration to its listing on the commands page, where its arguments and examples are
// written down. Renders nothing for any other field. Revealed on hover of its row, like the anchor icon it sits beside.
function CommandsPageCrossLink({ path }: { path: Path }) {
	if (path.length !== 2 || path[0] !== 'commands') return null
	return (
		<TSR.Link
			to="/commands"
			hash={CMDH.commandsPageAnchor(path[1] as CMD.CommandId)}
			className="shrink-0 text-xs text-muted-foreground underline-offset-2 opacity-0 transition-opacity hover:text-foreground hover:underline group-hover:opacity-100 focus-visible:opacity-100"
			title={tr.text(CMD_Msgs.commandsCrossLinkTitle())}
		>
			{tr.text(CMD_Msgs.commandsCrossLink())}
		</TSR.Link>
	)
}

// -------- comments --------

// the comment on the setting at `pathStr`, read off the root document (see SETTINGS.COMMENTS_KEY)
function useSettingComment(root$: ValueState, pathStr: string): string | undefined {
	const comment$ = React.useMemo(
		() => mapValue(root$, (v: any) => v?.[SETTINGS.COMMENTS_KEY]?.[pathStr] as string | undefined),
		[root$, pathStr],
	)
	return useFieldValue(comment$)
}

type CommentProps = {
	root$: ValueState
	rootOnChange: (next: any) => void
	pathStr: string
	writable: boolean
	editing: boolean
	setEditing: (editing: boolean) => void
	// where the textarea puts its caret when editing opens: the character that was clicked, or the end of the text
	caretRef: React.RefObject<number | null>
}

// a field's comment affordances, or null where the form has no root document to keep them on (tests)
function useCommentProps(pathStr: string, writable: boolean): CommentProps | null {
	const root$ = React.useContext(RootValueContext)
	const rootOnChange = React.useContext(RootOnChangeContext)
	const [editing, setEditing] = React.useState(false)
	const caretRef = React.useRef<number | null>(null)
	if (!root$ || !rootOnChange) return null
	return { root$, rootOnChange, pathStr, writable, editing, setEditing, caretRef }
}

// the collapsed preview squeezes each whitespace run to one space, so a caret placed in it has to be walked back to
// the original text. Returns the preview alongside the original index each of its characters came from.
function flattenWhitespace(text: string): { flat: string; origIndex: number[] } {
	let flat = ''
	const origIndex: number[] = []
	let inRun = false
	for (let i = 0; i < text.length; i++) {
		const ws = /\s/.test(text[i])
		if (ws && inRun) continue
		flat += ws ? ' ' : text[i]
		origIndex.push(i)
		inRun = ws
	}
	return { flat, origIndex }
}

// the character offset of a click inside `container`, counted over its text nodes in document order (the link anchors
// RichText renders included). Null when the click landed on no text.
function textOffsetAtPoint(container: HTMLElement, x: number, y: number): number | null {
	const doc = container.ownerDocument
	let node: globalThis.Node | null = null
	let offset = 0
	if (doc.caretPositionFromPoint) {
		const pos = doc.caretPositionFromPoint(x, y)
		if (pos) [node, offset] = [pos.offsetNode, pos.offset]
	} else if (doc.caretRangeFromPoint) {
		const range = doc.caretRangeFromPoint(x, y)
		if (range) [node, offset] = [range.startContainer, range.startOffset]
	}
	if (!node || !container.contains(node)) return null
	const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT)
	let total = 0
	for (let cur = walker.nextNode(); cur; cur = walker.nextNode()) {
		if (cur === node) return total + offset
		total += cur.textContent?.length ?? 0
	}
	return null
}

// how much of a comment survives the collapsed view. whitespace is flattened first so the preview is one line
// regardless of how the comment was written
const COMMENT_PREVIEW_LENGTH = 160

// The comment block under a field's name: the text while displayed, a textarea while editing. Edits go straight into
// the root document, so a comment is staged and saved with the rest of the draft. Mirrors the filter editor's NodeComment.
function SettingComment({ root$, rootOnChange, pathStr, writable, editing, setEditing, caretRef }: CommentProps) {
	const comment = useSettingComment(root$, pathStr)
	const [expanded, setExpanded] = React.useState(false)
	const setComment = React.useCallback(
		(text: string) => rootOnChange(SETTINGS.withSettingComment(root$.getValue(), pathStr, text)),
		[root$, rootOnChange, pathStr],
	)
	const setCommentDebounced = useDebounced({ delay: DEBOUNCE_MS, onChange: setComment })

	if (editing) {
		return (
			<Textarea
				aria-label={tr.text(SETTINGS_Msgs.settingComment())}
				autoFocus
				rows={3}
				maxLength={SETTINGS.SETTING_COMMENT_MAX_LENGTH}
				placeholder={tr.text(SETTINGS_Msgs.commentPlaceholder())}
				defaultValue={comment ?? ''}
				className="my-1 text-xs"
				onFocus={(e) => {
					const at = caretRef.current ?? e.currentTarget.value.length
					e.currentTarget.setSelectionRange(at, at)
				}}
				onChange={(e) => setCommentDebounced(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') e.currentTarget.blur()
				}}
				onBlur={(e) => {
					setComment(e.target.value)
					setEditing(false)
				}}
			/>
		)
	}

	if (!comment) return null

	const { flat: flattened, origIndex } = flattenWhitespace(comment)
	const truncated = flattened.length > COMMENT_PREVIEW_LENGTH
	const collapsed = truncated && !expanded
	// clicking into the text opens the editor with the caret under the click, as a plain textarea would. Links keep
	// their own click (RichText stops it propagating), and so does the more/less toggle.
	const editAtClick = (e: React.MouseEvent<HTMLDivElement>) => {
		if (!writable) return
		const offset = textOffsetAtPoint(e.currentTarget, e.clientX, e.clientY)
		caretRef.current = offset === null ? null : collapsed ? (origIndex[offset] ?? comment.length) : offset
		setEditing(true)
	}
	return (
		<div
			className={cn('my-1 flex items-start gap-1 border-l-2 border-muted pl-2 text-xs text-muted-foreground', writable && 'cursor-text')}
			onClick={editAtClick}
		>
			<RichText
				text={collapsed ? flattened : comment}
				maxLength={collapsed ? COMMENT_PREVIEW_LENGTH : undefined}
				className={cn('min-w-0', collapsed && 'whitespace-normal')}
			/>
			{truncated && (
				<button
					type="button"
					className="shrink-0 underline"
					onClick={(e) => {
						e.stopPropagation()
						setExpanded((v) => !v)
					}}
				>
					{expanded ? tr.text(SETTINGS_Msgs.showLess()) : tr.text(SETTINGS_Msgs.showMore())}
				</button>
			)}
		</div>
	)
}

// sits in the field's hover-revealed icon row beside AnchorLink. A field that has a comment keeps the icon showing, so
// the comment reads as something that can be edited.
function CommentButton({ root$, pathStr, editing, setEditing, caretRef }: CommentProps) {
	const hasComment = !!useSettingComment(root$, pathStr)
	const label = hasComment ? tr.text(SETTINGS_Msgs.editComment()) : tr.text(SETTINGS_Msgs.addComment())
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					aria-pressed={editing}
					className={cn(
						'shrink-0 transition-opacity focus-visible:opacity-100',
						hasComment ? 'text-primary' : 'text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100',
					)}
					onClick={() => {
						caretRef.current = null
						setEditing(!editing)
					}}
				>
					<Icons.MessageSquareText className="h-3 w-3" />
				</button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}

// -------- advanced disclosure --------

// The collapsed tail of a section: the fields most installs never touch (see settings-groups.ts). `paths` are the
// dotted paths it holds, so it can open itself when one of them is navigated to (the TOC lists advanced settings like
// any other) or when one of them fails validation, which must never be hidden behind a collapsed row.
function AdvancedDisclosure({ paths, children }: { paths: string[]; children: React.ReactNode }) {
	const [expanded, setExpanded] = React.useState(false)
	const { idPrefix } = React.useContext(FormOptionsContext)
	const covers = React.useCallback(
		(candidate: string, prefix: string) => {
			return paths.some((p) => {
				const full = `${prefix}${p}`
				return candidate === full || candidate.startsWith(`${full}.`)
			})
		},
		[paths],
	)

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
				{tr.text(SETTINGS_Msgs.advanced())}
				<span className="opacity-60">({paths.length})</span>
				{hasIssue && <Icons.TriangleAlert className="h-3 w-3 text-destructive" />}
			</button>
			{open && <div className="space-y-3 border-t px-2 py-3">{children}</div>}
		</div>
	)
}

// -------- scoped yaml editor --------

// lazily loaded so a settings visit that never opens a YAML editor doesn't pay for the CodeMirror bundle. The `as`
// casts restore the generic component signature React.lazy erases (same as the page-level editor in routes/settings).
const SchemaYamlEditor = React.lazy(
	() => import('@/components/schema-yaml-editor') as unknown as Promise<{ default: React.FC<any> }>,
) as unknown as typeof SchemaYamlEditorComponent

// which editor a field with a scoped YAML editor is currently showing, mirroring the page-level section modes
type FieldMode = 'gui' | 'yaml'

// the sub-schema for this field's scoped YAML editor, or undefined when it doesn't offer one
function useLocalEditorSchema(pathStr: string): z.ZodType | undefined {
	const rootSchema = React.useContext(RootSchemaContext)
	return React.useMemo(
		// splitting pathStr rather than taking the path array keeps this memo stable: the array is rebuilt every render.
		// Only the declared paths are split, and those have no dots inside a segment.
		() => (rootSchema && LOCAL_YAML_EDITOR_PATHS.has(pathStr) ? ZodUtils.schemaAtPath(rootSchema, pathStr.split('.')) : undefined),
		[rootSchema, pathStr],
	)
}

// the GUI/YAML segmented control the settings-page section headers use, scaled down to sit in a field's header row.
// `ml-auto` pins it to the right end of that row, where the page-level control sits in its own header.
function LocalModeToggle({ mode, onSelect }: { mode: FieldMode; onSelect: (next: FieldMode) => void }) {
	return (
		<div className="ml-auto flex items-center rounded-md border p-0.5">
			{(['gui', 'yaml'] as const).map((option) => (
				<Button
					key={option}
					type="button"
					size="sm"
					variant={mode === option ? 'secondary' : 'ghost'}
					className="h-5 px-1.5 text-[10px]"
					onClick={() => onSelect(option)}
				>
					{option === 'gui' ? 'GUI' : 'YAML'}
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

// A YAML editor over one subtree of the form, swapped in for that field's widget. The editor owns its buffer while
// open: handing our own edits straight back as `value` would re-sync the document mid-keystroke, so it's only re-seeded
// on reset$, which is exactly the programmatic-change signal the uncontrolled inputs re-read on. Re-seeding remounts it
// rather than passing a new `value`, because the editor re-syncs only when `value` differs from what it last synced,
// and a reset typically restores the very value it was seeded with (leaving the user's edits sitting in the buffer).
function LocalYamlField({
	schema,
	label,
	domId,
	path,
	value$,
	reset$,
	onChange,
}: {
	schema: z.ZodType
	label: string
	// the field's own anchor, which the editor renders inside: the scroll target once the editor is up
	domId: string
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
}) {
	const root$ = React.useContext(RootValueContext)
	const rootOnChange = React.useContext(RootOnChangeContext)
	const pathStr = path.join('.')
	// Every comment lives on the root document. The ones under this subtree ride into the editor keyed relative to it,
	// so they render as `#` lines, and come back out to the root in the same write as the subtree value.
	const seedValue = () => {
		const value = value$.getValue()
		if (!root$ || !Obj.isPlainObject(value)) return value
		const comments = SETTINGS.subtreeComments(root$.getValue()?.[SETTINGS.COMMENTS_KEY], pathStr)
		return Object.keys(comments).length > 0 ? { ...value, [SETTINGS.COMMENTS_KEY]: comments } : value
	}
	const [seed, setSeed] = React.useState(() => ({ value: seedValue(), nonce: 0 }))
	useReset(reset$, () => setSeed((prev) => ({ value: seedValue(), nonce: prev.nonce + 1 })))
	const onValidChange = (v: unknown) => {
		if (v === null) return
		if (!root$ || !rootOnChange || !Obj.isPlainObject(v)) return onChange(toInputShape(schema, v))
		const comments = (v[SETTINGS.COMMENTS_KEY] ?? {}) as SETTINGS.SettingsComments
		const root = setAtPath(root$.getValue(), path, toInputShape(schema, Obj.exclude(v, [SETTINGS.COMMENTS_KEY])))
		rootOnChange(SETTINGS.withSubtreeComments(root, pathStr, comments))
	}
	// only the first mount scrolls: re-seeding after a reset remounts the editor, and yanking the viewport for that
	// would be a surprise. This component only exists while the field is in YAML mode, so the ref resets on reopen.
	const broughtIntoView = React.useRef(false)
	const onReady = () => {
		if (broughtIntoView.current) return
		broughtIntoView.current = true
		SettingsNav.scrollToAnchorSettled(domId)
	}
	return (
		<React.Suspense fallback={<p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.loadingEditor())}</p>}>
			<SchemaYamlEditor
				key={seed.nonce}
				schema={schema}
				commentsKey={SETTINGS.COMMENTS_KEY}
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
function SectionField({
	name,
	node,
	path,
	value$,
	reset$,
	onChange,
}: {
	name: string
	node: Node
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
}) {
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
	const jsonSchema = useLocalEditorSchema(pathStr)
	const [mode, setMode] = React.useState<FieldMode>('gui')
	const commentProps = useCommentProps(pathStr, writable)
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
						<FieldResetControls
							value$={value$}
							reset$={reset$}
							onChange={onChange}
							node={node}
							path={path}
							showDefaultLabel={false}
						/>
					</span>
					<AnchorLink domId={domId} />
					{commentProps && writable && <CommentButton {...commentProps} />}
					{jsonSchema && writable && <LocalModeToggle mode={mode} onSelect={setMode} />}
				</div>
				{commentProps && <SettingComment {...commentProps} />}
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
				{/* oxlint-disable-next-line react/static-components -- a lookup over module-level components, not one built here */}
				{SectionExtra && <SectionExtra />}
				<FieldIssues issues={sectionIssues} pathStr={pathStr} />
				{jsonSchema && mode === 'yaml' ? (
					<LocalYamlField
						schema={jsonSchema}
						label={settingLabel(path, name)}
						domId={domId}
						path={path}
						value$={value$}
						reset$={reset$}
						onChange={onChange}
					/>
				) : (
					<FieldControl node={node} path={path} value$={value$} reset$={reset$} onChange={onChange} />
				)}
			</StickyGroup>
		</fieldset>
	)
}

// a single labeled leaf field (scalar, array, record, or override widget).
function LeafField({
	name,
	node,
	path,
	value$,
	reset$,
	onChange,
	hasOverride,
}: {
	name: string
	node: Node
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	hasOverride: boolean
}) {
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
	const jsonSchema = useLocalEditorSchema(pathStr)
	const [mode, setMode] = React.useState<FieldMode>('gui')
	const commentProps = useCommentProps(pathStr, writable)
	// the inline "default: <value>" hint only reads well for scalars; complex/override fields still get the reset buttons
	const showDefaultLabel = !hasOverride && isScalarNode(inner)
	const controls = (
		<span className="contents" inert={!writable}>
			<FieldResetControls
				value$={value$}
				reset$={reset$}
				onChange={onChange}
				node={node}
				path={path}
				showDefaultLabel={showDefaultLabel}
			/>
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
							<TooltipContent>{tr.text(SETTINGS_Msgs.notPermittedToModifySetting())}</TooltipContent>
						</Tooltip>
					)}
					{!isBoolean && controls}
					<AnchorLink domId={domId} />
					{commentProps && writable && <CommentButton {...commentProps} />}
					<CommandsPageCrossLink path={path} />
					{jsonSchema && writable && <LocalModeToggle mode={mode} onSelect={setMode} />}
				</div>
				{commentProps && <SettingComment {...commentProps} />}
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
				<FieldIssues issues={fieldIssues} pathStr={pathStr} />
			</div>
			<div className={cn(isBoolean && 'shrink-0 flex items-center gap-1')} inert={!writable}>
				{isBoolean && controls}
				{jsonSchema && mode === 'yaml' ? (
					<LocalYamlField
						schema={jsonSchema}
						label={settingLabel(path, name)}
						domId={domId}
						path={path}
						value$={value$}
						reset$={reset$}
						onChange={onChange}
					/>
				) : (
					<FieldControl node={node} path={path} value$={value$} reset$={reset$} onChange={onChange} />
				)}
			</div>
		</div>
	)
}

// dispatches a schema property to a section or leaf renderer, deriving its scoped value$ + onChange.
function Field({
	name,
	node,
	path,
	parent$,
	parentOnChange,
	reset$,
}: {
	name: string
	node: Node
	path: Path
	parent$: ValueState
	parentOnChange: (v: Record<string, any>) => void
	reset$: Rx.Subject<void>
}) {
	const value$ = scopeValue(parent$, name)
	const onChange = (v: any) => parentOnChange({ ...((parent$.getValue() as Record<string, any>) ?? {}), [name]: v })
	// keys managed inline by a sibling editor render no field of their own (e.g. defaultPrefix, chosen via the
	// "default" markers in the allowedPrefixes editor)
	if (path.length === 1 && HIDDEN_SETTINGS_KEYS.has(name)) return null
	const { inner } = stripNullable(node)
	const hasOverride = !!overrideFor(path, node)
	const isSection =
		!hasOverride &&
		inner.type === 'object' &&
		!!inner.properties &&
		!(inner.additionalProperties && typeof inner.additionalProperties === 'object')

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
function GroupedRootFields({
	node,
	groups,
	value$,
	reset$,
	onChange,
}: {
	node: Node
	groups: SettingsGroup[]
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: Record<string, any>) => void
}) {
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
			{grouped.map(({ group, keys }) =>
				group.passthrough ? (
					<React.Fragment key={group.slug}>{renderKeys(keys)}</React.Fragment>
				) : (
					<GroupSection key={group.slug} slug={group.slug} label={group.label}>
						{renderKeys(keys)}
					</GroupSection>
				),
			)}
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

export default function SettingsForm({
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
}) {
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
											{groups ? (
												<GroupedRootFields
													node={jsonSchema}
													groups={groups}
													value$={value$}
													reset$={reset$}
													onChange={onChange}
												/>
											) : (
												<ObjectField node={jsonSchema} path={rootPath} value$={value$} reset$={reset$} onChange={onChange} />
											)}
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
