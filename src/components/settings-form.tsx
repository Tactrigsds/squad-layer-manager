import { BmFlagMultiSelect, BmFlagOrColorSelect, BmFlagOrderedList, FlagPriorityMap } from '@/components/bm-flag-picker'
import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { DiscordMemberSelect, DiscordRoleSelect } from '@/components/discord-picker'
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
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as AAR from '@/models/admin-action-reasons.models'
import type * as LP from '@/models/labeled-presets.models'
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
const GRANT_PERM_OPTIONS: string[] = ['*', ...RBAC.GLOBAL_PERMISSION_TYPE.options]
const DENY_PERM_OPTIONS: string[] = [...RBAC.GLOBAL_PERMISSION_TYPE.options]

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

// `roles` (rbac.roles) is the source of truth for which roles exist; assignment role pickers are keyed to it and each
// role shows a warning when nothing assigns it. Both need data from sibling branches, shared here via context.
type RbacInfo = { roleIds: string[]; assignedRoleIds: Set<string> }
const RbacContext = React.createContext<RbacInfo>({ roleIds: [], assignedRoleIds: new Set() })

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

function readRbacInfo(root: any): RbacInfo {
	const rbac = root?.rbac
	const ra = rbac?.roleAssignments
	const roleIds = Object.keys(rbac?.roles ?? {})
	const assignedRoleIds = new Set<string>()
	// discord-role/discord-user are id-keyed lists of { roles }; discord-server-member is a flat list of roles
	for (const type of ['discord-role', 'discord-user'] as const) {
		for (const a of ra?.[type] ?? []) for (const r of a.roles ?? []) assignedRoleIds.add(r)
	}
	for (const r of ra?.['discord-server-member'] ?? []) assignedRoleIds.add(r)
	return { roleIds, assignedRoleIds }
}

function sameRbacInfo(a: RbacInfo, b: RbacInfo): boolean {
	if (a.roleIds.length !== b.roleIds.length || a.assignedRoleIds.size !== b.assignedRoleIds.size) return false
	return a.roleIds.every((r, i) => r === b.roleIds[i]) && [...a.assignedRoleIds].every((r) => b.assignedRoleIds.has(r))
}

function useRbacInfo(value$: ValueState): RbacInfo {
	const [info, setInfo] = React.useState(() => readRbacInfo(value$.getValue()))
	React.useEffect(() => {
		const sub = value$.subscribe((v) =>
			setInfo((prev) => {
				const next = readRbacInfo(v)
				return sameRbacInfo(prev, next) ? prev : next
			})
		)
		return () => sub.unsubscribe()
	}, [value$])
	return info
}

