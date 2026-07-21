import * as Arr from '@/lib/array'
import * as Obj from '@/lib/object'
import { simpleUniqueStringMatch } from '@/lib/string'
import { assertNever } from '@/lib/type-guards'
import { formatHumanTime } from '@/lib/zod'
import * as Messages from '@/messages.ts'
import * as AAR from '@/models/admin-action-reasons.models'
import * as BB from '@/models/backburner.models'
import * as BM from '@/models/battlemetrics.models'
import * as CMD from '@/models/command.models.ts'
import type * as CS from '@/models/context-shared'
import * as LP from '@/models/labeled-presets.models'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import type * as TSW from '@/models/teamswaps.models'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'
import * as Battlemetrics from '@/systems/battlemetrics.server'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as Settings from '@/systems/settings.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Teamswaps from '@/systems/teamswaps.server'
import * as Timeouts from '@/systems/timeouts.server'
import * as Users from '@/systems/users.server'
import * as Vote from '@/systems/vote.server'

const module = initModule('commands')
let log!: CS.Logger

export function setup() {
	log = module.getLogger()
}

type HandlerResult = { code: string; msg?: string } | undefined

type HandlerCtx = {
	ctx: C.Db & C.ServerSlice
	msg: SM.RconEvents.ChatMessage
	// the resolved chat sender (steam id guaranteed)
	sender: SM.Player
	user: USR.GuiOrChatUserId
	reply: (opts: SquadRcon.WarnOptions) => Promise<void>
	error: <T extends string>(reason: T, msg: string) => Promise<{ code: `err:${T}`; msg: string }>
}

export async function handleCommand(ctx: C.Db & C.ServerSlice, msg: SM.RconEvents.ChatMessage) {
	if (!SM.CHAT_CHANNEL_TYPE.safeParse(msg.channelType).success) {
		return {
			code: 'err:invalid-chat-channel' as const,
			msg: 'Invalid chat channel',
		}
	}

	// all command feedback goes through reply(); admin-chat feedback carries the configured warnPrefix,
	// feedback to public chats (and all player-directed warns elsewhere) stays unprefixed
	const isAdminChat = msg.channelType === 'ChatAdmin'
	async function reply(opts: SquadRcon.WarnOptions) {
		await SquadRcon.warn(ctx, msg.playerIds, isAdminChat ? SquadRcon.withPrefixFlag(opts) : opts)
	}
	async function error<T extends string>(reason: T, errorMessage: string) {
		await reply(errorMessage)
		return {
			code: `err:${reason}` as const,
			msg: errorMessage,
		}
	}

	const playerRes = await SquadRcon.getPlayer(ctx, msg.playerIds)
	if (playerRes.code === 'err:rcon') {
		return await error('rcon-error', 'RCON error')
	}
	if (playerRes.code === 'err:player-not-found') {
		return await error('player-not-found', 'Player not found')
	}
	const sender = playerRes.player
	if (!sender.ids.steam) return { code: 'ok' as const }

	const user: USR.GuiOrChatUserId = { steamId: sender.ids.steam }
	const h: HandlerCtx = { ctx, msg, sender, user, reply, error }

	// an alias is a plain text substitution for a complete command, so it's expanded up front and everything after
	// this point (scope, enabled, arg resolution) runs against the command it points at. Anything typed after the
	// alias is dropped: aliases take no arguments of their own.
	const alias = CMD.findAlias(Settings.GLOBAL_SETTINGS.commandAliases, Settings.GLOBAL_SETTINGS.commands, msg.message.split(/\s+/)[0])
	if (alias) log.info('Command alias expanded: %s -> %s', alias.alias, alias.command)
	const effectiveMsg = alias ? { ...msg, message: alias.command } : msg

	const parseRes = CMD.parseCommand(effectiveMsg, Settings.GLOBAL_SETTINGS.commands)
	if (parseRes.code === 'err:unknown-command') {
		// just don't respond to unknown commands from non-admins
		if (!sender.isAdmin) return
		// an alias pointing at a command string that no longer exists: report the alias, not its stale expansion
		if (alias) return await error('unknown-command', `Alias "${alias.alias}" points at a command that no longer exists`)
		return await error('unknown-command', parseRes.msg)
	}

	const { cmd, tokens } = parseRes

	log.info('Command received: %s', cmd)

	const cmdConfig = Settings.GLOBAL_SETTINGS.commands[cmd as keyof typeof Settings.GLOBAL_SETTINGS.commands]
	if (!CMD.chatInScope(cmdConfig.scopes, msg.channelType)) {
		if (!sender.isAdmin && Obj.deepEqual(cmdConfig.scopes, ['admin'])) {
			// non-admin is trying to use admin command, just ignore them
			return
		}
		return await error('wrong-chat', Messages.WARNS.commands.wrongChat(cmdConfig.scopes))
	}

	if (!cmdConfig.enabled) {
		return await error('command-disabled', `Command "${cmd}" is disabled`)
	}

	const resolved = await resolveArgs(ctx, cmd, cmdConfig, tokens, sender)
	if (resolved.code !== 'ok') {
		return await error('invalid-args', resolved.msg)
	}

	// TS cannot correlate handlers[cmd] with CommandArgs<typeof cmd> across the union, so the args
	// are cast at this single dispatch point; each handler's signature is still fully typed
	return await handlers[cmd](h, resolved.args as never)
}

// resolves a chat team token: 1|2, normalized A|B, or the faction name of the current layer
function resolveTeamToken(currentMatch: MH.MatchDetails, token: string): SM.TeamId | null {
	const teamArg = token.toUpperCase()
	if (teamArg === '1') return 1
	if (teamArg === '2') return 2
	if (teamArg === 'A' || teamArg === 'B') return MH.getDenormedTeamId(teamArg as MH.NormedTeamId, currentMatch.ordinal)
	const layer = L.toLayer(currentMatch.layerId)
	if (layer.Faction_1?.toUpperCase() === teamArg) return 1
	if (layer.Faction_2?.toUpperCase() === teamArg) return 2
	return null
}

