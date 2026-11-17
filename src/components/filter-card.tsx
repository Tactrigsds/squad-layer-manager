import { Link } from '@tanstack/react-router'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import { Braces, Columns3, ExternalLink, Minus, Plus, RotateCcw, TextCursorInput } from 'lucide-react'
import React from 'react'

import * as EditFrame from '@/frames/filter-editor.frame.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import * as Arr from '@/lib/array-utils'
import * as Obj from '@/lib/object-utils'
import type { Clearable, Focusable } from '@/lib/react'
import { eltToFocusable } from '@/lib/react'
import { assertNever } from '@/lib/type-guards.ts'
import { useDebounced } from '@/lib/use-debounce'
import { useDebouncedCommit } from '@/lib/use-debounced-commit'
import { cn } from '@/lib/utils.ts'
import * as Zus from '@/lib/zustand.ts'
import * as F_Msgs from '@/messages/filter.messages'
import * as I18n from '@/messages/i18n'
import * as LC_Msgs from '@/messages/layer-columns.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import type * as DND from '@/models/dndkit.models.ts'
import * as EFB from '@/models/editable-filter-builders.models'
import * as F from '@/models/filter.models'
import * as LC from '@/models/layer-columns.models'
import type * as LQY from '@/models/layer-queries.models'
import * as L from '@/models/layer.models'
import * as ConfigClient from '@/systems/config.client'
import * as DndKit from '@/systems/dndkit.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as KBClient from '@/systems/keybinds.client'
import { tr } from '@/systems/messages.client'

import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import type { ComboBoxHandle, ComboBoxOption } from './combo-box/combo-box.tsx'
import ComboBox from './combo-box/combo-box.tsx'
import type { ComboBoxGroupingDef } from './combo-box/options.ts'
import { enumGroupings, enumOptionGroups } from './enum-options.helpers.ts'
import { FilterEntityLabel } from './filter-entity-select.tsx'
import type { FilterTextEditorHandle } from './filter-text-editor.types'
import { NodePortal, StoredParentNode } from './node-map.tsx'
import { RichText } from './rich-text.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import ShortLayerName from './short-layer-name.tsx'
import { Button, buttonVariants } from './ui/button'
import { ButtonGroup } from './ui/button-group'
import { Input } from './ui/input'
import TabsList from './ui/tabs-list.tsx'
import { Textarea } from './ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx'
import { UndoRedoButtons } from './undo-redo-buttons'

const FilterTextEditor = React.lazy(() => import('./filter-text-editor'))

const depthColors = [
	{ border: 'border-danger dark:border-danger', background: 'bg-danger dark:bg-red-700' },
	{ border: 'border-ok dark:border-ok', background: 'bg-ok dark:bg-ok' },
	{ border: 'border-info dark:border-info', background: 'bg-blue-500 dark:bg-info' },
	{ border: 'border-warn dark:border-warn', background: 'bg-yellow-500 dark:bg-yellow-700' },
] satisfies { border: string; background: string }[]

export type FilterCardProps = {
	stores: EditFrame.KeyProp
}

// standard compact display for the operator (comparison-type) select: its options are short symbols
// (=, [..], not in), so it gets tight padding, a collapsed chevron gap, and a smaller chevron. px-1 is
// important so container padding rules (e.g. the filter menu grid) can't stretch it back out.
const operatorSelectClass = 'px-1! gap-0.5 [&_svg]:ms-0 [&_svg]:size-3'
// `builderOnly` drops the text mode and the toolbar, for a filter edited as one field of a larger form.
// `header` is laid out beside the toolbar, so the editor below it gets the full width.
export default function FilterCard(
	props: FilterCardProps & ({ children: React.ReactNode; header?: React.ReactNode; builderOnly?: false } | { builderOnly: true }),
) {
	const activeTab = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.view)
	const setActiveTab = (view: EditFrame.View) => EditFrame.Actions.setView(props.stores, view)
	const scopeId = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.scopeId)
	const editorRef = React.useRef<FilterTextEditorHandle>(null)
	const kbScope = KBClient.useScope('filter-editor', {})

	DndKit.useDragEnd((event) => {
		if (!event.over) return
		if (event.active.type !== 'filter-node') return
		const tree = Zus.getState(props.stores.filterEditor).tree
		const slot = event.over.slots.find((s) => s.dragItem.type === 'filter-node')
		if (!slot) return
		const slotId = slot.dragItem.id.toString()
		// every card on the page hears every drop, so a drag that started or landed in another card is not this one's
		if (!tree.nodes.has(event.active.id) || !tree.nodes.has(slotId)) return

		let parentId: string
		let index: number
		switch (slot.position) {
			case 'before':
			case 'after': {
				const slotParentId = tree.parents.get(slotId)
				if (slotParentId === undefined) return
				parentId = slotParentId
				index = tree.children.get(parentId)!.indexOf(slotId) + (slot.position === 'after' ? 1 : 0)
				break
			}
			case 'on':
				parentId = slotId
				index = tree.children.get(slotId)?.length ?? 0
				break
			default:
				assertNever(slot.position)
		}

		if (F.isWithin(tree, parentId, event.active.id)) {
			console.warn('Cannot move node to its own child')
			return
		}
		EditFrame.Actions.moveNode(props.stores, event.active.id, parentId, index)
	})

	const [nodeStore, modified, editingNodeId] = Zus.useStore(
		props.stores.filterEditor,
		Zus.useShallow((s) => [s.nodeMapStore, s.modified, s.editingNodeId] as const),
	)
	const [undoKind, redoKind] = Zus.useStore(
		props.stores.filterEditor,
		Zus.useShallow((s) => [EditFrame.Sel.undoEntry(s)?.kind ?? null, EditFrame.Sel.redoEntry(s)?.kind ?? null] as const),
	)

	// Escape returns the open node to its compact form. It listens on the document because clicking a
	// compact row destroys the button that was focused, leaving focus on the body; a popover or dialog
	// gets the key first, so the first press dismisses that and the second closes the editor.
	React.useEffect(() => {
		if (!editingNodeId) return
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Escape' || e.defaultPrevented) return
			if ((e.target as Element | null)?.closest('[data-radix-popper-content-wrapper],[role="dialog"]')) return
			EditFrame.Actions.setNodeEditing(props.stores, null)
		}
		document.addEventListener('keydown', onKeyDown)
		return () => document.removeEventListener('keydown', onKeyDown)
	}, [editingNodeId, props.stores])
	const rootNodeId = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.rootId)
	const allNodeIds = Zus.useStore(
		props.stores.filterEditor,
		Zus.useShallow((s) => Array.from(s.tree.nodes.keys())),
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

	if (props.builderOnly) {
		return (
			<>
				<div className="w-full min-w-0 overflow-x-auto" data-filter-tree={scopeId}>
					<StoredParentNode nodeId={rootNodeId} store={nodeStore} />
				</div>
				{leafNodes}
			</>
		)
	}

	const rendered = (
		<div ref={kbScope.ref} className="flex w-full flex-col gap-2">
			<div className="flex w-full gap-2">
				<div className="flex min-w-0 flex-1 flex-col gap-2">{props.header}</div>
				{/* -------- toolbar -------- */}
				<div className="flex flex-col space-y-2">
					<div className="flex items-center space-x-1 justify-end">
						{/* -------- format -------- */}
						<Tooltip help>
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
								<p>{tr.text(F_Msgs.reformat())}</p>
							</TooltipContent>
						</Tooltip>

						<UndoRedoButtons
							size="icon"
							undo={{
								description: undoKind && tr.text(F_Msgs.undoTooltip('undo', undoKind)),
								onClick: () => EditFrame.Actions.undo(props.stores),
							}}
							redo={{
								description: redoKind && tr.text(F_Msgs.undoTooltip('redo', redoKind)),
								onClick: () => EditFrame.Actions.redo(props.stores),
							}}
						/>

						{/* -------- reset filter -------- */}
						<Tooltip help>
							<TooltipTrigger asChild>
								<Button disabled={!modified} onClick={() => EditFrame.Actions.reset(props.stores)} variant="ghost" size="icon">
									<RotateCcw className="rtl:-scale-x-100" color="hsl(var(--muted-foreground))" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								<p>{tr.text(F_Msgs.resetFilter())}</p>
							</TooltipContent>
						</Tooltip>
					</div>
					<div className="flex items-center space-x-1 justify-end">{props.children}</div>
					<TabsList
						className="self-end"
						options={[
							{ value: 'text', label: tr.text(F_Msgs.textTab()) },
							{ value: 'builder', label: tr.text(F_Msgs.builderTab()) },
						]}
						active={activeTab}
						setActive={(tab) => {
							setActiveTab(tab)
							if (tab === 'text') editorRef.current!.focus()
						}}
					/>
				</div>
			</div>
			<div className="w-full min-w-0 overflow-x-auto">
				<div className={activeTab === 'builder' ? '' : 'hidden'} data-filter-tree={scopeId}>
					<StoredParentNode nodeId={rootNodeId} store={nodeStore} />
				</div>
				<div className={activeTab === 'text' ? '' : 'hidden'}>
					<React.Suspense fallback={<p className="text-sm text-muted-foreground">{tr.text(F_Msgs.loadingEditor())}</p>}>
						<FilterTextEditor ref={editorRef} stores={props.stores} active={activeTab === 'text'} />
					</React.Suspense>
				</div>
			</div>
		</div>
	)

	// the leaf nodes are portalled into the tree, so the scope reaches them through context rather than the DOM
	return (
		<KBClient.Context.Provider value={kbScope.id}>
			{rendered} {leafNodes}
		</KBClient.Context.Provider>
	)
}

function FilterNodeDisplay(props: FilterCardProps & { nodeId: string }) {
	const [nodeType, nodeMapStore] = Zus.useStore(
		props.stores.filterEditor,
		Zus.useShallow((s) => [s.tree.nodes.get(props.nodeId)?.type, s.nodeMapStore]),
	)
	const depth = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.depth(props.nodeId))
	const immediateChildren = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.children(props.nodeId))
	if (depth === undefined) return null
	if (!nodeType) return null

	if (!F.isBlockType(nodeType)) {
		{
			/* points to LeafFilterNode */
		}
		return <LeafFilterNode nodeId={props.nodeId} stores={props.stores} />
	}

	return (
		<NodeWrapper className="filter-node-display relative flex flex-col" depth={depth} nodeId={props.nodeId} stores={props.stores}>
			<BlockNodeControlPanel nodeId={props.nodeId} stores={props.stores} />
			{immediateChildren.map((id, index) => {
				const dragItem: DND.DragItem = { type: 'filter-node', id }
				return (
					<React.Fragment key={id}>
						<ChildNodeSeparator
							item={{ type: 'relative-to-drag-item', slots: [{ position: 'before', dragItem }] }}
							parentId={props.nodeId}
							index={index}
							stores={props.stores}
						/>
						<StoredParentNode store={nodeMapStore} nodeId={id} />
					</React.Fragment>
				)
			})}
			<ChildNodeSeparator
				item={{ type: 'relative-to-drag-item', slots: [{ position: 'on', dragItem: { id: props.nodeId, type: 'filter-node' } }] }}
				parentId={props.nodeId}
				index={immediateChildren.length}
				stores={props.stores}
			/>
		</NodeWrapper>
	)
}

