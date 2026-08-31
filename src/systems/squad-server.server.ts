import * as Otel from '@opentelemetry/api'
import * as Orpc from '@orpc/server'
import { Mutex, type MutexInterface } from 'async-mutex'
import { sql } from 'drizzle-orm'
import * as E from 'drizzle-orm'
import superjson from 'superjson'
import { z } from 'zod'

import * as Schema from '$root/drizzle/schema'
import type * as SchemaModels from '$root/drizzle/schema.models.ts'
import * as AR from '@/app-routes'
import * as Arr from '@/lib/array-utils'
import * as Cleanup from '@/lib/cleanup'
import { superjsonify } from '@/lib/drizzle'
import { FileTail } from '@/lib/file-tail'
import * as Gen from '@/lib/generator-utils'
import { IsolatedSubject, TracedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object-utils'
import * as Prom from '@/lib/promise-utils'
import Rcon, { DirectSocketTransport } from '@/lib/rcon/core-rcon'
import * as Rx from '@/lib/rxjs'
import { SftpTail } from '@/lib/sftp-tail'
import * as Templating from '@/lib/templating'
import { assertNever } from '@/lib/type-guards'
import type { Parts } from '@/lib/types'
import * as AppEvents_Msgs from '@/messages/app-events.messages'
import * as I18n from '@/messages/i18n'
import * as SS_Msgs from '@/messages/server-state.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import * as AAR from '@/models/admin-action-reasons.models'
import * as AppEvents from '@/models/app-events.models'
import * as CHAT from '@/models/chat.models.ts'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import type * as LQ from '@/models/layer-queue.models'
import * as MH from '@/models/match-history.models'
import type * as Msgs from '@/models/messages.models'
import * as ATTRS from '@/models/otel-attrs'
import * as PendingEvents from '@/models/pending-events.models'
import * as SE from '@/models/server-events.models'
import type * as SS from '@/models/server-state.models'
import type * as SETTINGS from '@/models/settings.models'
import * as SLL from '@/models/shared-layer-list'
import type * as SR from '@/models/squad-rcon.models'
import type * as SQS from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context.ts'
import * as DB from '@/server/db'
import * as Instr from '@/server/instrumentation'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AdminList from '@/systems/adminlist.server'
import * as AppEventsSys from '@/systems/app-events.server'
import * as Battlemetrics from '@/systems/battlemetrics.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as CommandPrompts from '@/systems/command-prompts.server'
import * as Commands from '@/systems/commands.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchEventsCache from '@/systems/match-events-cache.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as PluginsSys from '@/systems/plugins.server'
import * as Rbac from '@/systems/rbac.server'
import * as Sandbox from '@/systems/sandbox.server'
import * as ServerAgent from '@/systems/server-agent.server'
import * as ServerConsole from '@/systems/server-console.server'
import * as Settings from '@/systems/settings.server'
import * as SquadBrowser from '@/systems/squad-browser.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as Steam from '@/systems/steam.server'
import * as SwitchRequestsSys from '@/systems/switch-requests.server'
import * as TeamswapsSys from '@/systems/teamswaps.server'
import * as Timeouts from '@/systems/timeouts.server'
import * as Users from '@/systems/users.server'
import * as Vote from '@/systems/vote.server'
import * as WsSessionSys from '@/systems/ws-session.server'

const module = initModule('squad-server')

const meter = Otel.metrics.getMeter('squad-server')

const logLineCounter = meter.createCounter(ATTRS.SquadLogs.LINES, {
	description: 'Squad log lines ingested, by server and log source',
})

const logIoCounter = meter.createCounter(ATTRS.SquadLogs.IO, {
	description: 'Bytes of squad log data ingested, by server and log source',
	unit: 'By',
})

const logEventCounter = meter.createCounter(ATTRS.SquadLogs.EVENTS, {
	description: 'Squad log events successfully parsed out of the log stream, by server and log source',
})

const serverEventCounter = meter.createCounter(ATTRS.ServerEvent.EMITTED, {
	description: 'Server events emitted on event$, by server and event type',
})

const logLagHistogram = meter.createHistogram(ATTRS.SquadLogs.LAG, {
	description:
		'Log delivery lag (receive time minus log timestamp, incl. clock skew): the per-second worst-case samples the lead-time tuner acts on, by server and log source',
	unit: 'ms',
	advice: {
		// sized around the tuner's operating range: floor 250ms, ceiling 10s, with the 45s stale cutoff as tail
		explicitBucketBoundaries: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 45000],
	},
})
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

type State = {
	managedServers: Map<string, C.ManagedServer>
	// guards every transition of a managed server between running and not, not just setup. See withLifecycleLock.
	lifecycleMtxs: Map<string, MutexInterface>
	// emits a serverId whenever a managed server is added to or removed from `managedServers`
	lifecycleUpdate$: Rx.Subject<string>
	squadIdCounter: Generator<number, never, unknown>

	debug__ticketOutcome?: { team1: number; team2: number }
}

export let globalState!: State

export type MatchHistoryState = {
	historyMtx: Mutex
	update$: Rx.Subject<CS.Otel>
	recentMatches: MH.MatchDetails[]
} & Parts<USR.UserPart>

