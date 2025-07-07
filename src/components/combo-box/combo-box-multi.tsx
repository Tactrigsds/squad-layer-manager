import { Check, ChevronsUpDown, LoaderCircle } from 'lucide-react'
import React, { useImperativeHandle, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import * as DisplayHelpers from '@/lib/display-helpers.ts'
import { cn } from '@/lib/utils'

import { ComboBoxHandle, ComboBoxOption } from './combo-box.tsx'
import { LOADING } from './constants.ts'

export type ComboBoxMultiProps<T extends string | null = string | null> = {
	allowEmpty?: boolean
	className?: string
	title: string
	inputValue?: string
	setInputValue?: (value: string) => void
	values: T[]
	selectionLimit?: number
	disabled?: boolean
	options: (ComboBoxOption<T> | T)[] | typeof LOADING
	onSelect: React.Dispatch<React.SetStateAction<T[]>>
}

function ComboBoxMulti<T extends string | null>(props: ComboBoxMultiProps<T>, ref: React.ForwardedRef<ComboBoxHandle>) {
	const NULL = useRef('__null__' + Math.floor(Math.random() * 2000))
	const { values, selectionLimit, disabled } = props
	const [open, setOpen] = useState(true)
	const openRef = useRef(open)
	openRef.current = open
	useImperativeHandle(ref, () => ({
		focus: () => {
			setOpen(true)
		},
		get isFocused() {
			return openRef.current
		},
	}))

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

	if (valuesDisplay.length > 25) {
		valuesDisplay = valuesDisplay.slice(0, 25) + '...'
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					disabled={disabled}
					role="combobox"
					aria-expanded={open}
					className={cn(props.className, 'max-w-[400px] justify-between font-mono')}
				>
					{valuesDisplay}
					<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="max-[200px] p-0">
				<Command shouldFilter={!props.setInputValue}>
					<CommandInput value={props.inputValue} onValueChange={props.setInputValue} placeholder="Search..." />
					<CommandList>
						<CommandEmpty>No results found.</CommandEmpty>
						<CommandGroup>
							{options === LOADING && (
								<CommandItem>
									<LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
								</CommandItem>
							)}
							{options !== LOADING
								&& options.map((option) => (
									<CommandItem
										key={option.value}
										value={option.value === null ? NULL.current : option.value}
										disabled={selectionLimit ? values.length >= selectionLimit && !values.includes(option.value) : false}
										onSelect={(selected) => {
											onSelect((values) => {
												const selectedValue = selected as T
												if (values.includes(selectedValue)) {
													return values.filter((v) => v !== option.value)
												} else {
													return [...values, option.value]
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
			</PopoverContent>
		</Popover>
	)
}

export default React.forwardRef(ComboBoxMulti)
