import * as Icons from 'lucide-react'
import React from 'react'

import ComboBox from '@/components/combo-box/combo-box'
import { Comparison } from '@/components/filter-card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useDebounced } from '@/hooks/use-debounce'
import type * as Rx from '@/lib/rxjs'
import * as LC_Msgs from '@/messages/layer-columns.messages'
import type * as F from '@/models/filter.models'
import type * as LQY from '@/models/layer-queries.models'
import { LAYERS_QUERY_SORT_DIRECTION } from '@/models/layer-queries.models'
import * as ConfigClient from '@/systems/config.client'
import * as DndKit from '@/systems/dndkit.client'
import { tr } from '@/systems/messages.client'

type LayerTableConfig = LQY.LayerTableConfig

// a fresh comparison for a new "extra menu item": column unset so the user picks it in the widget
function blankComp(): F.EditableCompNode {
	return {
		type: 'eq',
		neg: false,
		args: [
			{ type: 'column', column: undefined },
			{ type: 'value', value: undefined },
		],
	}
}

export default function LayerTableConfigEditor({
	value,
	onChange,
	reset$,
}: {
	value: LayerTableConfig
	onChange: (next: LayerTableConfig) => void
	reset$: Rx.Subject<void>
}) {
	const cfg = ConfigClient.useEffectiveColConfig()
	const columnOptions = cfg ? Object.values(cfg.defs).map((d) => ({ value: d.name, label: d.displayName ?? d.name })) : []

	function patch(next: Partial<LayerTableConfig>) {
		onChange({ ...value, ...next })
	}

	return (
		<div className="space-y-5">
			<ColumnsSection value={value} patch={patch} columnOptions={columnOptions} />
			<SortSection value={value} patch={patch} columnOptions={columnOptions} reset$={reset$} />
			<ExtraMenuItemsSection value={value} patch={patch} />
		</div>
	)
}

function SectionLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
	return (
		<div className="space-y-0.5">
			<Label className="text-sm font-semibold">{children}</Label>
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
		</div>
	)
}

function ColumnsSection({
	value,
	patch,
	columnOptions,
}: {
	value: LayerTableConfig
	patch: (next: Partial<LayerTableConfig>) => void
	columnOptions: { value: string; label: string }[]
}) {
	const columns = value.orderedColumns
	const addOptions = columnOptions.filter((o) => !columns.some((c) => c.name === o.value))

	// drag-to-reorder via the shared dnd-kit provider (see dndkit.client). The handler stays stable (registered once)
	// but reads the latest columns/patch off a ref, so reordering doesn't depend on re-registering on every edit.
	const stateRef = React.useRef({ columns, patch })
	stateRef.current = { columns, patch }
	DndKit.useDragEnd(
		React.useCallback((evt) => {
			const { active, over } = evt
			if (active.type !== 'layer-table-column' || !over) return
			const slot = over.slots.find((s) => s.dragItem.type === 'layer-table-column')
			if (!slot) return
			const targetName = String(slot.dragItem.id)
			if (targetName === active.id) return
			const { columns, patch } = stateRef.current
			const moved = columns.find((c) => c.name === active.id)
			if (!moved) return
			const without = columns.filter((c) => c.name !== active.id)
			let insertAt = without.findIndex((c) => c.name === targetName)
			if (insertAt < 0) return
			if (slot.position === 'after') insertAt += 1
			patch({ orderedColumns: [...without.slice(0, insertAt), moved, ...without.slice(insertAt)] })
		}, []),
	)

	function setVisible(name: string, visible: boolean) {
		patch({ orderedColumns: columns.map((c) => (c.name === name ? { ...c, visible } : c)) })
	}
	function remove(name: string) {
		patch({ orderedColumns: columns.filter((c) => c.name !== name) })
	}

	return (
		<div className="space-y-1.5">
			<SectionLabel hint={tr.text(LC_Msgs.columnsHint())}>{tr.text(LC_Msgs.columnsHeading())}</SectionLabel>
			{columns.length === 0 && <p className="text-xs text-muted-foreground">{tr.text(LC_Msgs.noColumnsConfigured())}</p>}
			<ol>
				{columns.map((col, idx) => (
					<React.Fragment key={col.name}>
						<ColumnDropSeparator position="before" columnName={col.name} />
						<ColumnRow col={col} index={idx} onToggleVisible={(v) => setVisible(col.name, v)} onRemove={() => remove(col.name)} />
					</React.Fragment>
				))}
				{columns.length > 0 && <ColumnDropSeparator position="after" columnName={columns[columns.length - 1].name} />}
			</ol>
			<ComboBox
				title={tr.text(LC_Msgs.addColumn())}
				value={undefined}
				options={addOptions}
				onSelect={(name) => {
					if (name && !columns.some((c) => c.name === name)) patch({ orderedColumns: [...columns, { name }] })
				}}
			/>
		</div>
	)
}

// a thin gap between/around rows that highlights while a column is dragged over it (invisible but layout-occupying otherwise)
function ColumnDropSeparator({ position, columnName }: { position: 'before' | 'after'; columnName: string }) {
	const drop = DndKit.useDroppable({
		type: 'relative-to-drag-item',
		slots: [{ position, dragItem: { type: 'layer-table-column', id: columnName } }],
	})
	return <li ref={drop.ref} data-over={drop.isDropTarget} className="my-0.5 h-1 rounded bg-primary data-[over=false]:invisible" />
}

