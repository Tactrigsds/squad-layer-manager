import * as SchemaModels from '$root/drizzle/schema.models.ts'
import { AsyncResource, distinctDeepEquals, toAsyncGenerator } from '@/lib/async'
import Rcon from '@/lib/rcon/core-rcon.ts'
import fetchAdminLists from '@/lib/rcon/fetch-admin-lists'
import * as SM from '@/lib/rcon/squad-models'
import * as SME from '@/lib/rcon/squad-models.events.ts'
import SquadRcon from '@/lib/rcon/squad-rcon.ts'
import { SquadEventEmitter } from '@/lib/squad-log-parser/squad-event-emitter.ts'
import { assertNever } from '@/lib/typeGuards.ts'
import { WARNS } from '@/messages.ts'
import * as M from '@/models.ts'
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
import StringComparison from 'string-comparison'
import * as Env from '../env'
import { procedure, router } from '../trpc.server.ts'

type SquadServerState = {
	currentMatchId?: number

	// An ephemeral copy of the current matches layer queue item, taken just before the server rolls and the NEW_GAME squad event is emitted. in order for usages of this to be valid, the corresponding NEW_GAME event must be received after its details are buffered.
	bufferedNextMatch?: {
		layerListItem: M.LayerListItem
		// the expected entry id for the next game when the layer source was buffered
		historyEntryCount: number
	}
}

const tracer = Otel.trace.getTracer('squad-server')

export let rcon!: SquadRcon
export let squadLogEvents!: SquadEventEmitter

export let adminList!: AsyncResource<SM.SquadAdmins>
export let serverStatus!: AsyncResource<SM.ServerStatusWithCurrentMatchRes>

export let state!: SquadServerState

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.squadSftpLogs, ...Env.groups.rcon })
let ENV!: ReturnType<typeof envBuilder>

export const warnAllAdmins = C.spanOp('squad-server:warn-all-admins', { tracer }, async (ctx: C.Log, message: string) => {
	C.setSpanOpAttrs({ message })
	const [{ value: admins }, { value: playersRes }] = await Promise.all([adminList.get(ctx), rcon.playerList.get(ctx)])
	const ops: Promise<void>[] = []

	if (playersRes.code === 'err:rcon') return
	for (const player of playersRes.players) {
		const groups = admins.get(player.steamID)
		if (groups?.[CONFIG.adminListAdminRole]) {
			ops.push(rcon.warn(ctx, player.steamID.toString(), message))
		}
	}
	await Promise.all(ops)
})

async function* watchServerStatus({ ctx }: { ctx: C.Log }) {
	for await (const info of toAsyncGenerator(serverStatus.observe(ctx, { ttl: 3000 }).pipe(distinctDeepEquals()))) {
		yield info
	}
}

async function endMatch({ ctx }: { ctx: C.TrpcRequest }) {
	try {
		const deniedRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
			check: 'all',
			permits: [RBAC.perm('squad-server:end-match')],
		})
		if (deniedRes) return deniedRes
		await rcon.endMatch(ctx)
		await warnAllAdmins(ctx, 'Match ended via squad-layer-manager')
	} catch (err) {
		return { code: 'err' as const, msg: 'error while ending match', err }
	}
	await rcon.endMatch(ctx)
	await warnAllAdmins(ctx, 'Match ended via squad-layer-manager')
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

const handleCommand = C.spanOp('squad-server:handle-command', { tracer }, async (msg: SM.ChatMessage, ctx: C.Log & C.Db) => {
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
		return
	}

	const user: M.GuiOrChatUserId = { steamId: msg.steamID }
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
					break
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
			const nextItem = await LayerQueue.peekNext(ctx)
			await rcon.warn(ctx, msg.playerId, WARNS.queue.showNext(nextItem))
			C.setSpanStatus(Otel.SpanStatusCode.OK)
			return
		}
		default: {
			assertNever(cmd)
		}
	}
})