// the grouping that sections the add menu and the subject picker
const SUBJECT_GROUPING = 'subject'
const BLOCK_GROUP = 'block'

// The kinds of node that are not a comparison on a column, as the add menu and the node kind pickers offer them.
// Their values are prefixed so they cannot collide with a column name.
const NODE_KIND_PREFIX = 'node:'
type NodeSeed = { node: F.EditableFilterNode; hint?: EditFrame.CreateHint }
type NodeKindEntry = { label: () => string; description?: () => string; group: string; seed: () => NodeSeed }
const NODE_KIND_ENTRIES: Record<string, NodeKindEntry> = {
	...Object.fromEntries(
		F.BLOCK_TYPES.map((type): [string, NodeKindEntry] => [
			type,
			{
				label: () => tr.text(F_Msgs.blockTypeNames[type]),
				description: () => tr.text(F_Msgs.blockTypeDescriptions[type]),
				group: BLOCK_GROUP,
				seed: () => ({ node: EFB.nodeOfType(type) }),
			},
		]),
	),
	...Object.fromEntries(
		F.APPLY_FILTER_TYPES.map((type): [string, NodeKindEntry] => [
			type,
			{
				label: () => tr.text(F_Msgs.applyFilterKindNames[type]),
				description: () => tr.text(F_Msgs.applyFilterTypeDescriptions[type]),
				group: BLOCK_GROUP,
				seed: () => ({ node: EFB.nodeOfType(type) }),
			},
		]),
	),
	'select-layers': {
		label: () => tr.text(F_Msgs.selectLayers()),
		group: 'layer',
		seed: () => ({ node: EFB.inValues('id'), hint: { autoOpenLayers: true } }),
	},
	...Object.fromEntries(
		F.MATCHUP_TYPES.map((type): [string, NodeKindEntry] => [
			type,
			{ label: () => tr.text(F_Msgs.matchupTypeNames[type]), group: 'faction', seed: () => ({ node: EFB.nodeOfType(type) }) },
		]),
	),
}

// `blocksOnly` is for the root, which stays a block
function nodeKindEntryOptions(blocksOnly = false): ComboBoxOption<string>[] {
	return Object.entries(NODE_KIND_ENTRIES)
		.filter(([key]) => !blocksOnly || F.isBlockType(key))
		.map(([key, entry]) => ({
			value: NODE_KIND_PREFIX + key,
			label: entry.label(),
			description: entry.description?.(),
			groups: { [SUBJECT_GROUPING]: entry.group },
		}))
}

function nodeKindOptions(cfg: ColConfig, blocksOnly = false): ComboBoxOption<string>[] {
	if (blocksOnly) return nodeKindEntryOptions(true)
	return [...nodeKindEntryOptions(), ...subjectColumnOptions(cfg, true)]
}

function seedForKind(value: string, cfg: ColConfig): NodeSeed {
	if (value.startsWith(NODE_KIND_PREFIX)) return NODE_KIND_ENTRIES[value.slice(NODE_KIND_PREFIX.length)].seed()
	const subject = parseSubjectValue(value)
	const domain = F.argValueDomain(subject, cfg ?? undefined)
	const group = F.subjectArgGroup(subject)
	// a layer column is as often excluded as included, so its operator is chosen first, like a number's
	const focus = domain?.kind === 'number' || group === 'layer' ? 'operator' : 'values'
	return { node: EFB.forSubject(subject, domain), hint: { group, focus } }
}

// the option a node kind picker shows as selected for `node`
function nodeKindValue(node: F.ShallowEditableFilterNode): string | undefined {
	if (F.isBlockType(node.type) || F.isApplyFilterType(node.type) || F.isMatchupType(node.type)) return NODE_KIND_PREFIX + node.type
	if (!F.isCompNode(node)) return undefined
	const subject = (node as F.EditableCompNode).args[0] as F.EditableScalarArg | undefined
	if (subject?.type === 'column' && subject.column === 'id') return NODE_KIND_PREFIX + 'select-layers'
	if (subject?.type === 'team-column' && subject.column) return teamColumnValue(subject.column, subject.quantifier ?? 'either')
	return subject?.type === 'column' ? subject.column : undefined
}

function nodeKindGroup(value: string | undefined): string | undefined {
	if (!value) return undefined
	if (value.startsWith(NODE_KIND_PREFIX)) return NODE_KIND_ENTRIES[value.slice(NODE_KIND_PREFIX.length)]?.group
	return F.subjectArgGroup(parseSubjectValue(value))
}

// Picks what kind of node an existing node is, converting it on a change (see EditFrame.Actions.convertNode).
// A comparison's column picker does the same job for comparisons, so this is for every other kind of node.
function NodeKindPicker(props: NodeProps & { node: F.ShallowEditableFilterNode; blocksOnly?: boolean }) {
	const cfg = ConfigClient.useEffectiveColConfig()
	const value = nodeKindValue(props.node)
	const group = nodeKindGroup(value)
	return (
		<ComboBox
			className="w-min"
			title={tr.text(F_Msgs.nodeKindPicker())}
			value={value}
			options={nodeKindOptions(cfg, props.blocksOnly)}
			sort={false}
			groupings={subjectGroupings()}
			defaultGroups={group ? SUBJECT_GROUP_SELECTIONS[group] : undefined}
			renderGroupPrefix={false}
			preventCloseAutoFocus
			onSelect={(next) => {
				if (!next || next === value) return
				const seed = seedForKind(next, cfg)
				EditFrame.Actions.convertNode(props.stores, props.nodeId, seed.node, seed.hint)
			}}
		/>
	)
}

// The add menu: a sectioned picker of every kind of node a block can hold. The block's own add button and the
// insert points between its children share it and differ only in where the new node lands.
function AddNodeComboBox(props: {
	actions: EditFrame.BlockNodeActions
	index?: number
	trigger: React.ReactElement
	autoOpen?: boolean
	onOpenChange?: (open: boolean) => void
}) {
	const cfg = ConfigClient.useEffectiveColConfig()
	return (
		<ComboBox
			title={tr.text(F_Msgs.addCondition())}
			value={undefined}
			options={nodeKindOptions(cfg)}
			sort={false}
			groupings={subjectGroupings()}
			renderGroupPrefix={false}
			// the new node's editor takes focus as it mounts, which the trigger must not take back
			preventCloseAutoFocus
			autoOpen={props.autoOpen}
			onOpenChange={props.onOpenChange}
			onSelect={(value) => {
				if (value) {
					const seed = seedForKind(value, cfg)
					props.actions.addSeeded(seed.node, seed.hint, props.index)
				}
				props.onOpenChange?.(false)
			}}
		>
			{props.trigger}
		</ComboBox>
	)
}

function InlineAddButton(props: { actions: EditFrame.BlockNodeActions; compact?: boolean }) {
	return (
		<AddNodeComboBox
			actions={props.actions}
			trigger={
				<Button
					className={cn('min-h-0', props.compact && 'size-6 [&_svg]:size-3.5')}
					size="icon"
					variant="outline"
					aria-label={tr.text(F_Msgs.addCondition())}
				>
					<Plus />
				</Button>
			}
		/>
	)
}

function BlockNodeControlPanel(props: NodeProps) {
	const node = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.node(props.nodeId)) as F.ShallowEditableFilterNodeOfType<F.BlockType>
	const depth = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.depth(props.nodeId))
	const editing = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.nodeEditing(props.nodeId))
	if (!F.isBlockType(node.type) || depth === undefined) return null
	const isRootNode = depth === 0
	const actions = EditFrame.getNodeActions(props.stores, props.nodeId)
	const { delete: deleteNode } = actions.common
	const opCluster = (
		<>
			<CommentButton nodeId={props.nodeId} stores={props.stores} />
			{!isRootNode && (
				<>
					<DuplicateButton onClick={actions.common.duplicate} />
					<Button size="icon" variant="ghost" aria-label={tr.text(F_Msgs.removeNode())} onClick={deleteNode}>
						<Minus color="hsl(var(--destructive))" />
					</Button>
				</>
			)}
		</>
	)

	// the add button stays put in both modes: an empty block whose only way forward is hidden is a dead end
	if (!editing) {
		return (
			<div className="group/row flex items-center space-x-1">
				<NodeSummaryButton onClick={() => actions.common.setEditing(true)}>
					<NodeSummary node={node} />
				</NodeSummaryButton>
				<NodeErrorMark nodeId={props.nodeId} stores={props.stores} />
				<InlineAddButton compact actions={actions.block} />
				<CompactOpCluster>{opCluster}</CompactOpCluster>
			</div>
		)
	}

	return (
		<div className="flex items-center space-x-1">
			<NodeKindPicker nodeId={props.nodeId} stores={props.stores} node={node} blocksOnly={isRootNode} />
			<NodeErrorMark nodeId={props.nodeId} stores={props.stores} />
			<InlineAddButton actions={actions.block} />
			{opCluster}
			<DoneButton onClick={() => actions.common.setEditing(false)} />
		</div>
	)
}