type TeamsState = { players: SM.Player[]; squads: SM.Squad[] }

// resolves a [team] <squad> token window: team falls back to the caller's team; squad by "cmd" alias,
// in-game number, or unique name substring
function resolveSquadArg(
	teamsState: TeamsState,
	currentMatch: MH.MatchDetails,
	sender: SM.Player,
	window: string[],
): { code: 'ok'; value: CMD.ResolvedSquadArg } | { code: 'err'; msg: string } {
	const teamInput = window.length === 2 ? window[0] : undefined
	const squadInput = window.length === 2 ? window[1] : window[0]

	let rawTeamId: SM.TeamId | null = null
	if (!teamInput) {
		if (!sender.teamId) return { code: 'err', msg: 'You are not on a team; specify one explicitly' }
		rawTeamId = sender.teamId
	} else {
		rawTeamId = resolveTeamToken(currentMatch, teamInput)
		if (!rawTeamId) {
			return { code: 'err', msg: `Unknown team "${teamInput}". Use 1/2, A/B, or faction name.` }
		}
	}
	const teamLabel = teamInput ?? String(rawTeamId)

	const squadsOnTeam = teamsState.squads.filter(s => s.teamId === rawTeamId)
	const squadNum = parseInt(squadInput)
	let matchedSquad: SM.Squad | null = null
	if (squadInput.toLowerCase() === 'cmd') {
		matchedSquad = squadsOnTeam.find(s => SM.isCommandSquad(s)) ?? null
		if (!matchedSquad) return { code: 'err', msg: `No command squad found on team ${teamLabel}` }
	} else if (!isNaN(squadNum)) {
		matchedSquad = squadsOnTeam.find(s => s.squadId === squadNum) ?? null
		if (!matchedSquad) return { code: 'err', msg: `No squad ${squadNum} found on team ${teamLabel}` }
	} else {
		const squadMatchRes = simpleUniqueStringMatch(squadsOnTeam.map(s => s.squadName.toLowerCase()), squadInput.toLowerCase())
		if (squadMatchRes.code === 'err:not-found') {
			return { code: 'err', msg: `No squad matches "${squadInput}" on team ${teamLabel}` }
		}
		if (squadMatchRes.code === 'err:multiple-matches') {
			return { code: 'err', msg: `${squadMatchRes.count} squads match "${squadInput}"` }
		}
		matchedSquad = squadsOnTeam[squadMatchRes.matched]
	}

	const players = teamsState.players.filter(p => p.teamId === rawTeamId && p.squadId === matchedSquad.squadId)
	return { code: 'ok', value: { teamId: rawTeamId, teamLabel, squad: matchedSquad, players } }
}

// central arg resolution: token windows via the declared arg kinds, then per-kind resolution.
// every failure surfaces as a single message the caller sends back to the sender.
async function resolveArgs<Id extends CMD.CommandId>(
	ctx: C.Db & C.ServerSlice,
	cmd: Id,
	cmdConfig: CMD.CommandConfig,
	tokens: string[],
	sender: SM.Player,
): Promise<{ code: 'ok'; args: CMD.CommandArgs<Id> } | { code: 'err'; msg: string }> {
	const defs = CMD.COMMAND_DECLARATIONS[cmd].args as readonly CMD.ArgDef[]
	const res = await resolveArgDefs(ctx, defs, tokens, sender)
	if (res.code === 'err:missing-arg') {
		return { code: 'err', msg: CMD.formatUsage(cmd, cmdConfig) }
	}
	if (res.code !== 'ok') return res
	return { code: 'ok', args: res.args as CMD.CommandArgs<Id> }
}

async function resolveArgDefs(
	ctx: C.Db & C.ServerSlice,
	defs: readonly CMD.ArgDef[],
	tokens: string[],
	sender: SM.Player,
): Promise<
	{ code: 'ok'; args: Record<string, unknown> } | { code: 'err'; msg: string } | { code: 'err:missing-arg'; argName: string }
> {
	let teamsState: TeamsState | undefined
	let currentMatch: MH.MatchDetails | undefined
	if (defs.some(d => d.kind === 'player' || d.kind === 'squad')) {
		const teamsRes = await ctx.server.teams.get(ctx)
		if (teamsRes.code !== 'ok') return { code: 'err', msg: 'Failed to fetch the current teams (RCON error)' }
		teamsState = teamsRes
		currentMatch = await MatchHistory.getCurrentMatch(ctx)
	}

	const preds: CMD.AssignPredicates = {
		isTeamToken: t => (currentMatch ? resolveTeamToken(currentMatch, t) !== null : false),
		isPresetToken: (action, t) => !!LP.findByLabelOrAlias(AAR.reasonsForAction(Settings.GLOBAL_SETTINGS.adminActionReasons, action), t),
	}
	const assignRes = CMD.assignArgTokens(defs, tokens, preds)
	if (assignRes.code === 'err:missing-arg') return assignRes

	const out: Record<string, unknown> = {}
	for (const def of defs) {
		const window = assignRes.windows[def.name]
		if (window === undefined) {
			out[def.name] = undefined
			continue
		}
		switch (def.kind) {
			case 'string':
				out[def.name] = window[0]
				break
			case 'int': {
				const res = CMD.coerceIntArg(def.name, window[0])
				if (res.code !== 'ok') return { code: 'err', msg: res.msg }
				out[def.name] = res.value
				break
			}
			case 'duration': {
				const res = CMD.resolveDurationArg(def.name, window[0])
				if (res.code !== 'ok') return { code: 'err', msg: res.msg }
				out[def.name] = res.value
				break
			}
			case 'text':
				out[def.name] = window.join(' ')
				break
			case 'player': {
				const res = SM.PlayerIds.fuzzyMatchIdentifierUniquely(teamsState!.players, p => p.ids, window[0])
				if (res.code === 'err:not-found') return { code: 'err', msg: `No player matches found for "${window[0]}"` }
				if (res.code === 'err:multiple-matches') return { code: 'err', msg: `${res.count} players match "${window[0]}"` }
				out[def.name] = res.matched
				break
			}
			case 'squad': {
				const res = resolveSquadArg(teamsState!, currentMatch!, sender, window)
				if (res.code !== 'ok') return res
				out[def.name] = res.value
				break
			}
			case 'reason': {
				const res = CMD.resolveReasonArg(Settings.GLOBAL_SETTINGS.adminActionReasons, def.action, window)
				if (res.code !== 'ok') return { code: 'err', msg: res.msg }
				out[def.name] = res.value
				break
			}
			case 'preset-reason': {
				const res = CMD.resolveReasonToken(Settings.GLOBAL_SETTINGS.adminActionReasons, def.action, window[0])
				if (res.code !== 'ok') return { code: 'err', msg: res.msg }
				out[def.name] = res.reason
				break
			}
			case 'broadcast': {
				const res = CMD.resolveBroadcastArg(Settings.GLOBAL_SETTINGS.broadcasts, window)
				if (res.code !== 'ok') return { code: 'err', msg: res.msg }
				out[def.name] = res.value
				break
			}
			default:
				def satisfies never
		}
	}
	return { code: 'ok', args: out }
}

