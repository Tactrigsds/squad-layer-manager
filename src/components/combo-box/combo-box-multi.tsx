import { Check, CheckCheck, ChevronsUpDown, LoaderCircle, SquareCheck, Trash2, Undo2, X } from 'lucide-react'
import React, { useEffect, useImperativeHandle, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import * as DisplayHelpers from '@/lib/display-helpers.ts'
import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'
import { tr } from '@/systems/messages.client'

import type { ComboBoxHandle, ComboBoxOption } from './combo-box.tsx'
import { LOADING } from './constants.ts'
import { DescriptionBox, type DescriptionBoxHandle } from './description-box.tsx'
import { useComboBoxDismissal } from './dismissal.ts'
import { GroupDrillIn, GroupDrillInHeader, GroupingBar, PrefixedLabel } from './groupings.tsx'
import {
	ALL_GROUPS,
	type ComboBoxGroupingDef,
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

export type ComboBoxMultiProps<T extends string | null = string | null> = {
	className?: string
	title?: string
	inputValue?: string
	setInputValue?: (value: string) => void
	values: T[]
	// trigger text when nothing is selected. Defaults to a prompt, but callers where an empty selection
	// is itself meaningful (a matchup dimension left unconstrained) can say what it means instead
	emptyLabel?: string
	selectionLimit?: number
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
	options: (ComboBoxOption<T> | T)[] | typeof LOADING
	onSelect?: React.Dispatch<React.SetStateAction<T[]>>
	ref?: React.ForwardedRef<ComboBoxHandle>
	restrictValueSize?: boolean
	// render the selection as wrapping chips in the trigger instead of one ellipsis-clipped line. with
	// restrictValueSize the chip area caps its height and scrolls; otherwise it grows with the selection.
	chipDisplay?: boolean
	selectOnClose?: boolean
	reset?: boolean | T[]
	confirm?: boolean | string
	onConfirm?: (values: T[]) => void
	children?: React.ReactNode
}

export default function ComboBoxMulti<T extends string | null>(props: ComboBoxMultiProps<T>) {
	const NULL = useRef('__null__' + Math.floor(Math.random() * 2000))
	const { values, selectionLimit, disabled, onSelect: _onSelect = () => {}, selectOnClose = false, reset } = props
	const useInternalState = selectOnClose || !!props.confirm
	const [open, _setOpen] = useState(false)
	const [selection, setSelection] = useState<GroupSelection>(props.defaultGroups ?? {})
	const [drillInto, setDrillInto] = useState<string | null>(null)
	const [drillQuery, setDrillQuery] = useState('')
	const [query, setQuery] = useState('')
	const [internalValues, setInternalValues] = useState<T[]>(values)
	const [initialValues, setInitialValues] = useState<T[]>([])
	const selectOnCloseRef = useRef(selectOnClose)

	// Throw error if selectOnClose flag changes during component lifecycle
	useEffect(() => {
		if (selectOnCloseRef.current !== selectOnClose) {
			throw new Error('selectOnClose flag cannot be changed during component lifecycle')
		}
	}, [selectOnClose])

	// Initialize internal values when component mounts or values prop changes
	useEffect(() => {
		if (useInternalState) {
			setInternalValues(values)
		}
	}, [values, useInternalState])

	const setOpen = React.useCallback(
		(value: boolean) => {
			if (value) {
				setSelection(props.defaultGroups ?? {})
				setDrillInto(null)
				setDrillQuery('')
				setQuery('')
				// When opening with confirm mode, reset internal state to current prop values
				if (props.confirm) {
					setInternalValues(values)
				}
				// When opening, store the initial values for potential reset (only if reset is true, not an array)
				if (reset === true) {
					setInitialValues(useInternalState ? internalValues : values)
				}
			} else {
				// When closing, if selectOnClose is true, apply internal state to props
				if (selectOnClose) {
					_onSelect(internalValues)
				}
			}
			_setOpen(value)
		},
		[_onSelect, internalValues, selectOnClose, useInternalState, reset, values, props.confirm, props.defaultGroups],
	)

	// opt-in, as the name says: an unset prop leaves the trigger free to use the width its container
	// gives it, and the label's ellipsis cuts only when it actually runs out
	const restrictValueSize = props.restrictValueSize ?? false
	useImperativeHandle(
		props.ref,
		() => ({
			focus: () => {
				setOpen(true)
			},
			get isFocused() {
				return open
			},
			clear: (ephemeral) => {
				if (selectOnClose) {
					setInternalValues([])
					if (!ephemeral) _onSelect([])
				} else {
					if (!ephemeral) _onSelect([])
				}
			},
		}),
		[open, _onSelect, selectOnClose, setOpen],
	)

	function onSelect(updater: React.SetStateAction<T[]>) {
		if (useInternalState) {
			setInternalValues((currentValues) => {
				const newValues = typeof updater === 'function' ? updater(currentValues) : updater
				if (selectionLimit && newValues.length > selectionLimit) {
					return currentValues
				}
				return newValues
			})
		} else {
			_onSelect((currentValues) => {
				const newValues = typeof updater === 'function' ? updater(currentValues) : updater
				if (selectionLimit && newValues.length > selectionLimit) {
					return currentValues
				}
				return newValues
			})
		}
	}

	const groupings = React.useMemo(() => resolveGroupings(props.groupings), [props.groupings])
	const primary = groupings.at(0)
	const options = React.useMemo(
		() =>
			normalizeOptions(
				'ComboBoxMulti',
				props.options,
				props.sort ?? true,
				primary && { key: primary.key, order: primary.groups.map((g) => g.key) },
			),
		[props.options, props.sort, primary],
	)
	const barEntries = React.useMemo(
		() => (options === LOADING ? [] : groupingBarEntries(options, groupings, selection)),
		[options, groupings, selection],
	)
	// see ComboBox: the picks are stored raw and coerced to live groups at render, so a default naming a
	// group with no options degrades to "all" instead of showing an empty list
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

	// the primary grouping's own control names it, so only the un-narrowed view prefixes
	const primaryEntry = barEntries.find((entry) => entry.grouping.key === primary?.key)
	const prefixInList = !!primaryEntry && primaryEntry.narrowed === ALL_GROUPS && props.renderGroupPrefix !== false
	const prefixRenderer = props.renderGroupPrefix === false ? undefined : props.renderGroupPrefix
	const suppressHeadings = !!primaryEntry && (primaryEntry.narrowed !== ALL_GROUPS || prefixInList)
	// a selection is read outside the list, where no control or heading says which group it came from
	const selectedPrefix = (option: ComboBoxOption<T> | undefined) =>
		option && props.renderGroupPrefix !== false ? groupPrefixOf(option, primary) : undefined

	// the search input drives whichever list is showing. A caller only ever owns the option query, so a
	// drill-in filters through its own state and hands the option query back untouched on the way out.
	const callerControlsInput = props.setInputValue !== undefined
	const inputValue = drillEntry ? drillQuery : callerControlsInput ? props.inputValue : query
	const onInputChange = drillEntry ? setDrillQuery : callerControlsInput ? props.setInputValue : setQuery

	// what "select all" reaches: the rows the current narrowing leaves, minus the ones nothing can pick
	const selectableVisible = React.useMemo(
		() => (visibleOptions === LOADING ? [] : visibleOptions.filter((option) => !option.disabled).map((option) => option.value)),
		[visibleOptions],
	)
	const optionsByValue = React.useMemo(() => {
		const map = new Map<T, ComboBoxOption<T>>()
		if (options !== LOADING) {
			for (const option of options) map.set(option.value, option)
		}
		return map
	}, [options])

	// the option the mouse is over (in either column) is pushed straight into the description box rather than
	// held in state: hovering restated as a render would rebuild the whole option list for every row crossed
	const descriptionBoxRef = useRef<DescriptionBoxHandle | null>(null)
	const hasDescriptions = options !== LOADING && options.some((o) => o.description != null)
	const showDescription = (value: T) => {
		const option = optionsByValue.get(value)
		if (option?.description == null) descriptionBoxRef.current?.hide()
		else descriptionBoxRef.current?.show(descriptionTitle(option), option.description)
	}
	const hideDescription = () => descriptionBoxRef.current?.hide()

	const displayValues = useInternalState ? internalValues : values

	const confirmedSet = props.confirm ? new Set(values) : null
	const hasChanges =
		confirmedSet !== null && (displayValues.length !== confirmedSet.size || displayValues.some((v) => !confirmedSet.has(v)))

	const chipDisplay = props.chipDisplay ?? false
	let valuesDisplay = ''
	// chip mode renders each selection as its own node, so only the empty-state text is precomputed here
	if (!props.children && !(chipDisplay && displayValues.length > 0)) {
		if (displayValues.length > 0) {
			const displayText = displayValues
				.map((value) => {
					const option = optionsByValue.get(value)
					const displayValue = option ? (option.chipLabel ?? option.label ?? option.value) : value
					const text = typeof displayValue === 'object' ? JSON.stringify(displayValue) : String(displayValue)
					const prefix = selectedPrefix(option)
					return prefix ? `${prefix} ${text}` : text
				})
				.join(', ')

			valuesDisplay = selectionLimit ? `${displayText} (${displayValues.length}/${selectionLimit})` : displayText
		} else {
			valuesDisplay = props.emptyLabel ?? 'Select...'
		}
	}
	const showChips = chipDisplay && displayValues.length > 0
	const trigger = (
		<PopoverTrigger asChild>
			{React.isValidElement(props.children) ? (
				React.cloneElement(props.children as React.ReactElement<Record<string, unknown>>, { 'data-combobox-trigger': '' })
			) : (
				<Button
					data-combobox-trigger=""
					variant="outline"
					disabled={disabled}
					role="combobox"
					aria-expanded={open}
					// truncation is left to the ellipsis on the label below: it cuts at the width actually
					// available, where a character count would cut at a guess about it
					// min-w-0: a flex item defaults to min-width:auto and so refuses to shrink below its
					// content, which would leave the label's ellipsis with nothing to do and let the trigger
					// push out of a flex container instead of truncating inside it.
					// props.className goes last so a caller's width can beat these defaults -- cn merges
					// tailwind conflicts last-wins, so the old ordering silently dropped them
					// chip mode grows multiline as the selection wraps, so let the button size to its content
					// (h-auto) and top-align the chevron; the parent decides how much room it gets
					className={cn(
						restrictValueSize ? 'max-w-[400px]' : 'max-w-full',
						'min-w-0 justify-between font-mono',
						showChips && 'h-auto min-h-9 items-start py-1',
						props.className,
					)}
				>
					{showChips ? (
						<span className="flex grow flex-wrap items-center gap-1">
							{displayValues.map((value) => {
								const option = optionsByValue.get(value)
								const label = option ? (option.chipLabel ?? option.label ?? option.value) : value
								return (
									<span
										key={value === null ? NULL.current : value}
										className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 text-xs font-normal"
									>
										<PrefixedLabel
											prefix={selectedPrefix(option)}
											label={label === null ? DisplayHelpers.NULL_DISPLAY : label}
											render={prefixRenderer}
										/>
									</span>
								)
							})}
							{selectionLimit && (
								<span className="self-center text-xs text-muted-foreground">
									({displayValues.length}/{selectionLimit})
								</span>
							)}
						</span>
					) : (
						<span className="grow overflow-hidden text-ellipsis">{valuesDisplay}</span>
					)}
					<ChevronsUpDown className={cn('ml-2 h-4 w-4 shrink-0 opacity-50', showChips && 'mt-1 self-start')} />
				</Button>
			)}
		</PopoverTrigger>
	)

	useComboBoxDismissal(
		open,
		() => setOpen(false),
		() => {
			if (drillInto === null) return false
			closeDrill()
			return true
		},
	)

	// we don't fully unbound the size here, just relax the limit
	return (
		<Popover open={open} onOpenChange={setOpen}>
			{trigger}
			<PopoverContent
				align="start"
				className="relative min-w-[600px] p-0"
				// see ComboBox
				onEscapeKeyDown={(e) => e.preventDefault()}
			>
				{/* gate on open so the option elements aren't built on every render while closed --
				    option lists can be thousands of entries long */}
				{open && hasDescriptions && <DescriptionBox ref={descriptionBoxRef} placement="top" />}
				{open && (
					<Command
						shouldFilter={drillEntry ? true : !props.setInputValue}
						className="flex flex-col"
						onKeyDown={(e) => {
							if (e.key !== 'Tab') return
							const tabbed = barEntries.find((entry) => entry.control === 'tabs')
							if (!tabbed) return
							e.preventDefault()
							cycleGroup(tabbed, e.shiftKey ? -1 : 1)
						}}
					>
						{/* Shared header row */}
						<div className="flex border-b shrink-0">
							{/* Left header: search input */}
							<div className="flex-1 border-r">
								<CommandInput value={inputValue} onValueChange={onInputChange} placeholder={tr.text(UI_Msgs.searchOptions())} />
							</div>
							{/* Right header: selected count + action buttons */}
							<div className="flex-1 flex items-center justify-between px-2 h-[41px]">
								<span className="text-sm font-medium">
									{tr.text(UI_Msgs.selectedCount(props.title, displayValues.length, selectionLimit))}
								</span>
								<span className="flex items-center space-x-1">
									{reset &&
										(() => {
											const resetToValues = Array.isArray(reset) ? reset : initialValues
											const resetValues = resetToValues.filter((val) => optionsByValue.has(val))
											const currentSet = new Set(displayValues)
											const resetSet = new Set(resetValues)
											const isIdentical = currentSet.size === resetSet.size && [...currentSet].every((val) => resetSet.has(val))
											return (
												<Button
													variant="ghost"
													size="sm"
													onClick={() => onSelect(resetValues)}
													disabled={isIdentical}
													className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
													title={tr.text(UI_Msgs.resetToInitial())}
												>
													<Undo2 className="h-4 w-4" />
												</Button>
											)
										})()}
									{!drillEntry && selectableVisible.some((val) => !displayValues.includes(val)) && (
										<Button
											variant="ghost"
											size="sm"
											onClick={() => {
												// adds the rows on screen to the selection rather than replacing it: under a
												// narrowed grouping the rest of the catalog is not what the user is looking at,
												// and dropping their earlier picks to reach it would be a trap
												const allValues = [...displayValues]
												for (const val of selectableVisible) {
													if (allValues.includes(val)) continue
													if (selectionLimit && allValues.length >= selectionLimit) break
													allValues.push(val)
												}
												onSelect(allValues)
											}}
											className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
											title={tr.text(UI_Msgs.selectAll())}
										>
											<CheckCheck className="h-4 w-4" />
										</Button>
									)}
									{displayValues.length > 0 && (
										<Button
											variant="ghost"
											size="sm"
											onClick={() => onSelect([])}
											className="h-8 w-8 p-0 text-destructive hover:text-destructive"
											title={tr.text(UI_Msgs.clearAll())}
										>
											<Trash2 className="h-4 w-4" />
										</Button>
									)}
									{!props.confirm && (
										<Button
											variant="ghost"
											size="sm"
											onClick={() => setOpen(false)}
											className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
											title={tr.text(UI_Msgs.close())}
										>
											<X className="h-4 w-4" />
										</Button>
									)}
								</span>
							</div>
						</div>

						{/* Lists row */}
						<div className="flex h-[340px]">
							{/* Left — available options */}
							<div className="flex-1 border-r overflow-hidden flex flex-col">
								{drillEntry ? (
									<GroupDrillInHeader grouping={drillEntry.grouping} onBack={closeDrill} />
								) : (
									<GroupingBar groupings={barEntries} onPick={pickGroup} onDrill={openDrill} />
								)}
								<CommandList className="max-h-[340px]">
									<CommandEmpty>{tr.text(UI_Msgs.noResults())}</CommandEmpty>
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
												{tr.text(UI_Msgs.loadingEllipsis())}
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
														value={option.value === null ? NULL.current : option.value}
														keywords={option.keywords}
														onMouseEnter={() => showDescription(option.value)}
														onMouseLeave={hideDescription}
														disabled={
															option.disabled ||
															(selectionLimit ? values.length >= selectionLimit && !values.includes(option.value) : false)
														}
														onSelect={() => {
															if (option.disabled) return
															onSelect((prevValues) => {
																if (prevValues.includes(option.value)) {
																	return prevValues.filter((v) => v !== option.value)
																} else {
																	return [...prevValues, option.value]
																}
															})
														}}
													>
														<Check
															className={cn(
																'mr-2 h-4 w-4',
																displayValues.includes(option.value) ? 'opacity-100' : 'opacity-0',
															)}
														/>
														<PrefixedLabel
															prefix={prefixInList ? groupPrefixOf(option, primary) : undefined}
															label={option.label ?? (option.value === null ? DisplayHelpers.NULL_DISPLAY : option.value)}
															render={prefixRenderer}
														/>
													</CommandItem>
												))}
											</CommandGroup>
										))}
								</CommandList>
							</div>

							{/* Right — selected items */}
							<div className="flex-1 overflow-y-auto p-2 space-y-1">
								{displayValues.length === 0 ? (
									<div className="text-sm text-muted-foreground text-center py-8">{tr.text(UI_Msgs.nothingSelected())}</div>
								) : (
									displayValues.map((value) => {
										const option = optionsByValue.get(value)
										const displayText = option ? (option.label ?? option.value) : value
										return (
											<div
												key={value}
												className="flex items-center justify-between p-2 bg-muted rounded-sm text-sm cursor-pointer"
												onMouseEnter={() => showDescription(value)}
												onMouseLeave={hideDescription}
												onMouseDown={(e) => {
													if (e.button === 1) {
														e.preventDefault()
														onSelect((prevValues) => prevValues.filter((v) => v !== value))
													}
												}}
											>
												<span className="flex-1 truncate">
													<PrefixedLabel
														prefix={selectedPrefix(option)}
														label={displayText === null ? DisplayHelpers.NULL_DISPLAY : displayText}
														render={prefixRenderer}
													/>
												</span>
												<Button
													variant="ghost"
													size="sm"
													onClick={() => onSelect((prevValues) => prevValues.filter((v) => v !== value))}
													className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive ml-2"
												>
													<X className="h-3 w-3" />
												</Button>
											</div>
										)
									})
								)}
							</div>
						</div>

						{/* Full-width confirm button */}
						{props.confirm && (
							<div className="border-t shrink-0">
								<Button
									variant="ghost"
									onClick={() => {
										props.onConfirm?.(displayValues)
										setOpen(false)
									}}
									disabled={!hasChanges}
									className="w-full rounded-none h-9 text-primary hover:text-primary hover:bg-primary/10 flex items-center justify-center gap-2 disabled:opacity-40"
								>
									<SquareCheck className="h-4 w-4" />
									<span className="text-sm">{typeof props.confirm === 'string' ? props.confirm : 'Confirm'}</span>
								</Button>
							</div>
						)}
					</Command>
				)}
			</PopoverContent>
		</Popover>
	)
}
