import type { ButtonProps } from '@/components/ui/button'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type * as EMO from '@/models/emoji.models'
import * as Icons from 'lucide-react'
import EmojiDisplay from './emoji-display'

export default function EmojiButton(_props: ButtonProps & { emoji?: string | EMO.Emoji; showTooltip?: boolean }) {
	const { emoji, ...props } = _props
	return (
		<Button size="icon" {...props} className={cn('overflow-clip', props.className)}>
			{!emoji && <Icons.SmilePlus className="m-auto" />}
			{emoji && <EmojiDisplay className="m-auto" showTooltip={props.showTooltip} emoji={emoji} />}
		</Button>
	)
}
