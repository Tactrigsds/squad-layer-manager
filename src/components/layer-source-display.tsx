import * as Icons from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { assertNever } from '@/lib/type-guards'
import * as LL_Msgs from '@/messages/layer-list.messages'
import type * as LL from '@/models/layer-list.models'
import { tr } from '@/systems/messages.client'

import { Avatar } from './ui/avatar'
import { UserAvatar } from './user-avatar'

export default function LayerSourceDisplay(props: { source: LL.Source }) {
	const renderIcon = (displayName: string, backgroundColor: string, icon: React.ReactNode) => (
		<Tooltip delayDuration={0}>
			<TooltipTrigger>
				<Avatar style={{ backgroundColor }} className="h-6 w-6">
					{icon}
				</Avatar>
			</TooltipTrigger>
			<TooltipContent className="bg-secondary text-secondary-foreground">{displayName}</TooltipContent>
		</Tooltip>
	)

	switch (props.source.type) {
		case 'gameserver':
			return renderIcon(LL_Msgs.sourceNames.gameserver, '#6366f1', <Icons.Server />)
		case 'unknown':
			return renderIcon(LL_Msgs.sourceNames.unknown, '#64748b', <Icons.MessageCircleQuestion />)
		case 'generated':
			return renderIcon(LL_Msgs.sourceNames.generated, '#059669', <Icons.Dices />)
		case 'ingame-vote':
			return renderIcon(LL_Msgs.sourceNames['ingame-vote'], '#d97706', <Icons.Vote />)
		case 'manual':
			return <UserAvatar userId={props.source.userId} label={tr.text(LL_Msgs.setByLabel())} />
		default:
			assertNever(props.source)
	}
}
