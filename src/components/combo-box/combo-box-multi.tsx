import { Popover, PopoverContent, PopoverTrigger } from '@radix-ui/react-popover'
import { CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from 'cmdk'
import { Check, ChevronsUpDown, Command, LoaderCircle } from 'lucide-react'
import React, { useImperativeHandle, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import * as DisplayHelpers from '@/lib/display-helpers.ts'
import { GenericForwardedRef, SetStateCallback } from '@/lib/react.ts'
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
	options: (ComboBoxOption<T> | T)[] | typeof LOADING
	onSelect: React.Dispatch<React.SetStateAction<T[]>>
}

function ComboBoxMulti<T extends string | null>(props: ComboBoxMultiProps<T>, ref: React.ForwardedRef<ComboBoxHandle>) {
	const NULL = useRef('__null__' + Math.floor(Math.random() * 2000))
	const { values } = props
	const [open, setOpen] = useState(false)
	const openRef = useRef(open)
	openRef.current = open
	useImperativeHandle(ref, () => ({
		open: () => {
			setOpen(true)
		},
		get isOpen() {
			return openRef.current
		},
	}))

	function onSelect(updater: SetStateCallback<T[]>) {
		setOpen(false)
		props.onSelect(updater)
	}

	let options: ComboBoxOption<T>[] | typeof LOADING
	if (props.options !== LOADING && props.options.length > 0 && (typeof props.options[0] === 'string' || props.options[0] === null)) {
		options = (props.options as T[]).map((v) => ({ value: v }))
	} else {
		options = props.options as ComboBoxOption<T>[] | typeof LOADING
	}

	let valuesDisplay = values.length > 0 ? values.join(',') : 'Select...'
	if (valuesDisplay.length > 25) {
		valuesDisplay = valuesDisplay.slice(0, 25) + '...'
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" role="combobox" aria-expanded={open} className="max-w-[400px] justify-between font-mono">
					{valuesDisplay}
					<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[200px] p-0">
				<Command>
					<CommandInput placeholder="Search framework..." />
					<CommandList>
						<CommandEmpty>No framework found.</CommandEmpty>
						<CommandGroup>
							{options === LOADING && (
								<CommandItem>
									<LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
								</CommandItem>
							)}
							{options !== LOADING &&
								options.map((option) => (
									<CommandItem
										key={option.value}
										value={option.value === null ? NULL.current : option.value}
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
										{option === null ? DisplayHelpers.NULL_DISPLAY : option.label}
									</CommandItem>
								))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}

export default React.forwardRef(ComboBoxMulti) as GenericForwardedRef<ComboBoxHandle, ComboBoxMultiProps>
