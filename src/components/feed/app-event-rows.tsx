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
import * as I18n from '@/messages/i18n'
import * as AppEvents from '@/models/app-events.models'
import type * as CHAT from '@/models/chat.models'
import * as LH from '@/models/layer-history.models'
import * as LL from '@/models/layer-list.models'
import * as LTag from '@/models/layer-tags.models'
import type * as L from '@/models/layer.models'
import * as SM from '@/models/squad.models'
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
		<span>
			{I18n.nodeList(
				[
					...shown.map((layerId) => (
						<Atoms.ShortLayerName key={layerId} normalized={props.ctx.displayTeamsNormalized} layerId={layerId} />
					)),
					...(props.layerIds.length > shown.length ? [tr.text(AppEvents_Msgs.queueMore(props.layerIds.length - shown.length))] : []),
				],
				tr.locale,
			)}
		</span>
	)
}

// the final count per choice, each as a bar of its share of the votes cast
function VoteTally(props: { ctx: RC.RenderCtx; appEvent: AppEvents.VoteEnded }) {
	const { ctx, appEvent } = props
	const tally = appEvent.tally ?? []
	const total = appEvent.totalVotes ?? tally.reduce((sum, choice) => sum + choice.votes, 0)
	return (
		<div className="mt-1 flex max-w-md flex-col gap-1.5 rounded-md bg-muted/50 px-2.5 py-2">
			{tally.map((choice) => {
				const won = choice.layerId === appEvent.winnerLayerId
				const share = total > 0 ? (choice.votes / total) * 100 : 0
				return (
					<div key={choice.layerId}>
						<div className="flex items-baseline gap-2">
							{/* the layer name wraps rather than running under the count */}
							<span className={cn('min-w-0 flex-1 wrap-anywhere', won ? 'font-semibold text-foreground' : undefined)}>
								<Atoms.ShortLayerName normalized={ctx.displayTeamsNormalized} layerId={choice.layerId} />
							</span>
							<span className={cn('shrink-0 tabular-nums', won ? 'font-semibold text-primary' : undefined)}>{choice.votes}</span>
						</div>
						<div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-background">
							<div className={cn('h-full', won ? 'bg-primary' : 'bg-muted-foreground/50')} style={{ width: `${share}%` }} />
						</div>
					</div>
				)
			})}
			<div className="text-[11px]">{tr.text(AppEvents_Msgs.voteTallyFooter(total, appEvent.turnoutPercentage ?? null))}</div>
		</div>
	)
}

type ServerMapSet = Extract<CHAT.EventEnriched, { type: 'MAP_SET' }>

// the in-game or external set an app event reacted to, once the buffer has folded it under the event
function reactedToMapSet(event: AppEventEntry): ServerMapSet | undefined {
	const id = AppEvents.reactedToServerEventId(event.appEvent)
	if (id === undefined) return undefined
	return event.collapsed.find((c): c is ServerMapSet => c.type === 'MAP_SET' && c.id === id)
}

// the in-game admin who made a set outside SLM. Another rcon tool has no name worth more than "outside SLM".
function externalSetter(ctx: RC.RenderCtx, set: ServerMapSet): React.ReactNode {
	if (set.source?.type !== 'player') return null
	if (set.actorPlayer) return <Atoms.PlayerDisplay ctx={ctx} showTeam player={set.actorPlayer} matchId={set.matchId} />
	return set.source.playerIds.username ?? tr.text(AppEvents_Msgs.unnamedIngameAdmin())
}

// a queue sync and the in-game set it followed, as one line
function ExternalSetSyncLine(props: {
	ctx: RC.RenderCtx
	event: AppEventEntry
	appEvent: AppEvents.QueueUpdated
	externalSet: ServerMapSet
}) {
	const { ctx, appEvent, externalSet } = props
	const layer = <Atoms.ShortLayerName normalized={ctx.displayTeamsNormalized} layerId={externalSet.layerId} />
	const aheadOf = appEvent.list[1]?.layerId
	const ahead = aheadOf ? <Atoms.ShortLayerName normalized={ctx.displayTeamsNormalized} layerId={aheadOf} /> : undefined
	const who = externalSetter(ctx, externalSet)
	return who
		? tr.richText(AppEvents_Msgs.externalSetQueued(who, layer, ahead))
		: tr.richText(AppEvents_Msgs.externalSetQueuedAnonymous(layer, ahead))
}

