import * as AR from '@/app-routes'
import { cn } from '@/lib/utils'
import * as LL from '@/models/layer-list.models'
import * as SLL from '@/models/shared-layer-list'
import type * as USR from '@/models/users.models'
import * as SLLClient from '@/systems.client/shared-layer-list.client'
import * as UsersClient from '@/systems.client/users.client'
import * as DateFns from 'date-fns'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export default function UserPresencePanel() {
	const [userPresence, layerList] = Zus.useStore(SLLClient.Store, useShallow(state => [state.userPresence, state.session.list]))
	const usersRes = UsersClient.useUsers(Array.from(userPresence.keys()))
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
		const fiveMinutesAgo = Date.now() - (5 * 60 * 1000)
		const userPresenceList = Array.from(userPresence.entries()).map(([userId, presence]) => {
			const user = userMap.get(userId)
			return user ? { user, presence } : null
		}).filter((item): item is { user: USR.User; presence: SLL.ClientPresence } => {
			if (!item) return false
			// Only show users who are not away, or who have been seen in the last 5 minutes
			if (!item.presence.away) return true
			if (!item.presence.lastSeen) return false
			return item.presence.lastSeen > fiveMinutesAgo
		})

		return userPresenceList.sort((a, b) => {
			const aPresence = a.presence
			const bPresence = b.presence

			// If user is away, they go to the bottom regardless of other status
			if (aPresence.away && !bPresence.away) return 1
			if (!aPresence.away && bPresence.away) return -1
			if (aPresence.away && bPresence.away) return 0

			// Priority: has activity > editing > present
			const aHasActivity = aPresence.currentActivity !== null
			const bHasActivity = bPresence.currentActivity !== null

			if (aHasActivity && !bHasActivity) return -1
			if (!aHasActivity && bHasActivity) return 1

			if (aPresence.editing && !bPresence.editing) return -1
			if (!aPresence.editing && bPresence.editing) return 1

			return a.user.username.localeCompare(b.user.username)
		})
	}, [userPresence, userMap])

	const getAvatarUrl = (user: USR.User) => {
		return AR.link('/avatars/:discordId/:avatarId', user.discordId.toString(), user.avatar ?? 'default')
	}

	const getUserInitials = (user: USR.User) => {
		return user.username.slice(0, 2).toUpperCase()
	}

	const [_, setHoveredUser] = SLLClient.useHoveredActivityUser()

	if (isLoading) {
		return (
			<div className="flex items-center justify-center p-8 text-muted-foreground">
				<div className="text-center">
					<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-current mx-auto mb-2"></div>
					<div className="text-sm">Loading user presence...</div>
				</div>
			</div>
		)
	}

	if (sortedUserPresence.length === 0) {
		return (
			<div className="flex items-center justify-center p-8 text-muted-foreground">
				<div className="text-center">
					<div className="text-sm">No users online</div>
				</div>
			</div>
		)
	}

	return (
		<>
			<div className="flex flex-wrap space-x-1">
				{sortedUserPresence.map(({ user, presence }) => {
					const isAway = presence.away
					const isEditing = presence.editing
					const currentActivity = presence.currentActivity
					const hasActivity = currentActivity !== null
					const itemIndex = (currentActivity && SLL.isItemOwnedActivity(currentActivity))
						? LL.findItemById(layerList, currentActivity.itemId)
						: undefined
					const activityText = currentActivity ? SLL.getHumanReadableActivity(currentActivity.code, itemIndex) : null

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
												className={cn(
													'h-6 w-6 transition-all duration-200',
													isAway && 'grayscale opacity-50',
													isEditing && 'ring-2 ring-blue-500 ring-offset-0',
												)}
											>
												<AvatarImage src={getAvatarUrl(user)} />
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
								<TooltipContent>
									<div className="text-center">
										<div className="font-medium">{user.username} {loggedInUser?.discordId === user.discordId ? '(You)' : ''}</div>
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
		</>
	)
}
