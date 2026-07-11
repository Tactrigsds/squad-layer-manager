import ComboBox from '@/components/combo-box/combo-box'
import type { ComboBoxOption } from '@/components/combo-box/combo-box'
import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { LOADING } from '@/components/combo-box/constants.ts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type * as BM from '@/models/battlemetrics.models'
import { useOrgFlags } from '@/systems/battlemetrics.client'
import * as DndKit from '@/systems/dndkit.client'
import * as Icons from 'lucide-react'
import React from 'react'

// a compact colored badge matching how flags are rendered elsewhere (see player-details-window)
export function FlagBadge({ flag, className }: { flag: BM.PlayerFlag; className?: string }) {
	return (
		<span
			className={cn('inline-flex items-center gap-0.5 rounded px-1 py-0 text-xs font-medium leading-tight', className)}
			style={{ backgroundColor: flag.color ? `${flag.color}33` : undefined, color: flag.color ?? undefined }}
			title={flag.description ?? undefined}
		>
			{flag.icon && <span className="material-symbols-outlined leading-none" style={{ fontSize: '13px' }}>{flag.icon}</span>}
			{flag.name}
		</span>
	)
}

// shows a resolved flag badge if the id is known, otherwise the raw id (so stale/unknown ids stay visible + removable)
export function FlagLabel({ id, flags }: { id: string; flags: BM.PlayerFlag[] | undefined }) {
	const flag = flags?.find((f) => f.id === id)
	if (flag) return <FlagBadge flag={flag} />
	return <span className="font-mono text-xs text-muted-foreground">{id}</span>
}

function useFlagOptions(): ComboBoxOption<string>[] | typeof LOADING {
	const orgFlags = useOrgFlags()
	return React.useMemo(() => {
		if (!orgFlags) return LOADING
		return orgFlags.map((flag): ComboBoxOption<string> => ({
			value: flag.id,
			label: <FlagBadge flag={flag} />,
			keywords: [flag.name, ...(flag.description ? [flag.description] : [])],
		}))
	}, [orgFlags])
}

function toArrayUpdate<T>(prev: T[], next: React.SetStateAction<T[]>): T[] {
	return typeof next === 'function' ? (next as (p: T[]) => T[])(prev) : next
}

// unordered multi-select of flags (e.g. playerFlagsRequiringNote).
// a custom trigger is required because ComboBoxMulti's default trigger stringifies option labels (which are react nodes here).
export function BmFlagMultiSelect(
	{ value, onChange, disabled, className }: {
		value: string[]
		onChange: (next: string[]) => void
		disabled?: boolean
		className?: string
	},
) {
	const options = useFlagOptions()
	const orgFlags = useOrgFlags()
	return (
		<ComboBoxMulti
			title="Flag"
			values={value}
			options={options}
			disabled={disabled}
			onSelect={(next) => onChange(toArrayUpdate(value, next))}
		>
			<Button
				type="button"
				variant="outline"
				role="combobox"
				disabled={disabled}
				className={cn('h-auto min-h-9 w-full justify-between', className)}
			>
				<span className="flex flex-wrap items-center gap-1 min-w-0">
					{value.length === 0
						? <span className="text-muted-foreground">Select flags...</span>
						: value.map((id) => <FlagLabel key={id} id={id} flags={orgFlags} />)}
				</span>
				<Icons.ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
			</Button>
		</ComboBoxMulti>
	)
}

// ordered list of flags with add / drag-to-reorder / remove (e.g. playerFlagColorHierarchy where order = priority)
export function BmFlagOrderedList(
	{ value, onChange, disabled }: { value: string[]; onChange: (next: string[]) => void; disabled?: boolean },
) {
	const orgFlags = useOrgFlags()
	const options = useFlagOptions()

	// only offer flags not already in the list
	const addOptions = options === LOADING ? LOADING : options.filter((o) => !value.includes(o.value))

	// drag-to-reorder via the shared dnd-kit provider. The handler stays stable (registered once) but reads the latest
	// value/onChange off a ref, so reordering doesn't depend on re-registering on every edit.
	const stateRef = React.useRef({ value, onChange })
	stateRef.current = { value, onChange }
	DndKit.useDragEnd(React.useCallback((evt) => {
		const { active, over } = evt
		if (active.type !== 'bm-flag' || !over) return
		const slot = over.slots.find((s) => s.dragItem.type === 'bm-flag')
		if (!slot) return
		const targetId = String(slot.dragItem.id)
		if (targetId === active.id) return
		const { value, onChange } = stateRef.current
		if (!value.includes(active.id)) return
		const without = value.filter((id) => id !== active.id)
		let insertAt = without.indexOf(targetId)
		if (insertAt < 0) return
		if (slot.position === 'after') insertAt += 1
		onChange([...without.slice(0, insertAt), active.id, ...without.slice(insertAt)])
	}, []))

	return (
		<div className="space-y-1.5">
			{value.length === 0 && <p className="text-xs text-muted-foreground">No flags configured.</p>}
			<ol>
				{value.map((id, idx) => (
					<React.Fragment key={id}>
						<FlagDropSeparator position="before" flagId={id} />
						<FlagOrderRow
							id={id}
							index={idx}
							flags={orgFlags}
							disabled={disabled}
							onRemove={() => onChange(value.filter((v) => v !== id))}
						/>
					</React.Fragment>
				))}
				{value.length > 0 && <FlagDropSeparator position="after" flagId={value[value.length - 1]} />}
			</ol>
			<ComboBox
				title="Add flag"
				value={undefined}
				options={addOptions}
				disabled={disabled}
				onSelect={(id) => {
					if (id && !value.includes(id)) onChange([...value, id])
				}}
			/>
		</div>
	)
}