export const orpcRouter = {
	// The admin-list group names known to any running server, for the player-groupings editor to offer. Player groupings are
	// global config while an admin list is per-server, so this is the union across servers rather than one server's list: a
	// grouping naming a group only some servers define simply matches nobody on the others.
	listAdminListGroups: orpcBase.handler(async () => {
		const baseCtx = getBaseCtx()
		const names = new Set<string>()
		for (const managedServer of globalState.managedServers.values()) {
			try {
				const adminLists = await AdminList.getListsForServerId({ ...baseCtx, ...managedServer }, managedServer.serverId)
				SM.AdminList.collectGroupNames(adminLists, names)
			} catch (err) {
				// one unreachable admin list must not deny the editor every other server's groups
				log.warn(err, 'Failed to read an admin list while listing groups')
			}
		}
		return [...names].sort()
	}),

	// which servers currently have a live managed server. This is runtime state, not registry config: a server can be enabled and
	// non-broken yet have no managed server (still booting, or torn down by a fatal resource error), and everything served per-server
	// needs one. The client gates the dashboard on this so it renders "unavailable" instead of hanging on silent streams.
	watchLoadedServers: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ context, signal }) {
		const obs = globalState.lifecycleUpdate$.pipe(
			Rx.startWith(null),
			// servers the session may not view are omitted rather than listed-but-unusable, matching ctx$
			Rx.switchMap(async () => {
				const ids: string[] = []
				for (const serverId of globalState.managedServers.keys()) {
					if (!(await Rbac.canViewServerForUser(context, serverId))) continue
					ids.push(serverId)
				}
				return ids
			}),
			Rx.Ext.distinctDeepEquals(),
			Rx.Ext.withAbortSignal(signal!),
		)
		yield* Rx.Ext.toAsyncGenerator(obs)
	}),

	// nextLayer comes from the rcon read, not from eventState.nextLayerId: eventState only learns of a set-next once
	// the MAP_SET log line has been tailed and parsed, seconds after setNextLayer already read the new value back.
	// The rcon resource is observed for the managed server's whole lifetime anyway (see the in-game vote inference in
	// layer-queue.server.ts) and setNextLayer refreshes it on the spot, so this is both free and immediate.
	watchLayersStatus: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, signal, input }) {
			const obs = stream$(context.wsClientId, input.serverId, (serverCtx) => {
				const read = async (): Promise<SM.LayersStatusResExt> => {
					const currentMatch = await MatchHistory.getCurrentMatch(serverCtx)
					const statusRes = await serverCtx.squadRcon.layersStatus.get(serverCtx)
					return {
						code: 'ok',
						data: {
							currentLayer: L.toLayer(currentMatch.layerId),
							nextLayer: statusRes.code === 'ok' ? statusRes.data.nextLayer : null,
							currentMatch,
						},
					}
				}
				const event$ = serverCtx.server.event$.pipe(Rx.filter(([, event]) => ['NEW_GAME', 'MAP_SET', 'RESET'].includes(event.type)))
				return Rx.merge(serverCtx.squadRcon.layersStatus.observe(serverCtx), event$).pipe(
					Rx.startWith(null),
					Rx.switchMap(() => read()),
					Rx.Ext.distinctDeepEquals(),
				)
			}).pipe(Rx.Ext.withAbortSignal(signal!))
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	watchServerRolling: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, signal, input }) {
			const obs = stream$(context.wsClientId, input.serverId, (ctx) => ctx.server.serverRolling$).pipe(Rx.Ext.withAbortSignal(signal!))
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	watchTickRate: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, signal, input }) {
			const obs = stream$(context.wsClientId, input.serverId, (ctx) => ctx.server.tickRate$.pipe(Rx.Ext.distinctDeepEquals())).pipe(
				Rx.Ext.withAbortSignal(signal!),
			)
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	watchServerInfo: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, signal, input }) {
			const obs = stream$(context.wsClientId, input.serverId, (ctx) =>
				ctx.squadRcon.serverInfo.observe(ctx).pipe(Rx.Ext.distinctDeepEquals()),
			).pipe(Rx.Ext.withAbortSignal(signal!))
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	endMatch: orpcBase.input(z.object({ serverId: z.string() })).handler(async ({ context: _ctx, input }) => {
		const ctxRes = await tryCtx(_ctx, input.serverId)
		if (ctxRes.code !== 'ok') return ctxRes
		const ctx = ctxRes.ctx
		const deniedRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:end-match', { serverId: ctx.serverId }))
		if (deniedRes) return deniedRes
		return await endMatchAction(ctx, { type: 'slm-user', userId: ctx.user.discordId })
	}),

	watchChatEvents: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ lastEventId: z.number().optional(), serverId: z.string() }))
		.handler(async function* ({ context, signal, input }) {
			const obs = stream$(context.wsClientId, input.serverId, (ctx) => {
				async function getInitialEvents() {
					const sync: CHAT.SyncedEvent = {
						type: 'SYNCED' as const,
						time: Date.now(),
						matchId: (await MatchHistory.getCurrentMatch(ctx)).historyEntryId,
					}

					let allEvents: SE.Event[] = ctx.server.emittedEvents
					let events: (SE.Event | CHAT.AppFeedEvent | CHAT.LifecycleEvent)[] = []

					if (input.lastEventId === undefined) {
						events.push({
							type: 'INIT',
							time: Date.now(),
							serverId: ctx.serverId,
						})
						events.push(...CHAT.mergeAppEvents(allEvents, ctx.server.emittedAppEvents))
						events.push(sync)
					} else {
						let lastEventIndex = allEvents.findIndex((e) => e.id === input!.lastEventId!)

						// let the client know that we are reconnecting from their last known event id
						events.push({
							type: 'CHAT_RECONNECTED',
							resumedEventId: lastEventIndex === -1 ? null : input!.lastEventId!,
						})
						// if last event was not found it'll be -1, which works nicely here because we just need to resend all events
						events.push(
							...CHAT.mergeAppEvents(
								allEvents.slice(lastEventIndex + 1),
								ctx.server.emittedAppEvents.filter((a) => lastEventIndex === -1 || a.time >= allEvents[lastEventIndex].time),
							),
						)
						events.push(sync)
					}

					return Arr.paged(events, 512)
				}
				const initial$ = Rx.from(getInitialEvents()).pipe(Rx.concatAll())

				const upcoming$ = Rx.merge(
					ctx.server.event$.pipe(Rx.map(([_, e]): SE.Event | CHAT.AppFeedEvent => e)),
					ctx.server.appEvent$.pipe(Rx.map(([_, appEvent]): SE.Event | CHAT.AppFeedEvent => ({ type: 'APP_EVENT', appEvent }))),
				).pipe(Rx.map((event): (SE.Event | CHAT.AppFeedEvent)[] => [event]))

				return Rx.concat(initial$, upcoming$).pipe(
					// orpc will break without this
					Rx.observeOn(Rx.asyncScheduler),
				)
			}).pipe(
				Rx.tap({
					error: (err) => {
						log.error(err, 'Error in watchChatEvents')
					},
				}),
				Rx.Ext.withAbortSignal(signal!),
			)
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	toggleFogOfWar: orpcBase.input(z.object({ serverId: z.string(), disabled: z.boolean() })).handler(async ({ context: _ctx, input }) => {
		const ctxRes = await tryCtx(_ctx, input.serverId)
		if (ctxRes.code !== 'ok') return ctxRes
		const ctx = ctxRes.ctx
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:turn-fog-off', { serverId: ctx.serverId }))
		if (denyRes) return denyRes
		const serverStatusRes = await ctx.squadRcon.layersStatus.get(ctx)
		if (serverStatusRes.code !== 'ok') return serverStatusRes
		await SquadRcon.setFogOfWar(ctx, input.disabled ? 'off' : 'on')
		await emitAppEvent(
			ctx,
			AppEvents.create<AppEvents.FogOfWarToggled>({
				type: 'FOG_OF_WAR_TOGGLED',
				actor: { type: 'slm-user', userId: ctx.user.discordId },
				serverId: ctx.serverId,
				matchId: (await MatchHistory.getCurrentMatch(ctx)).historyEntryId,
				causeId: null,
				enabled: !input.disabled,
			}),
		)
		if (input.disabled) {
			await SquadRcon.broadcast(ctx, ctx.tr.broadcast(SS_Msgs.fogOff()))
		}
		return { code: 'ok' as const }
	}),

	// The squad browser indexes servers by the name they report over RCON, so the lookup goes through the live
	// server rather than the registry: an operator's display name for a server is their own and matches nothing.
	getJoinLink: orpcBase.input(z.object({ serverId: z.string() })).handler(async ({ context: _ctx, input }) => {
		const ctxRes = await tryCtx(_ctx, input.serverId)
		if (ctxRes.code !== 'ok') return ctxRes
		const ctx = ctxRes.ctx
		// nothing to join: a sandbox is emulated in-process, and its players are made up
		if (Sandbox.getInstance(ctx.serverId)) return { code: 'err:disabled' as const }
		const serverInfoRes = await ctx.squadRcon.serverInfo.get(ctx)
		if (serverInfoRes.code !== 'ok') return serverInfoRes
		const currentMatch = await MatchHistory.getCurrentMatch(ctx)
		const browserRes = await SquadBrowser.getJoinLink(ctx, serverInfoRes.data.name, currentMatch.historyEntryId)
		if (browserRes.code === 'ok') return browserRes

		const steamRes = await getSteamJoinLink(ctx)
		// wherever the browser was actually asked, its refusal names a condition an admin can act on ("not
		// listed", "try again in a minute") where steam's only says nobody happens to be sharing a lobby
		if (steamRes.code !== 'ok' && browserRes.code !== 'err:disabled') return browserRes
		return steamRes
	}),

	warnPlayers: orpcBase
		.input(
			z
				.object({
					serverId: z.string(),
					playerIds: z.array(SM.PlayerIdSchema).min(1),
					reason: z.string().min(1).optional(),
					presetReasonLabel: z.string().min(1).optional(),
					// omitted, the admin notification follows the admin-target rule in warnPlayers
					notifyAdmins: z.boolean().optional(),
					// lead the delivered message with the acting admin's display name ("grey275: @Alice ..."). Resolved
					// server-side so it always names the actual sender.
					prefixSenderName: z.boolean().optional(),
					// when a warn targets a whole squad the message gets a "@Squad<id>" (or "@cmdSquad") tag
					taggedSquad: z
						.object({
							squadId: z.number().int().positive(),
							squadName: z.string().min(1),
							teamId: SM.TeamIdSchema,
						})
						.optional(),
				})
				.refine((i) => !!i.reason !== !!i.presetReasonLabel, {
					error: 'Exactly one of reason or presetReasonLabel must be provided',
				}),
		)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:warn-players', { serverId: ctx.serverId }))
			if (denyRes) return denyRes
			const reasonRes = resolveReasonInput('warn', input, input.taggedSquad ? { squadName: input.taggedSquad.squadName } : undefined)
			if (reasonRes.code !== 'ok') return reasonRes
			// the input refine guarantees a reason was provided; narrow without asserting
			if (!reasonRes.applied) return { code: 'err:reason-required' as const, msg: 'A reason is required to warn.' }
			const tagged = AAR.renderAppliedReason(reasonRes.applied, {
				audienceTag: await resolveWarnAudienceTag(ctx, input.playerIds, input.taggedSquad),
			})
			// the sender's name leads the whole thing, ahead of the audience tag: "grey275: @Alice ..."
			const message = input.prefixSenderName ? `${await Users.resolveDisplayName(ctx, ctx.user.discordId)}: ${tagged}` : tagged
			// squad warns name the squad + faction (e.g. "warned Squad1 (PLA): ...") in the admin notification, which
			// already attributes the actor, so it quotes the message without the sender prefix
			let adminNotifyDescription: string | undefined
			if (input.taggedSquad) {
				const currentMatch = await MatchHistory.getCurrentMatch(ctx)
				const squadLabel = SM.squadAdminLabel(input.taggedSquad, MH.getTeamFaction(currentMatch, input.taggedSquad.teamId))
				adminNotifyDescription = `warned ${squadLabel}: ${tagged}`
			}
			await warnPlayers(
				ctx,
				input.playerIds,
				message,
				{ type: 'slm-user', userId: ctx.user.discordId },
				{
					reasonLabel: reasonRes.applied.label,
					notifyAdmins: input.notifyAdmins,
					adminNotifyDescription,
					adminNotifyMessage: tagged,
				},
			)
			return { code: 'ok' as const }
		}),

	warnAdmins: orpcBase.input(z.object({ serverId: z.string(), message: z.string().min(1) })).handler(async ({ context: _ctx, input }) => {
		const ctxRes = await tryCtx(_ctx, input.serverId)
		if (ctxRes.code !== 'ok') return ctxRes
		const ctx = ctxRes.ctx
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:warn-players', { serverId: ctx.serverId }))
		if (denyRes) return denyRes
		const [adminLists, teamsRes] = await Promise.all([AdminList.getListsForServerId(ctx, ctx.serverId), ctx.squadRcon.teams.get(ctx)])
		if (teamsRes.code !== 'ok') return teamsRes
		const admins = teamsRes.players
			.filter((p) => {
				if (!p.ids.steam) return false
				return SM.AdminList.isAdminInAny(adminLists, p.ids as SM.PlayerIds.IdQuery<'steam' | 'eos'>)
			})
			.map((p) => SM.PlayerIds.getPlayerId(p.ids))
		if (admins.length === 0) return { code: 'err:no-admins-online' as const }
		// the warn already reaches every admin, so skip the meta-notification
		await warnPlayers(ctx, admins, input.message, { type: 'slm-user', userId: ctx.user.discordId }, { notifyAdmins: false })
		return { code: 'ok' as const }
	}),

	broadcast: orpcBase
		.input(
			z
				.object({
					serverId: z.string(),
					message: z.string().min(1).optional(),
					presetReasonLabel: z.string().min(1).optional(),
					prefixSenderName: z.boolean().optional(),
				})
				.refine((i) => !!i.message !== !!i.presetReasonLabel, {
					error: 'Exactly one of message or presetReasonLabel must be provided',
				}),
		)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:broadcast', { serverId: ctx.serverId }))
			if (denyRes) return denyRes
			let template = input.message
			let presetLabel: string | undefined
			if (input.presetReasonLabel) {
				const res = resolvePresetReason('broadcast', input.presetReasonLabel)
				if (res.code !== 'ok') return res
				template = AAR.reasonText('broadcast', res.reason)
				presetLabel = res.reason.label
			}
			// broadcastAction renders the template, so the sender prefix wraps the raw text and rides through with it
			if (input.prefixSenderName) template = `${await Users.resolveDisplayName(ctx, ctx.user.discordId)}: ${template!}`
			await broadcastAction(ctx, template!, { type: 'slm-user', userId: ctx.user.discordId }, { presetLabel })
			return { code: 'ok' as const }
		}),

	demoteCommander: orpcBase
		.input(z.object({ serverId: z.string(), playerId: SM.PlayerIdSchema, presetReasonLabel: z.string().min(1).optional() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players', { serverId: ctx.serverId }))
			if (denyRes) return denyRes
			const reasonRes = resolveReasonInput('demote-commander', input)
			if (reasonRes.code !== 'ok') return reasonRes
			await demoteCommanderAction(ctx, input.playerId, { type: 'slm-user', userId: ctx.user.discordId }, reasonRes.applied)
			return { code: 'ok' as const }
		}),

	disbandSquad: orpcBase
		.input(
			z.object({
				serverId: z.string(),
				teamId: SM.TeamIdSchema,
				squadId: z.number().int().positive(),
				presetReasonLabel: z.string().min(1).optional(),
			}),
		)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players', { serverId: ctx.serverId }))
			if (denyRes) return denyRes
			const currTeams = getCurrTeams(ctx)
			const squad = currTeams && SM.findSquadForPlayer(currTeams.squads, { squadId: input.squadId, teamId: input.teamId })
			const reasonRes = resolveReasonInput('disband-squad', input, squad ? { squadName: squad.squadName } : undefined)
			if (reasonRes.code !== 'ok') return reasonRes
			await disbandSquadAction(ctx, input.teamId, input.squadId, { type: 'slm-user', userId: ctx.user.discordId }, reasonRes.applied)
			return { code: 'ok' as const }
		}),

	removeFromSquad: orpcBase
		.input(z.object({ serverId: z.string(), playerId: SM.PlayerIdSchema, presetReasonLabel: z.string().min(1).optional() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players', { serverId: ctx.serverId }))
			if (denyRes) return denyRes
			const reasonRes = resolveReasonInput('remove-from-squad', input)
			if (reasonRes.code !== 'ok') return reasonRes
			await removePlayersFromSquad(ctx, [input.playerId], { type: 'slm-user', userId: ctx.user.discordId }, reasonRes.applied)
			return { code: 'ok' as const }
		}),

	removePlayersFromSquad: orpcBase
		.input(
			z.object({
				serverId: z.string(),
				playerIds: z.array(SM.PlayerIdSchema).min(1),
				presetReasonLabel: z.string().min(1).optional(),
			}),
		)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players', { serverId: ctx.serverId }))
			if (denyRes) return denyRes
			const reasonRes = resolveReasonInput('remove-from-squad', input)
			if (reasonRes.code !== 'ok') return reasonRes
			await removePlayersFromSquad(ctx, input.playerIds, { type: 'slm-user', userId: ctx.user.discordId }, reasonRes.applied)
			return { code: 'ok' as const }
		}),

	kill: orpcBase
		.input(
			z.object({
				serverId: z.string(),
				playerIds: z.array(SM.PlayerIdSchema).min(1),
				reason: z.string().trim().min(1).optional(),
				presetReasonLabel: z.string().min(1).optional(),
				// set when the targets are a whole squad; exposed to reason templates as {{squadName}}
				squadName: z.string().min(1).optional(),
			}),
		)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players', { serverId: ctx.serverId }))
			if (denyRes) return denyRes
			const reasonRes = resolveReasonInput('kill', input, input.squadName ? { squadName: input.squadName } : undefined)
			if (reasonRes.code !== 'ok') return reasonRes
			// the kill notify delivers the rendered reason verbatim (see SquadRcon.killPlayers / ctx.tr.warn(SM_Msgs.notifyKilled()))
			const reason = reasonRes.applied && AAR.renderAppliedReason(reasonRes.applied)
			await killPlayersAction(ctx, input.playerIds, { type: 'slm-user', userId: ctx.user.discordId }, reason, reasonRes.applied?.label)
			return { code: 'ok' as const }
		}),

	// a plain kick; timeouts (which bar the player from rejoining) go through timeouts.timeoutPlayer
	kickPlayers: orpcBase
		.input(
			z.object({
				serverId: z.string(),
				playerIds: z.array(SM.PlayerIdSchema).min(1),
				reason: z.string().trim().min(1).optional(),
				presetReasonLabel: z.string().min(1).optional(),
				// set when the targets are a whole squad; exposed to reason templates as {{squadName}}
				squadName: z.string().min(1).optional(),
			}),
		)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:kick-players', { serverId: ctx.serverId }))
			if (denyRes) return denyRes
			const reasonRes = resolveReasonInput('kick', input, input.squadName ? { squadName: input.squadName } : undefined)
			if (reasonRes.code !== 'ok') return reasonRes
			await kickPlayersAction(ctx, input.playerIds, { type: 'slm-user', userId: ctx.user.discordId }, reasonRes.applied)
			return { code: 'ok' as const }
		}),

	renameSquad: orpcBase
		.input(z.object({ serverId: z.string(), teamId: SM.TeamIdSchema, squadId: z.number().int().positive() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('squad-server:manage-players', { serverId: ctx.serverId }))
			if (denyRes) return denyRes
			await renameSquadAction(ctx, input.teamId, input.squadId, { type: 'slm-user', userId: ctx.user.discordId })
			return { code: 'ok' as const }
		}),
}

