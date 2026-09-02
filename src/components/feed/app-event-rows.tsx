// static-render calls these components directly, so the react compiler must not inject its memo-cache hook
'use no memo'

// SLM's own actions as feed rows, as inert jsx. Same idiom as rows.tsx: no state, no hooks, no handlers, so one
// template serializes on the server and walks straight to dom on the client.
//
// The actor's display name is the one thing a row cannot derive from its event, so it comes off the ctx
// (RenderCtx.userLabel / pluginName) rather than from a query hook.
//
// A plugin that registered its own renderer is the one thing that cannot come through here: its content is
// arbitrary react supplied in the browser. Those rows draw the generic line, and the activity feed mounts the
// real renderer over the top (see feed-list.tsx).

import React from 'react'

import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as ZodUtils from '@/lib/zod-utils'
import * as AppEvents_Msgs from '@/messages/app-events.messages'
import * as CHAT_Msgs from '@/messages/chat.messages'
import * as AppEvents from '@/models/app-events.models'
import type * as CHAT from '@/models/chat.models'
import type * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import type * as USR from '@/models/users.models'
import { tr } from '@/systems/messages.client'

import * as Atoms from './atoms'
import { Icon, type IconName } from './icons'
import type * as RC from './render-context'

type AppEventEntry = Extract<CHAT.EventEnriched, { type: 'APP_EVENT' }>

// warns render like chat messages, keyed by who was targeted. `admins` is the admin chat channel's own colour
// (just a different channel name); `single`/`selection` inherit WarnChatBox's warm warn accent, split into two
// tones so a warn aimed at one player reads distinctly from a bulk warn against a whole selection.
const WARN_CHANNEL_STYLES = {
	admins: { color: 'hsl(var(--admin))', gradientColor: 'hsl(var(--admin) / 0.1)' },
	single: { color: 'rgb(251, 146, 60)', gradientColor: 'rgba(251, 146, 60, 0.1)' }, // orange-400, WarnChatBox targeted-warn accent
	selection: { color: 'rgb(245, 158, 11)', gradientColor: 'rgba(245, 158, 11, 0.1)' }, // amber-500, a bulk/group warn
} as const

const DETAILS_CLASS = 'py-1 text-xs text-muted-foreground w-full min-w-0'
const SUMMARY_CLASS = 'flex gap-2 items-baseline cursor-pointer'

function EventIcon(props: { name: IconName; className: string }) {
	return <Icon name={props.name} className={cn('h-4 w-4 shrink-0', props.className)} />
}

function labelOf(ctx: RC.RenderCtx, userId: USR.UserId): string {
	return ctx.userLabel(userId) ?? tr.text(AppEvents_Msgs.unnamedSlmUser())
}

function LayerNames(props: { ctx: RC.RenderCtx; layerIds: L.LayerId[] }) {
	const shown = props.layerIds.slice(0, 3)
	return (
		<span className="inline-flex items-baseline gap-1 flex-wrap">
			{shown.map((layerId, i) => (
				<span key={layerId} className="inline-flex items-baseline">
					<Atoms.ShortLayerName normalized={props.ctx.displayTeamsNormalized} layerId={layerId} />
					{i < shown.length - 1 ? ',' : ''}
				</span>
			))}
			{props.layerIds.length > shown.length && <span>{tr.text(AppEvents_Msgs.queueAndMore(props.layerIds.length - shown.length))}</span>}
		</span>
	)
}