function ingameActor(sender: SM.Player): { type: 'ingame-user'; playerId: SM.PlayerId } {
	return { type: 'ingame-user', playerId: SM.PlayerIds.getPlayerId(sender.ids) }
}

// swapping players to the other team is expressed relative to the current match ordinal
function oppositeNormedTeam(currentMatch: MH.MatchDetails, teamId: SM.TeamId): MH.NormedTeamId {
	return MH.getNormedTeamId(teamId, currentMatch.ordinal) === 'A' ? 'B' : 'A'
}

// exhaustive by construction: a new CommandId without a handler is a compile error
const handlers: { [Id in CMD.CommandId]: (h: HandlerCtx, args: CMD.CommandArgs<Id>) => Promise<HandlerResult> } = {
	help: async (h, args) => {
		await h.reply(
			Messages.WARNS.commands.help(
				Settings.GLOBAL_SETTINGS.commands,
				Settings.GLOBAL_SETTINGS.commandAliases,
				args.section,
			),
		)
		return { code: 'ok' }
	},

	startVote: async (h) => {
		const res = await Vote.startVote(h.ctx, { initiator: h.user })
		switch (res.code) {
			case 'err:permission-denied':
				return await h.error('permission-denied', Messages.WARNS.permissionDenied(res))
			case 'err:invalid-item-type':
			case 'err:public-vote-not-first':
			case 'err:vote-not-allowed':
			case 'err:item-not-found':
			case 'err:vote-in-progress':
			case 'err:editing-in-progress':
				return await h.error('vote-error', res.msg)
			case 'err:rcon':
				throw new Error(`RCON error`)
			case 'ok':
				return { code: 'ok' }
			default:
				assertNever(res)
		}
	},

	abortVote: async (h) => {
		const res = await Vote.abortVote(h.ctx, { aborter: h.user })
		switch (res.code) {
			case 'ok':
				return { code: 'ok' }
			case 'err:no-vote-in-progress':
				return await h.error('no-vote-in-progress', Messages.WARNS.vote.noVoteInProgress)
			default:
				assertNever(res)
		}
	},

	endVoteEarly: async (h) => {
		const res = await Vote.endVote(h.ctx, { reason: 'ended-early', endedBy: h.user })
		switch (res.code) {
			case 'ok':
				return { code: 'ok' }
			case 'err:no-vote-in-progress':
				return await h.error('no-vote-in-progress', Messages.WARNS.vote.noVoteInProgress)
			case 'err:rcon':
				return await h.error('rcon', res.msg)
			default:
				assertNever(res)
		}
	},

	showNext: async (h) => {
		await LayerQueue.warnShowNext(h.ctx, h.msg.playerIds)
		return { code: 'ok' }
	},

	enableSlmUpdates: (h) => toggleSlmUpdates(h, false),
	disableSlmUpdates: (h) => toggleSlmUpdates(h, true),

	getSlmUpdatesEnabled: async (h) => {
		const res = await LayerQueue.getSlmUpdatesEnabled(h.ctx)
		await h.reply(Messages.WARNS.slmUpdatesStatus(res.enabled))
		return { code: 'ok' }
	},

	requestFeedback: async (h, args) => {
		const res = await LayerQueue.requestFeedback(h.ctx, h.sender.ids.username, args.number)
		switch (res.code) {
			case 'err:empty':
			case 'err:not-found':
				return await h.error('not-found', 'Item not found')
			case 'ok':
				return { code: 'ok' }
			default:
				assertNever(res)
		}
	},

	swapNow: async (h, args) => {
		const target = args.player
		if (!target.teamId) return await h.error('no-team', `Player "${target.ids.username}" is not on a team`)
		const currentMatch = await MatchHistory.getCurrentMatch(h.ctx)
		const toTeam = oppositeNormedTeam(currentMatch, target.teamId)
		const playerId = SM.PlayerIds.getPlayerId(target.ids)
		const errors = await Teamswaps.dispatchSwapNow(h.ctx, new Map([[playerId, { toTeam, source: h.user }]]), h.user)
		if (errors.length > 0) {
			const err = errors[0] as TSW.OpError
			if (err.code === 'err:currently-swapping') {
				return await h.error('currently-swapping', 'A team swap is currently in progress')
			}
		}
		await h.reply(`Swapping ${target.ids.username} to team ${toTeam} now`)
		return { code: 'ok' }
	},

	swapNext: async (h, args) => {
		const target = args.player
		if (!target.teamId) return await h.error('no-team', `Player "${target.ids.username}" is not on a team`)
		const currentMatch = await MatchHistory.getCurrentMatch(h.ctx)
		const toTeam = oppositeNormedTeam(currentMatch, target.teamId)
		const playerId = SM.PlayerIds.getPlayerId(target.ids)
		const errors = await Teamswaps.dispatchSwapNext(h.ctx, new Map([[playerId, { toTeam, source: h.user }]]))
		if (errors.length > 0) {
			const err = errors[0] as TSW.OpError
			if (err.code === 'err:currently-swapping') {
				return await h.error('currently-swapping', 'A team swap is currently in progress')
			}
			if (err.code === 'err:already-marked') {
				return await h.error('already-marked', `${target.ids.username} is already marked to swap teams`)
			}
		}
		await h.reply(`Queued ${target.ids.username} to swap teams on next map`)
		return { code: 'ok' }
	},

	swapSquadNow: async (h, args) => {
		const { squad, players } = args.squad
		if (players.length === 0) return await h.error('empty-squad', `Squad "${squad.squadName}" has no players`)
		const currentMatch = await MatchHistory.getCurrentMatch(h.ctx)
		const swaps: Map<SM.PlayerId, { toTeam: MH.NormedTeamId; source: USR.GuiOrChatUserId }> = new Map()
		for (const p of players) {
			swaps.set(SM.PlayerIds.getPlayerId(p.ids), { toTeam: oppositeNormedTeam(currentMatch, p.teamId!), source: h.user })
		}
		const errors = await Teamswaps.dispatchSwapNow(h.ctx, swaps, h.user)
		if (errors.length > 0) {
			const err = errors[0] as TSW.OpError
			if (err.code === 'err:currently-swapping') {
				return await h.error('currently-swapping', 'A team swap is currently in progress')
			}
		}
		await h.reply(`Swapping ${players.length} players from "${squad.squadName}" to the opposite team now`)
		return { code: 'ok' }
	},

	swapSquadNext: async (h, args) => {
		const { squad, players } = args.squad
		if (players.length === 0) return await h.error('empty-squad', `Squad "${squad.squadName}" has no players`)
		const currentMatch = await MatchHistory.getCurrentMatch(h.ctx)
		const nextSwaps: TSW.TeamswapCollection = new Map(
			players.map(p => [SM.PlayerIds.getPlayerId(p.ids), { toTeam: oppositeNormedTeam(currentMatch, p.teamId!), source: h.user }] as const),
		)
		const errors = await Teamswaps.dispatchSwapNext(h.ctx, nextSwaps)
		const alreadyMarked = errors.filter(e => (e as TSW.OpError).code === 'err:already-marked').length
		if (alreadyMarked === nextSwaps.size) {
			return await h.error('already-marked', `All players in "${squad.squadName}" are already marked to swap teams`)
		}
		if (errors.some(e => (e as TSW.OpError).code === 'err:currently-swapping')) {
			return await h.error('currently-swapping', 'A team swap is currently in progress')
		}
		const queued = nextSwaps.size - alreadyMarked
		await h.reply(`Queued ${queued} players from "${squad.squadName}" to swap teams on next map`)
		return { code: 'ok' }
	},

	swaps: async (h) => {
		const currentMatch = await MatchHistory.getCurrentMatch(h.ctx)
		const layer = L.toLayer(currentMatch.layerId)
		const swaps = h.ctx.teamswaps.session.state.savedSwaps

		if (swaps.size === 0) {
			await h.reply('No swaps queued')
			return { code: 'ok' }
		}

		const factionA = layer[MH.getTeamNormalizedFactionProp(currentMatch.ordinal, 'A')] ?? 'Team A'
		const factionB = layer[MH.getTeamNormalizedFactionProp(currentMatch.ordinal, 'B')] ?? 'Team B'

		const toA: SM.PlayerId[] = []
		const toB: SM.PlayerId[] = []
		for (const [playerId, sw] of swaps) {
			if (sw.toTeam === 'A') toA.push(playerId)
			else toB.push(playerId)
		}

		const parts = [
			toA.length > 0 ? `${toA.length} to current ${factionA}` : null,
			toB.length > 0 ? `${toB.length} to current ${factionB}` : null,
		].filter(Boolean)
		const header = `Swaps: ${parts.join(', ')}`

		if (swaps.size <= 8) {
			const teamsStateRes = await h.ctx.server.teams.get(h.ctx)
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
			await h.reply(lines.join('\n'))
		} else {
			await h.reply(header)
		}
		return { code: 'ok' }
	},

	clearSwaps: async (h) => {
		// what's queued is only settled once the op is applied under the dispatch mutex, so the reply is driven by
		// the op's outcome rather than a pre-read of the state
		const errors = await Teamswaps.dispatchClearSwaps(h.ctx, h.user)
		if (errors.length > 0) {
			const err = errors[0] as TSW.OpError
			if (err.code === 'err:nothing-queued') {
				await h.reply('No teamswaps queued')
				return { code: 'ok' }
			}
			if (err.code === 'err:currently-swapping' || err.code === 'err:pending-swap') {
				return await h.error('currently-swapping', 'A team swap is currently in progress')
			}
			return await h.error('unexpected', 'Failed to clear queued teamswaps')
		}
		await h.reply('Cleared all queued teamswaps')
		return { code: 'ok' }
	},

	flag: async (h, args) => {
		const target = args.player
		const flags = await Battlemetrics.getOrgFlags(h.ctx)
		const matchedFlagRes = simpleUniqueStringMatch(flags.map(f => f.name), args.flag)
		if (matchedFlagRes.code === 'err:not-found') {
			return await h.error('not-found', `No flag matches found for "${args.flag}"`)
		}
		if (matchedFlagRes.code === 'err:multiple-matches') {
			return await h.error('multiple-matches', `Multiple(${matchedFlagRes.count}) flag matches found for "${args.flag}".`)
		}

		const flagToUpdate = flags[matchedFlagRes.matched]
		const reason = args.reason?.trim()
		if (Settings.GLOBAL_SETTINGS.playerFlagsRequiringNote.includes(flagToUpdate.id) && !reason) {
			return await h.error(
				'note-required',
				`Flag "${flagToUpdate.name}" requires a reason: ${CMD.formatUsage('flag', Settings.GLOBAL_SETTINGS.commands.flag)}`,
			)
		}
		const targetIds = target.ids
		const bmPlayerData = await Battlemetrics.fetchSinglePlayerBmData(h.ctx, targetIds)
		if (!bmPlayerData) {
			return await h.error('not-in-battlemetrics', `Unable to resolve player "${targetIds.username}" in battlemetrics`)
		}

		const res = await Battlemetrics.addPlayerFlags(h.ctx, bmPlayerData.bmPlayerId, [flagToUpdate.id])
		if (res.code === 'err:no-flags') return { code: 'ok' }
		if (res.code === 'player-already-has-flag') {
			return await h.error(res.code, `Player "${targetIds.username}" is already assigned flag "${flagToUpdate.name}"`)
		}
		if (res.code === 'ok') {
			const note = BM.flagChangeNote({
				action: 'added',
				flagName: flagToUpdate.name,
				actor: `${h.sender.ids.username} (Steam ${h.sender.ids.steam})`,
				reason,
			})
			const noteAdded = await Battlemetrics.addPlayerNote(h.ctx, bmPlayerData.bmPlayerId, note).then(() => true).catch((err) => {
				log.warn({ err, targetIds }, 'failed to post BM note after adding flag')
				return false
			})
			await Battlemetrics.invalidateAndRefetchPlayer(h.ctx, targetIds.eos)
			await h.reply(
				`Added flag "${flagToUpdate.name}" to ${targetIds.username}'s BM profile`
					+ (noteAdded ? '' : ', but failed to post the accompanying note'),
			)
			return { code: 'ok' }
		}
		assertNever(res)
	},

	removeFlag: async (h, args) => {
		const target = args.player
		const flags = await Battlemetrics.getOrgFlags(h.ctx)
		const matchedFlagRes = simpleUniqueStringMatch(flags.map(f => f.name), args.flag)
		if (matchedFlagRes.code === 'err:not-found') {
			return await h.error('not-found', `No flag matches found for "${args.flag}"`)
		}
		if (matchedFlagRes.code === 'err:multiple-matches') {
			return await h.error('multiple-matches', `Multiple(${matchedFlagRes.count}) flag matches found for "${args.flag}".`)
		}

		const flagToRemove = flags[matchedFlagRes.matched]
		const bmPlayerData = await Battlemetrics.fetchSinglePlayerBmData(h.ctx, target.ids)
		if (!bmPlayerData) {
			return await h.error('not-in-battlemetrics', `Unable to resolve player "${target.ids.username}" in battlemetrics`)
		}
		if (!bmPlayerData.flagIds.includes(flagToRemove.id)) {
			return await h.error('not-found', `Player "${target.ids.username}" does not have flag "${flagToRemove.name}".`)
		}

		const [status] = await Battlemetrics.removePlayerFlags(h.ctx, bmPlayerData.bmPlayerId, [flagToRemove.id])
		if (status === 'already-removed') {
			return await h.error(
				'already-removed',
				`Flag "${flagToRemove.name}" is already removed from ${target.ids.username}'s BM profile`,
			)
		}
		const note = BM.flagChangeNote({
			action: 'removed',
			flagName: flagToRemove.name,
			actor: `${h.sender.ids.username} (Steam ${h.sender.ids.steam})`,
			reason: args.reason?.trim(),
		})
		const noteAdded = await Battlemetrics.addPlayerNote(h.ctx, bmPlayerData.bmPlayerId, note).then(() => true).catch((err) => {
			log.warn({ err, targetIds: target.ids }, 'failed to post BM note after removing flag')
			return false
		})
		await Battlemetrics.invalidateAndRefetchPlayer(h.ctx, target.ids.eos)
		await h.reply(
			`Removed flag "${flagToRemove.name}" from ${target.ids.username}'s BM profile`
				+ (noteAdded ? '' : ', but failed to post the accompanying note'),
		)
		return { code: 'ok' }
	},

	listFlags: async (h, args) => {
		function formatFlagList(flags: BM.PlayerFlag[]) {
			if (flags.length === 0) {
				return 'none'
			}
			return Arr.paged(flags.map(f => f.name), 4).map(g => g.join('\n'))
		}
		const flags = await Battlemetrics.getOrgFlags(h.ctx)

		if (!args.player) {
			await h.reply(formatFlagList(flags))
			return { code: 'ok' }
		}

		const bmPlayerData = await Battlemetrics.fetchSinglePlayerBmData(h.ctx, args.player.ids)
		if (!bmPlayerData) {
			return await h.error('not-in-battlemetrics', `Unable to resolve player "${args.player.ids.username}" in battlemetrics`)
		}
		const playerFlags = flags.filter(f => bmPlayerData.flagIds.includes(f.id))

		await h.reply(formatFlagList(playerFlags))
		return { code: 'ok' }
	},

	warn: async (h, args) => {
		const target = args.player
		const targetId = SM.PlayerIds.getPlayerId(target.ids)
		const applied = CMD.applyResolvedReason('warn', args.reason, SquadServer.messageVars())
		const message = AAR.renderAppliedReason(applied)
		await SquadServer.warnPlayers(h.ctx, [targetId], message, ingameActor(h.sender), { reasonLabel: applied.label })
		// echo the exact delivered text so the admin sees what the player got (preset labels are embedded in it)
		await h.reply(`Warned ${target.ids.username}: "${message}"`)
		return { code: 'ok' }
	},

	listWarnReasons: async (h) => {
		const reasons = Settings.GLOBAL_SETTINGS.adminActionReasons
		if (reasons.length === 0) {
			await h.reply('No admin action reasons are configured')
			return { code: 'ok' }
		}
		// label + aliases + the actions each reason is set up for; the texts themselves are looked up at use time
		const actionsFor = (r: AAR.AdminActionReason) =>
			AAR.ADMIN_ACTION_TYPE.options
				.filter((a) => r.actionTexts[a] !== undefined)
				.map((a) => AAR.ADMIN_ACTIONS[a].displayName)
				.join(', ')
		const entries = reasons.map(r => {
			const head = r.aliases.length > 0 ? `${r.label} (${r.aliases.join(', ')})` : r.label
			return `${head}\n${actionsFor(r)}`
		})
		// each reason is a 2-line block (label, then its actions); blank line between blocks
		await h.reply(Arr.paged(entries, 3).map(g => g.join('\n\n')))
		return { code: 'ok' }
	},

	warnSquad: async (h, args) => {
		const { squad, players } = args.squad
		if (players.length === 0) return await h.error('empty-squad', `Squad "${squad.squadName}" has no players`)
		const targetIds = players.map(p => SM.PlayerIds.getPlayerId(p.ids))
		const applied = CMD.applyResolvedReason('warn', args.reason, SquadServer.messageVars())
		// squad warns carry the same @Squad tag the web squad warn box prepends
		const message = AAR.renderAppliedReason(applied, { squadTag: SM.squadWarnTag(squad) })
		await SquadServer.warnPlayers(h.ctx, targetIds, message, ingameActor(h.sender), { reasonLabel: applied.label })
		const currentMatch = await MatchHistory.getCurrentMatch(h.ctx)
		const squadLabel = SM.squadAdminLabel(squad, MH.getTeamFaction(currentMatch, args.squad.teamId))
		await h.reply(`Warned ${squadLabel}: "${message}"`)
		return { code: 'ok' }
	},

	kill: async (h, args) => {
		const g = await requireReasonGuard(h, 'kill', !!args.reason)
		if (g) return g
		const target = args.player
		const applied = args.reason && CMD.applyResolvedReason('kill', args.reason, SquadServer.messageVars())
		// the kill notify delivers the rendered reason verbatim (see WARNS.kill.notifyKilled)
		const reason = applied && AAR.renderAppliedReason(applied)
		await SquadServer.killPlayersAction(h.ctx, [SM.PlayerIds.getPlayerId(target.ids)], ingameActor(h.sender), reason, applied?.label)
		await h.reply(applied?.label ? `Killed ${target.ids.username} for ${applied.label}` : `Killed ${target.ids.username}`)
		return { code: 'ok' }
	},

	killSquad: async (h, args) => {
		const { squad, players } = args.squad
		if (players.length === 0) return await h.error('empty-squad', `Squad "${squad.squadName}" has no players`)
		const g = await requireReasonGuard(h, 'kill', !!args.reason)
		if (g) return g
		const targetIds = players.map(p => SM.PlayerIds.getPlayerId(p.ids))
		const applied = args.reason && CMD.applyResolvedReason('kill', args.reason, SquadServer.messageVars())
		const reason = applied && AAR.renderAppliedReason(applied)
		await SquadServer.killPlayersAction(h.ctx, targetIds, ingameActor(h.sender), reason, applied?.label)
		await h.reply(
			`Killed "${squad.squadName}" (${players.length} player${players.length !== 1 ? 's' : ''})${
				applied?.label ? ` for ${applied.label}` : ''
			}`,
		)
		return { code: 'ok' }
	},

	removeFromSquad: async (h, args) => {
		const target = args.player
		if (target.squadId == null) return await h.error('not-in-squad', `Player "${target.ids.username}" is not in a squad`)
		const g = await requireReasonGuard(h, 'remove-from-squad', !!args.reason)
		if (g) return g
		const applied = args.reason && CMD.applyResolvedReason('remove-from-squad', args.reason, SquadServer.messageVars())
		await SquadServer.removePlayersFromSquad(h.ctx, [SM.PlayerIds.getPlayerId(target.ids)], ingameActor(h.sender), applied || undefined)
		await h.reply(`Removed ${target.ids.username} from their squad${applied?.label ? ` for ${applied.label}` : ''}`)
		return { code: 'ok' }
	},

	disbandSquad: async (h, args) => {
		const g = await requireReasonGuard(h, 'disband-squad', !!args.reason)
		if (g) return g
		const { squad, teamLabel } = args.squad
		const applied = args.reason && CMD.applyResolvedReason('disband-squad', args.reason, SquadServer.messageVars())
		await SquadServer.disbandSquadAction(h.ctx, args.squad.teamId, squad.squadId, ingameActor(h.sender), applied || undefined)
		await h.reply(`Disbanded "${squad.squadName}" on team ${teamLabel}${applied?.label ? ` for ${applied.label}` : ''}`)
		return { code: 'ok' }
	},

	demoteCommander: async (h, args) => {
		const g = await requireReasonGuard(h, 'demote-commander', !!args.reason)
		if (g) return g
		const target = args.player
		const applied = args.reason && CMD.applyResolvedReason('demote-commander', args.reason, SquadServer.messageVars())
		await SquadServer.demoteCommanderAction(h.ctx, SM.PlayerIds.getPlayerId(target.ids), ingameActor(h.sender), applied || undefined)
		await h.reply(`Demoted ${target.ids.username}${applied?.label ? ` for ${applied.label}` : ''}`)
		return { code: 'ok' }
	},

	broadcast: async (h, args) => {
		if (args.message.type === 'preset') {
			await SquadServer.broadcastAction(h.ctx, args.message.preset.message, ingameActor(h.sender), {
				presetLabel: args.message.preset.label,
			})
		} else {
			await SquadServer.broadcastAction(h.ctx, args.message.text, ingameActor(h.sender))
		}
		await h.reply('Broadcast sent')
		return { code: 'ok' }
	},

	kick: async (h, args) => {
		return await executeKick(h, [args.player], args.reason, args.player.ids.username)
	},

	kickSquad: async (h, args) => {
		const { squad, players } = args.squad
		if (players.length === 0) return await h.error('empty-squad', `Squad "${squad.squadName}" has no players`)
		return await executeKick(h, players, args.reason, squadSubjectLabel(squad.squadName, players.length))
	},

	timeout: async (h, args) => {
		return await executeTimeout(h, [args.player], args.duration, args.reason, args.player.ids.username)
	},

	timeoutSquad: async (h, args) => {
		const { squad, players } = args.squad
		if (players.length === 0) return await h.error('empty-squad', `Squad "${squad.squadName}" has no players`)
		return await executeTimeout(h, players, args.duration, args.reason, squadSubjectLabel(squad.squadName, players.length))
	},

	clearTimeout: async (h, args) => {
		const linkedRes = await resolveLinkedSender(h)
		if (linkedRes.code !== 'ok') return linkedRes.res
		const denyRes = await Rbac.tryDenyAnyTimeoutGrant({ ...h.ctx, user: { discordId: linkedRes.discordId } })
		if (denyRes) return await h.error('permission-denied', Messages.WARNS.permissionDenied(denyRes))

		// the target may be offline, so match against players holding active timeouts rather than the roster
		const active = await Timeouts.listActiveTimeouts(h.ctx)
		const token = args.player
		let matches = active.filter(t => t.playerId === token || t.steamId?.toString() === token)
		if (matches.length === 0) {
			const lower = token.toLowerCase()
			matches = active.filter(t => (t.username ?? '').toLowerCase().includes(lower))
		}
		const matchedPlayerIds = new Set(matches.map(t => t.playerId))
		if (matchedPlayerIds.size === 0) return await h.error('not-found', `No active timeout matches "${token}"`)
		if (matchedPlayerIds.size > 1) return await h.error('multiple-matches', `${matchedPlayerIds.size} timed-out players match "${token}"`)
		for (const timeout of matches) {
			await Timeouts.cancelTimeout(h.ctx, { timeoutId: timeout.id, actor: ingameActor(h.sender), sliceCtx: h.ctx })
		}
		await h.reply(`Cancelled ${matches.length === 1 ? 'the timeout' : `${matches.length} timeouts`} for ${matches[0].username ?? token}`)
		return { code: 'ok' }
	},

	requestLayer: async (h, args) => {
		const linkedRes = await resolveLinkedSender(h)
		if (linkedRes.code !== 'ok') return linkedRes.res
		const tokens = args.request.split(/\s+/).filter(t => t.length > 0)
		const filterEntities = Array.from(FilterEntity.state.filters.values()).map(f => ({ id: f.id, name: f.name }))
		const resolveRes = BB.resolveRequestTokens({ tokens, components: L.StaticLayerComponents, filterEntities })
		if (resolveRes.code !== 'ok') return await h.error('invalid-request', resolveRes.msg)
		const source: USR.GuiOrChatUserId = { discordId: linkedRes.discordId, steamId: h.sender.ids.steam! }
		const res = await LayerQueue.addBackburnerRequestFromChat(h.ctx, {
			user: { discordId: linkedRes.discordId },
			source,
			filter: resolveRes.value.filter,
		})
		switch (res.code) {
			case 'err:permission-denied':
				return await h.error('permission-denied', Messages.WARNS.permissionDenied(res))
			case 'err:no-solutions':
				return await h.error('no-solutions', Messages.WARNS.layerRequests.noSolutions(args.request.trim()))
			case 'err:backburner-full':
				return await h.error('backburner-full', Messages.WARNS.layerRequests.backburnerFull(res.max))
			case 'ok': {
				const ownCount = BB.ownedItems(LayerQueue.getSavedBackburner(h.ctx), source).length
				await h.reply(Messages.WARNS.layerRequests.added(resolveRes.value.parts, ownCount, res.evicted.length))
				return { code: 'ok' }
			}
			default:
				assertNever(res)
		}
	},

	listLayerRequests: async (h) => {
		const items = LayerQueue.getSavedBackburner(h.ctx)
		if (items.length === 0) {
			await h.reply(Messages.WARNS.layerRequests.empty)
			return { code: 'ok' }
		}
		const owner = await resolveChatOwner(h)
		const pages = Arr.paged(BB.getLayerRequestSummary(items, LayerQueue.backburnerFilterName, owner), 4).map(page => page.join('\n'))
		for (const page of pages) await h.reply(page)
		return { code: 'ok' }
	},

	removeLayerRequest: async (h, args) => {
		const items = LayerQueue.getSavedBackburner(h.ctx)
		const owner = await resolveChatOwner(h)
		let target: BB.BackburnerItem | undefined
		if (args.number !== undefined) {
			target = items[args.number - 1]
			if (!target) return await h.error('not-found', `No layer request #${args.number}`)
		} else {
			const own = BB.ownedItems(items, owner)
			target = own[own.length - 1]
			if (!target) return await h.error('not-found', 'You have no layer requests queued')
		}
		if (!BB.sameOwner(target.source, owner)) {
			// removing someone else's request needs queue:write
			if (owner.discordId === undefined) {
				return await h.error('not-linked', Messages.WARNS.commands.steamAccountNotLinked())
			}
			const denyRes = await Rbac.tryDenyPermissionsForUser(
				{ ...h.ctx, user: { discordId: owner.discordId } },
				RBAC.perm('queue:write'),
			)
			if (denyRes) return await h.error('permission-denied', Messages.WARNS.permissionDenied(denyRes))
		}
		await LayerQueue.removeBackburnerRequestsFromChat(h.ctx, { itemIds: [target.itemId], source: owner })
		await h.reply(Messages.WARNS.layerRequests.removed(BB.describeTemplate(target.filter, LayerQueue.backburnerFilterName)))
		return { code: 'ok' }
	},
}

