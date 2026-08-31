import * as Icons from 'lucide-react'

import { EventTime } from '@/components/event-time'
import { PlayerDisplay } from '@/components/player-display'
import ShortLayerName from '@/components/short-layer-name'
import { MatchTeamDisplay } from '@/components/teams-display'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as ZodUtils from '@/lib/zod-utils'
import * as Zus from '@/lib/zustand'
import * as AppEvents_Msgs from '@/messages/app-events.messages'
import * as CHAT_Msgs from '@/messages/chat.messages'
import * as AppEvents from '@/models/app-events.models'
import type * as CHAT from '@/models/chat.models'
import type * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import type * as USR from '@/models/users.models'
import { tr } from '@/systems/messages.client'
import * as PartsSys from '@/systems/parts.client'
import * as PluginsClient from '@/systems/plugins.client'
import * as UsersClient from '@/systems/users.client'

import { PluginErrorBoundary } from './plugin-slot.tsx'

// warns render like chat messages, keyed by who was targeted. `admins` is the admin chat channel's own colour
// (just a different channel name); `single`/`selection` inherit WarnChatBox's warm warn accent, split into two
// tones so a warn aimed at one player reads distinctly from a bulk warn against a whole selection.
const WARN_CHANNEL_STYLES = {
	admins: { color: 'hsl(var(--admin))', gradientColor: 'hsl(var(--admin) / 0.1)' },
	single: { color: 'rgb(251, 146, 60)', gradientColor: 'rgba(251, 146, 60, 0.1)' }, // orange-400, WarnChatBox targeted-warn accent
	selection: { color: 'rgb(245, 158, 11)', gradientColor: 'rgba(245, 158, 11, 0.1)' }, // amber-500, a bulk/group warn
} as const

// Shared layout for a feed entry: a non-shrinking time + icon gutter, then a text column that wraps.
// The text column has to stay a block rather than a flex row -- a flex row can't break between its
// items, which is what pinned entries to a single line and forced the feed to scroll horizontally.
// Inline atoms (player/squad/team/layer displays) keep themselves intact via their own nowrap, so
// lines break between them rather than through them.
//
// wrap-anywhere rather than wrap-break-word: radix sizes the scroll viewport's content as a table,
// so the feed's width follows its max-content width. Only `anywhere` shrinks an element's min-content
// contribution, so it's what stops one long username or unbroken message from widening the whole feed.
function EventLine({
	time,
	icon,
	className,
	style,
	children,
}: {
	time: number
	icon?: React.ReactNode
	className?: string
	style?: React.CSSProperties
	children: React.ReactNode
}) {
	return (
		<div className={cn('flex gap-2 py-1 text-xs text-muted-foreground w-full min-w-0 items-baseline', className)} style={style}>
			<EventTime time={time} variant="small" />
			{icon}
			<div className="grow min-w-0 wrap-anywhere">{children}</div>
		</div>
	)
}

// display names for the SLM users an event attributes work to. Users already in the parts store (or the viewer
// themselves) need no fetch; the rest are fetched in one batch.
function useUserLabels(userIds: USR.UserId[]) {
	const loggedInUser = UsersClient.useLoggedInUser()
	const unresolved = userIds.filter((id) => !PartsSys.findUser(id) && id !== loggedInUser?.discordId)
	const res = UsersClient.useUsers(unresolved, { enabled: unresolved.length > 0 })
	const fetched = new Map((res.data?.code === 'ok' ? res.data.users : []).map((u) => [u.discordId, u.displayName]))
	return (userId: USR.UserId) => {
		if (userId === loggedInUser?.discordId) return loggedInUser.displayName
		return PartsSys.findUser(userId)?.displayName ?? fetched.get(userId) ?? tr.text(AppEvents_Msgs.unnamedSlmUser())
	}
}

function QueueChangeLayers({ layerIds }: { layerIds: L.LayerId[] }) {
	const shown = layerIds.slice(0, 3)
	return (
		<span className="inline-flex items-baseline gap-1 flex-wrap">
			{shown.map((layerId, i) => (
				<span key={layerId} className="inline-flex items-baseline">
					<ShortLayerName layerId={layerId} />
					{i < shown.length - 1 ? ',' : ''}
				</span>
			))}
			{layerIds.length > shown.length && <span>{tr.text(AppEvents_Msgs.queueAndMore(layerIds.length - shown.length))}</span>}
		</span>
	)
}

