import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as MapUtils from '@/lib/map'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as UP from '@/models/user-presence'
import * as USR from '@/models/users.models'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import * as DateFns from 'date-fns'
import { Loader2 } from 'lucide-react'
import React from 'react'
import type * as Rx from 'rxjs'
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
	const aRoot = aPresence.activityState
	const bRoot = bPresence.activityState
	const aEditingActivity = aRoot ? UP.Trans.editingQueue(aRoot.opts.serverId).match(aRoot) : null
	const bEditingActivity = bRoot ? UP.Trans.editingQueue(bRoot.opts.serverId).match(bRoot) : null

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

type PresenceEntry = { user: USR.User; presence: UP.ClientPresence; activityText: string | null }
type PresenceGroup = { activityText: string | null; entries: PresenceEntry[] }

export type UserPresencePanelProps = {
	// users which have a matchng activity will be listed
	className?: string
	matchActivity?: UP.Resolver
	// what activity to resolve the text status from, if any
	matchActivityForStatusText?: UP.Resolver<UP.AnyActivityNode | null | undefined>
	transitionMessages?: {
		matchActivity: UP.Resolver
		leaveMessage?: string
		joinMessage?: string
	}[]
	// emissions briefly display event text for the user (e.g. "Saved the queue")
	event$?: Rx.Observable<UP.PresenceEvent>
	sourcePresenceFn?: SortPresenceFn
	stores?: SquadServerFrame.KeyProp
}