// a thin gap between/around rows that highlights while a flag is dragged over it (invisible but layout-occupying otherwise)
function FlagDropSeparator({ position, flagId }: { position: 'before' | 'after'; flagId: string }) {
	const drop = DndKit.useDroppable({
		type: 'relative-to-drag-item',
		slots: [{ position, dragItem: { type: 'bm-flag', id: flagId } }],
	})
	return <li ref={drop.ref} data-over={drop.isDropTarget} className="my-0.5 h-1 rounded bg-primary data-[over=false]:invisible" />
}

function FlagOrderRow(
	{ id, index, flags, disabled, onRemove }: {
		id: string
		index: number
		flags: BM.PlayerFlag[] | undefined
		disabled?: boolean
		onRemove: () => void
	},
) {
	const drag = DndKit.useDraggable({ type: 'bm-flag', id }, { feedback: 'default', disabled })
	return (
		<li
			ref={drag.ref}
			data-dragging={drag.isDragging}
			className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-1 rounded-md bg-background data-[dragging=true]:opacity-40"
		>
			<button
				type="button"
				ref={drag.handleRef}
				className="cursor-grab rounded text-muted-foreground disabled:cursor-default"
				aria-label="Drag to reorder"
				disabled={disabled}
			>
				<Icons.GripVertical className="h-4 w-4" />
			</button>
			<span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{index + 1}.</span>
			<div className="min-w-0 overflow-hidden">
				<FlagLabel id={id} flags={flags} />
			</div>
			<Button
				type="button"
				size="icon"
				variant="ghost"
				className="h-6 w-6 text-destructive"
				disabled={disabled}
				onClick={onRemove}
			>
				<Icons.X className="h-4 w-4" />
			</Button>
		</li>
	)
}

// editor for a Record<flagId, priority> map (e.g. a flag grouping's `associations`)
export function FlagPriorityMap(
	{ value, onChange, disabled }: { value: Record<string, number>; onChange: (next: Record<string, number>) => void; disabled?: boolean },
) {
	const orgFlags = useOrgFlags()
	const options = useFlagOptions()
	const entries = Object.entries(value)
	const addOptions = options === LOADING ? LOADING : options.filter((o) => !(o.value in value))

	function setPriority(id: string, priority: number) {
		onChange({ ...value, [id]: priority })
	}
	function remove(id: string) {
		const next = { ...value }
		delete next[id]
		onChange(next)
	}
	function add(id: string) {
		const nextPriority = entries.length === 0 ? 1 : Math.max(...entries.map(([, p]) => p)) + 1
		onChange({ ...value, [id]: nextPriority })
	}

	return (
		<div className="space-y-1.5">
			{entries.length === 0 && <p className="text-xs text-muted-foreground">No flags in this group.</p>}
			<ul className="space-y-1">
				{entries.map(([id, priority]) => (
					<li key={id} className="grid grid-cols-[minmax(0,1fr)_auto_5rem_auto] items-center gap-2">
						<div className="min-w-0 overflow-hidden">
							<FlagLabel id={id} flags={orgFlags} />
						</div>
						<label className="text-xs text-muted-foreground">priority</label>
						<Input
							type="number"
							className="h-8 w-full"
							value={priority}
							disabled={disabled}
							onChange={(e) => setPriority(id, e.target.valueAsNumber)}
						/>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-6 w-6 text-destructive"
							disabled={disabled}
							onClick={() => remove(id)}
						>
							<Icons.X className="h-4 w-4" />
						</Button>
					</li>
				))}
			</ul>
			<ComboBox
				title="Add flag"
				value={undefined}
				options={addOptions}
				disabled={disabled}
				onSelect={(id) => {
					if (id) add(id)
				}}
			/>
		</div>
	)
}

// a value that is either a flag id (color taken from that flag) or a raw CSS color (e.g. "#ef4444")
export function BmFlagOrColorSelect(
	{ value, onChange, disabled }: { value: string; onChange: (next: string) => void; disabled?: boolean },
) {
	const orgFlags = useOrgFlags()
	const options = useFlagOptions()
	const isKnownFlag = orgFlags?.some((f) => f.id === value)
	return (
		<div className="flex items-center gap-2">
			<ComboBox
				className="flex-1"
				title="Flag color"
				value={isKnownFlag ? value : undefined}
				options={options}
				disabled={disabled}
				onSelect={(id) => {
					if (id) onChange(id)
				}}
			/>
			<span className="text-xs text-muted-foreground">or</span>
			<Input
				className="w-28 font-mono"
				placeholder="#rrggbb"
				value={isKnownFlag ? '' : value}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value)}
			/>
			<span
				className="h-6 w-6 rounded border shrink-0"
				style={{ backgroundColor: isKnownFlag ? orgFlags?.find((f) => f.id === value)?.color ?? undefined : value }}
			/>
		</div>
	)
}
