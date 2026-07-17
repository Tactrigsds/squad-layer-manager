import ComboBox from '@/components/combo-box/combo-box'
import type { ComboBoxOption } from '@/components/combo-box/combo-box'
import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { LOADING } from '@/components/combo-box/constants.ts'
import { Button } from '@/components/ui/button'
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

// A flag id that resolves to nothing: removed from the org, or config written against a different one. Flag ids are
// uuids and tell a reader nothing, so say what is wrong instead and keep the id in the tooltip for whoever fixes it.
// The entry stays present and removable either way -- a reference is never silently dropped.
export function UnknownFlagLabel({ id }: { id: string }) {
	return <span className="text-xs italic text-muted-foreground" title={`Unknown flag: ${id}`}>Unknown flag</span>
}

// shows a resolved flag badge if the id is known, otherwise marks it unknown (never the bare uuid)
export function FlagLabel({ id, flags }: { id: string; flags: BM.PlayerFlag[] | undefined }) {
	const flag = flags?.find((f) => f.id === id)
	if (flag) return <FlagBadge flag={flag} />
	return <UnknownFlagLabel id={id} />
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

// unordered multi-select of flags (e.g. playerFlagsRequiringNote). `only` narrows the choice to a given set (and keeps
// their order), for callers where an arbitrary org flag would be meaningless.
// a custom trigger is required because ComboBoxMulti's default trigger stringifies option labels (which are react nodes here).
export function BmFlagMultiSelect(
	{ value, onChange, disabled, only, placeholder, className }: {
		value: string[]
		onChange: (next: string[]) => void
		disabled?: boolean
		only?: string[]
		placeholder?: string
		className?: string
	},
) {
	const options = useFlagOptions()
	const orgFlags = useOrgFlags()
	let selectable = options
	if (selectable !== LOADING && only) {
		const byId = new Map(selectable.map((o) => [o.value, o]))
		selectable = only.flatMap((id) => {
			const option = byId.get(id)
			return option ? [option] : []
		})
	}
	return (
		<ComboBoxMulti
			title="Flag"
			values={value}
			options={selectable}
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
						? <span className="text-muted-foreground">{placeholder ?? 'Select flags...'}</span>
						: value.map((id) => <FlagLabel key={id} id={id} flags={orgFlags} />)}
				</span>
				<Icons.ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
			</Button>
		</ComboBoxMulti>
	)
}

// single flag select. `exclude` drops flags already spoken for by a sibling row; `only` narrows the choice to a given
// set (and keeps their order), for callers where an arbitrary org flag would be meaningless.
export function BmFlagSelect(
	{ value, onChange, disabled, exclude, only, title, className }: {
		value: string | undefined
		onChange: (next: string) => void
		disabled?: boolean
		exclude?: string[]
		only?: string[]
		title?: string
		className?: string
	},
) {
	const options = useFlagOptions()
	let selectable = options
	if (selectable !== LOADING && only) {
		const byId = new Map(selectable.map((o) => [o.value, o]))
		selectable = only.flatMap((id) => {
			const option = byId.get(id)
			return option ? [option] : []
		})
	}
	if (selectable !== LOADING && exclude?.length) {
		selectable = selectable.filter((o) => o.value === value || !exclude.includes(o.value))
	}
	// an unresolved id has no option to take a label from, and ComboBox would fall back to printing the raw uuid
	if (selectable !== LOADING && value && !selectable.some((o) => o.value === value)) {
		selectable = [...selectable, { value, label: <UnknownFlagLabel id={value} />, keywords: ['unknown'] }]
	}
	return (
		<ComboBox
			className={className}
			title={title ?? 'Flag'}
			value={value}
			options={selectable}
			disabled={disabled}
			onSelect={(id) => {
				if (id) onChange(id)
			}}
		/>
	)
}