function QueueChangeLine(props: { ctx: RC.RenderCtx; change: AppEvents.QueueChange }) {
	const { ctx, change } = props
	const who =
		change.actor.type === 'slm-user'
			? labelOf(ctx, change.actor.userId)
			: change.actor.type === 'system'
				? tr.text(AppEvents_Msgs.systemActor())
				: tr.text(AppEvents_Msgs.unnamedIngameAdmin())
	const layers = <LayerNames ctx={ctx} layerIds={change.layerIds} />
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
					tr.richText(AppEvents_Msgs.queueItemEdited(who, <LayerNames ctx={ctx} layerIds={change.prevLayerIds} />, layers)),
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
function QueueUpdatedRow(props: {
	ctx: RC.RenderCtx
	event: AppEventEntry
	appEvent: AppEvents.QueueUpdated
	actorLabel: React.ReactNode
}) {
	const { ctx, event, appEvent, actorLabel } = props
	const changes = AppEvents.summarizeQueueChanges(appEvent)
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
						<Atoms.PlayerDisplay ctx={ctx} showTeam player={event.actorPlayer} matchId={matchId} />
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
						overrode.length > 0 ? tr.text(AppEvents_Msgs.joinNames(overrode.map((id) => labelOf(ctx, id)))) : undefined,
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
						AppEvents_Msgs.queueNextLayer(
							appEvent.trigger === 'external-layer-change',
							<Atoms.ShortLayerName normalized={ctx.displayTeamsNormalized} layerId={nextAfter} />,
						),
					)}
				</span>
			)}
		</>
	)
	const icon = <EventIcon name="ListOrdered" className="text-indigo-500" />

	if (changes.length === 0) {
		return (
			<Atoms.EventLine time={event.time} icon={icon}>
				{summary}
			</Atoms.EventLine>
		)
	}

	return (
		<details className={DETAILS_CLASS}>
			<summary className={SUMMARY_CLASS}>
				<Atoms.EventTime time={event.time} />
				{icon}
				<span className="grow min-w-0 wrap-anywhere">{summary}</span>
			</summary>
			<div className="pl-6 pt-1 flex flex-col gap-0.5">
				{changes.map((change) => (
					<QueueChangeLine key={`${change.kind}:${change.itemId}`} ctx={ctx} change={change} />
				))}
			</div>
		</details>
	)
}

