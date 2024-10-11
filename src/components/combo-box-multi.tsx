import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@radix-ui/react-popover'
import { CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from 'cmdk'
import { Check, ChevronsUpDown, Command } from 'lucide-react'
import React, { useImperativeHandle, useRef, useState } from 'react'

import { ComboBoxHandle, ComboBoxProps } from './combo-box'
import { Button } from './ui/button'

function ComboBoxMulti<T extends string | null, V = T[] | undefined>(props: ComboBoxProps<T, V>, ref: React.ForwardedRef<ComboBoxHandle>) {
	const NULL = useRef('__null__' + Math.floor(Math.random() * 2000))
	const { values, onSelect, options } = props
	const [open, setOpen] = useState(false)
	const openRef = useRef(open)
	openRef.current = open
	useImperativeHandle(ref, () => ({
		open: () => {
			console.log('opening ComboBoxMulti')
			setOpen(true)
		},
		get isOpen() {
			return openRef.current
		},
	}))
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
							{options.map((option) => (
								<CommandItem
									key={option}
									value={option === null ? NULL.current : option}
									onSelect={(selected) => {
										onSelect((values) => {
											const selectedValue = selected as T
											if (values.includes(selectedValue)) {
												return values.filter((v) => v !== option)
											} else {
												return [...values, option]
											}
										})
									}}
								>
									<Check className={cn('mr-2 h-4 w-4', values.includes(option) ? 'opacity-100' : 'opacity-0')} />
									{option === null ? DH.NULL_DISPLAY : option}
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
