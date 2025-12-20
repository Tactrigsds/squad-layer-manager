import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as EMO from '@/models/emoji.models'
import * as DiscordClient from '@/systems/discord.client'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export default function EmojiDisplay(
	props: { emoji: string | EMO.Emoji; showTooltip?: boolean; className?: string; size?: 'sm' | number },
) {
	let emoji: EMO.Emoji | undefined
	{
		const id = typeof props.emoji === 'string' ? props.emoji : undefined
		emoji = DiscordClient.useEmoji(id, { enabled: !!id })
		if (typeof props.emoji !== 'string') emoji = props.emoji ?? undefined
	}

	const sizeClass = props.size === 'sm' ? 'w-6 h-6' : typeof props.size === 'number' ? '' : 'text-xl'
	const sizeStyle = typeof props.size === 'number' ? { width: `${props.size}px`, height: `${props.size}px` } : undefined

	let inner: React.ReactNode
	if (!emoji) return
	if (emoji.type === 'discord') {
		inner = (
			<img
				className={cn(props.className, 'rounded-md', sizeClass, 'object-center')}
				style={sizeStyle}
				src={DiscordClient.getEmojiUrl(emoji)}
				alt={EMO.displayName(emoji)}
			/>
		)
	} else if (emoji.type === 'unicode') {
		inner = <span className={cn(props.className, 'text-xl', sizeClass)} style={sizeStyle}>{emoji.id}</span>
	} else {
		assertNever(emoji)
	}

	if (props.showTooltip !== true) {
		return inner
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{inner}
			</TooltipTrigger>
			<TooltipContent>
				{EMO.displayName(emoji)}
			</TooltipContent>
		</Tooltip>
	)
}
