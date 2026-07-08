import { BmFlagMultiSelect, BmFlagOrColorSelect, BmFlagOrderedList, FlagPriorityMap } from '@/components/bm-flag-picker'
import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { DiscordMemberSelect, DiscordRoleSelect } from '@/components/discord-picker'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import * as Obj from '@/lib/object'
import { settingLabel } from '@/lib/settings-labels'
import { cn } from '@/lib/utils'
import * as RBAC from '@/rbac.models'
import * as Icons from 'lucide-react'
import React from 'react'
import { z } from 'zod'

// The form is driven off the JSON-Schema projection of a Zod schema (input mode), edited in the encoded/input shape
// (e.g. HumanTime fields as '5m' strings). Custom widgets are matched by path for the flag + rbac config.

type Node = any
type Path = (string | number)[]

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

function emptyValue(node: Node): unknown {
	const { inner, nullable } = stripNullable(node)
	if (nullable) return null
	if (inner.default !== undefined) return structuredClone(inner.default)
	if (inner.enum) return inner.enum[0]
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

// -------- override widgets (matched by path) --------

function overrideFor(path: Path): React.FC<{ value: any; onChange: (v: any) => void }> | undefined {
	const last = path[path.length - 1]
	if (path.length === 1 && last === 'playerFlagColorHierarchy') {
		return ({ value, onChange }) => <BmFlagOrderedList value={value ?? []} onChange={onChange} />
	}
	if (path.length === 1 && last === 'playerFlagsRequiringNote') {
		return ({ value, onChange }) => <BmFlagMultiSelect value={value ?? []} onChange={onChange} />
	}
	if (path[0] === 'playerFlagGroupings' && typeof path[1] === 'number' && last === 'color') {
		return ({ value, onChange }) => <BmFlagOrColorSelect value={value ?? ''} onChange={onChange} />
	}
	if (path[0] === 'playerFlagGroupings' && typeof path[1] === 'number' && last === 'associations') {
		return ({ value, onChange }) => <FlagPriorityMap value={value ?? {}} onChange={onChange} />
	}
	if (path[0] === 'rbac' && path[1] === 'globalRolePermissions' && path.length === 3) {
		return PermissionExpressionEditor
	}
	// searchable Discord role/account pickers for the role-assignment editor, keyed to the raw-id fields
	if (path[0] === 'rbac' && path[1] === 'roleAssignments' && path[2] === 'discord-role' && last === 'discordRoleId') {
		return ({ value, onChange }) => <DiscordRoleSelect value={value ?? ''} onChange={onChange} />
	}
	if (path[0] === 'rbac' && path[1] === 'roleAssignments' && path[2] === 'discord-user' && last === 'userId') {
		return ({ value, onChange }) => <DiscordMemberSelect value={value ?? ''} onChange={onChange} />
	}
	return undefined
}

// -------- field renderers --------

function NullableWrap(
	{ nullable, value, empty, onChange, children }: {
		nullable: boolean
		value: unknown
		empty: unknown
		onChange: (v: unknown) => void
		children: React.ReactNode
	},
): React.ReactNode {
	if (!nullable) return children
	const isNull = value === null || value === undefined
	return (
		<div className="flex items-center gap-2">
			<label className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
				<Checkbox checked={isNull} onCheckedChange={(c) => onChange(c ? null : empty)} />
				unset
			</label>
			{!isNull && <div className="flex-1 min-w-0">{children}</div>}
		</div>
	)
}

function FieldControl({ node, path, value, onChange }: { node: Node; path: Path; value: any; onChange: (v: any) => void }) {
	const Override = overrideFor(path)
	if (Override) return <Override value={value} onChange={onChange} />

	const { inner, nullable } = stripNullable(node)
	const empty = emptyValue(inner)

	// enum -> select
	if (inner.enum && inner.type !== 'array') {
		return (
			<NullableWrap nullable={nullable} value={value} empty={empty} onChange={onChange}>
				<Select value={value ?? ''} onValueChange={onChange}>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{inner.enum.map((opt: string) => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}
					</SelectContent>
				</Select>
			</NullableWrap>
		)
	}

	// string | number (HumanTime etc.) -> text input
	if (isStringOrNumber(inner)) {
		return (
			<NullableWrap nullable={nullable} value={value} empty={empty} onChange={onChange}>
				<Input value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
			</NullableWrap>
		)
	}

	if (inner.type === 'boolean') {
		return <Switch checked={!!value} onCheckedChange={onChange} />
	}

	if (inner.type === 'integer' || inner.type === 'number') {
		return (
			<NullableWrap nullable={nullable} value={value} empty={empty} onChange={onChange}>
				<Input
					type="number"
					value={typeof value === 'number' ? value : ''}
					onChange={(e) => onChange(e.target.value === '' ? '' : e.target.valueAsNumber)}
				/>
			</NullableWrap>
		)
	}

	if (inner.type === 'string') {
		return (
			<NullableWrap nullable={nullable} value={value} empty={empty} onChange={onChange}>
				<Input value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
			</NullableWrap>
		)
	}

	if (inner.type === 'array') {
		return <ArrayField node={inner} path={path} value={value ?? []} onChange={onChange} />
	}

	if (inner.type === 'object') {
		if (inner.additionalProperties && typeof inner.additionalProperties === 'object') {
			return <RecordField node={inner} path={path} value={value ?? {}} onChange={onChange} />
		}
		return <ObjectField node={inner} path={path} value={value ?? {}} onChange={onChange} />
	}

	// fallback for anything the walker can't render structurally
	return <JsonFallback value={value} onChange={onChange} />
}

function ArrayField({ node, path, value, onChange }: { node: Node; path: Path; value: any[]; onChange: (v: any[]) => void }) {
	const items: Node = node.items ?? {}
	const { inner } = stripNullable(items)

	// array of enum -> multi-select
	if (inner.enum && inner.type !== 'array' && inner.type !== 'object') {
		return (
			<ComboBoxMulti
				title="Value"
				values={value}
				options={inner.enum}
				onSelect={(next) => onChange(typeof next === 'function' ? next(value) : next)}
			/>
		)
	}

	const isPrimitive = inner.type === 'string' || inner.type === 'integer' || inner.type === 'number' || isStringOrNumber(inner)

	return (
		<div className="space-y-1.5">
			{value.length === 0 && <p className="text-xs text-muted-foreground">Empty.</p>}
			{value.map((item, idx) => (
				// list items have no stable id (primitives / freshly-added objects), so index is the pragmatic key here
				// oxlint-disable-next-line no-array-index-key
				<div key={idx} className={cn('flex gap-2', isPrimitive ? 'items-center' : 'items-start')}>
					<div className={cn('flex-1 min-w-0', !isPrimitive && 'border rounded-md p-2')}>
						<FieldControl
							node={items}
							path={[...path, idx]}
							value={item}
							onChange={(v) => {
								const next = [...value]
								next[idx] = v
								onChange(next)
							}}
						/>
					</div>
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className="h-8 w-8 text-destructive shrink-0"
						onClick={() => onChange(value.filter((_, i) => i !== idx))}
					>
						<Icons.X className="h-4 w-4" />
					</Button>
				</div>
			))}
			<Button type="button" size="sm" variant="outline" onClick={() => onChange([...value, emptyValue(items)])}>
				<Icons.Plus className="h-4 w-4" />
				Add
			</Button>
		</div>
	)
}

function RecordField(
	{ node, path, value, onChange }: { node: Node; path: Path; value: Record<string, any>; onChange: (v: Record<string, any>) => void },
) {
	const valueNode: Node = node.additionalProperties
	// when the schema constrains keys to a known set (z.partialRecord / propertyNames enum), the key becomes a fixed picker
	// rather than free text, so only known keys can be added
	const keyEnum: string[] | undefined = node.propertyNames?.enum
	const [newKey, setNewKey] = React.useState('')
	const entries = Object.entries(value)

	function rename(oldKey: string, nextKey: string) {
		if (nextKey === oldKey || nextKey in value) return
		const next: Record<string, any> = {}
		for (const [k, v] of Object.entries(value)) next[k === oldKey ? nextKey : k] = v
		onChange(next)
	}

	function add(key: string) {
		if (!key || key in value) return
		onChange({ ...value, [key]: emptyValue(valueNode) })
		setNewKey('')
	}

	const remainingKeys = keyEnum?.filter((k) => !(k in value)) ?? []

	return (
		<div className="space-y-2">
			{entries.length === 0 && <p className="text-xs text-muted-foreground">No entries.</p>}
			{entries.map(([key, val]) => (
				<div key={key} className="border rounded-md p-2 space-y-1.5">
					<div className="flex items-center gap-2">
						{keyEnum
							? <span className="font-mono text-sm">{key}</span>
							: (
								<Input
									className="font-mono h-8 max-w-[16rem]"
									defaultValue={key}
									onBlur={(e) => rename(key, e.target.value.trim())}
								/>
							)}
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-8 w-8 text-destructive ml-auto"
							onClick={() => {
								const next = { ...value }
								delete next[key]
								onChange(next)
							}}
						>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
					<FieldControl
						node={valueNode}
						path={[...path, key]}
						value={val}
						onChange={(v) => onChange({ ...value, [key]: v })}
					/>
				</div>
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

function ObjectField(
	{ node, path, value, onChange }: { node: Node; path: Path; value: Record<string, any>; onChange: (v: Record<string, any>) => void },
) {
	const props: Record<string, Node> = node.properties ?? {}
	return (
		<div className="space-y-3">
			{Object.entries(props).map(([key, childNode]) => (
				<Field
					key={key}
					name={key}
					node={childNode}
					path={[...path, key]}
					value={value?.[key]}
					onChange={(v) => onChange({ ...value, [key]: v })}
				/>
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

// a single labeled field; nested objects render as titled sections. `id` anchors it for the table-of-contents nav.
function Field({ name, node, path, value, onChange }: { name: string; node: Node; path: Path; value: any; onChange: (v: any) => void }) {
	const { inner } = stripNullable(node)
	const description: string | undefined = node.description ?? inner.description
	const pathStr = path.join('.')
	const domId = `setting:${pathStr}`
	const hasOverride = !!overrideFor(path)
	const isSection = !hasOverride
		&& inner.type === 'object'
		&& !!inner.properties
		&& !(inner.additionalProperties && typeof inner.additionalProperties === 'object')

	const def = effectiveDefault(node)
	const canReset = def.has && !Obj.deepEqual(value, def.value)
	const resetBtn = canReset ? <ResetButton onClick={() => onChange(structuredClone(def.value))} /> : null

	if (isSection) {
		return (
			<fieldset id={domId} className="border rounded-md p-3 space-y-3 scroll-mt-2">
				<div className="flex items-center gap-2">
					<legend className="px-1 text-sm font-semibold">{settingLabel(path, name)}</legend>
					<code className="text-[10px] text-muted-foreground">{pathStr}</code>
					{resetBtn}
				</div>
				{description && <p className="text-xs text-muted-foreground -mt-1">{description}</p>}
				<FieldControl node={node} path={path} value={value} onChange={onChange} />
			</fieldset>
		)
	}

	const isBoolean = inner.type === 'boolean'
	const showDefaultText = !hasOverride && def.has && isScalarNode(inner)
	return (
		<div
			id={domId}
			className={cn('space-y-1 scroll-mt-2', isBoolean && 'flex items-center justify-between space-y-0 gap-4')}
		>
			<div className={cn(isBoolean && 'min-w-0')}>
				<div className="flex items-center gap-1.5">
					<Label className="text-sm">{settingLabel(path, name)}</Label>
					<code className="text-[10px] text-muted-foreground">{pathStr}</code>
					{!isBoolean && resetBtn}
				</div>
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
				{showDefaultText && <p className="text-xs text-muted-foreground">Default: {formatDefaultValue(def.value)}</p>}
			</div>
			<div className={cn(isBoolean && 'shrink-0 flex items-center gap-1')}>
				{isBoolean && resetBtn}
				<FieldControl node={node} path={path} value={value} onChange={onChange} />
			</div>
		</div>
	)
}

function JsonFallback({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
	const [text, setText] = React.useState(() => JSON.stringify(value, null, 2))
	const [error, setError] = React.useState('')
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

export default function SettingsForm({ schema, value, onChange }: { schema: z.ZodType; value: any; onChange: (next: any) => void }) {
	const jsonSchema = React.useMemo(() => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Node, [schema])
	return <ObjectField node={jsonSchema} path={[]} value={value ?? {}} onChange={onChange} />
}