async function getSteamJoinLink(ctx: SR.Ctx & CS.AbortSignal): Promise<Steam.JoinLinkRes> {
	if (!Steam.isEnabled()) return { code: 'err:disabled' }
	const teamsRes = await ctx.squadRcon.teams.get(ctx)
	if (teamsRes.code !== 'ok') return { code: 'err:request-failed', msg: 'Could not read the player list' }
	return await Steam.getJoinLink(
		ctx,
		teamsRes.players.flatMap((player) => (player.ids.steam ? [player.ids.steam] : [])),
	)
}

export async function setup() {
	log = module.getLogger()
	const ctx = getBaseCtx()

	globalState = {
		managedServers: new Map(),
		lifecycleUpdate$: new IsolatedSubject(),
		squadIdCounter: undefined!,
		lifecycleMtxs: new Map(),
	}

	const lastSquadRes = await ctx.db().select({ id: Schema.squads.id }).from(Schema.squads).orderBy(E.desc(Schema.squads.id)).limit(1)
	const nextSquadId = lastSquadRes.length > 0 ? lastSquadRes[0].id + 1 : 0
	globalState.squadIdCounter = Gen.counter(nextSquadId)

	// Settings.setup() has already loaded the registry by this point (see main.ts); boot a managed server for every server that should have one
	await Promise.all(Settings.listServerEntries().map((entry) => ensureRunning(entry.id)))
}

// Serializes every transition of a managed server between running and not, so that no two of setup, teardown and restart can
// interleave and observe each other's half-applied state. Per-server, so unrelated servers never wait on each other.
//
// The mutex is not reentrant, so the *Locked functions below are the composable pieces: anything already holding the lock must
// call those, and only the exported entry points may take it. Acquiring it twice in one call stack self-deadlocks.
function withLifecycleLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
	let mtx = globalState.lifecycleMtxs.get(serverId)
	if (!mtx) {
		mtx = new Mutex()
		globalState.lifecycleMtxs.set(serverId, mtx)
	}
	return mtx.runExclusive(fn)
}

// boots a managed server for the given server if it's enabled, not broken, and doesn't already have one running
export async function ensureRunning(serverId: string) {
	await withLifecycleLock(serverId, () => ensureRunningLocked(serverId))
}

async function ensureRunningLocked(serverId: string) {
	if (globalState.managedServers.has(serverId)) return
	const entry = Settings.getServerEntry(serverId)
	if (!entry || !entry.enabled || entry.broken) return
	const ctx = getBaseCtx()
	const serverState = await getServerState({ ...ctx, serverId })
	await setupManagedServer(ctx, serverState)
	log.info(`Server ${serverId} setup complete`)
}

// tears down a server's managed server if one is running. No-op otherwise.
async function destroyIfRunningLocked(serverId: string) {
	const managedServer = globalState.managedServers.get(serverId)
	if (!managedServer) return false
	await destroyServer({ ...getBaseCtx(), ...managedServer })
	return true
}

// tears down and re-creates a server's managed server, picking up the latest settings from the DB. If the server isn't currently
// running (disabled, broken, or not yet started), this just ensures it's running per the usual rules -- it never force-starts it.
export async function restartIfRunning(serverId: string) {
	await withLifecycleLock(serverId, async () => {
		if (await destroyIfRunningLocked(serverId)) {
			log.info(`Server ${serverId} torn down for restart`)
		}
		await ensureRunningLocked(serverId)
	})
}

// lets destroyServer cancel a managed server's in-flight work before its cleanup tasks run
const abortControllers = new Map<string, AbortController>()

