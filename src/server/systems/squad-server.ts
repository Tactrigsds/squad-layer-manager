import * as SchemaModels from '$root/drizzle/schema.models.ts'
import { AsyncResource, distinctDeepEquals, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import * as DH from '@/lib/display-helpers.ts'
import * as OneToMany from '@/lib/one-to-many-map.ts'
import Rcon from '@/lib/rcon/core-rcon.ts'
import fetchAdminLists from '@/lib/rcon/fetch-admin-lists'
import SquadRcon, { WarnOptions } from '@/lib/rcon/squad-rcon.ts'
import { SquadEventEmitter } from '@/lib/squad-log-parser/squad-event-emitter.ts'
import { assertNever } from '@/lib/type-guards.ts'
import { BROADCASTS, WARNS } from '@/messages.ts'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models.ts'
import * as MH from '@/models/match-history.models.ts'
import * as SME from '@/models/squad-models.events.ts'
import * as SM from '@/models/squad.models.ts'
import * as USR from '@/models/users.models.ts'
import * as RBAC from '@/rbac.models'
import * as Config from '@/server/config'
import { CONFIG } from '@/server/config'
import * as C from '@/server/context.ts'
import * as DB from '@/server/db.ts'
import { baseLogger } from '@/server/logger'
import * as LayerQueue from '@/server/systems/layer-queue.ts'
import * as MatchHistory from '@/server/systems/match-history.ts'
import * as Rbac from '@/server/systems/rbac.system.ts'
import * as Otel from '@opentelemetry/api'
import * as Rx from 'rxjs'
import StringComparison from 'string-comparison'
import { z } from 'zod'
import * as Env from '../env'
import { procedure, router } from '../trpc.server.ts'

type SquadServerState = {
	// An ephemeral copy of the current matches layer queue item, taken just before the server rolls and the NEW_GAME squad event is emitted. in order for usages of this to be valid, the corresponding NEW_GAME event must be received after its details are buffered.
	bufferedNextMatch?: {
		layerListItem: LL.LayerListItem
	}
	lastRoll: Date

	debug__ticketOutcome?: SME.DebugTicketOutcome
}

const tracer = Otel.trace.getTracer('squad-server')

export let rcon!: SquadRcon
export let squadLogEvents!: SquadEventEmitter

export let adminList!: AsyncResource<SM.AdminList>
let layersStatusExt$!: Rx.Observable<SM.LayersStatusResExt>

// be a good citizen and don't update this from outside of squad-server
export let state!: SquadServerState

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.squadSftpLogs, ...Env.groups.rcon })
let ENV!: ReturnType<typeof envBuilder>

export const warnAllAdmins = C.spanOp(
	'squad-server:warn-all-admins',
	{ tracer, eventLogLevel: 'info' },
	async (ctx: CS.Log, options: WarnOptions) => {
		const [{ value: currentAdminList }, { value: playersRes }] = await Promise.all([adminList.get(ctx), rcon.playerList.get(ctx)])
		const ops: Promise<void>[] = []

		if (playersRes.code === 'err:rcon') return
		for (const player of playersRes.players) {
			if (OneToMany.has(currentAdminList.admins, player.steamID, CONFIG.adminListAdminRole)) {
				await rcon.warn(ctx, player.steamID.toString(), options)
			}
		}
		await Promise.all(ops)
	},
)

async function* watchLayersStatus({ ctx, signal }: { ctx: CS.Log; signal?: AbortSignal }) {
	yield await fetchLayersStatusExt(ctx)
	ctx.log.info('aborted: %s', signal!.aborted)
	for await (const res of toAsyncGenerator(layersStatusExt$.pipe(withAbortSignal(signal!)))) {
		yield res
	}
	ctx.log.info('watchlayerStatus ended')
}

async function* watchServerInfo({ ctx, signal }: { ctx: CS.Log; signal?: AbortSignal }) {
	yield* toAsyncGenerator(rcon.serverInfo.observe(ctx).pipe(withAbortSignal(signal!)))
}

async function endMatch({ ctx }: { ctx: C.TrpcRequest }) {
	const deniedRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
		check: 'all',
		permits: [RBAC.perm('squad-server:end-match')],
	})
	if (deniedRes) return deniedRes
	await rcon.endMatch(ctx)
	await warnAllAdmins(ctx, BROADCASTS.matchEnded(ctx.user))
	return { code: 'ok' as const }
}

