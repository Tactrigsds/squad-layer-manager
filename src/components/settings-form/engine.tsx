import * as Icons from 'lucide-react'
import React from 'react'

import {
	EnumArrayField,
	FieldIssues,
	JsonFallback,
	NullableField,
	SelectField,
	SwitchField,
	TextInputField,
} from '@/components/settings-form/controls'
import { RbacBody } from '@/components/settings-form/editors/rbac'
import {
	AdvancedDisclosure,
	AnchorLink,
	CommandsPageCrossLink,
	CommentButton,
	FieldNotice,
	FieldResetControls,
	LocalModeToggle,
	LocalYamlField,
	SettingComment,
} from '@/components/settings-form/field-parts'
import { overrideFor, sectionExtraFor } from '@/components/settings-form/overrides'
import {
	AdvancedPathsContext,
	discriminatedUnion,
	emptyValue,
	type FieldMode,
	FormOptionsContext,
	type FormRoot,
	isScalarNode,
	isStringOrNumber,
	issuesForField,
	type ObjectSchemaNode,
	type Path,
	placeholderFor,
	type SchemaNode,
	scopeValue,
	stripNullable,
	useCommentProps,
	useFieldValue,
	useLocalEditorSchema,
	ValidationContext,
	type ValueState,
	WriteAccessContext,
} from '@/components/settings-form/settings-form.helpers'
import { StickyGroup } from '@/components/sticky-group'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type * as Rx from '@/lib/rxjs'
import type { SettingsGroup } from '@/lib/settings-groups'
import { HIDDEN_SETTINGS_KEYS, splitAdvanced, splitByGroups, TOC_ENTRY_PATHS } from '@/lib/settings-groups'
import { cn } from '@/lib/utils'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as RBAC from '@/rbac.models'
import { tr } from '@/systems/messages.client'

// discriminated union: a variant picker keyed to the discriminator const, plus the active branch's object fields
// (the discriminator field itself is chosen by the picker, so it isn't rendered as an editable property).
function DiscriminatedUnionField({
	node,
	path,
	value$,
	reset$,
	onChange,
	branches,
	discriminator,
	root,
}: {
	node: SchemaNode
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	branches: ObjectSchemaNode[]
	discriminator: string
	root: FormRoot
}) {
	const value = useFieldValue(value$) as any
	const branchFor = (constVal: string) => branches.find((b) => String(b.properties[discriminator].const) === constVal)
	const active = value?.[discriminator]
	const branch = branchFor(String(active)) ?? branches[0]
	// hide the discriminator from the rendered fields; it's set by the picker (and carried in the value)
	const branchProps = Object.fromEntries(Object.entries(branch.properties).filter(([k]) => k !== discriminator))
	const branchNode: SchemaNode = { ...branch, properties: branchProps }
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
								{tr.text(SETTINGS_Msgs.settingOption(node, opt))}
							</SelectItem>
						)
					})}
				</SelectContent>
			</Select>
			<ObjectField node={branchNode} path={path} value$={value$} reset$={reset$} onChange={onChange} root={root} />
		</div>
	)
}