async function setupManagedServer(ctx: C.Db & CS.AbortSignal, serverState: SS.ServerState) {
	const serverId = serverState.id
	const settings = serverState.settings
	const cleanup: Cleanup.Tasks = []

	const abort = new AbortController()
	abortControllers.set(serverId, abort)
	// aborts when the managed server is destroyed or the process shuts down
	const signal = Prom.anySignal(ctx.signal, abort.signal)!
	ctx = { ...ctx, signal }

	// the emulator has to be listening before anything can dial it, and it owns its own (ephemeral) port
	if (Sandbox.isSandbox(settings.connections)) await Sandbox.ensureInstance(serverId, settings.connections)

	ServerConsole.recordSlm(serverId, 'info', `Starting server, reaching it over ${settings.connections.type}`)

	// local/sftp dial RCON directly; server-agent tunnels it through the agent (the agent holds the password).
	// sandbox dials the in-process emulator over loopback, so the real packet framing still runs.
	const rconTransport =
		settings.connections.type === 'server-agent'
			? ServerAgent.rconTransportFor(serverId)
			: new DirectSocketTransport(settings.connections.type === 'sandbox' ? Sandbox.connectionFor(serverId) : settings.connections.rcon)
	const rcon = new Rcon({
		serverId,
		transport: rconTransport,
		onTraffic: (dir, body, reqId) => ServerConsole.record(serverId, { type: 'rcon', dir, body, reqId, time: Date.now() }),
		onStatus: (level, message, detail) => ServerConsole.recordSlm(serverId, level, message, detail),
	})
	rcon.ensureConnected()
	cleanup.push(() => rcon.disconnect())
	cleanup.push(() => ServerConsole.recordSlm(serverId, 'info', 'Server stopped'))
	cleanup.push(() => CommandPrompts.disposeFor(serverId))

	// a resource that keeps failing after retries means the managed server can't do its job -- tear the managed server down instead of
	// letting the error escalate to an unhandled rejection and crash the process.
	//
	// Takes the lifecycle lock, which is safe only because AsyncResource discards this callback's return rather than awaiting it:
	// nothing holding the lock ever waits on us, so there is no cycle. If the resource dies mid-setup we simply queue behind
	// setupManagedServer and tear down the managed server it just finished building.
	const destroyAfterFatalError = async (err: unknown) => {
		log.error(err, `Server ${serverId}: async resource failed permanently, tearing the server down`)
		ServerConsole.recordSlm(serverId, 'error', 'A connection failed permanently, stopping the server', err)
		try {
			await withLifecycleLock(serverId, () => destroyIfRunningLocked(serverId))
		} catch (destroyErr) {
			log.error(destroyErr, `Server ${serverId}: failed to tear the server down after fatal resource error`)
		}
	}
	const onResourceFatalError = (err: unknown) => void destroyAfterFatalError(err)

	// How long a logged line can take to reach us. A polled source can be a whole poll behind; a pushed one is near-live.
	const logDeliveryMs =
		settings.connections.type === 'sftp'
			? settings.connections.sftp.pollInterval
			: settings.connections.type === 'local'
				? Settings.GLOBAL_SETTINGS.logFilePollInterval
				: settings.connections.type === 'server-agent'
					? 500
					: // in-process: a log line is delivered in the same tick the world writes it
						settings.connections.type === 'sandbox'
						? 0
						: assertNever(settings.connections)

	// Long enough to survive a tick split across two deliveries, and short enough to stay inside the window below,
	// so a poll doesn't give up waiting for the log while the parser is still holding a tick.
	const logIdleFlushMs = Math.max(logDeliveryMs * 1.5, 100)

	const eventState: PendingEvents.State = PendingEvents.init({
		counters: {
			squadId: globalState.squadIdCounter,
		},
		currentMatch: 'PENDING',
		log: log,
		hooks: {
			onNewGameDuringRoll: onNewGameDuringRoll(serverId),
			onNewGameDuringSync: onNewGameDuringSync(serverId),
			createEvent: createEvent(serverId),
			// Every caller resolves what the server is doing right now, at a moment the cached value is still the
			// outgoing match's. observe() replays whatever is cached as its first emission whatever ttl it is asked
			// for, so this has to be a get that refuses the cache outright.
			fetchLayersStatus: async () => {
				const ctx = resolveCtx(getBaseCtx(), serverId)
				const res = await ctx.squadRcon.layersStatus.get(ctx, { ttl: 0 })
				return res.code === 'ok' ? res.data : null
			},
		},
		// how far a non-log event may lead the log stream before we stop waiting for the log to catch up:
		// one delivery, and the parser's wait for the tick it is accumulating to go quiet. A static prior only:
		// once measured log lag warms up, LogLagTuner retunes it (clock skew makes any static value drift).
		minSafeLogLeadTimeForOtherEvents: logDeliveryMs + logIdleFlushMs,
	})

	const server: SQS.Ctx.Payload = {
		postRollEventsSub: null,

		serverRolling$: new Rx.BehaviorSubject(null as number | null),
		tickRate$: new Rx.BehaviorSubject(null as number | null),

		event$: new TracedSubject({ ...CS.init(), serverId }),
		appEvent$: new TracedSubject({ ...CS.init(), serverId }),
		processEventsMtx: new Mutex(),

		eventState: eventState,

		chatState: CHAT.getInitialChatState(),
		emittedEvents: [],
		emittedAppEvents: [],
		destroyed: false,
		cleanupId: null,
	}

	const squadRcon = SquadRcon.initSquadRcon({ ...ctx, rcon, serverId }, cleanup, {
		cacheTTL: settings.rconCacheTTL,
		onFatalError: onResourceFatalError,
	})

	cleanup.push(
		() => server.postRollEventsSub,
		server.serverRolling$,
		server.tickRate$,
		server.event$,
		server.appEvent$,
		server.processEventsMtx,
	)

	// hoisted so the translator can follow the server's locale setting, whose payload is mutated in place
	const serverSettings = Settings.initServerPayload({ ...ctx, cleanup, serverId }, serverState)

	const managedServer: C.ManagedServer = {
		...CS.init(),
		serverId,
		signal,
		tr: I18n.liveTranslator(() => serverSettings.settings.locale),

		rcon,
		squadRcon,
		server,

		matchHistory: MatchHistory.initMatchHistoryContext(server.event$, cleanup),
		matchEventsCache: MatchEventsCache.initMatchEventsCacheContext(),

		teamswaps: TeamswapsSys.initContext({
			...ctx,
			serverId,
			cleanup,
			rcon,
			squadRcon,
			server,
		}),
		switchRequests: SwitchRequestsSys.initContext({
			...ctx,
			serverId,
			cleanup,
			rcon,
			squadRcon,
			server,
		}),
		layerQueue: LayerQueue.initPayload({ ...ctx, cleanup, serverId }, serverState),
		serverSettings,
		vote: Vote.initVoteContext(cleanup),

		cleanup: cleanup,
	}

	globalState.managedServers.set(serverId, managedServer)
	globalState.lifecycleUpdate$.next(serverId)

	// -------- load saved events --------
	await MatchHistory.initState({
		...ctx,
		serverId,
		signal,
		matchHistory: managedServer.matchHistory,
		matchEventsCache: managedServer.matchEventsCache,
	})
	await loadSavedEvents({ ...ctx, rcon, squadRcon, server, serverId })

	// // -------- watch events --------
	server.event$.subscribe(([, event]) => {
		try {
			CHAT.handleEvent(server.chatState, event)
		} catch (error) {
			log.error(error, 'Error handling event: %s %d', event.type, event.id)
		}
		log.info(
			'emitted event: %s %s',
			event.type,
			JSON.stringify(['NEW_GAME', 'RESET'].includes(event.type) ? Obj.omit(event as any, ['state']) : event),
		)
		server.emittedEvents.push(event)
	})

	server.event$
		.pipe(
			Rx.filter(([_, event]) => event.type === 'PLAYER_DETAILS_CHANGED' && !!event.newUsername),
			Instr.durableSub('onPlayerNameChanged', { module }, async ([evtCtx, event], signal) => {
				if (event.type !== 'PLAYER_DETAILS_CHANGED' || !event.newUsername) {
					return
				}
				const ctx = eventCtx(evtCtx, signal)
				await ctx.db().update(Schema.players).set({ username: event.newUsername }).where(E.eq(Schema.players.eosId, event.player))
			}),
		)
		.subscribe()

	// The Squad server re-reads its Admins.cfg on every new game, so refetch at the same moment rather than waiting out
	// the hourly TTL: from the roll onwards the file's current contents are what the server enforces in-game, and SLM
	// answering permission checks from an older copy disagrees with it for up to an hour.
	server.event$.pipe(Rx.filter(([, event]) => event.type === 'NEW_GAME')).subscribe(() => AdminList.invalidateAll(ctx))

	// kick-timeout enforcement: fresh connects and full roster reseeds. PLAYER_RECONCILED (roster backfill of an
	// already-present player) is deliberately excluded. RESET fires on every roll, doubling as a periodic sweep.
	server.event$
		.pipe(
			Rx.filter(([_, event]) => event.type === 'PLAYER_CONNECTED' || event.type === 'RESET'),
			Instr.durableSub('onPlayerConnectedEnforceTimeouts', { module }, async ([evtCtx, event], signal) => {
				const playerIds =
					event.type === 'PLAYER_CONNECTED'
						? [SM.PlayerIds.getPlayerId(event.player.ids)]
						: event.type === 'RESET'
							? (SE.eventRoster(event)?.players.map((p) => SM.PlayerIds.getPlayerId(p.ids)) ?? [])
							: []
				if (playerIds.length === 0) return
				await Timeouts.enforceTimeouts(eventCtx(evtCtx, signal), playerIds)
			}),
		)
		.subscribe() // -------- process log events --------
	const logStreamAc = new AbortController()
	cleanup.push(logStreamAc)
	void Instr.spanOp('processLogEvents', { module }, async (_: unknown) => {
		let chunk$: Rx.Observable<string>
		if (settings.connections.type === 'sftp') {
			const sftp = settings.connections.sftp
			const sftpReader = new SftpTail({
				filePath: sftp.logFile,
				host: sftp.host,
				port: sftp.port,
				username: sftp.username,
				password: sftp.password,
				pollInterval: sftp.pollInterval,
				reconnectInterval: sftp.reconnectInterval,
				maxReconnectAttempts: sftp.maxReconnectAttempts,
				// reconnection attempts exhausted: tear the managed server down rather than letting the error crash the process
				onFatalError: onResourceFatalError,
				onStatus: (level, message, detail) => ServerConsole.recordSlm(serverId, level, message, detail),
				parentModule: module,
			})
			cleanup.push(() => sftpReader.unwatch())
			sftpReader.watch()

			chunk$ = Rx.fromEvent(sftpReader, 'chunk').pipe(Rx.map((...args) => args[0] as string))
		} else if (settings.connections.type === 'local') {
			const fileReader = new FileTail({
				filePath: settings.connections.logFile,
				pollInterval: Settings.GLOBAL_SETTINGS.logFilePollInterval,
				onFatalError: onResourceFatalError,
				onStatus: (level, message, detail) => ServerConsole.recordSlm(serverId, level, message, detail),
				parentModule: module,
			})
			cleanup.push(() => fileReader.unwatch())
			fileReader.watch()

			chunk$ = Rx.fromEvent(fileReader, 'chunk').pipe(Rx.map((...args) => args[0] as string))
		} else if (settings.connections.type === 'server-agent') {
			chunk$ = ServerAgent.streamFor(serverId)
		} else if (settings.connections.type === 'sandbox') {
			// straight from the world, with no file in between. The instance outlives this subscription, so the
			// unsubscribe has to detach the listener or a managed server restart would leave the old one writing into a dead stream.
			chunk$ = new Rx.Observable<string>((subscriber) => {
				const instance = Sandbox.getInstance(serverId)
				if (!instance) {
					subscriber.error(new Error(`sandbox ${serverId} has no running emulator`))
					return
				}
				return instance.emu.onLogLine((line) => subscriber.next(line + '\n'))
			})
		} else {
			assertNever(settings.connections)
		}

		// Counted on the way in, at the one point every log source (sftp poll, local file tail,
		// server-agent push) funnels through, so the numbers mean the same thing whichever a server uses. A
		// chunk is not line-aligned, so lines are counted by newline rather than by split length: a
		// chunk that splits a line in half would otherwise count it twice.
		const logSource = settings.connections.type satisfies ATTRS.SquadLogs.Source
		const countedChunk$ = chunk$.pipe(
			Rx.tap((chunk) => {
				// the console tails the same point the counters do, so it shows what was actually ingested rather
				// than what a particular source happened to produce
				ServerConsole.recordLogChunk(serverId, chunk, Date.now())
				const attrs = { [ATTRS.SquadServer.ID]: serverId, [ATTRS.SquadLogs.SOURCE]: logSource }
				logIoCounter.add(Buffer.byteLength(chunk, 'utf8'), attrs)
				let lines = 0
				for (let i = 0; i < chunk.length; i++) {
					if (chunk[i] === '\n') lines++
				}
				if (lines > 0) logLineCounter.add(lines, attrs)
			}),
		)

		const errors: Error[] = []
		for await (const event of SM.LogEvents.parseLogStream(
			Rx.Ext.toAsyncGenerator(countedChunk$.pipe(Rx.Ext.withAbortSignal(logStreamAc.signal))),
			errors,
			{
				onTickRate: (rate) => server.tickRate$.next(rate),
				// a tick is otherwise only closed by the next one, which on a quiet server can be a long time
				idleFlushMs: logIdleFlushMs,
			},
		)) {
			if (logStreamAc.signal.aborted) break
			const ctx = resolveCtx(getBaseCtx(), serverId)
			for (const error of errors) {
				log.error(error)
				// a line SLM could not parse is usually the game's log format having moved, which shows up to an admin
				// as SLM quietly missing events rather than as anything being wrong
				ServerConsole.recordSlm(serverId, 'warn', 'Could not parse a log line', error)
			}
			errors.splice(0, errors.length)

			if (!event) {
				log.warn('No log event to process')
				return
			}

			logEventCounter.add(1, { [ATTRS.SquadServer.ID]: serverId, [ATTRS.SquadLogs.SOURCE]: logSource })
			const lagSampleMs = PendingEvents.LogLagTuner.observe(ctx.server.eventState, event.time, Date.now())
			if (lagSampleMs !== null) {
				// clock skew can push a lag negative; the tuner keeps the sign, the metric clamps to stay a valid histogram value
				logLagHistogram.record(Math.max(0, lagSampleMs), {
					[ATTRS.SquadServer.ID]: serverId,
					[ATTRS.SquadLogs.SOURCE]: logSource,
				})
			}

			await collectEvents(ctx, () => {
				PendingEvents.onLogEvent(ctx.server.eventState, event)
			})
		}
	})({ ...ctx, server })

	cleanup.push(
		rcon.connected$
			.pipe(
				Instr.durableSub('onRconConnectStatusChange', { module }, async (connected, signal) => {
					const ctx = resolveCtx(CS.addSignal(getBaseCtx(), signal), serverId)
					const time = Date.now()
					let layerStatus: SM.LayersStatusResExt | undefined
					let layersData: SM.LayersStatusExt | undefined
					if (connected) {
						Users.invalidatePendingSteamLinkCodes()
						layerStatus = await ctx.squadRcon.layersStatus.get({ ...ctx, rcon })
						if (layerStatus.code !== 'ok') return layerStatus
						layersData = layerStatus.data
					}
					await collectEvents({ ...ctx, server }, () => {
						if (connected) {
							PendingEvents.onRconConnected(
								ctx.server.eventState,
								time,
								layersData!.nextLayer?.id ?? null,
								layersData!.currentLayer.id,
							)
						} else {
							PendingEvents.onRconDisconnected(ctx.server.eventState, time)
						}
					})
				}),
			)
			.subscribe(),
	)

	// -------- process rcon events --------
	cleanup.push(
		squadRcon.rconEvent$
			.pipe(
				Instr.durableSub(
					'onRconEvent',
					{ module, taskScheduling: 'parallel', levels: { event: 'trace' } },
					async ([_ctx, event], signal) => {
						const ctx = CS.initDeferred(DB.addPooledDb(resolveCtx(CS.addSignal({ ..._ctx }, signal), serverId)))
						try {
							const opts: Promise<void>[] = []
							if (event.type === 'CHAT_MESSAGE') {
								ServerConsole.record(serverId, {
									type: 'command',
									player: event.playerIds.username ?? 'unknown',
									channel: event.channelType,
									message: event.message,
									time: event.time,
								})
								if (Settings.GLOBAL_SETTINGS.allowedPrefixes.some(({ prefix }) => event.message.startsWith(prefix))) {
									opts.push(
										Commands.handleCommand(ctx, event).then((res) => {
											if (res && res?.code !== 'ok') log.error(res)
										}),
									)
								} else if (CommandPrompts.capturesAnswer(serverId, SM.PlayerIds.getPlayerId(event.playerIds), event)) {
									// a number this player was just asked for outranks the same number as a vote: the prompt was
									// solicited from them seconds ago and clears itself either way (see command-prompts.server)
									opts.push(
										Commands.handleChoiceAnswer(ctx, event).then((res) => {
											if (res && res?.code !== 'ok') log.error(res)
										}),
									)
								} else if (event.message.trim().match(/^\d+$/) && ctx.vote.state?.code === 'in-progress') {
									opts.push(Vote.handleVote(ctx, event))
								}
							}
							await Promise.all(opts)
						} catch (err) {
							log.error(err)
						}

						await collectEvents(ctx, () => {
							PendingEvents.onRconEvent(ctx.server.eventState, event)
						})

						// drain best-effort side work (e.g. vote-cast warns) scheduled by the handlers above, so it
						// finishes inside this task's lifetime and signal instead of leaking as a floating promise
						for (const err of await CS.awaitDeferred(ctx)) log.error(err)
					},
				),
			)
			.subscribe(),
	)

	cleanup.push(
		squadRcon.teams
			.observe({ ...managedServer, ...ctx })
			.pipe(
				Instr.durableSub('onTeamsPolled', { module, numTaskRetries: 0, levels: { event: 'debug' } }, async (teamsRes, signal) => {
					if (teamsRes.code !== 'ok') return teamsRes
					const receivedAt = Date.now()
					const ctx = resolveCtx(CS.addSignal(getBaseCtx(), signal), serverId)
					await collectEvents(ctx, () => {
						PendingEvents.onTeamsPolled(
							server.eventState,
							{ players: teamsRes.players, squads: teamsRes.squads },
							receivedAt,
							teamsRes.polledAt,
						)
					})
				}),
			)
			.subscribe(),
	)

	cleanup.push(
		server.event$
			.pipe(
				Rx.filter(([ctx, e]) => e.type === 'PLAYER_WOUNDED' && e.variant === 'teamkill'),
				Instr.durableSub('notifyTeamkills', { module }, async ([_ctx, e], signal) => {
					const ctx = resolveCtx(CS.addSignal(getBaseCtx(), signal), serverId)
					const settings = (await Settings.getServerSettings(ctx, serverId)).teamkillNotifications
					if (e.type !== 'PLAYER_WOUNDED') return
					if (!settings.enabled) return
					const players = getCurrTeams(ctx)?.players
					if (!players) return
					const attacker = players.get(e.attacker)
					const victim = players.get(e.victim)
					if (!attacker || !victim) return
					const rendered = Templating.renderTemplate(settings.template, {
						attacker: attacker.ids.username,
						weapon: e.weapon ?? '',
					})
					await SquadRcon.warn(ctx, victim.ids, rendered)
				}),
			)
			.subscribe(),
	)

	void LayerQueue.setupInstance({ ...ctx, ...managedServer })
	// A sandbox's players are fabricated, so their eos ids belong to nobody. BattleMetrics is a real, org-wide
	// outbound service: looking them up would spam it with garbage and any flag or note written while looking at
	// the sandbox would land on the live org. It is left off entirely rather than stubbed.
	if (!Sandbox.isSandbox(settings.connections)) Battlemetrics.setupSquadServerInstance({ ...ctx, ...managedServer })
	PluginsSys.setupServerInstances(managedServer)

	server.cleanupId = CleanupSys.register(async () => {
		await withLifecycleLock(serverId, () => destroyIfRunningLocked(serverId))
	})
	log.info('Initialized server %s', serverId)
	if (Settings.GLOBAL_SETTINGS.warnOnSlmStart) {
		const restartedBy = AppEventsSys.restartInfo
			? await Users.resolveDisplayName(ctx, AppEventsSys.restartInfo.userId, 'someone')
			: undefined
		await SquadRcon.warnAllAdmins({ ...ctx, ...managedServer }, SS_Msgs.slmStarted(restartedBy))
	}
}

