import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as MapUtils from '@/lib/map'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as UP from '@/models/user-presence'
import type * as USR from '@/models/users.models'
import * as ConfigClient from '@/systems/config.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import * as DateFns from 'date-fns'
import { Loader2 } from 'lucide-react'
import React from 'react'
import type * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const EVENT_TEXT_DURATION = 2000

// -------- cross-panel visible-client registry --------
// A user's clients can be split across panels (e.g. one tab viewing Queue, another viewing Teams), so
// whether a user has "more than one client visible" -- and thus whether to badge their avatars with an
// ordinal -- has to be judged across ALL mounted panels, not just one. Each panel registers the clients
// it currently shows; the count below unions them (deduped by clientId).
type PanelVisibleClients = Map<string, bigint> // clientId -> userId
const visibleClientsStore = Zus.createStore<{ panels: Map<string, PanelVisibleClients> }>(() => ({ panels: new Map() }))

function setPanelVisibleClients(panelId: string, clients: PanelVisibleClients) {
	visibleClientsStore.setState((state) => {
		const panels = new Map(state.panels)
		panels.set(panelId, clients)
		return { panels }
	})
}
function removePanelVisibleClients(panelId: string) {
	visibleClientsStore.setState((state) => {
		if (!state.panels.has(panelId)) return state
		const panels = new Map(state.panels)
		panels.delete(panelId)
		return { panels }
	})
}
// per-client ordinal (1-based), assigned only among clients belonging to a user with more than
// one client visible, so a solo client never gets badged
function selectVisibleClientOrdinalByClientId(state: { panels: Map<string, PanelVisibleClients> }): Map<string, number> {
	const clientIdsByUser = new Map<bigint, Set<string>>()
	for (const clients of state.panels.values()) {
		for (const [clientId, userId] of clients) {
			let clientIds = clientIdsByUser.get(userId)
			if (!clientIds) {
				clientIds = new Set()
				clientIdsByUser.set(userId, clientIds)
			}
			clientIds.add(clientId)
		}
	}
	const ordinals = new Map<string, number>()
	for (const clientIds of clientIdsByUser.values()) {
		if (clientIds.size <= 1) continue
		;[...clientIds].sort().forEach((clientId, i) => ordinals.set(clientId, i + 1))
	}
	return ordinals
}

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

type PresenceEntry = { clientId: string; user: USR.User; presence: UP.ClientPresence; activityText: string | null }
type PresenceGroup = { activityText: string | null; entries: PresenceEntry[] }

// small "reset this session" control shown in the tooltip of one of the current user's OTHER clients
function ResetSessionButton({ clientId }: { clientId: string }) {
	return (
		<button
			type="button"
			onClick={() => UPClient.Actions.resetClient(clientId)}
			className="mt-1.5 w-full rounded border border-border px-2 py-0.5 text-xs font-medium hover:bg-accent"
		>
			Reset this session
		</button>
	)
}

// Avatar plus presence chrome: greyed out when away, encircled by a spinner while the client's
// connection is interrupted (socket dropped but activity is being held for a possible reconnect).
// `badge` (a per-user client ordinal) distinguishes a user's multiple clients. forwardRef + prop
// spread so it can be a Radix TooltipTrigger `asChild` target.
const PresenceAvatar = React.forwardRef<
	HTMLSpanElement,
	& {
		user: USR.User
		presence: UP.ClientPresence
		size: string
		badge?: React.ReactNode
		// the badge for the viewer's own current client is highlighted (green) to set it apart
		badgeCurrent?: boolean
		avatarClassName?: string
		fallbackClassName?: string
	}
	& React.HTMLAttributes<HTMLSpanElement>