function QueueChangeLine({ change, labelFor }: { change: AppEvents.QueueChange; labelFor: (userId: USR.UserId) => string }) {
	const who =
		change.actor.type === 'slm-user'
			? labelFor(change.actor.userId)
			: change.actor.type === 'system'
				? tr.text(AppEvents_Msgs.systemActor())
				: tr.text(AppEvents_Msgs.unnamedIngameAdmin())
	const layers = <QueueChangeLayers layerIds={change.layerIds} />
	const vote = change.isVote ? tr.text(AppEvents_Msgs.queueVoteChoices(change.layerIds.length)) : null

	const [marker, markerClass, body] = ((): [string, string, React.ReactNode] => {
		switch (change.kind) {
			case 'added':
				return ['+', 'text-added', tr.richText(AppEvents_Msgs.queueItemAdded(who, vote, layers))]
			case 'removed':
				return ['−', 'text-destructive', tr.richText(AppEvents_Msgs.queueItemRemoved(who, vote, layers))]
			case 'edited':
				return [
					'~',
					'text-amber-500',
					tr.richText(AppEvents_Msgs.queueItemEdited(who, <QueueChangeLayers layerIds={change.prevLayerIds} />, layers)),
				]
			case 'moved':
				return [
					'↕',
					'text-indigo-400',
					tr.richText(AppEvents_Msgs.queueItemMoved(who, layers, change.fromIndex + 1, change.toIndex + 1)),
				]
			default:
				assertNever(change)
		}
	})()

	return (
		<div className="flex gap-2 items-baseline text-xs text-muted-foreground">
			<span className={cn('font-mono shrink-0', markerClass)}>{marker}</span>
			<span className="grow min-w-0 wrap-anywhere">{body}</span>
		</div>
	)
}

// a save of the layer queue. The summary names who saved and the net effect; expanding attributes each surviving
// change to the user who made it, which is the part a shared queue actually needs (several admins edit at once).
function QueueUpdatedEvent({
	event,
	appEvent,
	actorLabel,
	stores,
}: {
	event: Extract<CHAT.EventEnriched, { type: 'APP_EVENT' }>
	appEvent: AppEvents.QueueUpdated
	actorLabel: React.ReactNode
	stores: SquadServerFrame.KeyProp
}) {
	const changes = AppEvents.summarizeQueueChanges(appEvent)
	const contributors = changes.flatMap((c) => (c.actor.type === 'slm-user' ? [c.actor.userId] : []))
	const labelFor = useUserLabels([...new Set([...contributors, ...(appEvent.save?.overrodeEditors ?? [])])])
	const matchId = event.matchId

	const counts = {
		added: changes.filter((c) => c.kind === 'added').length,
		removed: changes.filter((c) => c.kind === 'removed').length,
		edited: changes.filter((c) => c.kind === 'edited').length,
		moved: changes.filter((c) => c.kind === 'moved').length,
	}

	const overrode = appEvent.save?.overrodeEditors ?? []
	const kind = AppEvents.queueUpdateKind(appEvent)
	const headline: React.ReactNode = ((): React.ReactNode => {
		switch (kind) {
			case 'roll':
				return tr.text(AppEvents_Msgs.queueAdvancedOnRoll())
			case 'external-layer-change': {
				const external = AppEvents.queueUpdateExternalSource(appEvent)
				const who =
					external?.type === 'player' && event.actorPlayer && matchId !== null ? (
						<PlayerDisplay showTeam player={event.actorPlayer} matchId={matchId} stores={stores} />
					) : external?.type === 'player' ? (
						tr.text(CHAT_Msgs.ingameAdmin())
					) : external?.type === 'rcon' ? (
						tr.text(CHAT_Msgs.anotherRconTool())
					) : null
				// a layer SLM found already set has no actor to name (see externalActor)
				return who ? tr.richText(AppEvents_Msgs.queueSyncedTo(who)) : tr.text(AppEvents_Msgs.queueSyncedOutsideSlm())
			}
			case 'generated':
				return tr.text(AppEvents_Msgs.queueGenerated())
			case 'vote-result':
				return tr.text(AppEvents_Msgs.queueVoteApplied())
			case 'force-save':
			case 'save':
				return tr.richText(
					AppEvents_Msgs.queueSaved(
						actorLabel,
						!!appEvent.save?.force,
						overrode.length > 0 ? tr.text(AppEvents_Msgs.joinNames(overrode.map(labelFor))) : undefined,
					),
				)
			default:
				assertNever(kind)
		}
	})()

	const nextBefore = LL.getNextLayerId(appEvent.prevList)
	const nextAfter = LL.getNextLayerId(appEvent.list)
	const summary = (
		<>
			{headline}
			{tr.text(AppEvents_Msgs.queueChangeCounts(counts))}
			{nextAfter !== null && nextAfter !== nextBefore && (
				<span className="inline-flex items-baseline gap-1">
					{tr.richText(
						AppEvents_Msgs.queueNextLayer(appEvent.trigger === 'external-layer-change', <ShortLayerName layerId={nextAfter} />),
					)}
				</span>
			)}
		</>
	)
	const icon = <Icons.ListOrdered className="h-4 w-4 text-indigo-500 shrink-0" />

	if (changes.length === 0) {
		return (
			<EventLine time={event.time} icon={icon}>
				{summary}
			</EventLine>
		)
	}

	return (
		<details className="py-1 text-xs text-muted-foreground w-full min-w-0">
			<summary className="flex gap-2 items-baseline cursor-pointer">
				<EventTime time={event.time} variant="small" />
				{icon}
				<span className="grow min-w-0 wrap-anywhere">{summary}</span>
			</summary>
			<div className="pl-6 pt-1 flex flex-col gap-0.5">
				{changes.map((change) => (
					<QueueChangeLine key={`${change.kind}:${change.itemId}`} change={change} labelFor={labelFor} />
				))}
			</div>
		</details>
	)
}

