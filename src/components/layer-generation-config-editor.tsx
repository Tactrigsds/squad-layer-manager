import ComboBox from '@/components/combo-box/combo-box'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useDebounced } from '@/hooks/use-debounce'
import * as LC from '@/models/layer-columns'
import * as DndKit from '@/systems/dndkit.client'
import * as Icons from 'lucide-react'
import React from 'react'
import type * as Rx from 'rxjs'

type Config = LC.LayerGenerationConfig
type WeightEntry = { value: string; weight: number }

// Editor for globalSettings.layerGeneration. Generation walks `columnOrder` in order, picking one value per column
// weighted-randomly and discarding the candidates that don't match, so the earlier a column is, the more it shapes
// the result. Values with no configured weight are weighted DEFAULT_GENERATION_WEIGHT.
export default function LayerGenerationConfigEditor(
	{ value, onChange, reset$ }: { value: Config; onChange: (next: Config) => void; reset$: Rx.Subject<void> },
) {
	const columnOrder = value.columnOrder ?? []

	function setWeights(column: LC.WeightColumn, entries: WeightEntry[] | undefined) {
		const weights = { ...value.weights }
		if (entries?.length) weights[column] = entries
		else delete weights[column]
		onChange({ ...value, weights })
	}

	// weights survive a column being dropped from the pick order (so reordering experiments aren't destructive), but
	// they do nothing until it's picked again -- call that out rather than leaving dead config invisible
	const unpickedColumns = (Object.keys(value.weights ?? {}) as LC.WeightColumn[])
		.filter((column) => !columnOrder.includes(column) && (value.weights?.[column]?.length ?? 0) > 0)

	return (
		<div className="space-y-5">
			<ColumnOrderSection value={value} onChange={onChange} />
			{columnOrder.length === 0
				? <p className="text-xs text-muted-foreground">Add a column above to give its values weights.</p>
				: columnOrder.map((column, idx) => (
					<WeightsSection
						key={column}
						column={column}
						pickOrder={idx + 1}
						entries={value.weights?.[column] ?? []}
						onChange={(entries) => setWeights(column, entries)}
						reset$={reset$}
					/>
				))}
			{unpickedColumns.length > 0 && (
				<div className="space-y-1.5">
					<SectionLabel hint="These columns have weights but aren't in the pick order, so they have no effect. Add the column above to use them.">
						Unused weights
					</SectionLabel>
					{unpickedColumns.map((column) => (
						<div key={column} className="flex items-center gap-2 text-sm">
							<span className="font-mono">{column}</span>
							<span className="text-xs text-muted-foreground">{value.weights?.[column]?.length} values</span>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								className="h-6 text-destructive"
								onClick={() => setWeights(column, undefined)}
							>
								Discard
							</Button>
						</div>
					))}
				</div>
			)}
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

function ColumnOrderSection({ value, onChange }: { value: Config; onChange: (next: Config) => void }) {
	const columnOrder = value.columnOrder ?? []
	const addOptions = LC.WEIGHT_COLUMNS.options
		.filter((c) => !columnOrder.includes(c))
		.map((c) => ({ value: c, label: c }))

	// drag-to-reorder via the shared dnd-kit provider. the handler is registered once and reads the latest
	// state off a ref, mirroring the layer-table config editor
	const stateRef = React.useRef({ value, onChange })
	stateRef.current = { value, onChange }
	DndKit.useDragEnd(React.useCallback((evt) => {
		const { active, over } = evt
		if (active.type !== 'layer-generation-column' || !over) return
		const slot = over.slots.find((s) => s.dragItem.type === 'layer-generation-column')
		if (!slot) return
		const targetName = String(slot.dragItem.id)
		if (targetName === active.id) return
		const { value, onChange } = stateRef.current
		const order = value.columnOrder ?? []
		const moved = order.find((c) => c === active.id)
		if (!moved) return
		const without = order.filter((c) => c !== active.id)
		let insertAt = without.findIndex((c) => c === targetName)
		if (insertAt < 0) return
		if (slot.position === 'after') insertAt += 1
		onChange({ ...value, columnOrder: [...without.slice(0, insertAt), moved, ...without.slice(insertAt)] })
	}, []))

	// the column's weights are kept (see the "Unused weights" section) so dropping a column isn't destructive
	function remove(column: LC.WeightColumn) {
		onChange({ ...value, columnOrder: columnOrder.filter((c) => c !== column) })
	}

	return (
		<div className="space-y-1.5">
			<SectionLabel hint="Columns picked weighted-randomly during generation, in pick order. Each pick narrows the candidates for the ones below it, so the first column shapes the result the most.">
				Pick order
			</SectionLabel>
			{columnOrder.length === 0 && (
				<p className="text-xs text-muted-foreground">No columns configured: generation picks layers uniformly.</p>
			)}
			<ol>
				{columnOrder.map((column, idx) => (
					<React.Fragment key={column}>
						<ColumnDropSeparator position="before" column={column} />
						<ColumnRow
							column={column}
							index={idx}
							weightCount={value.weights?.[column]?.length ?? 0}
							onRemove={() => remove(column)}
						/>
					</React.Fragment>
				))}
				{columnOrder.length > 0 && <ColumnDropSeparator position="after" column={columnOrder[columnOrder.length - 1]} />}
			</ol>
			<ComboBox
				title="Add column"
				value={undefined}
				options={addOptions}
				onSelect={(column) => {
					if (column && !columnOrder.includes(column)) onChange({ ...value, columnOrder: [...columnOrder, column] })
				}}
			/>
		</div>
	)
}

function ColumnDropSeparator({ position, column }: { position: 'before' | 'after'; column: string }) {
	const drop = DndKit.useDroppable({
		type: 'relative-to-drag-item',
		slots: [{ position, dragItem: { type: 'layer-generation-column', id: column } }],
	})
	return <li ref={drop.ref} data-over={drop.isDropTarget} className="my-0.5 h-1 rounded bg-primary data-[over=false]:invisible" />
}

function ColumnRow(
	{ column, index, weightCount, onRemove }: { column: string; index: number; weightCount: number; onRemove: () => void },
) {
	const drag = DndKit.useDraggable({ type: 'layer-generation-column', id: column }, { feedback: 'default' })
	return (
		<li
			ref={drag.ref}
			data-dragging={drag.isDragging}
			className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-1 rounded-md bg-background data-[dragging=true]:opacity-40"
		>
			<button type="button" ref={drag.handleRef} className="cursor-grab rounded text-muted-foreground" aria-label="Drag to reorder">
				<Icons.GripVertical className="h-4 w-4" />
			</button>
			<span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{index + 1}.</span>
			<span className="min-w-0 truncate font-mono text-sm">{column}</span>
			<span className="text-xs text-muted-foreground">
				{weightCount === 0 ? 'no weights' : `${weightCount} weighted`}
			</span>
			<Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={onRemove}>
				<Icons.X className="h-4 w-4" />
			</Button>
		</li>
	)
}

function WeightsSection(
	{ column, pickOrder, entries, onChange, reset$ }: {
		column: LC.WeightColumn
		pickOrder: number
		entries: WeightEntry[]
		onChange: (entries: WeightEntry[] | undefined) => void
		reset$: Rx.Subject<void>
	},
) {
	const possibleValues = React.useMemo(() => LC.groupByColumnDefaultValues(column) as string[], [column])
	const addOptions = React.useMemo(
		() => possibleValues.filter((v) => !entries.some((e) => e.value === v)).map((v) => ({ value: v, label: v })),
		[possibleValues, entries],
	)

	// weights are relative, so what an admin actually wants to see is the share a value would get. the true
	// denominator depends on which values survive the filters at pick time, so this assumes every value is available:
	// the weights of the real values listed here, plus the default weight for each value that isn't listed. entries
	// for unknown values are excluded -- nothing in the pool can match them
	const knownEntries = entries.filter((e) => possibleValues.includes(e.value))
	const totalWeight = knownEntries.reduce((sum, e) => sum + e.weight, 0)
		+ LC.DEFAULT_GENERATION_WEIGHT * (possibleValues.length - knownEntries.length)

	function setWeight(value: string, weight: number) {
		onChange(entries.map((e) => (e.value === value ? { ...e, weight } : e)))
	}
	function remove(value: string) {
		const next = entries.filter((e) => e.value !== value)
		onChange(next.length ? next : undefined)
	}

	return (
		<div className="space-y-1.5">
			<SectionLabel
				hint={`Pick ${pickOrder}. Unlisted ${column} values weigh ${LC.DEFAULT_GENERATION_WEIGHT}. Shares assume every value is available in the pool.`}
			>
				{column} weights
			</SectionLabel>
			{entries.length > 0 && (
				<table className="w-full max-w-[32rem] text-sm">
					<thead>
						<tr className="text-xs text-muted-foreground">
							<th scope="col" className="text-left font-normal">Value</th>
							<th scope="col" className="text-left font-normal">Weight</th>
							<th scope="col" className="text-right font-normal">Share</th>
							<th scope="col" className="sr-only">Remove</th>
						</tr>
					</thead>
					<tbody>
						{entries.map((entry) => (
							<tr key={entry.value}>
								<td className="py-0.5 pr-2 font-mono">
									{entry.value}
									{/* a value the current layer set doesn't have (e.g. a map dropped by a game update): it can never be picked */}
									{!possibleValues.includes(entry.value) && (
										<span className="ml-1.5 text-xs font-sans text-muted-foreground" title={`No layers have this ${column} value`}>
											(unknown)
										</span>
									)}
								</td>
								<td className="py-0.5 pr-2">
									<WeightInput weight={entry.weight} onChange={(weight) => setWeight(entry.value, weight)} reset$={reset$} />
								</td>
								<td className="py-0.5 pr-2 text-right tabular-nums text-muted-foreground">
									{totalWeight > 0 && possibleValues.includes(entry.value) ? `${(entry.weight / totalWeight * 100).toFixed(1)}%` : '-'}
								</td>
								<td className="py-0.5">
									<Button
										type="button"
										size="icon"
										variant="ghost"
										className="h-6 w-6 text-destructive"
										aria-label={`Remove ${entry.value}`}
										onClick={() => remove(entry.value)}
									>
										<Icons.X className="h-4 w-4" />
									</Button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<ComboBox
				title={`Add ${column} value`}
				value={undefined}
				options={addOptions}
				onSelect={(value) => {
					if (value && !entries.some((e) => e.value === value)) {
						onChange([...entries, { value, weight: LC.DEFAULT_GENERATION_WEIGHT }])
					}
				}}
			/>
		</div>
	)
}

// uncontrolled + debounced: weights get typed digit by digit, and a controlled input would round-trip every keystroke
// through the settings document. re-mounts on reset$ so it re-reads the value after a programmatic change
function WeightInput({ weight, onChange, reset$ }: { weight: number; onChange: (weight: number) => void; reset$: Rx.Subject<void> }) {
	const [resetKey, setResetKey] = React.useState(0)
	React.useEffect(() => {
		const sub = reset$.subscribe(() => setResetKey((k) => k + 1))
		return () => sub.unsubscribe()
	}, [reset$])
	const push = useDebounced<string>({
		delay: 250,
		onChange: (raw) => {
			const parsed = Number(raw)
			if (raw.trim() === '' || Number.isNaN(parsed) || parsed < 0) return
			onChange(parsed)
		},
	})
	return (
		<input
			key={resetKey}
			type="number"
			min={0}
			step={0.01}
			className="h-8 w-[6rem] rounded-md border bg-background px-2 text-sm"
			defaultValue={weight}
			onChange={(e) => push(e.currentTarget.value)}
		/>
	)
}