export async function pushAttribution(ctx: SQS.Ctx & C.Db & CS.AbortSignal, attribution: Omit<PendingEvents.Attribution, 'time'>) {
	await collectEvents(ctx, () => {
		PendingEvents.pushAttribution(ctx.server.eventState, attribution)
	})
}

// persists an SLM app (audit) event and streams it into this server's activity feed. Persist happens before
// the push (and before any server event that links to it via appEventId is later saved), satisfying the FK.
export async function emitAppEvent(ctx: SQS.Ctx & C.Db & CS.AbortSignal, appEvent: AppEvents.AppEvent) {
	await AppEventsSys.persistAppEvent(ctx, appEvent)
	ctx.server.emittedAppEvents.push(appEvent)
	ctx.server.appEvent$.emit(appEvent)
}

// resolves a preset admin-action reason against the current global settings. handlers call this before executing
// anything so a stale preset (deleted/retargeted since the client loaded it) fails the whole action.
export function resolvePresetReason(action: AAR.AdminActionType, presetReasonLabel: string) {
	return AAR.resolveReasonByLabel(Settings.GLOBAL_SETTINGS.adminActionReasons, action, presetReasonLabel)
}

// the variable context for reason/broadcast message templates: the admin-configured custom variables, expanded
// against each other, overlaid with any per-call standard variables (e.g. duration). squadName is a standard
// variable too: the target squad's name when the action targets a whole squad, empty otherwise, so
// {{#squadName}} sections drop out for player targets.
export function messageVars(extra?: Record<string, string>): Record<string, string> {
	return Templating.resolveTemplateVars(Settings.GLOBAL_SETTINGS.messageVariables, { squadName: '', ...extra })
}

// enforces the per-action "require a reason" setting; returns an error result when the action needs a reason
// and none was provided, else null. A warn is nothing but its reason, so one is always required (which is why
// warn isn't configurable in requireReasonFor).
export function reasonRequirementError(
	action: AAR.AdminActionType,
	hasReason: boolean,
): { code: 'err:reason-required'; msg: string } | null {
	if (hasReason) return null
	const required = action === 'warn' || Settings.GLOBAL_SETTINGS.requireReasonFor.some((a) => a === action)
	if (required) return { code: 'err:reason-required', msg: `A reason is required for ${AAR.ADMIN_ACTIONS[action].displayName}.` }
	return null
}

// resolves a web action's reason input into an AppliedReason snapshot: enforces the require-reason setting,
// resolves preset labels against current settings (a stale preset fails the whole action), and snapshots the
// message variables so custom and preset text render identically everywhere. `applied` is undefined only when
// no reason was given and the action doesn't require one.
export function resolveReasonInput(
	action: AAR.AdminActionType,
	input: { reason?: string; presetReasonLabel?: string },
	extraVars?: Record<string, string>,
):
	| { code: 'ok'; applied?: AAR.AppliedReason }
	| { code: 'err:reason-required'; msg: string }
	| Exclude<AAR.ResolveReasonRes, { code: 'ok' }> {
	const rr = reasonRequirementError(action, !!(input.reason || input.presetReasonLabel))
	if (rr) return rr
	if (input.presetReasonLabel) {
		const res = resolvePresetReason(action, input.presetReasonLabel)
		if (res.code !== 'ok') return res
		return { code: 'ok', applied: AAR.applyReason(action, res.reason, messageVars(extraVars)) }
	}
	if (input.reason) return { code: 'ok', applied: AAR.applyCustomReason(input.reason, messageVars(extraVars)) }
	return { code: 'ok' }
}

// warns every in-game admin of a web-initiated admin action so they see activity they'd otherwise only find in
// the web feed. In-game commands already echo to the invoking admin via reply() (and warn the target), so this
// fires only for slm-user (web) actors; ingame-user/system actions no-op.
export async function notifyAdminsOfWebAction(
	ctx: SR.Ctx & C.Db & CS.AbortSignal & Msgs.Ctx,
	appEvent: AppEvents.AppEvent,
	// override the default describeAppEvent phrasing (e.g. squad warns name the squad + faction)
	description?: string,
) {
	if (appEvent.actor.type !== 'slm-user') return
	const name = await Users.resolveDisplayName(ctx, appEvent.actor.userId)
	await SquadRcon.warnAllAdmins(ctx, `${name} ${description ?? AppEvents_Msgs.describeAppEvent(appEvent)}`)
}

// delivers a preset reason's message to the affected players as an in-game warn, attributing the landing
// PLAYER_WARNED server events to the originating action's app event (so they collapse under it in the feed
// rather than emitting a separate PLAYER_WARNED app event).
async function sendReasonFollowUpWarn(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & CS.AbortSignal & Msgs.Ctx,
	appEventId: AppEvents.AppEventId,
	targets: SM.PlayerId[],
	message: string,
) {
	if (targets.length === 0) return
	const source = { type: 'event' as const, id: appEventId }
	await collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.expectWarn(ctx.server.eventState, { playerId: target, reason: message, source })
		}
	})
	await SquadRcon.warnAll(ctx, targets, message)
}

// kicks a single player, attributing the resulting PLAYER_KICKED server event to `source` (the app event that
// caused it: PLAYER_TIMED_OUT for timeout kicks and their later enforcement, PLAYER_KICKED for plain kicks).
// The primitive both kick paths bottom out in; it emits no app event of its own.
export async function kickPlayerAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & CS.AbortSignal,
	target: SM.PlayerId,
	source: PendingEvents.ArmedActionSource,
	reason?: string,
) {
	await collectEvents(ctx, () => {
		PendingEvents.armExpectation(ctx.server.eventState, { type: 'PLAYER_KICKED', playerId: target }, source)
	})
	await SquadRcon.kickPlayer(ctx, target, reason)
}

// a plain kick (no timeout): the players are removed and may rejoin immediately. One app event covers the whole
// batch, and each kick's server event is attributed to it.
export async function kickPlayersAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal & Msgs.Ctx,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
	reason?: AAR.AppliedReason,
) {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.PlayerKicked>({
		type: 'PLAYER_KICKED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		targets,
		reason,
	})
	await emitAppEvent(ctx, appEvent)
	const message = ctx.tr.text(SM_Msgs.notifyKicked(reason && AAR.renderAppliedReason(reason)))
	for (const target of targets) {
		await kickPlayerAction(ctx, target, { type: 'event', id: appEvent.id }, message)
	}
	await notifyAdminsOfWebAction(ctx, appEvent)
}

export async function broadcastAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal & Msgs.Ctx,
	message: string,
	actor: AppEvents.Actor,
	opts?: { presetLabel?: string },
) {
	// render {{var}} templating; the rendered text is what's broadcast and what the audit records
	const rendered = Templating.renderTemplate(message, messageVars({ label: opts?.presetLabel ?? '' }))
	const appEvent = AppEvents.create<AppEvents.BroadcastSent>({
		type: 'BROADCAST_SENT',
		actor,
		serverId: ctx.serverId,
		// feed-visible: the landing ADMIN_BROADCAST server event is attributed to this and collapses under it, which
		// is what makes the broadcast read as the admin who sent it rather than as an anonymous RCON line
		matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
		causeId: null,
		message: rendered,
		presetLabel: opts?.presetLabel,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await collectEvents(ctx, () => {
		// a long broadcast reaches the game as several rcon calls, and the game logs each one
		for (const message of SquadRcon.splitBroadcast(rendered)) {
			PendingEvents.armExpectation(ctx.server.eventState, { type: 'ADMIN_BROADCAST', message }, source)
		}
	})
	await SquadRcon.broadcast(ctx, rendered)
}

/**
 * Ends the current match and waits for the round end it produces.
 *
 * The app event is recorded and the expectation armed before the rcon command goes out, so the ROUND_ENDED
 * that lands is attributed to `actor` rather than reported as an anonymous RCON tool's doing: the game log
 * cannot tell the two apart.
 */
export async function endMatchAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal,
	actor: AppEvents.Actor,
): Promise<{ code: 'ok' | 'err:timeout' | 'err:unknown'; message: string }> {
	const matchEnded$ = ctx.server.event$.pipe(
		Rx.map(([_, e]) => e),
		Rx.filter((e) => e.type === 'ROUND_ENDED'),
		Rx.endWith(null),
	)
	const result$ = Rx.Ext.firstValueFrom(Rx.race(matchEnded$, Rx.timer(20_000).pipe(Rx.map(() => 'timeout' as const))), ctx.signal)

	const matchEnded = AppEvents.create<AppEvents.MatchEnded>({
		type: 'MATCH_ENDED',
		actor,
		serverId: ctx.serverId,
		matchId: (await MatchHistory.getCurrentMatch(ctx)).historyEntryId,
		causeId: null,
	})
	await emitAppEvent(ctx, matchEnded)
	await collectEvents(ctx, () => {
		PendingEvents.armExpectation(ctx.server.eventState, { type: 'ROUND_ENDED' }, { type: 'event', id: matchEnded.id })
	})
	await SquadRcon.endMatch(ctx)

	const result = await result$
	if (result === 'timeout') return { code: 'err:timeout' as const, message: 'Failed to end match: operation timed out' }
	if (result === null) return { code: 'err:unknown' as const, message: 'Failed to end match: unknown error' }
	if (result.type === 'ROUND_ENDED') return { code: 'ok' as const, message: 'Match ended successfully' }
	assertNever(result.type)
}

// warns players through an app event: creates the PLAYER_WARNED app event (so the feed can aggregate the
// resulting warns under one entry), arms the pending-events machine to attribute each landing PLAYER_WARNED server
// event to it, then issues the warns. Emit (persist) precedes arming and the warns so the app event exists before
// any server event referencing it is saved.
export async function warnPlayers(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal & Msgs.Ctx,
	targets: SM.PlayerId[],
	reason: string,
	actor: AppEvents.Actor,
	// notifyAdmins: forces the meta-notification on or off; left undefined it follows the admin-target rule below.
	// adminNotifyDescription: override the admin-notification phrasing (squad warns name the squad + faction)
	// adminNotifyMessage: the text the notification quotes, when that should differ from what was delivered (the
	// notification already names the actor, so it drops the delivered message's sender prefix)
	opts?: { reasonLabel?: string; notifyAdmins?: boolean; adminNotifyDescription?: string; adminNotifyMessage?: string },
) {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.PlayerWarned>({
		type: 'PLAYER_WARNED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		message: reason,
		targets,
		reasonLabel: opts?.reasonLabel,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.expectWarn(ctx.server.eventState, { playerId: target, reason, source })
		}
	})
	await SquadRcon.warnAll(ctx, targets, reason)
	// in-game commands echo to the invoking admin themselves, so there's nothing to classify or notify for them
	if (opts?.notifyAdmins === false || actor.type !== 'slm-user') return
	const audience = await classifyWarnTargets(ctx, targets)
	if (opts?.notifyAdmins === undefined) {
		// admin-to-admin chatter shouldn't page the whole admin team; a preset reason is a formal action, so it still does
		if (!opts?.reasonLabel && audience.allAdmins) return
	}
	const notifyMessage = opts?.adminNotifyMessage ?? reason
	await notifyAdminsOfWebAction(ctx, appEvent, opts?.adminNotifyDescription ?? `warned ${audience.label}: ${notifyMessage}`)
}

// resolves warn targets against the live roster: the matching players (undefined where a target isn't online) plus
// whether they're all admins and whether they're the entire online admin roster
async function resolveWarnTargets(ctx: SR.Ctx & CS.AbortSignal, targets: SM.PlayerId[]) {
	const [adminLists, teamsRes] = await Promise.all([AdminList.getListsForServerId(ctx, ctx.serverId), ctx.squadRcon.teams.get(ctx)])
	if (teamsRes.code !== 'ok') return { players: [], allAdmins: false, isEntireAdminRoster: false }

	const isAdmin = (player: SM.Player) => SM.AdminList.isAdminInAny(adminLists, player.ids as SM.PlayerIds.IdQuery<'steam' | 'eos'>)
	const players = targets.map((target) => SM.PlayerIds.find(teamsRes.players, (p) => p.ids, target))
	const allAdmins = players.every((player) => !!player && isAdmin(player))
	return { players, allAdmins, isEntireAdminRoster: allAdmins && players.length === teamsRes.players.filter(isAdmin).length }
}

