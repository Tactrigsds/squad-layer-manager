import { cn } from '@/lib/utils'
import * as SLL from '@/models/shared-layer-list'
import * as USR from '@/models/users.models'
import * as SLLClient from '@/systems/shared-layer-list.client'
import * as UsersClient from '@/systems/users.client'
import * as DateFns from 'date-fns'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export default function UserPresencePanel() {
	const [userPresence, layerList] = Zus.useStore(SLLClient.Store, useShallow(state => [state.userPresence, state.session.list]))
	const usersRes = UsersClient.useUsers(Array.from(userPresence.keys()), { enabled: userPresence.size > 0 })
	const loggedInUser = UsersClient.useLoggedInUser()
	const users = React.useMemo(() => {
		return usersRes.data?.code === 'ok' ? usersRes.data.users : []
	}, [usersRes.data])

	// Loading state when data isn't ready yet
	const isLoading = users.length === 0 || userPresence.size === 0

	// Create a map of users by their discordId for quick lookup
	const userMap = React.useMemo(() => {
		const map = new Map<bigint, USR.User>()
		users.forEach(user => {
			map.set(user.discordId, user)
		})
		return map
	}, [users])

	// Sort users based on presence priority
	const sortedUserPresence = React.useMemo(() => {
		const oldestLastSeenToDisplay = Date.now() - SLL.DISPLAYED_AWAY_PRESENCE_WINDOW
		const userPresenceList = Array.from(userPresence.entries()).map(([userId, presence]) => {
			const user = userMap.get(userId)
			return user ? { user, presence } : null
		}).filter((item): item is { user: USR.User; presence: SLL.ClientPresence } => {
			if (!item) return false
			// Only show users who are not away, or who have been seen in the last 5 minutes
			if (!item.presence.away) return true
			if (!item.presence.lastSeen) return false
			return item.presence.lastSeen > oldestLastSeenToDisplay
		})

		return userPresenceList.sort((a, b) => {
			const aPresence = a.presence
			const bPresence = b.presence

			// If user is away, they go to the bottom regardless of other status
			if (aPresence.away && !bPresence.away) return 1
			if (!aPresence.away && bPresence.away) return -1
			if (aPresence.away && bPresence.away) {
				if (aPresence.lastSeen && bPresence.lastSeen) {
					if (aPresence.lastSeen > bPresence.lastSeen) return -1
					if (aPresence.lastSeen < bPresence.lastSeen) return 1
				}
				return 0
			}

			// Priority: has queue non-idle edit activity > editing > present
			const aEditingActivity = aPresence.activityState?.child.EDITING
			const bEditingActivity = bPresence.activityState?.child.EDITING

			const aNonIdle = !!aEditingActivity?.chosen && aEditingActivity.chosen.id !== 'IDLE'
			const bNonIdle = !!bEditingActivity?.chosen && bEditingActivity.chosen.id !== 'IDLE'

			if (aNonIdle && !bNonIdle) return -1
			if (!aNonIdle && bNonIdle) return 1

			const aEditing = !!aEditingActivity
			const bEditing = !!bEditingActivity

			if (aEditing && !bEditing) return -1
			if (!aEditing && bEditing) return 1

			return a.user.displayName.localeCompare(b.user.displayName)
		})
	}, [userPresence, userMap])

	const getUserInitials = (user: USR.User) => {
		return user.displayName.slice(0, 2).toUpperCase()
	}

	const [_, setHoveredUser] = SLLClient.useHoveredActivityUser()

	if (isLoading) {
		return <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-current mx-auto mb-2"></div>
	}

	if (sortedUserPresence.length === 0) {
		return <div className="text-muted-foreground self-center">No users online</div>
	}

	return (
		<div className="flex flex-wrap space-x-1">
			{sortedUserPresence.map(({ user, presence }) => {
				const isAway = presence.away
				const currentActivity = presence.activityState
				const isEditing = !!currentActivity?.child?.EDITING
				const hasActivity = currentActivity && Object.keys(currentActivity.child).length > 0
					&& currentActivity.child.EDITING?.chosen.id !== 'IDLE'
				const activityText = currentActivity ? SLL.getHumanReadableActivity(currentActivity, layerList) : null

				return (
					<div key={user.discordId.toString()} className="flex items-center space-x-1">
						<Tooltip
							delayDuration={0}
						>
							<TooltipTrigger asChild>
								<div
									onMouseOver={() => setHoveredUser(user.discordId, true)}
									onMouseOut={() => setHoveredUser(user.discordId, false)}
									className={cn(
										'inline-flex items-center gap-1.5 h-6 py-0 rounded-full transition-all duration-200 cursor-pointer',
										hasActivity && 'bg-accent px-2',
										!hasActivity && 'px-0',
									)}
								>
									<div className="flex items-center justify-center w-6 h-6 flex-shrink-0">
										<Avatar
											style={{ backgroundColor: user.displayHexColor ?? undefined }}
											className={cn(
												'h-6 w-6 transition-all duration-200',
												isAway && 'grayscale opacity-50',
												isEditing && 'ring-2 ring-blue-500 ring-offset-0',
											)}
										>
											<AvatarImage src={USR.getAvatarUrl(user)} crossOrigin="anonymous" />
											<AvatarFallback className="text-xs">
												{getUserInitials(user)}
											</AvatarFallback>
										</Avatar>
									</div>
									{hasActivity && activityText && (
										<span className="text-xs font-medium whitespace-nowrap flex items-center h-6">
											{activityText}
										</span>
									)}
								</div>
							</TooltipTrigger>
							{/*<TooltipContent className="bg-secondary text-secondary-foreground">*/}
							<TooltipContent>
								<div className="text-center">
									<div className="font-medium">{user.displayName} {loggedInUser?.discordId === user.discordId ? '(You)' : ''}</div>
									{isAway && presence.lastSeen && (
										<div className="text-xs mt-1">
											Last seen {DateFns.formatDistanceToNow(new Date(presence.lastSeen), { addSuffix: true })}
										</div>
									)}
									{isEditing && !isAway && (
										<div className="text-xs text-blue-600 mt-1">
											Editing
										</div>
									)}
									{isEditing && isAway && (
										<div className="text-xs text-blue-600 mt-1">
											Editing (away)
										</div>
									)}
								</div>
							</TooltipContent>
						</Tooltip>
					</div>
				)
			})}
		</div>
	)
}
