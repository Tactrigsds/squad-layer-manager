import { Check, ChevronsUpDown, LoaderCircle, Trash2, X } from 'lucide-react'
import React, { useImperativeHandle, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import * as DisplayHelpers from '@/lib/display-helpers.ts'
import { cn } from '@/lib/utils'

import { ComboBoxHandle, ComboBoxOption } from './combo-box.tsx'
import { LOADING } from './constants.ts'

export type ComboBoxMultiProps<T extends string | null = string | null> = {
	className?: string
	title: string
	inputValue?: string
	setInputValue?: (value: string) => void
	values: T[]
	selectionLimit?: number
	disabled?: boolean
	options: (ComboBoxOption<T> | T)[] | typeof LOADING
	onSelect: React.Dispatch<React.SetStateAction<T[]>>
	ref?: React.ForwardedRef<ComboBoxHandle>
	restrictValueSize?: boolean
}

export default function ComboBoxMulti<T extends string | null>(props: ComboBoxMultiProps<T>) {
	const NULL = useRef('__null__' + Math.floor(Math.random() * 2000))
	const { values, selectionLimit, disabled, onSelect: _onSelect } = props
	const [open, setOpen] = useState(false)
	const restrictValueSize = props.restrictValueSize ?? true
	useImperativeHandle(props.ref, () => ({
		focus: () => {
			setOpen(true)
		},
		get isFocused() {
			return open
		},
		clear: () => {
			setOpen(false)
			_onSelect([])
		},
	}), [open, _onSelect])

	function onSelect(updater: React.SetStateAction<T[]>) {
		props.onSelect((currentValues) => {
			const newValues = typeof updater === 'function' ? updater(currentValues) : updater
			if (selectionLimit && newValues.length > selectionLimit) {
				return currentValues
			}
			return newValues
		})
	}

	let options: ComboBoxOption<T>[] | typeof LOADING
	if (props.options !== LOADING && props.options.length > 0 && (typeof props.options[0] === 'string' || props.options[0] === null)) {
		options = (props.options as T[]).map((v) => ({ value: v }))
	} else {
		options = props.options as ComboBoxOption<T>[] | typeof LOADING
	}

	let valuesDisplay = ''
	if (values.length > 0) {
		const displayText = values
			.map((value) => {
				const option = options !== LOADING && options.find((opt) => opt.value === value)
				return option ? (option.label ?? option.value) : value
			})
			.join(', ')

		valuesDisplay = selectionLimit ? `${displayText} (${values.length}/${selectionLimit})` : displayText
	} else {
		valuesDisplay = 'Select...'
	}

	if (restrictValueSize && valuesDisplay.length > 25) {
		valuesDisplay = valuesDisplay.slice(0, 25) + '...'
	}
	return (
		<Popover open={open} onOpenChange={setOpen} modal={true}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					disabled={disabled}
					role="combobox"
					aria-expanded={open}
					className={cn(props.className, restrictValueSize && 'max-w-[400px]', 'justify-between font-mono')}
				>
					{valuesDisplay}
					<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="min-w-[600px] p-0">
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
												disabled={selectionLimit ? values.length >= selectionLimit && !values.includes(option.value) : false}
												onSelect={() => {
													onSelect((prevValues) => {
														if (prevValues.includes(option.value)) {
															return prevValues.filter((v) => v !== option.value)
														} else {
															return [...prevValues, option.value]
														}
													})
												}}
											>
												<Check className={cn('mr-2 h-4 w-4', values.includes(option.value) ? 'opacity-100' : 'opacity-0')} />
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
								Selected {props.title ? props.title + 's ' : ''}({values.length}
								{selectionLimit ? `/${selectionLimit}` : ''})
							</span>
							{values.length > 0 && (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => onSelect([])}
									className="h-8 w-8 p-0 text-destructive hover:text-destructive"
								>
									<Trash2 className="h-4 w-4" />
								</Button>
							)}
						</div>
						<div className="flex-1 overflow-y-auto p-2 space-y-1">
							{values.length === 0
								? (
									<div className="text-sm text-muted-foreground text-center py-8">
										No items selected
									</div>
								)
								: (
									values.map((value) => {
										const option = options !== LOADING && options.find((opt) => opt.value === value)
										const displayText = option ? (option.label ?? option.value) : value
										return (
											<div
												key={value}
												className="flex items-center justify-between p-2 bg-muted rounded-sm text-sm"
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
