import * as EditFrame from '@/frames/filter-editor.frame.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import * as Arr from '@/lib/array.ts'
import * as DH from '@/lib/display-helpers'
import * as Obj from '@/lib/object.ts'
import type { Clearable, Focusable } from '@/lib/react'
import { eltToFocusable } from '@/lib/react'
import * as Sparse from '@/lib/sparse-tree'
import { assertNever } from '@/lib/type-guards.ts'
import { cn } from '@/lib/utils.ts'
import * as ZusUtils from '@/lib/zustand.ts'
import type * as DND from '@/models/dndkit.models.ts'
import * as F from '@/models/filter.models'
import * as LC from '@/models/layer-columns'
import type * as LQY from '@/models/layer-queries.models.ts'
import * as ConfigClient from '@/systems/config.client'
import * as DndKit from '@/systems/dndkit.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { Link } from '@tanstack/react-router'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import { Braces, Columns3, ExternalLink, Minus, Plus, TextCursorInput, Undo2 } from 'lucide-react'
import React from 'react'
import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import type { ComboBoxHandle, ComboBoxOption } from './combo-box/combo-box.tsx'
import ComboBox from './combo-box/combo-box.tsx'
import EditLayerDialog from './edit-layer-dialog.tsx'
import { FilterEntityLabel } from './filter-entity-select.tsx'
import type { FilterTextEditorHandle } from './filter-text-editor.types'
import { NodePortal, StoredParentNode } from './node-map.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import { Button, buttonVariants } from './ui/button'
import { ButtonGroup } from './ui/button-group'
import { Input } from './ui/input'
import { Separator } from './ui/separator.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx'

const FilterTextEditor = React.lazy(() => import('./filter-text-editor'))

const depthColors = [
	{ border: 'border-red-700 dark:border-red-700', background: 'bg-red-500 dark:bg-red-700' },
	{ border: 'border-green-700 dark:border-green-700', background: 'bg-green-500 dark:bg-green-700' },
	{ border: 'border-blue-700 dark:border-blue-700', background: 'bg-blue-500 dark:bg-blue-700' },
	{ border: 'border-yellow-700 dark:border-yellow-700', background: 'bg-yellow-500 dark:bg-yellow-700' },
] satisfies { border: string; background: string }[]

export type FilterCardProps = {
	stores: EditFrame.KeyProp
}

const triggerClass =
	'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm'

