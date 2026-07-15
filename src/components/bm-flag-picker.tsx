import ComboBox from '@/components/combo-box/combo-box'
import type { ComboBoxOption } from '@/components/combo-box/combo-box'
import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { LOADING } from '@/components/combo-box/constants.ts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type * as BM from '@/models/battlemetrics.models'
import { useOrgFlags } from '@/systems/battlemetrics.client'
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
