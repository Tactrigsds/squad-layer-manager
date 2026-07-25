import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type * as USR from '@/models/users.models'
import { getUserInitials } from '@/models/users.models'
import * as UsersClient from '@/systems/users.client'

import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'

// A discord user rendered as their avatar, with their name on hover. `label` prefixes the tooltip ("Set By").
// Renders nothing while the user is unresolved, so a caller can fall back to whatever identity it does have.
export function UserAvatar(props: { userId: USR.UserId; label?: string; className?: string }) {
	const user = UsersClient.useResolvedUser(props.userId)
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

// The same user with their name spelled out beside the avatar, for somewhere with room for it (a hover card, a panel).
export function UserLabel(props: { userId: USR.UserId; label?: string; className?: string }) {
	const user = UsersClient.useResolvedUser(props.userId)
	if (!user) return null

	return (
		<span className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', props.className)}>
			<Avatar style={{ backgroundColor: user.displayHexColor ?? undefined }} className="h-4 w-4">
				<AvatarImage src={user.avatarUrl} crossOrigin="anonymous" />
				<AvatarFallback className="text-2xs">{getUserInitials(user)}</AvatarFallback>
			</Avatar>
			<span className="truncate">
				{props.label} <span className="text-foreground">{user.displayName}</span>
			</span>
		</span>
	)
}