// the "@..." tag prepended to a warn so recipients see who it's aimed at: an explicit squad warn keeps its squad
// tag, a lone target is named, the whole online admin roster reads as "@admins", and any other set goes untagged.
async function resolveWarnAudienceTag(
	ctx: SR.Ctx & CS.AbortSignal,
	targets: SM.PlayerId[],
	taggedSquad?: { squadId: number; squadName: string; teamId: SM.TeamId },
) {
	if (taggedSquad) return SM.squadWarnTag(taggedSquad)
	const resolved = await resolveWarnTargets(ctx, targets)
	if (targets.length === 1) {
		const username = resolved.players[0]?.ids.username
		return username ? `@${username}` : undefined
	}
	return resolved.isEntireAdminRoster ? '@admins' : undefined
}

// who a warn hit, phrased for the admin notification: the warnee by name for a single target, "all admins" when it
// reached exactly the online admin roster, otherwise a plain count. allAdmins also drives the notification opt-out.
async function classifyWarnTargets(ctx: SR.Ctx & CS.AbortSignal, targets: SM.PlayerId[]) {
	const count = (n: number) => `${n} ${n === 1 ? 'player' : 'players'}`
	const resolved = await resolveWarnTargets(ctx, targets)
	if (resolved.isEntireAdminRoster) return { allAdmins: resolved.allAdmins, label: 'all admins' }
	const only = resolved.players.length === 1 ? resolved.players[0]?.ids.username : undefined
	return { allAdmins: resolved.allAdmins, label: only ?? count(targets.length) }
}

// disbands a squad through an app event: records the squad + its members, arms the machine to attribute the
// resulting SQUAD_DISBANDED server event to the acting user, then issues the disband.
export async function disbandSquadAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal & Msgs.Ctx,
	teamId: SM.TeamId,
	squadId: SM.SquadId,
	actor: AppEvents.Actor,
	reason?: AAR.AppliedReason,
) {
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const teams = getCurrTeams(ctx)
	const squad = teams && SM.findSquadForPlayer(teams.squads, { squadId, teamId })
	const members: SM.PlayerId[] = []
	for (const [id, player] of teams?.players ?? []) {
		if (player.teamId === teamId && player.squadId === squadId) members.push(id)
	}
	const appEvent = AppEvents.create<AppEvents.SquadDisbanded>({
		type: 'SQUAD_DISBANDED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		teamId,
		squadId,
		squadName: squad?.squadName ?? `Squad ${squadId}`,
		members,
		reason,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await collectEvents(ctx, () => {
		PendingEvents.armExpectation(ctx.server.eventState, { type: 'SQUAD_DISBANDED', teamId, squadId }, source)
	})
	await SquadRcon.disbandSquad(ctx, teamId, squadId)
	if (reason) {
		await sendReasonFollowUpWarn(
			ctx,
			appEvent.id,
			members,
			AAR.renderAppliedReason(reason, { audienceTag: squad ? SM.squadWarnTag(squad) : `@Squad${squadId}` }),
		)
	}
	// name the squad + faction consistently with squad warns (e.g. "disbanded Squad1 (PLA)")
	const squadLabel = squad ? SM.squadAdminLabel(squad, MH.getTeamFaction(currentMatch, teamId)) : `Squad${squadId}`
	await notifyAdminsOfWebAction(ctx, appEvent, `disbanded ${squadLabel}${reason?.label ? ` for ${reason.label}` : ''}`)
}

// removes players from their squads through an app event, attributing each resulting PLAYER_LEFT_SQUAD server event
export async function removePlayersFromSquad(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal & Msgs.Ctx,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
	reason?: AAR.AppliedReason,
) {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.PlayerRemovedFromSquad>({
		type: 'PLAYER_REMOVED_FROM_SQUAD',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		targets,
		reason,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.armExpectation(ctx.server.eventState, { type: 'PLAYER_LEFT_SQUAD', playerId: target }, source)
		}
	})
	await Promise.all(targets.map((target) => SquadRcon.removeFromSquad(ctx, target)))
	if (reason) {
		await sendReasonFollowUpWarn(ctx, appEvent.id, targets, AAR.renderAppliedReason(reason))
	}
	await notifyAdminsOfWebAction(ctx, appEvent)
}

// records a forced team change as an app event and arms attribution for the resulting PLAYER_CHANGED_TEAM server
// events (which arrive via the next teams poll). The caller (teamswaps) still issues the actual switch. Returns the
// event so a re-fire of the same switch can attribute to it rather than logging itself a second time.
export async function forceTeamChangeAppEvent(
	ctx: SQS.Ctx & C.Db & MH.Ctx & CS.AbortSignal,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
) {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.TeamChangeForced>({
		type: 'TEAM_CHANGE_FORCED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		targets,
	})
	await emitAppEvent(ctx, appEvent)
	await armTeamChangeAttribution(ctx, targets, appEvent.id)
	return appEvent
}

// arms attribution for the PLAYER_CHANGED_TEAM events a forced switch produces, against an app event that already
// records that switch. A queue execution logs itself as a TEAMSWAPS_UPDATED, so a TEAM_CHANGE_FORCED alongside it
// would say the same thing twice.
export async function armTeamChangeAttribution(
	ctx: SQS.Ctx & C.Db & CS.AbortSignal,
	targets: SM.PlayerId[],
	causeId: AppEvents.AppEventId,
) {
	if (targets.length === 0) return
	const source = { type: 'event' as const, id: causeId }
	await collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.armExpectation(ctx.server.eventState, { type: 'PLAYER_CHANGED_TEAM', playerId: target }, source)
		}
	})
}

// records a kill as an app event and arms attribution for any resulting PLAYER_CHANGED_TEAM server events. The
// double switch nets zero, so a settled teams poll usually emits none; arming keeps parity with the forced-switch
// path in case a poll observes an intermediate state.
export async function killPlayersAppEvent(
	ctx: SQS.Ctx & C.Db & MH.Ctx & CS.AbortSignal,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
	reason?: string,
	reasonLabel?: string,
): Promise<AppEvents.PlayerKilled | undefined> {
	if (targets.length === 0) return
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.PlayerKilled>({
		type: 'PLAYER_KILLED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		targets,
		reason,
		reasonLabel,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await collectEvents(ctx, () => {
		for (const target of targets) {
			PendingEvents.armExpectation(ctx.server.eventState, { type: 'PLAYER_CHANGED_TEAM', playerId: target }, source)
		}
	})
	return appEvent
}

export async function killPlayersAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & SETTINGS.Ctx & CS.AbortSignal & Msgs.Ctx,
	targets: SM.PlayerId[],
	actor: AppEvents.Actor,
	reason?: string,
	reasonLabel?: string,
) {
	if (targets.length === 0) return
	const appEvent = await killPlayersAppEvent(ctx, targets, actor, reason, reasonLabel)
	await SquadRcon.killPlayers(ctx, targets, reason)
	if (appEvent) await notifyAdminsOfWebAction(ctx, appEvent)
}

export async function renameSquadAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal,
	teamId: SM.TeamId,
	squadId: SM.SquadId,
	actor: AppEvents.Actor,
) {
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const renameTeams = getCurrTeams(ctx)
	const squad = renameTeams && SM.findSquadForPlayer(renameTeams.squads, { squadId, teamId })
	const appEvent = AppEvents.create<AppEvents.SquadRenamed>({
		type: 'SQUAD_RENAMED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		teamId,
		squadId,
		squadName: squad?.squadName ?? `Squad ${squadId}`,
	})
	await emitAppEvent(ctx, appEvent)
	const source = { type: 'event' as const, id: appEvent.id }
	await collectEvents(ctx, () => {
		PendingEvents.armExpectation(ctx.server.eventState, { type: 'SQUAD_RENAMED', teamId, squadId }, source)
	})
	await SquadRcon.adminRenameSquad(ctx, teamId, squadId)
}

// demoting a commander has no attributable server event, so this is a pure audit-feed entry
export async function demoteCommanderAction(
	ctx: SQS.Ctx & SR.Ctx.Rcon & C.Db & MH.Ctx & CS.AbortSignal & Msgs.Ctx,
	playerId: SM.PlayerId,
	actor: AppEvents.Actor,
	reason?: AAR.AppliedReason,
) {
	const currentMatch = await MatchHistory.getCurrentMatch(ctx)
	const appEvent = AppEvents.create<AppEvents.CommanderDemoted>({
		type: 'COMMANDER_DEMOTED',
		actor,
		serverId: ctx.serverId,
		matchId: currentMatch.historyEntryId,
		causeId: null,
		target: playerId,
		reason,
	})
	await emitAppEvent(ctx, appEvent)
	await SquadRcon.demoteCommander(ctx, playerId)
	if (reason) {
		await sendReasonFollowUpWarn(ctx, appEvent.id, [playerId], AAR.renderAppliedReason(reason))
	}
	await notifyAdminsOfWebAction(ctx, appEvent)
}

// Must be called with the server's lifecycle lock held (see withLifecycleLock) -- it is the unlocked primitive, and callers reach it
// through destroyIfRunningLocked. Taking the lock here instead would self-deadlock the callers that already hold it.
const destroyServer = Instr.spanOp('destroyServer', { module, levels: { event: 'info' } }, async (ctx: C.ManagedServer) => {
	if (ctx.server.destroyed) return
	log.info(`destroying managed server ${ctx.serverId}`)
	ctx.server.destroyed = true
	abortControllers.get(ctx.serverId)?.abort(new DOMException('managed server destroyed', 'AbortError'))
	abortControllers.delete(ctx.serverId)
	const cleanupId = ctx.server.cleanupId
	if (cleanupId !== null) CleanupSys.unregister(cleanupId)
	await Cleanup.runCleanup({ ...CS.init(), ...ctx, log }, ctx.cleanup)
	globalState.managedServers.delete(ctx.serverId)
	globalState.lifecycleUpdate$.next(ctx.serverId)
})

export async function getFullServerState(ctx: C.Db & LQ.Ctx) {
	const query = ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, ctx.serverId))
	const [serverRaw] = await query
	return Settings.parseServerStateRow(serverRaw)
}

export function getCurrTeams(ctx: SQS.Ctx) {
	return ctx.server.eventState.currTeams
}

// maps a GUI/chat user id (or an automated marker) to an app-event actor, resolving in-game (steam) senders against
// the current teams. Shared by the vote/teamswap attribution paths.
export function actorFromUser(ctx: SQS.Ctx, source: USR.GuiOrChatUserId | 'autostart' | undefined | null): AppEvents.Actor {
	if (!source || source === 'autostart') return { type: 'system' }
	if (source.discordId) return { type: 'slm-user', userId: source.discordId }
	if (source.steamId) {
		// by steam id, which the roster is not keyed on -- one of the few lookups that still has to scan
		const player = SM.PlayerIds.find([...(getCurrTeams(ctx)?.players.values() ?? [])], (p) => p.ids, { steam: source.steamId })
		if (player) return { type: 'ingame-user', playerId: SM.PlayerIds.getPlayerId(player.ids) }
	}
	return { type: 'system' }
}

async function collectEvents(ctx: SQS.Ctx & C.Db & CS.AbortSignal, addEventsCb: () => void) {
	using _lock = await Prom.acquireInBlock(ctx.server.processEventsMtx, { signal: ctx.signal })
	addEventsCb()
	for await (const event of PendingEvents.process(ctx.server.eventState, Date.now())) {
		// the single funnel for every server event, whatever produced it
		serverEventCounter.add(1, {
			[ATTRS.SquadServer.ID]: ctx.serverId,
			[ATTRS.ServerEvent.TYPE]: event.type,
		})
		ctx.server.event$.emit(event)
	}
}

