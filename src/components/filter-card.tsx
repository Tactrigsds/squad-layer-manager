import * as AR from '@/app-routes.ts'
import * as EditFrame from '@/frames/filter-editor.frame.ts'
import { getFrameState, useFrameLifecycle, useFrameStore } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import { globalToast$ } from '@/hooks/use-global-toast.ts'
import * as Arr from '@/lib/array.ts'
import * as DH from '@/lib/display-helpers'
import * as FRM from '@/lib/frame'
import * as Obj from '@/lib/object.ts'
import { Clearable, eltToFocusable, Focusable } from '@/lib/react'
import * as Sparse from '@/lib/sparse-tree'
import { assertNever } from '@/lib/type-guards.ts'
import { cn } from '@/lib/utils.ts'
import * as ZusUtils from '@/lib/zustand.ts'
import * as DND from '@/models/dndkit.models.ts'
import * as F from '@/models/filter.models'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models.ts'
import * as ConfigClient from '@/systems.client/config.client.ts'
import * as DndKit from '@/systems.client/dndkit.ts'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import { useLayerComponents as useLayerComponent } from '@/systems.client/layer-queries.client.ts'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import { Braces, EqualNot, ExternalLink, Minus, Plus, Undo2 } from 'lucide-react'
import React from 'react'
import { Link } from 'react-router-dom'
import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import ComboBox, { ComboBoxHandle, ComboBoxOption } from './combo-box/combo-box.tsx'
import { LOADING } from './combo-box/constants.ts'
import EditLayerDialog from './edit-layer-dialog.tsx'
import { FilterEntityLabel } from './filter-entity-select.tsx'
import FilterTextEditor, { FilterTextEditorHandle } from './filter-text-editor.tsx'
import { NodePortal, StoredParentNode } from './node-map.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import { Button, buttonVariants } from './ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Input } from './ui/input'
import { Label } from './ui/label.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx'
import { Separator } from './ui/separator.tsx'
import { Toggle } from './ui/toggle.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx'

const depthColors = [
	{ border: 'border-red-700 dark:border-red-700', background: 'bg-red-500 dark:bg-red-700' },
	{ border: 'border-green-700 dark:border-green-700', background: 'bg-green-500 dark:bg-green-700' },
	{ border: 'border-blue-700 dark:border-blue-700', background: 'bg-blue-500 dark:bg-blue-700' },
	{ border: 'border-yellow-700 dark:border-yellow-700', background: 'bg-yellow-500 dark:bg-yellow-700' },
] satisfies { border: string; background: string }[]

export type FilterCardProps = {
	frameKey: EditFrame.Key
}

const triggerClass =
	'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow'
export default function FilterCard(props: FilterCardProps & { children: React.ReactNode }) {
	const [activeTab, setActiveTab] = React.useState('builder' as 'builder' | 'text')
	const editorRef = React.useRef<FilterTextEditorHandle>(null)

	DndKit.useDragEnd(React.useCallback(event => {
		if (!event.over) return
		if (event.active.type !== 'filter-node') return
		const editor = getFrameState(props.frameKey)
		const sourcePath = editor.tree.paths.get(event.active.id)!
		const slot = event.over.slots.find(s => s.dragItem.type === 'filter-node')
		if (!slot) return
		const slotPath = editor.tree.paths.get(slot.dragItem.id.toString())!

		let targetPath: Sparse.NodePath

		switch (slot.position) {
			case 'after':
				targetPath = [...slotPath.slice(0, -1), slotPath[slotPath.length - 1] + 1]
				break
			case 'before':
				targetPath = slotPath
				break
			case 'on': {
				targetPath = [...slotPath, F.nextChildIndex(editor.tree, slotPath)]
				break
			}
			default:
				assertNever(slot.position)
		}

		if (Sparse.isOwnedPath(sourcePath, targetPath)) {
			console.warn('Cannot move node to its own child')
			return
		}
		editor.moveNode(sourcePath, targetPath)
	}, [props.frameKey]))

	const [nodeStore, modified] = useFrameStore(props.frameKey, ZusUtils.useShallow((s) => [s.nodeMapStore, s.modified]))
	const rootNodeId = useFrameStore(props.frameKey, s => EditFrame.selectIdByPath(s, []))!
	const allNodeIds = useFrameStore(
		props.frameKey,
		ZusUtils.useShallow(s => Array.from(s.tree.nodes.keys())),
	)

	// leaf nodes & block control panels. we render these flatly for vdom perf and use NodePortal to put them in the right place in the DOM
	// Will have to rework this if we ever want to render multiple portaled elements per node
	const leafNodes = allNodeIds.map((id) => {
		return (
			<NodePortal nodeId={id} store={nodeStore} key={id}>
				<FilterNodeDisplay nodeId={id} frameKey={props.frameKey} />
			</NodePortal>
		)
	})

	const rendered = (
		<div defaultValue="builder" className="w-full space-x-2 flex">
			<div className="flex-1">
				<div className={activeTab === 'builder' ? '' : 'hidden'}>
					<StoredParentNode nodeId={rootNodeId} store={nodeStore} />
				</div>
				<div className={activeTab === 'text' ? '' : 'hidden'}>
					<FilterTextEditor ref={editorRef} frameKey={props.frameKey} />
				</div>
			</div>
			{/* -------- toolbar -------- */}
			<div className="flex flex-col space-y-2">
				<div className="flex items-center space-x-1 justify-end">
					{/* -------- format -------- */}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								onClick={() => editorRef.current?.format()}
								variant="ghost"
								size="icon"
								className={activeTab === 'text' ? '' : 'invisible'}
							>
								<Braces color="hsl(var(--muted-foreground))" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Reformat</p>
						</TooltipContent>
					</Tooltip>

					{/* -------- reset filter -------- */}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button disabled={!modified} onClick={() => getFrameState(props.frameKey).reset()} variant="ghost" size="icon">
								<Undo2 color="hsl(var(--muted-foreground))" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Reset Filter</p>
						</TooltipContent>
					</Tooltip>
				</div>
				<div className="flex items-center space-x-1 justify-end">
					{props.children}
				</div>
				<div className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground">
					<button
						type="button"
						data-state={activeTab === 'text' && 'active'}
						onClick={() => {
							setActiveTab('text')
							editorRef.current!.focus()
						}}
						className={triggerClass}
					>
						Text
					</button>
					<button
						type="button"
						data-state={activeTab === 'builder' && 'active'}
						onClick={() => setActiveTab('builder')}
						className={triggerClass}
					>
						Builder
					</button>
				</div>
			</div>
		</div>
	)

	return <>{rendered} {leafNodes}</>
}