// a change to the teamswaps queued for the next map. The summary names who changed it and the net effect;
// expanding lists each swap, attributed to whoever queued that player (a save commits every admin's pending marks).
function TeamswapsUpdatedEvent({
	event,
	appEvent,
	actorLabel,
	stores,
}: {
	event: Extract<CHAT.EventEnriched, { type: 'APP_EVENT' }>
	appEvent: AppEvents.TeamswapsUpdated
	actorLabel: React.ReactNode
	stores: SquadServerFrame.KeyProp
}) {
	const changes = AppEvents.summarizeTeamswapChanges(appEvent)
	const queuedBy = changes.flatMap((c) => (c.kind === 'added' && c.byUserId ? [c.byUserId] : []))
	const labelFor = useUserLabels([...new Set(queuedBy)])
	const matchId = event.matchId
	const playerFor = (playerId: string) => event.targetPlayers.find((p) => p.ids.eos === playerId)

	const added = changes.filter((c) => c.kind === 'added').length
	const removed = changes.filter((c) => c.kind === 'removed').length
	const queued = appEvent.swaps.size

	const summary: React.ReactNode =
		appEvent.trigger === 'executed' || appEvent.trigger === 'swapped-now'
			? // an execution with no actor is the map roll firing the queue; a manual one names the admin who fired it
				appEvent.actor.type === 'system'
				? tr.text(AppEvents_Msgs.teamswapsExecutedOnRoll(removed))
				: tr.richText(AppEvents_Msgs.teamswapsExecuted(actorLabel, removed))
			: appEvent.trigger === 'roster-change'
				? tr.text(AppEvents_Msgs.teamswapsDropped(removed))
				: queued === 0
					? tr.richText(AppEvents_Msgs.teamswapsCleared(actorLabel))
					: tr.richText(AppEvents_Msgs.teamswapsUpdated(actorLabel, added, removed, queued))
	const icon = <Icons.ArrowLeftRight className="h-4 w-4 text-cyan-500 shrink-0" />

	if (changes.length === 0 || matchId === null) {
		return (
			<EventLine time={event.time} icon={icon}>
				{summary}
			</EventLine>
		)
	}

	return (
		<details className="py-1 text-xs text-muted-foreground w-full min-w-0">
			<summary className="flex gap-2 items-baseline cursor-pointer">
				<EventTime time={event.time} variant="small" />
				{icon}
				<span className="grow min-w-0 wrap-anywhere">{summary}</span>
			</summary>
			<div className="pl-6 pt-1 flex flex-col gap-0.5">
				{changes.map((change) => {
					const player = playerFor(change.playerId)
					// the swap's own actor is only worth naming when it wasn't the admin this event is attributed to
					const queuedBy =
						change.kind === 'added' &&
						change.byUserId &&
						!(appEvent.actor.type === 'slm-user' && appEvent.actor.userId === change.byUserId)
							? labelFor(change.byUserId)
							: undefined
					return (
						<div key={`${change.kind}:${change.playerId}`} className="flex gap-2 items-baseline text-xs text-muted-foreground">
							<span className={cn('font-mono shrink-0', change.kind === 'added' ? 'text-emerald-400' : 'text-rose-400')}>
								{change.kind === 'added' ? '+' : '−'}
							</span>
							<span className="grow min-w-0 wrap-anywhere">
								{tr.richText(
									AppEvents_Msgs.teamswapLine(
										player ? <PlayerDisplay showTeam player={player} matchId={matchId} stores={stores} /> : change.playerId,
										<MatchTeamDisplay matchId={matchId} teamId={change.toTeam} stores={stores} />,
										queuedBy,
									),
								)}
							</span>
						</div>
					)
				})}
			</div>
		</details>
	)
}