function wrapNullable(
	nullable: boolean,
	child: React.ReactNode,
	inner: SchemaNode,
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

function FieldControl({
	node,
	path,
	value$,
	reset$,
	onChange,
	root,
}: {
	node: SchemaNode
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	root: FormRoot
}) {
	const Override = overrideFor(path, node)
	// oxlint-disable-next-line react/static-components -- a lookup over module-level components, not one built here
	if (Override) return <Override value$={value$} reset$={reset$} onChange={onChange} path={path} root={root} />

	// the whole rbac subtree renders as one consolidated per-role editor (kept inside the standard section shell so its
	// header + super-users callout + reset controls are preserved)
	if (path.length === 1 && path[0] === 'rbac') return <RbacBody value$={value$} reset$={reset$} onChange={onChange} />

	const { inner, nullable } = stripNullable(node)

	// discriminated union -> variant picker + active branch fields
	const du = discriminatedUnion(inner)
	if (du) {
		return (
			<DiscriminatedUnionField
				node={node}
				path={path}
				value$={value$}
				reset$={reset$}
				onChange={onChange}
				branches={du.branches}
				discriminator={du.discriminator}
				root={root}
			/>
		)
	}

	// enum -> select
	if (inner.enum && inner.type !== 'array') {
		return wrapNullable(
			nullable,
			<SelectField value$={value$} reset$={reset$} onChange={onChange} options={inner.enum} node={node} />,
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
		return <ArrayField node={inner} path={path} value$={value$} reset$={reset$} onChange={onChange} root={root} />
	}

	if (inner.type === 'object') {
		if (inner.additionalProperties && typeof inner.additionalProperties === 'object') {
			return <RecordField node={inner} path={path} value$={value$} reset$={reset$} onChange={onChange} root={root} />
		}
		return <ObjectField node={inner} path={path} value$={value$} reset$={reset$} onChange={onChange} root={root} />
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
	root,
}: {
	node: SchemaNode
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any[]) => void
	root: FormRoot
}) {
	const items: SchemaNode = node.items ?? {}
	const { inner } = stripNullable(items)

	const value = (useFieldValue(value$) as any[]) ?? []

	// array of enum -> multi-select
	if (inner.enum && inner.type !== 'array' && inner.type !== 'object') {
		return <EnumArrayField value$={value$} reset$={reset$} onChange={onChange} options={inner.enum.map(String)} node={items} />
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
					root={root}
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
	root,
	onRemove,
}: {
	items: SchemaNode
	path: Path
	idx: number
	parent$: ValueState
	reset$: Rx.Subject<void>
	parentOnChange: (v: any[]) => void
	isPrimitive: boolean
	root: FormRoot
	onRemove: () => void
}) {
	const value$ = scopeValue(parent$, idx)
	const onChange = (v: any) => {
		const arr = [...((parent$.getValue() as any[]) ?? [])]
		arr[idx] = v
		parentOnChange(arr)
	}
	const { idPrefix } = React.useContext(FormOptionsContext)
	const pathStr = path.join('.')
	const isTocEntry = TOC_ENTRY_PATHS.has(pathStr)
	return (
		<div
			id={isTocEntry ? `${idPrefix}${pathStr}.${idx}` : undefined}
			className={cn(
				'flex gap-2',
				isPrimitive ? 'items-center' : 'items-start',
				// inset so the anchor highlight ring doesn't sit on the item's own border
				isTocEntry && 'scroll-mt-2 rounded-md -mx-1 p-1',
			)}
		>
			<div className={cn('flex-1 min-w-0', !isPrimitive && 'border rounded-md p-2')}>
				<FieldControl node={items} path={[...path, idx]} value$={value$} reset$={reset$} onChange={onChange} root={root} />
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
	root,
}: {
	node: SchemaNode
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: Record<string, any>) => void
	root: FormRoot
}) {
	const valueNode: SchemaNode = typeof node.additionalProperties === 'object' ? node.additionalProperties : {}
	// when the schema constrains keys to a known set (z.partialRecord / propertyNames enum), the key becomes a fixed picker
	// rather than free text, so only known keys can be added
	const keyEnum = node.propertyNames?.enum?.map(String)
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
					root={root}
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
	root,
	onRename,
	onRemove,
}: {
	valueNode: SchemaNode
	path: Path
	entryKey: string
	fixedKey: boolean
	parent$: ValueState
	reset$: Rx.Subject<void>
	parentOnChange: (v: Record<string, any>) => void
	root: FormRoot
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
				<Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-destructive ms-auto" onClick={onRemove}>
					<Icons.X className="h-4 w-4" />
				</Button>
			</div>
			<FieldControl node={valueNode} path={[...path, entryKey]} value$={value$} reset$={reset$} onChange={onChange} root={root} />
		</div>
	)
}