// The gap between two children: a drop target during a drag, and otherwise a place to add a node at
// that exact position rather than at the end of the block. It grows while a drag is in flight, since
// aiming at 6px of dead space is the hard part of reordering.
function ChildNodeSeparator(props: {
	// null means we're before the first item in the list
	item: DND.DropItem
	parentId: string
	index: number
	stores: EditFrame.KeyProp
}) {
	const dropProps = DndKit.useDroppable(props.item)
	// dnd-kit re-renders only on the fields read before its first layout effect, so read this before any branch
	const isDropTarget = dropProps.isDropTarget
	const activeItem = DndKit.useDragging()
	const [expanded, setExpanded] = React.useState(false)
	const slot = props.item.slots[0]
	const slotId = slot.dragItem.id?.toString()
	const activeNodeId = activeItem?.type === 'filter-node' ? activeItem.id : undefined
	const slotWithinActive = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.isWithin(slotId, activeNodeId))
	const isValid = slot.position === 'on' || !slotWithinActive
	const slotDepth = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.depth(slotId)) ?? 0
	const depth = slot.position === 'on' ? slotDepth + 1 : slotDepth

	if (expanded) {
		return (
			<div className="flex min-w-0 items-center py-1">
				<AddNodeComboBox
					actions={EditFrame.getNodeActions(props.stores, props.parentId).block}
					index={props.index}
					autoOpen
					onOpenChange={(open) => !open && setExpanded(false)}
					trigger={
						<Button size="icon" variant="outline" className="size-6 [&_svg]:size-3.5" aria-label={tr.text(F_Msgs.insertCondition())}>
							<Plus />
						</Button>
					}
				/>
			</div>
		)
	}

	const dragging = !!activeItem
	return (
		<div className="relative h-3 w-full min-w-0">
			<button
				type="button"
				ref={dropProps.ref}
				aria-label={tr.text(F_Msgs.insertCondition())}
				onClick={() => setExpanded(true)}
				data-is-over={isDropTarget && isValid}
				className={cn(
					'group absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center gap-1',
					// while dragging the target grows over the rows either side rather than pushing them apart,
					// which would move the row the pointer is already aiming at.
					dragging ? 'h-7' : 'h-3',
				)}
			>
				<Plus className={cn('size-3 shrink-0 text-muted-foreground opacity-0', !dragging && 'group-hover:opacity-100')} />
				<span
					className={cn(
						Obj.deref('background', depthColors)[depth % depthColors.length],
						'h-1.5 w-full min-w-0 rounded-full transition-opacity',
						// dim while dragging so every landing spot is visible, solid once this one is the target
						dragging ? 'opacity-30' : 'opacity-0 group-hover:opacity-60',
						'group-data-[is-over=true]:opacity-100',
					)}
				/>
			</button>
		</div>
	)
}

const NodeWrapper = ({
	children,
	className,
	narrowGrip,
	depth,
	nodeId,
	stores,
}: {
	children: React.ReactNode
	className?: string
	// a leaf node's compact row is barely taller than the full grip is wide, so leaf nodes take a narrow grip in
	// both their compact and editing forms, which keeps the row from shifting as it opens
	narrowGrip?: boolean
	depth: number
	nodeId: string
	stores: EditFrame.KeyProp
}) => {
	const dragItem: DND.DragItem = { type: 'filter-node', id: nodeId }
	const dragProps = DndKit.useDraggable(dragItem, { feedback: 'default' })
	const invalid = Zus.useStore(stores.filterEditor, EditFrame.Sel.nodeErrors(nodeId)).length > 0
	const draggingPlaceholder = <span className="w-[20px] mx-auto">...</span>
	return (
		// data-filter-node-id is how EditFrame.Actions.revealNode finds the node
		<div
			ref={dragProps.ref}
			className={cn(
				'bg-background flex space-x-1 min-h-[20px] min-w-[40px] data-[is-dragging=true]:outline-solid rounded-md',
				invalid && 'bg-destructive/10 ring-1 ring-inset ring-destructive/60',
			)}
			data-is-dragging={dragProps.isDragging}
			data-filter-node-id={nodeId}
			data-node-invalid={invalid || undefined}
		>
			{false ? (
				draggingPlaceholder
			) : (
				<>
					<button
						type="button"
						ref={dragProps.handleRef}
						className={cn(
							Obj.deref('background', depthColors)[depth % depthColors.length],
							'cursor-grab rounded',
							narrowGrip && 'w-3 [&_svg]:size-3',
							depth === 0 && 'hidden',
						)}
					>
						<Icons.GripVertical />
					</button>
					<div className="flex min-w-0 flex-1 flex-col">
						<NodeComment nodeId={nodeId} stores={stores} />
						<div className={cn('min-w-0', className)}>{children}</div>
					</div>
				</>
			)}
		</div>
	)
}

type NodeProps = { nodeId: string; stores: EditFrame.KeyProp }

// how much of a comment survives the collapsed view. whitespace is flattened first so the preview is
// one line regardless of how the comment was written
const COMMENT_PREVIEW_LENGTH = 160

function NodeComment(props: NodeProps) {
	const [comment, edited] = Zus.useStore(
		props.stores.filterEditor,
		Zus.useShallow((s) => [EditFrame.Sel.comment(props.nodeId)(s), EditFrame.Sel.commentEdited(props.nodeId)(s)] as const),
	)
	const [expanded, setExpanded] = React.useState(false)
	const setComment = React.useCallback(
		(value: string) => EditFrame.Actions.setNodeComment(props.stores, props.nodeId, value),
		[props.stores, props.nodeId],
	)
	const setCommentDebounced = useDebounced({ delay: 250, onChange: setComment })

	if (edited) {
		return (
			<Textarea
				aria-label={tr.text(F_Msgs.nodeComment())}
				autoFocus
				rows={3}
				maxLength={F.NODE_COMMENT_MAX_LENGTH}
				placeholder={tr.text(F_Msgs.nodeCommentPlaceholder())}
				defaultValue={comment ?? ''}
				className="my-1 text-xs"
				onChange={(e) => setCommentDebounced(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') e.currentTarget.blur()
				}}
				onBlur={(e) => {
					setComment(e.target.value)
					EditFrame.Actions.setCommentEdited(props.stores, props.nodeId, false)
				}}
			/>
		)
	}

	if (!comment) return null

	const flattened = comment.replace(/\s+/g, ' ')
	const truncated = flattened.length > COMMENT_PREVIEW_LENGTH
	const collapsed = truncated && !expanded

	return (
		<div className="my-1 flex items-start gap-1 border-s-2 border-muted ps-2 text-xs text-muted-foreground">
			<RichText
				text={collapsed ? flattened : comment}
				maxLength={collapsed ? COMMENT_PREVIEW_LENGTH : undefined}
				className={cn('min-w-0', collapsed && 'whitespace-normal')}
			/>
			{truncated && (
				<button type="button" className="shrink-0 underline" onClick={() => setExpanded((v) => !v)}>
					{expanded ? 'less' : 'more'}
				</button>
			)}
		</div>
	)
}

function CommentButton(props: NodeProps) {
	const [hasComment, edited] = Zus.useStore(
		props.stores.filterEditor,
		Zus.useShallow((s) => [!!EditFrame.Sel.comment(props.nodeId)(s), EditFrame.Sel.commentEdited(props.nodeId)(s)] as const),
	)
	const label = tr.text(hasComment ? UI_Msgs.editComment() : UI_Msgs.addComment())
	return (
		<Tooltip help>
			<TooltipTrigger asChild>
				<Button
					size="icon"
					variant="ghost"
					aria-label={label}
					aria-pressed={edited}
					onClick={() => EditFrame.Actions.setCommentEdited(props.stores, props.nodeId, !edited)}
				>
					<Icons.MessageSquareText color={hasComment ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))'} />
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				<p>{label}</p>
			</TooltipContent>
		</Tooltip>
	)
}

// on a block this copies the whole subtree, and the copy lands directly below the original
function DuplicateButton(props: { onClick: () => void }) {
	const label = tr.text(F_Msgs.duplicateNode())
	return (
		<Tooltip help>
			<TooltipTrigger asChild>
				<Button size="icon" variant="ghost" aria-label={label} onClick={props.onClick}>
					<Icons.Copy color="hsl(var(--muted-foreground))" />
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				<p>{label}</p>
			</TooltipContent>
		</Tooltip>
	)
}

// -------- the compact node view --------

// A node reads as one line until it is the node being edited. Values carry the emphasis: a filter is read
// by scanning for them, where today every part of a node is a control of equal weight.

type ColConfig = LQY.EffectiveColumnAndTableConfig | undefined

function columnLabel(column: string | undefined, cfg: ColConfig) {
	if (!column) return undefined
	const def = LC.getColumnDef(column, cfg)
	return def ? tr.text(LC_Msgs.columnName(def)) : column
}

function valueText(value: F.Value) {
	return value === null ? tr.text(F_Msgs.nullValue()) : String(value)
}

// Each part carries the space that follows it. A flex gap is not whitespace, so a row laid out with one
// reads as "Gamemode=RAAS" when it is copied or read aloud; the trailing space at the end of a row
// collapses in inline flow, so nothing shows for it.
function ValueChip(props: { children: React.ReactNode; invalid?: boolean }) {
	return (
		<span
			data-invalid={props.invalid || undefined}
			className={cn('rounded-sm bg-muted px-1 py-px font-mono text-xs text-foreground', props.invalid && INVALID_PART_CLASS)}
		>
			{props.children}
		</span>
	)
}

// the red treatment of a column, value or filter that an error names, in the compact view and in the pickers
const INVALID_PART_CLASS =
	'bg-destructive/15 text-destructive outline-1 outline-destructive/60 underline decoration-wavy decoration-destructive underline-offset-3'
const INVALID_PICKER_CLASS = 'border-destructive ring-1 ring-destructive/60'

function OpWord(props: { children: React.ReactNode }) {
	return <span className="text-muted-foreground">{props.children}</span>
}

function ColumnWord(props: { children: React.ReactNode; invalid?: boolean }) {
	return (
		<span
			data-invalid={props.invalid || undefined}
			className={cn('font-medium', props.invalid && cn('rounded-sm px-1', INVALID_PART_CLASS))}
		>
			{props.children}
		</span>
	)
}

function Incomplete() {
	return <span className="italic text-muted-foreground">{tr.text(F_Msgs.incompleteNode())}</span>
}

const trSummary = tr.withTags({
	op: (chunks) => <OpWord>{chunks}</OpWord>,
	value: (chunks) => <ValueChip>{chunks}</ValueChip>,
})

type Marks = EditFrame.NodeMarks | undefined

function valueMarked(value: F.Value, marks: Marks) {
	return value !== null && !!marks?.values.has(String(value))
}

// a team column is stored without its side, and its errors name the sided column it lowered to
function teamColumnMarked(column: F.TeamColumn, marks: Marks) {
	return !!marks && (marks.columns.has(F.resolveTeamColumn(column, 1)) || marks.columns.has(F.resolveTeamColumn(column, 2)))
}

// the items of a summary's run of values, separated the way the locale separates a list read aloud as one unit
function ValueRun(props: { items: React.ReactNode[] }) {
	return I18n.nodeList(props.items, tr.locale, { type: 'unit', style: 'narrow' })
}

function SubjectSummary(props: { arg: F.EditableScalarArg | undefined; cfg: ColConfig; marks: Marks }) {
	const arg = props.arg
	if (arg?.type === 'team-column' && arg.column) {
		const quantifier = tr.text(F_Msgs.teamQuantifierNames[arg.quantifier ?? 'either'])
		return (
			<ColumnWord invalid={teamColumnMarked(arg.column, props.marks)}>
				{tr.text(F_Msgs.teamColumnQuantified(tr.text(F_Msgs.teamColumnNames[arg.column]), quantifier))}
			</ColumnWord>
		)
	}
	const label = arg?.type === 'column' ? columnLabel(arg.column, props.cfg) : undefined
	if (!label) return <Incomplete />
	return <ColumnWord invalid={arg?.type === 'column' && !!arg.column && !!props.marks?.columns.has(arg.column)}>{label}</ColumnWord>
}

