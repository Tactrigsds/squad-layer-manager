import * as Icons from 'lucide-react'
import React from 'react'

import ComboBox from '@/components/combo-box/combo-box'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import * as HistoryFrame from '@/frames/history.frame'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as HistoryMsgs from '@/messages/history.messages'
import * as F from '@/models/filter.models'
import * as HQ from '@/models/history.models'
import * as L from '@/models/layer'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

// The advanced query tree editor: the filter card's visual idiom (depth colours, one compact row per node,
// inline adds) over the history vocabulary, plus the two node kinds the filter AST does not have.

const depthColors = ['border-red-700', 'border-green-700', 'border-blue-700', 'border-yellow-700']

type EditorProps = { stores: HistoryFrame.KeyProp }

export default function HistoryAdvancedEditor(props: EditorProps) {
	const [tree, revision] = Zus.useStore(
		props.stores.history,
		Zus.useShallow((s) => [s.tree, s.revision] as const),
	)
	return (
		<div className="rounded-md border border-border p-2">
			{/* keyed on the revision so a structural edit remounts the tree: its inputs are uncontrolled, and a
			    removed node otherwise leaves its text behind on the sibling that shifts into its index */}
			<NodeEditor key={revision} stores={props.stores} node={tree} path={[]} depth={0} />
		</div>
	)
}

function NodeEditor(props: EditorProps & { node: HQ.EditableNode; path: HistoryFrame.Path; depth: number }) {
	const { node } = props
	if (HQ.isBlockNode(node)) return <BlockEditor {...props} node={node} />
	if (HQ.isCompNode(node)) return <CompEditor {...props} node={node as F.EditableCompNode} />
	if (node.type === 'match-layer') return <LayerNodeEditor {...props} node={node} />
	if (node.type === 'subquery') return <SubqueryEditor {...props} node={node} />
	return null
}

function RemoveButton(props: EditorProps & { path: HistoryFrame.Path }) {
	if (props.path.length === 0 || props.path[props.path.length - 1] === 'f') return null
	return (
		<Button
			variant="ghost"
			size="icon"
			className="h-6 w-6 shrink-0"
			title={tr.text(HistoryMsgs.removeNode())}
			onClick={() => HistoryFrame.Actions.removeNode(props.stores, props.path)}
		>
			<Icons.X className="h-3 w-3" />
		</Button>
	)
}

function NotToggle(props: EditorProps & { path: HistoryFrame.Path; neg: boolean }) {
	return (
		<Button
			variant={props.neg ? 'destructive' : 'ghost'}
			size="sm"
			className="h-6 px-1.5 text-2xs font-mono"
			onClick={() =>
				HistoryFrame.Actions.updateNode(props.stores, props.path, (node) => {
					;(node as { neg: boolean }).neg = !props.neg
				})
			}
		>
			{tr.text(HistoryMsgs.notLabel())}
		</Button>
	)
}

function newComp(): F.EditableCompNode {
	return { type: 'eq', neg: false, args: [{ type: 'column' }, { type: 'value' }] }
}