function NegationToggle(props: { frameKey: EditFrame.Key; nodeId: string; node: F.ShallowEditableFilterNode }) {
	const { setNegation } = EditFrame.getNodeActions(props.frameKey, props.nodeId).common
	return (
		<Toggle
			aria-label="negate"
			pressed={props.node.neg}
			onPressedChange={setNegation}
			variant="default"
			className="h-9 px-2 hover:bg-destructive/90 data-[state=on]:bg-destructive data-[state=on]:text-destructive-foreground"
		>
			<EqualNot className="w-4" />
		</Toggle>
	)
}

function FilterNodeDisplay(props: FilterCardProps & { nodeId: string }) {
	const [nodeType, nodeMapStore] = useFrameStore(
		props.frameKey,
		ZusUtils.useShallow(s => [
			s.tree.nodes.get(props.nodeId)?.type,
			s.nodeMapStore,
		]),
	)
	const nodePath = EditFrame.useNodePath(props.frameKey, props.nodeId)
	const immediateChildren = EditFrame.useImmediateChildren(props.frameKey, props.nodeId)
	if (!nodePath) return null
	if (!nodeType) return null

	if (!F.isBlockType(nodeType)) {
		{/* points to LeafFilterNode */}
		return <LeafFilterNode nodeId={props.nodeId} frameKey={props.frameKey} />
	}

	return (
		<NodeWrapper className="filter-node-display relative flex flex-col" path={nodePath} nodeId={props.nodeId}>
			<BlockNodeControlPanel nodeId={props.nodeId} frameKey={props.frameKey} />
			{immediateChildren.map((id) => {
				const dragItem: DND.DragItem = { type: 'filter-node', id }
				return (
					<React.Fragment key={id}>
						<ChildNodeSeparator
							item={{ type: 'relative-to-drag-item', slots: [{ position: 'before', dragItem }] }}
							frameKey={props.frameKey}
						/>
						<StoredParentNode store={nodeMapStore} nodeId={id} />
					</React.Fragment>
				)
			})}
			<ChildNodeSeparator
				item={{ type: 'relative-to-drag-item', slots: [{ position: 'on', dragItem: { id: props.nodeId, type: 'filter-node' } }] }}
				frameKey={props.frameKey}
			/>
		</NodeWrapper>
	)
}

function BlockNodeControlPanel(props: NodeProps) {
	const node = useFrameStore(props.frameKey, s => EditFrame.selectNode(s, props.nodeId)) as F.ShallowEditableFilterNodeOfType<
		F.BlockType
	>
	const nodePath = EditFrame.useNodePath(props.frameKey, props.nodeId)
	if (!F.isBlockType(node.type) || !nodePath) return null
	const isRootNode = nodePath.length === 0
	const actions = EditFrame.getNodeActions(props.frameKey, props.nodeId)
	const { delete: deleteNode } = actions.common
	const { addChild, setBlockType } = actions.block
	return (
		<div className="flex items-center space-x-1">
			<NegationToggle frameKey={props.frameKey} nodeId={props.nodeId} node={node} />
			<ComboBox
				className="w-min"
				title={'Block Type'}
				value={node.type}
				options={['and', 'or']}
				onSelect={(v) => setBlockType(v as F.BlockType)}
			/>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button className="min-h-0" size="icon" variant="outline">
						<Plus />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem onClick={() => addChild('comp')}>comparison</DropdownMenuItem>
					<DropdownMenuItem onClick={() => addChild('apply-filter')}>apply existing filter</DropdownMenuItem>
					<DropdownMenuItem onClick={() => addChild('allow-matchups')}>Allow Matchups</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => addChild('and')}>and block</DropdownMenuItem>
					<DropdownMenuItem onClick={() => addChild('or')}>or block</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{!isRootNode
				&& (
					<Button size="icon" variant="ghost" onClick={deleteNode}>
						<Minus color="hsl(var(--destructive))" />
					</Button>
				)}
		</div>
	)
}

function ChildNodeSeparator(props: {
	// null means we're before the first item in the list
	item: DND.DropItem
	frameKey: EditFrame.Key
}) {
	const dropProps = DndKit.useDroppable(props.item)
	const activeItem = DndKit.useDragging()
	const activePath = EditFrame.useNodePath(props.frameKey, activeItem?.id?.toString()) ?? null
	const slot = props.item.slots[0]
	const itemPath = EditFrame.useNodePath(props.frameKey, slot.dragItem.id?.toString()) ?? null
	let isValid = true
	if (activePath && itemPath) {
		if (activeItem!.type !== 'filter-node') isValid = false
		else if (slot.position !== 'on' && Sparse.isOwnedPath(activePath, itemPath)) isValid = false
	}
	let depth = itemPath?.length ?? 0
	if (props.item.slots[0].position === 'on') {
		depth++
	}

	// WARNING: without this useEffect the component breaks. something fucky must be happening with dndkit or some memoization issue
	React.useEffect(() => {
		console.debug('item', props.item, 'Drop target', dropProps.isDropTarget, 'itemPath', itemPath, 'activePath', activePath)
	}, [dropProps.isDropTarget, itemPath, activePath, props.item])

	return (
		<Separator
			ref={dropProps.ref}
			className={cn(
				Obj.deref('background', depthColors)[depth % depthColors.length],
				'w-full min-w-0 h-1.5 data-[is-over=false]:invisible',
			)}
			data-is-over={dropProps.isDropTarget && isValid}
		/>
	)
}