function matchCommandText(cmdText: string) {
	for (const [cmd, config] of Object.entries(CONFIG.commands)) {
		if (config.strings.includes(cmdText)) {
			return cmd as keyof typeof CONFIG.commands
		}
	}
	return null
}
function chatInScope(scopes: SM.CommandScope[], msgChat: SM.ChatChannel) {
	for (const scope of scopes) {
		if (SM.CHAT_SCOPE_MAPPINGS[scope].includes(msgChat)) {
			return true
		}
	}
	return false
}

async function handleCommand(ctx: CS.Log & C.Db, msg: SM.ChatMessage) {
	if (!SM.CHAT_CHANNEL.safeParse(msg.chat)) {
		C.setSpanStatus(Otel.SpanStatusCode.ERROR, 'Invalid chat channel')
		return
	}

	const showError = (errMsg: string) => {
		C.setSpanStatus(Otel.SpanStatusCode.ERROR, errMsg)
		return rcon.warn(ctx, msg.playerId, errMsg)
	}

	const words = msg.message.split(/\s+/)
	const cmdText = words[0].slice(1)
	// const args = words.slice(1)
	const cmd = matchCommandText(cmdText)
	if (cmd === null) {
		const allCommandStrings = Object.values(CONFIG.commands)
			.filter((c) => chatInScope(c.scopes, msg.chat))
			.flatMap((c) => c.strings)
			.map((s) => CONFIG.commandPrefix + s)
		const sortedMatches = StringComparison.diceCoefficient.sortMatch(words[0], allCommandStrings)
		if (sortedMatches.length === 0) {
			return await showError(`Unknown command "${words[0]}"`)
			return
		}
		const matched = sortedMatches[sortedMatches.length - 1].member
		return await showError(`Unknown command "${words[0]}". Did you mean ${matched}?`)
		return
	}
	ctx.log.info('Command received: %s', cmd)

	const cmdConfig = CONFIG.commands[cmd]
	if (!chatInScope(cmdConfig.scopes, msg.chat)) {
		const scopes = SM.getScopesForChat(msg.chat)
		const correctChats = scopes.flatMap((s) => SM.CHAT_SCOPE_MAPPINGS[s])
		await rcon.warn(ctx, msg.playerId, WARNS.commands.wrongChat(correctChats))
		return
	}

	if (cmdConfig.enabled === false) {
		return await showError(`Command "${cmd}" is disabled`)
	}

	const user: USR.GuiOrChatUserId = { steamId: msg.steamID }
	switch (cmd) {
		case 'startVote': {
			const res = await LayerQueue.startVote(ctx, { initiator: user })
			switch (res.code) {
				case 'err:permission-denied': {
					return await showError(WARNS.permissionDenied(res))
				}
				case 'err:no-vote-exists':
				case 'err:vote-in-progress': {
					return await showError(res.msg)
				}
				case 'err:rcon': {
					throw new Error(`RCON error`)
				}
				case 'ok':
					break
				default:
					assertNever(res)
			}
			C.setSpanStatus(Otel.SpanStatusCode.OK)
			return
		}
		case 'abortVote': {
			const res = await LayerQueue.abortVote(ctx, { aborter: user })
			switch (res.code) {
				case 'ok':
					break
				case 'err:no-vote-in-progress':
					return await showError(WARNS.vote.noVoteInProgress)
				default: {
					assertNever(res)
				}
			}
			C.setSpanStatus(Otel.SpanStatusCode.OK)
			return
		}
		case 'help': {
			const configsWithDescriptions: (Config.CommandConfig & { description: string })[] = []
			for (const [_cmd, config] of Object.entries(CONFIG.commands)) {
				const cmd = _cmd as keyof typeof CONFIG.commands
				configsWithDescriptions.push({
					...config,
					description: Config.ConfigSchema.shape.commands.shape[cmd].description ?? '<no description>',
				})
			}
			await rcon.warn(ctx, msg.playerId, WARNS.commands.help(configsWithDescriptions, CONFIG.commandPrefix))
			C.setSpanStatus(Otel.SpanStatusCode.OK)
			return
		}
		case 'showNext': {
			await LayerQueue.warnShowNext(ctx, msg.playerId, { repeat: 3 })
			C.setSpanStatus(Otel.SpanStatusCode.OK)
			return
		}
		default: {
			assertNever(cmd)
		}
	}
}

