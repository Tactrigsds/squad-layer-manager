import { HexColorPicker } from 'react-colorful'

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