// when a role is deleted from rbac.roles, prune it from every assignment so the config never dangles (which the schema
// would otherwise reject). Runs off the root value$/onChange since it spans both branches.
function useRoleCascade(value$: ValueState, onChange: (v: any) => void) {
	const prevRoles = React.useRef<string[] | null>(null)
	React.useEffect(() => {
		const sub = value$.subscribe((v: any) => {
			const roleIds = Object.keys(v?.rbac?.roles ?? {})
			const prev = prevRoles.current
			prevRoles.current = roleIds
			if (prev === null) return
			const removed = prev.filter((r) => !roleIds.includes(r))
			if (removed.length === 0) return
			const ra = v.rbac.roleAssignments
			let changed = false
			const nextRa: any = {}
			for (const type of ['discord-role', 'discord-user'] as const) {
				nextRa[type] = (ra[type] ?? []).map((a: any) => {
					const roles = (a.roles ?? []).filter((r: string) => !removed.includes(r))
					if (roles.length !== (a.roles?.length ?? 0)) changed = true
					return { ...a, roles }
				})
			}
			const memberRoles = (ra['discord-server-member'] ?? []).filter((r: string) => !removed.includes(r))
			if (memberRoles.length !== (ra['discord-server-member']?.length ?? 0)) changed = true
			nextRa['discord-server-member'] = memberRoles
			// maxTimeouts is keyed by role too; dangling keys would fail the schema's superRefine
			const nextMaxTimeouts: Record<string, unknown> = { ...(v.rbac.maxTimeouts ?? {}) }
			for (const r of removed) {
				if (r in nextMaxTimeouts) {
					delete nextMaxTimeouts[r]
					changed = true
				}
			}
			// defer to avoid re-entrant BehaviorSubject.next while this emission is still being delivered
			if (changed) {
				queueMicrotask(() =>
					onChange({
						...value$.getValue(),
						rbac: { ...value$.getValue().rbac, roleAssignments: nextRa, maxTimeouts: nextMaxTimeouts },
					})
				)
			}
		})
		return () => sub.unsubscribe()
	}, [value$, onChange])
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

function FlagOrderedListField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$, reset$)
	return <BmFlagOrderedList value={value ?? []} onChange={onChange} />
}
function FlagMultiSelectField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$, reset$)
	return <BmFlagMultiSelect value={value ?? []} onChange={onChange} />
}
function FlagOrColorField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$, reset$)
	return <BmFlagOrColorSelect value={value ?? ''} onChange={onChange} />
}
function FlagPriorityMapField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$, reset$)
	return <FlagPriorityMap value={value ?? {}} onChange={onChange} />
}
function DiscordRoleField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$, reset$)
	return <DiscordRoleSelect value={value ?? ''} onChange={onChange} />
}
function PasswordField({ value$, reset$, onChange }: OverrideProps) {
	return <TextInputField value$={value$} reset$={reset$} onChange={onChange} numeric={false} secret placeholder="Password" />
}
function DiscordMemberField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$, reset$)
	return <DiscordMemberSelect value={value ?? ''} onChange={onChange} />
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
// a defined role's permission expression, plus a warning when nothing assigns the role
function RolePermissionField({ value$, reset$, onChange, path }: OverrideProps) {
	const value = useFieldValue(value$, reset$)
	const { assignedRoleIds } = React.useContext(RbacContext)
	const roleId = String(path[path.length - 1])
	return (
		<div className="space-y-1.5">
			<PermissionExpressionEditor value={value} onChange={onChange} />
			{!assignedRoleIds.has(roleId) && (
				<p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
					<Icons.TriangleAlert className="h-3 w-3 shrink-0" />
					This role has no role assignments, so it is never granted to anyone.
				</p>
			)}
		</div>
	)
}
// per-role max kick-timeout durations (rbac.maxTimeouts): role picker keyed to the defined roles,
// HumanTime text input (edited in the encoded string form, e.g. "2h")
function MaxTimeoutsField({ value$, reset$, onChange }: OverrideProps) {
	const { roleIds } = React.useContext(RbacContext)
	const value = (useFieldValue(value$, reset$) as Record<string, string> | undefined) ?? {}
	const entries = Object.keys(value)
	const remaining = roleIds.filter((r) => !(r in value))

	function structural(next: Record<string, unknown>) {
		onChange(next)
		reset$.next()
	}

	return (
		<div className="space-y-2">
			{entries.length === 0 && <p className="text-xs text-muted-foreground">No roles may issue kick timeouts.</p>}
			{entries.map((roleId) => (
				<MaxTimeoutEntry
					key={roleId}
					roleId={roleId}
					parent$={value$}
					reset$={reset$}
					parentOnChange={onChange}
					onRemove={() => {
						const next = { ...((value$.getValue() as Record<string, unknown>) ?? {}) }
						delete next[roleId]
						structural(next)
					}}
				/>
			))}
			{remaining.length > 0 && (
				<Select
					value=""
					onValueChange={(roleId) => structural({ ...((value$.getValue() as Record<string, unknown>) ?? {}), [roleId]: '1h' })}
				>
					<SelectTrigger className="h-8 max-w-[16rem]">
						<SelectValue placeholder="Add role…" />
					</SelectTrigger>
					<SelectContent>
						{remaining.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
					</SelectContent>
				</Select>
			)}
		</div>
	)
}

function MaxTimeoutEntry(
	{ roleId, parent$, reset$, parentOnChange, onRemove }: {
		roleId: string
		parent$: ValueState
		reset$: Rx.Subject<void>
		parentOnChange: (v: any) => void
		onRemove: () => void
	},
) {
	const value$ = React.useMemo(() => scopeValue(parent$, roleId), [parent$, roleId])
	const onChange = React.useCallback(
		(v: any) => parentOnChange({ ...((parent$.getValue() as Record<string, unknown>) ?? {}), [roleId]: v }),
		[parent$, parentOnChange, roleId],
	)
	return (
		<div className="flex items-center gap-2">
			<span className="w-40 truncate text-sm font-mono">{roleId}</span>
			<div className="w-32">
				<TextInputField value$={value$} reset$={reset$} onChange={onChange} numeric={false} placeholder="2h" />
			</div>
			<Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={onRemove}>
				<Icons.X className="h-4 w-4" />
			</Button>
		</div>
	)
}

// role picker for an assignment, keyed to the defined roles (rbac.roles) rather than free text
function AssignmentRolesField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$, reset$) as string[]
	const { roleIds } = React.useContext(RbacContext)
	return (
		<ComboBoxMulti
			title="Role"
			values={value ?? []}
			options={roleIds}
			onSelect={(next) => onChange(typeof next === 'function' ? next(value ?? []) : next)}
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
			newRow={() => ({ label: '', message: '', aliases: [], actionTexts: {} })}
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
	const message$ = React.useMemo(() => scopeValue(row$, 'message'), [row$])
	const aliases$ = React.useMemo(() => scopeValue(row$, 'aliases'), [row$])
	const actionTexts$ = React.useMemo(() => scopeValue(row$, 'actionTexts'), [row$])
	// the set of actions this reason carries text for; keys are added/removed structurally (emits reset$)
	const actionTexts = (useFieldValue(actionTexts$, reset$) as Partial<Record<AAR.ExecutableAdminActionType, string>> | undefined) ?? {}
	const presentActions = AAR.EXECUTABLE_ADMIN_ACTION_TYPE.options.filter((a) => actionTexts[a] !== undefined)
	const remainingActions = AAR.EXECUTABLE_ADMIN_ACTION_TYPE.options.filter((a) => actionTexts[a] === undefined)

	const setField = (key: keyof AAR.AdminActionReason) => (v: any) => {
		const arr = [...((parent$.getValue() as AAR.AdminActionReason[]) ?? [])]
		arr[idx] = { ...arr[idx], [key]: v }
		parentOnChange(arr)
	}
	// non-structural: text edit within an existing action key (no reset$; the textarea stays mounted)
	const setActionText = (action: AAR.ExecutableAdminActionType) => (v: string) => {
		const arr = [...((parent$.getValue() as AAR.AdminActionReason[]) ?? [])]
		arr[idx] = { ...arr[idx], actionTexts: { ...arr[idx].actionTexts, [action]: v } }
		parentOnChange(arr)
	}
	// structural: adding/removing an action key mounts/unmounts a textarea, so re-seed uncontrolled inputs via reset$
	const addAction = (action: AAR.ExecutableAdminActionType) => {
		const arr = [...((parent$.getValue() as AAR.AdminActionReason[]) ?? [])]
		arr[idx] = { ...arr[idx], actionTexts: { ...arr[idx].actionTexts, [action]: '' } }
		parentOnChange(arr)
		reset$.next()
	}
	const removeAction = (action: AAR.ExecutableAdminActionType) => {
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
					<div className="rounded-md border">
						<div className="px-2 pt-1 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">Warn</div>
						<TextAreaCell value$={message$} reset$={reset$} onChange={setField('message')} placeholder="Sent when warning a player" />
					</div>
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
						<Select value="" onValueChange={(a) => addAction(a as AAR.ExecutableAdminActionType)}>
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
// with the given custom message variables applied. kicks are shown both with a 2h sample timeout and with no
// timeout (empty {{duration}}) so {{#duration}} sections can be checked both ways
function reasonPreviewEntries(reason: AAR.AdminActionReason, customVars: Record<string, string>): { context: string; text: string }[] {
	const applied = (action: AAR.AdminActionType, opts?: { squadTag?: string; duration?: string }) =>
		AAR.formatAppliedReason(action, reason, {
			squadTag: opts?.squadTag,
			vars: { ...customVars, ...(action === 'kick' ? { duration: opts?.duration ?? '' } : {}) },
		})
	const entries = [
		{ context: 'Warn', text: applied('warn') },
		{ context: 'Warn squad', text: applied('warn', { squadTag: '@Squad1' }) },
	]
	// one entry per action the reason carries text for; squad-directed actions get the @Squad1 tag
	for (const action of AAR.EXECUTABLE_ADMIN_ACTION_TYPE.options) {
		if (reason.actionTexts[action] === undefined) continue
		if (action === 'kick') {
			entries.push({ context: 'Kick (timeout)', text: applied('kick', { duration: '2h' }) })
			entries.push({ context: 'Kick (no timeout)', text: applied('kick', { duration: '' }) })
			continue
		}
		const squadTag = AAR.ADMIN_ACTIONS[action].targetKind === 'squad' ? '@Squad1' : undefined
		entries.push({ context: AAR.ADMIN_ACTIONS[action].displayName, text: applied(action, { squadTag }) })
	}
	return entries
}

function ReasonPreviewButton({ row$, reset$ }: { row$: ValueState; reset$: Rx.Subject<void> }) {
	const raw = useFieldValue(row$, reset$) as Partial<AAR.AdminActionReason> | undefined
	const customVars = React.useContext(MessageVarsContext)
	// tolerate incomplete draft rows so the preview shows the message shape while it's being written
	const actionTexts = Object.fromEntries(
		Object.entries(raw?.actionTexts ?? {}).map(([action, text]) => [action, (text ?? '').trim() || '<action text>']),
	) as Partial<Record<AAR.ExecutableAdminActionType, string>>
	const reason: AAR.AdminActionReason = {
		label: raw?.label?.trim() || '<label>',
		message: raw?.message?.trim() || '<warn text>',
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
					In-game text delivered for each applicable action (kicks shown with a 2h sample timeout and with none).
				</p>
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
				<Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={onRemove}>
					<Icons.X className="h-4 w-4" />
				</Button>
			</TableCell>
		</TableRow>
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
		// the settings page is already gated by admin:manage-servers; per-field write perms don't apply here
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
	if (path.length === 1 && last === 'playerFlagColorHierarchy') return FlagOrderedListField
	if (path.length === 1 && last === 'playerFlagsRequiringNote') return FlagMultiSelectField
	if (path[0] === 'playerFlagGroupings' && typeof path[1] === 'number' && last === 'color') return FlagOrColorField
	if (path[0] === 'playerFlagGroupings' && typeof path[1] === 'number' && last === 'associations') return FlagPriorityMapField
	if (path[0] === 'rbac' && path[1] === 'roles' && path.length === 3) return RolePermissionField
	if (path[0] === 'rbac' && path.length === 2 && last === 'maxTimeouts') return MaxTimeoutsField
	// the per-assignment `roles` lists, plus the flat "every member" list, are all role pickers keyed to defined roles
	if (path[0] === 'rbac' && path[1] === 'roleAssignments' && (last === 'roles' || last === 'discord-server-member')) {
		return AssignmentRolesField
	}
	// searchable Discord role/account pickers for the role-assignment editor, keyed to the raw-id fields
	if (path[0] === 'rbac' && path[1] === 'roleAssignments' && path[2] === 'discord-role' && last === 'discordRoleId') return DiscordRoleField
	if (path[0] === 'rbac' && path[1] === 'roleAssignments' && path[2] === 'discord-user' && last === 'userId') return DiscordMemberField
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
					keyEnum={keyEnum}
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
	{ valueNode, path, entryKey, keyEnum, parent$, reset$, parentOnChange, onRename, onRemove }: {
		valueNode: Node
		path: Path
		entryKey: string
		keyEnum: string[] | undefined
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
				{keyEnum
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

// the value a field falls back to. For prefaulted object sections the node default is a bare {}, so we reconstruct
// from child defaults to get the real nested default (used for both the "Default:" hint and reset-to-default).
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
					<FieldResetControls value$={value$} reset$={reset$} onChange={onChange} node={node} path={path} showDefaultLabel={false} />
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
	// the inline "default: <value>" hint only reads well for scalars; complex/override fields still get the reset buttons
	const showDefaultLabel = !hasOverride && isScalarNode(inner)
	const controls = (
		<FieldResetControls value$={value$} reset$={reset$} onChange={onChange} node={node} path={path} showDefaultLabel={showDefaultLabel} />
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
			)}
		>
			<div className={cn(isBoolean && 'min-w-0')}>
				<div className="group flex items-center gap-1.5">
					<Label className={cn('text-sm', hasError && 'text-destructive')}>{settingLabel(path, name)}</Label>
					<code className="text-[10px] text-muted-foreground">{pathStr}</code>
					{!isBoolean && controls}
					<AnchorLink domId={domId} />
				</div>
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
				<FieldIssues issues={fieldIssues} pathStr={pathStr} />
			</div>
			<div className={cn(isBoolean && 'shrink-0 flex items-center gap-1')}>
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
	{ schema, value$, reset$, onChange, saved, idPrefix = 'setting:', groups, issues }: {
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
		// schema issues for the current draft (input-shape safeParse); each leaf field displays the issues under its path
		issues?: readonly z.core.$ZodIssue[]
	},
) {
	const jsonSchema = React.useMemo(() => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Node, [schema])
	// stable so the form subtree stays memoized when only rbacInfo (context) changes
	const rootPath = React.useMemo<Path>(() => [], [])
	const formOptions = React.useMemo(() => ({ idPrefix }), [idPrefix])
	const savedCtx = React.useMemo(() => ({ saved }), [saved])
	const rbacInfo = useRbacInfo(value$)
	const messageVars = useMessageVars(value$)
	useRoleCascade(value$, onChange)
	const normIssues = React.useMemo(
		() => (issues ?? []).map((i): NormalizedIssue => ({ path: i.path.map(String).join('.'), message: i.message })),
		[issues],
	)
	return (
		<FormOptionsContext.Provider value={formOptions}>
			<SavedRootContext.Provider value={savedCtx}>
				<RbacContext.Provider value={rbacInfo}>
					<MessageVarsContext.Provider value={messageVars}>
						<ValidationContext.Provider value={normIssues}>
							{groups
								? <GroupedRootFields node={jsonSchema} groups={groups} value$={value$} reset$={reset$} onChange={onChange} />
								: <ObjectField node={jsonSchema} path={rootPath} value$={value$} reset$={reset$} onChange={onChange} />}
						</ValidationContext.Provider>
					</MessageVarsContext.Provider>
				</RbacContext.Provider>
			</SavedRootContext.Provider>
		</FormOptionsContext.Provider>
	)
}