// resolves a default server id for a request given the route and a previously stored default server id
export function manageDefaultServerIdForRequest<Ctx extends C.HttpRequest>(ctx: Ctx) {
	const servers = Settings.listServerEntries()
		// scoped servers are entered explicitly (a tutorial), never resolved as somebody's default server, so they must
		// not be picked here or persisted into the default-server cookie via the /servers/:id sync below.
		.filter((s) => s.enabled && globalState.managedServers.has(s.id) && s.visibility !== 'scoped')
		.toSorted((a, b) => {
			if (a.defaultServer !== b.defaultServer) return a.defaultServer ? -1 : 1
			return 0
		})

	const res = ctx.res

	if (servers.length === 0) {
		// Clear any stale server cookie so the client doesn't try to connect to a disabled server
		if (ctx.cookies['default-server-id']) {
			res.clearCookie(AR.COOKIE_KEY.enum['default-server-id'], AR.COOKIE_DEFAULTS)
		}
		return { ...ctx, res }
	}

	const defaultServerId = ctx.cookies['default-server-id']
	let serverId: string
	if (ctx.route?.id === AR.route('/servers/:id') && servers.some((s) => s.id === ctx.route!.params.id)) {
		// keep the default in sync with the server being viewed -- but only when it's a real server. An invalid id (e.g.
		// /servers/undefined) still renders a client-side 404, we just must not persist it as the default server.
		serverId = ctx.route.params.id
	} else if (defaultServerId && servers.some((s) => s.id === defaultServerId)) {
		serverId = defaultServerId
	} else {
		serverId = servers[0].id
	}

	if (serverId !== defaultServerId) {
		res.cookie(AR.COOKIE_KEY.enum['default-server-id'], serverId, {
			...AR.COOKIE_DEFAULTS,
			httpOnly: false,
		})
	}

	return {
		...ctx,
		res,
	}
}

function withSignal<T extends object>(ctx: T, managedServer: C.ManagedServer) {
	// cancel when either the caller (e.g. the originating request) or the managed server is done. the managed server signal
	// already covers process shutdown, so don't allocate a composite for base ctxs on the hot event path
	const callerSignal = (ctx as Partial<CS.AbortSignal>).signal
	const signal = callerSignal === CleanupSys.shutdownSignal ? managedServer.signal : Prom.anySignal(callerSignal, managedServer.signal)!
	return {
		...ctx,
		...managedServer,
		signal,
	}
}

// throws when the managed server is missing. Only for callers running inside the managed server's own lifecycle (setup loops, timers,
// event handlers), where a missing managed server is a bug rather than a state the caller has to render. oRPC handlers should
// use tryCtx / stream$ instead, so the client gets a code it can act on.
/** the live managed server, for the rare caller that needs one field off it rather than a ctx */
export function require(serverId: string): C.ManagedServer {
	const managedServer = globalState.managedServers.get(serverId)
	if (!managedServer) throw new Error('Managed server not found: ' + serverId)
	return managedServer
}

/**
 * The managed server ctx for an event handler, rebuilt at handle time from the serverId the event carries.
 * The emitter used to ship its whole ctx on the stream, which made the SQS.Ctx.Payload payload reference
 * C.ManagedServer and so pinned it to the server layer.
 */
export function eventCtx(evtCtx: CS.Otel & CS.ServerId, signal: AbortSignal) {
	return { ...resolveCtx({ ...getBaseCtx(), ...evtCtx }, evtCtx.serverId), signal }
}

export function resolveCtx<T extends object>(ctx: T, serverId: string) {
	const managedServer = globalState.managedServers.get(serverId)
	if (!managedServer) {
		throw new Orpc.ORPCError('BAD_REQUEST', {
			message: 'Managed server not found: ' + serverId,
		})
	}
	return withSignal(ctx, managedServer)
}

// Resolving a managed server for a request is also where the request is authorized to look at that server at all: every
// per-server endpoint goes through here, so squad-server:view is enforced once rather than per handler. Action
// permissions are still checked by the handler on top of this.
export async function tryCtx<T extends C.Db & USR.Ctx.Id & CS.AbortSignal>(
	ctx: T,
	serverId: string,
): Promise<{ code: 'ok'; ctx: ReturnType<typeof withSignal<T>> } | SM.ServerNotLoaded | RBAC.PermissionDeniedResponse> {
	const managedServer = globalState.managedServers.get(serverId)
	if (!managedServer) return SM.serverNotLoaded(serverId)
	if (!(await Rbac.canViewServerForUser(ctx, serverId))) {
		return RBAC.permissionDenied('all', [`squad-server:view on ${serverId}`])
	}
	return { code: 'ok', ctx: withSignal(ctx, managedServer) }
}

// like selectedServerCtx$, but keyed by an explicit serverId instead of a wsClientId's session selection
// A server the session may not view resolves to null, exactly as one with no live managed server does, so every per-server
// stream reports it as not loaded. Deliberate: to a user without squad-server:view the server is indistinguishable
// from one that isn't running, which is also what listLoadedServerIds tells them, so the two agree.
export function ctx$(wsClientId: string, serverId: string) {
	return globalState.lifecycleUpdate$.pipe(
		Rx.filter((id) => id === serverId),
		Rx.startWith(serverId),
		Rx.switchMap(async () => {
			const managedServer = globalState.managedServers.get(serverId)
			if (!managedServer) return null
			const session = WsSessionSys.wsSessions.get(wsClientId)!
			const ctx = { ...getBaseCtx(), ...session, ...managedServer }
			if (!(await Rbac.canViewServerForUser(ctx, serverId))) return null
			return ctx
		}),
	)
}

export type ManagedServerCtx = NonNullable<Rx.ObservedValueOf<ReturnType<typeof ctx$>>>

// the only way an oRPC stream should resolve a managed server. While the managed server is absent the stream emits err:server-not-loaded
// rather than going silent (a silent stream leaves the client suspended forever), and it switches over to the real
// source as soon as the managed server appears -- so a server being enabled, or coming back after a crash, self-heals.
export function stream$<T>(
	wsClientId: string,
	serverId: string,
	project: (ctx: ManagedServerCtx) => Rx.Observable<T>,
): Rx.Observable<T | SM.ServerNotLoaded> {
	return ctx$(wsClientId, serverId).pipe(
		Rx.switchMap((ctx): Rx.Observable<T | SM.ServerNotLoaded> => {
			if (!ctx) return Rx.of(SM.serverNotLoaded(serverId))
			return project(ctx)
		}),
	)
}

function getBaseCtx() {
	return DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal })
}

// registry data (identity/enabled/default/broken) lives in settings.server.ts; this only orchestrates the live managed server around it
export async function enableServer(serverId: string) {
	const ctx = getBaseCtx()
	const res = await Settings.setServerEnabled(ctx, serverId, true)
	if (res.code !== 'ok') return res
	await ensureRunning(serverId)
	log.info('Server %s enabled', serverId)
	return { code: 'ok' as const }
}

export async function disableServer(serverId: string) {
	const ctx = getBaseCtx()
	const res = await Settings.setServerEnabled(ctx, serverId, false)
	if (res.code !== 'ok') return res

	await withLifecycleLock(serverId, () => destroyIfRunningLocked(serverId))
	// the emulator deliberately outlives a managed server restart, but not the server being switched off
	Sandbox.disposeInstance(serverId)
	log.info('Server %s disabled', serverId)
	return { code: 'ok' as const }
}

export async function deleteServer(serverId: string) {
	const ctx = getBaseCtx()
	await withLifecycleLock(serverId, () => destroyIfRunningLocked(serverId))
	Sandbox.disposeInstance(serverId)
	return await Settings.deleteServerEntry(ctx, serverId)
}

export async function getServerState(ctx: C.Db & CS.ServerId) {
	const query = ctx.db().select().from(Schema.servers).where(E.eq(Schema.servers.id, ctx.serverId))
	const [serverRaw] = await query
	return Settings.parseServerStateRow(serverRaw)
}

// settings changes go through Settings.updateServerSettings instead — that's the one source of truth for reading/writing/broadcasting settings
export async function updateServerState(
	ctx: C.Db & C.Tx & LQ.Ctx,
	changes: Partial<Omit<SS.ServerState, 'settings'>>,
	source: SS.LQStateUpdate['source'],
) {
	const serverState = await getServerState(ctx)
	const newServerState = { ...serverState, ...changes }
	await ctx.db().update(Schema.servers).set(superjsonify(Schema.servers, changes)).where(E.eq(Schema.servers.id, ctx.serverId))
	const update: SS.LQStateUpdate = { state: newServerState, source }

	ctx.tx.unlockTasks.push(() => ctx.layerQueue.update$.next(update))
	return newServerState
}

const loadSavedEvents = Instr.spanOp('loadSavedEvents', { module }, async (ctx: SQS.Ctx & C.Db) => {
	const server = ctx.server
	const [lastMatch] = await ctx
		.db()
		.select({ id: Schema.matchHistory.id })
		.from(Schema.matchHistory)
		.where(E.eq(Schema.matchHistory.serverId, ctx.serverId))
		.orderBy(E.desc(Schema.matchHistory.ordinal))
		.limit(1)

	const rowsRaw = lastMatch
		? await ctx
				.db()
				.select({ event: Schema.serverEvents })
				.from(Schema.serverEvents)
				.where(E.eq(Schema.serverEvents.matchId, lastMatch.id))
				.orderBy(E.asc(Schema.serverEvents.id))
		: []
	server.emittedEvents = SE.fromEventRows(
		{ ...ctx, log },
		rowsRaw.map((r) => r.event),
	)

	const appEventRows = lastMatch
		? await ctx
				.db()
				.select()
				.from(Schema.appEvents)
				.where(E.eq(Schema.appEvents.matchId, lastMatch.id))
				.orderBy(E.asc(Schema.appEvents.time))
		: []
	// this buffer is the feed, so it has to hold what the live path would have pushed -- not every row the audit
	// log kept. Without the isFeedVisible filter an audit-only event (a queue-driven MAP_SET) reappears as its own
	// feed entry after a restart, duplicating the QUEUE_UPDATED it was folded into.
	server.emittedAppEvents = appEventRows
		.map((r) => AppEvents.fromRow(r))
		.filter((e): e is AppEvents.AppEvent => e !== null && AppEvents.isFeedVisible(e))
})

// an index entry before its weapon name has been resolved to a weapons row, which needs the db
type PendingIndexRow = Omit<SchemaModels.NewPlayerEventIndexEntry, 'damageSourceId'> & { damageSource: string | null }

// the rows that hang off an event, and so can only be built once the insert has allocated its id
type EventAssociationRows = {
	playerRows: SchemaModels.NewPlayer[]
	playerIndexRows: PendingIndexRow[]
	squadRows: SchemaModels.NewSquad[]
	squadAssociationRows: SchemaModels.NewSquadEventAssociation[]
	chatSearchRow?: { message: string; serverEventId: number; playerId: string; matchId: number; serverId: string; time: number }
}

function buildEventRow(event: SE.NewEvent): SchemaModels.NewServerEvent {
	const persisted = Obj.omit(event, ['type', 'time', 'matchId'])
	// queryable projection of source when it links to an app event
	const source = (event as { source?: { type: string; id?: string } }).source
	return {
		type: event.type,
		time: new Date(event.time),
		matchId: event.matchId,
		appEventId: source?.type === 'event' ? source.id! : null,
		data: superjson.serialize(persisted),
	}
}

function buildAssociationRows(ctx: CS.Log, serverId: string, event: SE.Event): EventAssociationRows {
	const playerRows: SchemaModels.NewPlayer[] = []
	const playerIndexRows: PendingIndexRow[] = []
	for (const [player, assocType] of SE.iterAssocPlayers(event)) {
		let playerId: SM.PlayerId
		if (typeof player === 'object') {
			playerRows.push({
				steamId: player.ids.steam ? BigInt(player.ids.steam) : null,
				eosId: player.ids.eos,
				username: player.ids.username,
				epicId: player.ids.epic,
			})
			playerId = SM.PlayerIds.getPlayerId(player.ids)
		} else {
			playerId = player
		}
		playerIndexRows.push({
			playerId,
			time: new Date(event.time),
			serverEventId: event.id,
			assocType,
			matchId: event.matchId,
			serverId,
			type: event.type,
			// the event model calls this `weapon` because the log line does; see the damageSourceId comment in
			// the schema for why the projection does not. Resolved to a damageSources row by insertAssociationRows.
			damageSource: 'weapon' in event ? event.weapon : null,
			variant: 'variant' in event ? event.variant : null,
		})
	}

	const squadRows: SchemaModels.NewSquad[] = []
	const squadAssociationRows: SchemaModels.NewSquadEventAssociation[] = []
	for (const squad of SE.iterAssocUniqueSquads(ctx, event)) {
		let uniqueSquadId: number
		if (typeof squad === 'object') {
			squadRows.push({
				id: squad.uniqueId,
				ingameSquadId: squad.squadId,
				name: squad.squadName,
				creatorId: squad.creator,
				teamId: squad.teamId,
				matchId: event.matchId,
			})
			uniqueSquadId = squad.uniqueId
		} else {
			uniqueSquadId = squad
		}
		squadAssociationRows.push({ squadId: uniqueSquadId, serverEventId: event.id })
	}

	const chatSearchRow =
		event.type === 'CHAT_MESSAGE'
			? {
					message: event.message,
					serverEventId: event.id,
					playerId: event.player,
					matchId: event.matchId,
					serverId,
					time: event.time,
				}
			: undefined

	return { playerRows, playerIndexRows, squadRows, squadAssociationRows, chatSearchRow }
}

