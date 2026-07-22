import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type * as USR from '@/models/users.models'
import { getUserInitials } from '@/models/users.models'
import * as PartsSys from '@/systems/parts.client'
import * as UsersClient from '@/systems/users.client'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'

// A discord user rendered as their avatar, with their name on hover. `label` prefixes the tooltip ("Set By").
// Renders nothing while the user is unresolved, so a caller can fall back to whatever identity it does have.
export function UserAvatar(props: { userId: USR.UserId; label?: string; className?: string }) {
	const loggedInUser = UsersClient.useLoggedInUser()
	const partial = PartsSys.findUser(props.userId)
	const isMe = props.userId === loggedInUser?.discordId
	const res = UsersClient.useUser(props.userId, { enabled: !partial && !isMe })
	const user = (res.data?.code === 'ok' ? res.data.user : undefined) ?? partial ?? (isMe ? loggedInUser : undefined)
	if (!user) return null

	return (
		<Tooltip delayDuration={0}>
			<TooltipTrigger>
				<Avatar style={{ backgroundColor: user.displayHexColor ?? undefined }} className={cn('h-6 w-6', props.className)}>
					<AvatarImage src={user.avatarUrl} crossOrigin="anonymous" />
					<AvatarFallback className="text-xs">{getUserInitials(user)}</AvatarFallback>
				</Avatar>
			</TooltipTrigger>
			<TooltipContent className="bg-secondary text-secondary-foreground">
				{props.label} {user.displayName}
			</TooltipContent>
		</Tooltip>
	)
}
