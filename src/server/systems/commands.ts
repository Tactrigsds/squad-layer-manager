import { assertNever } from '@/lib/type-guards'
import * as Messages from '@/messages.ts'
import * as CMD from '@/models/command.models.ts'
import * as CS from '@/models/context-shared'
import * as SM from '@/models/squad.models'
import * as USR from '@/models/users.models'
import { CONFIG } from '@/server/config.ts'
import * as C from '@/server/context.ts'
import * as LayerQueue from '@/server/systems/layer-queue.ts'
import * as SquadRcon from '@/server/systems/squad-rcon'
import * as Users from '@/server/systems/users.ts'

export async function handleCommand(ctx: CS.Log & C.Db & C.Mutexes & C.ServerSlice, msg: SM.ChatMessage) {
	if (!SM.CHAT_CHANNEL.safeParse(msg.chat)) {
		return {
			code: 'err:invalid-chat-channel' as const,
			msg: 'Invalid chat channel',
		}
	}

	async function showError<T extends string>(reason: T, errorMessage: string) {
		await SquadRcon.warn(ctx, msg.playerId, errorMessage)
		return {
			code: `err:${reason}` as const,
			msg: errorMessage,
		}
	}

	const parseRes = CMD.parseCommand(msg, CONFIG.commands, CONFIG.commandPrefix)
	if (parseRes.code === 'err:unknown-command') {
		await SquadRcon.warn(ctx, msg.playerId, parseRes.msg)
		return
	}

	const { cmd, args } = parseRes

	ctx.log.info('Command received: %s', cmd)

	const cmdConfig = CONFIG.commands[cmd as keyof typeof CONFIG.commands]
	if (!CMD.chatInScope(cmdConfig.scopes, msg.chat)) {
		const scopes = CMD.getScopesForChat(msg.chat)
		const correctChats = scopes.flatMap((s) => CMD.CHAT_SCOPE_MAPPINGS[s])
		await SquadRcon.warn(ctx, msg.playerId, Messages.WARNS.commands.wrongChat(correctChats))
		return
	}

	if (cmdConfig.enabled === false) {
		return await showError('command-disabled', `Command "${cmd}" is disabled`)
	}
	const playerListRes = await ctx.server.playerList.get(ctx)
	if (!msg.steamID) return
	if (playerListRes.code === 'err:rcon') {
		return await showError('rcon-error', 'RCON error')
	}
	const player = playerListRes.players.find((p) => p.steamID === BigInt(msg.steamID!))!

	const user: USR.GuiOrChatUserId = { steamId: msg.steamID }
	switch (cmd) {
		case 'startVote': {
			const res = await LayerQueue.startVote(ctx, { initiator: user })
			switch (res.code) {
				case 'err:permission-denied': {
					return await showError('permission-denied', Messages.WARNS.permissionDenied(res))
				}
				case 'err:invalid-item-type':
				case 'err:public-vote-not-first':
				case 'err:vote-not-allowed':
				case 'err:item-not-found':
				case 'err:vote-in-progress':
				case 'err:editing-in-progress': {
					return await showError('vote-error', res.msg)
				}
				case 'err:rcon': {
					throw new Error(`RCON error`)
				}
				case 'ok':
					return { code: 'ok' as const }
				default:
					assertNever(res)
					return
			}
		}
		case 'abortVote': {
			const res = await LayerQueue.abortVote(ctx, { aborter: user })
			switch (res.code) {
				case 'ok':
					return { code: 'ok' as const }
				case 'err:no-vote-in-progress':
					return await showError('no-vote-in-progress', Messages.WARNS.vote.noVoteInProgress)
				default: {
					assertNever(res)
					return
				}
			}
			break
		}
		case 'help': {
			await SquadRcon.warn(ctx, msg.playerId, Messages.WARNS.commands.help(CONFIG.commands, CONFIG.commandPrefix))
			return { code: 'ok' as const }
		}
		case 'showNext': {
			await LayerQueue.warnShowNext(ctx, msg.playerId, { repeat: 3 })
			return { code: 'ok' as const }
		}
		case 'disableSlmUpdates':
		case 'enableSlmUpdates': {
			const res = await LayerQueue.toggleUpdatesToSquadServer({ ctx, input: { disabled: cmd === 'disableSlmUpdates' } })
			switch (res.code) {
				case 'ok':
					return { code: 'ok' as const }
				case 'err:permission-denied':
					await SquadRcon.warn(ctx, msg.playerId, Messages.WARNS.permissionDenied(res))
					return res
				default:
					assertNever(res)
					return res
			}
		}
		case 'getSlmUpdatesEnabled': {
			const res = await LayerQueue.getSlmUpdatesEnabled(ctx)
			await SquadRcon.warn(ctx, msg.playerId, Messages.WARNS.slmUpdatesStatus(res.enabled))
			return { code: 'ok' as const }
		}
		case 'linkSteamAccount': {
			if (!msg.steamID) {
				await SquadRcon.warn(ctx, msg.playerId, Messages.WARNS.commands.missingSteamId())
				return { code: 'err:missing-steam-id' as const }
			}
			const res = await Users.completeSteamAccountLink(ctx, args.code, BigInt(msg.steamID))
			switch (res.code) {
				case 'ok':
					await SquadRcon.warn(ctx, msg.playerId, Messages.WARNS.commands.steamAccountLinked(res.linkedUsername))
					return { code: 'ok' as const }
				case 'err:invalid-code':
				case 'err:already-linked':
				case 'err:discord-user-not-found':
					await SquadRcon.warn(ctx, msg.playerId, res.msg)
					return res
				default:
					assertNever(res)
					// return needed for typechecking the outer switch Sadge
					return res
			}
		}
		case 'requestFeedback': {
			const res = await LayerQueue.requestFeedback(ctx, player.name, args.number)
			switch (res.code) {
				case 'err:empty':
				case 'err:not-found': {
					await SquadRcon.warn(ctx, msg.playerId, 'Item not found')
					return { code: 'err:not-found' as const }
				}
				case 'ok':
					break
				default: {
					assertNever(res)
					return res
				}
			}
			break
		}
		default: {
			assertNever(cmd)
		}
	}
}
