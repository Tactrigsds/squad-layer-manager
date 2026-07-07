import * as Arr from '@/lib/array'
import { simpleUniqueStringMatch } from '@/lib/string'
import { assertNever } from '@/lib/type-guards'
import * as Messages from '@/messages.ts'
import type * as BM from '@/models/battlemetrics.models'
import * as CMD from '@/models/command.models.ts'
import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import type * as TSW from '@/models/teamswitches.models'
import type * as USR from '@/models/users.models'
import type * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'
import * as Battlemetrics from '@/systems/battlemetrics.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Settings from '@/systems/settings.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as Teamswitches from '@/systems/teamswitches.server'
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

	const parseRes = CMD.parseCommand(msg, Settings.GLOBAL_SETTINGS.commands, Settings.GLOBAL_SETTINGS.commandPrefix)
	if (parseRes.code === 'err:unknown-command') {
		await SquadRcon.warn(ctx, msg.playerIds, parseRes.msg)
		return
	}

	const { cmd, args } = parseRes

	log.info('Command received: %s', cmd)

	const cmdConfig = Settings.GLOBAL_SETTINGS.commands[cmd as keyof typeof Settings.GLOBAL_SETTINGS.commands]
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

	const user: USR.GuiOrChatUserId = { steamId: player.ids.steam }
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
		}

		case 'endVoteEarly': {
			const res = await Vote.endVote(ctx, { reason: 'ended-early', endedBy: user })
			switch (res.code) {
				case 'ok':
					return { code: 'ok' as const }
				case 'err:no-vote-in-progress':
					return await showError('no-vote-in-progress', Messages.WARNS.vote.noVoteInProgress)
				case 'err:rcon':
					return await showError('rcon', res.msg)
				default: {
					assertNever(res)
					return
				}
			}
		}

		case 'help': {
			await SquadRcon.warn(
				ctx,
				msg.playerIds,
				Messages.WARNS.commands.help(Settings.GLOBAL_SETTINGS.commands, Settings.GLOBAL_SETTINGS.commandPrefix),
			)
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

		case 'switchNow': {
			if (!args.player) return await showError('missing-arg', 'Usage: /switchnow <player>')
			const teamsStateRes = await ctx.server.teams.get(ctx)
			if (teamsStateRes.code !== 'ok') return teamsStateRes
			const matchedPlayerRes = SM.PlayerIds.fuzzyMatchIdentifierUniquely(teamsStateRes.players, p => p.ids, args.player)
			if (matchedPlayerRes.code === 'err:not-found') {
				return await showError('not-found', `No player matches found for "${args.player}"`)
			}
			if (matchedPlayerRes.code === 'err:multiple-matches') {
				return await showError('multiple-matches', `${matchedPlayerRes.count} players match "${args.player}"`)
			}
			const target = matchedPlayerRes.matched
			if (!target.teamId) return await showError('no-team', `Player "${target.ids.username}" is not on a team`)
			const currentMatch = await MatchHistory.getCurrentMatch(ctx)
			const targetNormedTeam = MH.getNormedTeamId(target.teamId, currentMatch.ordinal)
			const toTeam: MH.NormedTeamId = targetNormedTeam === 'A' ? 'B' : 'A'
			const source: USR.GuiOrChatUserId = { steamId: player.ids.steam }
			const playerId = SM.PlayerIds.getPlayerId(target.ids)
			const errors = await Teamswitches.dispatchSwitchNow(ctx, new Map([[playerId, { toTeam, source }]]), source)
			if (errors.length > 0) {
				const err = errors[0] as TSW.OpError
				if (err.code === 'err:currently-switching') {
					return await showError('currently-switching', 'A team switch is currently in progress')
				}
			}
			await SquadRcon.warn(ctx, msg.playerIds, `Switching ${target.ids.username} to team ${toTeam} now`)
			return { code: 'ok' as const }
		}

		case 'switchNext': {
			if (!args.player) return await showError('missing-arg', 'Usage: /switchnext <player>')
			const teamsStateRes = await ctx.server.teams.get(ctx)
			if (teamsStateRes.code !== 'ok') return teamsStateRes
			const matchedPlayerRes = SM.PlayerIds.fuzzyMatchIdentifierUniquely(teamsStateRes.players, p => p.ids, args.player)
			if (matchedPlayerRes.code === 'err:not-found') {
				return await showError('not-found', `No player matches found for "${args.player}"`)
			}
			if (matchedPlayerRes.code === 'err:multiple-matches') {
				return await showError('multiple-matches', `${matchedPlayerRes.count} players match "${args.player}"`)
			}
			const target = matchedPlayerRes.matched
			if (!target.teamId) return await showError('no-team', `Player "${target.ids.username}" is not on a team`)
			const currentMatch = await MatchHistory.getCurrentMatch(ctx)
			const targetNormedTeam = MH.getNormedTeamId(target.teamId, currentMatch.ordinal)
			const toTeam: MH.NormedTeamId = targetNormedTeam === 'A' ? 'B' : 'A'
			const source: USR.GuiOrChatUserId = { steamId: player.ids.steam }
			const playerId = SM.PlayerIds.getPlayerId(target.ids)
			const errors = await Teamswitches.dispatchSwitchNext(ctx, new Map([[playerId, { toTeam, source }]]))
			if (errors.length > 0) {
				const err = errors[0] as TSW.OpError
				if (err.code === 'err:currently-switching') {
					return await showError('currently-switching', 'A team switch is currently in progress')
				}
				if (err.code === 'err:already-marked') {
					return await showError('already-marked', `${target.ids.username} is already marked for teamswitching`)
				}
			}
			await SquadRcon.warn(ctx, msg.playerIds, `Queued ${target.ids.username} to switch teams on next map`)
			return { code: 'ok' as const }
		}

		case 'switchSquadNow':
		case 'switchSquadNext': {
			// single-arg form: only a squad is given, team defaults to the caller's team
			const teamInput = args.squad ? args.team : undefined
			const squadInput = args.squad ?? args.team
			if (!squadInput) {
				return await showError(
					'missing-arg',
					`Usage: /${cmd === 'switchSquadNow' ? 'switchsquadnow' : 'switchsquadnext'} [team] <squad>`,
				)
			}
			const teamsStateRes = await ctx.server.teams.get(ctx)
			if (teamsStateRes.code !== 'ok') return teamsStateRes
			const currentMatch = await MatchHistory.getCurrentMatch(ctx)

			// resolve raw team ID (1|2) from input, or fall back to the caller's team
			let rawTeamId: SM.TeamId | null = null
			if (!teamInput) {
				if (!player.teamId) return await showError('no-team', 'You are not on a team; specify one explicitly')
				rawTeamId = player.teamId
			} else {
				const teamArg = teamInput.toUpperCase()
				if (teamArg === '1') {
					rawTeamId = 1
				} else if (teamArg === '2') {
					rawTeamId = 2
				} else if (teamArg === 'A' || teamArg === 'B') {
					rawTeamId = MH.getDenormedTeamId(teamArg as MH.NormedTeamId, currentMatch.ordinal)
				} else {
					const layer = L.toLayer(currentMatch.layerId)
					if (layer.Faction_1?.toUpperCase() === teamArg) rawTeamId = 1
					else if (layer.Faction_2?.toUpperCase() === teamArg) rawTeamId = 2
				}
				if (!rawTeamId) {
					return await showError('unknown-team', `Unknown team "${teamInput}". Use 1/2, A/B, or faction name.`)
				}
			}
			const teamLabel = teamInput ?? String(rawTeamId)

			// resolve squad by "cmd" alias, number or name
			const squadsOnTeam = teamsStateRes.squads.filter(s => s.teamId === rawTeamId)
			const squadNum = parseInt(squadInput)
			let matchedSquad: SM.Squad | null = null
			if (squadInput.toLowerCase() === 'cmd') {
				matchedSquad = squadsOnTeam.find(s => s.squadName === 'Command Squad') ?? null
				if (!matchedSquad) return await showError('not-found', `No command squad found on team ${teamLabel}`)
			} else if (!isNaN(squadNum)) {
				matchedSquad = squadsOnTeam.find(s => s.squadId === squadNum) ?? null
				if (!matchedSquad) return await showError('not-found', `No squad ${squadNum} found on team ${teamLabel}`)
			} else {
				const squadMatchRes = simpleUniqueStringMatch(squadsOnTeam.map(s => s.squadName.toLowerCase()), squadInput.toLowerCase())
				if (squadMatchRes.code === 'err:not-found') {
					return await showError('not-found', `No squad matches "${squadInput}" on team ${teamLabel}`)
				}
				if (squadMatchRes.code === 'err:multiple-matches') {
					return await showError('multiple-matches', `${squadMatchRes.count} squads match "${squadInput}"`)
				}
				matchedSquad = squadsOnTeam[squadMatchRes.matched]
			}

			const squadPlayers = teamsStateRes.players.filter(p => p.teamId === rawTeamId && p.squadId === matchedSquad!.squadId)
			if (squadPlayers.length === 0) {
				return await showError('empty-squad', `Squad "${matchedSquad.squadName}" has no players`)
			}

			const source: USR.GuiOrChatUserId = { steamId: player.ids.steam }
			if (cmd === 'switchSquadNow') {
				const switches: Map<SM.PlayerId, { toTeam: MH.NormedTeamId; source: USR.GuiOrChatUserId }> = new Map()
				for (const p of squadPlayers) {
					const normed = MH.getNormedTeamId(p.teamId!, currentMatch.ordinal)
					const toTeam: MH.NormedTeamId = normed === 'A' ? 'B' : 'A'
					switches.set(SM.PlayerIds.getPlayerId(p.ids), { toTeam, source })
				}
				const errors = await Teamswitches.dispatchSwitchNow(ctx, switches, source)
				if (errors.length > 0) {
					const err = errors[0] as TSW.OpError
					if (err.code === 'err:currently-switching') {
						return await showError('currently-switching', 'A team switch is currently in progress')
					}
				}
				await SquadRcon.warn(
					ctx,
					msg.playerIds,
					`Switching ${squadPlayers.length} players from "${matchedSquad.squadName}" to the opposite team now`,
				)
			} else {
				const nextSwitches: TSW.TeamswitchCollection = new Map(
					squadPlayers.map(p => {
						const normed = MH.getNormedTeamId(p.teamId!, currentMatch.ordinal)
						const toTeam: MH.NormedTeamId = normed === 'A' ? 'B' : 'A'
						return [SM.PlayerIds.getPlayerId(p.ids), { toTeam, source }] as const
					}),
				)
				const errors = await Teamswitches.dispatchSwitchNext(ctx, nextSwitches)
				const alreadyMarked = errors.filter(e => (e as TSW.OpError).code === 'err:already-marked').length
				if (alreadyMarked === nextSwitches.size) {
					return await showError('already-marked', `All players in "${matchedSquad.squadName}" are already marked for teamswitching`)
				}
				if (errors.some(e => (e as TSW.OpError).code === 'err:currently-switching')) {
					return await showError('currently-switching', 'A team switch is currently in progress')
				}
				const queued = nextSwitches.size - alreadyMarked
				await SquadRcon.warn(ctx, msg.playerIds, `Queued ${queued} players from "${matchedSquad.squadName}" to switch teams on next map`)
			}
			return { code: 'ok' as const }
		}

		case 'swaps': {
			const currentMatch = await MatchHistory.getCurrentMatch(ctx)
			const layer = L.toLayer(currentMatch.layerId)
			const switches = ctx.teamswitches.session.state.savedSwitches

			if (switches.size === 0) {
				await SquadRcon.warn(ctx, msg.playerIds, 'No swaps queued')
				return { code: 'ok' as const }
			}

			const factionA = layer[MH.getTeamNormalizedFactionProp(currentMatch.ordinal, 'A')] ?? 'Team A'
			const factionB = layer[MH.getTeamNormalizedFactionProp(currentMatch.ordinal, 'B')] ?? 'Team B'

			const toA: SM.PlayerId[] = []
			const toB: SM.PlayerId[] = []
			for (const [playerId, sw] of switches) {
				if (sw.toTeam === 'A') toA.push(playerId)
				else toB.push(playerId)
			}

			const parts = [
				toA.length > 0 ? `${toA.length} to current ${factionA}` : null,
				toB.length > 0 ? `${toB.length} to current ${factionB}` : null,
			].filter(Boolean)
			const header = `Swaps: ${parts.join(', ')}`

			if (switches.size <= 8) {
				const teamsStateRes = await ctx.server.teams.get(ctx)
				const players = teamsStateRes.code === 'ok' ? teamsStateRes.players : []
				const getName = (playerId: SM.PlayerId) => SM.PlayerIds.find(players, p => p.ids, playerId)?.ids.username ?? playerId
				const lines = [header]
				if (toA.length > 0) {
					lines.push(`\nto ${factionA}:`)
					for (const id of toA) lines.push(getName(id))
				}
				if (toB.length > 0) {
					lines.push(`\nto ${factionB}:`)
					for (const id of toB) lines.push(getName(id))
				}
				await SquadRcon.warn(ctx, msg.playerIds, lines.join('\n'))
			} else {
				await SquadRcon.warn(ctx, msg.playerIds, header)
			}
			return { code: 'ok' as const }
		}

		case 'clearSwitches': {
			const prevCount = ctx.teamswitches.session.state.savedSwitches.size
			if (prevCount === 0) {
				await SquadRcon.warn(ctx, msg.playerIds, 'No teamswitches queued')
				return { code: 'ok' as const }
			}
			const source: USR.GuiOrChatUserId = { steamId: player.ids.steam }
			await Teamswitches.dispatchClearSwitches(ctx, source)
			await SquadRcon.warn(ctx, msg.playerIds, `Cleared ${prevCount} queued teamswitch${prevCount !== 1 ? 'es' : ''}`)
			return { code: 'ok' as const }
		}

		case 'flag': {
			const teamsStateRes = await ctx.server.teams.get(ctx)
			if (teamsStateRes.code !== 'ok') {
				return teamsStateRes
			}
			if (!args.player) {
				return await showError('missing-player', 'Please provide a player and a flag')
			}

			if (!args.flag) {
				return await showError('missing-flag', 'Please provide a flag')
			}
			let matchedPlayerRes = SM.PlayerIds.fuzzyMatchIdentifierUniquely(teamsStateRes.players, p => p.ids, args.player)
			if (matchedPlayerRes.code === 'err:not-found') {
				return await showError('not-found', `No player matches found for "${args.player}.\nPlayer must be on the server."`)
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
			const reason = args.reason?.trim()
			if (Settings.GLOBAL_SETTINGS.playerFlagsRequiringNote.includes(flagToUpdate.id) && !reason) {
				return await showError(
					'note-required',
					`Flag "${flagToUpdate.name}" requires a reason: ${Settings.GLOBAL_SETTINGS.commandPrefix}flag ${args.player} ${args.flag} <reason>`,
				)
			}
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
				const note = [
					`Flag "${flagToUpdate.name}" added by ${player.ids.username} (Steam ${player.ids.steam}) via SLM.`,
					...(reason ? [`Reason: ${reason}`] : []),
				].join('\n')
				const noteAdded = await Battlemetrics.addPlayerNote(ctx, bmPlayerData.bmPlayerId, note).then(() => true).catch((err) => {
					log.warn({ err, targetIds }, 'failed to post BM note after adding flag')
					return false
				})
				await Battlemetrics.invalidateAndRefetchPlayer(ctx, targetIds.eos)
				await SquadRcon.warn(
					ctx,
					msg.playerIds,
					`Added flag "${flagToUpdate.name}" to ${targetIds.username}'s BM profile`
						+ (noteAdded ? '' : ', but failed to post the accompanying note'),
				)
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
				return await showError('not-found', `No player matches found for "${args.player}.\nPlayer must be on server."`)
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
				return await showError('not-found', `Player "${matchedPlayerRes.matched.ids.username}" does not have flag "${flagToRemove.name}".`)
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
