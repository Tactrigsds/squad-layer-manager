import * as Arr from '@/lib/array'
import { simpleUniqueStringMatch } from '@/lib/string'
import { assertNever } from '@/lib/type-guards'
import * as Messages from '@/messages.ts'
import type * as BM from '@/models/battlemetrics.models'
import * as CMD from '@/models/command.models.ts'
import type * as CS from '@/models/context-shared'
import * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import { CONFIG } from '@/server/config.ts'
import type * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'
import * as Battlemetrics from '@/systems/battlemetrics.server'
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
			const res = await Users.completeSteamAccountLink(ctx, args.code, BigInt(msg.playerIds.steam))
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

		case 'flag': {
			const teamsStateRes = await ctx.server.teams.get(ctx)
			if (teamsStateRes.code !== 'ok') {
				return teamsStateRes
			}
			let matchedPlayerRes = SM.PlayerIds.fuzzyMatchIdentifierUniquely(teamsStateRes.players, p => p.ids, args.player)
			if (matchedPlayerRes.code === 'err:not-found') {
				return await showError('not-found', `No player matches found for "${args.player}"`)
			}

			if (matchedPlayerRes.code === 'err:multiple-matches') {
				return await showError('multiple-matches', `Multiple(${matchedPlayerRes.count}) player matches found for "${args.player}".`)
			}

			const flags = await Battlemetrics.getOrgFlags(ctx)

			const matchedFlagRes = simpleUniqueStringMatch(flags.map(f => f.name), args.flag)

			if (matchedFlagRes.code === 'err:not-found') {
				return await showError('not-found', `No flag matches found for "${args.flag}"`)
			}

			if (matchedFlagRes.code === 'err:multiple-matches') {
				return await showError('multiple-matches', `Multiple(${matchedFlagRes.count}) flag matches found for "${args.flag}".`)
			}

			const flagToUpdate = flags[matchedFlagRes.matched]
			const targetIds = matchedPlayerRes.matched.ids
			const bmPlayerData = await Battlemetrics.fetchSinglePlayerBmData(ctx, targetIds)
			if (!bmPlayerData) {
				return await showError('not-in-battlemetrics', `Unable to resolve player "${args.player}" in battlemetrics`)
			}

			const res = await Battlemetrics.addPlayerFlags(ctx, bmPlayerData.bmPlayerId, [flagToUpdate.id])
			if (res.code === 'err:no-flags') return
			if (res.code === 'player-already-has-flag') {
				return await showError(res.code, `Player "${targetIds.username}" is already assigned flag "${flagToUpdate.name}"`)
			}
			if (res.code === 'ok') {
				await Battlemetrics.invalidateAndRefetchPlayer(ctx, targetIds.eos)
				await SquadRcon.warn(ctx, msg.playerIds, `Added flag "${flagToUpdate.name}" to ${targetIds.username}'s BM profile`)
				return
			}
			assertNever(res)
			break
		}

		case 'removeFlag': {
			const teamsStateRes = await ctx.server.teams.get(ctx)
			if (teamsStateRes.code !== 'ok') {
				return teamsStateRes
			}
			const matchedPlayerRes = SM.PlayerIds.fuzzyMatchIdentifierUniquely(teamsStateRes.players, p => p.ids, args.player)
			if (matchedPlayerRes.code === 'err:not-found') {
				return await showError('not-found', `No player matches found for "${args.player}"`)
			}
			if (matchedPlayerRes.code === 'err:multiple-matches') {
				return await showError('multiple-matches', `Multiple(${matchedPlayerRes.count}) player matches found for "${args.player}".`)
			}

			const flags = await Battlemetrics.getOrgFlags(ctx)
			const matchedFlagRes = simpleUniqueStringMatch(flags.map(f => f.name), args.flag)
			if (matchedFlagRes.code === 'err:not-found') {
				return await showError('not-found', `No flag matches found for "${args.flag}"`)
			}
			if (matchedFlagRes.code === 'err:multiple-matches') {
				return await showError('multiple-matches', `Multiple(${matchedFlagRes.count}) flag matches found for "${args.flag}".`)
			}

			const flagToRemove = flags[matchedFlagRes.matched]
			const bmPlayerData = await Battlemetrics.fetchSinglePlayerBmData(ctx, matchedPlayerRes.matched.ids)
			if (!bmPlayerData) {
				return await showError('not-in-battlemetrics', `Unable to resolve player "${args.player}" in battlemetrics`)
			}
			if (!bmPlayerData.flagIds.includes(flagToRemove.id)) {
				return await showError('not-found', `Player "${matchedPlayerRes.matched.ids.username}" does not have flag "${flagToRemove.name}"`)
			}

			const [status] = await Battlemetrics.removePlayerFlags(ctx, bmPlayerData.bmPlayerId, [flagToRemove.id])
			if (status === 'already-removed') {
				return await showError(
					'already-removed',
					`Flag "${flagToRemove.name}" is already removed from ${matchedPlayerRes.matched.ids.username}'s BM profile`,
				)
			}
			await Battlemetrics.invalidateAndRefetchPlayer(ctx, matchedPlayerRes.matched.ids.eos)
			await SquadRcon.warn(
				ctx,
				msg.playerIds,
				`Removed flag "${flagToRemove.name}" from ${matchedPlayerRes.matched.ids.username}'s BM profile`,
			)
			break
		}

		case 'listFlags': {
			function formatFlagList(flags: BM.PlayerFlag[]) {
				if (flags.length === 0) {
					return 'none'
				}
				return Arr.paged(flags.map(f => f.name), 4).map(g => g.join('\n'))
			}
			const flags = await Battlemetrics.getOrgFlags(ctx)

			if (!args.player) {
				await SquadRcon.warn(ctx, msg.playerIds, formatFlagList(flags))
				break
			}

			const teamsStateRes = await ctx.server.teams.get(ctx)
			if (teamsStateRes.code !== 'ok') {
				return teamsStateRes
			}
			const matchedPlayerRes = SM.PlayerIds.fuzzyMatchIdentifierUniquely(teamsStateRes.players, p => p.ids, args.player)
			if (matchedPlayerRes.code === 'err:not-found') {
				return await showError('not-found', `No player matches found for "${args.player}"`)
			}
			if (matchedPlayerRes.code === 'err:multiple-matches') {
				return await showError('multiple-matches', `Multiple(${matchedPlayerRes.count}) player matches found for "${args.player}".`)
			}

			const bmPlayerData = await Battlemetrics.fetchSinglePlayerBmData(ctx, matchedPlayerRes.matched.ids)
			if (!bmPlayerData) {
				return await showError('not-in-battlemetrics', `Unable to resolve player "${args.player}" in battlemetrics`)
			}
			const playerFlags = flags.filter(f => bmPlayerData.flagIds.includes(f.id))

			await SquadRcon.warn(ctx, msg.playerIds, formatFlagList(playerFlags))
			break
		}

		default: {
			assertNever(cmd)
		}
	}
}