const NodeWrapper = (
	{ children, className, path, nodeId }: { children: React.ReactNode; className?: string; path: Sparse.NodePath; nodeId: string },
) => {
	const dragItem: DND.DragItem = { type: 'filter-node', id: nodeId }
	const depth = path.length
	const dragProps = DndKit.useDraggable(dragItem, { feedback: 'default' })
	const draggingPlaceholder = <span className="w-[20px] mx-auto">...</span>
	return (
		<div
			ref={dragProps.ref}
			className="bg-background flex space-x-1 min-h-[20px] min-w-[40px] data-[is-dragging=true]:outline rounded-md"
			data-is-dragging={dragProps.isDragging}
		>
			{false ? draggingPlaceholder : (
				<>
					<button
						ref={dragProps.handleRef}
						className={cn(
							Obj.deref('background', depthColors)[depth % depthColors.length],
							'cursor-grab rounded',
							depth === 0 && 'hidden',
						)}
					>
						<Icons.GripVertical />
					</button>
					<div className={className}>
						{children}
					</div>
				</>
			)}
		</div>
	)
}

type NodeProps = { nodeId: string; frameKey: EditFrame.Key }
export function LeafFilterNode(props: NodeProps) {
	const editedFilterId = useFrameStore(props.frameKey, state => state.editedFilterId)
	const node = useFrameStore(props.frameKey, state => EditFrame.selectNode(state, props.nodeId))
	const nodePath = EditFrame.useNodePath(props.frameKey, props.nodeId)!
	if (F.isBlockType(node.type)) return null
	const depth = nodePath.length
	const actions = EditFrame.getNodeActions(props.frameKey, props.nodeId)

	const negationToggle = <NegationToggle frameKey={props.frameKey} nodeId={props.nodeId} node={node} />

	const opCluster = depth > 0 && (
		<>
			<Button
				size="icon"
				variant="ghost"
				onClick={() => {
					actions.common.delete()
				}}
			>
				<Minus color="hsl(var(--destructive))" />
			</Button>
		</>
	)

	if (node.type === 'comp') {
		return (
			<NodeWrapper path={nodePath} className="flex items-center space-x-1" nodeId={props.nodeId}>
				{negationToggle}
				<Comparison
					comp={node.comp!}
					setComp={update => actions.comp.setComp(update)}
					restrictValueSize={false}
				/>
				{opCluster}
			</NodeWrapper>
		)
	}
	if (node.type === 'apply-filter') {
		return (
			<NodeWrapper path={nodePath} className="flex items-center space-x-1" nodeId={props.nodeId}>
				{negationToggle}
				<ApplyFilter
					filterId={node.filterId}
					editedFilterId={editedFilterId}
					setFilterId={id => actions.applyFilter.setFilterId(id)}
				/>
				<Link
					to={AR.link('/filters/:id', node.filterId ?? '')}
					className={cn(!node.filterId ? 'invisible' : '', buttonVariants({ variant: 'ghost', size: 'icon' }), 'font-light')}
				>
					<ExternalLink color="hsl(var(--primary))" />
				</Link>
				{opCluster}
			</NodeWrapper>
		)
	}

	if (node.type === 'allow-matchups') {
		return (
			<NodeWrapper path={nodePath} className="flex items-center space-x-1" nodeId={props.nodeId}>
				{negationToggle}
				<FactionsAllowMatchupsConfig
					masks={node.allowMatchups.allMasks}
					mode={node.allowMatchups.mode}
					setMasks={actions.allowMatchups.setMasks}
					setMode={actions.allowMatchups.setMode}
				/>
				{opCluster}
			</NodeWrapper>
		)
	}
}

