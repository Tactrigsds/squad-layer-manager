import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { assertNever } from '@/lib/type-guards'
import type * as LL from '@/models/layer-list.models'
import * as Icons from 'lucide-react'
import { Avatar } from './ui/avatar'
import { UserAvatar } from './user-avatar'

export default function LayerSourceDisplay(props: { source: LL.Source }) {
	const renderIcon = (displayName: string, backgroundColor: string, icon: React.ReactNode) => (
		<Tooltip delayDuration={0}>
			<TooltipTrigger>
				<Avatar style={{ backgroundColor }} className="h-6 w-6">{icon}</Avatar>
			</TooltipTrigger>
			<TooltipContent className="bg-secondary text-secondary-foreground">{displayName}</TooltipContent>
		</Tooltip>
	)

	switch (props.source.type) {
		case 'gameserver':
			return renderIcon('Game Server', '#6366f1', <Icons.Server />)
		case 'unknown':
			return renderIcon('Unknown', '#64748b', <Icons.MessageCircleQuestion />)
		case 'generated':
			return renderIcon('Generated', '#059669', <Icons.Dices />)
		case 'manual':
			return <UserAvatar userId={props.source.userId} label="Set By" />
		default:
			assertNever(props.source)
	}
}