export const setup = C.spanOp('squad-server:setup', { tracer, eventLogLevel: 'info' }, async () => {
	ENV = envBuilder()
	// -------- set up admin list --------
	const adminListTTL = 1000 * 60 * 60 * 60
	const ctx = DB.addPooledDb({ log: baseLogger })

	state = {
		lastRoll: new Date(0),
	}

	adminList = new AsyncResource('adminLists', (ctx) => fetchAdminLists(ctx, CONFIG.adminListSources), { defaultTTL: adminListTTL })
	void adminList.get(ctx)

	// -------- set up rcon --------
	const coreRcon = new Rcon({
		host: ENV.RCON_HOST,
		port: ENV.RCON_PORT,
		password: ENV.RCON_PASSWORD,
	})

	void coreRcon.connect(ctx)
		.then(async () => {
			const { value: statusRes } = await rcon.layersStatus.get(ctx)
			if (statusRes.code === 'err:rcon') return
			await MatchHistory.resolvePotentialCurrentLayerConflict(ctx, statusRes.data.currentLayer.id)
			const currentMatch = MatchHistory.getCurrentMatch()
			if (currentMatch && L.areLayersCompatible(statusRes.data.currentLayer, currentMatch.layerId)) {
				const currentLayer = L.toLayer(currentMatch.layerId)
				if (currentLayer.Gamemode === 'FRAAS') await rcon.setFogOfWar(ctx, 'off')
			}
		})
	rcon = new SquadRcon(ctx, coreRcon, { warnPrefix: CONFIG.warnPrefix })

	rcon.event$.pipe(
		C.durableSub(
			'squad-server:handle-rcon-event',
			{ tracer, ctx, eventLogLevel: 'trace', taskScheduling: 'parallel', root: true },
			async (event) => {
				if (event.type === 'chat-message' && event.message.message.startsWith(CONFIG.commandPrefix)) {
					await handleCommand(ctx, event.message)
				}

				if (event.type === 'chat-message' && event.message.message.trim().match(/^\d+$/)) {
					await LayerQueue.handleVote(ctx, event.message)
				}
			},
		),
	).subscribe()

	// -------- set up squad events (events from logger) --------
	squadLogEvents = new SquadEventEmitter(ctx, {
		sftp: {
			host: ENV.SQUAD_SFTP_HOST,
			port: ENV.SQUAD_SFTP_PORT,
			username: ENV.SQUAD_SFTP_USERNAME,
			password: ENV.SQUAD_SFTP_PASSWORD,
			filePath: ENV.SQUAD_SFTP_LOG_FILE,
			pollInterval: ENV.SQUAD_SFTP_POLL_INTERVAL,
		},
	})

	squadLogEvents.event$.pipe(
		C.durableSub(
			'squad-server:handle-squad-log-event',
			{ tracer, ctx, eventLogLevel: 'info' },
			([ctx, event]) => handleSquadEvent(DB.addPooledDb(ctx), event),
		),
	).subscribe()

	void squadLogEvents.connect()

	layersStatusExt$ = getLayersStatusExt$(ctx)
	C.setSpanStatus(Otel.SpanStatusCode.OK)
})