// an app (audit) event, e.g. a warnAll that aggregates its individual PLAYER_WARNED server events into one
// expandable entry. Uses a native <details> so no local state is needed.
// The icons a plugin may pick from for its own events. Fixed markup per name so a plugin line looks like
// every other feed line, and so no plugin has to ship an icon set.
const PLUGIN_EVENT_ICONS: Record<PluginsClient.EventIcon, React.ReactNode> = {
	plugin: <Icons.Puzzle className="h-4 w-4 text-slate-400 shrink-0" />,
	info: <Icons.Info className="h-4 w-4 text-blue-400 shrink-0" />,
	success: <Icons.CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />,
	warning: <Icons.AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />,
	error: <Icons.XCircle className="h-4 w-4 text-red-500 shrink-0" />,
}

// A plugin's own event. The plugin may have registered a renderer for this event name (see
// registerEventRenderer), which supplies the predicate only -- the plugin's name stays the prefix, as on
// every other feed line. Without one, the line is the `message` the event recorded, which is also what the
// audit log shows and what an admin sees while the plugin is stopped.
function PluginEventLine({ appEvent, time, actorLabel }: { appEvent: AppEvents.PluginEvent; time: number; actorLabel: React.ReactNode }) {
	// subscription only: a version bump re-renders this so the renderer map is re-read live
	Zus.useStore(PluginsClient.Store, (s) => s.version)
	const rendering = PluginsClient.getEventRendering(appEvent.pluginId, {
		name: appEvent.name,
		payload: appEvent.payload,
		message: appEvent.message,
		time: appEvent.time,
		serverId: appEvent.serverId,
		matchId: appEvent.matchId,
	})
	return (
		<EventLine time={time} icon={PLUGIN_EVENT_ICONS[rendering?.icon ?? 'plugin']}>
			{rendering
				? tr.richText(
						AppEvents_Msgs.pluginLine(
							actorLabel,
							<PluginErrorBoundary pluginId={appEvent.pluginId}>{rendering.content}</PluginErrorBoundary>,
						),
					)
				: tr.richText(AppEvents_Msgs.genericLine(actorLabel, AppEvents_Msgs.describeAppEvent(appEvent)))}
		</EventLine>
	)
}