function ScalarSummary(props: { arg: F.EditableArg | undefined; cfg: ColConfig; marks: Marks }) {
	const arg = props.arg
	if (arg?.type === 'column') {
		const label = columnLabel(arg.column, props.cfg)
		return label ? <ColumnWord invalid={!!arg.column && !!props.marks?.columns.has(arg.column)}>{label}</ColumnWord> : <Incomplete />
	}
	if (arg?.type === 'value' && arg.value !== undefined) {
		return <ValueChip invalid={valueMarked(arg.value, props.marks)}>{valueText(arg.value)}</ValueChip>
	}
	return <Incomplete />
}

// every value of an `in` list, wrapping with the row rather than truncating
function ValuesSummary(props: { arg: F.EditableArg | undefined; cfg: ColConfig; marks: Marks }) {
	const items = (props.arg?.type === 'values' ? props.arg.values : undefined) ?? []
	// keyed by what the item renders as, which also collapses the repeat a hand-written filter can carry
	const parts = new Map<string, React.ReactNode>()
	for (const item of items) {
		if (F.isColumnListItem(item)) {
			const key = `col:${item.column}`
			parts.set(
				key,
				<ColumnWord key={key} invalid={!!props.marks?.columns.has(item.column)}>
					{columnLabel(item.column, props.cfg) ?? item.column}
				</ColumnWord>,
			)
		} else {
			const key = `val:${valueText(item)}`
			parts.set(
				key,
				<ValueChip key={key} invalid={valueMarked(item, props.marks)}>
					{valueText(item)}
				</ValueChip>,
			)
		}
	}
	if (parts.size === 0) return <Incomplete />
	return <ValueRun items={Array.from(parts.values())} />
}

function CompSummary(props: { node: F.EditableCompNode; cfg: ColConfig; marks: Marks }) {
	const node = props.node
	const marks = props.marks
	const subject = node.args[0] as F.EditableScalarArg | undefined
	// `id` is reachable only through the "select layers" node, whose values are the layers' stored text
	if (subject?.type === 'column' && subject.column === 'id') {
		return trSummary.richText(F_Msgs.layerSetSummary(node.neg, <ValuesSummary arg={node.args[1]} cfg={props.cfg} marks={marks} />))
	}
	const readable = F_Msgs.compTypeReadableNames[node.type]
	const op = node.neg ? readable.negated : readable.plain
	const subjectElt = <SubjectSummary arg={subject} cfg={props.cfg} marks={marks} />
	if (node.type === 'inrange') {
		return trSummary.richText(
			F_Msgs.rangeSummary(
				subjectElt,
				op,
				<ScalarSummary arg={node.args[1]} cfg={props.cfg} marks={marks} />,
				<ScalarSummary arg={node.args[2]} cfg={props.cfg} marks={marks} />,
			),
		)
	}
	const operand =
		node.type === 'in' ? (
			<ValuesSummary arg={node.args[1]} cfg={props.cfg} marks={marks} />
		) : (
			<ScalarSummary arg={node.args[1]} cfg={props.cfg} marks={marks} />
		)
	return trSummary.richText(F_Msgs.compSummary(subjectElt, op, operand))
}

// the dimensions are flattened into one run of values: which column a faction or a unit came from is
// already clear from the value, and keeping them apart is what makes the editor's version tall
function TeamSpecSummary(props: { spec: F.MatchupTeamSpec; marks: Marks }) {
	const values = F.TEAM_COLUMNS.flatMap((column) => (props.spec[column] ?? []).map((value) => ({ column, value })))
	if (values.length === 0) return <OpWord>{tr.text(F_Msgs.anyTeam())}</OpWord>
	return (
		<ValueRun
			items={values.map(({ column, value }) => (
				<ValueChip key={`${column}:${valueText(value)}`} invalid={valueMarked(value, props.marks)}>
					{valueText(value)}
				</ValueChip>
			))}
		/>
	)
}

function MatchupSummary(props: { node: F.EditableMatchupNode; marks: Marks }) {
	const node = props.node
	return trSummary.richText(
		F_Msgs.matchupSummary(
			node.type === 'disallow-matchups',
			node.locked,
			<TeamSpecSummary spec={node.teams[0]} marks={props.marks} />,
			<TeamSpecSummary spec={node.teams[1]} marks={props.marks} />,
		),
	)
}

function ApplyFilterSummary(props: { node: F.EditableApplyFilterNode; marks: Marks }) {
	const filters = FilterEntityClient.useFilterEntities()
	const entity = props.node.filterId ? filters.get(props.node.filterId) : undefined
	const invalid = !!props.marks?.filter
	return trSummary.richText(
		F_Msgs.applyFilterSummary(
			F_Msgs.applyFilterTypeNames[props.node.type],
			entity ? (
				<span data-invalid={invalid || undefined} className={cn('inline-flex', invalid && cn('rounded-sm px-1', INVALID_PART_CLASS))}>
					<FilterEntityLabel filter={entity} className="inline-flex" hideProblems />
				</span>
			) : props.node.filterId ? (
				<ValueChip invalid={invalid}>{props.node.filterId}</ValueChip>
			) : (
				<Incomplete />
			),
		),
	)
}

// A node as one line of text. `marks` gives the parts its errors name the red treatment.
export function NodeSummary(props: { node: F.ShallowEditableFilterNode; cfg?: ColConfig; marks?: EditFrame.NodeMarks }) {
	const node = props.node
	if (F.isBlockType(node.type)) return <span className="font-semibold">{tr.text(F_Msgs.blockTypeShortNames[node.type])}</span>
	if (F.isCompNode(node)) return <CompSummary node={node as F.EditableCompNode} cfg={props.cfg} marks={props.marks} />
	if (F.isMatchupNode(node)) return <MatchupSummary node={node as F.EditableMatchupNode} marks={props.marks} />
	if (F.isApplyFilterNode(node)) return <ApplyFilterSummary node={node as F.EditableApplyFilterNode} marks={props.marks} />
	return null
}

// the compact row itself. Its own text is its accessible name, so it carries no label of its own.
function NodeSummaryButton(props: { onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			data-node-summary=""
			onClick={props.onClick}
			className="min-w-0 rounded-sm px-1 text-start text-sm leading-6 hover:bg-accent"
		>
			{props.children}
		</button>
	)
}

// move/copy/delete stay reachable on a compact row, but stay out of the way until it is pointed at: the
// point of the row is that it can be read. They keep their box either way, so nothing shifts.
function CompactOpCluster(props: { children: React.ReactNode }) {
	return (
		<div
			// the buttons are what a row's height actually is, so they shrink with it. Overriding them here
			// rather than threading a size through each one keeps the compact sizing in one place.
			className="flex items-center opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 [&_button]:size-6 [&_svg]:size-3.5"
		>
			{props.children}
		</div>
	)
}

// why a node cannot be applied, behind an icon so the row keeps its height
function NodeErrorMark(props: NodeProps) {
	const errors = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.nodeErrors(props.nodeId))
	const filters = FilterEntityClient.useFilterEntities()
	if (errors.length === 0) return null
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					data-node-error-mark=""
					aria-label={tr.text(F_Msgs.problemCount(errors.length))}
					className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-destructive hover:bg-destructive/15"
				>
					<Icons.CircleAlert className="size-4" />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-sm">
				<ul className="flex flex-col gap-1">
					{/* a value listed twice fails twice, with the same message */}
					{Array.from(new Map(errors.map((error) => [F.describeNodeValidationError(error), error])), ([key, error]) => {
						const owner = error.via.length > 0 && error.ownerFilterId ? filters.get(error.ownerFilterId) : undefined
						return <li key={key}>{owner ? tr.richText(F_Msgs.problemLine(owner.name, error.msg)) : tr.text(error.msg)}</li>
					})}
				</ul>
			</TooltipContent>
		</Tooltip>
	)
}

function DoneButton(props: { onClick: () => void }) {
	return (
		<Button size="sm" variant="outline" onClick={props.onClick}>
			{tr.text(F_Msgs.doneEditing())}
		</Button>
	)
}

export function LeafFilterNode(props: NodeProps) {
	const editedFilterId = Zus.useStore(props.stores.filterEditor, (state) => state.editedFilterId)
	const node = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.node(props.nodeId))
	const depth = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.depth(props.nodeId))!
	const editing = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.nodeEditing(props.nodeId))
	const marks = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.nodeMarks(props.nodeId))
	const cfg = ConfigClient.useEffectiveColConfig()
	if (F.isBlockType(node.type)) return null
	const actions = EditFrame.getNodeActions(props.stores, props.nodeId)
	const errorMark = <NodeErrorMark nodeId={props.nodeId} stores={props.stores} />

	const opCluster = depth > 0 && (
		<>
			<CommentButton nodeId={props.nodeId} stores={props.stores} />
			<DuplicateButton onClick={actions.common.duplicate} />
			<Button
				size="icon"
				variant="ghost"
				aria-label={tr.text(F_Msgs.removeNode())}
				onClick={() => {
					actions.common.delete()
				}}
			>
				<Minus color="hsl(var(--destructive))" />
			</Button>
		</>
	)

	if (!editing) {
		return (
			<NodeWrapper
				narrowGrip
				depth={depth}
				className="group/row flex flex-wrap items-center gap-1"
				nodeId={props.nodeId}
				stores={props.stores}
			>
				<NodeSummaryButton onClick={() => actions.common.setEditing(true)}>
					<NodeSummary node={node} cfg={cfg} marks={marks} />
				</NodeSummaryButton>
				{errorMark}
				{/* the link is an anchor, so it cannot live inside the summary button */}
				{F.isApplyFilterNode(node) && <ApplyFilterLink filterId={(node as F.EditableApplyFilterNode).filterId} />}
				<CompactOpCluster>{opCluster}</CompactOpCluster>
			</NodeWrapper>
		)
	}

	const doneButton = <DoneButton onClick={() => actions.common.setEditing(false)} />

	if (F.isCompNode(node)) {
		const subject = node.args[0]
		const isSelectLayers = subject?.type === 'column' && subject.column === 'id'
		return (
			<NodeWrapper narrowGrip depth={depth} className="flex flex-wrap items-center gap-1" nodeId={props.nodeId} stores={props.stores}>
				{isSelectLayers ? (
					<>
						<NodeKindPicker nodeId={props.nodeId} stores={props.stores} node={node} />
						<SelectLayersNodeConfig nodeId={props.nodeId} stores={props.stores} node={node} />
					</>
				) : (
					<CompNodeConfig nodeId={props.nodeId} stores={props.stores} node={node} marks={marks} />
				)}
				{errorMark}
				{opCluster}
				{doneButton}
			</NodeWrapper>
		)
	}
	if (F.isMatchupNode(node)) {
		return (
			<NodeWrapper narrowGrip depth={depth} className="flex flex-wrap items-center gap-1" nodeId={props.nodeId} stores={props.stores}>
				<NodeKindPicker nodeId={props.nodeId} stores={props.stores} node={node} />
				<MatchupNodeConfig nodeId={props.nodeId} stores={props.stores} node={node} marks={marks} />
				{errorMark}
				{opCluster}
				{doneButton}
			</NodeWrapper>
		)
	}
	if (F.isApplyFilterNode(node)) {
		return (
			<NodeWrapper narrowGrip depth={depth} className="flex flex-wrap items-center gap-1" nodeId={props.nodeId} stores={props.stores}>
				<NodeKindPicker nodeId={props.nodeId} stores={props.stores} node={node} />
				<ApplyFilter
					filterId={node.filterId}
					editedFilterId={editedFilterId}
					setFilterId={(id) => actions.applyFilter.setFilterId(id)}
					invalid={marks.filter}
				/>
				<ApplyFilterLink filterId={node.filterId} />
				{errorMark}
				{opCluster}
				{doneButton}
			</NodeWrapper>
		)
	}
	// block nodes are rendered by BlockNodeControlPanel, not here
	return null
}

