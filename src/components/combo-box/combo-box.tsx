import { useCommandState } from 'cmdk'
import { Check, ChevronsUpDown, LoaderCircle } from 'lucide-react'
import React, { useImperativeHandle, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import * as DH from '@/lib/display-helpers.ts'
import type { Clearable, Focusable } from '@/lib/react.ts'
import { cn } from '@/lib/utils'

import { LOADING } from './constants.ts'
import { cmdkItemKey, normalizeOptions } from './options.ts'

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
	// longer explanatory text shown in a floating box while the option is highlighted
	description?: React.ReactNode
}

// floating box describing the currently highlighted option, anchored to the option list. cmdk owns the
// highlight (it follows both the pointer and arrow keys), so we read it rather than tracking hover
// ourselves. Rendered only when some option carries a description.
function HighlightedDescription<T extends string | null>(props: { options: ComboBoxOption<T>[] }) {
	const highlighted = useCommandState((state) => state.value) as string | undefined
	const option = highlighted ? props.options.find((o) => cmdkItemKey(o) === highlighted) : undefined
	const description = option?.description
	return (
		<Popover open={description != null}>
			{/* spans the option panel, so the box sits beside the whole list rather than jumping between items */}
			<PopoverAnchor asChild>
				<div className="pointer-events-none absolute inset-0" />
			</PopoverAnchor>
			<PopoverContent
				side="right"
				align="start"
				sideOffset={6}
				onOpenAutoFocus={(e) => e.preventDefault()}
				onCloseAutoFocus={(e) => e.preventDefault()}
				className="pointer-events-none w-64 max-w-none space-y-1 p-3"
			>
				{option?.label != null && <div className="text-sm font-medium font-mono break-words">{option.label}</div>}
				<div className="text-xs text-muted-foreground break-words">{description}</div>
			</PopoverContent>
		</Popover>
	)
}

export default function ComboBox<T extends string | null>(props: ComboBoxProps<T>) {
	const disabled = props.disabled ?? false
	const options = React.useMemo(
		() => normalizeOptions('ComboBox', props.options, props.sort ?? true),
		[props.options, props.sort],
	)

	const hasDescriptions = options !== LOADING && options.some((o) => o.description != null)

	const btnRef = useRef<HTMLButtonElement | null>(null)
	const inputRef = useRef<HTMLInputElement | null>(null)
	// records whether the pending close was caused by a selection (vs. a dismiss). Reset on open, so it never
	// races the close callback. Only consulted when preventCloseAutoFocus is set.
	const selectionInitiatedRef = useRef(false)

	const [open, setOpen] = useState(!!props.autoOpen)
	const _onSelect = props.onSelect
	useImperativeHandle(props.ref, () => ({
		focus: () => {
			selectionInitiatedRef.current = false
			setOpen(true)
		},
		get isFocused() {
			return open
		},
		clear: (ephemeral) => {
			setOpen(false)
			if (!ephemeral) _onSelect(undefined)
		},
	}), [_onSelect, open])
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
		selectedOptionDisplay = selectedOption.label ?? selectedOption.value
	} else {
		selectedOptionDisplay = props.value ?? props.placeholder ?? `Select ${props.title}...`
	}

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (next) selectionInitiatedRef.current = false
				setOpen(next)
				props.onOpenChange?.(next)
			}}
		>
			<PopoverTrigger asChild>
				{props.children
					? props.children
					: (
						<Button
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
				className="w-50 p-0"
				onCloseAutoFocus={(e) => {
					if (!props.preventCloseAutoFocus) return
					// take full control of close-focus: Radix never restores. On a dismiss we reproduce the
					// default by focusing the trigger ourselves; on a selection we leave focus for the hand-off.
					e.preventDefault()
					if (!selectionInitiatedRef.current) btnRef.current?.focus()
				}}
			>
				{
					/* gate on open so the option elements aren't built on every render while closed --
				    option lists can be thousands of entries long */
				}
				{open && (
					<Command shouldFilter={!props.setInputValue} className="relative">
						{hasDescriptions && <HighlightedDescription options={options as ComboBoxOption<T>[]} />}
						<CommandInput
							ref={inputRef}
							placeholder={props.searchPlaceholder ?? 'Search...'}
							value={props.inputValue}
							onValueChange={props.setInputValue}
						/>
						<CommandList>
							<CommandEmpty>{props.emptyMessage ?? `No ${props.title} found.`}</CommandEmpty>
							<CommandGroup>
								{options === LOADING && (
									<CommandItem>
										<LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
									</CommandItem>
								)}
								{options !== LOADING && props.allowEmpty && (
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
								)}
								{options !== LOADING
									&& options.map((option) => (
										<CommandItem
											key={option.value}
											value={option.value ?? undefined}
											disabled={option.disabled}
											onSelect={() => {
												if (option.disabled) return
												onSelect(option.value)
											}}
										>
											<Check className={cn('mr-2 h-4 w-4', props.value === option.value ? 'opacity-100' : 'opacity-0')} />
											{option.label ?? (option.value === null ? DH.NULL_DISPLAY : option.value)}
										</CommandItem>
									))}
							</CommandGroup>
						</CommandList>
					</Command>
				)}
			</PopoverContent>
		</Popover>
	)
}