export function AppEventEntry({
	event,
	stores,
}: {
	event: Extract<CHAT.EventEnriched, { type: 'APP_EVENT' }>
	stores: SquadServerFrame.KeyProp
}) {
	const appEvent = event.appEvent
	// resolve the acting user's display name (hooks must run before any early return)
	const actorUserId = appEvent.actor.type === 'slm-user' ? appEvent.actor.userId : undefined
	const loggedInUser = UsersClient.useLoggedInUser()
	const userPartial = actorUserId ? PartsSys.findUser(actorUserId) : undefined
	const isMe = !!actorUserId && actorUserId === loggedInUser?.discordId
	const userRes = UsersClient.useUser(actorUserId, { enabled: !!actorUserId && !userPartial && !isMe })
	const actorUser = (userRes.data?.code === 'ok' ? userRes.data.user : undefined) ?? userPartial ?? (isMe ? loggedInUser : undefined)
	const matchId = event.matchId
	// a plugin can be the actor on more than its own events: ending a match and editing the queue are both
	// attributed to it. Its display name, or its id while the plugin list is still loading.
	const actorPluginId = appEvent.actor.type === 'plugin' ? appEvent.actor.pluginId : undefined
	const pluginName = Zus.useStore(PluginsClient.Store, (s) =>
		actorPluginId ? (s.plugins.find((p) => p.id === actorPluginId)?.name ?? actorPluginId) : undefined,
	)

	// an in-game admin is named like anyone else in the feed: enrichment resolved them from the roster (see
	// enrichAppEvent), and the fallback only applies to someone who left before the roster last reset
	const actorLabel: React.ReactNode =
		appEvent.actor.type === 'slm-user' ? (
			(actorUser?.displayName ?? tr.text(AppEvents_Msgs.unnamedSlmUser()))
		) : appEvent.actor.type === 'system' ? (
			tr.text(AppEvents_Msgs.systemActor())
		) : appEvent.actor.type === 'plugin' ? (
			pluginName
		) : event.actorPlayer && matchId !== null ? (
			<PlayerDisplay player={event.actorPlayer} matchId={matchId} stores={stores} />
		) : (
			tr.text(AppEvents_Msgs.unnamedIngameAdmin())
		)

	// expandable list of the players involved (targets, or a disbanded squad's members)
	const targetList =
		matchId !== null && event.targetPlayers.length > 0 ? (
			<div className="pl-6 pt-1 flex flex-col gap-0.5">
				{event.targetPlayers.map((player) => (
					<PlayerDisplay key={player.ids.eos} showTeam player={player} matchId={matchId} stores={stores} />
				))}
			</div>
		) : null

	if (appEvent.type === 'SQUAD_DISBANDED') {
		const n = appEvent.members.length
		return (
			<details className="py-1 text-xs text-muted-foreground w-full min-w-0">
				<summary className="flex gap-2 items-baseline cursor-pointer">
					<EventTime time={event.time} variant="small" />
					<Icons.Users className="h-4 w-4 text-red-500 shrink-0" />
					<span className="grow min-w-0 wrap-anywhere">
						{tr.richText(AppEvents_Msgs.squadDisbanded(actorLabel, appEvent.squadName, appEvent.teamId, appEvent.reason?.label, n))}
					</span>
				</summary>
				{targetList}
			</details>
		)
	}

	// pure-audit / single-line entries with no target-count summary
	if (appEvent.type === 'SQUAD_RENAMED') {
		return (
			<EventLine time={event.time} icon={<Icons.PencilLine className="h-4 w-4 text-cyan-500 shrink-0" />}>
				{tr.richText(AppEvents_Msgs.squadRenamed(actorLabel, appEvent.squadName, appEvent.teamId))}
			</EventLine>
		)
	}
	if (appEvent.type === 'COMMANDER_DEMOTED') {
		const target = event.targetPlayers[0]
		return (
			<EventLine time={event.time} icon={<Icons.ShieldOff className="h-4 w-4 text-orange-500 shrink-0" />}>
				{tr.richText(
					AppEvents_Msgs.commanderDemoted(
						actorLabel,
						target && matchId !== null ? (
							<PlayerDisplay showTeam player={target} matchId={matchId} stores={stores} />
						) : (
							tr.text(AppEvents_Msgs.theCommander())
						),
						appEvent.reason?.label,
					),
				)}
			</EventLine>
		)
	}
	if (appEvent.type === 'FOG_OF_WAR_TOGGLED') {
		return (
			<EventLine time={event.time} icon={<Icons.CloudFog className="h-4 w-4 text-slate-400 shrink-0" />}>
				{tr.richText(AppEvents_Msgs.fogOfWarToggled(actorLabel, appEvent.enabled))}
			</EventLine>
		)
	}
	// the ADMIN_BROADCAST server event this produced is attributed to it and collapses under this entry, so the
	// broadcast is shown once, with its sender
	if (appEvent.type === 'BROADCAST_SENT') {
		return (
			<EventLine time={event.time} icon={<Icons.Megaphone className="h-4 w-4 text-amber-500 shrink-0" />}>
				{tr.richText(AppEvents_Msgs.broadcastSent(actorLabel, appEvent.message))}
			</EventLine>
		)
	}
	if (appEvent.type === 'PLAYER_TIMED_OUT') {
		const target = event.targetPlayers[0]
		return (
			<EventLine time={event.time} icon={<Icons.UserX className="h-4 w-4 text-red-500 shrink-0" />}>
				{tr.richText(
					AppEvents_Msgs.playerTimedOut(
						actorLabel,
						target && matchId !== null ? (
							<PlayerDisplay showTeam player={target} matchId={matchId} stores={stores} />
						) : (
							tr.text(AppEvents_Msgs.aPlayer())
						),
						ZodUtils.formatHumanTime(appEvent.durationMs),
						appEvent.reason?.label,
					),
				)}
			</EventLine>
		)
	}
	if (appEvent.type === 'TIMEOUT_CANCELLED') {
		const target = event.targetPlayers[0]
		return (
			<EventLine time={event.time} icon={<Icons.UserCheck className="h-4 w-4 text-green-500 shrink-0" />}>
				{tr.richText(
					AppEvents_Msgs.timeoutCancelled(
						actorLabel,
						target && matchId !== null ? (
							<PlayerDisplay showTeam player={target} matchId={matchId} stores={stores} />
						) : (
							tr.text(AppEvents_Msgs.aPlayer())
						),
					),
				)}
			</EventLine>
		)
	}
	if (appEvent.type === 'MATCH_ENDED') {
		return (
			<EventLine time={event.time} icon={<Icons.Flag className="h-4 w-4 text-red-500 shrink-0" />}>
				{tr.richText(AppEvents_Msgs.matchEnded(actorLabel))}
			</EventLine>
		)
	}
	if (appEvent.type === 'VOTE_STARTED') {
		return (
			<EventLine time={event.time} icon={<Icons.Vote className="h-4 w-4 text-blue-500 shrink-0" />}>
				{tr.richText(AppEvents_Msgs.voteStarted(actorLabel, appEvent.choiceCount))}
			</EventLine>
		)
	}
	if (appEvent.type === 'VOTE_ENDED') {
		return (
			<EventLine time={event.time} icon={<Icons.ListChecks className="h-4 w-4 text-green-500 shrink-0" />}>
				{appEvent.reason === 'ended-early'
					? tr.richText(AppEvents_Msgs.voteEndedEarly(actorLabel))
					: tr.text(AppEvents_Msgs.voteEnded())}
				{appEvent.winnerLayerId
					? tr.richText(AppEvents_Msgs.voteWinner(<ShortLayerName layerId={appEvent.winnerLayerId} />))
					: tr.text(AppEvents_Msgs.voteNoWinner())}
			</EventLine>
		)
	}
	if (appEvent.type === 'VOTE_ABORTED') {
		return (
			<EventLine time={event.time} icon={<Icons.Ban className="h-4 w-4 text-red-500 shrink-0" />}>
				{tr.richText(AppEvents_Msgs.voteAborted(actorLabel))}
			</EventLine>
		)
	}
	if (appEvent.type === 'QUEUE_UPDATED') {
		return <QueueUpdatedEvent event={event} appEvent={appEvent} actorLabel={actorLabel} stores={stores} />
	}
	if (appEvent.type === 'TEAMSWAPS_UPDATED') {
		return <TeamswapsUpdatedEvent event={event} appEvent={appEvent} actorLabel={actorLabel} stores={stores} />
	}
	if (appEvent.type === 'MAP_SET') {
		// audit-only (see AppEvents.isFeedVisible): its QUEUE_UPDATED already names the layer, so drawing this too
		// would just repeat it. Only override sets are worth a line of their own.
		if (appEvent.reason === 'queue-updated') return null
		const icon = <Icons.RefreshCw className="h-4 w-4 text-amber-500 shrink-0" />
		// nobody was seen setting the layer SLM is replacing -- it was already set when SLM connected
		if (!appEvent.overrode || appEvent.overrode.type === 'unknown') {
			return (
				<EventLine time={event.time} icon={icon}>
					{tr.richText(AppEvents_Msgs.nextLayerRestored(<ShortLayerName layerId={appEvent.layerId} />))}
				</EventLine>
			)
		}
		// the overridden player (if any) is resolved into targetPlayers via involvedPlayerIds
		const overrodePlayer = event.targetPlayers[0]
		const who =
			appEvent.overrode.type === 'player' && overrodePlayer && matchId !== null ? (
				<PlayerDisplay showTeam player={overrodePlayer} matchId={matchId} stores={stores} />
			) : appEvent.overrode.type === 'player' ? (
				tr.text(CHAT_Msgs.ingameAdmin())
			) : (
				tr.text(CHAT_Msgs.anotherRconTool())
			)
		return (
			<EventLine time={event.time} icon={icon}>
				{tr.richText(AppEvents_Msgs.nextLayerOverrode(who, <ShortLayerName layerId={appEvent.layerId} />))}
			</EventLine>
		)
	}
	if (appEvent.type === 'LAYER_REQUEST_ADDED' || appEvent.type === 'LAYER_REQUEST_REMOVED' || appEvent.type === 'LAYER_REQUEST_CONSUMED') {
		const icon =
			appEvent.type === 'LAYER_REQUEST_CONSUMED' ? (
				<Icons.CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
			) : appEvent.type === 'LAYER_REQUEST_ADDED' ? (
				<Icons.ListPlus className="h-4 w-4 text-blue-400 shrink-0" />
			) : (
				<Icons.ListX className="h-4 w-4 text-orange-500 shrink-0" />
			)
		return (
			<EventLine time={event.time} icon={icon}>
				{tr.richText(AppEvents_Msgs.genericLine(actorLabel, AppEvents_Msgs.describeAppEvent(appEvent)))}
			</EventLine>
		)
	}
	if (appEvent.type === 'PLUGIN_EVENT') {
		return <PluginEventLine appEvent={appEvent} time={event.time} actorLabel={actorLabel} />
	}
	if (
		appEvent.type === 'SETTINGS_UPDATED' ||
		appEvent.type === 'SERVER_REGISTRY_CHANGED' ||
		appEvent.type === 'FILTER_CHANGED' ||
		appEvent.type === 'FILTER_CONTRIBUTOR_CHANGED' ||
		appEvent.type === 'USER_ACCOUNT_CHANGED' ||
		appEvent.type === 'PLAYER_FLAGS_UPDATED' ||
		appEvent.type === 'APP_STARTED' ||
		appEvent.type === 'APP_RESTARTED' ||
		appEvent.type === 'BACKUP_CREATED' ||
		appEvent.type === 'PLUGIN_DATA_PURGED' ||
		appEvent.type === 'MATCH_LAYERS_RECONCILED'
	) {
		// global/audit-only types -- they never reach a server activity feed (matchId null), but the union needs a
		// branch. rendered generically via describeAppEvent (the audit log is where these actually show up).
		return (
			<EventLine time={event.time} icon={<Icons.ScrollText className="h-4 w-4 text-slate-400 shrink-0" />}>
				{tr.richText(AppEvents_Msgs.genericLine(actorLabel, AppEvents_Msgs.describeAppEvent(appEvent)))}
			</EventLine>
		)
	}

	// warns render message-style (colored channel + border + gradient) like a chat message, with the channel naming
	// both ends of the warn ("(X warned Y): ...") rather than a chat scope. The verb stays inside the channel because
	// the warn body may itself carry an admin's name (the warn box's optional username prefix), and a bare sender
	// prefix would make the attribution indistinguishable from that.
	if (appEvent.type === 'PLAYER_WARNED') {
		const warnCount = appEvent.targets.length
		const summary = event.warnSummary
		// one resolved target is always named, even when the grouping classifier would rather call them
		// "everyone on Team 2" (which it does whenever that player happens to be alone on their team)
		const single = warnCount === 1 && matchId !== null && event.targetPlayers.length === 1
		const styleKey = single ? 'single' : summary.type === 'all-admins' ? 'admins' : 'selection'
		const style = WARN_CHANNEL_STYLES[styleKey]

		const warnee: React.ReactNode = single ? (
			<PlayerDisplay showTeam player={event.targetPlayers[0]} matchId={matchId!} stores={stores} />
		) : summary.type === 'all-admins' ? (
			tr.text(AppEvents_Msgs.allAdmins())
		) : (
			(() => {
				const descriptor = AppEvents_Msgs.warnTargetDescriptor(summary)
				const players = tr.text(AppEvents_Msgs.warnPlayerCount(warnCount))
				if (!descriptor) return players
				return warnCount > 1 ? tr.text(AppEvents_Msgs.warnDescriptorWithCount(descriptor, players)) : descriptor
			})()
		)

		const channel = (
			<span
				className="inline-flex items-baseline gap-1 flex-nowrap whitespace-nowrap"
				style={{ color: style.color }}
				title={tr.text(AppEvents_Msgs.warnChannelHint())}
			>
				{tr.richText(AppEvents_Msgs.warnChannel(actorLabel, warnee))}
			</span>
		)

		const header = (
			<>
				<EventTime time={event.time} />
				<div className="grow min-w-0 wrap-anywhere">
					{channel}: {appEvent.message}
				</div>
			</>
		)

		const containerStyle = {
			borderRightColor: style.color,
			backgroundImage: `linear-gradient(to left, ${style.gradientColor}, transparent)`,
		}
		// a single/named-target warn is a flat line; a bulk warn keeps an expandable list of everyone warned
		if (single || !targetList) {
			return (
				<div
					className="flex gap-2 py-1 text-xs w-full min-w-0 border-r-2 bg-linear-to-l to-transparent items-baseline"
					style={containerStyle}
				>
					{header}
				</div>
			)
		}
		return (
			<details className="py-1 text-xs w-full min-w-0 border-r-2 bg-linear-to-l to-transparent" style={containerStyle}>
				<summary className="flex gap-2 items-baseline cursor-pointer">{header}</summary>
				{targetList}
			</details>
		)
	}

	// PLAYER_REMOVED_FROM_SQUAD / TEAM_CHANGE_FORCED / SWITCH_REQUESTS_FULFILLED / PLAYER_KILLED / PLAYER_KICKED:
	// "{actor} {verb} {targets}{suffix}"
	const count = appEvent.targets.length
	let verb: AppEvents_Msgs.TargetVerb
	let icon: React.ReactNode
	let suffix: React.ReactNode
	if (appEvent.type === 'PLAYER_REMOVED_FROM_SQUAD') {
		verb = 'removed'
		icon = <Icons.UserMinus className="h-4 w-4 text-orange-500 shrink-0" />
		suffix = tr.text(AppEvents_Msgs.removedFromSquadSuffix(appEvent.reason?.label))
	} else if (appEvent.type === 'PLAYER_KICKED') {
		verb = 'kicked'
		icon = <Icons.UserX className="h-4 w-4 text-red-500 shrink-0" />
		suffix = appEvent.reason?.label ? tr.text(AppEvents_Msgs.forReasonSuffix(appEvent.reason.label)) : null
	} else if (appEvent.type === 'PLAYER_KILLED') {
		verb = 'killed'
		icon = <Icons.Skull className="h-4 w-4 text-red-500 shrink-0" />
		suffix = appEvent.reason ? tr.text(AppEvents_Msgs.killReasonSuffix(appEvent.reason)) : null
	} else if (appEvent.type === 'SWITCH_REQUESTS_FULFILLED') {
		verb = 'swapped'
		icon = <Icons.ArrowLeftRight className="h-4 w-4 text-amber-500 shrink-0" />
		suffix = tr.text(AppEvents_Msgs.switchRequestFulfilledSuffix())
	} else {
		verb = 'swapped'
		icon = <Icons.ArrowLeftRight className="h-4 w-4 text-blue-500 shrink-0" />
		suffix = tr.text(AppEvents_Msgs.swappedTeamsSuffix())
	}

	// few enough targets: name them inline instead of grouping/collapsing (but still show the count)
	if (count <= 4 && matchId !== null && event.targetPlayers.length === count) {
		const targets = event.targetPlayers.map((player, i) => (
			<span key={player.ids.eos}>
				{i > 0 ? ', ' : ''}
				<PlayerDisplay showTeam player={player} matchId={matchId} stores={stores} />
			</span>
		))
		return (
			<EventLine time={event.time} icon={icon}>
				{tr.richText(AppEvents_Msgs.actionOnNamedTargets(actorLabel, verb, targets, count, suffix))}
			</EventLine>
		)
	}

	return (
		<details className="py-1 text-xs text-muted-foreground w-full min-w-0">
			<summary className="flex gap-2 items-baseline cursor-pointer">
				<EventTime time={event.time} variant="small" />
				{icon}
				<span className="grow min-w-0 wrap-anywhere">
					{tr.richText(AppEvents_Msgs.actionOnCountedTargets(actorLabel, verb, count, suffix))}
				</span>
			</summary>
			{targetList}
		</details>
	)
}
