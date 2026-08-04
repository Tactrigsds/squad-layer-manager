import { ChevronDown, ChevronLeft } from 'lucide-react'

import { CommandGroup, CommandItem } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'
import { tr } from '@/systems/messages.client'

import { ALL_GROUPS, type GroupingBarEntry, type GroupPrefixRenderer, type ResolvedGroup, type ResolvedGrouping } from './options.ts'

// Mousedown is swallowed throughout so operating these never pulls focus out of the search input: the
// user's next keystroke still types into the filter.
const keepFocus = (e: React.MouseEvent) => e.preventDefault()

// One tab per group plus a leading "all" tab.
export function GroupTabs(props: { groups: readonly ResolvedGroup[]; label?: string; value: string; onChange: (group: string) => void }) {
	return (
		<div role="tablist" aria-label={props.label} className="flex shrink-0 items-center gap-1 overflow-x-auto px-1 py-1">
			{props.label && <span className="shrink-0 pr-1 text-xs text-muted-foreground">{props.label}</span>}
			{[{ key: ALL_GROUPS, label: tr.text(UI_Msgs.allGroups()), prefix: '' }, ...props.groups].map((group) => (
				<button
					key={group.key}
					type="button"
					role="tab"
					aria-selected={props.value === group.key}
					onMouseDown={keepFocus}
					onClick={() => props.onChange(group.key)}
					className={cn(
						'whitespace-nowrap rounded px-2 py-0.5 text-xs transition-colors',
						props.value === group.key ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
					)}
				>
					{group.label}
				</button>
			))}
		</div>
	)
}

// A grouping with more groups than a tab strip can show. It reads as its current pick and opens the list of
// groups in place of the options, which is the only control that stays usable as the group count grows.
export function GroupingFacet(props: { grouping: ResolvedGrouping; current: ResolvedGroup | undefined; onOpen: () => void }) {
	return (
		<button
			type="button"
			onMouseDown={keepFocus}
			onClick={props.onOpen}
			aria-label={tr.text(UI_Msgs.narrowByGrouping(props.grouping.label))}
			className="flex w-full shrink-0 items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
		>
			<span className="truncate">
				{props.grouping.label}:{' '}
				<span className={cn(props.current && 'font-medium text-foreground')}>
					{props.current?.label ?? tr.text(UI_Msgs.allGroups())}
				</span>
			</span>
			<ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
		</button>
	)
}

// Every grouping's control, stacked. Tab strips carry their grouping's name only when another strip could
// be mistaken for them; a lone strip's group names already say what dimension it is.
export function GroupingBar(props: {
	groupings: readonly GroupingBarEntry[]
	onPick: (grouping: string, group: string) => void
	onDrill: (grouping: string) => void
}) {
	if (props.groupings.length === 0) return null
	const nameStrips = props.groupings.filter((entry) => entry.control === 'tabs').length > 1
	return (
		<div className="flex shrink-0 flex-col divide-y border-b">
			{props.groupings.map((entry) =>
				entry.control === 'tabs' ? (
					<GroupTabs
						key={entry.grouping.key}
						groups={entry.live}
						label={nameStrips ? entry.grouping.label : undefined}
						value={entry.narrowed}
						onChange={(group) => props.onPick(entry.grouping.key, group)}
					/>
				) : (
					<GroupingFacet
						key={entry.grouping.key}
						grouping={entry.grouping}
						current={entry.live.find((group) => group.key === entry.narrowed)}
						onOpen={() => props.onDrill(entry.grouping.key)}
					/>
				),
			)}
		</div>
	)
}

// Replaces the grouping bar while a facet's list is open.
export function GroupDrillInHeader(props: { grouping: ResolvedGrouping; onBack: () => void }) {
	return (
		<div className="flex shrink-0 items-center border-b">
			<button
				type="button"
				onMouseDown={keepFocus}
				onClick={props.onBack}
				aria-label={tr.text(UI_Msgs.backToOptions())}
				className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronLeft className="h-3 w-3" />
				{props.grouping.label}
			</button>
		</div>
	)
}

// The groups themselves as list rows, so the search input filters them and the arrow keys walk them exactly
// as they do the options. Counts are what each pick would leave once the other groupings have had their say.
export function GroupDrillIn(props: {
	grouping: ResolvedGrouping
	live: readonly ResolvedGroup[]
	counts: Map<string, number>
	narrowed: string
	onPick: (group: string) => void
	total: number
}) {
	const rows = [
		{ key: ALL_GROUPS, label: tr.text(UI_Msgs.allGroups()), count: props.total },
		...props.live.map((group) => ({
			key: group.key,
			label: group.label,
			count: props.counts.get(group.key) ?? 0,
		})),
	]
	return (
		<CommandGroup>
			{rows.map((row) => (
				<CommandItem key={row.key} value={row.key} keywords={[row.label]} onSelect={() => props.onPick(row.key)}>
					<span className={cn('grow truncate', props.narrowed === row.key && 'font-medium')}>{row.label}</span>
					<span className="ml-2 shrink-0 text-xs text-muted-foreground">{row.count}</span>
				</CommandItem>
			))}
		</CommandGroup>
	)
}

// An option's label with its group shown ahead of it. `render` replaces the default badge; passing false
// for the component's renderGroupPrefix prop drops the prefix before this is ever rendered. The separating
// space is a text node rather than a margin so the rendered text reads "GC Narva", which is what a
// screen reader announces and what a test asserting on the trigger's text sees.
export function PrefixedLabel(props: { prefix?: string | null; label: React.ReactNode; render?: GroupPrefixRenderer }) {
	if (!props.prefix) return props.label
	return (
		<>
			{props.render ? props.render(props.prefix) : <span className="shrink-0 text-muted-foreground">{props.prefix}</span>} {props.label}
		</>
	)
}
