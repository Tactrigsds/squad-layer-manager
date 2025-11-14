import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { EmojiStyle } from 'emoji-picker-react'
import { useState } from 'react'
import EmojiButton from './emoji-button'
import { UnifiedEmojiPicker } from './emoji-picker'

export type EmojiPickerPopoverProps = {
	value?: string
	onSelect: (emoji: string | undefined) => void
	disabled?: boolean
	placeholder?: string
	hidden?: string[]
	className?: string
	emojiStyle?: EmojiStyle
	guildEmojiSize?: number
	width?: number | string
	height?: number | string
}

export function EmojiPickerPopover(props: EmojiPickerPopoverProps) {
	const {
		value: emoji,
		onSelect,
		disabled = false,
		className,
		emojiStyle = EmojiStyle.NATIVE,
		guildEmojiSize = 48,
		width = 350,
		height = 450,
	} = props

	const [open, setOpen] = useState(false)

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<EmojiButton
					emoji={emoji}
					disabled={disabled}
					variant="outline"
					role="combobox"
					className={cn('h-auto min-h-9 justify-start gap-2', className)}
				/>
			</PopoverTrigger>
			<PopoverContent className="w-auto p-0" align="start">
				<UnifiedEmojiPicker
					// if we don't coalesce here the component breaks
					hidden={props.hidden ?? []}
					onEmojiClick={(emoji) => {
						onSelect(emoji)
						setOpen(false)
					}}
					emojiStyle={emojiStyle}
					guildEmojiSize={guildEmojiSize}
					width={width}
					height={height}
				/>
			</PopoverContent>
		</Popover>
	)
}
