import * as MapUtils from '@/lib/map'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import type * as SLL from '@/models/shared-layer-list'
import * as UP from '@/models/user-presence'
import * as USR from '@/models/users.models'
import * as SLLClient from '@/systems/shared-layer-list.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import * as DateFns from 'date-fns'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const EVENT_TEXT_DURATION = 2000

export type SortPresenceFn = (
	a: { user: USR.User; presence: UP.ClientPresence },
	b: { user: USR.User; presence: UP.ClientPresence },
) => number
export const sortEditingPresence: SortPresenceFn = (a, b) => {
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
	const aEditingActivity = UP.getEditingQueueNode(aPresence.activityState)
	const bEditingActivity = UP.getEditingQueueNode(bPresence.activityState)

	const aNonIdle = !!aEditingActivity?.chosen && aEditingActivity.chosen.id !== 'IDLE'
	const bNonIdle = !!bEditingActivity?.chosen && bEditingActivity.chosen.id !== 'IDLE'

	if (aNonIdle && !bNonIdle) return -1
	if (!aNonIdle && bNonIdle) return 1

	const aEditing = !!aEditingActivity
	const bEditing = !!bEditingActivity

	if (aEditing && !bEditing) return -1
	if (!aEditing && bEditing) return 1

	return a.user.displayName.localeCompare(b.user.displayName)
}

export type UserPresencePanelProps = {
	// users which have a matchng activity will be listed
	className?: string
	matchActivity?: UP.Resolver
	transitionMessages?: {
		matchActivity: UP.Resolver
		leaveMessage?: string
		joinMessage?: string
	}[]
	sourcePresenceFn?: SortPresenceFn
}

export default function UserPresencePanel(props: UserPresencePanelProps) {
	const layerList = Zus.useStore(
		SLLClient.Store,
		state => state.layerList,
	)

	const matchingUserPresence = Zus.useStore(
		UPClient.Store,
		ZusUtils.useDeep(state =>
			MapUtils.filter(state.userPresence, (userId, presence) => props.matchActivity ? props.matchActivity(presence.activityState) : true)
		),
	)

	const allUserIds = new Set(matchingUserPresence.keys())

	// -------- Track temporary event text for users (e.g., "Finished editing") --------
	const [userEventText, setUserEventText] = React.useState<Map<bigint, string>>(new Map())
	const eventTextTimeouts = React.useRef<Map<bigint, ReturnType<typeof setTimeout>>>(new Map())
	React.useEffect(() => {
		const unsub = UPClient.Store.subscribe((state, prev) => {
			if (state.userPresence === prev.userPresence) return
			const allUserIds = new Set([...state.userPresence.keys(), ...prev.userPresence.keys()])
			for (const userId of allUserIds) {
				const prevPresence = prev.userPresence.get(userId)
				const currentPresence = state.userPresence.get(userId)
				let message: string | undefined
				for (const config of props.transitionMessages ?? []) {
					const matched = config.matchActivity(currentPresence?.activityState)
					const prevMatched = config.matchActivity(prevPresence?.activityState)

					if (config.leaveMessage && !matched && prevMatched) {
						message = config.leaveMessage
						setUserEventText(prev => new Map(prev).set(userId, config.leaveMessage!))
						break
					} else if (config.joinMessage && matched && !prevMatched) {
						message = config.joinMessage
						break
					}
					break
				}

				if (!message) continue

				setUserEventText(prev => new Map(prev).set(userId, message))
				const existingTimeout = eventTextTimeouts.current.get(userId)
				if (existingTimeout) {
					clearTimeout(existingTimeout)
				}
				const timeout = setTimeout(() => {
					eventTextTimeouts.current.delete(userId)
					setUserEventText(prev => {
						const next = new Map(prev)
						next.delete(userId)
						return next
					})
				}, EVENT_TEXT_DURATION)
				eventTextTimeouts.current.set(userId, timeout)
			}
		})

		const timeouts = eventTextTimeouts.current
		return () => {
			unsub()
			// Clear all timeouts on unmount
			for (const timeout of timeouts.values()) {
				clearTimeout(timeout)
			}
			timeouts.clear()
		}
	}, [])

	const usersRes = UsersClient.useUsers(allUserIds, { enabled: allUserIds.size > 0 })
	const loggedInUser = UsersClient.useLoggedInUser()
	const users = React.useMemo(() => {
		return usersRes.data?.code === 'ok' ? usersRes.data.users : []
	}, [usersRes.data])

	// Loading state when data isn't ready yet
	const isLoading = usersRes.isLoading

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
		const oldestLastSeenToDisplay = Date.now() - UP.DISPLAYED_AWAY_PRESENCE_WINDOW
		const userPresenceList = Array.from(matchingUserPresence.entries()).map(([userId, presence]) => {
			const user = userMap.get(userId)
			return user ? { user, presence } : null
		}).filter((item): item is { user: USR.User; presence: UP.ClientPresence } => {
			if (!item) return false
			// Only show users who are not away, or who have been seen in the last 5 minutes
			if (!item.presence.away) return true
			if (!item.presence.lastSeen) return false
			return item.presence.lastSeen > oldestLastSeenToDisplay
		})

		return props.sourcePresenceFn ? userPresenceList.sort(props.sourcePresenceFn) : userPresenceList
	}, [matchingUserPresence, userMap])

	const getUserInitials = (user: USR.User) => {
		return user.displayName.slice(0, 2).toUpperCase()
	}

	const [_, setHoveredUser] = UPClient.useHoveredActivityUser()

	let otherMatchingUsersCount = 0
	for (const userId of allUserIds) {
		if (userId === loggedInUser?.discordId) continue
		otherMatchingUsersCount++
	}

	return (
		<div className={cn('flex flex-wrap space-x-1 min-h-6', props.className)}>
			{isLoading && <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-current mx-auto"></div>}
			{!isLoading && otherMatchingUsersCount > 1 && (
				<div className="text-sm text-muted-foreground pr-1">{otherMatchingUsersCount} other users editing queue</div>
			)}
			{sortedUserPresence.map(({ user, presence }) => {
				const isAway = presence.away
				const currentActivity = presence.activityState
				const isMatching = allUserIds.has(user.discordId)
				const eventText = userEventText.get(user.discordId)
				const activityText = eventText ?? (currentActivity ? UP.getHumanReadableActivity(currentActivity, layerList) : null)

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