async function handleSquadEvent(ctx: CS.Log & C.Db, event: SME.Event) {
	switch (event.type) {
		case 'NEW_GAME': {
			console.log('handling squad event:', new Date().toISOString())
			state.lastRoll = event.time
			const res = await DB.runTransaction(ctx, async (ctx) => {
				const { value: statusRes } = await rcon.layersStatus.get(ctx, { ttl: 200 })
				if (statusRes.code !== 'ok') return statusRes

				const newEntry: Omit<SchemaModels.NewMatchHistory, 'ordinal'> = {
					layerId: statusRes.data.currentLayer.id,
					startTime: event.time,
					setByType: 'unknown',
				}

				if (state.bufferedNextMatch) {
					newEntry.layerId = LL.getActiveItemLayerId(state.bufferedNextMatch.layerListItem) ?? newEntry.layerId
					newEntry.lqItemId = state.bufferedNextMatch.layerListItem.itemId
					newEntry.layerVote = state.bufferedNextMatch.layerListItem.vote
					newEntry.setByType = state.bufferedNextMatch.layerListItem.source.type

					const setByUserId = state.bufferedNextMatch.layerListItem.source.type === 'manual'
						? state.bufferedNextMatch.layerListItem.source.userId
						: undefined
					newEntry.setByUserId = setByUserId
				}

				const res = await MatchHistory.addNewCurrentMatch(ctx, newEntry)
				if (res.code !== 'ok') return res

				delete state.bufferedNextMatch

				return { code: 'ok' as const }
			})

			if (res.code !== 'ok') return res

			// Kind of a hack -- we need to refresh the server state to recalculate the relevant parts
			const lastUpdate = await Rx.firstValueFrom(LayerQueue.serverStateUpdateWithParts$)
			LayerQueue.serverStateUpdate$.next([lastUpdate, ctx])
			return res
		}

		case 'ROUND_ENDED': {
			const { value: statusRes } = await rcon.layersStatus.get(ctx, { ttl: 200 })
			if (statusRes.code !== 'ok') return statusRes
			// -------- use debug ticketOutcome if one was set --------
			if (state.debug__ticketOutcome) {
				let winner: SM.TeamId | null
				let loser: SM.TeamId | null
				if (state.debug__ticketOutcome.team1 === state.debug__ticketOutcome.team2) {
					winner = null
					loser = null
				} else {
					winner = state.debug__ticketOutcome.team1 - state.debug__ticketOutcome.team2 > 0 ? 1 : 2
					loser = state.debug__ticketOutcome.team1 - state.debug__ticketOutcome.team2 < 0 ? 1 : 2
				}
				const partial = L.toLayer(statusRes.data.currentLayer)
				const teams: SM.SquadOutcomeTeam[] = [
					{
						faction: partial.Faction_1!,
						unit: partial.Unit_1!,
						team: 1,
						tickets: state.debug__ticketOutcome.team1,
					},
					{
						faction: partial.Faction_2!,
						unit: partial.Unit_2!,
						team: 2,
						tickets: state.debug__ticketOutcome.team2,
					},
				]
				const winnerTeam = teams.find(t => t?.team && t.team === winner) ?? null
				const loserTeam = teams.find(t => t?.team && t.team === loser) ?? null
				event = {
					...event,
					loser: loserTeam,
					winner: winnerTeam,
				}
				delete state.debug__ticketOutcome
			}
			const res = await MatchHistory.finalizeCurrentMatch(ctx, statusRes.data.currentLayer.id, event)
			return res
		}
		default:
			assertNever(event)
	}
}

export function bufferNextMatchLQItem(item: LL.LayerListItem) {
	state.bufferedNextMatch = { layerListItem: item }
}

export async function toggleFogOfWar({ ctx, input }: { ctx: CS.Log & C.Db & C.User; input: { disabled: boolean } }) {
	const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, RBAC.perm('squad-server:turn-fog-off'))
	if (denyRes) return denyRes
	const { value: serverStatusRes } = await rcon.layersStatus.get(ctx)
	if (serverStatusRes.code !== 'ok') return serverStatusRes
	await rcon.setFogOfWar(ctx, input.disabled ? 'off' : 'on')
	if (input.disabled) {
		await rcon.broadcast(ctx, BROADCASTS.fogOff)
	}
	return { code: 'ok' as const }
}

export const squadServerRouter = router({
	watchLayersStatus: procedure.subscription(watchLayersStatus),
	watchServerInfo: procedure.subscription(watchServerInfo),
	endMatch: procedure.mutation(endMatch),
	toggleFogOfWar: procedure.input(z.object({ disabled: z.boolean() })).mutation(toggleFogOfWar),
})

function getLayersStatusExt$(ctx: CS.Log) {
	return new Rx.Observable<SM.LayersStatusResExt>(s => {
		const sub = new Rx.Subscription()
		sub.add(
			rcon.layersStatus.observe(ctx).subscribe({
				next: async () => {
					s.next(await fetchLayersStatusExt(ctx))
				},
				error: (err) => s.error(err),
				complete: () => s.complete(),
			}),
		)
		sub.add(MatchHistory.stateUpdated$.subscribe({
			next: async () => {
				s.next(await fetchLayersStatusExt(ctx))
			},
			error: (err) => s.error(err),
			complete: () => s.complete(),
		}))
		return () => sub.unsubscribe()
	}).pipe(distinctDeepEquals(), Rx.share())
}

async function fetchLayersStatusExt(ctx: CS.Log) {
	const { value: statusRes } = await rcon.layersStatus.get(ctx)
	if (statusRes.code !== 'ok') return statusRes
	return buildServerStatusRes(statusRes.data, MatchHistory.getCurrentMatch())
}

function buildServerStatusRes(rconStatus: SM.LayersStatus, currentMatch: MH.MatchDetails) {
	const res: SM.LayersStatusResExt = { code: 'ok' as const, data: { ...rconStatus } }
	if (currentMatch && L.areLayersCompatible(currentMatch.layerId, rconStatus.currentLayer)) {
		res.data.currentMatch = currentMatch
	}
	return res
}