function ColumnRow({
	col,
	index,
	onToggleVisible,
	onRemove,
}: {
	col: { name: string; visible?: boolean }
	index: number
	onToggleVisible: (visible: boolean) => void
	onRemove: () => void
}) {
	const drag = DndKit.useDraggable({ type: 'layer-table-column', id: col.name }, { feedback: 'default' })
	return (
		<li
			ref={drag.ref}
			data-dragging={drag.isDragging}
			className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-1 rounded-md bg-background data-[dragging=true]:opacity-40"
		>
			<button
				type="button"
				ref={drag.handleRef}
				className="cursor-grab rounded text-muted-foreground"
				aria-label={tr.text(LC_Msgs.dragToReorder())}
			>
				<Icons.GripVertical className="h-4 w-4" />
			</button>
			<span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{index + 1}.</span>
			<span className="min-w-0 truncate font-mono text-sm">{col.name}</span>
			<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<Switch checked={col.visible ?? true} onCheckedChange={onToggleVisible} />
				{tr.text(LC_Msgs.visibleByDefault())}
			</label>
			<Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={onRemove}>
				<Icons.X className="h-4 w-4" />
			</Button>
		</li>
	)
}

function SortSection({
	value,
	patch,
	columnOptions,
	reset$,
}: {
	value: LayerTableConfig
	patch: (next: Partial<LayerTableConfig>) => void
	columnOptions: { value: string; label: string }[]
	reset$: Rx.Subject<void>
}) {
	const sort = value.defaultSortBy

	return (
		<div className="space-y-1.5">
			<SectionLabel hint={tr.text(LC_Msgs.defaultSortHint())}>{tr.text(LC_Msgs.defaultSortHeading())}</SectionLabel>
			<div className="flex flex-wrap items-center gap-2">
				<Select
					value={sort.type}
					onValueChange={(type) => {
						if (type === sort.type) return
						patch({ defaultSortBy: type === 'random' ? { type: 'random' } : { type: 'column', sortBy: '', direction: 'ASC' } })
					}}
				>
					<SelectTrigger className="w-[140px]">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="random">{tr.text(LC_Msgs.sortRandom())}</SelectItem>
						<SelectItem value="column">{tr.text(LC_Msgs.sortColumn())}</SelectItem>
					</SelectContent>
				</Select>

				{sort.type === 'random' && (
					<SeedInput
						reset$={reset$}
						seed={sort.seed}
						onChange={(seed) => patch({ defaultSortBy: { type: 'random', seed: seed || undefined } })}
					/>
				)}

				{sort.type === 'column' && (
					<>
						<ComboBox
							title={tr.text(LC_Msgs.columnPicker())}
							className="w-[200px]"
							value={sort.sortBy || undefined}
							options={columnOptions}
							onSelect={(sortBy) => patch({ defaultSortBy: { ...sort, sortBy: sortBy ?? '' } })}
						/>
						<Select
							value={sort.direction ?? 'ASC'}
							onValueChange={(direction) =>
								patch({ defaultSortBy: { ...sort, direction: direction as LQY.LayersQuerySortDirection } })
							}
						>
							<SelectTrigger className="w-[130px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{LAYERS_QUERY_SORT_DIRECTION.options.map((d) => (
									<SelectItem key={d} value={d}>
										{d}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</>
				)}
			</div>
		</div>
	)
}

// uncontrolled seed input (re-mounts on reset$ so it re-reads the current value after a programmatic change)
function SeedInput({ seed, onChange, reset$ }: { seed: string | undefined; onChange: (v: string) => void; reset$: Rx.Subject<void> }) {
	const [resetKey, setResetKey] = React.useState(0)
	React.useEffect(() => {
		const sub = reset$.subscribe(() => setResetKey((k) => k + 1))
		return () => sub.unsubscribe()
	}, [reset$])
	const push = useDebounced<string>({ delay: 250, onChange })
	return (
		<input
			key={resetKey}
			className="h-9 w-[160px] rounded-md border bg-background px-3 text-sm"
			placeholder={tr.text(LC_Msgs.seedPlaceholder())}
			defaultValue={seed ?? ''}
			onChange={(e) => push(e.currentTarget.value)}
		/>
	)
}

function ExtraMenuItemsSection({ value, patch }: { value: LayerTableConfig; patch: (next: Partial<LayerTableConfig>) => void }) {
	const items = value.extraLayerSelectMenuItems ?? []

	function setItem(idx: number, node: F.EditableCompNode) {
		patch({ extraLayerSelectMenuItems: items.map((it, i) => (i === idx ? node : it)) })
	}
	function remove(idx: number) {
		const next = items.filter((_, i) => i !== idx)
		patch({ extraLayerSelectMenuItems: next.length ? next : undefined })
	}

	return (
		<div className="space-y-1.5">
			<SectionLabel hint={tr.text(LC_Msgs.extraMenuItemsHint())}>{tr.text(LC_Msgs.extraMenuItemsHeading())}</SectionLabel>
			{items.length === 0 && <p className="text-xs text-muted-foreground">{tr.text(LC_Msgs.noExtraMenuItems())}</p>}
			<div className="space-y-2">
				{items.map((item, idx) => (
					// menu items have no stable id, so index is the pragmatic key (add appends, remove filters)
					// oxlint-disable-next-line no-array-index-key
					<div key={idx} className="flex items-start gap-2 rounded-md border p-2">
						<div className="min-w-0 flex-1">
							<Comparison
								node={item as F.EditableCompNode}
								setNode={(update) => setItem(idx, typeof update === 'function' ? update(item as F.EditableCompNode) : update)}
							/>
						</div>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-8 w-8 shrink-0 text-destructive"
							onClick={() => remove(idx)}
						>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
				))}
			</div>
			<Button type="button" size="sm" variant="outline" onClick={() => patch({ extraLayerSelectMenuItems: [...items, blankComp()] })}>
				<Icons.Plus className="h-4 w-4" />
				{tr.text(LC_Msgs.addMenuItem())}
			</Button>
		</div>
	)
}