// a change to the teamswaps queued for the next map. The summary names who changed it and the net effect;
// expanding lists each swap, attributed to whoever queued that player (a save commits every admin's pending marks).
function TeamswapsUpdatedRow(props: {
	ctx: RC.RenderCtx
	event: AppEventEntry
	appEvent: AppEvents.TeamswapsUpdated
	actorLabel: React.ReactNode
}) {
	const { ctx, event, appEvent, actorLabel } = props
	const changes = AppEvents.summarizeTeamswapChanges(appEvent)
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
	const icon = <EventIcon name="ArrowLeftRight" className="text-cyan-500" />

	if (changes.length === 0 || matchId === null) {
		return (
			<Atoms.EventLine time={event.time} icon={icon}>
				{summary}
			</Atoms.EventLine>
		)
	}

	return (
		<details className={DETAILS_CLASS}>
			<summary className={SUMMARY_CLASS}>
				<Atoms.EventTime time={event.time} />
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
							? labelOf(ctx, change.byUserId)
							: undefined
					return (
						<div key={`${change.kind}:${change.playerId}`} className="flex gap-2 items-baseline text-xs text-muted-foreground">
							<span className={cn('font-mono shrink-0', change.kind === 'added' ? 'text-emerald-400' : 'text-rose-400')}>
								{change.kind === 'added' ? '+' : '−'}
							</span>
							<span className="grow min-w-0 wrap-anywhere">
								{tr.richText(
									AppEvents_Msgs.teamswapLine(
										player ? <Atoms.PlayerDisplay ctx={ctx} showTeam player={player} matchId={matchId} /> : change.playerId,
										<Atoms.MatchTeamDisplay ctx={ctx} matchId={matchId} teamId={change.toTeam} />,
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

/**
 * Whoever took the action, named the way the feed names anyone.
 *
 * A component rather than a helper so the plugin island can render the same label (see server-event.tsx).
 * An in-game admin is resolved from the roster by enrichment (see enrichAppEvent); the fallback only applies
 * to someone who left before the roster last reset.
 */
export function AppEventActor(props: { ctx: RC.RenderCtx; event: AppEventEntry }): React.ReactNode {
	const { ctx, event } = props
	const actor = event.appEvent.actor
	if (actor.type === 'slm-user') return labelOf(ctx, actor.userId)
	if (actor.type === 'system') return tr.text(AppEvents_Msgs.systemActor())
	if (actor.type === 'plugin') return ctx.pluginName(actor.pluginId) ?? actor.pluginId
	if (event.actorPlayer && event.matchId !== null) {
		return <Atoms.PlayerDisplay ctx={ctx} player={event.actorPlayer} matchId={event.matchId} />
	}
	return tr.text(AppEvents_Msgs.unnamedIngameAdmin())
}

/**
 * One app (audit) event as a feed row, or null when it draws nothing.
 *
 * Uses native <details> for the expandable entries, so nothing here needs local state.
 */
export function AppEventRow(props: { ctx: RC.RenderCtx; event: AppEventEntry }): React.ReactNode {
	const { ctx, event } = props
	const appEvent = event.appEvent
	const matchId = event.matchId

	const actorLabel = <AppEventActor ctx={ctx} event={event} />

	// expandable list of the players involved (targets, or a disbanded squad's members)
	const targetList =
		matchId !== null && event.targetPlayers.length > 0 ? (
			<div className="pl-6 pt-1 flex flex-col gap-0.5">
				{event.targetPlayers.map((player) => (
					<Atoms.PlayerDisplay key={player.ids.eos} ctx={ctx} showTeam player={player} matchId={matchId} />
				))}
			</div>
		) : null

	if (appEvent.type === 'SQUAD_DISBANDED') {
		const n = appEvent.members.length
		return (
			<details className={DETAILS_CLASS}>
				<summary className={SUMMARY_CLASS}>
					<Atoms.EventTime time={event.time} />
					<EventIcon name="Users" className="text-red-500" />
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
			<Atoms.EventLine time={event.time} icon={<EventIcon name="PencilLine" className="text-cyan-500" />}>
				{tr.richText(AppEvents_Msgs.squadRenamed(actorLabel, appEvent.squadName, appEvent.teamId))}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'COMMANDER_DEMOTED') {
		const target = event.targetPlayers[0]
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="ShieldOff" className="text-orange-500" />}>
				{tr.richText(
					AppEvents_Msgs.commanderDemoted(
						actorLabel,
						target && matchId !== null ? (
							<Atoms.PlayerDisplay ctx={ctx} showTeam player={target} matchId={matchId} />
						) : (
							tr.text(AppEvents_Msgs.theCommander())
						),
						appEvent.reason?.label,
					),
				)}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'FOG_OF_WAR_TOGGLED') {
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="CloudFog" className="text-slate-400" />}>
				{tr.richText(AppEvents_Msgs.fogOfWarToggled(actorLabel, appEvent.enabled))}
			</Atoms.EventLine>
		)
	}
	// the ADMIN_BROADCAST server event this produced is attributed to it and collapses under this entry, so the
	// broadcast is shown once, with its sender
	if (appEvent.type === 'BROADCAST_SENT') {
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="Megaphone" className="text-amber-500" />}>
				{tr.richText(AppEvents_Msgs.broadcastSent(actorLabel, appEvent.message))}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'PLAYER_TIMED_OUT') {
		const target = event.targetPlayers[0]
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="UserX" className="text-red-500" />}>
				{tr.richText(
					AppEvents_Msgs.playerTimedOut(
						actorLabel,
						target && matchId !== null ? (
							<Atoms.PlayerDisplay ctx={ctx} showTeam player={target} matchId={matchId} />
						) : (
							tr.text(AppEvents_Msgs.aPlayer())
						),
						ZodUtils.formatHumanTime(appEvent.durationMs),
						appEvent.reason?.label,
					),
				)}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'TIMEOUT_CANCELLED') {
		const target = event.targetPlayers[0]
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="UserCheck" className="text-green-500" />}>
				{tr.richText(
					AppEvents_Msgs.timeoutCancelled(
						actorLabel,
						target && matchId !== null ? (
							<Atoms.PlayerDisplay ctx={ctx} showTeam player={target} matchId={matchId} />
						) : (
							tr.text(AppEvents_Msgs.aPlayer())
						),
					),
				)}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'MATCH_ENDED') {
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="Flag" className="text-red-500" />}>
				{tr.richText(AppEvents_Msgs.matchEnded(actorLabel))}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'VOTE_STARTED') {
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="Vote" className="text-blue-500" />}>
				{tr.richText(AppEvents_Msgs.voteStarted(actorLabel, appEvent.choiceCount))}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'VOTE_ENDED') {
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="ListChecks" className="text-green-500" />}>
				{appEvent.reason === 'ended-early'
					? tr.richText(AppEvents_Msgs.voteEndedEarly(actorLabel))
					: tr.text(AppEvents_Msgs.voteEnded())}
				{appEvent.winnerLayerId
					? tr.richText(
							AppEvents_Msgs.voteWinner(
								<Atoms.ShortLayerName normalized={ctx.displayTeamsNormalized} layerId={appEvent.winnerLayerId} />,
							),
						)
					: tr.text(AppEvents_Msgs.voteNoWinner())}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'VOTE_ABORTED') {
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="Ban" className="text-red-500" />}>
				{tr.richText(AppEvents_Msgs.voteAborted(actorLabel))}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'QUEUE_UPDATED') {
		return <QueueUpdatedRow ctx={ctx} event={event} appEvent={appEvent} actorLabel={actorLabel} />
	}
	if (appEvent.type === 'TEAMSWAPS_UPDATED') {
		return <TeamswapsUpdatedRow ctx={ctx} event={event} appEvent={appEvent} actorLabel={actorLabel} />
	}
	if (appEvent.type === 'MAP_SET') {
		// audit-only (see AppEvents.isFeedVisible): its QUEUE_UPDATED already names the layer, so drawing this too
		// would just repeat it. Only override sets are worth a line of their own.
		if (appEvent.reason === 'queue-updated') return null
		const icon = <EventIcon name="RefreshCw" className="text-amber-500" />
		// nobody was seen setting the layer SLM is replacing -- it was already set when SLM connected
		if (!appEvent.overrode || appEvent.overrode.type === 'unknown') {
			return (
				<Atoms.EventLine time={event.time} icon={icon}>
					{tr.richText(
						AppEvents_Msgs.nextLayerRestored(
							<Atoms.ShortLayerName normalized={ctx.displayTeamsNormalized} layerId={appEvent.layerId} />,
						),
					)}
				</Atoms.EventLine>
			)
		}
		// the overridden player (if any) is resolved into targetPlayers via involvedPlayerIds
		const overrodePlayer = event.targetPlayers[0]
		const who =
			appEvent.overrode.type === 'player' && overrodePlayer && matchId !== null ? (
				<Atoms.PlayerDisplay ctx={ctx} showTeam player={overrodePlayer} matchId={matchId} />
			) : appEvent.overrode.type === 'player' ? (
				tr.text(CHAT_Msgs.ingameAdmin())
			) : (
				tr.text(CHAT_Msgs.anotherRconTool())
			)
		return (
			<Atoms.EventLine time={event.time} icon={icon}>
				{tr.richText(
					AppEvents_Msgs.nextLayerOverrode(
						who,
						<Atoms.ShortLayerName normalized={ctx.displayTeamsNormalized} layerId={appEvent.layerId} />,
					),
				)}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'LAYER_REQUEST_ADDED' || appEvent.type === 'LAYER_REQUEST_REMOVED' || appEvent.type === 'LAYER_REQUEST_CONSUMED') {
		const icon =
			appEvent.type === 'LAYER_REQUEST_CONSUMED' ? (
				<EventIcon name="CheckCircle2" className="text-green-500" />
			) : appEvent.type === 'LAYER_REQUEST_ADDED' ? (
				<EventIcon name="ListPlus" className="text-blue-400" />
			) : (
				<EventIcon name="ListX" className="text-orange-500" />
			)
		return (
			<Atoms.EventLine time={event.time} icon={icon}>
				{tr.richText(AppEvents_Msgs.genericLine(actorLabel, AppEvents_Msgs.describeAppEvent(appEvent)))}
			</Atoms.EventLine>
		)
	}
	// A plugin's own event, as the `message` it recorded. A plugin that registered a renderer for this event name
	// replaces this row in the activity feed; everywhere else (and for every plugin that registered nothing) this
	// generic line is the row, which is also what the audit log shows.
	if (appEvent.type === 'PLUGIN_EVENT') {
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="Puzzle" className="text-slate-400" />}>
				{tr.richText(AppEvents_Msgs.genericLine(actorLabel, AppEvents_Msgs.describeAppEvent(appEvent)))}
			</Atoms.EventLine>
		)
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
			<Atoms.EventLine time={event.time} icon={<EventIcon name="ScrollText" className="text-slate-400" />}>
				{tr.richText(AppEvents_Msgs.genericLine(actorLabel, AppEvents_Msgs.describeAppEvent(appEvent)))}
			</Atoms.EventLine>
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
			<Atoms.PlayerDisplay ctx={ctx} showTeam player={event.targetPlayers[0]} matchId={matchId!} />
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
				<Atoms.EventTime time={event.time} />
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
				<summary className={SUMMARY_CLASS}>{header}</summary>
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
		icon = <EventIcon name="UserMinus" className="text-orange-500" />
		suffix = tr.text(AppEvents_Msgs.removedFromSquadSuffix(appEvent.reason?.label))
	} else if (appEvent.type === 'PLAYER_KICKED') {
		verb = 'kicked'
		icon = <EventIcon name="UserX" className="text-red-500" />
		suffix = appEvent.reason?.label ? tr.text(AppEvents_Msgs.forReasonSuffix(appEvent.reason.label)) : null
	} else if (appEvent.type === 'PLAYER_KILLED') {
		verb = 'killed'
		icon = <EventIcon name="Skull" className="text-red-500" />
		suffix = appEvent.reason ? tr.text(AppEvents_Msgs.killReasonSuffix(appEvent.reason)) : null
	} else if (appEvent.type === 'SWITCH_REQUESTS_FULFILLED') {
		verb = 'swapped'
		icon = <EventIcon name="ArrowLeftRight" className="text-amber-500" />
		suffix = tr.text(AppEvents_Msgs.switchRequestFulfilledSuffix())
	} else {
		verb = 'swapped'
		icon = <EventIcon name="ArrowLeftRight" className="text-blue-500" />
		suffix = tr.text(AppEvents_Msgs.swappedTeamsSuffix())
	}

	// few enough targets: name them inline instead of grouping/collapsing (but still show the count)
	if (count <= 4 && matchId !== null && event.targetPlayers.length === count) {
		const targets = event.targetPlayers.map((player, i) => (
			<span key={player.ids.eos}>
				{i > 0 ? ', ' : ''}
				<Atoms.PlayerDisplay ctx={ctx} showTeam player={player} matchId={matchId} />
			</span>
		))
		return (
			<Atoms.EventLine time={event.time} icon={icon}>
				{tr.richText(AppEvents_Msgs.actionOnNamedTargets(actorLabel, verb, targets, count, suffix))}
			</Atoms.EventLine>
		)
	}

	return (
		<details className={DETAILS_CLASS}>
			<summary className={SUMMARY_CLASS}>
				<Atoms.EventTime time={event.time} />
				{icon}
				<span className="grow min-w-0 wrap-anywhere">
					{tr.richText(AppEvents_Msgs.actionOnCountedTargets(actorLabel, verb, count, suffix))}
				</span>
			</summary>
			{targetList}
		</details>
	)
}