function ApplyFilterLink(props: { filterId: string | undefined }) {
	return (
		<Link
			to="/filters/$filterId"
			params={{ filterId: props.filterId ?? '' }}
			target="_blank"
			className={cn(!props.filterId ? 'invisible' : '', buttonVariants({ variant: 'ghost', size: 'icon' }), 'font-light')}
		>
			<ExternalLink color="hsl(var(--primary))" />
		</Link>
	)
}

function CompNodeConfig(props: { nodeId: string; stores: EditFrame.KeyProp; node: F.EditableCompNode; marks: EditFrame.NodeMarks }) {
	const actions = EditFrame.getNodeActions(props.stores, props.nodeId)
	const hint = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.createHint(props.nodeId))
	const cfg = ConfigClient.useEffectiveColConfig()
	const subject = props.node.args[0] as F.EditableScalarArg | undefined
	const marks = props.marks
	const subjectColumns =
		subject?.type === 'team-column' && subject.column
			? [F.resolveTeamColumn(subject.column, 1), F.resolveTeamColumn(subject.column, 2)]
			: subject?.type === 'column' && subject.column
				? [subject.column]
				: []
	const invalid = {
		column: subjectColumns.some((column) => marks.columns.has(column)),
		// a column operand is picked among the value editors
		values: marks.values.size > 0 || [...marks.columns].some((column) => !subjectColumns.includes(column)),
		marks,
	}
	return (
		<Comparison
			nodeKindOptions={nodeKindEntryOptions()}
			onSelectNodeKind={(value) => {
				const seed = seedForKind(value, cfg)
				EditFrame.Actions.convertNode(props.stores, props.nodeId, seed.node, seed.hint)
			}}
			node={props.node}
			setNode={(update) => actions.comp.setNode(update)}
			invalid={invalid}
			teamColumnsAvailable
			defaultSubjectGroup={hint?.group}
			defaultFocus={hint?.focus}
			restrictValueSize={false}
		/>
	)
}

// the simplified `id in [...]` node: just the layer picker, since `id` supports no other operation.
function SelectLayersNodeConfig(props: { nodeId: string; stores: EditFrame.KeyProp; node: F.EditableCompNode }) {
	const actions = EditFrame.getNodeActions(props.stores, props.nodeId)
	const hint = Zus.useStore(props.stores.filterEditor, EditFrame.Sel.createHint(props.nodeId))
	const valuesArg = props.node.args[1]
	const items = (valuesArg?.type === 'values' ? valuesArg.values : undefined) ?? []
	const values = items.filter((i) => !F.isColumnListItem(i)) as (string | null)[]
	const setValues = (update: React.SetStateAction<(string | null)[]>) =>
		actions.comp.setNode(
			Im.produce((c) => {
				const prev = (c.args[1]?.type === 'values' ? c.args[1].values : undefined) ?? []
				const primitives = prev.filter((i) => !F.isColumnListItem(i)) as (string | null)[]
				const next = typeof update === 'function' ? update(primitives) : update
				c.args[1] = { type: 'values', values: next.length === 0 ? undefined : next }
			}),
		)
	return (
		<div className="flex items-center space-x-1">
			<ComboBox
				allowEmpty={false}
				className={operatorSelectClass}
				title={tr.text(F_Msgs.modePicker())}
				value={props.node.neg ? 'notin' : 'in'}
				options={[
					{ value: 'in', label: tr.text(F_Msgs.inSetNames.in), description: tr.text(F_Msgs.inSetDescriptions.in) },
					{ value: 'notin', label: tr.text(F_Msgs.inSetNames.notin), description: tr.text(F_Msgs.inSetDescriptions.notin) },
				]}
				onSelect={(v) => actions.comp.setNode(Im.produce((c) => void (c.neg = v === 'notin')))}
			/>
			<LayersInConfig values={values} setValues={setValues} autoOpen={hint?.autoOpenLayers} />
		</div>
	)
}

export type ComparisonHandle = Clearable & Focusable

const SUBJECT_GROUP_SELECTIONS: Record<string, Record<string, string>> = {
	[BLOCK_GROUP]: { [SUBJECT_GROUPING]: BLOCK_GROUP },
	layer: { [SUBJECT_GROUPING]: 'layer' },
	faction: { [SUBJECT_GROUPING]: 'faction' },
	vehicle: { [SUBJECT_GROUPING]: 'vehicle' },
	scores: { [SUBJECT_GROUPING]: 'scores' },
}

let subjectGroupingsCache: { locale: string; groupings: ComboBoxGroupingDef[] } | undefined
// cached per locale: ComboBox resolves its groupings on every change of the array's identity. The add menu's
// block section is listed first; the subject picker has no block options, so that tab never shows there.
function subjectGroupings(): ComboBoxGroupingDef[] {
	if (subjectGroupingsCache?.locale !== tr.locale) {
		subjectGroupingsCache = {
			locale: tr.locale,
			groupings: [
				{
					key: SUBJECT_GROUPING,
					label: tr.text(F_Msgs.subjectGroupingLabel()),
					groups: [
						{ key: BLOCK_GROUP, label: tr.text(F_Msgs.blockGroupName()) },
						...F.SUBJECT_COLUMN_GROUPS.map((group) => ({ key: group, label: tr.text(F_Msgs.subjectGroupNames[group]) })),
					],
					control: 'tabs',
				},
			],
		}
	}
	return subjectGroupingsCache.groupings
}

// team-generic columns are encoded as `team:<quantifier>:<column>` so the either/both choice lives
// directly in the column select rather than a separate dropdown
const TEAM_PREFIX = 'team:'
function teamColumnValue(column: F.TeamColumn, quantifier: F.TeamQuantifier) {
	return `${TEAM_PREFIX}${quantifier}:${column}`
}
function parseSubjectValue(value: string): F.EditableScalarArg {
	if (!value.startsWith(TEAM_PREFIX)) return { type: 'column', column: value }
	const [quantifier, column] = value.slice(TEAM_PREFIX.length).split(':') as [F.TeamQuantifier, F.TeamColumn]
	return { type: 'team-column', column, quantifier }
}

// The subject picker's options, sectioned by SUBJECT_GROUPING. Each team column family (Alliance/Faction/Unit/...)
// is kept together in order (T1, T2, Both, Either) ahead of the alphabetical rest of its section. Because the
// order is bespoke, a picker using these opts out of ComboBox's default label sort (sort={false}); the grouping
// still orders the sections.
function subjectColumnOptions(cfg: ColConfig, teamColumnsAvailable: boolean): ComboBoxOption<string>[] {
	// `id` is reachable only through the dedicated "select layers" node
	const baseCols = (cfg ? Object.keys(cfg.defs) : (LC.COLUMN_KEYS as string[])).filter((c) => c !== 'id')
	const baseOption = (c: string): ComboBoxOption<string> & { label: string } => ({
		value: c,
		label: columnLabel(c, cfg) ?? c,
		groups: { [SUBJECT_GROUPING]: F.subjectColumnGroup(c) },
	})
	const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label)
	if (!teamColumnsAvailable) return baseCols.map(baseOption).sort(byLabel)

	const teamBaseCols = new Set(F.TEAM_COLUMNS.flatMap((tc) => [F.resolveTeamColumn(tc, 1), F.resolveTeamColumn(tc, 2)]))
	// label the concrete T1/T2 columns consistently within the family (some base display names, e.g.
	// Faction's, omit the family prefix) so the four variants read uniformly
	const teamOptions = F.TEAM_COLUMNS.flatMap((tc): ComboBoxOption<string>[] => {
		const name = tr.text(F_Msgs.teamColumnNames[tc])
		const groups = { [SUBJECT_GROUPING]: F.teamColumnGroup(tc) }
		return [
			...([1, 2] as const)
				.filter((team) => baseCols.includes(F.resolveTeamColumn(tc, team)))
				.map((team) => ({ value: F.resolveTeamColumn(tc, team), label: tr.text(F_Msgs.teamColumnForTeam(name, team)), groups })),
			{ value: teamColumnValue(tc, 'both'), label: tr.text(F_Msgs.teamColumnBoth(name)), groups },
			{ value: teamColumnValue(tc, 'either'), label: tr.text(F_Msgs.teamColumnEither(name)), groups },
		]
	})
	const rest = baseCols
		.filter((c) => !teamBaseCols.has(c))
		.map(baseOption)
		.sort(byLabel)
	return [...teamOptions, ...rest]
}

// A team column's displayName is the layer table's compact header ('T1'), which names nothing on its own in a
// value picker: "Selected T1s (0)". Every picker on a team dimension names itself by the dimension and, for a
// concrete side, which side.
const TEAM_DIMENSION_BY_COLUMN: Record<string, { column: F.TeamColumn; team: 1 | 2 }> = Object.fromEntries(
	F.TEAM_COLUMNS.flatMap((column) => ([1, 2] as const).map((team) => [F.resolveTeamColumn(column, team), { column, team }])),
)

