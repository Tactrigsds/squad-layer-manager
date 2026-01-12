import { initModule } from '@/server/logger'
import { assertNever } from '@/lib/type-guards'
import * as Messages from '@/messages.ts'
import * as CMD from '@/models/command.models.ts'
import type * as CS from '@/models/context-shared'
import * as LOG from '@/models/logs'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import { CONFIG } from '@/server/config.ts'
import type * as C from '@/server/context.ts'
import { baseLogger } from '@/server/logger'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as Users from '@/systems/users.server'
import * as Vote from '@/systems/vote.server'

const module = initModule('commands')
let log!: CS.Logger

export function setup() {
	log = module.getLogger()
}
export async function handleCommand(ctx: C.Db & C.ServerSlice, msg: SM.RconEvents.ChatMessage) {
	if (!SM.CHAT_CHANNEL_TYPE.safeParse(msg.channelType)) {
		return {
			code: 'err:invalid-chat-channel' as const,
			msg: 'Invalid chat channel',
		}
	}

	async function showError<T extends string>(reason: T, errorMessage: string) {
		await SquadRcon.warn(ctx, msg.playerIds, errorMessage)
		return {
			code: `err:${reason}` as const,
			msg: errorMessage,
		}
	}

	const parseRes = CMD.parseCommand(msg, CONFIG.commands, CONFIG.commandPrefix)
	if (parseRes.code === 'err:unknown-command') {
		await SquadRcon.warn(ctx, msg.playerIds, parseRes.msg)
		return
	}

	const { cmd, args } = parseRes

	log.info('Command received: %s', cmd)

	const cmdConfig = CONFIG.commands[cmd as keyof typeof CONFIG.commands]
	if (!CMD.chatInScope(cmdConfig.scopes, msg.channelType)) {
		const scopes = CMD.getScopesForChat(msg.channelType)
		const correctChats = scopes.flatMap((s) => CMD.CHAT_SCOPE_MAPPINGS[s])
		await SquadRcon.warn(ctx, msg.playerIds, Messages.WARNS.commands.wrongChat(correctChats))
		return
	}

	if (!cmdConfig.enabled) {
		return await showError('command-disabled', `Command "${cmd}" is disabled`)
	}
	const playerRes = await SquadRcon.getPlayer(ctx, msg.playerIds)
	if (playerRes.code === 'err:rcon') {
		return await showError('rcon-error', 'RCON error')
	}
	if (playerRes.code === 'err:player-not-found') {
		return await showError('player-not-found', 'Player not found')
	}
	const player = playerRes.player
	if (!player.ids.steam) return

	const user: USR.GuiOrChatUserId = { steamId: player.ids.steam.toString() }
	switch (cmd) {
		case 'startVote': {
			const res = await Vote.startVote(ctx, { initiator: user })
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
			const res = await Vote.abortVote(ctx, { aborter: user })
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
			await SquadRcon.warn(ctx, msg.playerIds, Messages.WARNS.commands.help(CONFIG.commands, CONFIG.commandPrefix))
			return { code: 'ok' as const }
		}
		case 'showNext': {
			await LayerQueue.warnShowNext(ctx, msg.playerIds, { repeat: 3 })
			return { code: 'ok' as const }
		}
		case 'disableSlmUpdates':
		case 'enableSlmUpdates': {
			const res = await LayerQueue.toggleUpdatesToSquadServer({ ctx, input: { disabled: cmd === 'disableSlmUpdates' } })
			switch (res.code) {
				case 'ok':
					return { code: 'ok' as const }
				case 'err:permission-denied':
					await SquadRcon.warn(ctx, msg.playerIds, Messages.WARNS.permissionDenied(res))
					return res
				default:
					assertNever(res)
					return res
			}
		}
		case 'getSlmUpdatesEnabled': {
			const res = await LayerQueue.getSlmUpdatesEnabled(ctx)
			await SquadRcon.warn(ctx, msg.playerIds, Messages.WARNS.slmUpdatesStatus(res.enabled))
			return { code: 'ok' as const }
		}
		case 'linkSteamAccount': {
			if (!msg.playerIds.steam) {
				await SquadRcon.warn(ctx, msg.playerIds, Messages.WARNS.commands.missingSteamId())
				return { code: 'err:missing-steam-id' as const }
			}
			const res = await Users.completeSteamAccountLink(ctx, args.code, msg.playerIds.steam)
			switch (res.code) {
				case 'ok':
					await SquadRcon.warn(ctx, msg.playerIds, Messages.WARNS.commands.steamAccountLinked(res.linkedUsername))
					return { code: 'ok' as const }
				case 'err:invalid-code':
				case 'err:already-linked':
				case 'err:discord-user-not-found':
					await SquadRcon.warn(ctx, msg.playerIds, res.msg)
					return res
				default:
					assertNever(res)
					// return needed for typechecking the outer switch Sadge
					return res
			}
		}
		case 'requestFeedback': {
			const res = await LayerQueue.requestFeedback(ctx, player.ids.username, args.number)
			switch (res.code) {
				case 'err:empty':
				case 'err:not-found': {
					await SquadRcon.warn(ctx, msg.playerIds, 'Item not found')
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