// the sender's identity for backburner ownership checks: their steam id plus their linked account, when one
// exists (GUI-created items only carry a discordId)
async function resolveChatOwner(h: HandlerCtx): Promise<USR.GuiOrChatUserId> {
	const steamId = h.sender.ids.steam!
	const linked = await Users.findUserBySteam64Id(h.ctx, BigInt(steamId))
	return { steamId, discordId: linked?.discordId }
}

// resolves the chat sender's linked SLM account for RBAC-gated commands
async function resolveLinkedSender(
	h: HandlerCtx,
): Promise<{ code: 'ok'; discordId: bigint } | { code: 'err'; res: HandlerResult }> {
	if (!h.sender.ids.steam) return { code: 'err', res: await h.error('missing-steam-id', Messages.WARNS.commands.missingSteamId()) }
	const linked = await Users.findUserBySteam64Id(h.ctx, BigInt(h.sender.ids.steam))
	if (!linked) return { code: 'err', res: await h.error('not-linked', Messages.WARNS.commands.steamAccountNotLinked()) }
	return { code: 'ok', discordId: linked.discordId }
}

// enforces the per-action "require a reason" setting; returns the error handler-result to short-circuit, or null
async function requireReasonGuard(h: HandlerCtx, action: AAR.AdminActionType, hasReason: boolean): Promise<HandlerResult | null> {
	const rr = SquadServer.reasonRequirementError(action, hasReason)
	return rr ? await h.error('reason-required', rr.msg) : null
}

