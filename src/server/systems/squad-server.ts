import { AsyncResource, distinctDeepEquals, toAsyncGenerator } from '@/lib/async'
import fetchAdminLists from '@/lib/rcon/fetch-admin-lists'
import Rcon from '@/lib/rcon/rcon-core'
import * as SM from '@/lib/rcon/squad-models'
import StringComparison from 'string-comparison'
import SquadRcon from '@/lib/rcon/squad-rcon'
import * as C from '@/server/context.ts'
import * as M from '@/models.ts'
import * as DB from '@/server/db.ts'
import * as Rx from 'rxjs'

import { ENV } from '../env'
import { baseLogger } from '@/server/logger'
import { procedure, router } from '../trpc.server.ts'
import * as Rbac from '@/server/systems/rbac.system.ts'
import * as RBAC from '@/rbac.models'
import * as Config from '@/server/config'
import { CONFIG } from '@/server/config'
import * as LayerQueue from '@/server/systems/layer-queue.ts'
import { WARNS } from '@/messages.ts'
import { assertNever } from '@/lib/typeGuards.ts'

export let rcon!: SquadRcon
export let adminList!: AsyncResource<SM.SquadAdmins>

export async function warnAllAdmins(ctx: C.Log, message: string) {
	await using opCtx = C.pushOperation(ctx, 'squad-server:warn-all-admins')
	const [{ value: admins }, { value: players }] = await Promise.all([adminList.get(opCtx), rcon.playerList.get(opCtx)])
	const ops: Promise<void>[] = []

	for (const player of players) {
		const groups = admins.get(player.steamID)
		if (groups?.[CONFIG.adminListAdminRole]) {
			ops.push(rcon.warn(opCtx, player.steamID.toString(), message))
		}
	}
	await Promise.all(ops)
}

async function* watchServerStatus({ ctx }: { ctx: C.Log }) {
	using opCtx = C.pushOperation(ctx, 'squad-server:watch-status')
	for await (const info of toAsyncGenerator(rcon.serverStatus.observe(opCtx, { ttl: 3000 }).pipe(distinctDeepEquals()))) {
		yield info
	}
}

async function endMatch({ ctx: baseCtx }: { ctx: C.TrpcRequest }) {
	await using ctx = C.pushOperation(baseCtx, 'squad-server:end-match')

	try {
		const deniedRes = await Rbac.tryDenyPermissionsForUser(ctx, ctx.user.discordId, {
			check: 'all',
			permits: [RBAC.perm('squad-server:end-match')],
		})
		if (deniedRes) return deniedRes
		await rcon.endMatch(ctx)
		await warnAllAdmins(ctx, 'Match ended via squad-layer-manager')
	} catch (err) {
		C.failOperation(ctx, err)
		return { code: 'err' as const, msg: 'error while ending match', err }
	}
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

async function handleCommand(msg: SM.ChatMessage, _ctx: C.Log & C.Db) {
	await using ctx = C.pushOperation(_ctx, 'squad-server:handle-command')
	if (!SM.CHAT_CHANNEL.safeParse(msg.chat)) {
		ctx.log.warn('Invalid chat channel', { chatMsg: msg })
		return
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
			await rcon.warn(ctx, msg.playerId, `Unknown command "${words[0]}"`)
			return
		}
		const matched = sortedMatches[sortedMatches.length - 1].member
		await rcon.warn(ctx, msg.playerId, `Unknown command "${words[0]}". Did you mean ${matched}?`)
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
		await rcon.warn(ctx, msg.playerId, `Command "${cmd}" is disabled`)
		return
	}

	const user: M.GuiOrChatUserId = { steamId: msg.steamID }
	switch (cmd) {
		case 'startVote': {
			const res = await LayerQueue.startVote(ctx, { initiator: user })
			switch (res.code) {
				case 'err:permission-denied': {
					await rcon.warn(ctx, msg.playerId, WARNS.permissionDenied(res))
					break
				}
				case 'err:no-vote-exists':
				case 'err:vote-in-progress': {
					await rcon.warn(ctx, msg.playerId, res.msg)
					break
				}
				case 'ok':
					break
				default:
					assertNever(res)
			}
			return
		}
		case 'abortVote': {
			const res = await LayerQueue.abortVote(ctx, { aborter: user })
			switch (res.code) {
				case 'ok':
					break
				case 'err:no-vote-in-progress':
					await rcon.warn(ctx, msg.playerId, WARNS.vote.noVoteInProgress)
					break
				default: {
					assertNever(res)
				}
			}
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
			return
		}
		case 'showNext': {
			const nextItem = await LayerQueue.peekNext(ctx)
			await rcon.warn(ctx, msg.playerId, WARNS.queue.showNext(nextItem))
			return
		}
		default: {
			assertNever(cmd)
		}
	}
}

export async function setupSquadServer() {
	const adminListTTL = 1000 * 60 * 60
	const baseCtx = DB.addPooledDb({ log: baseLogger })

	await using opCtx = C.pushOperation(baseCtx, 'squad-server:setup', {
		level: 'info',
	})
	adminList = new AsyncResource('adminLists', (ctx) => fetchAdminLists(ctx, CONFIG.adminListSources), { defaultTTL: adminListTTL })
	void adminList.get(opCtx)

	const coreRcon = new Rcon({
		host: ENV.RCON_HOST,
		port: ENV.RCON_PORT,
		password: ENV.RCON_PASSWORD,
	})
	await coreRcon.connect(opCtx)
	rcon = new SquadRcon(baseCtx, coreRcon)

	rcon.event$.subscribe(async (event) => {
		if (event.type === 'chat-message' && event.message.message.startsWith(CONFIG.commandPrefix)) {
			await handleCommand(event.message, baseCtx)
		}

		if (event.type === 'chat-message' && event.message.message.trim().match(/^\d+$/)) {
			await LayerQueue.handleVote(event.message, baseCtx)
		}
	})
}

export const squadServerRouter = router({
	watchServerStatus: procedure.subscription(watchServerStatus),
	endMatch: procedure.mutation(endMatch),
})