type ServerBroadcast = Extract<CHAT.EventEnriched, { type: 'ADMIN_BROADCAST' }>

// the broadcasts an app event sent, as the server logged them (see SquadServerActions.attributeBroadcast)
function sentBroadcasts(event: AppEventEntry): ServerBroadcast[] {
	return event.collapsed.filter((c): c is ServerBroadcast => c.type === 'ADMIN_BROADCAST')
}

function SentBroadcasts(props: { broadcasts: ServerBroadcast[] }) {
	return (
		<div className="flex max-w-md flex-col gap-1">
			{props.broadcasts.map((broadcast) => (
				<div key={broadcast.id} className="flex gap-2 items-baseline">
					<Atoms.EventTime time={broadcast.time} />
					<span className="min-w-0 whitespace-pre-line rounded-md bg-muted/50 px-2 py-1 text-foreground">
						{broadcast.message.trim()}
					</span>
				</div>
			))}
		</div>
	)
}

// who made a layer request: the SLM user, else the player the roster knew them as
function requesterLabel(
	ctx: RC.RenderCtx,
	event: AppEventEntry,
	request: NonNullable<AppEvents.LayerRequestConsumed['requests']>[number],
): React.ReactNode {
	if (request.requester.discordId !== undefined) return labelOf(ctx, request.requester.discordId)
	const player = request.playerId ? event.targetPlayers.find((p) => SM.PlayerIds.getPlayerId(p.ids) === request.playerId) : undefined
	if (player && event.matchId !== null) return <Atoms.PlayerDisplay ctx={ctx} showTeam player={player} matchId={event.matchId} />
	return tr.text(AppEvents_Msgs.unnamedRequester())
}

function sessionActorLabel(ctx: RC.RenderCtx, event: AppEventEntry, actor: AppEvents.Actor): React.ReactNode {
	switch (actor.type) {
		case 'slm-user':
			return labelOf(ctx, actor.userId)
		case 'system':
			return tr.text(AppEvents_Msgs.systemActor())
		case 'plugin':
			return ctx.pluginName(actor.pluginId) ?? actor.pluginId
		case 'ingame-user': {
			// the event's actor is the only player the enrichment resolved
			const appActor = event.appEvent.actor
			if (appActor.type === 'ingame-user' && appActor.playerId === actor.playerId && event.actorPlayer && event.matchId !== null) {
				return <Atoms.PlayerDisplay ctx={ctx} player={event.actorPlayer} matchId={event.matchId} />
			}
			return tr.text(AppEvents_Msgs.unnamedIngameAdmin())
		}
		default:
			assertNever(actor)
	}
}

