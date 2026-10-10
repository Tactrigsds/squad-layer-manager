// The squadServer oRPC router: the procedures the web client calls against a managed server.

import * as Arr from '@/lib/array-utils'
import * as Rx from '@/lib/rxjs'
import { z } from '@/lib/zod'
import * as SS_Msgs from '@/messages/server-state.messages'
import * as AAR from '@/models/admin-action-reasons.models'
import * as AppEvents from '@/models/app-events.models'
import * as CHAT from '@/models/chat.models.ts'
import type * as CS from '@/models/context-shared.models'
import * as L from '@/models/layer.models'
import * as MH from '@/models/match-history.models'
import type * as SE from '@/models/server-events.models'
import type * as SR from '@/models/squad-rcon.models'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AdminList from '@/systems/adminlist.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as Sandbox from '@/systems/sandbox.server'
import * as SquadBrowser from '@/systems/squad-browser.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServerActions from '@/systems/squad-server-actions.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Steam from '@/systems/steam.server'
import * as Users from '@/systems/users.server'

const module = initModule('squad-server')

const orpcBase = getOrpcBase(module)

const LIVE_FEED_BATCH_MS = 50

export const orpcRouter = {
	// The admin-list group names known to any running server, for the player-groupings editor to offer. Player groupings are
	// global config while an admin list is per-server, so this is the union across servers rather than one server's list: a
	// grouping naming a group only some servers define simply matches nobody on the others.
	listAdminListGroups: orpcBase.handler(async () => {
		const baseCtx = SquadServer.getBaseCtx()
		const names = new Set<string>()
		for (const managedServer of SquadServer.globalState.managedServers.values()) {
			try {
				const adminLists = await AdminList.getListsForServerId({ ...baseCtx, ...managedServer }, managedServer.serverId)
				SM.AdminList.collectGroupNames(adminLists, names)
			} catch (err) {
				// one unreachable admin list must not deny the editor every other server's groups
				SquadServer.log.warn(err, 'Failed to read an admin list while listing groups')
			}
		}
		return [...names].sort()
	}),

	// which servers currently have a live managed server. This is runtime state, not registry config: a server can be enabled and
	// non-broken yet have no managed server (still booting, or torn down by a fatal resource error), and everything served per-server
	// needs one. The client gates the dashboard on this so it renders "unavailable" instead of hanging on silent streams.
	watchLoadedServers: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ context, signal }) {
		const obs = Rx.merge(SquadServer.globalState.lifecycleUpdate$, Rbac.userInvalidation$(context.user.discordId)).pipe(
			Rx.startWith(null),
			// servers the session may not view are omitted rather than listed-but-unusable
			Rx.switchMap(async () => {
				const canAccess = await Rbac.getUserAccessCheck(context)
				return [...SquadServer.globalState.managedServers.keys()].filter((serverId) => canAccess(RBAC.Req.viewServer(serverId)))
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
			const obs = SquadServer.stream$(context.wsClientId, input.serverId, () =>
				sharedForServer(input.serverId, 'layersStatus', (serverCtx) => {
					const read = async (): Promise<SM.LayersStatusResExt> => {
						const currentMatch = await MatchHistory.getCurrentMatch(serverCtx)
						const statusRes = await serverCtx.squadRcon.layersStatus.get(serverCtx)
						return {
							code: 'ok',
							data: {
								currentLayer: currentMatch ? L.toLayer(currentMatch.layerId) : null,
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
				}),
			).pipe(Rx.Ext.withAbortSignal(signal!))
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	watchServerRolling: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, signal, input }) {
			const obs = SquadServer.stream$(context.wsClientId, input.serverId, (ctx) => ctx.server.serverRolling$).pipe(
				Rx.Ext.withAbortSignal(signal!),
			)
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	watchTickRate: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, signal, input }) {
			const obs = SquadServer.stream$(context.wsClientId, input.serverId, (ctx) =>
				ctx.server.tickRate$.pipe(Rx.Ext.distinctDeepEquals()),
			).pipe(Rx.Ext.withAbortSignal(signal!))
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	watchServerInfo: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, signal, input }) {
			const obs = SquadServer.stream$(context.wsClientId, input.serverId, () =>
				sharedForServer(input.serverId, 'serverInfo', (ctx) => ctx.squadRcon.serverInfo.observe(ctx).pipe(Rx.Ext.distinctDeepEquals())),
			).pipe(Rx.Ext.withAbortSignal(signal!))
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	endMatch: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			return await SquadServerActions.endMatchAction(ctx, { type: 'slm-user', userId: ctx.user.discordId })
		}),

	watchChatEvents: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ lastEventId: z.number().optional(), serverId: z.string() }))
		.handler(async function* ({ context, signal, input }) {
			const obs = SquadServer.stream$(context.wsClientId, input.serverId, (ctx) => {
				async function getInitialEvents() {
					const sync: CHAT.SyncedEvent = {
						type: 'SYNCED' as const,
						time: Date.now(),
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

				// one frame per burst rather than per event: a burst of hundreds of events otherwise costs every client a
				// timer and a frame each
				const upcoming$ = Rx.merge(
					ctx.server.event$.pipe(Rx.map(([_, e]): SE.Event | CHAT.AppFeedEvent => e)),
					ctx.server.appEvent$.pipe(Rx.map(([_, appEvent]): SE.Event | CHAT.AppFeedEvent => ({ type: 'APP_EVENT', appEvent }))),
				).pipe(Rx.Ext.bufferBurst(LIVE_FEED_BATCH_MS))

				return Rx.concat(initial$, upcoming$).pipe(
					// orpc will break without this
					Rx.observeOn(Rx.asyncScheduler),
				)
			}).pipe(
				Rx.tap({
					error: (err) => {
						SquadServer.log.error(err, 'Error in watchChatEvents')
					},
				}),
				Rx.Ext.withAbortSignal(signal!),
			)
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	toggleFogOfWar: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), disabled: z.boolean() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const serverStatusRes = await ctx.squadRcon.layersStatus.get(ctx)
			if (serverStatusRes.code !== 'ok') return serverStatusRes
			await SquadRcon.setFogOfWar(ctx, input.disabled ? 'off' : 'on')
			await SquadServerActions.emitAppEvent(
				ctx,
				AppEvents.create<AppEvents.FogOfWarToggled>({
					type: 'FOG_OF_WAR_TOGGLED',
					actor: { type: 'slm-user', userId: ctx.user.discordId },
					serverId: ctx.serverId,
					matchId: (await MatchHistory.getCurrentMatch(ctx))?.historyEntryId ?? null,
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
		const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
		if (ctxRes.code !== 'ok') return ctxRes
		const ctx = ctxRes.ctx
		// nothing to join: a sandbox is emulated in-process, and its players are made up
		if (Sandbox.getInstance(ctx.serverId)) return { code: 'err:disabled' as const }
		const serverInfoRes = await ctx.squadRcon.serverInfo.get(ctx)
		if (serverInfoRes.code !== 'ok') return serverInfoRes
		const currentMatch = await MatchHistory.getCurrentMatch(ctx)
		const browserRes = await SquadBrowser.getJoinLink(ctx, serverInfoRes.data.name, currentMatch?.historyEntryId ?? null)
		if (browserRes.code === 'ok') return browserRes

		const steamRes = await getSteamJoinLink(ctx)
		// wherever the browser was actually asked, its refusal names a condition an admin can act on ("not
		// listed", "try again in a minute") where steam's only says nobody happens to be sharing a lobby
		if (steamRes.code !== 'ok' && browserRes.code !== 'err:disabled') return browserRes
		return steamRes
	}),

	warnPlayers: orpcBase
		.meta({ type: 'mutation' })
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
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const reasonRes = SquadServerActions.resolveReasonInput(
				'warn',
				input,
				input.taggedSquad ? { squadName: input.taggedSquad.squadName } : undefined,
			)
			if (reasonRes.code !== 'ok') return reasonRes
			// the input refine guarantees a reason was provided; narrow without asserting
			if (!reasonRes.applied) return { code: 'err:reason-required' as const, msg: 'A reason is required to warn.' }
			const tagged = AAR.renderAppliedReason(reasonRes.applied, {
				audienceTag: await SquadServerActions.resolveWarnAudienceTag(ctx, input.playerIds, input.taggedSquad),
			})
			// the sender's name leads the whole thing, ahead of the audience tag: "grey275: @Alice ..."
			const message = input.prefixSenderName ? `${await Users.resolveDisplayName(ctx, ctx.user.discordId)}: ${tagged}` : tagged
			// squad warns name the squad + faction (e.g. "warned Squad1 (PLA): ...") in the admin notification, which
			// already attributes the actor, so it quotes the message without the sender prefix
			let adminNotifyDescription: string | undefined
			if (input.taggedSquad) {
				const currentMatch = await MatchHistory.getCurrentMatch(ctx)
				const squadLabel = SM.squadAdminLabel(
					input.taggedSquad,
					currentMatch && MH.getTeamFaction(currentMatch, input.taggedSquad.teamId),
				)
				adminNotifyDescription = `warned ${squadLabel}: ${tagged}`
			}
			await SquadServerActions.warnPlayers(
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

	warnAdmins: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), message: z.string().min(1) }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
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
			await SquadServerActions.warnPlayers(
				ctx,
				admins,
				input.message,
				{ type: 'slm-user', userId: ctx.user.discordId },
				{ notifyAdmins: false },
			)
			return { code: 'ok' as const }
		}),

	broadcast: orpcBase
		.meta({ type: 'mutation' })
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
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			let template = input.message
			let presetLabel: string | undefined
			if (input.presetReasonLabel) {
				const res = SquadServerActions.resolvePresetReason('broadcast', input.presetReasonLabel)
				if (res.code !== 'ok') return res
				template = AAR.reasonText('broadcast', res.reason)
				presetLabel = res.reason.label
			}
			// broadcastAction renders the template, so the sender prefix wraps the raw text and rides through with it
			if (input.prefixSenderName) template = `${await Users.resolveDisplayName(ctx, ctx.user.discordId)}: ${template!}`
			await SquadServerActions.broadcastAction(ctx, template!, { type: 'slm-user', userId: ctx.user.discordId }, { presetLabel })
			return { code: 'ok' as const }
		}),

	demoteCommander: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), playerId: SM.PlayerIdSchema, presetReasonLabel: z.string().min(1).optional() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const reasonRes = SquadServerActions.resolveReasonInput('demote-commander', input)
			if (reasonRes.code !== 'ok') return reasonRes
			await SquadServerActions.demoteCommanderAction(
				ctx,
				input.playerId,
				{ type: 'slm-user', userId: ctx.user.discordId },
				reasonRes.applied,
			)
			return { code: 'ok' as const }
		}),

	disbandSquad: orpcBase
		.meta({ type: 'mutation' })
		.input(
			z.object({
				serverId: z.string(),
				teamId: SM.TeamIdSchema,
				squadId: z.number().int().positive(),
				presetReasonLabel: z.string().min(1).optional(),
			}),
		)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const currTeams = SquadServer.getCurrTeams(ctx)
			const squad = currTeams && SM.findSquadForPlayer(currTeams.squads, { squadId: input.squadId, teamId: input.teamId })
			const reasonRes = SquadServerActions.resolveReasonInput('disband-squad', input, squad ? { squadName: squad.squadName } : undefined)
			if (reasonRes.code !== 'ok') return reasonRes
			await SquadServerActions.disbandSquadAction(
				ctx,
				input.teamId,
				input.squadId,
				{ type: 'slm-user', userId: ctx.user.discordId },
				reasonRes.applied,
			)
			return { code: 'ok' as const }
		}),

	removeFromSquad: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), playerId: SM.PlayerIdSchema, presetReasonLabel: z.string().min(1).optional() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const reasonRes = SquadServerActions.resolveReasonInput('remove-from-squad', input)
			if (reasonRes.code !== 'ok') return reasonRes
			await SquadServerActions.removePlayersFromSquad(
				ctx,
				[input.playerId],
				{ type: 'slm-user', userId: ctx.user.discordId },
				reasonRes.applied,
			)
			return { code: 'ok' as const }
		}),

	removePlayersFromSquad: orpcBase
		.meta({ type: 'mutation' })
		.input(
			z.object({
				serverId: z.string(),
				playerIds: z.array(SM.PlayerIdSchema).min(1),
				presetReasonLabel: z.string().min(1).optional(),
			}),
		)
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const reasonRes = SquadServerActions.resolveReasonInput('remove-from-squad', input)
			if (reasonRes.code !== 'ok') return reasonRes
			await SquadServerActions.removePlayersFromSquad(
				ctx,
				input.playerIds,
				{ type: 'slm-user', userId: ctx.user.discordId },
				reasonRes.applied,
			)
			return { code: 'ok' as const }
		}),

	kill: orpcBase
		.meta({ type: 'mutation' })
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
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const reasonRes = SquadServerActions.resolveReasonInput(
				'kill',
				input,
				input.squadName ? { squadName: input.squadName } : undefined,
			)
			if (reasonRes.code !== 'ok') return reasonRes
			// the kill notify delivers the rendered reason verbatim (see SquadRcon.killPlayers / ctx.tr.warn(SM_Msgs.notifyKilled()))
			const reason = reasonRes.applied && AAR.renderAppliedReason(reasonRes.applied)
			await SquadServerActions.killPlayersAction(
				ctx,
				input.playerIds,
				{ type: 'slm-user', userId: ctx.user.discordId },
				reason,
				reasonRes.applied?.label,
			)
			return { code: 'ok' as const }
		}),

	// a plain kick; timeouts (which bar the player from rejoining) go through timeouts.timeoutPlayer
	kickPlayers: orpcBase
		.meta({ type: 'mutation' })
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
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			const reasonRes = SquadServerActions.resolveReasonInput(
				'kick',
				input,
				input.squadName ? { squadName: input.squadName } : undefined,
			)
			if (reasonRes.code !== 'ok') return reasonRes
			await SquadServerActions.kickPlayersAction(
				ctx,
				input.playerIds,
				{ type: 'slm-user', userId: ctx.user.discordId },
				reasonRes.applied,
			)
			return { code: 'ok' as const }
		}),

	renameSquad: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), teamId: SM.TeamIdSchema, squadId: z.number().int().positive() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctxRes = await SquadServer.tryCtx(_ctx, input.serverId)
			if (ctxRes.code !== 'ok') return ctxRes
			const ctx = ctxRes.ctx
			await SquadServerActions.renameSquadAction(ctx, input.teamId, input.squadId, { type: 'slm-user', userId: ctx.user.discordId })
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

// A stream whose value is the same for every client, built once per managed server and shared by every watcher, so the
// reads and comparisons behind it run once per change rather than once per client. Never for anything filtered by the
// caller's permissions. Keyed by the managed server object, so a server that restarts builds its streams afresh.
const sharedStreams = new WeakMap<C.ManagedServer, Map<string, Rx.Observable<unknown>>>()

function sharedForServer<T>(serverId: string, key: string, build: (ctx: C.ManagedServer & C.Db) => Rx.Observable<T>): Rx.Observable<T> {
	const managedServer = SquadServer.globalState.managedServers.get(serverId)
	if (!managedServer) return Rx.EMPTY
	let streams = sharedStreams.get(managedServer)
	if (!streams) {
		streams = new Map()
		sharedStreams.set(managedServer, streams)
	}
	let shared = streams.get(key) as Rx.Observable<T> | undefined
	if (!shared) {
		shared = build({ ...SquadServer.getBaseCtx(), ...managedServer }).pipe(Rx.shareReplay({ bufferSize: 1, refCount: true }))
		streams.set(key, shared)
	}
	return shared
}