export const setupSquadServer = C.spanOp('squad-server:setup', { tracer }, async () => {
	ENV = envBuilder()
	// -------- set up admin list --------
	const adminListTTL = 1000 * 60 * 60
	const ctx = DB.addPooledDb({ log: baseLogger })

	state = {}

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
			const statusRes = await rcon.serverStatus.get(ctx)
			if (statusRes.value.code === 'err:rcon') return
			const match = MatchHistory.state.recentMatches[0]
			if (match && M.areLayerIdsCompatible(match.layerId, statusRes.value.data.currentLayer.id)) {
				state.currentMatchId = match.historyEntryId
			}
		})
	rcon = new SquadRcon(ctx, coreRcon)

	rcon.event$.subscribe(async (event) => {
		if (event.type === 'chat-message' && event.message.message.startsWith(CONFIG.commandPrefix)) {
			await handleCommand(event.message, ctx)
		}

		if (event.type === 'chat-message' && event.message.message.trim().match(/^\d+$/)) {
			await LayerQueue.handleVote(event.message, ctx)
		}
	})

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
		C.durableSub('squad-server:handle-squadjs-event', { tracer, ctx }, ([ctx, event]) => handleSquadEvent(DB.addPooledDb(ctx), event)),
	).subscribe()
	void squadLogEvents.connect()

	serverStatus = new AsyncResource('serverStatusWithCurrentMatch', async (ctx): Promise<SM.ServerStatusWithCurrentMatchRes> => {
		const { value: statusRes } = await rcon.serverStatus.get(ctx, {
			ttl: Math.max(ctx.resOpts.ttl, 5000 / 2),
		})
		if (statusRes.code !== 'ok') return statusRes
		const res: SM.ServerStatusWithCurrentMatchRes = { code: 'ok' as const, data: { ...statusRes.data } }
		const match = MatchHistory.state.recentMatches[0]
		if (match && match?.historyEntryId === state.currentMatchId && M.areLayerIdsCompatible(match.layerId, statusRes.data.currentLayer.id)) {
			res.data.currentMatchId = state.currentMatchId
		}
		return res
	}, { defaultTTL: 5000 })

	C.getSpan()!.setStatus({ code: Otel.SpanStatusCode.OK })
})

async function handleSquadEvent(ctx: C.Log & C.Db, event: SME.Event) {
	switch (event.type) {
		case 'NEW_GAME': {
			const res = await DB.runTransaction(ctx, async (ctx) => {
				const { value: statusRes } = await rcon.serverStatus.get(ctx, { ttl: 200 })
				if (statusRes.code !== 'ok') return statusRes
				let newEntry: SchemaModels.NewMatchHistory = {
					layerId: statusRes.data.currentLayer.id,
					startTime: event.time,
					setByType: 'unknown',
					// setByUserId: state.bufferedNewGameLayerSource?.type ==
				}
				if (state.bufferedNextMatch) {
					const setByUserId = state.bufferedNextMatch.layerListItem.source.type === 'manual'
						? state.bufferedNextMatch.layerListItem.source.userId
						: undefined
					const updated: Partial<SchemaModels.NewMatchHistory> = {
						setByType: state.bufferedNextMatch.layerListItem.source.type,
						setByUserId: setByUserId,
					}
					newEntry = {
						...newEntry,
						...updated,
					}
				}

				const res = await MatchHistory.addHistoryEntry(ctx, newEntry, state.bufferedNextMatch?.historyEntryCount)
				if (res.code !== 'ok') return res
				state.currentMatchId = res.match.historyEntryId

				delete state.bufferedNextMatch

				return { code: 'ok' as const }
			})

			if (res.code !== 'ok') return res

			// Kind of a hack -- we need to refresh the server state to recalculate the relevant parts
			const prevUpdate = LayerQueue.serverStateUpdate$.value
			LayerQueue.serverStateUpdate$.next(prevUpdate)
			return res
		}

		case 'ROUND_ENDED': {
			const { value: statusRes } = await rcon.serverStatus.get(ctx, { ttl: 200 })
			if (statusRes.code !== 'ok') return statusRes

			await DB.runTransaction(ctx, async (ctx) => {
				const currentMatch = MatchHistory.state.recentMatches[0]
				if (!currentMatch || !M.areLayerIdsCompatible(currentMatch.layerId, statusRes.data.currentLayer.id)) {
					delete state.currentMatchId
					return
				}
				const teams: [SM.SquadOutcomeTeam | null, SM.SquadOutcomeTeam | null] = [event.winner, event.loser]
				if (teams[0]) teams.sort((a, b) => a!.team - b!.team)
				const outcome = event.winner === null ? 'draw' : event.winner.team === 1 ? 'team1' : 'team2'
				const entry: Partial<SchemaModels.NewMatchHistory> = {
					endTime: event.time,
					team1Tickets: teams[0]?.tickets,
					team2Tickets: teams[1]?.tickets,
					outcome,
				}

				state.currentMatchId = (await MatchHistory.finalizeCurrentHistoryEntry(ctx, entry))?.historyEntryId
			})
			return { code: 'ok' as const }
		}
		default:
			assertNever(event)
	}
}

export async function bufferNextMatchLQItem(ctx: C.Db & C.Log, item: M.LayerListItem) {
	const count = await MatchHistory.getMatchHistoryCount(ctx)
	state.bufferedNextMatch = {
		historyEntryCount: count,
		layerListItem: item,
	}
}

export const squadServerRouter = router({
	watchServerStatus: procedure.subscription(watchServerStatus),
	endMatch: procedure.mutation(endMatch),
})