// A single comparison node: [anchor column] [operator] [value(s)]. The anchor (args[0]) determines
// the value domain, which in turn drives the operator options and the value editor.
export function Comparison(props: {
	node: F.EditableCompNode
	setNode: React.Dispatch<React.SetStateAction<F.EditableCompNode>>
	columnEditable?: boolean
	teamColumnsAvailable?: boolean
	// the subject picker's section to open on while the comparison has no subject
	defaultSubjectGroup?: F.SubjectColumnGroup
	// other kinds of node the column picker offers, each turning the comparison into that kind when picked
	nodeKindOptions?: ComboBoxOption<string>[]
	onSelectNodeKind?: (value: string) => void
	restrictValueSize?: boolean
	allowedEnumValues?: string[]
	onSetAllValuesAllowed?: () => void
	onSetAllValuesAllowedLabel?: string
	showValueDropdown?: boolean
	lockOnSingleOption?: boolean
	defaultEditing?: boolean
	// when a freshly-created comparison already has a subject column, open the operator select or the value
	// editor on mount instead of the subject picker
	defaultFocus?: 'operator' | 'values'
	highlight?: boolean
	// pickers whose selection an error names. `marks` narrows an `in` list's marking to the parts named
	invalid?: { column: boolean; values: boolean; marks?: EditFrame.NodeMarks }
	columnLabel?: string
	// overrides the numeric value input's width wrapper (default w-[100px]); used to keep the compact
	// filter menu's range inputs from stretching the whole value column
	numericValueClassName?: string
	// extra classes for the operator select, e.g. the compact filter menu's symbol-width one
	operatorClassName?: string
	// the filter menu labels its rows itself, and the matchup node's cells have no operator of their own
	showColumn?: boolean
	showOperator?: boolean
	// overrides for how the value multi-select names itself; a team dimension defaults all three (see
	// TEAM_DIMENSION_BY_COLUMN). The constraint rail overrides the placeholder, whose cells are too narrow
	// for the default "any faction"
	valuesTitle?: string
	valuesAriaLabel?: string
	valuesEmptyLabel?: string
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

	// a team-generic anchor carries its quantifier in the column box beside the picker, so the side is not the
	// picker's to say; a concrete one has no other label
	const teamDimensionColumn = anchorTeamColumn
		? { column: anchorTeamColumn, team: undefined }
		: anchorColumn
			? TEAM_DIMENSION_BY_COLUMN[anchorColumn]
			: undefined
	const teamDimension = teamDimensionColumn && {
		label: tr.text(F_Msgs.teamColumnNames[teamDimensionColumn.column]),
		team: teamDimensionColumn.team,
	}
	const valuesTitle = props.valuesTitle ?? teamDimension?.label
	const valuesAriaLabel =
		props.valuesAriaLabel ??
		(teamDimension?.team ? tr.text(F_Msgs.teamColumnForTeam(teamDimension.label, teamDimension.team)) : teamDimension?.label)
	const valuesEmptyLabel = props.valuesEmptyLabel ?? (teamDimensionColumn && tr.text(F_Msgs.anyTeamColumn(teamDimensionColumn.column)))

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

	const subjectOptions = subjectColumnOptions(cfg, props.teamColumnsAvailable ?? false)
	const columnOptions = props.nodeKindOptions ? [...props.nodeKindOptions, ...subjectOptions] : subjectOptions
	const subjectGroup = F.subjectArgGroup(anchor) ?? props.defaultSubjectGroup
	const subjectGroupSelection = subjectGroup ? SUBJECT_GROUP_SELECTIONS[subjectGroup] : undefined

	const currentColumnValue = anchorTeamColumn ? teamColumnValue(anchorTeamColumn, anchorQuantifier) : anchorColumn

	// reshape the node's args for a newly selected anchor, keeping the operator if the new domain supports it
	function selectAnchor(newAnchor: F.EditableScalarArg) {
		const newDomain = F.argValueDomain(newAnchor, cfg)
		setNode((c) => {
			const keepOp = newDomain ? F.domainSupportsCompType(newDomain, c.type) : true
			const type = keepOp ? c.type : F.defaultCompType(newDomain)
			const neg = keepOp ? c.neg : false
			const slots = F.COMP_TYPE_DEFS[type].argSlots
			const args = slots.map((slot, i): F.EditableArg =>
				i === 0 ? newAnchor : slot === 'values' ? { type: 'values' } : { type: 'value' },
			)
			return { type, neg, args }
		})
	}

	const columnDef = optionsColumn ? LC.getColumnDef(optionsColumn, cfg) : undefined
	const componentStyles = props.highlight ? 'text-pri-hi' : undefined
	const valueStyles = cn(componentStyles, props.invalid?.values && INVALID_PICKER_CLASS)

	const columnBox = columnEditable ? (
		<ComboBox
			title={props.columnLabel ?? (columnDef && tr.text(LC_Msgs.columnName(columnDef))) ?? tr.text(F_Msgs.columnPicker())}
			className={cn(componentStyles, props.invalid?.column && INVALID_PICKER_CLASS)}
			allowEmpty
			value={currentColumnValue}
			options={columnOptions}
			// options are pre-ordered (team families grouped, rest alphabetical); keep that order
			sort={false}
			groupings={subjectGroupings()}
			defaultGroups={subjectGroupSelection}
			renderGroupPrefix={false}
			ref={columnBoxRef}
			// selecting a column always resets and reopens the next argument, so hand focus onward on
			// selection (ComboBox still restores focus on a plain dismiss)
			preventCloseAutoFocus
			onSelect={(value) => {
				if (!value) return setNode(() => ({ type: 'eq', neg: false, args: [{ type: 'column' }, { type: 'value' }] }))
				if (value.startsWith(NODE_KIND_PREFIX)) return props.onSelectNodeKind?.(value)
				const parsed = parseSubjectValue(value)
				if (parsed.type === 'team-column') {
					const { quantifier, column } = parsed
					// changing only the quantifier on the same column keeps the operator and value(s)
					if (column === anchorTeamColumn) {
						setNode(
							Im.produce((c) => {
								if (c.args[0]?.type === 'team-column') c.args[0].quantifier = quantifier
							}),
						)
						return
					}
					selectAnchor(parsed)
					// team columns are enum-domained, so advance straight to the value
					setFocusRequest('advance')
					return
				}
				const newAnchor = parsed
				selectAnchor(newAnchor)
				// numeric subjects: the operator matters (eq/lt/gt/inrange), so send focus to the operator
				// select; everything else advances straight to the value
				const newDomain = F.argValueDomain(newAnchor, cfg)
				setFocusRequest(newDomain?.kind === 'number' ? 'operator' : 'advance')
			}}
		/>
	) : (
		<span className={cn(buttonVariants({ size: 'default', variant: 'outline' }), 'pointer-events-none', componentStyles)}>
			{props.columnLabel ?? (columnDef && tr.text(LC_Msgs.columnName(columnDef)))}
		</span>
	)
	// operator options come from the subject's domain once one is set, otherwise the full set is offered
	const opOptions = F.compOpSelectOptions(domain)
	const codeBox = (
		<ComboBox
			allowEmpty={false}
			className={cn(operatorSelectClass, componentStyles, props.operatorClassName)}
			title={tr.text(F_Msgs.operatorPicker())}
			value={F.compOpSelectionKey(node)}
			options={opOptions.map((o) => ({
				value: o.key,
				label: tr.text(F_Msgs.compOpLabels[o.key]),
				description: tr.text(F_Msgs.compOpDescription(o)),
			}))}
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
		if (!columnEditable) return
		const raf = requestAnimationFrame(() => {
			if (props.defaultFocus === 'operator' && hasSubject) codeBoxRef.current?.focus()
			else if (props.defaultFocus === 'values' && hasSubject) valueBoxRef.current?.focus()
			else if (props.defaultEditing || !hasSubject) columnBoxRef.current?.focus()
		})
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
		setNode(
			Im.produce((c) => {
				c.args[index] = { type: 'value', value }
			}),
		)

	// a scalar value slot may instead reference another column of the same value domain (column-vs-column).
	// offered only in the full editor, not the locked filter menu.
	const allowColumnOperand = columnEditable && !!domain
	const comparableColumnOptions = (): ComboBoxOption<string>[] => {
		const cols = cfg ? Object.keys(cfg.defs) : LC.COLUMN_KEYS
		return cols
			.filter((c) => {
				// virtual (vehicle) columns hold sets, not scalars; they can be a subject but never an operand
				if (LC.isVirtualColumn(c, cfg)) return false
				const d = F.columnValueDomain(c, cfg)
				return d && domain && F.domainsCompatible(d, domain)
			})
			.map((c) => ({ value: c, label: columnLabel(c, cfg) ?? c }))
	}
	// segmented control to pick whether a slot compares against a constant value or another column
	const operandKindSelector = (index: number, isColumn: boolean) => {
		if (!allowColumnOperand) return null
		const setKind = (kind: 'value' | 'column') =>
			setNode(
				Im.produce((c) => {
					// no-op if already that kind, so re-picking the active segment preserves the current value
					if (c.args[index]?.type !== kind) c.args[index] = { type: kind }
				}),
			)
		return (
			<ButtonGroup>
				<Button
					size="icon"
					variant={!isColumn ? 'secondary' : 'ghost'}
					title={tr.text(F_Msgs.compareToValue())}
					onClick={() => setKind('value')}
				>
					<TextCursorInput className="h-4 w-4" />
				</Button>
				<Button
					size="icon"
					variant={isColumn ? 'secondary' : 'ghost'}
					title={tr.text(F_Msgs.compareToColumn())}
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
		columnEditable && node.type === 'eq' && !enumSubject && !F.isFloatEqNullOnly(domain, node.type) ? (
			<Button
				size="icon"
				variant={isNull ? 'secondary' : 'ghost'}
				title={tr.text(isNull ? F_Msgs.clearNull() : F_Msgs.compareToNull())}
				onClick={() =>
					setNode(
						Im.produce((c) => {
							c.args[index] = { type: 'value', value: isNull ? undefined : null }
						}),
					)
				}
			>
				<Icons.Ban className="h-4 w-4" />
			</Button>
		) : null

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
						className={valueStyles}
						title={tr.text(F_Msgs.columnPicker())}
						value={arg.column}
						options={comparableColumnOptions()}
						onSelect={(v) =>
							setNode(
								Im.produce((c) => {
									c.args[index] = { type: 'column', column: v || undefined }
								}),
							)
						}
					/>
					{nullToggle(index, false)}
				</div>
			)
		}
		// a float eq only compares against null; render a static null indicator plus a "?" explaining why
		if (F.isFloatEqNullOnly(domain, node.type)) {
			return (
				<div className="flex items-center space-x-1">
					<span className={cn(buttonVariants({ variant: 'outline' }), 'pointer-events-none', valueStyles)}>
						{tr.text(F_Msgs.nullValue())}
					</span>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								className="text-muted-foreground hover:text-foreground"
								aria-label={tr.text(F_Msgs.whyOnlyNull())}
							>
								<Icons.CircleHelp className="h-4 w-4" />
							</button>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs">
							<p>{tr.richText(F_Msgs.floatEqNullOnly())}</p>
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
					<span className={cn(buttonVariants({ variant: 'outline' }), 'pointer-events-none', valueStyles)}>
						{tr.text(F_Msgs.nullValue())}
					</span>
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
		if (!domain || domain.kind === 'enum' || domain.kind === 'string') {
			return withToggle(
				<StringEqConfig
					ref={ref as React.ForwardedRef<ComboBoxHandle>}
					lockOnSingleOption={lockOnSingleOption}
					className={valueStyles}
					allowedValues={props.allowedEnumValues}
					onSetAllValuesAllowed={props.onSetAllValuesAllowed}
					onSetAllValuesAllowedLabel={props.onSetAllValuesAllowedLabel}
					column={optionsColumn}
					title={valuesAriaLabel}
					placeholder={valuesEmptyLabel}
					value={value as string | undefined | null}
					setValue={(v) => setSlotValue(index, v)}
				/>,
			)
		}
		if (domain.kind === 'boolean') {
			return withToggle(
				<ComboBox
					allowEmpty
					className={valueStyles}
					title={tr.text(F_Msgs.valuePicker())}
					value={value === undefined || value === null ? undefined : String(value)}
					options={[
						{ value: 'true', label: 'true' },
						{ value: 'false', label: 'false' },
					]}
					onSelect={(v) => setSlotValue(index, v === undefined ? undefined : v === 'true')}
				/>,
			)
		}
		// number
		return withToggle(
			<div className={cn('w-[100px]', props.numericValueClassName)}>
				<NumericValueConfig
					ref={ref as React.ForwardedRef<Focusable & Clearable>}
					className={valueStyles}
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
				setNode(
					Im.produce((c) => {
						const prev = (c.args[1]?.type === 'values' ? c.args[1].values : undefined) ?? []
						const next = typeof update === 'function' ? update(prev) : update
						c.args[1] = { type: 'values', values: next.length === 0 ? undefined : next }
					}),
				)
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
						className={valueStyles}
					/>
				)
			} else {
				valueBox = (
					<InListConfig
						className={componentStyles}
						marks={props.invalid?.marks}
						ref={valueBoxRef as React.ForwardedRef<ComboBoxHandle>}
						column={optionsColumn}
						allowedEnumValues={props.allowedEnumValues}
						restrictValueSize={restrictValueSize}
						title={valuesTitle}
						ariaLabel={valuesAriaLabel}
						emptyLabel={valuesEmptyLabel}
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
					<span>{tr.text(F_Msgs.rangeTo())}</span>
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
			{props.showColumn !== false && columnBox}
			{props.showOperator !== false && codeBox}
			{valueBox}
		</>
	)
}

type ApplyFilterProps = {
	filterId: string | undefined
	setFilterId: (filterId: string) => void
	// the id of the filter entity currently being edited
	editedFilterId?: string
	invalid?: boolean
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
			className={cn(props.invalid && INVALID_PICKER_CLASS)}
			title={tr.text(F_Msgs.filterPicker())}
			options={options}
			allowEmpty
			value={props.filterId}
			onSelect={(v) => {
				return props.setFilterId(v as string)
			}}
		/>
	)
}

// vehicle class codes are terse, so their options carry the readable name and an explanation; the code
// stays the stored value and the compact display (chips, trigger)
function enumOptionExtras(column: LC.EnumColumn, value: string): Partial<ComboBoxOption<string | null>> {
	const groups = enumOptionGroups(column, value)
	const grouped: Partial<ComboBoxOption<string | null>> = groups ? { groups } : {}
	const kind = LC.vehicleColumnInfo(column)?.kind
	if (kind === 'vehicles') {
		const type = LC.vehicleTypeForVehicle(value)
		if (!type) return grouped
		const typeLabel = LC_Msgs.vehicleTypeLabels[type]
		return {
			...grouped,
			description: typeLabel ? `${type} (${tr.text(typeLabel)})` : type,
			// searching a class code or name narrows the list to that class
			keywords: typeLabel ? [type, tr.text(typeLabel)] : [type],
		}
	}
	if (kind !== 'vehicleTypes') return grouped
	const label = LC_Msgs.vehicleTypeLabels[value]
	if (!label) return grouped
	const description = LC_Msgs.vehicleTypeDescriptions[value]
	return {
		...grouped,
		label: `${value} (${tr.text(label)})`,
		chipLabel: value,
		keywords: [tr.text(label)],
		...(description ? { description: tr.text(description) } : {}),
	}
}

export function StringEqConfig<T extends string | null>(props: {
	value: T | undefined
	// a plain string, because a filter's column arg is free text: a hand-edited or stale filter can name a
	// column that resolves to nothing, and the editor then offers no options rather than throwing
	column: string | undefined
	allowedValues?: T[]
	onSetAllValuesAllowed?: () => void
	onSetAllValuesAllowedLabel?: string
	setValue: (value: T | undefined) => void
	className?: string
	lockOnSingleOption?: boolean
	// override naming the picker by its column, as StringInConfig's do
	title?: string
	placeholder?: string
	ref?: React.ForwardedRef<ComboBoxHandle>
}) {
	const lockOnSingleOption = props.lockOnSingleOption ?? false
	const hasUnlockAction = !!props.onSetAllValuesAllowed
	const options = React.useMemo(() => {
		const column = LC.isEnumColumn(props.column) ? props.column : undefined
		if (!column) return []
		const allowedSet = props.allowedValues ? new Set(props.allowedValues) : null
		const options: ComboBoxOption<string | null>[] = []
		for (const value of LC.groupByColumnDefaultValues(column)) {
			const matched = allowedSet?.has(value as T) ?? true
			// null is a real enum value for some columns (e.g. LayerVersion "no version"); surface it
			if (value === null) {
				options.push({ label: '(none)', value: null, disabled: !matched && !hasUnlockAction, sortLast: !matched })
				continue
			}
			options.push({
				label: value,
				...enumOptionExtras(column, value),
				value,
				disabled: !matched && !hasUnlockAction,
				sortLast: !matched,
				locked: !matched && hasUnlockAction,
			})
		}
		return options
	}, [props.column, props.allowedValues, hasUnlockAction])
	return (
		<ComboBox
			ref={props.ref}
			allowEmpty
			className={props.className}
			title={props.title ?? columnLabel(props.column, undefined) ?? ''}
			placeholder={props.placeholder}
			disabled={lockOnSingleOption && options.length === 1}
			value={lockOnSingleOption && options.length === 1 ? options[0].value : props.value}
			options={options}
			groupings={LC.isEnumColumn(props.column) ? enumGroupings(props.column) : []}
			onSelect={(v) => props.setValue(v as T | undefined)}
			onUnlock={props.onSetAllValuesAllowed}
			unlockLabel={props.onSetAllValuesAllowedLabel ?? 'deselect all other filters and select this one'}
		/>
	)
}

export function StringInConfig(props: {
	values: (string | null)[]
	column: string | undefined
	allowedValues?: (string | null)[]
	setValues: React.Dispatch<React.SetStateAction<(string | null)[]>>
	className?: string
	ref?: React.ForwardedRef<ComboBoxHandle>
	restrictValueSize?: boolean
	// matchup dimensions title themselves by dimension ('Faction'), not by the underlying column ('T1')
	title?: string
	ariaLabel?: string
	emptyLabel?: string
}) {
	const options = React.useMemo(() => {
		const column = LC.isEnumColumn(props.column) ? props.column : undefined
		if (!column) return []
		const allowedSet = props.allowedValues ? new Set(props.allowedValues) : null
		const options: ComboBoxOption<string | null>[] = []
		for (const value of LC.groupByColumnDefaultValues(column)) {
			const matched = allowedSet?.has(value) ?? true
			if (value === null) {
				options.push({ label: '(none)', value: null, disabled: !matched })
				continue
			}
			options.push({ label: value, ...enumOptionExtras(column, value), value, disabled: !matched })
		}
		return options
	}, [props.column, props.allowedValues])
	return (
		<ComboBoxMulti
			title={props.title ?? columnLabel(props.column, undefined) ?? ''}
			ariaLabel={props.ariaLabel}
			emptyLabel={props.emptyLabel}
			ref={props.ref}
			values={props.values}
			options={options}
			groupings={LC.isEnumColumn(props.column) ? enumGroupings(props.column) : []}
			onSelect={props.setValues}
			className={props.className}
			restrictValueSize={props.restrictValueSize}
			chipDisplay
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
	// narrow a dimension's options to what still has matches (the backburner request dialog); absent = full list
	allowedValues?: (column: F.TeamColumn) => string[] | undefined
	// the dimensions to offer; hosts whose queries only understand physical team columns pass a subset
	columns?: readonly F.TeamColumn[]
	// values an error names, as String() renders them
	invalidValues?: ReadonlySet<string>
}) {
	const invalidValues = props.invalidValues
	return (
		<div className="flex flex-col space-y-1 rounded border border-dashed px-2 py-1.5">
			<span className="text-xs font-semibold text-muted-foreground">{props.label}</span>
			{(props.columns ?? F.TEAM_COLUMNS).map((teamColumn) => (
				<StringInConfig
					key={teamColumn}
					title={tr.text(F_Msgs.teamColumnNames[teamColumn])}
					emptyLabel={tr.text(F_Msgs.anyTeamColumn(teamColumn))}
					// a floor, not a fixed width: the three dimensions line up when empty, but a filled one
					// grows to its selection (all four alliances need ~270px) instead of truncating at 180.
					// restrictValueSize still caps it at 400px, so a big faction selection can't run away
					className={cn(
						'min-w-[180px]',
						invalidValues?.size && props.spec[teamColumn]?.some((value) => invalidValues.has(String(value))) && INVALID_PICKER_CLASS,
					)}
					restrictValueSize
					allowedValues={props.allowedValues?.(teamColumn)}
					// both teams' columns share an enum mapping, so team 1's value list serves either side
					column={F.resolveTeamColumn(teamColumn, 1) as LC.EnumColumn}
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

export type MatchupActions = {
	setType: (type: F.MatchupType) => void
	setLocked: (locked: boolean) => void
	swapTeams: () => void
	setTeamValues: (teamIndex: 0 | 1, column: F.TeamColumn, values: F.Value[]) => void
}

// the matchup editor proper, decoupled from the filter-editor frame so other hosts (the backburner request
// dialog) can drive it against their own state. Whether it allows or disallows is the host's to pick.
export function MatchupConfig(props: {
	node: F.EditableMatchupNode
	actions: MatchupActions
	// per-side, per-dimension option narrowing (the backburner request dialog); absent = full value lists
	allowedTeamValues?: (side: 0 | 1, column: F.TeamColumn) => string[] | undefined
	// the dimensions each side offers; defaults to all of them, including the vehicle columns
	columns?: readonly F.TeamColumn[]
	// values an error names, as String() renders them
	invalidValues?: ReadonlySet<string>
	// the dimensions shown before any is added or holds a value. The rest are offered by an add control.
	// Absent, every offered dimension is shown.
	defaultColumns?: readonly F.TeamColumn[]
}) {
	const { node, actions } = props
	const [addedColumns, setAddedColumns] = React.useState<readonly F.TeamColumn[]>([])
	const offeredColumns = props.columns ?? F.TEAM_COLUMNS
	const defaultColumns = props.defaultColumns
	const shownColumns = defaultColumns
		? offeredColumns.filter(
				(column) =>
					defaultColumns.includes(column) ||
					addedColumns.includes(column) ||
					node.teams.some((spec) => (spec[column]?.length ?? 0) > 0),
			)
		: offeredColumns
	const hiddenColumns = offeredColumns.filter((column) => !shownColumns.includes(column))
	// unlocked, the specs are not pinned to the _1/_2 columns, so naming them "Team 1"/"Team 2" would
	// misdescribe what the node matches. "Team A"/"Team B" are not available either: those already mean
	// the normalized teams that persist across the team1/team2 swap (see MH.NormedTeamId and the
	// displayTeamsNormalized setting), which is a different idea entirely -- and that setting toggles
	// between those very labels, so reusing them here would read as driving it.
	const [firstLabel, secondLabel] = node.locked
		? [tr.text(F_Msgs.matchupSideLabels.lockedFirst), tr.text(F_Msgs.matchupSideLabels.lockedSecond)]
		: [tr.text(F_Msgs.matchupSideLabels.first), tr.text(F_Msgs.matchupSideLabels.second)]
	return (
		<div className="flex flex-wrap items-center gap-2">
			<TeamSpecConfig
				label={firstLabel}
				spec={node.teams[0]}
				columns={shownColumns}
				invalidValues={props.invalidValues}
				allowedValues={props.allowedTeamValues && ((column) => props.allowedTeamValues!(0, column))}
				setValues={(col, values) => actions.setTeamValues(0, col, values)}
			/>
			<div className="flex flex-col items-center space-y-1">
				<Tooltip help>
					<TooltipTrigger asChild>
						<Button size="icon" variant="ghost" onClick={() => actions.swapTeams()}>
							<Icons.ArrowLeftRight />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{tr.text(F_Msgs.swapSides())}</TooltipContent>
				</Tooltip>
				<Tooltip help>
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
					<TooltipContent>{tr.text(node.locked ? F_Msgs.matchupLockedHint() : F_Msgs.matchupUnlockedHint())}</TooltipContent>
				</Tooltip>
				<span className="whitespace-nowrap text-[10px] text-muted-foreground">{node.locked ? 'order locked' : 'either order'}</span>
			</div>
			<TeamSpecConfig
				label={secondLabel}
				spec={node.teams[1]}
				columns={shownColumns}
				invalidValues={props.invalidValues}
				allowedValues={props.allowedTeamValues && ((column) => props.allowedTeamValues!(1, column))}
				setValues={(col, values) => actions.setTeamValues(1, col, values)}
			/>
			{hiddenColumns.length > 0 && (
				<ComboBox
					title={tr.text(F_Msgs.teamDimensionPicker())}
					placeholder={tr.text(F_Msgs.addTeamDimension())}
					value={undefined}
					options={hiddenColumns.map((column) => ({ value: column, label: tr.text(F_Msgs.teamColumnNames[column]) }))}
					sort={false}
					onSelect={(column) => column && setAddedColumns((prev) => [...prev, column as F.TeamColumn])}
				/>
			)}
		</div>
	)
}

const DEFAULT_MATCHUP_COLUMNS: readonly F.TeamColumn[] = ['Faction', 'Unit']

function MatchupNodeConfig(props: { nodeId: string; stores: EditFrame.KeyProp; node: F.EditableMatchupNode; marks: EditFrame.NodeMarks }) {
	const actions = EditFrame.getNodeActions(props.stores, props.nodeId).matchup
	return <MatchupConfig node={props.node} actions={actions} invalidValues={props.marks.values} defaultColumns={DEFAULT_MATCHUP_COLUMNS} />
}

// value list for an `in` operator: a constant multi-select plus (in the editor) removable column references
function InListConfig(props: {
	items: F.InListItem[]
	setItems: (update: React.SetStateAction<F.InListItem[]>) => void
	column: string | undefined
	allowedEnumValues?: string[]
	comparableColumns: ComboBoxOption<string>[]
	allowColumns: boolean
	restrictValueSize?: boolean
	title?: string
	ariaLabel?: string
	emptyLabel?: string
	className?: string
	marks?: EditFrame.NodeMarks
	ref?: React.ForwardedRef<ComboBoxHandle>
}) {
	const cfg = ConfigClient.useEffectiveColConfig()
	const primitives = props.items.filter((i) => !F.isColumnListItem(i)) as (string | null)[]
	const columns = props.items.filter(F.isColumnListItem)
	const marks = props.marks

	const setPrimitives: React.Dispatch<React.SetStateAction<(string | null)[]>> = (update) =>
		props.setItems((prev) => {
			const prevPrimitives = prev.filter((i) => !F.isColumnListItem(i)) as (string | null)[]
			const prevColumns = prev.filter(F.isColumnListItem)
			const next = typeof update === 'function' ? update(prevPrimitives) : update
			return [...next, ...prevColumns]
		})
	const addColumn = (column: string) =>
		props.setItems((prev) =>
			prev.some((i) => F.isColumnListItem(i) && i.column === column) ? prev : [...prev, { type: 'column', column }],
		)
	const removeColumn = (column: string) => props.setItems((prev) => prev.filter((i) => !(F.isColumnListItem(i) && i.column === column)))

	const addableColumns = props.comparableColumns.filter((o) => !columns.some((c) => c.column === o.value))

	return (
		<div className={cn(props.className, 'flex flex-wrap items-center gap-1')}>
			<StringInConfig
				ref={props.ref}
				column={props.column}
				allowedValues={props.allowedEnumValues}
				restrictValueSize={props.restrictValueSize}
				title={props.title}
				ariaLabel={props.ariaLabel}
				emptyLabel={props.emptyLabel}
				className={cn(marks && primitives.some((value) => valueMarked(value, marks)) && INVALID_PICKER_CLASS)}
				values={primitives}
				setValues={setPrimitives}
			/>
			{columns.map((c) => (
				<span
					key={c.column}
					className={cn(
						'flex items-center px-2 py-1 bg-secondary rounded-md text-sm',
						marks?.columns.has(c.column) && INVALID_PART_CLASS,
					)}
				>
					{columnLabel(c.column, cfg) ?? c.column}
					<button type="button" onClick={() => removeColumn(c.column)} className="ms-1">
						<Icons.X className="h-3 w-3" />
					</button>
				</span>
			))}
			{props.allowColumns && addableColumns.length > 0 && (
				<ComboBox
					allowEmpty
					title={tr.text(F_Msgs.columnPicker())}
					placeholder={tr.text(F_Msgs.addColumnPlaceholder())}
					value={undefined}
					options={addableColumns}
					onSelect={(v) => v && addColumn(v)}
				/>
			)}
		</div>
	)
}

// `values` are canonical layer text, which is how a filter stores the layers it selects
function LayersInConfig(props: {
	values: (string | null)[]
	setValues: React.Dispatch<React.SetStateAction<(string | null)[]>>
	className?: string
	// open the layer-select dialog once on mount (a freshly added "select layers" node)
	autoOpen?: boolean
}) {
	const [open, setOpen] = React.useState(false)
	const filteredValues = props.values?.filter((v) => v !== null)

	// mirrors the comparison/apply-filter auto-open: rAF + cancel dodges the portal remount race
	React.useEffect(() => {
		if (!props.autoOpen) return
		const raf = requestAnimationFrame(() => setOpen(true))
		return () => cancelAnimationFrame(raf)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const removeValue = (layerIdToRemove: string) => {
		props.setValues((prevValues) => prevValues?.filter((layerId) => layerId !== layerIdToRemove) ?? [])
	}

	// TODO implement a useImperativeHandle call
	return (
		<div className={cn(props.className, 'space-y-2')}>
			{filteredValues.length > 0 && (
				<ul className="flex flex-wrap items-center gap-1">
					{filteredValues.map((layerId) => (
						<li key={layerId} className="flex min-w-0 items-center justify-between gap-1 px-2 py-1 bg-secondary rounded-md">
							<ShortLayerName layerId={L.readStoredLayerId(layerId)} className="text-sm" />
							<Button
								size="sm"
								variant="ghost"
								onClick={() => removeValue(layerId)}
								className="h-6 w-6 shrink-0 p-0 hover:bg-destructive/20 hover:text-destructive"
							>
								<Minus className="h-3 w-3" />
							</Button>
						</li>
					))}
				</ul>
			)}
			<div className="w-max">
				<Button size="sm" variant="outline" onClick={() => setOpen(true)} className="w-full">
					<Icons.Edit className="h-4 w-4 me-2" />
					{filteredValues.length === 0 ? tr.text(F_Msgs.selectLayers()) : tr.text(F_Msgs.editLayers())}
				</Button>
				<SelectLayersDialog
					open={open}
					onOpenChange={setOpen}
					title={tr.text(F_Msgs.selectLayers())}
					pinMode="layers"
					defaultSelected={filteredValues.map((text) => L.readStoredLayerId(text))}
					selectQueueItems={(items) =>
						props.setValues((values) =>
							Arr.union(
								values,
								items.map((items) => L.toLayerText(items.layerId!)),
							),
						)
					}
				/>
			</div>
		</div>
	)
}

function NumericValueConfig(props: {
	placeholder?: string
	className?: string
	value?: number
	setValue: (value?: number) => void
	ref?: React.ForwardedRef<Focusable & Clearable>
}) {
	const inputRef = React.useRef<HTMLInputElement>(null)
	// a committed value is a shared op, so typing is batched rather than dispatched per keystroke
	const commit = useDebouncedCommit((text: string) => props.setValue(parseNumericText(text)), 250)

	// follow a value set elsewhere, such as by another editor, unless the input already reads as that value
	React.useEffect(() => {
		const input = inputRef.current
		if (!input || commit.isPending()) return
		if (!Object.is(parseNumericText(input.value), props.value)) input.value = props.value?.toString() ?? ''
	}, [props.value, commit])

	React.useImperativeHandle(props.ref, () => ({
		...eltToFocusable(inputRef.current!),
		clear: (ephemeral) => {
			commit.cancel()
			inputRef.current!.value = ''
			if (!ephemeral) props.setValue()
		},
	}))
	return (
		<Input
			ref={inputRef}
			className={props.className}
			placeholder={props.placeholder}
			defaultValue={props.value?.toString() ?? ''}
			onChange={(e) => commit.schedule(e.target.value)}
			onBlur={commit.flush}
		/>
	)
}

function parseNumericText(text: string) {
	const trimmed = text.trim()
	return trimmed === '' ? undefined : parseFloat(trimmed)
}