function SessionLogLine(props: { ctx: RC.RenderCtx; event: AppEventEntry; entry: LH.SessionLogEntry }) {
	const { ctx, event, entry } = props
	const who = sessionActorLabel(ctx, event, entry.actor)
	const layers = <LayerNames ctx={ctx} layerIds={entry.layerIds} />
	const vote = entry.isVote ? tr.text(AppEvents_Msgs.queueVoteChoices(entry.layerIds.length)) : null

	const [marker, markerClass, body] = ((): [string, string, React.ReactNode] => {
		switch (entry.kind) {
			case 'added':
				return ['+', 'text-added', tr.richText(AppEvents_Msgs.sessionAdded(who, entry.index + 1, vote, layers))]
			case 'cloned':
				return ['+', 'text-added', tr.richText(AppEvents_Msgs.sessionCloned(who, entry.index + 1, layers))]
			case 'generated':
				return ['+', 'text-added', tr.richText(AppEvents_Msgs.sessionGenerated(entry.index + 1, layers))]
			case 'synced':
				return [
					'+',
					'text-added',
					entry.actor.type === 'ingame-user'
						? tr.richText(AppEvents_Msgs.sessionSyncedBy(who, layers))
						: tr.richText(AppEvents_Msgs.sessionSynced(layers)),
				]
			case 'removed':
				return ['−', 'text-destructive', tr.richText(AppEvents_Msgs.sessionRemoved(who, vote, layers))]
			case 'advanced':
				return ['−', 'text-muted-foreground', tr.richText(AppEvents_Msgs.sessionAdvanced(layers))]
			case 'moved':
				return ['↕', 'text-info', tr.richText(AppEvents_Msgs.sessionMoved(who, layers, entry.fromIndex + 1, entry.toIndex + 1))]
			case 'factions-swapped':
				return ['~', 'text-warn', tr.richText(AppEvents_Msgs.sessionFactionsSwapped(who, layers))]
			case 'layer-edited':
				return [
					'~',
					'text-warn',
					tr.richText(AppEvents_Msgs.sessionLayerEdited(who, <LayerNames ctx={ctx} layerIds={entry.prevLayerIds} />, layers)),
				]
			case 'tag-added':
				return ['#', 'text-muted-foreground', tr.richText(AppEvents_Msgs.sessionTagAdded(who, layers, LTag.originalLabel(entry.tagId)))]
			case 'tag-removed':
				return [
					'#',
					'text-muted-foreground',
					tr.richText(AppEvents_Msgs.sessionTagRemoved(who, layers, LTag.originalLabel(entry.tagId))),
				]
			case 'note-added':
				return ['✎', 'text-muted-foreground', tr.richText(AppEvents_Msgs.sessionNoteAdded(who, layers, entry.text))]
			case 'note-edited':
				return ['✎', 'text-muted-foreground', tr.richText(AppEvents_Msgs.sessionNoteEdited(who, layers, entry.text))]
			case 'note-deleted':
				return ['✎', 'text-muted-foreground', tr.richText(AppEvents_Msgs.sessionNoteDeleted(who, layers))]
			case 'vote-configured':
				return ['~', 'text-warn', tr.richText(AppEvents_Msgs.sessionVoteConfigured(who, layers))]
			case 'vote-result':
				return ['~', 'text-warn', tr.richText(AppEvents_Msgs.sessionVoteResult(layers))]
			case 'reverted':
				return ['↶', 'text-muted-foreground', tr.richText(AppEvents_Msgs.sessionReverted(who, entry.count))]
			case 'discarded':
				return [
					'↶',
					'text-muted-foreground',
					entry.actor.type === 'system'
						? tr.text(AppEvents_Msgs.sessionAbandoned(entry.count))
						: tr.richText(AppEvents_Msgs.sessionDiscardedBy(who, entry.count)),
				]
			default:
				assertNever(entry)
		}
	})()

	return (
		<div className="flex gap-2 items-baseline text-xs text-muted-foreground">
			<span className={cn('font-mono shrink-0 w-3 text-center', markerClass)}>{marker}</span>
			<span className="grow min-w-0 wrap-anywhere">{body}</span>
		</div>
	)
}

/**
 * The ops one queue save committed, in order. `itemId` narrows the log to the edits of one item, and counts the rest
 * of the session in a trailing line.
 */
export function SessionLog(props: { ctx: RC.RenderCtx; event: AppEventEntry; entries: LH.SessionLogEntry[]; itemId?: LL.ItemId }) {
	const { ctx, event, entries, itemId } = props
	const shown = itemId === undefined ? entries : entries.filter((entry) => LH.entryTouches(entry, itemId))
	// a discarded draft names no item, so it is neither this item's edit nor another's
	const others = itemId === undefined ? 0 : entries.filter((entry) => entry.itemId !== null && !LH.entryTouches(entry, itemId)).length
	return (
		<div className="flex flex-col gap-0.5">
			{shown.map((entry) => (
				<SessionLogLine key={`${entry.opId}:${entry.itemId ?? ''}`} ctx={ctx} event={event} entry={entry} />
			))}
			{others > 0 && (
				<div className="flex gap-2 items-baseline text-xs text-muted-foreground">
					<span className="w-3 shrink-0" />
					<span>{tr.text(AppEvents_Msgs.sessionOtherChanges(others))}</span>
				</div>
			)}
		</div>
	)
}

