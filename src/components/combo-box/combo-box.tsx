import { Button } from '@/components/ui/button.tsx'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import * as DH from '@/lib/display-helpers.ts'
import { GenericForwardedRef } from '@/lib/react.ts'
import { cn } from '@/lib/utils'
import { Check, ChevronsUpDown, LoaderCircle } from 'lucide-react'
import React, { useImperativeHandle, useRef, useState } from 'react'

import { LOADING } from './constants.ts'

export type ComboBoxHandle = {
	open: () => void
	isOpen: boolean
}
export type ComboBoxProps<T extends string | null = string | null> = {
	allowEmpty?: boolean
	className?: string
	title: string
	inputValue?: string
	setInputValue?: (value: string) => void
	value: T | undefined
	options: (ComboBoxOption<T> | T)[] | typeof LOADING
	onSelect: (value: T | undefined) => void
}

export interface ComboBoxOption<T> {
	value: T
	label?: string
}

function ComboBox<T extends string | null>(props: ComboBoxProps<T>, ref: React.Ref<ComboBoxHandle>) {
	const NULL = useRef('__null__' + Math.floor(Math.random() * 2000))
	let options: ComboBoxOption<T>[] | typeof LOADING
	if (props.options !== LOADING && props.options.length > 0 && (typeof props.options[0] === 'string' || props.options[0] === null)) {
		options = (props.options as T[]).map((v) => ({ value: v }))
	} else {
		options = props.options as ComboBoxOption<T>[] | typeof LOADING
	}
	const btnRef = useRef<HTMLButtonElement | null>(null)
	const inputRef = useRef<HTMLInputElement | null>(null)

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
	function onSelect(value: T | undefined) {
		setOpen(false)
		props.onSelect(value)
	}

	const selectedOption = (options === LOADING ? [] : options).find((o) => o.value === props.value)
	let selectedOptionDisplay: string
	if (selectedOption?.value === null) {
		selectedOptionDisplay = DH.MISSING_DISPLAY
	} else if (selectedOption) {
		selectedOptionDisplay = selectedOption.label ?? selectedOption.value
	} else {
		selectedOptionDisplay = `Select ${props.title}...`
	}

	return (
		<Popover modal={true} open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button ref={btnRef} variant="outline" role="combobox" className={cn('w-[min] justify-between', props.className)}>
					<span>{selectedOptionDisplay}</span>
					<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[200px] p-0">
				<Command shouldFilter={!props.setInputValue}>
					<CommandInput ref={inputRef} placeholder={`Search...`} value={props.inputValue} onValueChange={props.setInputValue} />
					<CommandList>
						<CommandEmpty>No {props.title} found.</CommandEmpty>
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
							{options !== LOADING &&
								options.map((option) => (
									<CommandItem
										key={option.value}
										value={option.value === null ? NULL.current : option.value}
										onSelect={() => {
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
			</PopoverContent>
		</Popover>
	)
}

export default React.forwardRef(ComboBox) as GenericForwardedRef<ComboBoxHandle, ComboBoxProps>
