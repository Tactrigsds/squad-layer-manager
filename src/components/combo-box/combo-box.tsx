import { useCommandState } from 'cmdk'
import { Check, ChevronsUpDown, LoaderCircle } from 'lucide-react'
import React, { useCallback, useImperativeHandle, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import * as DH from '@/lib/display-helpers.ts'
import type { Clearable, Focusable } from '@/lib/react.ts'
import { cn } from '@/lib/utils'

import { LOADING } from './constants.ts'
import { DescriptionBox, type DescriptionBoxHandle } from './description-box.tsx'
import { useComboBoxDismissal } from './dismissal.ts'
import { GroupDrillIn, GroupDrillInHeader, GroupingBar, PrefixedLabel } from './groupings.tsx'
import {
	ALL_GROUPS,
	type ComboBoxGroupingDef,
	descriptionsByItemKey,
	descriptionTitle,
	groupCounts,
	type GroupingBarEntry,
	groupingBarEntries,
	groupPrefixOf,
	type GroupPrefixRenderer,
	groupRuns,
	type GroupSelection,
	normalizeOptions,
	optionsInSelection,
	resolveGroupings,
	selectableCount,
} from './options.ts'

export type ComboBoxHandle = Focusable & Clearable
export type ComboBoxProps<T extends string | null = string | null> = {
	allowEmpty?: boolean
	className?: string
	title: string
	// text shown on the trigger when nothing is selected; defaults to `Select {title}...`
	placeholder?: string
	// placeholder inside the search input; defaults to `Search...`
	searchPlaceholder?: string
	// shown when the option list is empty; defaults to `No {title} found.`. Useful for search-driven pickers that want a
	// "type to search" hint before any query is entered.
	emptyMessage?: React.ReactNode
	inputValue?: string
	setInputValue?: (value: string) => void
	value: T | undefined
	options: (ComboBoxOption<T> | T)[] | typeof LOADING
	onSelect: (value: T | undefined) => void
	disabled?: boolean
	sort?: boolean
	// the dimensions the list can be narrowed by, in display order; see options.ts. Each gets a control once
	// two or more of its groups are live, and they intersect. The first also orders, prefixes and heads the list.
	groupings?: readonly ComboBoxGroupingDef[]
	// the group each grouping opens on. Defaults to "all"; a grouping named here whose group has no live
	// options falls back to "all".
	defaultGroups?: GroupSelection
	// how a group reads ahead of an option's label. false drops the prefix entirely.
	renderGroupPrefix?: GroupPrefixRenderer | false
	// when set, Radix won't restore focus to the trigger as the popover closes. Use when a selection
	// hands focus off to another element (e.g. the next argument), so the restore doesn't steal it back.
	preventCloseAutoFocus?: boolean
	// mount already open. for pickers summoned by another control (an "add" button that becomes this), where the
	// summoning click is the only click the user should need.
	autoOpen?: boolean
	// fired when the user dismisses the popover (escape, outside click, trigger). NOT fired when a selection closes
	// it -- `onSelect` covers that -- so a caller can tell "picked nothing" from "picked something".
	onOpenChange?: (open: boolean) => void
	children?: React.ReactNode
	ref?: React.ForwardedRef<ComboBoxHandle>
}

export interface ComboBoxOption<T> {
	value: T
	label?: React.ReactNode
	keywords?: string[]
	disabled?: boolean
	// sorts with the disabled options at the end of the list while staying interactive; for options that are
	// currently pointless (no results under the other active filters) but still carry an affordance
	sortLast?: boolean
	// longer explanatory text shown in a floating box while the option is highlighted. Text, not a node:
	// the box writes it to the DOM directly rather than rendering it (see description-box.tsx)
	description?: string
	// compact form for the selection display (trigger text, chips); the full label stays in the list
	chipLabel?: string
	// the group this option belongs to per grouping key; see the `groupings` prop. Drives which controls list
	// it and, for the first grouping, the prefix it carries. Excluded (disabled/sortLast) options keep sorting
	// to the back regardless of group.
	groups?: Record<string, string>
}

// cmdk owns the highlight (it follows both the pointer and arrow keys), so we read it rather than tracking
// hover ourselves. This renders nothing: the highlight changes on every row the pointer crosses, and the
// description box takes its content through a ref so none of that reaches the option list.
function HighlightedDescriptionSync<T extends string | null>(props: {
	options: Map<string, ComboBoxOption<T>>
	box: React.RefObject<DescriptionBoxHandle | null>
}) {
	const highlighted = useCommandState((state) => state.value) as string | undefined
	const option = highlighted ? props.options.get(highlighted) : undefined
	React.useLayoutEffect(() => {
		if (option?.description != null) props.box.current?.show(descriptionTitle(option), option.description)
		else props.box.current?.hide()
	})
	return null
}

export default function ComboBox<T extends string | null>(props: ComboBoxProps<T>) {
	const disabled = props.disabled ?? false
	const groupings = React.useMemo(() => resolveGroupings(props.groupings), [props.groupings])
	const primary = groupings.at(0)
	const options = React.useMemo(
		() =>
			normalizeOptions(
				'ComboBox',
				props.options,
				props.sort ?? true,
				primary && { key: primary.key, order: primary.groups.map((g) => g.key) },
			),
		[props.options, props.sort, primary],
	)

	const describedOptions = React.useMemo(() => descriptionsByItemKey(options === LOADING ? [] : options), [options])
	const descriptionBoxRef = useRef<DescriptionBoxHandle | null>(null)

	// the grouping controls only exist while the popover is open, so the narrowing resets with each opening
	// rather than persisting a filter the user cannot see they left behind. A default naming a group with no
	// live options falls back to "all" at render rather than where it was set, which keeps this independent
	// of load order.
	const [selection, setSelection] = useState<GroupSelection>(props.defaultGroups ?? {})
	const [drillInto, setDrillInto] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [drillQuery, setDrillQuery] = useState('')
	const resetGroups = useCallback(() => {
		setSelection(props.defaultGroups ?? {})
		setDrillInto(null)
		setDrillQuery('')
		setQuery('')
	}, [props.defaultGroups])

	const barEntries = React.useMemo(
		() => (options === LOADING ? [] : groupingBarEntries(options, groupings, selection)),
		[options, groupings, selection],
	)
	// a grouping with no control of its own narrows nothing, so what the bar shows is exactly what filters
	const narrowing = React.useMemo(() => Object.fromEntries(barEntries.map((e) => [e.grouping.key, e.narrowed])), [barEntries])
	const visibleOptions = React.useMemo(
		() => (options === LOADING ? options : optionsInSelection(options, narrowing)),
		[options, narrowing],
	)

	const drillEntry = barEntries.find((entry) => entry.grouping.key === drillInto)
	const openDrill = (grouping: string) => {
		setDrillQuery('')
		setDrillInto(grouping)
	}
	const closeDrill = () => {
		setDrillInto(null)
		setDrillQuery('')
	}
	const pickGroup = (grouping: string, group: string) => setSelection((prev) => ({ ...prev, [grouping]: group }))
	const cycleGroup = (entry: GroupingBarEntry, delta: number) => {
		const keys = [ALL_GROUPS, ...entry.live.map((g) => g.key)]
		const next = (keys.indexOf(entry.narrowed) + delta + keys.length) % keys.length
		pickGroup(entry.grouping.key, keys[next])
	}

	// the primary grouping's own control names it, so only the un-narrowed view prefixes rows
	const primaryEntry = barEntries.find((entry) => entry.grouping.key === primary?.key)
	const prefixInList = !!primaryEntry && primaryEntry.narrowed === ALL_GROUPS && props.renderGroupPrefix !== false
	const prefixRenderer = props.renderGroupPrefix === false ? undefined : props.renderGroupPrefix
	// headings only earn their space when nothing else identifies the group: not under a narrowed grouping, and
	// not in a view whose rows are already prefixed
	const suppressHeadings = !!primaryEntry && (primaryEntry.narrowed !== ALL_GROUPS || prefixInList)

	// the search input drives whichever list is showing. A caller only ever owns the option query, so a
	// drill-in filters through its own state and hands the option query back untouched on the way out.
	const callerControlsInput = props.setInputValue !== undefined
	const inputValue = drillEntry ? drillQuery : callerControlsInput ? props.inputValue : query
	const onInputChange = drillEntry ? setDrillQuery : callerControlsInput ? props.setInputValue : setQuery

	const btnRef = useRef<HTMLButtonElement | null>(null)
	const inputRef = useRef<HTMLInputElement | null>(null)
	// records whether the pending close was caused by a selection (vs. a dismiss). Reset on open, so it never
	// races the close callback. Only consulted when preventCloseAutoFocus is set.
	const selectionInitiatedRef = useRef(false)

	const [open, setOpen] = useState(!!props.autoOpen)
	const _onSelect = props.onSelect
	useImperativeHandle(
		props.ref,
		() => ({
			focus: () => {
				selectionInitiatedRef.current = false
				resetGroups()
				setOpen(true)
			},
			get isFocused() {
				return open
			},
			clear: (ephemeral) => {
				setOpen(false)
				if (!ephemeral) _onSelect(undefined)
			},
		}),
		[_onSelect, open, resetGroups],
	)
	function onSelect(value: T | undefined) {
		selectionInitiatedRef.current = true
		setOpen(false)
		_onSelect(value)
	}

	const selectedOption = React.useMemo(
		() => (options === LOADING ? [] : options).find((o) => o.value === props.value),
		[options, props.value],
	)
	let selectedOptionDisplay: React.ReactNode
	if (selectedOption?.value === null) {
		// prefer the option's own label (e.g. "(none)"), matching how the list renders it
		selectedOptionDisplay = selectedOption.label ?? DH.MISSING_DISPLAY
	} else if (selectedOption) {
		// a selection is read outside the list, where no control or heading says which group it came from, so
		// it carries its group whatever the list is currently showing
		selectedOptionDisplay = (
			<PrefixedLabel
				prefix={props.renderGroupPrefix === false ? undefined : groupPrefixOf(selectedOption, primary)}
				label={selectedOption.chipLabel ?? selectedOption.label ?? selectedOption.value}
				render={prefixRenderer}
			/>
		)
	} else {
		selectedOptionDisplay = props.value ?? props.placeholder ?? `Select ${props.title}...`
	}

	useComboBoxDismissal(
		open,
		() => {
			setOpen(false)
			props.onOpenChange?.(false)
		},
		() => {
			if (drillInto === null) return false
			closeDrill()
			return true
		},
	)

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (next) {
					selectionInitiatedRef.current = false
					resetGroups()
				}
				setOpen(next)
				props.onOpenChange?.(next)
			}}
		>
			<PopoverTrigger asChild data-combobox-trigger="">
				{React.isValidElement(props.children) ? (
					props.children
				) : (
					<Button
						data-combobox-trigger=""
						disabled={disabled}
						ref={btnRef}
						variant="outline"
						role="combobox"
						// the trigger's content is the current selection, which makes its name change as the
						// user picks values. Name it after what it selects instead, so it stays addressable.
						aria-label={props.title || undefined}
						className={cn('w-[min] justify-between overflow-hidden', props.className)}
					>
						<span className="truncate min-w-0">{selectedOptionDisplay}</span>
						<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
					</Button>
				)}
			</PopoverTrigger>
			<PopoverContent
				align="start"
				// as wide as what it hangs off, floored for the triggers that are narrower than the list needs
				// (icon buttons, table cells). A fixed width unrelated to the trigger is what made a full-width
				// field open a 200px popover and wrap every row.
				className="relative w-[var(--radix-popover-trigger-width)] min-w-50 p-0"
				// Escape belongs to the dismissal hook alone. Radix listens for it on the document too, and the
				// two cannot agree: whichever runs first re-renders the other's state out from under it, so a
				// drill-in that backed out here would still be dismissed there. Refusing unconditionally leaves
				// one owner, which is what useComboBoxDismissal already claims to be.
				onEscapeKeyDown={(e) => e.preventDefault()}
				onCloseAutoFocus={(e) => {
					if (!props.preventCloseAutoFocus) return
					// take full control of close-focus: Radix never restores. On a dismiss we reproduce the
					// default by focusing the trigger ourselves; on a selection we leave focus for the hand-off.
					e.preventDefault()
					if (!selectionInitiatedRef.current) btnRef.current?.focus()
				}}
			>
				{/* gate on open so the option elements aren't built on every render while closed --
				    option lists can be thousands of entries long */}
				{open && describedOptions.size > 0 && <DescriptionBox ref={descriptionBoxRef} placement="right" />}
				{open && (
					<Command
						shouldFilter={drillEntry ? true : !props.setInputValue}
						onKeyDown={(e) => {
							if (e.key !== 'Tab') return
							const tabbed = barEntries.find((entry) => entry.control === 'tabs')
							if (!tabbed) return
							e.preventDefault()
							cycleGroup(tabbed, e.shiftKey ? -1 : 1)
						}}
					>
						{!drillEntry && describedOptions.size > 0 && (
							<HighlightedDescriptionSync options={describedOptions} box={descriptionBoxRef} />
						)}
						<CommandInput
							ref={inputRef}
							placeholder={props.searchPlaceholder ?? 'Search...'}
							value={inputValue}
							onValueChange={onInputChange}
						/>
						{drillEntry ? (
							<GroupDrillInHeader grouping={drillEntry.grouping} onBack={closeDrill} />
						) : (
							<GroupingBar groupings={barEntries} onPick={pickGroup} onDrill={openDrill} />
						)}
						<CommandList>
							<CommandEmpty>{props.emptyMessage ?? `No ${props.title} found.`}</CommandEmpty>
							{drillEntry && options !== LOADING && (
								<GroupDrillIn
									grouping={drillEntry.grouping}
									live={drillEntry.live}
									counts={groupCounts(options, drillEntry.grouping, narrowing)}
									narrowed={drillEntry.narrowed}
									total={selectableCount(options, narrowing, drillEntry.grouping.key)}
									onPick={(group) => {
										pickGroup(drillEntry.grouping.key, group)
										closeDrill()
									}}
								/>
							)}
							{!drillEntry && options === LOADING && (
								<CommandGroup>
									<CommandItem>
										<LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
									</CommandItem>
								</CommandGroup>
							)}
							{!drillEntry && options !== LOADING && props.allowEmpty && (
								<CommandGroup>
									<CommandItem
										value={DH.MISSING_DISPLAY}
										onSelect={() => {
											if (!props.allowEmpty) return
											onSelect(undefined)
										}}
									>
										<Check className={cn('mr-2 h-4 w-4', props.value === undefined ? 'opacity-100' : 'opacity-0')} />
										{DH.MISSING_DISPLAY}
									</CommandItem>
								</CommandGroup>
							)}
							{!drillEntry &&
								visibleOptions !== LOADING &&
								groupRuns(visibleOptions, primary, suppressHeadings).map((run, i) => (
									<CommandGroup key={run.heading ?? `run-${i}`} heading={run.heading}>
										{run.options.map((option) => (
											<CommandItem
												key={option.value}
												value={option.value ?? undefined}
												keywords={option.keywords}
												disabled={option.disabled}
												onSelect={() => {
													if (option.disabled) return
													onSelect(option.value)
												}}
											>
												<Check
													className={cn('mr-2 h-4 w-4 shrink-0', props.value === option.value ? 'opacity-100' : 'opacity-0')}
												/>
												{/* a row is one line: too long ellipsizes rather than wrapping the list into a wall of text */}
												<span className="min-w-0 flex-1 truncate">
													<PrefixedLabel
														prefix={prefixInList ? groupPrefixOf(option, primary) : undefined}
														label={option.label ?? (option.value === null ? DH.NULL_DISPLAY : option.value)}
														render={prefixRenderer}
													/>
												</span>
											</CommandItem>
										))}
									</CommandGroup>
								))}
						</CommandList>
					</Command>
				)}
			</PopoverContent>
		</Popover>
	)
}