function squadSubjectLabel(squadName: string, playerCount: number) {
	return `"${squadName}" (${playerCount} player${playerCount !== 1 ? 's' : ''})`
}

async function executeKick(
	h: HandlerCtx,
	targets: SM.Player[],
	resolvedReason: CMD.ResolvedReasonArg | undefined,
	subjectLabel: string,
): Promise<HandlerResult> {
	const g = await requireReasonGuard(h, 'kick', !!resolvedReason)
	if (g) return g
	const linkedRes = await resolveLinkedSender(h)
	if (linkedRes.code !== 'ok') return linkedRes.res
	const denyRes = await Rbac.tryDenyPermissionsForUser(
		{ ...h.ctx, user: { discordId: linkedRes.discordId } },
		RBAC.perm('squad-server:kick-players'),
	)
	if (denyRes) return await h.error('permission-denied', Messages.WARNS.permissionDenied(denyRes))
	const reason = resolvedReason && CMD.applyResolvedReason('kick', resolvedReason, SquadServer.messageVars())
	await SquadServer.kickPlayersAction(
		h.ctx,
		targets.map(t => SM.PlayerIds.getPlayerId(t.ids)),
		ingameActor(h.sender),
		reason || undefined,
	)
	await h.reply(`Kicked ${subjectLabel}${reason?.label ? ` for ${reason.label}` : ''}`)
	return { code: 'ok' }
}