function BlockEditor(
	props: EditorProps & { node: Extract<HQ.EditableNode, { children: unknown[] }>; path: HistoryFrame.Path; depth: number },
) {
	const { node, path, depth } = props
	const add = (child: HQ.EditableNode) => HistoryFrame.Actions.addChild(props.stores, path, child)
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-1">
				<Select
					value={node.type}
					onValueChange={(type) =>
						HistoryFrame.Actions.updateNode(props.stores, path, (n) => {
							;(n as { type: string }).type = type
						})
					}
				>
					<SelectTrigger className="h-6 w-max px-2 font-mono text-xs uppercase">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{F.BLOCK_TYPES.map((type) => (
							<SelectItem key={type} value={type} className="font-mono uppercase">
								{type}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="sm" className="h-6 px-1.5">
							<Icons.Plus className="h-3 w-3" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						<DropdownMenuItem onClick={() => add(newComp())}>{tr.text(HistoryMsgs.addComparison())}</DropdownMenuItem>
						<DropdownMenuItem onClick={() => add({ type: 'and', children: [] })}>{tr.text(HistoryMsgs.addGroup())}</DropdownMenuItem>
						<DropdownMenuItem onClick={() => add({ type: 'match-layer', neg: false, filter: { type: 'included-in' } })}>
							{tr.text(HistoryMsgs.addLayerFilter())}
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() => add({ type: 'subquery', neg: false, target: 'matches', filter: { type: 'and', children: [] } })}
						>
							{tr.text(HistoryMsgs.addSubquery())}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<RemoveButton stores={props.stores} path={path} />
			</div>
			{node.children.length > 0 && (
				<div className={cn('ml-1.5 flex flex-col gap-1 border-l-2 pl-2', depthColors[depth % depthColors.length])}>
					{node.children.map((child, i) => (
						<NodeEditor key={i} stores={props.stores} node={child} path={[...path, i]} depth={depth + 1} />
					))}
				</div>
			)}
		</div>
	)
}

function compColumn(node: F.EditableCompNode): HQ.ColumnKey | undefined {
	const column = F.compAnchorColumn(node)
	return column && HQ.getColumnDef(column) ? (column as HQ.ColumnKey) : undefined
}

function compValues(node: F.EditableCompNode): F.Value[] {
	const arg = node.args[1]
	if (!arg) return []
	if (arg.type === 'value') return arg.value === undefined ? [] : [arg.value]
	if (arg.type === 'values') return (arg.values ?? []).filter((v): v is F.Value => !F.isColumnListItem(v))
	return []
}

function CompEditor(props: EditorProps & { node: F.EditableCompNode; path: HistoryFrame.Path }) {
	const { node, path } = props
	const column = compColumn(node)
	const def = column ? HQ.COLUMN_DEFS[column] : undefined
	const opOptions = HQ.columnCompOptions(column ?? '')
	const currentOp = opOptions.find((o) => o.type === node.type && o.neg === node.neg)

	const setColumn = (key: HQ.ColumnKey) => {
		HistoryFrame.Actions.replaceNode(props.stores, path, {
			...newComp(),
			args: [{ type: 'column', column: key }, { type: 'value' }],
		})
	}
	const setOp = (key: string) => {
		const option = opOptions.find((o) => o.key === key)
		if (!option) return
		HistoryFrame.Actions.replaceNode(props.stores, path, F.applyCompOpSelection(node, option))
	}

	return (
		<div className="flex flex-wrap items-center gap-1">
			<Select value={column} onValueChange={(v) => setColumn(v as HQ.ColumnKey)}>
				<SelectTrigger className="h-6 w-max px-2 text-xs">
					<SelectValue placeholder={tr.text(HistoryMsgs.selectColumn())} />
				</SelectTrigger>
				<SelectContent>
					{HQ.COLUMN_KEYS.map((key) => (
						<SelectItem key={key} value={key}>
							{HQ.COLUMN_DEFS[key].displayName}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{def && (
				<Select value={currentOp?.key} onValueChange={setOp}>
					<SelectTrigger className="h-6 w-max px-1 text-xs font-mono">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{opOptions.map((o) => (
							<SelectItem key={o.key} value={o.key}>
								{o.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			{def && <CompValueEditor {...props} def={def} />}
			<RemoveButton stores={props.stores} path={path} />
		</div>
	)
}

function CompValueEditor(props: EditorProps & { node: F.EditableCompNode; path: HistoryFrame.Path; def: HQ.ColumnDef }) {
	const { node, path, def } = props
	const setScalar = (index: number, value: F.Value | undefined) =>
		HistoryFrame.Actions.updateNode(props.stores, path, (n) => {
			;(n as F.EditableCompNode).args[index] = { type: 'value', value }
		})
	const setValues = (values: F.Value[]) =>
		HistoryFrame.Actions.updateNode(props.stores, path, (n) => {
			;(n as F.EditableCompNode).args[1] = { type: 'values', values }
		})

	const servers = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers)
	const enumOptions: readonly string[] | undefined = (() => {
		if (def.domain.kind === 'enum') return def.domain.options
		if (def.domain.kind !== 'dynamic-enum') return undefined
		switch (def.domain.source) {
			case 'servers':
				return servers?.map((s) => s.id) ?? []
			case 'layers':
				return L.StaticLayerComponents.layers
			case 'maps':
				return L.StaticLayerComponents.maps
			case 'gamemodes':
				return L.StaticLayerComponents.gamemodes
			case 'factions':
				return L.StaticLayerComponents.factions
			case 'units':
				return L.StaticLayerComponents.units
			// thousands of interned blueprint names, and a query usually knows the one it wants: free text
			case 'damageSources':
				return undefined
			default:
				assertNever(def.domain.source)
		}
	})()

	const values = compValues(node)

	if (node.type === 'inrange') {
		const isTime = def.domain.kind === 'timestamp'
		return (
			<>
				<RangeValueInput value={values[0]} isTime={isTime} onChange={(v) => setScalar(1, v)} />
				<RangeValueInput value={values[1]} isTime={isTime} onChange={(v) => setScalar(2, v)} />
			</>
		)
	}

	if (node.type === 'in' && enumOptions) {
		return (
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="outline" size="sm" className="h-6 px-2 text-xs max-w-64 truncate">
						{values.length > 0 ? values.join(', ') : tr.text(HistoryMsgs.anyOption())}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					{enumOptions.map((option) => (
						<DropdownMenuCheckboxItem
							key={option}
							checked={values.includes(option)}
							onCheckedChange={(checked) => setValues(checked ? [...values, option] : values.filter((v) => v !== option))}
							onSelect={(e) => e.preventDefault()}
						>
							{option}
						</DropdownMenuCheckboxItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		)
	}

	if (node.type === 'in') {
		// free-form multi values: comma-separated
		return (
			<Input
				className="h-6 w-56 text-xs"
				defaultValue={values.join(', ')}
				onChange={(e) =>
					setValues(
						e.target.value
							.split(',')
							.map((v) => v.trim())
							.filter(Boolean),
					)
				}
			/>
		)
	}

	// scalar operators
	if (enumOptions) {
		const value = values[0]
		return (
			<Select value={typeof value === 'string' ? value : undefined} onValueChange={(v) => setScalar(1, v)}>
				<SelectTrigger className="h-6 w-max px-2 text-xs">
					<SelectValue placeholder={tr.text(HistoryMsgs.anyOption())} />
				</SelectTrigger>
				<SelectContent>
					{enumOptions.map((option) => (
						<SelectItem key={option} value={option}>
							{option}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		)
	}
	if (def.domain.kind === 'timestamp') {
		return <RangeValueInput value={values[0]} isTime onChange={(v) => setScalar(1, v)} />
	}
	if (def.domain.kind === 'number') {
		return (
			<Input
				type="number"
				className="h-6 w-32 text-xs"
				defaultValue={typeof values[0] === 'number' ? values[0] : ''}
				onChange={(e) => setScalar(1, e.target.value === '' ? undefined : Number(e.target.value))}
			/>
		)
	}
	return (
		<Input
			className="h-6 w-48 text-xs"
			defaultValue={typeof values[0] === 'string' ? values[0] : ''}
			onChange={(e) => setScalar(1, e.target.value === '' ? undefined : e.target.value)}
		/>
	)
}

function toDatetimeLocal(value: F.Value | undefined): string {
	if (typeof value !== 'number') return ''
	const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000)
	return date.toISOString().slice(0, 16)
}

function RangeValueInput(props: { value: F.Value | undefined; isTime?: boolean; onChange: (value: F.Value | undefined) => void }) {
	if (props.isTime) {
		return (
			<Input
				type="datetime-local"
				className="h-6 w-max text-xs"
				defaultValue={toDatetimeLocal(props.value)}
				onChange={(e) => props.onChange(e.target.value === '' ? undefined : new Date(e.target.value).getTime())}
			/>
		)
	}
	return (
		<Input
			type="number"
			className="h-6 w-32 text-xs"
			defaultValue={typeof props.value === 'number' ? props.value : ''}
			onChange={(e) => props.onChange(e.target.value === '' ? undefined : Number(e.target.value))}
		/>
	)
}

export function LayerFilterPicker(props: { value?: string; onSelect: (filterId: string | undefined) => void; allowEmpty?: boolean }) {
	const filterEntities = FilterEntityClient.useFilterEntities()
	const options = [...filterEntities.values()].map((entity) => ({ value: entity.id, label: entity.name }))
	return (
		<ComboBox
			title={tr.text(HistoryMsgs.fieldLayer())}
			placeholder={tr.text(HistoryMsgs.selectFilter())}
			allowEmpty={props.allowEmpty ?? true}
			value={props.value}
			options={options}
			onSelect={(v) => props.onSelect(v ?? undefined)}
		/>
	)
}

function LayerNodeEditor(props: EditorProps & { node: HQ.EditableMatchLayerNode; path: HistoryFrame.Path }) {
	const { node, path } = props
	const filterId = node.filter.type === 'included-in' || node.filter.type === 'excluded-from' ? node.filter.filterId : undefined
	return (
		<div className="flex items-center gap-1">
			<NotToggle stores={props.stores} path={path} neg={node.neg} />
			<span className="text-xs text-muted-foreground">{tr.text(HistoryMsgs.layerInFilter())}</span>
			<LayerFilterPicker
				value={filterId}
				allowEmpty={false}
				onSelect={(id) =>
					HistoryFrame.Actions.updateNode(props.stores, path, (n) => {
						;(n as HQ.EditableMatchLayerNode).filter = { type: 'included-in', filterId: id }
					})
				}
			/>
			<RemoveButton stores={props.stores} path={path} />
		</div>
	)
}

function SubqueryEditor(props: EditorProps & { node: HQ.EditableSubqueryNode; path: HistoryFrame.Path; depth: number }) {
	const { node, path, depth } = props
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-1">
				<NotToggle stores={props.stores} path={path} neg={node.neg} />
				<Select
					value={node.target}
					onValueChange={(target) =>
						HistoryFrame.Actions.updateNode(props.stores, path, (n) => {
							;(n as HQ.EditableSubqueryNode).target = target as HQ.SubqueryTarget
						})
					}
				>
					<SelectTrigger className="h-6 w-max px-2 text-xs">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="matches">{tr.text(HistoryMsgs.subqueryMatches())}</SelectItem>
						<SelectItem value="players">{tr.text(HistoryMsgs.subqueryPlayers())}</SelectItem>
					</SelectContent>
				</Select>
				<RemoveButton stores={props.stores} path={path} />
			</div>
			<div className={cn('ml-1.5 border-l-2 pl-2', depthColors[depth % depthColors.length])}>
				<NodeEditor stores={props.stores} node={node.filter} path={[...path, 'f']} depth={depth + 1} />
			</div>
		</div>
	)
}
