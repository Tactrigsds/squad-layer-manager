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
import { GroupTabs, PrefixedLabel } from './group-tabs.tsx'
import {
	ALL_GROUPS,
	type ComboBoxGroupDef,
	descriptionsByItemKey,
	descriptionTitle,
	type GroupPrefixRenderer,
	groupPrefixOf,
	groupRuns,
	liveGroups,
	normalizeOptions,
	optionsInGroup,
	resolveGroups,
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
	// the option groups, in tab order. Two or more live groups turn on the tab strip; a bare string is a
	// group whose key is already its display text.
	groups?: readonly (ComboBoxGroupDef | string)[]
	// group tab to open on. Defaults to the "all" tab; ignored when the group has no live options.
	defaultGroup?: string
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
	// key of the group this option belongs to; see the `groups` prop. Drives the tab it lists under and the
	// prefix it carries. Excluded (disabled/sortLast) options keep sorting to the back regardless of group.
	group?: string
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
	const groups = React.useMemo(() => resolveGroups(props.groups), [props.groups])
	const options = React.useMemo(
		() =>
			normalizeOptions(
				'ComboBox',
				props.options,
				props.sort ?? true,
				groups.map((g) => g.key),
			),
		[props.options, props.sort, groups],
	)

	const describedOptions = React.useMemo(() => descriptionsByItemKey(options === LOADING ? [] : options), [options])
	const descriptionBoxRef = useRef<DescriptionBoxHandle | null>(null)

	const tabs = React.useMemo(() => (options === LOADING ? [] : liveGroups(options, groups)), [options, groups])
	const showTabs = tabs.length >= 2
	// the tab strip only exists while the popover is open, so the group resets with each opening rather than
	// persisting a filter the user cannot see they left behind. A default naming a group with no live options
	// falls back to "all" here rather than at the point it was set, which keeps this independent of load order.
	const [selectedGroup, setSelectedGroup] = useState(props.defaultGroup ?? ALL_GROUPS)
	const resetActiveGroup = useCallback(() => setSelectedGroup(props.defaultGroup ?? ALL_GROUPS), [props.defaultGroup])
	const activeGroup = selectedGroup === ALL_GROUPS || tabs.some((t) => t.key === selectedGroup) ? selectedGroup : ALL_GROUPS
	const cycleGroup = (delta: number) => {
		const keys = [ALL_GROUPS, ...tabs.map((t) => t.key)]
		const next = (keys.indexOf(activeGroup) + delta + keys.length) % keys.length
		setSelectedGroup(keys[next])
	}
	const visibleOptions = React.useMemo(
		() => (options === LOADING || !showTabs ? options : optionsInGroup(options, activeGroup)),
		[options, showTabs, activeGroup],
	)
	// a group tab names its own group, so only the "all" view prefixes
	const prefixInList = showTabs && activeGroup === ALL_GROUPS && props.renderGroupPrefix !== false
	const prefixRenderer = props.renderGroupPrefix === false ? undefined : props.renderGroupPrefix
	// headings only earn their space when nothing else identifies the group: not under a group's own tab, and
	// not in an "all" view whose rows are already prefixed
	const suppressHeadings = showTabs && (activeGroup !== ALL_GROUPS || prefixInList)

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
				resetActiveGroup()
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
		[_onSelect, open, resetActiveGroup],
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
		// a selection is read outside the list, where no tab or heading says which group it came from, so it
		// carries its group whatever the list is currently showing
		selectedOptionDisplay = (
			<PrefixedLabel
				prefix={props.renderGroupPrefix === false ? undefined : groupPrefixOf(selectedOption, groups)}
				label={selectedOption.chipLabel ?? selectedOption.label ?? selectedOption.value}
				render={prefixRenderer}
			/>
		)
	} else {
		selectedOptionDisplay = props.value ?? props.placeholder ?? `Select ${props.title}...`
	}

	useComboBoxDismissal(open, () => {
		setOpen(false)
		props.onOpenChange?.(false)
	})

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (next) {
					selectionInitiatedRef.current = false
					resetActiveGroup()
				}
				setOpen(next)
				props.onOpenChange?.(next)
			}}
		>
			<PopoverTrigger asChild>
				{React.isValidElement(props.children) ? (
					React.cloneElement(props.children as React.ReactElement<Record<string, unknown>>, { 'data-combobox-trigger': '' })
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
				className="relative w-50 p-0"
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
						shouldFilter={!props.setInputValue}
						onKeyDown={(e) => {
							if (!showTabs || e.key !== 'Tab') return
							e.preventDefault()
							cycleGroup(e.shiftKey ? -1 : 1)
						}}
					>
						{describedOptions.size > 0 && <HighlightedDescriptionSync options={describedOptions} box={descriptionBoxRef} />}
						<CommandInput
							ref={inputRef}
							placeholder={props.searchPlaceholder ?? 'Search...'}
							value={props.inputValue}
							onValueChange={props.setInputValue}
						/>
						{showTabs && <GroupTabs groups={tabs} value={activeGroup} onChange={setSelectedGroup} />}
						<CommandList>
							<CommandEmpty>{props.emptyMessage ?? `No ${props.title} found.`}</CommandEmpty>
							{options === LOADING && (
								<CommandGroup>
									<CommandItem>
										<LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
									</CommandItem>
								</CommandGroup>
							)}
							{options !== LOADING && props.allowEmpty && (
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
							{visibleOptions !== LOADING &&
								groupRuns(visibleOptions, suppressHeadings).map((run, i) => (
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
												<Check className={cn('mr-2 h-4 w-4', props.value === option.value ? 'opacity-100' : 'opacity-0')} />
												<PrefixedLabel
													prefix={prefixInList ? groupPrefixOf(option, groups) : undefined}
													label={option.label ?? (option.value === null ? DH.NULL_DISPLAY : option.value)}
													render={prefixRenderer}
												/>
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