export type ComparisonHandle = Clearable & Focusable
export function Comparison(props: {
	comp: F.EditableComparison
	setComp: React.Dispatch<React.SetStateAction<F.EditableComparison>>
	columnEditable?: boolean
	allowedColumns?: string[]
	allowedComparisonCodes?: F.ComparisonCode[]
	restrictValueSize?: boolean
	baseQueryInput?: LQY.BaseQueryInput
	showValueDropdown?: boolean
	lockOnSingleOption?: boolean
	defaultEditing?: boolean
	highlight?: boolean
	columnLabel?: string
	ref?: React.ForwardedRef<ComparisonHandle>
}) {
	const showValueDropdown = props.showValueDropdown ?? true
	const lockOnSingleOption = props.lockOnSingleOption ?? false
	const { comp, setComp } = props
	let { columnEditable } = props
	columnEditable ??= true
	const columnBoxRef = React.useRef<ComboBoxHandle>(null)
	const codeBoxRef = React.useRef<ComboBoxHandle>(null)
	const valueBoxRef = React.useRef<Focusable & Clearable>(null)
	const restrictValueSize = props.restrictValueSize ?? true

	React.useImperativeHandle(props.ref, () => ({
		clear: (ephemeral) => {
			valueBoxRef.current?.clear(ephemeral)
		},
		focus: () => {
			columnBoxRef.current?.focus()
		},
		get isFocused() {
			return columnBoxRef.current?.isFocused || codeBoxRef.current?.isFocused || valueBoxRef.current?.isFocused || false
		},
	}))

	const alreadyOpenedRef = React.useRef(false)
	const cfg = ConfigClient.useEffectiveColConfig()
	React.useEffect(() => {
		if (props.defaultEditing && !columnBoxRef.current!.isFocused && !alreadyOpenedRef.current) {
			columnBoxRef.current?.focus()
			alreadyOpenedRef.current = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const baseCols = cfg ? Object.keys(cfg.defs) : LC.COLUMN_KEYS
	const columnOptions = (props.allowedColumns ? props.allowedColumns.filter((c) => baseCols.includes(c)) : baseCols).map((c) => ({
		value: c,
	}))

	let codeOptions: ComboBoxOption<string>[] = []
	if (comp.column && cfg) {
		const res = F.getComparisonTypesForColumn(comp.column, cfg)
		if (res.code !== 'ok') {
			return <div>{comp.column} {comp.code} : {res.code} : {res.message}</div>
		}
		codeOptions = res.comparisonTypes.map((c) => ({ value: c.code, label: c.displayName }))
	}

	if (props.allowedComparisonCodes) {
		codeOptions = codeOptions.filter((c) => Arr.includes(props.allowedComparisonCodes!, c.value))
	}

	const componentStyles = props.highlight ? 'bg-accent' : undefined

	const columnDef = comp.column ? LC.getColumnDef(comp.column, cfg) : undefined
	const columnBox = columnEditable
		? (
			<ComboBox
				title={props.columnLabel ?? columnDef?.displayName ?? 'Column'}
				className={componentStyles}
				allowEmpty={true}
				value={comp.column}
				options={columnOptions}
				ref={columnBoxRef}
				onSelect={(column) => {
					if (!column) return setComp(() => ({ column: undefined }))
					const colType = F.getColumnTypeWithComposite(column, cfg)
					if (!colType) {
						throw new Error('Unknown column ' + column)
					}
					const defaultComparisonType = F.getDefaultComparison(colType)
					setComp((c) => {
						return { column, code: c.code ?? defaultComparisonType }
					})
					// sleepUntil(() => valueBoxRef.current).then((handle) => {
					// 	return handle?.focus()
					// })
				}}
			/>
		)
		: (
			<span className={cn(buttonVariants({ size: 'default', variant: 'outline' }), 'pointer-events-none', componentStyles)}>
				{props.columnLabel ?? columnDef?.displayName}
			</span>
		)
	if (!comp.column) return columnBox

	const codeBox = (
		<ComboBox
			allowEmpty={true}
			className={componentStyles}
			title=""
			value={comp.code}
			options={codeOptions}
			ref={codeBoxRef}
			onSelect={(_code) => {
				const code = _code as typeof comp.code
				// instead of doing this cringe sleepUntil thing we could buffer events to send to newly created Config components and send them on mount, but I thought of that after coming up with this solution ¯\_(ツ)_/¯. flushSync is also an option but I don't think blocking this event on a react rerender is a good idea
				// if (code !== undefined) {
				// 	sleepUntil(() => valueBoxRef.current).then((handle) => handle?.focus())
				// }
				return setComp((c) => ({ ...c, code: code ?? undefined }))
			}}
		/>
	)

	if (!showValueDropdown) {
		return (
			<>
				{columnBox}
				{codeBox}
			</>
		)
	}

	let valueBox: React.ReactNode = undefined
	switch (comp.code) {
		case 'neq':
		case 'eq': {
			if (comp.column === 'id') {
				valueBox = (
					<LayerEqConfig
						value={comp.value as string | null ?? null}
						setValue={(update) => {
							let value: string | null
							if (typeof update === 'function') {
								value = update(comp.value as string | undefined ?? null)
							} else {
								value = update as string | null
							}
							setComp((c) => ({ ...c, value }))
						}}
						baseQueryInput={props.baseQueryInput}
					/>
				)
			} else {
				valueBox = (
					<StringEqConfig
						ref={valueBoxRef}
						lockOnSingleOption={lockOnSingleOption}
						className={componentStyles}
						column={comp.column as LC.GroupByColumn}
						value={comp.value as string | undefined | null}
						setValue={(value) => {
							return setComp((c) => ({ ...c, value }))
						}}
						baseQueryInput={props.baseQueryInput}
					/>
				)
			}
			break
		}

		case 'notin':
		case 'in': {
			if (comp.column === 'id') {
				valueBox = (
					<LayersInConfig
						values={comp.values ?? []}
						setValues={(update) => {
							if (typeof update === 'function') {
								return setComp((c) => ({ ...c, values: update(c.values ?? []) }))
							}
							return setComp((c) => ({ ...c, values: update }))
						}}
						className={componentStyles}
					/>
				)
			} else {
				valueBox = (
					<StringInConfig
						className={componentStyles}
						ref={valueBoxRef}
						column={comp.column as LC.GroupByColumn}
						restrictValueSize={restrictValueSize}
						values={(comp.values ?? []) as string[]}
						baseQueryInput={props.baseQueryInput}
						setValues={(action) => {
							setComp(
								Im.produce((c) => {
									const values = typeof action === 'function' ? action(c.values ?? []) : action
									c.values = values.length === 0 ? undefined : values
								}),
							)
						}}
					/>
				)
			}
			break
		}
		case 'gt':
		case 'lt': {
			valueBox = (
				<div className="w-[100px]">
					<NumericValueConfig
						ref={valueBoxRef}
						className={componentStyles}
						value={comp.value as number | undefined}
						setValue={(value) => {
							return setComp((c) => ({ ...c, value }))
						}}
					/>
				</div>
			)
			break
		}

		case 'inrange': {
			valueBox = (
				<NumericRangeConfig
					className={componentStyles}
					ref={valueBoxRef}
					range={comp.range ?? [undefined, undefined]}
					setValues={(update) => {
						if (typeof update === 'function') {
							update = update(comp.range ?? [undefined, undefined])
						}
						setComp((c) => ({ ...c, range: update }))
					}}
				/>
			)
			break
		}

		case 'is-true': {
			valueBox = <span />
			break
		}

		case 'isnull': {
			valueBox = <span />
			break
		}

		case 'notnull': {
			valueBox = <span />
			break
		}

		default:
			comp.code satisfies undefined
			valueBox = <span />
	}
	return (
		<>
			{columnBox}
			{codeBox}
			{valueBox}
		</>
	)
}

type ApplyFilterProps = {
	filterId: string | undefined
	setFilterId: (filterId: string) => void
	// the id of the filter entity currently being edited
	editedFilterId?: string
	defaultEditing?: boolean
}

function ApplyFilter(props: ApplyFilterProps) {
	const filters = FilterEntityClient.useFilterEntities()
	const options: ComboBoxOption<string>[] = []
	for (const filter of filters.values()) {
		if (props.editedFilterId && filter.id === props.editedFilterId) continue

		options.push({ label: <FilterEntityLabel filter={filter} />, value: filter.id })
	}
	const boxRef = React.useRef<ComboBoxHandle>(null)
	React.useEffect(() => {
		if (props.defaultEditing) {
			boxRef.current?.focus()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])
	return (
		<>
			<span>Apply</span>
			<ComboBox
				title="Filter"
				options={options}
				allowEmpty={true}
				value={props.filterId}
				onSelect={(v) => {
					return props.setFilterId(v as string)
				}}
			/>
		</>
	)
}

function StringEqConfig<T extends string | null>(
	props: {
		value: T | undefined
		column: LC.GroupByColumn
		setValue: (value: T | undefined) => void
		baseQueryInput?: LQY.BaseQueryInput
		className?: string
		lockOnSingleOption?: boolean
		ref?: React.ForwardedRef<ComboBoxHandle>
	},
) {
	const lockOnSingleOption = props.lockOnSingleOption ?? false
	const valuesRes = useLayerComponent({ ...(props.baseQueryInput ?? {}), column: props.column })
	const options = valuesRes.isSuccess ? Array.isArray(valuesRes.data) ? valuesRes.data : [] : LOADING
	return (
		<ComboBox
			ref={props.ref}
			allowEmpty={true}
			className={props.className}
			title={props.column}
			disabled={valuesRes.isSuccess && lockOnSingleOption && options.length === 1}
			value={(valuesRes.isSuccess && lockOnSingleOption && options.length === 1) ? options[0] : props.value}
			options={options}
			onSelect={(v) => props.setValue(v as T | undefined)}
		/>
	)
}

function StringInConfig(
	props: {
		values: (string | null)[]
		column: LC.GroupByColumn
		setValues: React.Dispatch<React.SetStateAction<(string | null)[]>>
		baseQueryInput?: LQY.BaseQueryInput
		className?: string
		ref?: React.ForwardedRef<ComboBoxHandle>
		restrictValueSize?: boolean
	},
) {
	const valuesRes = useLayerComponent({ ...(props.baseQueryInput ?? {}), column: props.column })
	const options = Array.isArray(valuesRes.data) ? valuesRes.data : []
	return (
		<ComboBoxMulti
			title={props.column}
			ref={props.ref}
			values={props.values}
			options={options}
			onSelect={props.setValues}
			className={props.className}
			restrictValueSize={props.restrictValueSize}
		/>
	)
}

function LayersInConfig(
	props: {
		values: (string | null)[]
		setValues: React.Dispatch<React.SetStateAction<(string | null)[]>>
		className?: string
	},
) {
	const [open, setOpen] = React.useState(false)
	const filteredValues = props.values?.filter(v => v !== null)

	const removeValue = (layerIdToRemove: string) => {
		props.setValues(prevValues => prevValues?.filter(layerId => layerId !== layerIdToRemove) ?? [])
	}

	// TODO implement a useImperativeHandle call
	return (
		<div className={cn(props.className, 'space-y-2')}>
			{filteredValues.length > 0 && (
				<ul className="flex items-center space-x-1">
					{filteredValues.map((layerId) => (
						<li key={layerId} className="flex items-center justify-between px-2 py-1 bg-secondary rounded-md">
							<span className="text-sm">{DH.displayLayer(layerId)}</span>
							<Button
								size="sm"
								variant="ghost"
								onClick={() =>
									removeValue(layerId)}
								className="h-6 w-6 p-0 hover:bg-destructive/20 hover:text-destructive"
							>
								<Minus className="h-3 w-3" />
							</Button>
						</li>
					))}
				</ul>
			)}
			<div className="w-max">
				<SelectLayersDialog
					open={open}
					onOpenChange={setOpen}
					title="Select Layers"
					pinMode="layers"
					defaultSelected={filteredValues}
					selectQueueItems={items => props.setValues(values => Arr.union(values, items.map(items => items.layerId!)))}
				>
					<Button size="sm" variant="outline" onClick={() => setOpen(true)} className="w-full">
						<Icons.Edit className="h-4 w-4 mr-2" />
						{filteredValues.length === 0 ? 'Select Layers' : 'Edit Layers'}
					</Button>
				</SelectLayersDialog>
			</div>
		</div>
	)
}

export function LayerEqConfig(
	props: {
		value: string | null
		setValue: React.Dispatch<React.SetStateAction<string | null>>
		baseQueryInput?: LQY.BaseQueryInput
	},
) {
	const [open, setOpen] = React.useState(false)

	return (
		<div className="flex space-x-2 items-center">
			<EditLayerDialog
				open={open}
				onOpenChange={setOpen}
				layerId={props.value ?? undefined}
				onSelectLayer={(v) => props.setValue(v)}
			>
				<Button className="flex items-center space-x-1" variant="ghost" onClick={() => setOpen(true)}>
					{props.value !== null && DH.displayLayer(props.value)}
					<Icons.Edit />
				</Button>
			</EditLayerDialog>
		</div>
	)
}

function NumericValueConfig(
	props: {
		placeholder?: string
		className?: string
		value?: number
		setValue: (value?: number) => void
		ref?: React.ForwardedRef<Focusable & Clearable>
	},
) {
	const [value, setValue] = React.useState(props.value?.toString() ?? '')
	const inputRef = React.useRef<HTMLInputElement>(null)
	React.useImperativeHandle(props.ref, () => ({
		...eltToFocusable(inputRef.current!),
		clear: (ephemeral) => {
			if (!ephemeral) props.setValue()
			setValue('')
		},
	}))
	return (
		<Input
			ref={inputRef}
			className={props.className}
			placeholder={props.placeholder}
			value={value}
			onChange={(e) => {
				setValue(e.target.value)
				const value = e.target.value.trim()
				// TODO debounce
				return props.setValue(value === '' ? undefined : parseFloat(value))
			}}
		/>
	)
}

function NumericRangeConfig(
	props: {
		range: [number | undefined, number | undefined]
		setValues: React.Dispatch<React.SetStateAction<[number | undefined, number | undefined]>>
		className?: string
		ref?: React.ForwardedRef<Focusable & Clearable>
	},
) {
	function setFirst(value: number | undefined) {
		props.setValues((values) => [value, values[1]])
	}
	function setSecond(value: number | undefined) {
		props.setValues((values) => [values[0], value])
	}
	const secondValueRef = React.useRef<Focusable & Clearable>(null)
	const firstValueRef = React.useRef<Focusable & Clearable>(null)
	React.useImperativeHandle(props.ref, () => ({
		isFocused: false,
		clear: (ephemeral) => {
			firstValueRef.current?.clear(true)
			secondValueRef.current?.clear(true)
			if (!ephemeral) props.setValues([undefined, undefined])
		},
		focus: () => firstValueRef.current?.focus(),
	}))

	return (
		<div className={cn(props.className, 'flex w-[200px] items-center space-x-2')}>
			<NumericValueConfig ref={firstValueRef} value={props.range[0]} setValue={setFirst} />
			<span>to</span>
			<NumericValueConfig ref={secondValueRef} value={props.range[1]} setValue={setSecond} />
		</div>
	)
}

function FactionsAllowMatchupsConfig(props: {
	masks?: F.FactionMask[][]
	setMasks: React.Dispatch<React.SetStateAction<F.FactionMask[][]>>
	mode?: 'split' | 'both' | 'either'
	setMode?: (mode: 'split' | 'both' | 'either') => void
	baseQueryInput?: LQY.BaseQueryInput
	className?: string
	ref?: React.ForwardedRef<Focusable & Clearable>
}) {
	const innerRef = React.useRef<Focusable>(null)
	React.useImperativeHandle(props.ref, () => ({
		clear: (ephemeral) => {
			if (ephemeral) return
			props.setMasks([])
			props.setMode?.('either')
		},
		focus() {
			innerRef.current?.focus()
		},
		get isFocused() {
			return innerRef.current?.isFocused ?? false
		},
	}))

	const masks = props.masks ?? []
	const [isEditOpen, setIsEditOpen] = React.useState(false)

	// Helper function to check if a mask is empty
	function isMaskEmpty(mask: F.FactionMask): boolean {
		return !mask.alliance && !mask.faction && !mask.unit
	}

	// Helper function to clean up empty masks
	function cleanupEmptyMasks() {
		const cleanedMasks = masks.map(team => team.filter(mask => !isMaskEmpty(mask)))
		// Only update if there are changes
		const hasChanges = cleanedMasks.some((team, index) =>
			team.length !== masks[index]?.length
			|| team.some((mask, maskIndex) => mask !== masks[index]?.[maskIndex])
		)
		if (hasChanges) {
			props.setMasks(cleanedMasks.filter(team => team.length > 0))
		}
	}

	// Handle popover close with cleanup
	function handlePopoverOpenChange(open: boolean) {
		if (!open) {
			cleanupEmptyMasks()
		}
		setIsEditOpen(open)
	}

	// Helper function to format mask for display
	function formatMask(mask: F.FactionMask): string {
		const parts = []
		if (mask.alliance && mask.alliance.length > 0) parts.push(mask.alliance.join(', '))
		if (mask.faction && mask.faction.length > 0) parts.push(mask.faction.join(', '))
		if (mask.unit && mask.unit.length > 0) parts.push(mask.unit.join(', '))
		return parts.join(' / ')
	}

	// Helper function to format team for display
	function formatTeam(team: F.FactionMask[]): string {
		if (team.length === 0) return 'No masks'
		return team.map(formatMask).join(', ')
	}

	// Display component
	const DisplayMode = () => (
		<div className={cn(props.className, 'flex items-center space-x-2')}>
			<div className="flex-1 min-w-0">
				<div className="space-y-1">
					<div className="text-sm">
						<span className="font-medium">Allow Matchups:</span> (mode <span className="font-mono">{props.mode ?? 'either'}</span>)
					</div>
					{masks.length === 0
						? <span className="text-sm text-muted-foreground italic">No faction masks configured</span>
						: masks.length === 1
						? <span className="text-sm">{formatTeam(masks[0])}</span>
						: (
							<div className="space-y-1">
								<div className="text-sm">
									<span className="font-medium">Team 1:</span> {formatTeam(masks[0])}
								</div>
								<div className="text-sm">
									<span className="font-medium">Team 2:</span> {formatTeam(masks[1])}
								</div>
							</div>
						)}
				</div>
			</div>
			<Button
				variant="outline"
				size="sm"
				onClick={() => setIsEditOpen(true)}
				className="shrink-0"
			>
				<Icons.Edit />
			</Button>
		</div>
	)

	// Edit component
	const EditMode = () => {
		const currentMode = props.mode ?? 'either'
		const isSplitMode = currentMode === 'split'

		// Helper function to get team masks
		function getTeam1Masks(): F.FactionMask[] | undefined {
			return masks[0]
		}

		function getTeam2Masks(): F.FactionMask[] | undefined {
			return masks[1]
		}

		// Helper function to update team masks
		function updateTeam(teamIndex: 1 | 2, newMasks: React.SetStateAction<F.FactionMask[] | undefined>) {
			props.setMasks(currentMasks => {
				const resolvedNewMasks = typeof newMasks === 'function' ? newMasks(currentMasks?.[teamIndex - 1]) : newMasks

				if (isSplitMode) {
					const newTeams = [...(currentMasks ?? [])]

					if (teamIndex === 1) {
						if (resolvedNewMasks) {
							newTeams[0] = resolvedNewMasks
						} else {
							newTeams.splice(0, 1)
						}
						return newTeams.length > 0 ? newTeams : []
					} else {
						// Ensure team 1 exists
						if (newTeams.length === 0) newTeams.push([])

						if (resolvedNewMasks) {
							newTeams[1] = resolvedNewMasks
						} else if (newTeams.length > 1) {
							newTeams.splice(1, 1)
						}
						return newTeams
					}
				} else if (teamIndex === 1) {
					// Single team mode - just set the masks directly
					return resolvedNewMasks ? [resolvedNewMasks] : []
				}

				return currentMasks
			})
		}

		// Handle mode change
		function handleModeChange(newMode: 'split' | 'both' | 'either') {
			if (props.setMode) {
				props.setMode(newMode)
			}

			if (newMode === 'split') {
				// Split into two teams
				props.setMasks(currentMasks => {
					const team1 = currentMasks?.[0] ?? []
					return [team1, []]
				})
			} else {
				// Merge into one team
				props.setMasks(currentMasks => {
					return [(currentMasks ?? []).flat()]
				})
			}
		}

		const modeSelectId = React.useId()

		return (
			<div className="flex flex-col space-y-4 w-max">
				<div className="flex items-center justify-between">
					<div className="flex items-center space-x-2">
						<Label htmlFor={modeSelectId} className="text-sm font-medium">
							Mode:
						</Label>
						<ComboBox
							allowEmpty={false}
							className="w-32"
							title="Mode"
							value={currentMode}
							options={[
								{ value: 'split', label: 'Split' },
								{ value: 'both', label: 'Both' },
								{ value: 'either', label: 'Either' },
							]}
							onSelect={(v) => handleModeChange(v as 'split' | 'both' | 'either')}
						/>
					</div>
					<div className="flex items-center justify-between">
						<Button
							variant="outline"
							size="sm"
							onClick={() => setIsEditOpen(false)}
						>
							Done
						</Button>
					</div>
				</div>

				{isSplitMode
					? (
						<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
							<div className="space-y-2">
								<h4 className="text-sm font-medium">Team 1</h4>
								<FactionMaskListConfig
									ref={innerRef}
									value={getTeam1Masks()}
									setValue={update => updateTeam(1, update)}
									queryContext={props.baseQueryInput}
									className="w-full"
									onSwitchMaskTeam={(mask, index) => {
										props.setMasks(currentMasks => {
											// Remove from team 1
											const newTeam1 = [...(currentMasks?.[0] ?? [])]
											newTeam1.splice(index, 1)
											// Add to team 2
											const newTeam2 = [...(currentMasks?.[1] ?? []), mask]
											return [newTeam1, newTeam2]
										})
									}}
									showTeamSwitch={isSplitMode}
									currentTeam={1}
								/>
							</div>
							<div className="space-y-2">
								<h4 className="text-sm font-medium">Team 2</h4>
								<FactionMaskListConfig
									value={getTeam2Masks()}
									setValue={update => updateTeam(2, update)}
									queryContext={props.baseQueryInput}
									className="w-full"
									onSwitchMaskTeam={(mask, index) => {
										props.setMasks(currentMasks => {
											// Remove from team 2
											const newTeam2 = [...(currentMasks?.[1] ?? [])]
											newTeam2.splice(index, 1)
											// Add to team 1
											const newTeam1 = [...(currentMasks?.[0] ?? []), mask]
											return [newTeam1, newTeam2]
										})
									}}
									showTeamSwitch={isSplitMode}
									currentTeam={2}
								/>
							</div>
						</div>
					)
					: (
						<div className="space-y-2">
							<FactionMaskListConfig
								value={getTeam1Masks()}
								setValue={update => updateTeam(1, update)}
								queryContext={props.baseQueryInput}
								className="w-full"
							/>
						</div>
					)}
			</div>
		)
	}

	return (
		<Popover open={isEditOpen} onOpenChange={handlePopoverOpenChange}>
			<PopoverTrigger asChild>
				<div>
					<DisplayMode />
				</div>
			</PopoverTrigger>
			<PopoverContent className="w-auto p-4" side="bottom" align="start">
				<EditMode />
			</PopoverContent>
		</Popover>
	)
}

function FactionMaskConfig(props: {
	value: F.FactionMask | undefined
	setValue: React.Dispatch<React.SetStateAction<F.FactionMask | undefined>>
	queryContext?: LQY.BaseQueryInput
	className?: string
	ref?: React.ForwardedRef<Focusable>
}) {
	const responses = {
		alliance1Res: useLayerComponent({ ...(props.queryContext ?? {}), column: 'Alliance_1' }),
		alliance2Res: useLayerComponent({ ...(props.queryContext ?? {}), column: 'Alliance_2' }),
		faction1Res: useLayerComponent({ ...(props.queryContext ?? {}), column: 'Faction_1' }),
		faction2Res: useLayerComponent({ ...(props.queryContext ?? {}), column: 'Faction_2' }),
		unit1Res: useLayerComponent({ ...(props.queryContext ?? {}), column: 'Unit_1' }),
		unit2Res: useLayerComponent({ ...(props.queryContext ?? {}), column: 'Unit_2' }),
	}

	const mask = props.value ?? {}

	const allPopulated = Object.values(responses).every(res => !!res)

	// Get available options from the query context
	const { alliances, factions, units } = React.useMemo(() => {
		const coalesceErrors = (data: ReturnType<typeof useLayerComponent>['data']) => {
			if (!Array.isArray(data)) return []
			return data
		}
		if (!allPopulated) return { alliances: [], factions: [], units: [] }
		return {
			alliances: Arr.union(coalesceErrors(responses.alliance1Res.data), coalesceErrors(responses.alliance2Res.data)),
			factions: Arr.union(coalesceErrors(responses.faction1Res.data), coalesceErrors(responses.faction2Res.data)),
			units: Arr.union(coalesceErrors(responses.unit1Res.data), coalesceErrors(responses.unit2Res.data)),
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...Object.values(responses), allPopulated])

	// Helper function to update the mask
	function updateMask(field: keyof F.FactionMask, update: React.SetStateAction<(string | null)[]>) {
		props.setValue((prev) => {
			const currentValue = prev?.[field] ?? undefined
			let value = typeof update === 'function' ? update(currentValue ?? []) : update
			value = value.filter((v) => v !== null)

			const newPrev = prev ?? {}

			if (value && value.length > 0) {
				return { ...newPrev, [field]: value }
			} else {
				const { [field]: _, ...rest } = newPrev
				return rest
			}
		})
	}

	// Right now we're setting the selectOnClose flag because otherwise the mask selection is slow/will auto-close the dialog due to component remounting. There are probably better solutions.

	return (
		<div className={cn(props.className, 'flex flex-col space-y-2 w-[300px]')}>
			<div className="flex items-center space-x-2">
				<span className="text-sm font-medium min-w-[60px]">Alliance:</span>
				<ComboBoxMulti
					className="flex-1"
					title="Alliance"
					selectOnClose={true}
					values={mask.alliance ?? []}
					options={allPopulated ? alliances : LOADING}
					onSelect={(v) => updateMask('alliance', v as string[])}
				/>
			</div>
			<div className="flex items-center space-x-2">
				<span className="text-sm font-medium min-w-[60px]">Faction:</span>
				<ComboBoxMulti
					className="flex-1"
					title="Faction"
					selectOnClose={true}
					values={mask.faction ?? []}
					options={allPopulated ? factions : LOADING}
					onSelect={(v) => updateMask('faction', v as string[])}
				/>
			</div>
			<div className="flex items-center space-x-2">
				<span className="text-sm font-medium min-w-[60px]">Unit:</span>
				<ComboBoxMulti
					className="flex-1"
					title="Unit"
					selectOnClose={true}
					values={mask.unit ?? []}
					options={allPopulated ? units : LOADING}
					onSelect={(v) => updateMask('unit', v as string[])}
				/>
			</div>
		</div>
	)
}

function FactionMaskListConfig(props: {
	value: F.FactionMask[] | undefined
	setValue: React.Dispatch<React.SetStateAction<F.FactionMask[] | undefined>>
	queryContext?: LQY.BaseQueryInput
	className?: string
	onSwitchMaskTeam?: (mask: F.FactionMask, index: number) => void
	showTeamSwitch?: boolean
	currentTeam?: 1 | 2
	ref?: React.ForwardedRef<Focusable>
}) {
	const maskIds = React.useMemo(() => {
		return props.value?.map(mask => JSON.stringify(mask))
	}, [props.value])
	const masks = props.value ?? []
	function checkNoDuplicates(newMask: F.FactionMask, masks: F.FactionMask[]) {
		newMask = Obj.map(newMask, (value) => value ?? undefined)
		for (let mask of masks) {
			mask = Obj.map(mask, (value) => value ?? undefined)
			if (Obj.deepEqual(mask, newMask)) {
				globalToast$.next({
					variant: 'destructive',
					title: 'Duplicate Faction Mask',
					description: 'A faction mask with the same content already exists.',
				})
				return false
			}
		}
		return true
	}

	function updateMask(index: number, mask: React.SetStateAction<F.FactionMask | undefined>) {
		props.setValue(currentMasks => {
			const newMasks = [...(currentMasks ?? [])]
			const resolvedMask = typeof mask === 'function' ? mask((currentMasks ?? [])[index]) : mask
			if (resolvedMask) {
				if (!checkNoDuplicates(resolvedMask, currentMasks ?? [])) return currentMasks
				newMasks[index] = resolvedMask
			} else {
				newMasks.splice(index, 1)
			}

			if (newMasks.length === 0) {
				return undefined
			} else {
				return newMasks
			}
		})
	}

	// Helper function to add a new mask
	function addMask() {
		if (!checkNoDuplicates({}, masks)) return
		props.setValue([...masks, {}])
	}

	// Helper function to remove a mask
	function removeMask(index: number) {
		const newMasks = masks.filter((_, i) => i !== index)
		if (newMasks.length === 0) {
			props.setValue(undefined)
		} else {
			props.setValue(newMasks)
		}
	}

	return (
		<div className={cn(props.className, 'flex flex-col space-y-3 w-[350px]')}>
			<div className="flex items-center justify-between">
				<span className="text-sm font-medium">Faction Masks</span>
				<Button
					variant="outline"
					size="sm"
					onClick={addMask}
					className="h-8 w-8 p-0"
				>
					<Plus className="h-4 w-4" />
				</Button>
			</div>

			{masks.length === 0
				? (
					<div className="text-sm text-muted-foreground italic">
						No faction masks configured. Click + to add one.
					</div>
				)
				: (
					<div className="space-y-2">
						{masks.map((mask, index) => (
							<div className="flex items-start space-x-2 p-2 border rounded-md" key={maskIds![index]}>
								<div className="flex-1">
									<FactionMaskConfig
										ref={index === 0 ? props.ref : undefined}
										value={mask}
										setValue={(newMask) => updateMask(index, newMask)}
										queryContext={props.queryContext}
										className="w-full"
									/>
								</div>
								<div>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => removeMask(index)}
										className="h-8 w-8 p-0 text-destructive hover:text-destructive"
									>
										<Minus className="h-4 w-4" />
									</Button>
									{props.showTeamSwitch && (
										<Button
											variant="ghost"
											size="sm"
											onClick={() => props.onSwitchMaskTeam?.(mask, index)}
											className="h-6 px-2 text-xs"
											title={`Move to Team ${props.currentTeam === 1 ? 2 : 1}`}
										>
											<Icons.ArrowLeftRight className="h-3 w-3" />
										</Button>
									)}
								</div>
							</div>
						))}
					</div>
				)}
		</div>
	)
}