// shared by the timeout commands and the fixed-duration timeout aliases
async function executeTimeout(
	h: HandlerCtx,
	targets: SM.Player[],
	durationMs: number,
	resolvedReason: CMD.ResolvedReasonArg | undefined,
	subjectLabel: string,
): Promise<HandlerResult> {
	const g = await requireReasonGuard(h, 'timeout', !!resolvedReason)
	if (g) return g
	const linkedRes = await resolveLinkedSender(h)
	if (linkedRes.code !== 'ok') return linkedRes.res
	const denyRes = await Rbac.tryDenyTimeoutForUser({ ...h.ctx, user: { discordId: linkedRes.discordId } }, durationMs)
	if (denyRes) return await h.error('permission-denied', Messages.WARNS.permissionDenied(denyRes))
	const vars = SquadServer.messageVars({ duration: formatHumanTime(durationMs) })
	const reason = resolvedReason && CMD.applyResolvedReason('timeout', resolvedReason, vars)
	const skipped: string[] = []
	let lastErrMsg = ''
	for (const target of targets) {
		const res = await Timeouts.kickWithTimeout(h.ctx, { target, durationMs, actor: ingameActor(h.sender), reason })
		if (res.code === 'err:already-timed-out') {
			skipped.push(target.ids.username ?? SM.PlayerIds.getPlayerId(target.ids))
			lastErrMsg = res.msg
		}
	}
	if (skipped.length === targets.length) {
		return await h.error(
			'already-timed-out',
			targets.length === 1 ? lastErrMsg : `All ${targets.length} players already have active timeouts`,
		)
	}
	await h.reply([
		`Timed out ${subjectLabel} for ${formatHumanTime(durationMs)}${reason?.label ? ` for ${reason.label}` : ''}`,
		...(skipped.length > 0 ? [`Skipped (already timed out): ${skipped.join(', ')}`] : []),
	].join('\n'))
	return { code: 'ok' }
}

async function toggleSlmUpdates(h: HandlerCtx, disabled: boolean): Promise<HandlerResult> {
	const res = await LayerQueue.toggleUpdatesToSquadServer({ ctx: h.ctx, input: { disabled } })
	switch (res.code) {
		case 'ok':
			return { code: 'ok' }
		case 'err:permission-denied':
			await h.reply(Messages.WARNS.permissionDenied(res))
			return res
		default:
			assertNever(res)
	}
}