export default function UserPresencePanel(props: UserPresencePanelProps) {
	const layerList = ZusUtils.useStore(
		props.stores?.squadServer ?? null,
		state => state ? LayerQueuePrt.Sel.layerList(state) : [],
	)

	const matchingUserPresence = ZusUtils.useStore(
		UPClient.Store,
		ZusUtils.useDeep(state =>
			MapUtils.filter(state.userPresence, (userId, presence) => props.matchActivity ? props.matchActivity(presence.activityState) : true)
		),
	)

	const allUserIds = new Set(matchingUserPresence.keys())

	// -------- Track temporary event text for users (e.g., "Finished editing") --------
	const [userEventText, setUserEventText] = React.useState<Map<bigint, string>>(new Map())
	const eventTextTimeouts = React.useRef<Map<bigint, ReturnType<typeof setTimeout>>>(new Map())

	const showEventText = React.useCallback((userId: bigint, message: string) => {
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
	}, [])

	React.useEffect(() => {
		if (!props.event$) return
		const sub = props.event$.subscribe(event => {
			showEventText(event.userId, UP.PRESENCE_EVENT_TEXT[event.action])
		})
		return () => sub.unsubscribe()
	}, [props.event$, showEventText])

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
						break
					} else if (config.joinMessage && matched && !prevMatched) {
						message = config.joinMessage
						break
					}
					break
				}

				if (!message) continue

				// op events (event$) take priority: e.g. a queue save also ends the saver's editing
				// session, and "Finished editing" shouldn't clobber "Saved the queue"
				if (eventTextTimeouts.current.has(userId)) continue

				showEventText(userId, message)
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
	}, [props.transitionMessages, showEventText])

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
	}, [
		matchingUserPresence,
		userMap,
		props.sourcePresenceFn,
	])

	const getUserInitials = (user: USR.User) => {
		return user.displayName.slice(0, 2).toUpperCase()
	}

	const groupedPresence = React.useMemo((): PresenceGroup[] => {
		const entries: PresenceEntry[] = sortedUserPresence.map(({ user, presence }) => {
			let activityText: string | null = null
			const eventText = userEventText.get(user.discordId)
			const activityForText = props.matchActivityForStatusText?.(presence.activityState)
			// const
			if (eventText) activityText = eventText
			else if (activityForText) {
				activityText = UP.getHumanReadableActivity(activityForText, layerList)
			}
			return { user, presence, activityText }
		})

		const textGroups = new Map<string, PresenceEntry[]>()
		for (const entry of entries) {
			if (entry.activityText) {
				if (!textGroups.has(entry.activityText)) textGroups.set(entry.activityText, [])
				textGroups.get(entry.activityText)!.push(entry)
			}
		}

		const result: PresenceGroup[] = []
		const seenTexts = new Set<string>()
		for (const entry of entries) {
			if (entry.activityText) {
				if (!seenTexts.has(entry.activityText)) {
					seenTexts.add(entry.activityText)
					result.push({ activityText: entry.activityText, entries: textGroups.get(entry.activityText)! })
				}
			} else {
				result.push({ activityText: null, entries: [entry] })
			}
		}
		return result
	}, [
		sortedUserPresence,
		userEventText,
		layerList,
		props,
	])

	const actionCount = React.useMemo(() => {
		return groupedPresence.reduce((count, group) => count + group.entries.filter(e => e.activityText !== null).length, 0)
	}, [groupedPresence])

	// -------- Compact mode: switch when content overflows the container --------
	const [isCompact, setIsCompact] = React.useState(false)
	const containerRef = React.useRef<HTMLDivElement>(null)
	const normalContentRef = React.useRef<HTMLDivElement>(null)

	React.useEffect(() => {
		const container = containerRef.current
		const content = normalContentRef.current
		if (!container || !content) return
		const check = () => setIsCompact(container.scrollWidth > container.clientWidth)
		const observer = new ResizeObserver(check)
		observer.observe(container)
		observer.observe(content)
		return () => observer.disconnect()
	}, [])

	return (
		<div ref={containerRef} className={cn('relative overflow-hidden min-h-6', props.className)}>
			{isLoading && <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-current mx-auto"></div>}

			{!isLoading && isCompact && (
				<div className="absolute inset-0 flex items-center">
					<Tooltip delayDuration={0}>
						<TooltipTrigger asChild>
							<div className="inline-flex items-center gap-1.5 h-6 rounded-full bg-accent px-1.5 cursor-pointer">
								<div className="flex -space-x-1.5">
									{sortedUserPresence.map(({ user, presence }) => (
										<Avatar
											key={user.discordId.toString()}
											style={{ backgroundColor: user.displayHexColor ?? undefined }}
											className={cn('h-5 w-5 ring-1 ring-background shrink-0', presence.away && 'grayscale opacity-50')}
										>
											<AvatarImage src={USR.getAvatarUrl(user)} crossOrigin="anonymous" />
											<AvatarFallback className="text-[10px]">{getUserInitials(user)}</AvatarFallback>
										</Avatar>
									))}
								</div>
								{actionCount > 0 && (
									<div className="flex items-center gap-1">
										<Loader2 className="h-3 w-3 animate-spin shrink-0" />
										<span className="text-xs font-medium">{actionCount}</span>
									</div>
								)}
							</div>
						</TooltipTrigger>
						<TooltipContent className="p-2">
							<div className="flex flex-col gap-1.5">
								{sortedUserPresence.map(({ user, presence }) => {
									const eventText = userEventText.get(user.discordId)
									const activityText = eventText
										?? (presence.activityState ? UP.getHumanReadableActivity(presence.activityState, layerList) : null)
									return (
										<div key={user.discordId.toString()} className="flex items-center gap-2">
											<Avatar
												style={{ backgroundColor: user.displayHexColor ?? undefined }}
												className={cn('h-5 w-5 shrink-0', presence.away && 'grayscale opacity-50')}
											>
												<AvatarImage src={USR.getAvatarUrl(user)} crossOrigin="anonymous" />
												<AvatarFallback className="text-[10px]">{getUserInitials(user)}</AvatarFallback>
											</Avatar>
											<div className="flex flex-col leading-none gap-0.5">
												<span className="text-xs font-medium">
													{user.displayName}
													{loggedInUser?.discordId === user.discordId ? ' (You)' : ''}
												</span>
												{activityText && <span className="text-xs opacity-70">{activityText}</span>}
												{presence.away && presence.lastSeen && (
													<span className="text-xs opacity-70">
														Last seen {DateFns.formatDistanceToNow(new Date(presence.lastSeen), { addSuffix: true })}
													</span>
												)}
											</div>
										</div>
									)
								})}
							</div>
						</TooltipContent>
					</Tooltip>
				</div>
			)}

			{!isLoading && (
				<div ref={normalContentRef} className={cn('flex flex-nowrap items-center gap-1', isCompact && 'invisible')}>
					{groupedPresence.map((group) => {
						const isGrouped = group.entries.length > 1
						const key = group.activityText ?? group.entries[0].user.discordId.toString()

						if (isGrouped) {
							return (
								<div key={key} className="flex items-center space-x-1">
									<div
										className={cn(
											'inline-flex items-center gap-1.5 h-6 py-0 rounded-full transition-all duration-200',
											'bg-accent pr-2',
										)}
									>
										<div className="flex -space-x-1.5 shrink-0">
											{group.entries.map(({ user, presence }) => (
												<Tooltip key={user.discordId.toString()} delayDuration={0}>
													<TooltipTrigger asChild>
														<Avatar
															onMouseOver={() => UPClient.Actions.setHoveredActivityUserId(user.discordId, true)}
															onMouseOut={() => UPClient.Actions.setHoveredActivityUserId(user.discordId, false)}
															style={{ backgroundColor: user.displayHexColor ?? undefined }}
															className={cn(
																'h-6 w-6 transition-all duration-200 cursor-pointer ring-1 ring-background',
																presence.away && 'grayscale opacity-50',
															)}
														>
															<AvatarImage src={USR.getAvatarUrl(user)} crossOrigin="anonymous" />
															<AvatarFallback className="text-xs">
																{getUserInitials(user)}
															</AvatarFallback>
														</Avatar>
													</TooltipTrigger>
													<TooltipContent>
														<div className="text-center">
															<div className="font-medium">
																{user.displayName} {loggedInUser?.discordId === user.discordId ? '(You)' : ''}
															</div>
															{presence.away && presence.lastSeen && (
																<div className="text-xs mt-1">
																	Last seen {DateFns.formatDistanceToNow(new Date(presence.lastSeen), { addSuffix: true })}
																</div>
															)}
														</div>
													</TooltipContent>
												</Tooltip>
											))}
										</div>
										<span className="text-xs font-medium whitespace-nowrap">
											{group.activityText}
										</span>
									</div>
								</div>
							)
						}

						const { user, presence, activityText } = group.entries[0]
						return (
							<div key={user.discordId.toString()} className="flex items-center space-x-1">
								<Tooltip delayDuration={0}>
									<TooltipTrigger asChild>
										<div
											onMouseOver={() => UPClient.Actions.setHoveredActivityUserId(user.discordId, true)}
											onMouseOut={() => UPClient.Actions.setHoveredActivityUserId(user.discordId, false)}
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
														presence.away && 'grayscale opacity-50',
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
									<TooltipContent>
										<div className="text-center">
											<div className="font-medium">{user.displayName} {loggedInUser?.discordId === user.discordId ? '(You)' : ''}</div>
											{presence.away && presence.lastSeen && (
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
			)}
		</div>
	)
}
