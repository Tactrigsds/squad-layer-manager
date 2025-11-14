import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { assertNever } from '@/lib/type-guards'
import * as LL from '@/models/layer-list.models'
import * as USR from '@/models/users.models'
import * as PartsSys from '@/systems.client/parts.ts'
import * as UsersClient from '@/systems.client/users.client'
import * as Icons from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'

export default function LayerSourceDisplay(props: { source: LL.Source }) {
	const loggedInUser = UsersClient.useLoggedInUser()
	const userId = props.source.type === 'manual' ? props.source.userId : undefined
	const userPartial = userId ? PartsSys.findUser(userId) : undefined
	const isMe = userId && userId === loggedInUser?.discordId
	const userRes = UsersClient.useUser(userId, { enabled: !!userId && !userPartial && !isMe })
	const user: USR.User | undefined = (userRes.data?.code === 'ok' ? userRes.data.user : undefined) ?? userPartial ?? loggedInUser
	const username = user?.displayName ?? 'Unknown'

	const renderAvatar = (
		displayName: string,
		initials: string,
		backgroundColor?: string,
		avatar?: string | React.ReactNode,
	) => {
		let inner: React.ReactNode
		if (!avatar || typeof avatar === 'string') {
			inner = (
				<Avatar
					style={{ backgroundColor: backgroundColor ?? undefined }}
					className="h-6 w-6"
				>
					{typeof avatar === 'string' && <AvatarImage src={avatar} crossOrigin="anonymous" />}
					<AvatarFallback className="text-xs">
						{initials}
					</AvatarFallback>
				</Avatar>
			)
		} else {
			inner = avatar
		}

		return (
			<Tooltip delayDuration={0}>
				<TooltipTrigger>
					{inner}
				</TooltipTrigger>
				<TooltipContent className="bg-secondary text-secondary-foreground">
					Set By {displayName}
					{isMe ? ' (You)' : ''}
				</TooltipContent>
			</Tooltip>
		)
	}

	switch (props.source.type) {
		case 'gameserver':
			return renderAvatar('Game Server', 'GS', '#6366f1', <Icons.Server />)
		case 'unknown':
			return renderAvatar('Unknown', '?', '#64748b', <Icons.MessageCircleQuestion />)
		case 'generated':
			return renderAvatar('Generated', 'G', '#059669', <Icons.Dices />)
		case 'manual': {
			if (!user) return null
			return renderAvatar(username, USR.getUserInitials(user), user.displayHexColor ?? undefined, USR.getAvatarUrl(user))
		}
		default:
			assertNever(props.source)
	}
}