export function ObjectField({
	node,
	path,
	value$,
	reset$,
	onChange,
	root,
}: {
	node: SchemaNode
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: Record<string, any>) => void
	root: FormRoot
}) {
	const props: Record<string, SchemaNode> = node.properties ?? {}
	const { normal, advanced } = splitAdvanced(Object.keys(props), path.join('.'), React.useContext(AdvancedPathsContext))
	const field = (key: string) => (
		<Field
			key={key}
			name={key}
			node={props[key]}
			path={[...path, key]}
			parent$={value$}
			parentOnChange={onChange}
			reset$={reset$}
			root={root}
		/>
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

// a nested object section: titled fieldset. `useIsModified` keeps the reset affordance live without re-rendering
// the whole subtree on every descendant edit.
function SectionField({
	name,
	node,
	path,
	value$,
	reset$,
	onChange,
	root,
}: {
	name: string
	node: SchemaNode
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	root: FormRoot
}) {
	const { inner } = stripNullable(node)
	const descriptionMsg = SETTINGS_Msgs.settingDescription(node) ?? SETTINGS_Msgs.settingDescription(inner)
	const description = descriptionMsg && tr.text(descriptionMsg)
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
	const commentProps = useCommentProps(root, pathStr, writable)
	return (
		<fieldset
			id={domId}
			data-settings-error={sectionIssues.length > 0 || undefined}
			className={cn('border rounded-md px-3 pb-3 pt-0 space-y-3 scroll-mt-2', sectionIssues.length > 0 && 'border-destructive')}
		>
			<StickyGroup stickyRef={headerRef}>
				<div ref={headerRef} className="group flex items-center gap-2 -mx-3 rounded-t-md border-b bg-card px-3 py-2">
					<legend className="px-1 text-sm font-semibold">{tr.text(SETTINGS_Msgs.settingLabel(node, name))}</legend>
					<code className="text-[10px] text-muted-foreground ltr-isolate">{pathStr}</code>
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
					{writable && <CommentButton {...commentProps} />}
					{jsonSchema && writable && <LocalModeToggle mode={mode} onSelect={setMode} />}
				</div>
				<SettingComment {...commentProps} />
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
				{/* oxlint-disable-next-line react/static-components -- a lookup over module-level components, not one built here */}
				{SectionExtra && <SectionExtra />}
				<FieldIssues issues={sectionIssues} pathStr={pathStr} />
				{jsonSchema && mode === 'yaml' ? (
					<LocalYamlField
						schema={jsonSchema}
						label={tr.text(SETTINGS_Msgs.settingLabel(node, name))}
						domId={domId}
						path={path}
						value$={value$}
						reset$={reset$}
						onChange={onChange}
						root={root}
					/>
				) : (
					<FieldControl node={node} path={path} value$={value$} reset$={reset$} onChange={onChange} root={root} />
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
	root,
}: {
	name: string
	node: SchemaNode
	path: Path
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: any) => void
	hasOverride: boolean
	root: FormRoot
}) {
	const { inner } = stripNullable(node)
	const descriptionMsg = SETTINGS_Msgs.settingDescription(node) ?? SETTINGS_Msgs.settingDescription(inner)
	const description = descriptionMsg && tr.text(descriptionMsg)
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
	const commentProps = useCommentProps(root, pathStr, writable)
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
				hasError && 'border-s-2 border-destructive',
				!writable && 'opacity-60',
			)}
		>
			<div className={cn(isBoolean && 'min-w-0')}>
				<div className="group flex items-center gap-1.5">
					<Label className={cn('text-sm', hasError && 'text-destructive')}>{tr.text(SETTINGS_Msgs.settingLabel(node, name))}</Label>
					<code className="text-[10px] text-muted-foreground ltr-isolate">{pathStr}</code>
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
					{writable && <CommentButton {...commentProps} />}
					<CommandsPageCrossLink path={path} />
					{jsonSchema && writable && <LocalModeToggle mode={mode} onSelect={setMode} />}
				</div>
				<SettingComment {...commentProps} />
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
				<FieldIssues issues={fieldIssues} pathStr={pathStr} />
				<FieldNotice path={path} />
			</div>
			<div className={cn(isBoolean && 'shrink-0 flex items-center gap-1')} inert={!writable}>
				{isBoolean && controls}
				{jsonSchema && mode === 'yaml' ? (
					<LocalYamlField
						schema={jsonSchema}
						label={tr.text(SETTINGS_Msgs.settingLabel(node, name))}
						domId={domId}
						path={path}
						value$={value$}
						reset$={reset$}
						onChange={onChange}
						root={root}
					/>
				) : (
					<FieldControl node={node} path={path} value$={value$} reset$={reset$} onChange={onChange} root={root} />
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
	root,
}: {
	name: string
	node: SchemaNode
	path: Path
	parent$: ValueState
	parentOnChange: (v: Record<string, any>) => void
	reset$: Rx.Subject<void>
	root: FormRoot
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

	if (isSection) {
		return <SectionField name={name} node={node} path={path} value$={value$} reset$={reset$} onChange={onChange} root={root} />
	}
	return (
		<LeafField
			name={name}
			node={node}
			path={path}
			value$={value$}
			reset$={reset$}
			onChange={onChange}
			hasOverride={hasOverride}
			root={root}
		/>
	)
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
export function GroupedRootFields({
	node,
	groups,
	value$,
	reset$,
	onChange,
	root,
}: {
	node: SchemaNode
	groups: SettingsGroup[]
	value$: ValueState
	reset$: Rx.Subject<void>
	onChange: (v: Record<string, any>) => void
	root: FormRoot
}) {
	const props: Record<string, SchemaNode> = node.properties ?? {}
	const { groups: grouped, ungrouped } = splitByGroups(Object.keys(props), groups)
	const advancedPaths = React.useContext(AdvancedPathsContext)
	const field = (key: string) => (
		<Field key={key} name={key} node={props[key]} path={[key]} parent$={value$} parentOnChange={onChange} reset$={reset$} root={root} />
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
					<GroupSection key={group.slug} slug={group.slug} label={tr.text(SETTINGS_Msgs.settingsGroupNames[group.slug])}>
						{renderKeys(keys)}
					</GroupSection>
				),
			)}
			{renderKeys(ungrouped)}
		</div>
	)
}
