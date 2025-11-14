import { Check, CheckCheck, ChevronsUpDown, LoaderCircle, Trash2, Undo2, X } from 'lucide-react'
import React, { useEffect, useImperativeHandle, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import * as DisplayHelpers from '@/lib/display-helpers.ts'
import { cn } from '@/lib/utils'

import { ComboBoxHandle, ComboBoxOption } from './combo-box.tsx'
import { LOADING } from './constants.ts'

export type ComboBoxMultiProps<T extends string | null = string | null> = {
	className?: string
	title?: string
	inputValue?: string
	setInputValue?: (value: string) => void
	values: T[]
	selectionLimit?: number
	disabled?: boolean
	options: (ComboBoxOption<T> | T)[] | typeof LOADING
	onSelect: React.Dispatch<React.SetStateAction<T[]>>
	ref?: React.ForwardedRef<ComboBoxHandle>
	restrictValueSize?: boolean
	selectOnClose?: boolean
	reset?: boolean | T[]
	children?: React.ReactNode
}

export default function ComboBoxMulti<T extends string | null>(props: ComboBoxMultiProps<T>) {
	const NULL = useRef('__null__' + Math.floor(Math.random() * 2000))
	const { values, selectionLimit, disabled, onSelect: _onSelect, selectOnClose = false, reset } = props
	const [open, _setOpen] = useState(false)
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
		if (selectOnClose) {
			setInternalValues(values)
		}
	}, [values, selectOnClose])

	const setOpen = React.useCallback((value: boolean) => {
		if (value) {
			// When opening, store the initial values for potential reset (only if reset is true, not an array)
			if (reset === true) {
				setInitialValues(selectOnClose ? internalValues : values)
			}
		} else {
			// When closing, if selectOnClose is true, apply internal state to props
			if (selectOnClose) {
				_onSelect(internalValues)
			}
		}
		_setOpen(value)
	}, [_onSelect, internalValues, selectOnClose, reset, values])

	const restrictValueSize = props.restrictValueSize ?? true
	useImperativeHandle(props.ref, () => ({
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
	}), [open, _onSelect, selectOnClose, setOpen])

	function onSelect(updater: React.SetStateAction<T[]>) {
		if (selectOnClose) {
			// Use internal state when selectOnClose is true
			setInternalValues((currentValues) => {
				const newValues = typeof updater === 'function' ? updater(currentValues) : updater
				if (selectionLimit && newValues.length > selectionLimit) {
					return currentValues
				}
				return newValues
			})
		} else {
			// Use props directly when selectOnClose is false
			props.onSelect((currentValues) => {
				const newValues = typeof updater === 'function' ? updater(currentValues) : updater
				if (selectionLimit && newValues.length > selectionLimit) {
					return currentValues
				}
				return newValues
			})
		}
	}

	let options: ComboBoxOption<T>[] | typeof LOADING
	if (props.options === LOADING) {
		options = LOADING
	} else {
		options = (props.options as (T | ComboBoxOption<T>)[]).map((item): ComboBoxOption<T> =>
			typeof item === 'string' || item === null ? { value: item as T } : item
		)

		options.sort((a, b) => (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0))
	}

	// Use internal values for display when selectOnClose is true
	const displayValues = selectOnClose ? internalValues : values

	let valuesDisplay = ''
	if (!props.children) {
		if (displayValues.length > 0) {
			const displayText = displayValues
				.map((value) => {
					const option = options !== LOADING && options.find((opt) => opt.value === value)
					return option ? (option.label ?? option.value) : value
				})
				.join(', ')

			valuesDisplay = selectionLimit ? `${displayText} (${displayValues.length}/${selectionLimit})` : displayText
		} else {
			valuesDisplay = 'Select...'
		}

		const restrictSize = props.restrictValueSize ? 25 : 100
		if (valuesDisplay.length > restrictSize) {
			valuesDisplay = valuesDisplay.slice(0, restrictSize) + '...'
		}
	}
	// we don't fully unbound the size here, just relax the limit
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				{props.children ?? (
					<Button
						variant="outline"
						disabled={disabled}
						role="combobox"
						aria-expanded={open}
						className={cn(props.className, restrictValueSize && 'max-w-[400px]', 'justify-between font-mono')}
					>
						<span className="grow-1 overflow-hidden text-ellipsis">
							{valuesDisplay}
						</span>
						<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
					</Button>
				)}
			</PopoverTrigger>
			<PopoverContent align="start" className="min-w-[600px] p-0 overflow-hidden">
				<div className="flex h-[400px]">
					{/* Left Column - Available Options */}
					<div className="flex-1 border-r">
						<Command shouldFilter={!props.setInputValue}>
							<CommandInput value={props.inputValue} onValueChange={props.setInputValue} placeholder="Search options..." />
							<CommandList>
								<CommandEmpty>No results found.</CommandEmpty>
								<CommandGroup>
									{options === LOADING && (
										<CommandItem>
											<LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
											Loading...
										</CommandItem>
									)}
									{options !== LOADING
										&& options.map((option) => (
											<CommandItem
												key={option.value}
												value={option.value === null ? NULL.current : option.value}
												disabled={option.disabled
													|| (selectionLimit ? values.length >= selectionLimit && !values.includes(option.value) : false)}
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
												<Check className={cn('mr-2 h-4 w-4', displayValues.includes(option.value) ? 'opacity-100' : 'opacity-0')} />
												{option.label ?? (option.value === null ? DisplayHelpers.NULL_DISPLAY : option.value)}
											</CommandItem>
										))}
								</CommandGroup>
							</CommandList>
						</Command>
					</div>

					{/* Right Column - Selected Items */}
					<div className="flex-1 flex flex-col">
						<div className="p-2 border-b flex items-center justify-between">
							<span className="text-sm font-medium">
								Selected {props.title ? props.title + 's ' : ''}({displayValues.length}
								{selectionLimit ? `/${selectionLimit}` : ''})
							</span>
							<span className="flex items-center space-x-1">
								{reset && (() => {
									// Determine what values to reset to
									const resetToValues = Array.isArray(reset) ? reset : initialValues
									// Filter to only include those that still exist in options
									const availableValues = options !== LOADING ? options.map(opt => opt.value) : []
									const resetValues = resetToValues.filter(val => availableValues.includes(val))
									// Check if current state matches reset state
									const currentSet = new Set(displayValues)
									const resetSet = new Set(resetValues)
									const isIdentical = currentSet.size === resetSet.size
										&& [...currentSet].every(val => resetSet.has(val))

									return (
										<Button
											variant="ghost"
											size="sm"
											onClick={() => onSelect(resetValues)}
											disabled={isIdentical}
											className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
											title="Reset to Initial"
										>
											<Undo2 className="h-4 w-4" />
										</Button>
									)
								})()}
								{options !== LOADING && options.length > 0 && displayValues.length < options.length && (
									<Button
										variant="ghost"
										size="sm"
										onClick={() => {
											const allValues = options
												.filter(opt => !opt.disabled)
												.map(opt => opt.value)
												.filter(val => !selectionLimit || displayValues.length + (displayValues.includes(val) ? 0 : 1) <= selectionLimit)
											onSelect(allValues)
										}}
										className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
										title="Select All"
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
										title="Clear All"
									>
										<Trash2 className="h-4 w-4" />
									</Button>
								)}
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setOpen(false)}
									className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
									title="Close"
								>
									<X className="h-4 w-4" />
								</Button>
							</span>
						</div>
						<div className="flex-1 overflow-y-auto p-2 space-y-1">
							{displayValues.length === 0
								? (
									<div className="text-sm text-muted-foreground text-center py-8">
										No items selected
									</div>
								)
								: (
									displayValues.map((value) => {
										const option = options !== LOADING && options.find((opt) => opt.value === value)
										const displayText = option ? (option.label ?? option.value) : value
										return (
											<div
												key={value}
												className="flex items-center justify-between p-2 bg-muted rounded-sm text-sm cursor-pointer"
												onMouseDown={(e) => {
													if (e.button === 1) { // Middle mouse button
														e.preventDefault()
														onSelect((prevValues) => prevValues.filter((v) => v !== value))
													}
												}}
											>
												<span className="flex-1 truncate">
													{displayText === null ? DisplayHelpers.NULL_DISPLAY : displayText}
												</span>
												<Button
													variant="ghost"
													size="sm"
													onClick={() => {
														onSelect((prevValues) => prevValues.filter((v) => v !== value))
													}}
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
				</div>
			</PopoverContent>
		</Popover>
	)
}