>(function PresenceAvatar({ user, presence, size, badge, badgeCurrent, avatarClassName, fallbackClassName, ...rest }, ref) {
	const interrupted = presence.connectionState === 'connection-interrupted'
	return (
		<span ref={ref} className={cn('relative isolate inline-flex shrink-0', size)} {...rest}>
			{interrupted && (
				<Loader2 className="pointer-events-none absolute -inset-[3px] h-[calc(100%+6px)] w-[calc(100%+6px)] animate-spin text-primary" />
			)}
			<Avatar
				style={{ backgroundColor: user.displayHexColor ?? undefined }}
				className={cn('h-full w-full', presence.away && 'grayscale opacity-50', avatarClassName)}
			>
				<AvatarImage src={user.avatarUrl} crossOrigin="anonymous" />
				<AvatarFallback className={fallbackClassName}>{user.displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
			</Avatar>
			{badge !== undefined && (
				<span
					className={cn(
						'pointer-events-none absolute -bottom-1 -right-1 z-10 flex h-3 min-w-3 items-center justify-center rounded-full px-0.5 text-[8px] font-bold leading-none ring-1 ring-background',
						badgeCurrent ? 'bg-green-600 text-white' : 'bg-primary text-primary-foreground',
					)}
				>
					{badge}
				</span>
			)}
		</span>
	)
})

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

	// per-client (not deduped by user): each of a user's tabs/devices shows separately
	const matchingClientPresence = ZusUtils.useStore(
		UPClient.Store,
		ZusUtils.useDeep(state =>
			MapUtils.filter(state.presence, (_clientId, presence) => props.matchActivity ? props.matchActivity(presence.activityState) : true)
		),
	)
	const myClientId = ZusUtils.useStore(ConfigClient.Store, config => config?.wsClientId)

	const allUserIds = new Set(Array.from(matchingClientPresence.values(), p => p.userId))

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

	// Sort clients based on presence priority
	const sortedClientPresence = React.useMemo(() => {
		const oldestLastSeenToDisplay = Date.now() - UP.DISPLAYED_AWAY_PRESENCE_WINDOW
		const clientList = Array.from(matchingClientPresence.entries()).map(([clientId, presence]) => {
			const user = userMap.get(presence.userId)
			return user ? { clientId, user, presence } : null
		}).filter((item): item is { clientId: string; user: USR.User; presence: UP.ClientPresence } => {
			if (!item) return false
			// Only show clients that are not away, or that have been seen in the last 5 minutes
			if (!item.presence.away) return true
			if (!item.presence.lastSeen) return false
			return item.presence.lastSeen > oldestLastSeenToDisplay
		})

		return props.sourcePresenceFn ? clientList.sort(props.sourcePresenceFn) : clientList
	}, [
		matchingClientPresence,
		userMap,
		props.sourcePresenceFn,
	])

	// publish the clients this panel is showing to the shared registry, and read back the count of each
	// user's clients across ALL panels -- a user with more than one visible (even split across panels)
	// gets an ordinal badge on each avatar so they can be told apart
	const panelId = React.useId()
	React.useEffect(() => {
		const clients: PanelVisibleClients = new Map()
		for (const { clientId, user } of sortedClientPresence) clients.set(clientId, user.discordId)
		setPanelVisibleClients(panelId, clients)
	}, [panelId, sortedClientPresence])
	React.useEffect(() => () => removePanelVisibleClients(panelId), [panelId])

	const clientOrdinalByClientId = ZusUtils.useStore(visibleClientsStore, ZusUtils.useDeep(selectVisibleClientOrdinalByClientId))

	const badgeFor = React.useCallback(
		(entry: { clientId: string }) => clientOrdinalByClientId.get(entry.clientId),
		[clientOrdinalByClientId],
	)
	const isMyOtherClient = React.useCallback(
		(entry: { clientId: string; user: USR.User }) => entry.user.discordId === loggedInUser?.discordId && entry.clientId !== myClientId,
		[loggedInUser?.discordId, myClientId],
	)

	const groupedPresence = React.useMemo((): PresenceGroup[] => {
		const entries: PresenceEntry[] = sortedClientPresence.map(({ clientId, user, presence }) => {
			let activityText: string | null = null
			const eventText = userEventText.get(user.discordId)
			const activityForText = props.matchActivityForStatusText?.(presence.activityState)
			// const
			if (eventText) activityText = eventText
			else if (activityForText) {
				activityText = UP.getHumanReadableActivity(activityForText, layerList)
			}
			return { clientId, user, presence, activityText }
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
		sortedClientPresence,
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
									{sortedClientPresence.map((entry) => (
										<PresenceAvatar
											key={entry.clientId}
											user={entry.user}
											presence={entry.presence}
											badge={badgeFor(entry)}
											badgeCurrent={entry.clientId === myClientId}
											size="h-5 w-5"
											avatarClassName="ring-1 ring-background"
											fallbackClassName="text-[10px]"
										/>
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
								{sortedClientPresence.map((entry) => {
									const { clientId, user, presence } = entry
									const eventText = userEventText.get(user.discordId)
									const activityText = eventText
										?? (presence.activityState ? UP.getHumanReadableActivity(presence.activityState, layerList) : null)
									return (
										<div key={clientId} className="flex items-center gap-2">
											<PresenceAvatar
												user={user}
												presence={presence}
												badge={badgeFor(entry)}
												badgeCurrent={entry.clientId === myClientId}
												size="h-5 w-5"
												fallbackClassName="text-[10px]"
											/>
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
												{isMyOtherClient(entry) && <ResetSessionButton clientId={clientId} />}
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
						const key = group.activityText ?? group.entries[0].clientId

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
											{group.entries.map((entry) => {
												const { clientId, user, presence } = entry
												return (
													<Tooltip key={clientId} delayDuration={0}>
														<TooltipTrigger asChild>
															<PresenceAvatar
																onMouseOver={() => UPClient.Actions.setHoveredActivityUserId(user.discordId, true)}
																onMouseOut={() => UPClient.Actions.setHoveredActivityUserId(user.discordId, false)}
																user={user}
																presence={presence}
																badge={badgeFor(entry)}
																badgeCurrent={entry.clientId === myClientId}
																size="h-6 w-6"
																avatarClassName="transition-all duration-200 cursor-pointer ring-1 ring-background"
																fallbackClassName="text-xs"
															/>
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
																{isMyOtherClient(entry) && <ResetSessionButton clientId={clientId} />}
															</div>
														</TooltipContent>
													</Tooltip>
												)
											})}
										</div>
										<span className="text-xs font-medium whitespace-nowrap">
											{group.activityText}
										</span>
									</div>
								</div>
							)
						}

						const entry = group.entries[0]
						const { clientId, user, presence, activityText } = entry
						return (
							<div key={clientId} className="flex items-center space-x-1">
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
												<PresenceAvatar
													user={user}
													presence={presence}
													badge={badgeFor(entry)}
													badgeCurrent={entry.clientId === myClientId}
													size="h-6 w-6"
													avatarClassName="transition-all duration-200"
													fallbackClassName="text-xs"
												/>
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
											{isMyOtherClient(entry) && <ResetSessionButton clientId={clientId} />}
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