// a save of the layer queue. The summary names who saved and the net effect; expanding lists the edit session the
// save committed, each op attributed to the user who made it, which is the part a shared queue actually needs
// (several admins edit at once).
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
	const externalSet = reactedToMapSet(event)
	// in the history of the item a roll took off the head of the queue to play, the match's start already says so
	if (
		ctx.focusItemId !== undefined &&
		appEvent.prevList[0]?.itemId === ctx.focusItemId &&
		appEvent.ops.some((op) => op.op === 'shift-first-saved-layer')
	) {
		return null
	}
	const summary =
		kind === 'external-layer-change' && externalSet ? (
			<ExternalSetSyncLine ctx={ctx} event={event} appEvent={appEvent} externalSet={externalSet} />
		) : (
			tr.richText(
				AppEvents_Msgs.queueSummary(
					headline,
					tr.text(AppEvents_Msgs.queueChangeCounts(counts)),
					nextAfter !== null && nextAfter !== nextBefore
						? {
								external: appEvent.trigger === 'external-layer-change',
								layer: <Atoms.ShortLayerName normalized={ctx.displayTeamsNormalized} layerId={nextAfter} />,
							}
						: undefined,
				),
			)
		)
	const icon = <EventIcon name="ListOrdered" className="text-info" />
	// a save the queue made for itself is one op its headline already describes
	const log = kind === 'save' || kind === 'force-save' ? LH.queueSessionLog(appEvent) : []
	// the edits that reached the queue: a discarded draft is a line of the log, but none of its edits
	const editCount = log.filter((entry) => entry.kind !== 'discarded').length
	const focus = ctx.focusItemId
	const madeNext = focus !== undefined && appEvent.list[0]?.itemId === focus && appEvent.prevList[0]?.itemId !== focus
	const line = (
		<>
			{summary}
			{madeNext && (
				<span className="ms-2 rounded bg-primary/20 px-1.5 text-[11px] text-primary">{tr.text(AppEvents_Msgs.nowNextLayer())}</span>
			)}
		</>
	)

	if (log.length === 0) {
		return (
			<Atoms.EventLine time={event.time} icon={icon}>
				{line}
			</Atoms.EventLine>
		)
	}

	// in one item's history the item's own edits are the point, so they start out shown
	return (
		<details className={DETAILS_CLASS} open={focus !== undefined}>
			<summary className={SUMMARY_CLASS}>
				<Atoms.EventTime time={event.time} />
				{icon}
				<span className="grow min-w-0 wrap-anywhere">
					{line}
					{editCount > 0 && (
						<span className="ms-2 rounded bg-muted px-1.5 text-[11px]">{tr.text(AppEvents_Msgs.sessionEditCount(editCount))}</span>
					)}
				</span>
			</summary>
			<div className="ps-6 pt-1">
				<SessionLog ctx={ctx} event={event} entries={log} itemId={focus} />
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
				: appEvent.trigger === 'counterbalance' && matchId !== null
					? tr.richText(
							AppEvents_Msgs.teamswapsCounterbalanced(
								added,
								removed,
								{
									A: <Atoms.MatchTeamDisplay ctx={ctx} matchId={matchId} teamId="A" />,
									B: <Atoms.MatchTeamDisplay ctx={ctx} matchId={matchId} teamId="B" />,
								},
								appEvent.balance,
								appEvent.actor.type === 'slm-user' ? actorLabel : undefined,
							),
						)
					: queued === 0
						? tr.richText(AppEvents_Msgs.teamswapsCleared(actorLabel))
						: tr.richText(AppEvents_Msgs.teamswapsUpdated(actorLabel, added, removed, queued))
	const icon = <EventIcon name="ArrowLeftRight" className="text-info" />

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
			<div className="ps-6 pt-1 flex flex-col gap-0.5">
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
							<span className={cn('font-mono shrink-0', change.kind === 'added' ? 'text-ok' : 'text-repeat')}>
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
			<div className="ps-6 pt-1 flex flex-col gap-0.5">
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
					<EventIcon name="Users" className="text-danger" />
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
			<Atoms.EventLine time={event.time} icon={<EventIcon name="PencilLine" className="text-info" />}>
				{tr.richText(AppEvents_Msgs.squadRenamed(actorLabel, appEvent.squadName, appEvent.teamId))}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'COMMANDER_DEMOTED') {
		const target = event.targetPlayers[0]
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="ShieldOff" className="text-warn" />}>
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
			<Atoms.EventLine time={event.time} icon={<EventIcon name="CloudFog" className="text-text-3" />}>
				{tr.richText(AppEvents_Msgs.fogOfWarToggled(actorLabel, appEvent.enabled))}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'RCON_COMMAND_RUN') {
		return (
			<Atoms.EventLine
				time={event.time}
				icon={<EventIcon name="SquareTerminal" className={appEvent.error ? 'text-danger' : 'text-warn'} />}
			>
				{tr.richText(AppEvents_Msgs.rconCommandRun(actorLabel, appEvent.command, appEvent.error))}
			</Atoms.EventLine>
		)
	}
	// the ADMIN_BROADCAST server event this produced is attributed to it and collapses under this entry, so the
	// broadcast is shown once, with its sender
	if (appEvent.type === 'BROADCAST_SENT') {
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="Megaphone" className="text-warn" />}>
				{tr.richText(AppEvents_Msgs.broadcastSent(actorLabel, appEvent.message))}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'PLAYER_TIMED_OUT') {
		const target = event.targetPlayers[0]
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="UserX" className="text-danger" />}>
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
			<Atoms.EventLine time={event.time} icon={<EventIcon name="UserCheck" className="text-ok" />}>
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
			<Atoms.EventLine time={event.time} icon={<EventIcon name="Flag" className="text-danger" />}>
				{tr.richText(AppEvents_Msgs.matchEnded(actorLabel))}
			</Atoms.EventLine>
		)
	}
	if (appEvent.type === 'VOTE_STARTED' || appEvent.type === 'VOTE_ABORTED') {
		const icon =
			appEvent.type === 'VOTE_STARTED' ? (
				<EventIcon name="Vote" className="text-info" />
			) : (
				<EventIcon name="Ban" className="text-danger" />
			)
		const line =
			appEvent.type === 'VOTE_STARTED'
				? tr.richText(AppEvents_Msgs.voteStarted(actorLabel, appEvent.choiceCount))
				: tr.richText(AppEvents_Msgs.voteAborted(actorLabel))
		const broadcasts = sentBroadcasts(event)
		if (broadcasts.length === 0) {
			return (
				<Atoms.EventLine time={event.time} icon={icon}>
					{line}
				</Atoms.EventLine>
			)
		}
		return (
			<details className={DETAILS_CLASS}>
				<summary className={SUMMARY_CLASS}>
					<Atoms.EventTime time={event.time} />
					{icon}
					<span className="grow min-w-0 wrap-anywhere">{line}</span>
				</summary>
				<div className="ps-6 pt-1">
					<SentBroadcasts broadcasts={broadcasts} />
				</div>
			</details>
		)
	}
	if (appEvent.type === 'VOTE_ENDED') {
		const broadcasts = sentBroadcasts(event)
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="ListChecks" className="text-ok" />}>
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
				{appEvent.tally && appEvent.tally.length > 0 && <VoteTally ctx={ctx} appEvent={appEvent} />}
				{broadcasts.length > 0 && (
					<details className="mt-1">
						<summary className="cursor-pointer">{tr.text(AppEvents_Msgs.voteBroadcastsShown(broadcasts.length))}</summary>
						<SentBroadcasts broadcasts={broadcasts} />
					</details>
				)}
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
		const icon = <EventIcon name="RefreshCw" className="text-warn" />
		const externalSet = reactedToMapSet(event)
		const setter = externalSet ? externalSetter(ctx, externalSet) : null
		if (externalSet && setter) {
			return (
				<Atoms.EventLine time={event.time} icon={icon}>
					{tr.richText(
						AppEvents_Msgs.externalSetRestored(
							setter,
							<Atoms.ShortLayerName normalized={ctx.displayTeamsNormalized} layerId={externalSet.layerId} />,
							<Atoms.ShortLayerName normalized={ctx.displayTeamsNormalized} layerId={appEvent.layerId} />,
						),
					)}
				</Atoms.EventLine>
			)
		}
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
	// recorded with its requests, a consumption lists who asked for what
	if (appEvent.type === 'LAYER_REQUEST_CONSUMED' && appEvent.requests) {
		const requests = appEvent.requests
		// in the history of the item that fulfilled them, the requests are why the item exists, so they start out shown
		return (
			<details className={DETAILS_CLASS} open={ctx.focusItemId !== undefined && ctx.focusItemId === appEvent.queueItemId}>
				<summary className={SUMMARY_CLASS}>
					<Atoms.EventTime time={event.time} />
					<EventIcon name="CheckCircle2" className="text-ok" />
					<span className="grow min-w-0 wrap-anywhere">
						{tr.richText(
							AppEvents_Msgs.layerRequestsFulfilled(
								requests.length,
								<Atoms.ShortLayerName normalized={ctx.displayTeamsNormalized} layerId={appEvent.layerId} />,
							),
						)}
					</span>
				</summary>
				<div className="ps-6 pt-1 flex flex-col gap-0.5">
					{requests.map((request, i) => (
						<div key={appEvent.itemIds[i]} className="flex gap-2 items-baseline">
							<Atoms.EventTime time={request.requestedAt} />
							<span className="grow min-w-0 wrap-anywhere">
								{tr.richText(AppEvents_Msgs.layerRequestBy(appEvent.descriptions[i] ?? '', requesterLabel(ctx, event, request)))}
							</span>
						</div>
					))}
				</div>
			</details>
		)
	}
	if (appEvent.type === 'LAYER_REQUEST_ADDED' || appEvent.type === 'LAYER_REQUEST_REMOVED' || appEvent.type === 'LAYER_REQUEST_CONSUMED') {
		const icon =
			appEvent.type === 'LAYER_REQUEST_CONSUMED' ? (
				<EventIcon name="CheckCircle2" className="text-ok" />
			) : appEvent.type === 'LAYER_REQUEST_ADDED' ? (
				<EventIcon name="ListPlus" className="text-info" />
			) : (
				<EventIcon name="ListX" className="text-warn" />
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
			<Atoms.EventLine time={event.time} icon={<EventIcon name="Puzzle" className="text-text-3" />}>
				{tr.richText(AppEvents_Msgs.genericLine(actorLabel, AppEvents_Msgs.describeAppEvent(appEvent)))}
			</Atoms.EventLine>
		)
	}
	if (
		appEvent.type === 'SCHEDULED_JOB_SUCCESS' ||
		appEvent.type === 'SCHEDULED_JOB_FAILED' ||
		appEvent.type === 'SCHEDULED_JOB_CANCELLED'
	) {
		const failed = appEvent.type === 'SCHEDULED_JOB_FAILED'
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="Clock" className={failed ? 'text-destructive' : 'text-text-3'} />}>
				{tr.richText(AppEvents_Msgs.genericLine(actorLabel, AppEvents_Msgs.describeAppEvent(appEvent)))}
			</Atoms.EventLine>
		)
	}
	if (
		appEvent.type === 'SETTINGS_UPDATED' ||
		appEvent.type === 'SERVER_REGISTRY_CHANGED' ||
		appEvent.type === 'FILTER_CHANGED' ||
		appEvent.type === 'FILTER_CONTRIBUTOR_CHANGED' ||
		appEvent.type === 'ROTATION_CHANGED' ||
		appEvent.type === 'ROTATION_CONTRIBUTOR_CHANGED' ||
		appEvent.type === 'USER_ACCOUNT_CHANGED' ||
		appEvent.type === 'PLAYER_FLAGS_UPDATED' ||
		appEvent.type === 'PLAYER_NOTE_ADDED' ||
		appEvent.type === 'APP_STARTED' ||
		appEvent.type === 'APP_RESTARTED' ||
		appEvent.type === 'ANNOUNCEMENT_SENT' ||
		appEvent.type === 'PERMISSION_DENIED' ||
		appEvent.type === 'BACKUP_CREATED' ||
		appEvent.type === 'PLUGIN_DATA_PURGED' ||
		appEvent.type === 'MATCH_LAYERS_RECONCILED'
	) {
		// global/audit-only types -- they never reach a server activity feed (matchId null), but the union needs a
		// branch. rendered generically via describeAppEvent (the audit log is where these actually show up).
		return (
			<Atoms.EventLine time={event.time} icon={<EventIcon name="ScrollText" className="text-text-3" />}>
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
			<span className="whitespace-nowrap" style={{ color: style.color }} title={tr.text(AppEvents_Msgs.warnChannelHint())}>
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

		const containerStyle = { borderInlineEndColor: style.color, '--row-tint': style.gradientColor } as React.CSSProperties
		// a single/named-target warn is a flat line; a bulk warn keeps an expandable list of everyone warned
		if (single || !targetList) {
			return (
				<div
					className="flex gap-2 py-1 text-xs w-full min-w-0 border-e-2 bg-linear-to-l rtl:bg-linear-to-r from-(--row-tint) to-transparent items-baseline"
					style={containerStyle}
				>
					{header}
				</div>
			)
		}
		return (
			<details
				className="py-1 text-xs w-full min-w-0 border-e-2 bg-linear-to-l rtl:bg-linear-to-r from-(--row-tint) to-transparent"
				style={containerStyle}
			>
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
		icon = <EventIcon name="UserMinus" className="text-warn" />
		suffix = tr.text(AppEvents_Msgs.removedFromSquadSuffix(appEvent.reason?.label))
	} else if (appEvent.type === 'PLAYER_KICKED') {
		verb = 'kicked'
		icon = <EventIcon name="UserX" className="text-danger" />
		suffix = appEvent.reason?.label ? tr.text(AppEvents_Msgs.forReasonSuffix(appEvent.reason.label)) : null
	} else if (appEvent.type === 'PLAYER_KILLED') {
		verb = 'killed'
		icon = <EventIcon name="Skull" className="text-danger" />
		suffix = appEvent.reason ? tr.text(AppEvents_Msgs.killReasonSuffix(appEvent.reason)) : null
	} else if (appEvent.type === 'SWITCH_REQUESTS_FULFILLED') {
		verb = 'swapped'
		icon = <EventIcon name="ArrowLeftRight" className="text-warn" />
		suffix = tr.text(AppEvents_Msgs.switchRequestFulfilledSuffix())
	} else {
		verb = 'swapped'
		icon = <EventIcon name="ArrowLeftRight" className="text-info" />
		suffix = tr.text(AppEvents_Msgs.swappedTeamsSuffix())
	}

	// few enough targets: name them inline instead of grouping/collapsing (but still show the count)
	if (count <= 4 && matchId !== null && event.targetPlayers.length === count) {
		const targets = I18n.nodeList(
			event.targetPlayers.map((player) => (
				<Atoms.PlayerDisplay key={player.ids.eos} ctx={ctx} showTeam player={player} matchId={matchId} />
			)),
			tr.locale,
		)
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
