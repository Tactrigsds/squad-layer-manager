import { cn } from '@/lib/utils'
import * as SLL from '@/models/shared-layer-list'
import * as USR from '@/models/users.models'
import * as SLLClient from '@/systems/shared-layer-list.client'
import * as UsersClient from '@/systems/users.client'
import * as DateFns from 'date-fns'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const EVENT_TEXT_DURATION = 2000

export default function UserPresencePanel() {
	const [userPresence, layerList, editorIds] = Zus.useStore(
		SLLClient.Store,
		useShallow(state => [state.userPresence, state.session.list, state.session.editors]),
	)

	// -------- Track temporary event text for users (e.g., "Finished editing") --------
	const [userEventText, setUserEventText] = React.useState<Map<bigint, string>>(new Map())
	const eventTextTimeouts = React.useRef<Map<bigint, ReturnType<typeof setTimeout>>>(new Map())
	React.useEffect(() => {
		const sub = SLLClient.Store.getState().syncedOp$.pipe(
			Rx.filter((op): op is SLL.Operation & { op: 'finish-editing' } => op.op === 'finish-editing'),
		).subscribe((op) => {
			// Clear existing timeout for this user if any
			const existingTimeout = eventTextTimeouts.current.get(op.userId)
			if (existingTimeout) {
				clearTimeout(existingTimeout)
			}

			setUserEventText(prev => new Map(prev).set(op.userId, 'Finished editing'))

			const timeout = setTimeout(() => {
				eventTextTimeouts.current.delete(op.userId)
				setUserEventText(prev => {
					const next = new Map(prev)
					next.delete(op.userId)
					return next
				})
			}, EVENT_TEXT_DURATION)
			eventTextTimeouts.current.set(op.userId, timeout)
		})

		return () => {
			sub.unsubscribe()
			// Clear all timeouts on unmount
			for (const timeout of eventTextTimeouts.current.values()) {
				clearTimeout(timeout)
			}
			eventTextTimeouts.current.clear()
		}
	}, [])

	const allUserIds = React.useMemo(() => Array.from(new Set([...userPresence.keys(), ...editorIds])), [userPresence, editorIds])
	const usersRes = UsersClient.useUsers(allUserIds, { enabled: allUserIds.length > 0 })
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
	let otherEditorsCount = 0
	for (const editorId of editorIds) {
		if (editorId === loggedInUser?.discordId) continue
		otherEditorsCount++
	}

	return (
		<div className="flex flex-wrap space-x-1">
			{otherEditorsCount > 1 && <div className="text-sm text-muted-foreground pr-1">{otherEditorsCount} other users editing queue</div>}
			{sortedUserPresence.map(({ user, presence }) => {
				const isAway = presence.away
				const currentActivity = presence.activityState
				const isEditing = editorIds.has(user.discordId)
				const eventText = userEventText.get(user.discordId)
				const activityText = eventText ?? (currentActivity
					? SLL.getHumanReadableActivity(currentActivity, layerList)
					: (isEditing ? 'Editing Queue' : null))

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
										activityText && 'bg-accent pr-2',
										!activityText && 'px-0',
									)}
								>
									<div className="flex items-center justify-center w-6 h-6 shrink-0">
										<Avatar
											style={{ backgroundColor: user.displayHexColor ?? undefined }}
											className={cn(
												'h-6 w-6 transition-all duration-200',
												isAway && 'grayscale opacity-50',
											)}
										>
											<AvatarImage src={USR.getAvatarUrl(user)} crossOrigin="anonymous" />
											<AvatarFallback className="text-xs">
												{getUserInitials(user)}
											</AvatarFallback>
										</Avatar>
									</div>
									{activityText && (
										<span className="activity-text">
											<span className="text-xs font-medium whitespace-nowrap">
												{activityText}
											</span>
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
								</div>
							</TooltipContent>
						</Tooltip>
					</div>
				)
			})}
		</div>
	)
}
