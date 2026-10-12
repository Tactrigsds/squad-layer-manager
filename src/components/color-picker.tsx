import type * as React from 'react'
import { HexColorPicker } from 'react-colorful'

import { InputGroup, InputGroupAddon, InputGroupButton } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import * as Color from '@/lib/color'
import { cn } from '@/lib/utils'

// a free-form picker with the shared swatches beneath it, sized to the picker's width
export function ColorPicker({
	color,
	onChange,
	width = 200,
	height = 200,
}: {
	color: string
	onChange: (hex: string) => void
	width?: number
	height?: number
}) {
	const selected = color.toLowerCase()
	return (
		<div className="space-y-2" style={{ width }}>
			<HexColorPicker color={color} onChange={onChange} style={{ width, height }} />
			<div className="grid grid-cols-6 gap-1">
				{Color.SWATCH_LIST.map((swatch) => (
					<button
						key={swatch}
						type="button"
						title={swatch}
						aria-label={swatch}
						aria-pressed={swatch === selected}
						className={cn(
							'aspect-square rounded-sm border',
							swatch === selected && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
						)}
						style={{ backgroundColor: swatch }}
						onClick={() => onChange(swatch)}
					/>
				))}
			</div>
		</div>
	)
}

// A swatch that opens the picker, beside the color's hex code. The hex input is uncontrolled so a keystroke is never
// clobbered mid-edit; a change made anywhere but the hex field has to be written back through `hexRef`.
export function ColorHexInput({
	hexRef,
	color,
	pickLabel,
	onChange,
}: {
	hexRef: React.RefObject<HTMLInputElement | null>
	color: string
	pickLabel: string
	onChange: (hex: string, fromHexField: boolean) => void
}) {
	return (
		<InputGroup className="h-8 w-[9.5rem]">
			<InputGroupAddon align="inline-start">
				<Popover>
					<PopoverTrigger asChild>
						<InputGroupButton size="icon-xs" title={pickLabel} aria-label={pickLabel}>
							<span className="size-4 rounded-sm border" style={{ backgroundColor: color }} />
						</InputGroupButton>
					</PopoverTrigger>
					<PopoverContent className="w-auto p-2">
						<ColorPicker color={color} onChange={(c) => onChange(c, false)} />
					</PopoverContent>
				</Popover>
			</InputGroupAddon>
			{/* a bare input (not InputGroupInput, whose custom Input wraps the control in a div that breaks the flex row) */}
			<input
				ref={hexRef}
				data-slot="input-group-control"
				defaultValue={color}
				maxLength={7}
				autoComplete="off"
				spellCheck={false}
				onChange={(e) => onChange(e.currentTarget.value.trim(), true)}
				className="w-full min-w-0 bg-transparent py-1 pe-2 font-mono text-xs outline-none ltr-isolate"
			/>
		</InputGroup>
	)
}