// blueprint name -> damageSources.id. Process-wide and never invalidated: the table is append-only and an id
// is never reused, so a name seen once is correct for the life of the process. An install sees a couple of
// thousand distinct names, so this settles quickly and takes the lookup off the per-kill path.
const damageSourceIdCache = new Map<string, number>()

async function internDamageSources(ctx: C.Db, names: (string | null)[]): Promise<Map<string, number>> {
	const wanted = new Set(names.filter((n): n is string => n !== null && !damageSourceIdCache.has(n)))
	if (wanted.size > 0) {
		// returning() rather than a separate select: on conflict the row already exists but returns nothing,
		// so the select afterwards covers both the rows this inserted and the ones it raced with
		await ctx
			.db()
			.insert(Schema.damageSources)
			.values([...wanted].map((name) => ({ name })))
			.onConflictDoNothing({ target: Schema.damageSources.name })
		const rows = await ctx
			.db()
			.select()
			.from(Schema.damageSources)
			.where(E.inArray(Schema.damageSources.name, [...wanted]))
		for (const row of rows) damageSourceIdCache.set(row.name, row.id)
	}
	return damageSourceIdCache
}

async function insertAssociationRows(ctx: C.Db, rows: EventAssociationRows) {
	if (rows.playerRows.length > 0) {
		await ctx
			.db()
			.insert(Schema.players)
			.values(rows.playerRows)
			.onConflictDoUpdate({
				target: Schema.players.eosId,
				set: {
					steamId: sql`excluded.steamId`,
					username: sql`excluded.username`,
					modifiedAt: new Date(),
				},
			})
	}

	if (rows.playerIndexRows.length > 0) {
		const insertedEosIds = new Set(rows.playerRows.map((p) => p.eosId))
		const playersToLookup = [...new Set(rows.playerIndexRows.map((r) => r.playerId).filter((id) => !insertedEosIds.has(id)))]
		let existingIds = new Set<SM.PlayerId>()
		if (playersToLookup.length > 0) {
			const existingPlayers = await ctx
				.db()
				.select({ eosId: Schema.players.eosId })
				.from(Schema.players)
				.where(E.inArray(Schema.players.eosId, playersToLookup))
			existingIds = new Set(existingPlayers.map((p) => p.eosId))
		}
		const validRows = rows.playerIndexRows.filter((r) => {
			if (insertedEosIds.has(r.playerId)) return true
			if (existingIds.has(r.playerId)) return true
			log.error('skipping playerEventIndex entry for unknown player %s (event %d)', r.playerId, r.serverEventId)
			return false
		})
		if (validRows.length > 0) {
			const sourceIds = await internDamageSources(
				ctx,
				validRows.map((r) => r.damageSource),
			)
			await ctx
				.db()
				.insert(Schema.playerEventIndex)
				.values(
					validRows.map(({ damageSource, ...row }) => ({
						...row,
						damageSourceId: damageSource === null ? null : sourceIds.get(damageSource)!,
					})),
				)
				.onConflictDoNothing({
					target: [
						Schema.playerEventIndex.playerId,
						Schema.playerEventIndex.time,
						Schema.playerEventIndex.serverEventId,
						Schema.playerEventIndex.assocType,
					],
				})
		}
	}

	if (rows.squadRows.length > 0) {
		// creatorId references players.eosId, but the creator may have left before we ever persisted them (e.g. a
		// squad snapshotted or synthesized from a poll). Null the reference out rather than failing the whole event.
		const insertedEosIds = new Set(rows.playerRows.map((p) => p.eosId))
		const creatorsToLookup = [
			...new Set(rows.squadRows.map((s) => s.creatorId).filter((id): id is string => !!id && !insertedEosIds.has(id))),
		]
		let knownCreatorIds = new Set<string>()
		if (creatorsToLookup.length > 0) {
			const existingPlayers = await ctx
				.db()
				.select({ eosId: Schema.players.eosId })
				.from(Schema.players)
				.where(E.inArray(Schema.players.eosId, creatorsToLookup))
			knownCreatorIds = new Set(existingPlayers.map((p) => p.eosId))
		}
		const squadRows = rows.squadRows.map((s) => {
			if (!s.creatorId || insertedEosIds.has(s.creatorId) || knownCreatorIds.has(s.creatorId)) return s
			log.warn({ squadId: s.id, creatorId: s.creatorId }, 'squad creator not in players table; inserting with null creatorId')
			return { ...s, creatorId: null }
		})
		await ctx
			.db()
			.insert(Schema.squads)
			.values(squadRows)
			.onConflictDoUpdate({
				target: Schema.squads.id,
				set: {
					ingameSquadId: sql`excluded.ingameSquadId`,
					teamId: sql`excluded.teamId`,
					name: sql`excluded.name`,
					creatorId: sql`excluded.creatorId`,
					matchId: sql`excluded.matchId`,
				},
			})
	}

	// chat text goes into the standalone fts index at insert time, so it survives the compaction that
	// deletes the event it came from. Raw sql because fts5 is a virtual table drizzle cannot model; not
	// awaited because run() on the better-sqlite3 driver executes synchronously and returns no thenable.
	if (rows.chatSearchRow) {
		const r = rows.chatSearchRow
		ctx.db().run(
			sql`INSERT INTO chatSearch (message, serverEventId, playerId, matchId, serverId, time) VALUES (${r.message}, ${r.serverEventId}, ${r.playerId}, ${r.matchId}, ${r.serverId}, ${r.time})`,
		)
	}

	if (rows.squadAssociationRows.length > 0) {
		await ctx
			.db()
			.insert(Schema.squadEventAssociations)
			.values(rows.squadAssociationRows)
			.onConflictDoNothing({
				target: [Schema.squadEventAssociations.serverEventId, Schema.squadEventAssociations.squadId],
			})
	}
}

// Persists a single event and returns it with the id the insert allocated -- the createEvent hook every event
// PendingEvents emits goes through. serverEvents.id is autoincrement, so the db, not the app, hands out ids and
// they can't drift from what's on disk.
//
// One transaction per event: a statement that throws (a constraint violation, a bad steamId, an unknown-player
// FK) rolls back only this event, and the throw propagates so the caller never emits an event we failed to
// record. PendingEvents.process() logs it and moves on to the next pending event.
const createEvent =
	(serverId: string): PendingEvents.State['hooks']['createEvent'] =>
	async (newEvent) => {
		const ctx = resolveCtx(getBaseCtx(), serverId)
		return Instr.spanOp(
			'createEvent',
			{ module },
			async () =>
				await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
					const [inserted] = await ctx
						.db()
						.insert(Schema.serverEvents)
						.values(buildEventRow(newEvent))
						.returning({ id: Schema.serverEvents.id })
					const event = { ...newEvent, id: inserted.id } as SE.Event
					await insertAssociationRows(ctx, buildAssociationRows({ ...ctx, log }, serverId, event))
					return event
				}),
		)()
	}

const onNewGameDuringSync =
	(serverId: string): PendingEvents.State['hooks']['onNewGameDuringSync'] =>
	async (currentLayerId, _time) => {
		const ctx = resolveCtx(getBaseCtx(), serverId)
		return Instr.spanOp(
			'onNewGameDuringSync',
			{
				module,
				// both, in the same order onNewGameDuringRoll takes them: the queue reconciliation below dispatches an
				// op, and taking updateLayerMtx after matchHistory.mtx in one place and before it in another deadlocks
				mutexes: () => [ctx.matchHistory.mtx, ctx.layerQueue.updateLayerMtx],
				levels: { event: 'info' },
			},
			async () => {
				const { currentMatch, pushedNewMatch } = await MatchHistory.syncWithCurrentLayer(ctx, currentLayerId)
				// We've just found the server on a layer we had no record of, so a roll happened while SLM wasn't
				// watching, and it consumed whatever SLM had set as next. The roll path shifts the queue when the head
				// is what started playing; this path never did, so a head that was already played stayed at the head
				// and went up as next a second time.
				//
				// Only once SLM has history for this server, though. On the first match it records there is no roll it
				// could have missed: the server is simply already running, and a head that happens to name the layer
				// it is running is a request to play that layer next, not evidence it has been played.
				//
				// Exact equality rather than compatibility: dropping someone's queued item is not recoverable, so a
				// head that merely could be what is playing stays put.
				if (pushedNewMatch && currentMatch.ordinal > 0) {
					const head = LayerQueue.getSavedQueue(ctx)[0]
					if (head?.layerId && L.layersEqual(head.layerId, currentLayerId)) {
						log.info('queue head %s is already playing; consuming it rather than queueing it again', head.layerId)
						await LayerQueue.dispatchOp(ctx, { op: 'shift-first-saved-layer', opId: SLL.createOpId() })
					}
				}
				return { match: currentMatch, isNewMatch: pushedNewMatch }
			},
		)()
	}

const onNewGameDuringRoll =
	(serverId: string): PendingEvents.State['hooks']['onNewGameDuringRoll'] =>
	async (newLayerId, time) => {
		const ctx = resolveCtx(getBaseCtx(), serverId)
		return Instr.spanOp(
			'onNewGameDuringRoll',
			{
				module,
				mutexes: () => [ctx.matchHistory.mtx, ctx.layerQueue.updateLayerMtx],
				levels: { event: 'info' },
			},
			async () => {
				ctx.server.serverRolling$.next(Date.now())
				try {
					const { match } = await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
						const nextLqItem = LayerQueue.getSavedQueue(ctx)[0]

						// A vote was running, so it picked this layer and the queue did not: SLM stood down when the vote
						// started and never set the head as next. Attributing the match to the head would also consume it
						// for a layer it had no part in choosing.
						const pickedByIngameVote = ctx.layerQueue.ingameVote$.getValue() !== null

						let currentMatchLqItem: LL.Item | undefined
						if (!pickedByIngameVote && nextLqItem && L.areLayersCompatible(nextLqItem.layerId, newLayerId)) {
							currentMatchLqItem = nextLqItem
						}
						// the new match must be recorded before the queue shift: emptying the queue triggers generation,
						// whose do-not-repeat lookback must see the layer that just started playing
						const { match } = await MatchHistory.addNewCurrentMatch(
							ctx,
							MH.getNewMatchHistoryEntry({
								layerId: newLayerId,
								serverId: ctx.serverId,
								startTime: new Date(time),
								lqItem: currentMatchLqItem,
								source: pickedByIngameVote ? { type: 'ingame-vote' } : undefined,
							}),
						)
						if (currentMatchLqItem) {
							await LayerQueue.dispatchOp(ctx, { op: 'shift-first-saved-layer', opId: SLL.createOpId() })
						}
						LayerQueue.schedulePostRollTasks(ctx, match.layerId)
						return { match }
					})
					// after the transaction, not inside it: emptying the queue defers generation to the transaction's
					// unlockTasks, which runTransaction awaits before resolving. Read any earlier and the queue is still
					// empty. The rolling flag likewise stays up until generation has landed.
					const nextLayerId = LL.getNextLayerId(LayerQueue.getSavedQueue(ctx))
					return { match, nextLayerId }
				} finally {
					ctx.server.serverRolling$.next(null)
				}
			},
		)()
	}

export async function waitForSynced(ctx: SQS.Ctx & CS.AbortSignal) {
	if (ctx.server.eventState.syncState.type === 'synced') return
	await Rx.Ext.firstValueFrom(
		ctx.server.event$.pipe(Rx.filter(([ctx, event]) => event.type === 'NEW_GAME' || event.type === 'RESET')),
		ctx.signal,
	)
}
