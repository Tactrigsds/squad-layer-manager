import { BmFlagMultiSelect, BmFlagOrColorSelect, BmFlagOrderedList, FlagPriorityMap } from '@/components/bm-flag-picker'
import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { DiscordMemberSelect, DiscordRoleSelect } from '@/components/discord-picker'
import FilterEntitySelect from '@/components/filter-entity-select'
import { StickyGroup } from '@/components/sticky-group'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useDebounced } from '@/hooks/use-debounce'
import * as Obj from '@/lib/object'
import { settingLabel } from '@/lib/settings-labels'
import * as SettingsNav from '@/lib/settings-nav'
import { cn } from '@/lib/utils'
import * as RBAC from '@/rbac.models'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'
import { z } from 'zod'

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

// cheap "differs from default" flag for section headers: only flips (not per-keystroke), so sections don't
// re-render (and cascade) on every descendant edit.
function useIsModified(value$: ValueState, reset$: Rx.Observable<void>, def: { has: boolean; value: unknown }): boolean {
	const compute = React.useCallback(() => def.has && !Obj.deepEqual(value$.getValue(), def.value), [value$, def])
	const [mod, setMod] = React.useState(compute)
	React.useEffect(() => {
		const sub = new Rx.Subscription()
		sub.add(value$.pipe(Rx.map(() => compute()), Rx.distinctUntilChanged()).subscribe(setMod))
		sub.add(reset$.subscribe(() => setMod(compute())))
		return () => sub.unsubscribe()
	}, [value$, reset$, compute])
	return mod
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

// per-form options. `idPrefix` scopes the DOM ids / URL-fragment anchors so multiple forms on the settings page (global
// settings + one per server) don't collide; it stays `setting:*` so the TOC scroll-spy and hash nav still match.
const FormOptionsContext = React.createContext<{ idPrefix: string }>({ idPrefix: 'setting:' })

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
			// defer to avoid re-entrant BehaviorSubject.next while this emission is still being delivered
			if (changed) queueMicrotask(() => onChange({ ...value$.getValue(), rbac: { ...value$.getValue().rbac, roleAssignments: nextRa } }))
		})
		return () => sub.unsubscribe()
	}, [value$, onChange])
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
// filter-pool config references a filter entity by id; pick it from the known filters rather than typing the id
function FilterIdField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$, reset$)
	return <FilterEntitySelect className="w-full" filterId={value ?? null} allowEmpty={false} onSelect={(id) => onChange(id ?? '')} />
}
function PasswordField({ value$, reset$, onChange }: OverrideProps) {
	return <TextInputField value$={value$} reset$={reset$} onChange={onChange} numeric={false} secret />
}
function DiscordMemberField({ value$, reset$, onChange }: OverrideProps) {
	const value = useFieldValue(value$, reset$)
	return <DiscordMemberSelect value={value ?? ''} onChange={onChange} />
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

function overrideFor(path: Path): React.FC<OverrideProps> | undefined {
	const last = path[path.length - 1]
	if (path.length === 1 && last === 'playerFlagColorHierarchy') return FlagOrderedListField
	if (path.length === 1 && last === 'playerFlagsRequiringNote') return FlagMultiSelectField
	if (path[0] === 'playerFlagGroupings' && typeof path[1] === 'number' && last === 'color') return FlagOrColorField
	if (path[0] === 'playerFlagGroupings' && typeof path[1] === 'number' && last === 'associations') return FlagPriorityMapField
	if (path[0] === 'rbac' && path[1] === 'roles' && path.length === 3) return RolePermissionField
	// the per-assignment `roles` lists, plus the flat "every member" list, are all role pickers keyed to defined roles
	if (path[0] === 'rbac' && path[1] === 'roleAssignments' && (last === 'roles' || last === 'discord-server-member')) {
		return AssignmentRolesField
	}
	// searchable Discord role/account pickers for the role-assignment editor, keyed to the raw-id fields
	if (path[0] === 'rbac' && path[1] === 'roleAssignments' && path[2] === 'discord-role' && last === 'discordRoleId') return DiscordRoleField
	if (path[0] === 'rbac' && path[1] === 'roleAssignments' && path[2] === 'discord-user' && last === 'userId') return DiscordMemberField
	// server settings: filter-pool entries reference a filter by id; connection passwords are masked
	if (last === 'filterId') return FilterIdField
	if (last === 'password') return PasswordField
	return undefined
}

// -------- leaf controls --------

// uncontrolled text/number input: seeded from value$, edits debounced upward, re-read on reset$
function TextInputField(
	{ value$, reset$, onChange, numeric, secret }: {
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: any) => void
		numeric: boolean
		secret?: boolean
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

function FieldControl(
	{ node, path, value$, reset$, onChange }: {
		node: Node
		path: Path
		value$: ValueState
		reset$: Rx.Subject<void>
		onChange: (v: any) => void
	},
) {
	const Override = overrideFor(path)
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
			<TextInputField value$={value$} reset$={reset$} onChange={onChange} numeric={false} />,
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
			<TextInputField value$={value$} reset$={reset$} onChange={onChange} numeric />,
			inner,
			value$,
			reset$,
			onChange,
		)
	}

	if (inner.type === 'string') {
		return wrapNullable(
			nullable,
			<TextInputField value$={value$} reset$={reset$} onChange={onChange} numeric={false} />,
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

function ResetButton({ onClick }: { onClick: () => void }) {
	return (
		<Button
			type="button"
			size="icon"
			variant="ghost"
			className="h-6 w-6 shrink-0 text-muted-foreground"
			title="Reset to default"
			onClick={onClick}
		>
			<Icons.RotateCcw className="h-3.5 w-3.5" />
		</Button>
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
	const def = effectiveDefault(node)
	const modified = useIsModified(value$, reset$, def)
	// the header pins to the top of the scroll column (stacking under any ancestor section headers) while this section
	// is in view. StickyGroup handles the offset math + z-index; the ref'd element must sit before the section body.
	const headerRef = React.useRef<HTMLDivElement>(null)
	return (
		<fieldset id={domId} className="border rounded-md px-3 pb-3 pt-0 space-y-3 scroll-mt-2">
			<StickyGroup stickyRef={headerRef}>
				<div ref={headerRef} className="group flex items-center gap-2 -mx-3 rounded-t-md border-b bg-card px-3 py-2">
					<legend className="px-1 text-sm font-semibold">{settingLabel(path, name)}</legend>
					<code className="text-[10px] text-muted-foreground">{pathStr}</code>
					<AnchorLink domId={domId} />
					{modified && (
						<ResetButton
							onClick={() => {
								onChange(structuredClone(def.value))
								reset$.next()
							}}
						/>
					)}
				</div>
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
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
	const value = useFieldValue(value$, reset$)
	const def = effectiveDefault(node)
	const canReset = def.has && !Obj.deepEqual(value, def.value)
	const resetBtn = canReset
		? (
			<ResetButton
				onClick={() => {
					onChange(structuredClone(def.value))
					reset$.next()
				}}
			/>
		)
		: null

	const isBoolean = inner.type === 'boolean'
	const showDefaultText = !hasOverride && def.has && isScalarNode(inner)
	return (
		<div
			id={domId}
			className={cn('space-y-1 scroll-mt-2', isBoolean && 'flex items-center justify-between space-y-0 gap-4')}
		>
			<div className={cn(isBoolean && 'min-w-0')}>
				<div className="group flex items-center gap-1.5">
					<Label className="text-sm">{settingLabel(path, name)}</Label>
					<code className="text-[10px] text-muted-foreground">{pathStr}</code>
					<AnchorLink domId={domId} />
					{!isBoolean && resetBtn}
				</div>
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
				{showDefaultText && <p className="text-xs text-muted-foreground">Default: {formatDefaultValue(def.value)}</p>}
			</div>
			<div className={cn(isBoolean && 'shrink-0 flex items-center gap-1')}>
				{isBoolean && resetBtn}
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
	const hasOverride = !!overrideFor(path)
	const isSection = !hasOverride
		&& inner.type === 'object'
		&& !!inner.properties
		&& !(inner.additionalProperties && typeof inner.additionalProperties === 'object')

	if (isSection) return <SectionField name={name} node={node} path={path} value$={value$} reset$={reset$} onChange={onChange} />
	return <LeafField name={name} node={node} path={path} value$={value$} reset$={reset$} onChange={onChange} hasOverride={hasOverride} />
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
	{ schema, value$, reset$, onChange, idPrefix = 'setting:' }: {
		schema: z.ZodType
		value$: Rx.Observable<any> & { getValue: () => any }
		reset$: Rx.Subject<void>
		onChange: (next: any) => void
		// scopes field DOM ids / URL anchors; defaults to `setting:` (global settings). Server forms pass `setting:server:<id>:`
		idPrefix?: string
	},
) {
	const jsonSchema = React.useMemo(() => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Node, [schema])
	// stable so the form subtree stays memoized when only rbacInfo (context) changes
	const rootPath = React.useMemo<Path>(() => [], [])
	const formOptions = React.useMemo(() => ({ idPrefix }), [idPrefix])
	const rbacInfo = useRbacInfo(value$)
	useRoleCascade(value$, onChange)
	return (
		<FormOptionsContext.Provider value={formOptions}>
			<RbacContext.Provider value={rbacInfo}>
				<ObjectField node={jsonSchema} path={rootPath} value$={value$} reset$={reset$} onChange={onChange} />
			</RbacContext.Provider>
		</FormOptionsContext.Provider>
	)
}