// standard compact display for the operator (comparison-type) select: its options are short symbols
// (=, [..], not in), so it gets tight padding, a collapsed chevron gap, and a smaller chevron. px-1 is
// important so container padding rules (e.g. the filter menu grid) can't stretch it back out.
const operatorSelectClass = 'px-1! gap-0.5 [&_svg]:ml-0 [&_svg]:size-3'
export default function FilterCard(props: FilterCardProps & { children: React.ReactNode }) {
	const [activeTab, setActiveTab] = React.useState('builder' as 'builder' | 'text')
	const editorRef = React.useRef<FilterTextEditorHandle>(null)

	DndKit.useDragEnd(React.useCallback(event => {
		if (!event.over) return
		if (event.active.type !== 'filter-node') return
		const editor = ZusUtils.getState(props.stores.filterEditor)
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
		EditFrame.Actions.moveNode(props.stores, sourcePath, targetPath)
	}, [props.stores]))

	const [nodeStore, modified] = ZusUtils.useStore(props.stores.filterEditor, ZusUtils.useShallow((s) => [s.nodeMapStore, s.modified]))
	const rootNodeId = ZusUtils.useStore(props.stores.filterEditor, EditFrame.Sel.idByPath([]))!
	const allNodeIds = ZusUtils.useStore(
		props.stores.filterEditor,
		ZusUtils.useShallow(s => Array.from(s.tree.nodes.keys())),
	)

	// leaf nodes & block control panels. we render these flatly for vdom perf and use NodePortal to put them in the right place in the DOM
	// Will have to rework this if we ever want to render multiple portaled elements per node
	const leafNodes = allNodeIds.map((id) => {
		return (
			<NodePortal nodeId={id} store={nodeStore} key={id}>
				<FilterNodeDisplay nodeId={id} stores={props.stores} />
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
					<React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading editor…</p>}>
						<FilterTextEditor ref={editorRef} stores={props.stores} />
					</React.Suspense>
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
							<Button disabled={!modified} onClick={() => EditFrame.Actions.reset(props.stores)} variant="ghost" size="icon">
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

function FilterNodeDisplay(props: FilterCardProps & { nodeId: string }) {
	const [nodeType, nodeMapStore] = ZusUtils.useStore(
		props.stores.filterEditor,
		ZusUtils.useShallow(s => [
			s.tree.nodes.get(props.nodeId)?.type,
			s.nodeMapStore,
		]),
	)
	const nodePath = ZusUtils.useStore(props.stores.filterEditor, ZusUtils.useShallow(EditFrame.Sel.nodePath(props.nodeId)))
	const immediateChildren = ZusUtils.useStore(
		props.stores.filterEditor,
		ZusUtils.useShallow(EditFrame.Sel.immediateChildren(props.nodeId)),
	)
	if (!nodePath) return null
	if (!nodeType) return null

	if (!F.isBlockType(nodeType)) {
		{/* points to LeafFilterNode */}
		return <LeafFilterNode nodeId={props.nodeId} stores={props.stores} />
	}

	return (
		<NodeWrapper className="filter-node-display relative flex flex-col" path={nodePath} nodeId={props.nodeId}>
			<BlockNodeControlPanel nodeId={props.nodeId} stores={props.stores} />
			{immediateChildren.map((id) => {
				const dragItem: DND.DragItem = { type: 'filter-node', id }
				return (
					<React.Fragment key={id}>
						<ChildNodeSeparator
							item={{ type: 'relative-to-drag-item', slots: [{ position: 'before', dragItem }] }}
							stores={props.stores}
						/>
						<StoredParentNode store={nodeMapStore} nodeId={id} />
					</React.Fragment>
				)
			})}
			<ChildNodeSeparator
				item={{ type: 'relative-to-drag-item', slots: [{ position: 'on', dragItem: { id: props.nodeId, type: 'filter-node' } }] }}
				stores={props.stores}
			/>
		</NodeWrapper>
	)
}

type InlineAddAction = { label: React.ReactNode; onSelect: () => void } | 'separator'

// a "+" button that reveals its actions inline to the right when opened, and collapses once focus
// leaves the widget. replaces a popover/dropdown so a freshly added node's auto-opened editor isn't
// slammed shut by the menu's focus-restore.
function InlineAddButton(props: { actions: InlineAddAction[]; className?: string }) {
	const [expanded, setExpanded] = React.useState(false)
	return (
		<div
			className={cn('flex items-center space-x-1', props.className)}
			onBlur={(e) => {
				// collapse only once focus has left the whole control, not when moving between its buttons
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setExpanded(false)
			}}
		>
			<Button className="min-h-0" size="icon" variant="outline" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
				<Plus />
			</Button>
			{expanded && (
				<div className="flex items-center space-x-1 overflow-x-auto">
					{props.actions.map((action, i) => {
						// actions are a static, non-reordered config; a positional key is stable here
						const key = action === 'separator' ? `sep-${i}` : (typeof action.label === 'string' ? action.label : `action-${i}`)
						if (action === 'separator') return <Separator key={key} orientation="vertical" className="h-6" />
						return (
							<Button
								key={key}
								size="sm"
								variant="outline"
								className="whitespace-nowrap"
								onClick={() => {
									action.onSelect()
									setExpanded(false)
								}}
							>
								{action.label}
							</Button>
						)
					})}
				</div>
			)}
		</div>
	)
}

function BlockNodeControlPanel(props: NodeProps) {
	const node = ZusUtils.useStore(props.stores.filterEditor, EditFrame.Sel.node(props.nodeId)) as F.ShallowEditableFilterNodeOfType<
		F.BlockType
	>
	const nodePath = ZusUtils.useStore(props.stores.filterEditor, ZusUtils.useShallow(EditFrame.Sel.nodePath(props.nodeId)))
	if (!F.isBlockType(node.type) || !nodePath) return null
	const isRootNode = nodePath.length === 0
	const actions = EditFrame.getNodeActions(props.stores, props.nodeId)
	const { delete: deleteNode } = actions.common
	const { addChild, setBlockType } = actions.block
	const blockTypeOptions = F.BLOCK_TYPES.map((t) => ({ value: t, label: F.BLOCK_TYPE_DISPLAY_NAMES[t] }))
	return (
		<div className="flex items-center space-x-1">
			<ComboBox
				className="w-min"
				title="Operator"
				value={node.type}
				options={blockTypeOptions}
				onSelect={(v) => setBlockType(v as F.BlockType)}
			/>
			<InlineAddButton
				actions={[
					{ label: 'comparison', onSelect: () => addChild('eq') },
					{ label: 'matchup', onSelect: () => addChild('allow-matchups') },
					{ label: 'apply existing filter', onSelect: () => addChild('included-in') },
					'separator',
					...F.BLOCK_TYPES.map((t): InlineAddAction => ({
						label: `${F.BLOCK_TYPE_DISPLAY_NAMES[t]} block`,
						onSelect: () => addChild(t),
					})),
				]}
			/>
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
	stores: EditFrame.KeyProp
}) {
	const dropProps = DndKit.useDroppable(props.item)
	const activeItem = DndKit.useDragging()
	const activePath = ZusUtils.useStore(props.stores.filterEditor, ZusUtils.useShallow(EditFrame.Sel.nodePath(activeItem?.id?.toString())))
		?? null
	const slot = props.item.slots[0]
	const itemPath = ZusUtils.useStore(props.stores.filterEditor, ZusUtils.useShallow(EditFrame.Sel.nodePath(slot.dragItem.id?.toString())))
		?? null
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
			className="bg-background flex space-x-1 min-h-[20px] min-w-[40px] data-[is-dragging=true]:outline-solid rounded-md"
			data-is-dragging={dragProps.isDragging}
		>
			{false ? draggingPlaceholder : (
				<>
					<button
						type="button"
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

type NodeProps = { nodeId: string; stores: EditFrame.KeyProp }
export function LeafFilterNode(props: NodeProps) {
	const editedFilterId = ZusUtils.useStore(props.stores.filterEditor, state => state.editedFilterId)
	const node = ZusUtils.useStore(props.stores.filterEditor, EditFrame.Sel.node(props.nodeId))
	const nodePath = ZusUtils.useStore(props.stores.filterEditor, ZusUtils.useShallow(EditFrame.Sel.nodePath(props.nodeId)))!
	if (F.isBlockType(node.type)) return null
	const depth = nodePath.length
	const actions = EditFrame.getNodeActions(props.stores, props.nodeId)

	const opCluster = depth > 0 && (
		<Button
			size="icon"
			variant="ghost"
			onClick={() => {
				actions.common.delete()
			}}
		>
			<Minus color="hsl(var(--destructive))" />
		</Button>
	)

	if (F.isCompNode(node)) {
		return (
			<NodeWrapper path={nodePath} className="flex items-center space-x-1" nodeId={props.nodeId}>
				<CompNodeConfig nodeId={props.nodeId} stores={props.stores} node={node} />
				{opCluster}
			</NodeWrapper>
		)
	}
	if (F.isMatchupNode(node)) {
		return (
			<NodeWrapper path={nodePath} className="flex items-center space-x-1" nodeId={props.nodeId}>
				<MatchupNodeConfig nodeId={props.nodeId} stores={props.stores} node={node} />
				{opCluster}
			</NodeWrapper>
		)
	}
	if (F.isApplyFilterNode(node)) {
		return (
			<NodeWrapper path={nodePath} className="flex items-center space-x-1" nodeId={props.nodeId}>
				<ComboBox
					allowEmpty={false}
					title="mode"
					value={node.type}
					options={F.APPLY_FILTER_TYPES.map((t) => ({ value: t, label: F.APPLY_FILTER_TYPE_DISPLAY_NAMES[t] }))}
					onSelect={(v) => actions.applyFilter.setType(v as F.ApplyFilterType)}
				/>
				<ApplyFilter
					filterId={node.filterId}
					editedFilterId={editedFilterId}
					setFilterId={id => actions.applyFilter.setFilterId(id)}
				/>
				<Link
					to="/filters/$filterId"
					params={{ filterId: node.filterId ?? '' }}
					target="__blank"
					className={cn(!node.filterId ? 'invisible' : '', buttonVariants({ variant: 'ghost', size: 'icon' }), 'font-light')}
				>
					<ExternalLink color="hsl(var(--primary))" />
				</Link>
				{opCluster}
			</NodeWrapper>
		)
	}
	// block nodes are rendered by BlockNodeControlPanel, not here
	return null
}

function CompNodeConfig(props: { nodeId: string; stores: EditFrame.KeyProp; node: F.EditableCompNode }) {
	const actions = EditFrame.getNodeActions(props.stores, props.nodeId)
	return (
		<Comparison
			node={props.node}
			setNode={update => actions.comp.setNode(update)}
			teamColumnsAvailable
			restrictValueSize={false}
		/>
	)
}

export type ComparisonHandle = Clearable & Focusable

// A single comparison node: [anchor column] [operator] [value(s)]. The anchor (args[0]) determines
// the value domain, which in turn drives the operator options and the value editor.
export function Comparison(props: {
	node: F.EditableCompNode
	setNode: React.Dispatch<React.SetStateAction<F.EditableCompNode>>
	columnEditable?: boolean
	teamColumnsAvailable?: boolean
	allowedColumns?: string[]
	restrictValueSize?: boolean
	allowedEnumValues?: string[]
	onSetAllValuesAllowed?: () => void
	onSetAllValuesAllowedLabel?: string
	showValueDropdown?: boolean
	lockOnSingleOption?: boolean
	defaultEditing?: boolean
	highlight?: boolean
	columnLabel?: string
	// overrides the numeric value input's width wrapper (default w-[100px]); used to keep the compact
	// filter menu's range inputs from stretching the whole value column
	numericValueClassName?: string
	ref?: React.ForwardedRef<ComparisonHandle>
	stores?: Partial<SquadServerFrame.KeyProp>
}) {
	const showValueDropdown = props.showValueDropdown ?? true
	const lockOnSingleOption = props.lockOnSingleOption ?? false
	const { node, setNode } = props
	const columnEditable = props.columnEditable ?? true
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

	const cfg = ConfigClient.useEffectiveColConfig()

	const anchor = node.args[0] as F.EditableScalarArg | undefined
	const anchorColumn = anchor?.type === 'column' ? anchor.column : undefined
	const anchorTeamColumn = anchor?.type === 'team-column' ? anchor.column : undefined
	const anchorQuantifier: F.TeamQuantifier = (anchor?.type === 'team-column' ? anchor.quantifier : undefined) ?? 'either'
	// the concrete column used to source enum options / value rendering (team columns resolve to team 1)
	const optionsColumn = anchorColumn ?? (anchorTeamColumn ? F.resolveTeamColumn(anchorTeamColumn, 1) : undefined)
	const domain = anchor ? F.argValueDomain(anchor, cfg) : undefined

	const hasSubject = !!(anchorColumn || anchorTeamColumn)
	// whether the value slot(s) still need input, so we only jump focus forward when there's a blank to fill
	const valueSlotEmpty = ((): boolean => {
		if (node.type === 'in') {
			const valuesArg = node.args[1]
			return ((valuesArg?.type === 'values' ? valuesArg.values : undefined) ?? []).length === 0
		}
		const arg = node.args[1]
		if (!arg) return true
		if (arg.type === 'value') return arg.value === undefined
		if (arg.type === 'column') return !arg.column
		return false
	})()
	// once a subject is chosen with a blank value, focus is handed off to the value editor (or, for numeric
	// subjects, the operator select) -- and only then do we suppress a closing select's focus-restore.
	// Otherwise (no subject, or value already filled) the good behavior is the normal restore.
	const handOffFocusToValue = hasSubject && valueSlotEmpty

	// pending auto-focus for a user selection. `advance` opens the lowest empty argument (subject, then first
	// empty value slot); `operator` opens the operator select. Queued on selection, consumed once the target
	// editor has mounted (see the effect below). The initial subject-open is handled separately on mount.
	const [focusRequest, setFocusRequest] = React.useState<'advance' | 'operator' | null>(null)

	// team-generic columns are encoded as `team:<quantifier>:<column>` so the either/both choice lives
	// directly in the column select rather than a separate dropdown
	const TEAM_PREFIX = 'team:'
	const teamColumnValue = (column: F.TeamColumn, quantifier: F.TeamQuantifier) => `${TEAM_PREFIX}${quantifier}:${column}`
	const baseCols = cfg ? Object.keys(cfg.defs) : LC.COLUMN_KEYS
	const allowedBaseCols = props.allowedColumns ? props.allowedColumns.filter((c) => baseCols.includes(c)) : baseCols
	const baseOption = (c: string): ComboBoxOption<string> & { label: string } => ({
		value: c,
		label: LC.getColumnDef(c, cfg)?.displayName ?? c,
	})
	const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label)

	// team columns are kept together at the top: each family (Alliance/Faction/Unit) in order
	// (T1, T2, Both, Either). the concrete T1/T2 columns are pulled out of the alphabetical list into
	// their family group. because the order is bespoke, the column select opts out of ComboBox's default
	// label sort (sort={false}).
	let columnOptions: ComboBoxOption<string>[]
	if (props.teamColumnsAvailable) {
		const teamBaseCols = new Set(F.TEAM_COLUMNS.flatMap((tc) => [F.resolveTeamColumn(tc, 1), F.resolveTeamColumn(tc, 2)]))
		// label the concrete T1/T2 columns consistently within the group (some base display names, e.g.
		// Faction's, omit the family prefix) so the four variants read uniformly
		const teamGroup = F.TEAM_COLUMNS.flatMap((tc): ComboBoxOption<string>[] => [
			...(allowedBaseCols.includes(F.resolveTeamColumn(tc, 1)) ? [{ value: F.resolveTeamColumn(tc, 1), label: `${tc} T1` }] : []),
			...(allowedBaseCols.includes(F.resolveTeamColumn(tc, 2)) ? [{ value: F.resolveTeamColumn(tc, 2), label: `${tc} T2` }] : []),
			{ value: teamColumnValue(tc, 'both'), label: `${tc} (Both)` },
			{ value: teamColumnValue(tc, 'either'), label: `${tc} (Either)` },
		])
		const rest = allowedBaseCols.filter((c) => !teamBaseCols.has(c)).map(baseOption).sort(byLabel)
		columnOptions = [...teamGroup, ...rest]
	} else {
		columnOptions = allowedBaseCols.map(baseOption).sort(byLabel)
	}

	const currentColumnValue = anchorTeamColumn ? teamColumnValue(anchorTeamColumn, anchorQuantifier) : anchorColumn

	// reshape the node's args for a newly selected anchor, keeping the operator if the new domain supports it
	function selectAnchor(newAnchor: F.EditableScalarArg) {
		const newDomain = F.argValueDomain(newAnchor, cfg)
		setNode((c) => {
			const keepOp = newDomain ? F.domainSupportsCompType(newDomain, c.type) : true
			const type = keepOp ? c.type : F.defaultCompType(newDomain)
			const neg = keepOp ? c.neg : false
			const slots = F.COMP_TYPE_DEFS[type].argSlots
			const args = slots.map((slot, i): F.EditableArg => i === 0 ? newAnchor : (slot === 'values' ? { type: 'values' } : { type: 'value' }))
			return { type, neg, args }
		})
	}

	const columnDef = optionsColumn ? LC.getColumnDef(optionsColumn, cfg) : undefined
	const componentStyles = props.highlight ? 'bg-accent' : undefined

	const columnBox = columnEditable
		? (
			<ComboBox
				title={props.columnLabel ?? columnDef?.displayName ?? 'Column'}
				className={componentStyles}
				allowEmpty
				value={currentColumnValue}
				options={columnOptions}
				// options are pre-ordered (team families grouped, rest alphabetical); keep that order
				sort={false}
				ref={columnBoxRef}
				// selecting a column always resets and reopens the next argument, so hand focus onward on
				// selection (ComboBox still restores focus on a plain dismiss)
				preventCloseAutoFocus
				onSelect={(value) => {
					if (!value) return setNode(() => ({ type: 'eq', neg: false, args: [{ type: 'column' }, { type: 'value' }] }))
					if (value.startsWith(TEAM_PREFIX)) {
						const [quantifier, column] = value.slice(TEAM_PREFIX.length).split(':') as [F.TeamQuantifier, F.TeamColumn]
						// changing only the quantifier on the same column keeps the operator and value(s)
						if (column === anchorTeamColumn) {
							setNode(Im.produce((c) => {
								if (c.args[0]?.type === 'team-column') c.args[0].quantifier = quantifier
							}))
							return
						}
						selectAnchor({ type: 'team-column', column, quantifier })
						// team columns are enum-domained, so advance straight to the value
						setFocusRequest('advance')
						return
					}
					const newAnchor: F.EditableScalarArg = { type: 'column', column: value }
					selectAnchor(newAnchor)
					// numeric subjects: the operator matters (eq/lt/gt/inrange), so send focus to the operator
					// select; everything else advances straight to the value
					const newDomain = F.argValueDomain(newAnchor, cfg)
					setFocusRequest(newDomain?.kind === 'number' ? 'operator' : 'advance')
				}}
			/>
		)
		: (
			<span className={cn(buttonVariants({ size: 'default', variant: 'outline' }), 'pointer-events-none', componentStyles)}>
				{props.columnLabel ?? columnDef?.displayName}
			</span>
		)
	// operator options come from the subject's domain once one is set, otherwise the full set is offered
	const opOptions = F.compOpSelectOptions(domain)
	const codeBox = (
		<ComboBox
			allowEmpty={false}
			className={cn(operatorSelectClass, componentStyles)}
			title="Operator"
			value={F.compOpSelectionKey(node)}
			options={opOptions.map((o) => ({ value: o.key, label: o.label }))}
			ref={codeBoxRef}
			// like the subject, hand focus onward to the value editor once an operator is picked
			preventCloseAutoFocus={handOffFocusToValue}
			onSelect={(key) => {
				const option = opOptions.find((o) => o.key === key)
				if (!option) return
				setNode((c) => {
					const next = F.applyCompOpSelection(c, option)
					// a float's eq only compares against null, so seed the value as null
					if (F.isFloatEqNullOnly(domain, next.type)) return { ...next, args: [next.args[0], { type: 'value', value: null }] }
					return next
				})
				// advance to the lowest empty argument (the value slot); no-ops if the operator kept a value
				setFocusRequest('advance')
			}}
		/>
	)

	// -------- auto-focus flow --------
	// open the subject picker for a freshly created (subject-less) comparison. Deferred to the next frame and
	// cancelled on unmount: leaf nodes are portaled and remount when the portal re-targets from its hidden
	// placeholder to the real container (see node-map.tsx), so a synchronous open races that remount -- the
	// placeholder mount's frame is cancelled when it unmounts, and only the stable mount's frame fires.
	React.useEffect(() => {
		if (!(columnEditable && (props.defaultEditing || !hasSubject))) return
		const raf = requestAnimationFrame(() => columnBoxRef.current?.focus())
		return () => cancelAnimationFrame(raf)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// consume a queued focus request once the relevant editor has mounted for the current node state
	React.useEffect(() => {
		if (!focusRequest) return
		if (focusRequest === 'operator') {
			codeBoxRef.current?.focus()
		} else {
			// advance to the lowest empty argument: the subject if unset, else the first empty value slot
			if (!hasSubject) columnBoxRef.current?.focus()
			else if (valueSlotEmpty) valueBoxRef.current?.focus()
		}
		setFocusRequest(null)
	}, [focusRequest, hasSubject, valueSlotEmpty])

	// -------- value editor(s) --------
	const setSlotValue = (index: number, value: F.Value | undefined) =>
		setNode(Im.produce((c) => {
			c.args[index] = { type: 'value', value }
		}))

	// a scalar value slot may instead reference another column of the same value domain (column-vs-column).
	// offered only in the full editor, not the locked filter menu.
	const allowColumnOperand = columnEditable && !!domain
	const comparableColumnOptions = (): ComboBoxOption<string>[] => {
		const cols = cfg ? Object.keys(cfg.defs) : LC.COLUMN_KEYS
		return cols
			.filter((c) => {
				const d = F.columnValueDomain(c, cfg)
				return d && domain && F.domainsCompatible(d, domain)
			})
			.map((c) => ({ value: c, label: LC.getColumnDef(c, cfg)?.displayName ?? c }))
	}
	// segmented control to pick whether a slot compares against a constant value or another column
	const operandKindSelector = (index: number, isColumn: boolean) => {
		if (!allowColumnOperand) return null
		const setKind = (kind: 'value' | 'column') =>
			setNode(Im.produce((c) => {
				// no-op if already that kind, so re-picking the active segment preserves the current value
				if (c.args[index]?.type !== kind) c.args[index] = { type: kind }
			}))
		return (
			<ButtonGroup>
				<Button
					size="icon"
					variant={!isColumn ? 'secondary' : 'ghost'}
					title="Compare to a constant value"
					onClick={() => setKind('value')}
				>
					<TextCursorInput className="h-4 w-4" />
				</Button>
				<Button
					size="icon"
					variant={isColumn ? 'secondary' : 'ghost'}
					title="Compare to another column"
					onClick={() => setKind('column')}
				>
					<Columns3 className="h-4 w-4" />
				</Button>
			</ButtonGroup>
		)
	}

	// enum columns surface null as a "(none)" option in their own value dropdown, so the generic
	// null affordance (chip + toggle) is only for non-enum columns
	const enumSubject = domain?.kind === 'enum'
	// button to set a slot to null (IS NULL) / clear it back to an empty constant; only for `eq`, where
	// null is meaningful. On floats, eq is null-only so the value is fixed to null (no toggle).
	const nullToggle = (index: number, isNull: boolean) =>
		(columnEditable && node.type === 'eq' && !enumSubject && !F.isFloatEqNullOnly(domain, node.type))
			? (
				<Button
					size="icon"
					variant={isNull ? 'secondary' : 'ghost'}
					title={isNull ? 'Clear null' : 'Compare to null'}
					onClick={() =>
						setNode(Im.produce((c) => {
							c.args[index] = { type: 'value', value: isNull ? undefined : null }
						}))}
				>
					<Icons.Ban className="h-4 w-4" />
				</Button>
			)
			: null

	// renders the editor for a single scalar value slot: a column picker when it references a column,
	// a "null" indicator when the value is null, otherwise a constant editor chosen by the anchor's domain
	const scalarSlot = (index: number, ref?: React.Ref<Focusable & Clearable>): React.ReactNode => {
		const arg = node.args[index]
		const isNullValue = arg?.type === 'value' && arg.value === null
		if (arg?.type === 'column') {
			return (
				<div className="flex items-center space-x-1">
					{operandKindSelector(index, true)}
					<ComboBox
						allowEmpty
						className={componentStyles}
						title="Column"
						value={arg.column}
						options={comparableColumnOptions()}
						onSelect={(v) =>
							setNode(Im.produce((c) => {
								c.args[index] = { type: 'column', column: v || undefined }
							}))}
					/>
					{nullToggle(index, false)}
				</div>
			)
		}
		// a float eq only compares against null; render a static null indicator plus a "?" explaining why
		if (F.isFloatEqNullOnly(domain, node.type)) {
			return (
				<div className="flex items-center space-x-1">
					<span className={cn(buttonVariants({ variant: 'outline' }), 'pointer-events-none', componentStyles)}>null</span>
					<Tooltip>
						<TooltipTrigger asChild>
							<button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Why only null?">
								<Icons.CircleHelp className="h-4 w-4" />
							</button>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs">
							<p>
								This column holds decimal (floating-point) values, which can't be matched with exact equality. Tiny rounding differences
								make <code>=</code> unreliable, so use a range (<code>[..]</code>) or <code>&lt;</code>/<code>&gt;</code>{' '}
								to compare magnitudes; <code>=</code> only checks whether the value is null.
							</p>
						</TooltipContent>
					</Tooltip>
				</div>
			)
		}
		// enum columns render null via their own "(none)" dropdown option, not the generic chip
		if (isNullValue && !enumSubject) {
			return (
				<div className="flex items-center space-x-1">
					{operandKindSelector(index, false)}
					<span className={cn(buttonVariants({ variant: 'outline' }), 'pointer-events-none', componentStyles)}>null</span>
					{nullToggle(index, true)}
				</div>
			)
		}
		const value = arg?.type === 'value' ? arg.value : undefined
		const withToggle = (editor: React.ReactNode) => (
			<div className="flex items-center space-x-1">
				{operandKindSelector(index, false)}
				{editor}
				{nullToggle(index, false)}
			</div>
		)
		if (optionsColumn === 'id') {
			return withToggle(
				<LayerEqConfig
					value={(value as string | null) ?? null}
					stores={props.stores}
					setValue={(update) => {
						const v = typeof update === 'function' ? update((value as string | null) ?? null) : update
						setSlotValue(index, v)
					}}
				/>,
			)
		}
		if (!domain || domain.kind === 'enum' || domain.kind === 'string') {
			return withToggle(
				<StringEqConfig
					ref={ref as React.ForwardedRef<ComboBoxHandle>}
					lockOnSingleOption={lockOnSingleOption}
					className={componentStyles}
					allowedValues={props.allowedEnumValues}
					onSetAllValuesAllowed={props.onSetAllValuesAllowed}
					onSetAllValuesAllowedLabel={props.onSetAllValuesAllowedLabel}
					column={optionsColumn as LC.GroupByColumn}
					value={value as string | undefined | null}
					setValue={(v) => setSlotValue(index, v)}
				/>,
			)
		}
		if (domain.kind === 'boolean') {
			return withToggle(
				<ComboBox
					allowEmpty
					className={componentStyles}
					title="value"
					value={value === undefined || value === null ? undefined : String(value)}
					options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]}
					onSelect={(v) => setSlotValue(index, v === undefined ? undefined : v === 'true')}
				/>,
			)
		}
		// number
		return withToggle(
			<div className={cn('w-[100px]', props.numericValueClassName)}>
				<NumericValueConfig
					ref={ref as React.ForwardedRef<Focusable & Clearable>}
					className={componentStyles}
					value={value as number | undefined}
					setValue={(v) => setSlotValue(index, v)}
				/>
			</div>,
		)
	}

	// value editors need a subject to source their domain, so they only appear once one is chosen
	let valueBox: React.ReactNode = null
	if (hasSubject && showValueDropdown) {
		if (node.type === 'in') {
			const valuesArg = node.args[1]
			const items = (valuesArg?.type === 'values' ? valuesArg.values : undefined) ?? []
			const setItems = (update: React.SetStateAction<F.InListItem[]>) =>
				setNode(Im.produce((c) => {
					const prev = (c.args[1]?.type === 'values' ? c.args[1].values : undefined) ?? []
					const next = typeof update === 'function' ? update(prev) : update
					c.args[1] = { type: 'values', values: next.length === 0 ? undefined : next }
				}))
			if (optionsColumn === 'id') {
				// layer-id lists are constant-only (there is only one id column)
				const setValues = (update: React.SetStateAction<(string | null)[]>) =>
					setItems((prev) => {
						const primitives = prev.filter((i) => !F.isColumnListItem(i)) as (string | null)[]
						return typeof update === 'function' ? update(primitives) : update
					})
				valueBox = (
					<LayersInConfig
						values={items.filter((i) => !F.isColumnListItem(i)) as (string | null)[]}
						setValues={setValues}
						className={componentStyles}
					/>
				)
			} else {
				valueBox = (
					<InListConfig
						className={componentStyles}
						ref={valueBoxRef as React.ForwardedRef<ComboBoxHandle>}
						column={optionsColumn as LC.GroupByColumn}
						allowedEnumValues={props.allowedEnumValues}
						restrictValueSize={restrictValueSize}
						items={items}
						setItems={setItems}
						comparableColumns={comparableColumnOptions()}
						allowColumns={columnEditable}
					/>
				)
			}
		} else if (node.type === 'inrange') {
			valueBox = (
				<div className="flex items-center space-x-2">
					{scalarSlot(1, valueBoxRef)}
					<span>to</span>
					{scalarSlot(2)}
				</div>
			)
		} else {
			valueBox = scalarSlot(1, valueBoxRef)
		}
	}

	// infix order: subject, operator (in the middle), then value(s)
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
}

function ApplyFilter(props: ApplyFilterProps) {
	const filters = FilterEntityClient.useFilterEntities()
	const options = React.useMemo(() => {
		const options: ComboBoxOption<string>[] = []
		for (const filter of filters.values()) {
			if (props.editedFilterId && filter.id === props.editedFilterId) continue

			options.push({ label: <FilterEntityLabel filter={filter} />, value: filter.id })
		}
		return options
	}, [filters, props.editedFilterId])
	const boxRef = React.useRef<ComboBoxHandle>(null)
	// auto-open the filter picker for a freshly added (filter-less) node, mirroring how a new comparison
	// opens its column picker. rAF + cancel avoids a race with the portal remount (see node-map.tsx).
	React.useEffect(() => {
		if (props.filterId) return
		const raf = requestAnimationFrame(() => boxRef.current?.focus())
		return () => cancelAnimationFrame(raf)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])
	return (
		<ComboBox
			ref={boxRef}
			title="Filter"
			options={options}
			allowEmpty
			value={props.filterId}
			onSelect={(v) => {
				return props.setFilterId(v as string)
			}}
		/>
	)
}

export function StringEqConfig<T extends string | null>(
	props: {
		value: T | undefined
		column: LC.GroupByColumn
		allowedValues?: T[]
		onSetAllValuesAllowed?: () => void
		onSetAllValuesAllowedLabel?: string
		setValue: (value: T | undefined) => void
		className?: string
		lockOnSingleOption?: boolean
		ref?: React.ForwardedRef<ComboBoxHandle>
	},
) {
	const lockOnSingleOption = props.lockOnSingleOption ?? false
	// keep the callback identity out of the options memo -- parents often pass a fresh closure each render
	const onSetAllValuesAllowedRef = React.useRef(props.onSetAllValuesAllowed)
	onSetAllValuesAllowedRef.current = props.onSetAllValuesAllowed
	const hasUnlockAction = !!props.onSetAllValuesAllowed
	const options = React.useMemo(() => {
		const allowedSet = props.allowedValues ? new Set(props.allowedValues) : null
		const options: ComboBoxOption<string | null>[] = []
		for (const value of LC.groupByColumnDefaultValues(props.column)) {
			const matched = allowedSet?.has(value as T) ?? true
			// null is a real enum value for some columns (e.g. LayerVersion "no version"); surface it
			if (value === null) {
				options.push({ label: '(none)', value: null, disabled: !matched && !hasUnlockAction })
				continue
			}
			let label: React.ReactNode
			if (!matched && hasUnlockAction) {
				label = (
					<span
						className="flex items-center gap-1 group w-full"
						onClick={(e) => {
							if (e.target !== e.currentTarget) return
							e.stopPropagation()
						}}
					>
						<span className="text-muted-foreground pointer-events-none">{value}</span>
						<span title={props.onSetAllValuesAllowedLabel ?? 'deselect all other filters and select this one'}>
							<Icons.Unlock
								className="h-3 w-3 opacity-0 group-hover:opacity-100 cursor-pointer text-green-500 pointer-events-auto"
								onClick={() => {
									onSetAllValuesAllowedRef.current?.()
								}}
							/>
						</span>
					</span>
				)
			} else {
				label = value
			}
			options.push({ label, value, disabled: !matched && !hasUnlockAction })
		}
		return options
	}, [props.column, props.allowedValues, hasUnlockAction, props.onSetAllValuesAllowedLabel])
	return (
		<ComboBox
			ref={props.ref}
			allowEmpty
			className={props.className}
			title={LC.getColumnDef(props.column)?.displayName ?? props.column}
			disabled={lockOnSingleOption && options.length === 1}
			value={(lockOnSingleOption && options.length === 1) ? options[0].value : props.value}
			options={options}
			onSelect={(v) => props.setValue(v as T | undefined)}
		/>
	)
}

function StringInConfig(
	props: {
		values: (string | null)[]
		column: LC.GroupByColumn
		allowedValues?: (string | null)[]
		setValues: React.Dispatch<React.SetStateAction<(string | null)[]>>
		className?: string
		ref?: React.ForwardedRef<ComboBoxHandle>
		restrictValueSize?: boolean
		// matchup dimensions title themselves by dimension ('Faction'), not by the underlying column ('T1')
		title?: string
		emptyLabel?: string
	},
) {
	const options = React.useMemo(() => {
		const allowedSet = props.allowedValues ? new Set(props.allowedValues) : null
		const options: ComboBoxOption<string | null>[] = []
		for (const value of LC.groupByColumnDefaultValues(props.column)) {
			const matched = allowedSet?.has(value) ?? true
			if (value === null) {
				options.push({ label: '(none)', value: null, disabled: !matched })
				continue
			}
			options.push({ label: value, value, disabled: !matched })
		}
		return options
	}, [props.column, props.allowedValues])
	return (
		<ComboBoxMulti
			title={props.title ?? LC.getColumnDef(props.column)?.displayName ?? props.column}
			emptyLabel={props.emptyLabel}
			ref={props.ref}
			values={props.values}
			options={options}
			onSelect={props.setValues}
			className={props.className}
			restrictValueSize={props.restrictValueSize}
		/>
	)
}

// One side of a matchup: a multi-select per team dimension. Empty means "any", so the placeholder says
// so rather than prompting for a selection -- an unfilled dimension is a real choice here, not a
// half-finished one.
function TeamSpecConfig(props: {
	label: string
	spec: F.MatchupTeamSpec
	setValues: (column: F.TeamColumn, values: F.Value[]) => void
}) {
	return (
		<div className="flex flex-col space-y-1 rounded border border-dashed px-2 py-1.5">
			<span className="text-xs font-semibold text-muted-foreground">{props.label}</span>
			{F.TEAM_COLUMNS.map((teamColumn) => (
				<StringInConfig
					key={teamColumn}
					title={teamColumn}
					emptyLabel={`any ${teamColumn.toLowerCase()}`}
					// a floor, not a fixed width: the three dimensions line up when empty, but a filled one
					// grows to its selection (all four alliances need ~270px) instead of truncating at 180.
					// restrictValueSize still caps it at 400px, so a big faction selection can't run away
					className="min-w-[180px]"
					restrictValueSize
					// both teams' columns share an enum mapping, so team 1's value list serves either side
					column={F.resolveTeamColumn(teamColumn, 1) as LC.GroupByColumn}
					values={(props.spec[teamColumn] ?? []) as (string | null)[]}
					setValues={(update) => {
						const prev = (props.spec[teamColumn] ?? []) as (string | null)[]
						const next = typeof update === 'function' ? update(prev) : update
						props.setValues(teamColumn, next as F.Value[])
					}}
				/>
			))}
		</div>
	)
}

function MatchupNodeConfig(props: { nodeId: string; stores: EditFrame.KeyProp; node: F.EditableMatchupNode }) {
	const node = props.node
	const actions = EditFrame.getNodeActions(props.stores, props.nodeId).matchup
	// unlocked, the specs are not pinned to the _1/_2 columns, so naming them "Team 1"/"Team 2" would
	// misdescribe what the node matches. "Team A"/"Team B" are not available either: those already mean
	// the normalized teams that persist across the team1/team2 swap (see MH.NormedTeamId and the
	// displayTeamsNormalized setting), which is a different idea entirely -- and that setting toggles
	// between those very labels, so reusing them here would read as driving it.
	const [leftLabel, rightLabel] = node.locked ? ['Team 1', 'Team 2'] : ['One side', 'Other side']
	return (
		<div className="flex items-center space-x-2">
			<ComboBox
				allowEmpty={false}
				className="w-min"
				title="Operator"
				value={node.type}
				options={F.MATCHUP_TYPES.map((t) => ({ value: t, label: F.MATCHUP_TYPE_DISPLAY_NAMES[t] }))}
				onSelect={(v) => actions.setType(v as F.MatchupType)}
			/>
			<TeamSpecConfig label={leftLabel} spec={node.teams[0]} setValues={(col, values) => actions.setTeamValues(0, col, values)} />
			<div className="flex flex-col items-center space-y-1">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button size="icon" variant="ghost" onClick={() => actions.swapTeams()}>
							<Icons.ArrowLeftRight />
						</Button>
					</TooltipTrigger>
					<TooltipContent>Swap the two sides</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							variant={node.locked ? 'secondary' : 'ghost'}
							aria-pressed={node.locked}
							onClick={() => actions.setLocked(!node.locked)}
						>
							{node.locked ? <Icons.Lock /> : <Icons.LockOpen />}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{node.locked
							? 'Team order locked: matches only as configured, left on team 1 and right on team 2. Click to allow either order.'
							: 'Either team order matches: the two sides are interchangeable. Click to lock them to team 1 and team 2.'}
					</TooltipContent>
				</Tooltip>
				<span className="whitespace-nowrap text-[10px] text-muted-foreground">
					{node.locked ? 'order locked' : 'either order'}
				</span>
			</div>
			<TeamSpecConfig label={rightLabel} spec={node.teams[1]} setValues={(col, values) => actions.setTeamValues(1, col, values)} />
		</div>
	)
}

// value list for an `in` operator: a constant multi-select plus (in the editor) removable column references
function InListConfig(
	props: {
		items: F.InListItem[]
		setItems: (update: React.SetStateAction<F.InListItem[]>) => void
		column: LC.GroupByColumn
		allowedEnumValues?: string[]
		comparableColumns: ComboBoxOption<string>[]
		allowColumns: boolean
		restrictValueSize?: boolean
		className?: string
		ref?: React.ForwardedRef<ComboBoxHandle>
	},
) {
	const cfg = ConfigClient.useEffectiveColConfig()
	const primitives = props.items.filter((i) => !F.isColumnListItem(i)) as (string | null)[]
	const columns = props.items.filter(F.isColumnListItem)

	const setPrimitives: React.Dispatch<React.SetStateAction<(string | null)[]>> = (update) =>
		props.setItems((prev) => {
			const prevPrimitives = prev.filter((i) => !F.isColumnListItem(i)) as (string | null)[]
			const prevColumns = prev.filter(F.isColumnListItem)
			const next = typeof update === 'function' ? update(prevPrimitives) : update
			return [...next, ...prevColumns]
		})
	const addColumn = (column: string) =>
		props.setItems((prev) => prev.some((i) => F.isColumnListItem(i) && i.column === column) ? prev : [...prev, { type: 'column', column }])
	const removeColumn = (column: string) => props.setItems((prev) => prev.filter((i) => !(F.isColumnListItem(i) && i.column === column)))

	const addableColumns = props.comparableColumns.filter((o) => !columns.some((c) => c.column === o.value))

	return (
		<div className={cn(props.className, 'flex items-center space-x-1')}>
			<StringInConfig
				ref={props.ref}
				column={props.column}
				allowedValues={props.allowedEnumValues}
				restrictValueSize={props.restrictValueSize}
				values={primitives}
				setValues={setPrimitives}
			/>
			{columns.map((c) => (
				<span key={c.column} className="flex items-center px-2 py-1 bg-secondary rounded-md text-sm">
					{LC.getColumnDef(c.column, cfg)?.displayName ?? c.column}
					<button type="button" onClick={() => removeColumn(c.column)} className="ml-1">
						<Icons.X className="h-3 w-3" />
					</button>
				</span>
			))}
			{props.allowColumns && addableColumns.length > 0 && (
				<ComboBox
					allowEmpty
					title="Column"
					placeholder="+ column"
					value={undefined}
					options={addableColumns}
					onSelect={(v) => v && addColumn(v)}
				/>
			)}
		</div>
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
		stores?: Partial<SquadServerFrame.KeyProp>
	},
) {
	const [open, setOpen] = React.useState(false)

	return (
		<div className="flex space-x-2 items-center">
			<Button className="flex items-center space-x-1" variant="ghost" onClick={() => setOpen(true)}>
				{props.value !== null && DH.displayLayer(props.value)}
				<Icons.Edit />
			</Button>
			<EditLayerDialog
				open={open}
				onOpenChange={setOpen}
				layerId={props.value ?? undefined}
				onSelectLayer={(v) => props.setValue(v)}
				stores={props.stores}
			/>
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
