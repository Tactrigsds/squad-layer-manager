import * as Arr from '@/lib/array-utils'
import * as Obj from '@/lib/object-utils'
import * as Str from '@/lib/string-utils'
import { assertNever } from '@/lib/type-guards'
import * as ZodUtils from '@/lib/zod-utils'
import * as BB_Msgs from '@/messages/backburner.messages'
import * as CMD_Msgs from '@/messages/command.messages'
import * as RBAC_Msgs from '@/messages/rbac.messages'
import * as SS_Msgs from '@/messages/server-state.messages'
import * as TSW_Msgs from '@/messages/teamswaps.messages'
import * as V_Msgs from '@/messages/vote.messages'
import * as AAR from '@/models/admin-action-reasons.models'
import * as BB from '@/models/backburner.models'
import * as BM from '@/models/battlemetrics.models'
import * as CMDH from '@/models/command-help.models'
import * as CMD from '@/models/command.models.ts'
import type * as CS from '@/models/context-shared'
import * as LP from '@/models/labeled-presets.models'
import * as L from '@/models/layer'
import * as MH from '@/models/match-history.models'
import type * as SR from '@/models/squad-rcon.models'
import * as SM from '@/models/squad.models'
import type * as TSW from '@/models/teamswaps.models'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'
import * as Battlemetrics from '@/systems/battlemetrics.server'
import * as CommandPrompts from '@/systems/command-prompts.server'
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

// What every message from a chat sender is handled against, whether it runs a command or answers a prompt.
type ChatCtx = {
	ctx: C.Db & C.ManagedServer & Partial<USR.Ctx> & SM.Ctx.Player
	msg: SM.RconEvents.ChatMessage
	// the resolved chat sender (steam id guaranteed)
	sender: SM.Player
	user: USR.GuiOrChatUserId
	reply: (opts: SR.WarnInput) => Promise<void>
	error: <T extends string>(reason: T, msg: string) => Promise<{ code: `err:${T}`; msg: string }>
}

// How this run of the command was reached, so a lookup that fails inside a handler can offer choices the same way
// argument resolution does. `ranges` says where each argument sits in `tokens`, which is what a pick replaces.
type Invocation = {
	cmd: CMD.CommandId
	trigger: CMD.CommandTrigger
	tokens: string[]
	ranges: CMD.ArgTokenRanges
	// the command as the caller typed it, carried through a replay: by then the chat message in hand is their
	// answer, which is not what a notice about the pending command should quote
	typed: string
}

type HandlerCtx = ChatCtx & {
	invocation: Invocation
	// Raises a prompt for an argument this handler resolved itself. Only safe before the handler has changed
	// anything: answering replays the whole command, so a side effect ahead of the prompt would happen twice.
	nearMiss: (argName: string, opts: Omit<NearMissResult, 'code'>) => Promise<HandlerResult>
}

// the sender's own identity, which is what a prompt is keyed by
function chatPlayerId(msg: SM.RconEvents.ChatMessage): SM.PlayerId {
	return SM.PlayerIds.getPlayerId(msg.playerIds)
}

type Exchange = { code: 'ok'; chat: ChatCtx } | { code: 'done'; result: HandlerResult }

// the sender lookup and reply helpers every chat message needs before anything can be decided about it
async function openExchange(baseCtx: C.Db & C.ManagedServer & CS.AbortSignal, msg: SM.RconEvents.ChatMessage): Promise<Exchange> {
	if (!SM.CHAT_CHANNEL_TYPE.safeParse(msg.channelType).success) {
		return { code: 'done', result: { code: 'err:invalid-chat-channel', msg: 'Invalid chat channel' } }
	}

	async function reply(opts: SR.WarnInput) {
		await SquadRcon.warn(baseCtx, msg.playerIds, opts)
	}
	async function error<T extends string>(reason: T, errorMessage: string) {
		await reply(errorMessage)
		return {
			code: `err:${reason}` as const,
			msg: errorMessage,
		}
	}

	const playerRes = await SquadRcon.getPlayer(baseCtx, msg.playerIds)
	if (playerRes.code === 'err:rcon') {
		return { code: 'done', result: await error('rcon-error', baseCtx.tr.text(CMD_Msgs.rconError())) }
	}
	if (playerRes.code === 'err:player-not-found') {
		return { code: 'done', result: await error('player-not-found', baseCtx.tr.text(CMD_Msgs.playerNotFound())) }
	}
	const sender = playerRes.player
	if (!sender.ids.steam) return { code: 'done', result: { code: 'ok' } }
	// const roles = Rbac.getRolesForIngameUser(ctx, sender.ids as SM.PlayerIds.IdQuery<'steam' | 'eos'>)
	const discordId = await Users.findDiscordIdBySteam64Id(baseCtx, BigInt(sender.ids.steam!))

	const user = discordId ? await Users.getUser(baseCtx, discordId) : undefined
	const ctx: ChatCtx['ctx'] = Obj.trimUndefined({ ...baseCtx, user, player: sender })
	return { code: 'ok', chat: { ctx, msg, sender, user: { discordId, steamId: sender.ids.steam }, reply, error } }
}

export async function handleCommand(baseCtx: C.Db & C.ManagedServer & CS.AbortSignal, msg: SM.RconEvents.ChatMessage) {
	const exchange = await openExchange(baseCtx, msg)
	if (exchange.code === 'done') return exchange.result
	const chat = exchange.chat
	const { ctx, sender } = chat

	// Typing another command means this one has been left behind, and a choice nobody remembers making is how a
	// stale prompt turns a bare number into a moderation action. Unrecognised commands count: the caller has still
	// moved on.
	const superseded = CommandPrompts.take(ctx.serverId, chatPlayerId(msg))
	if (superseded) await chat.reply(CMD_Msgs.Prompt.superseded(superseded.typed))

	// the trigger that matched decides the arguments: a plain one takes them as typed, one with an args template
	// pins some of them and feeds the rest through its placeholders (see CMD.parseCommand)
	const parseRes = CMD.parseCommand(msg, Settings.GLOBAL_SETTINGS.commands)
	if (parseRes.code === 'err:unknown-command') {
		// just don't respond to unknown commands from non-admins
		if (!sender.isAdmin) return
		return await chat.error('unknown-command', parseRes.msg)
	}

	const { cmd, trigger, tokens } = parseRes

	if (CMD.triggerArgs(trigger) !== undefined) {
		log.info('Command trigger %s ran %s with: %s', CMD.triggerString(trigger), cmd, tokens.join(' '))
	}
	log.info('Command received: %s', cmd)

	return await runCommand(chat, cmd, trigger, tokens, msg.message.trim())
}

// Everything a recognised command does: the gates, the arguments, the handler. Reached a second time when a caller
// answers a prompt, with their picks spliced into `tokens` -- which is why the gates live here and not in
// handleCommand. Permissions and the live roster are checked against the moment the command actually runs.
async function runCommand(
	chat: ChatCtx,
	cmd: CMD.CommandId,
	trigger: CMD.CommandTrigger,
	tokens: string[],
	typed: string,
): Promise<HandlerResult> {
	const { ctx, sender, msg } = chat
	const cmdConfig = Settings.GLOBAL_SETTINGS.commands[cmd as keyof typeof Settings.GLOBAL_SETTINGS.commands]
	if (!CMD.chatAllowed(cmdConfig.allowedChats, msg.channelType)) {
		if (!sender.isAdmin && Obj.deepEqual(cmdConfig.allowedChats, ['admin'])) {
			// non-admin is trying to use admin command, just ignore them
			return
		}
		return await chat.error('wrong-chat', ctx.tr.text(CMD_Msgs.wrongChat(cmdConfig.allowedChats)))
	}

	if (!cmdConfig.enabled) {
		return await chat.error('command-disabled', ctx.tr.text(CMD_Msgs.commandDisabled(cmd)))
	}

	// Authorization sits here, next to the allowed-chat and enabled gates, rather than in each handler: the declaration is
	// exhaustive over CommandId, so a command cannot reach its handler without having stated what it requires.
	// Being in admin chat is not authorization on its own -- that is Squad's admin list, not SLM's roles.
	const permission = CMD.COMMAND_DECLARATIONS[cmd].permission
	if (permission !== null) {
		const required =
			permission === 'battlemetrics:write-flags'
				? RBAC.perm('battlemetrics:write-flags')
				: RBAC.perm(permission, { serverId: ctx.serverId })
		const denyRes = await Rbac.tryDenyPermissionsForPlayer(ctx, required)
		if (denyRes) return await chat.error('permission-denied', ctx.tr.text(RBAC_Msgs.permissionDenied(denyRes)))
	}

	const resolved = await resolveArgs(ctx, cmd, cmdConfig, tokens, sender, trigger)
	if (resolved.code === 'err:near-miss') {
		return await raisePrompt(chat, { cmd, trigger, tokens, typed, ranges: resolved.ranges }, resolved.nearMisses)
	}
	if (resolved.code !== 'ok') {
		return await chat.error('invalid-args', resolved.msg)
	}

	const invocation: Invocation = { cmd, trigger, tokens, typed, ranges: resolved.ranges }
	const h: HandlerCtx = {
		...chat,
		invocation,
		nearMiss: (argName, opts) => raisePrompt(chat, invocation, [{ argName, ...opts }]),
	}

	// TS cannot correlate handlers[cmd] with CommandArgs<typeof cmd> across the union, so the args
	// are cast at this single dispatch point; each handler's signature is still fully typed
	return await handlers[cmd](h, resolved.args as never)
}

// Asks the caller to pick, and holds what to run once they have. The command itself does not run: every near miss
// is raised before anything has been applied, so replaying the whole command later repeats nothing.
async function raisePrompt(chat: ChatCtx, invocation: Invocation, nearMisses: CMD.NearMiss[]): Promise<HandlerResult> {
	const steps = nearMisses.flatMap((near) => {
		const range = invocation.ranges[near.argName]
		// nothing to offer, or an argument that never came from the caller's words and so has nothing to splice a
		// pick over: either way they have to retype, and the resolver's message already says why
		if (near.choices.length === 0 || !range) return []
		return [{ argName: near.argName, typed: near.typed, range, msg: near.msg, choices: near.choices }]
	})
	if (steps.length === 0) return await chat.error('invalid-args', nearMisses[0].msg)

	const session: CommandPrompts.PromptSession = {
		cmd: invocation.cmd,
		trigger: invocation.trigger,
		tokens: invocation.tokens,
		typed: invocation.typed,
		channel: chat.msg.channelType,
		steps,
		picks: steps.map(() => undefined),
		expiresAt: Date.now() + CommandPrompts.TTL_MS,
	}
	CommandPrompts.set(chat.ctx.serverId, chatPlayerId(chat.msg), session)
	log.info('Command %s asked %s for %d choice(s)', invocation.cmd, chat.sender.ids.username, steps.length)
	await askStep(chat, session, 0)
	return { code: 'ok' }
}

async function askStep(chat: ChatCtx, session: CommandPrompts.PromptSession, index: number) {
	const step = session.steps[index]
	await chat.reply(CMD_Msgs.Prompt.question({ msg: step.msg, choices: step.choices, step: index + 1, total: session.steps.length }))
}

// A caller answering the choices they were asked for. Numbers fill the outstanding questions in order, so several
// in one message answer several at once; 0 cancels; the command runs once nothing is left unanswered.
export async function handleChoiceAnswer(baseCtx: C.Db & C.ManagedServer & CS.AbortSignal, msg: SM.RconEvents.ChatMessage) {
	const exchange = await openExchange(baseCtx, msg)
	if (exchange.code === 'done') return exchange.result
	const chat = exchange.chat
	const playerId = chatPlayerId(msg)
	const session = CommandPrompts.take(chat.ctx.serverId, playerId)
	if (!session) return { code: 'ok' as const }

	if (CommandPrompts.expired(session, Date.now())) {
		await chat.reply(CMD_Msgs.Prompt.expired(session.typed))
		return { code: 'ok' as const }
	}

	let picks = session.picks
	for (const answer of CommandPrompts.parseAnswer(msg.message)) {
		const index = CommandPrompts.nextStep({ ...session, picks })
		if (index === undefined) break
		if (answer === 0) {
			await chat.reply(CMD_Msgs.Prompt.cancelled())
			return { code: 'ok' as const }
		}
		const choice = session.steps[index].choices[answer - 1]
		if (!choice) {
			// the session survives a mistyped number: it was solicited, and losing it would mean retyping the command
			CommandPrompts.set(chat.ctx.serverId, playerId, { ...session, picks })
			await chat.reply(CMD_Msgs.Prompt.outOfRange(session.steps[index].choices.length))
			return { code: 'ok' as const }
		}
		picks = picks.with(index, choice)
	}

	const answered = { ...session, picks }
	const remaining = CommandPrompts.nextStep(answered)
	if (remaining !== undefined) {
		CommandPrompts.set(chat.ctx.serverId, playerId, { ...answered, expiresAt: Date.now() + CommandPrompts.TTL_MS })
		await askStep(chat, answered, remaining)
		return { code: 'ok' as const }
	}

	return await runCommand(chat, session.cmd, session.trigger, CommandPrompts.resolvedTokens(answered), session.typed)
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

// A failure the caller can fix by picking one of `choices`, as against retyping. `msg` is what they see when
// nothing was close enough, which is why every near miss carries one.
type NearMissResult = { code: 'err:near-miss'; msg: string; typed: string; cause: CMD.NearMiss['cause']; choices: CMD.ArgChoice[] }

function nearMiss(opts: Omit<NearMissResult, 'code'>): NearMissResult {
	return { code: 'err:near-miss', ...opts }
}

// A squad is picked back as "<team> <squad number>" rather than by name: both tokens are unambiguous, and the pair
// re-assigns to the same argument window whatever the caller originally typed (see assignArgTokens).
function squadChoices(teamId: SM.TeamId, squads: SM.Squad[]): CMD.ArgChoice[] {
	return squads.map((squad) => ({
		tokens: [String(teamId), String(squad.squadId)],
		label: `${squad.squadName} (team ${teamId} squad ${squad.squadId})`,
	}))
}

// resolves a [team] <squad> token window: team falls back to the caller's team; squad by "cmd" alias,
// in-game number, or unique name substring
function resolveSquadArg(
	teamsState: TeamsState,
	currentMatch: MH.MatchDetails,
	sender: SM.Player,
	window: string[],
): { code: 'ok'; value: CMD.ResolvedSquadArg } | { code: 'err'; msg: string } | NearMissResult {
	const teamInput = window.length === 2 ? window[0] : undefined
	const squadInput = window.length === 2 ? window[1] : window[0]

	let rawTeamId: SM.TeamId | null = null
	if (!teamInput) {
		if (!sender.teamId) return { code: 'err', msg: 'You are not on a team; specify one explicitly' }
		rawTeamId = sender.teamId
	} else {
		rawTeamId = resolveTeamToken(currentMatch, teamInput)
		if (!rawTeamId) {
			const layer = L.toLayer(currentMatch.layerId)
			const factions = [layer.Faction_1, layer.Faction_2]
			return nearMiss({
				// both teams are always offered, so telling the caller how to name one is a line spent on advice the
				// prompt underneath makes unnecessary
				msg: `Unknown team "${teamInput}"`,
				typed: teamInput,
				cause: 'no-match',
				// the squad token is carried through, so picking a team only replaces the team half of the window
				choices: ([1, 2] as const).map((teamId) => ({
					tokens: [String(teamId), squadInput],
					label: factions[teamId - 1] ? `Team ${teamId} (${factions[teamId - 1]})` : `Team ${teamId}`,
				})),
			})
		}
	}
	const teamLabel = teamInput ?? String(rawTeamId)

	const squadsOnTeam = teamsState.squads.filter((s) => s.teamId === rawTeamId)
	const squadNum = parseInt(squadInput)
	let matchedSquad: SM.Squad | null = null
	if (squadInput.toLowerCase() === 'cmd') {
		matchedSquad = squadsOnTeam.find((s) => SM.isCommandSquad(s)) ?? null
		if (!matchedSquad) return { code: 'err', msg: `No command squad found on team ${teamLabel}` }
	} else if (!isNaN(squadNum)) {
		matchedSquad = squadsOnTeam.find((s) => s.squadId === squadNum) ?? null
		if (!matchedSquad) return { code: 'err', msg: `No squad ${squadNum} found on team ${teamLabel}` }
	} else {
		const squadMatchRes = Str.simpleUniqueStringMatch(
			squadsOnTeam.map((s) => s.squadName.toLowerCase()),
			squadInput.toLowerCase(),
		)
		if (squadMatchRes.code === 'err:not-found') {
			return nearMiss({
				msg: `No squad matches "${squadInput}" on team ${teamLabel}`,
				typed: squadInput,
				cause: 'no-match',
				choices: squadChoices(
					rawTeamId,
					Str.nearestBy(squadInput, squadsOnTeam, (s) => s.squadName, CMD.MAX_CHOICES),
				),
			})
		}
		if (squadMatchRes.code === 'err:multiple-matches') {
			const matched = Str.simpleStringMatch(
				squadsOnTeam.map((s) => s.squadName.toLowerCase()),
				squadInput.toLowerCase(),
			).map((idx) => squadsOnTeam[idx])
			return nearMiss({
				msg: `${squadMatchRes.count} squads match "${squadInput}"`,
				typed: squadInput,
				cause: 'ambiguous',
				choices: squadChoices(rawTeamId, matched.slice(0, CMD.MAX_CHOICES)),
			})
		}
		matchedSquad = squadsOnTeam[squadMatchRes.matched]
	}

	const players = teamsState.players.filter((p) => p.teamId === rawTeamId && p.squadId === matchedSquad.squadId)
	return { code: 'ok', value: { teamId: rawTeamId, teamLabel, squad: matchedSquad, players } }
}

// The players a mistyped token might have meant: the ones it actually matched when it matched too many, the closest
// usernames when it matched none. Picked back as a player id, which resolves to exactly one player.
function playerChoices(players: SM.Player[], typed: string, cause: CMD.NearMiss['cause']): CMD.ArgChoice[] {
	const named = players.filter((p) => p.ids.username)
	const picked =
		cause === 'ambiguous'
			? named.filter((p) => Str.normalizeForMatch(p.ids.username!).includes(Str.normalizeForMatch(typed))).slice(0, CMD.MAX_CHOICES)
			: Str.nearestBy(typed, named, (p) => p.ids.username!, CMD.MAX_CHOICES)
	return picked.map((p) => ({ tokens: [p.ids.steam ?? p.ids.eos], label: p.ids.username! }))
}

// central arg resolution: token windows via the declared arg kinds, then per-kind resolution.
// every failure surfaces as a single message the caller sends back to the sender.
//
// A missing argument is reported against the trigger that was typed, not the command's own signature: `/to2h` typed
// bare runs `/timeout` with only `2h`, whose honest complaint names <duration>, which that trigger pins and the
// caller has no way to supply.
async function resolveArgs<Id extends CMD.CommandId>(
	ctx: C.Db & C.ManagedServer,
	cmd: Id,
	cmdConfig: CMD.CommandConfig,
	tokens: string[],
	sender: SM.Player,
	trigger?: CMD.CommandTrigger,
): Promise<
	| { code: 'ok'; args: CMD.CommandArgs<Id>; ranges: CMD.ArgTokenRanges }
	| { code: 'err'; msg: string }
	| { code: 'err:near-miss'; nearMisses: CMD.NearMiss[]; ranges: CMD.ArgTokenRanges }
> {
	const defs = CMD.COMMAND_DECLARATIONS[cmd].args as readonly CMD.ArgDef[]
	const res = await resolveArgDefs(ctx, defs, tokens, sender)
	if (res.code === 'err:missing-arg') {
		return { code: 'err', msg: CMD.formatUsage(cmd, cmdConfig, trigger, Settings.GLOBAL_SETTINGS.requireReasonFor) }
	}
	if (res.code !== 'ok') return res
	return { code: 'ok', args: res.args as CMD.CommandArgs<Id>, ranges: res.ranges }
}

// Every choice-fixable failure is collected rather than the first one reported, so a caller who mistyped two
// arguments answers for both in one exchange. A failure they cannot fix by picking still wins: answering two
// prompts and only then being told the duration is unparseable is worse than being told immediately.
async function resolveArgDefs(
	ctx: C.Db & C.ManagedServer,
	defs: readonly CMD.ArgDef[],
	tokens: string[],
	sender: SM.Player,
): Promise<
	| { code: 'ok'; args: Record<string, unknown>; ranges: CMD.ArgTokenRanges }
	| { code: 'err'; msg: string }
	| { code: 'err:missing-arg'; argName: string }
	| { code: 'err:near-miss'; nearMisses: CMD.NearMiss[]; ranges: CMD.ArgTokenRanges }
> {
	let teamsState: TeamsState | undefined
	let currentMatch: MH.MatchDetails | undefined
	if (defs.some((d) => d.kind === 'player' || d.kind === 'squad')) {
		const teamsRes = await ctx.squadRcon.teams.get(ctx)
		if (teamsRes.code !== 'ok') return { code: 'err', msg: 'Failed to fetch the current teams (RCON error)' }
		teamsState = teamsRes
		currentMatch = await MatchHistory.getCurrentMatch(ctx)
	}

	const preds: CMD.AssignPredicates = {
		isTeamToken: (t) => (currentMatch ? resolveTeamToken(currentMatch, t) !== null : false),
		isPresetToken: (action, t) => !!LP.findByKeyword(AAR.reasonsForAction(Settings.GLOBAL_SETTINGS.adminActionReasons, action), t),
	}
	const assignRes = CMD.assignArgTokens(defs, tokens, preds)
	if (assignRes.code === 'err:missing-arg') return assignRes

	const out: Record<string, unknown> = {}
	const nearMisses: CMD.NearMiss[] = []
	// a near miss with nothing close enough to offer is not one: the caller has to retype either way, so it takes
	// the hard-error path and its message stands on its own
	const collect = (def: CMD.ArgDef, res: NearMissResult): { code: 'err'; msg: string } | undefined => {
		if (res.choices.length === 0) return { code: 'err', msg: res.msg }
		nearMisses.push({ argName: def.name, typed: res.typed, cause: res.cause, msg: res.msg, choices: res.choices })
		return undefined
	}
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
				const res = SM.PlayerIds.fuzzyMatchIdentifierUniquely(teamsState!.players, (p) => p.ids, window[0])
				if (res.code !== 'ok') {
					const cause = res.code === 'err:not-found' ? ('no-match' as const) : ('ambiguous' as const)
					const hard = collect(def, {
						code: 'err:near-miss',
						msg:
							res.code === 'err:not-found'
								? `No player matches found for "${window[0]}"`
								: `${res.count} players match "${window[0]}"`,
						typed: window[0],
						cause,
						choices: playerChoices(teamsState!.players, window[0], cause),
					})
					if (hard) return hard
					break
				}
				out[def.name] = res.matched
				break
			}
			case 'squad': {
				const res = resolveSquadArg(teamsState!, currentMatch!, sender, window)
				if (res.code === 'err:near-miss') {
					const hard = collect(def, res)
					if (hard) return hard
					break
				}
				if (res.code !== 'ok') return res
				out[def.name] = res.value
				break
			}
			case 'reason': {
				const res = CMD.resolveReasonArg(Settings.GLOBAL_SETTINGS.adminActionReasons, def.action, window)
				if (res.code !== 'ok') {
					const hard = collect(def, { code: 'err:near-miss', msg: res.msg, typed: window[0], cause: 'no-match', choices: res.choices })
					if (hard) return hard
					break
				}
				out[def.name] = res.value
				break
			}
			case 'preset-reason': {
				const res = CMD.resolveReasonToken(Settings.GLOBAL_SETTINGS.adminActionReasons, def.action, window[0])
				if (res.code !== 'ok') {
					const hard = collect(def, { code: 'err:near-miss', msg: res.msg, typed: window[0], cause: 'no-match', choices: res.choices })
					if (hard) return hard
					break
				}
				out[def.name] = res.reason
				break
			}
			default:
				def satisfies never
		}
	}
	if (nearMisses.length > 0) return { code: 'err:near-miss', nearMisses, ranges: assignRes.ranges }
	return { code: 'ok', args: out, ranges: assignRes.ranges }
}

function ingameActor(sender: SM.Player): { type: 'ingame-user'; playerId: SM.PlayerId } {
	return { type: 'ingame-user', playerId: SM.PlayerIds.getPlayerId(sender.ids) }
}

// swapping players to the other team is expressed relative to the current match ordinal
function oppositeNormedTeam(currentMatch: MH.MatchDetails, teamId: SM.TeamId): MH.NormedTeamId {
	return MH.getNormedTeamId(teamId, currentMatch.ordinal) === 'A' ? 'B' : 'A'
}

// A flag is named by one chat token, so one with whitespace is offered back with it stripped out: matching folds
// whitespace away on both sides (Str.normalizeForMatch), so "SuspectedCheater" still finds "Suspected Cheater".
function flagChoices(flags: BM.PlayerFlag[]): CMD.ArgChoice[] {
	return flags.map((flag) => ({ tokens: [flag.name.replace(/\s+/g, '')], label: flag.name }))
}

// shared by the two flag commands, which name a flag the same way
async function resolveFlagArg(
	h: HandlerCtx,
	flags: BM.PlayerFlag[],
	typed: string,
): Promise<{ code: 'ok'; flag: BM.PlayerFlag } | { code: 'asked'; result: HandlerResult }> {
	const names = flags.map((f) => f.name)
	const res = Str.simpleUniqueStringMatch(names, typed)
	if (res.code === 'ok') return { code: 'ok', flag: flags[res.matched] }
	const asked =
		res.code === 'err:not-found'
			? await h.nearMiss('flag', {
					msg: `No flag matches found for "${typed}"`,
					typed,
					cause: 'no-match',
					choices: flagChoices(Str.nearestBy(typed, flags, (f) => f.name, CMD.MAX_CHOICES)),
				})
			: await h.nearMiss('flag', {
					msg: `Multiple(${res.count}) flag matches found for "${typed}".`,
					typed,
					cause: 'ambiguous',
					choices: flagChoices(
						Str.simpleStringMatch(names, typed)
							.slice(0, CMD.MAX_CHOICES)
							.map((i) => flags[i]),
					),
				})
	return { code: 'asked', result: asked }
}

// exhaustive by construction: a new CommandId without a handler is a compile error
const handlers: { [Id in CMD.CommandId]: (h: HandlerCtx, args: CMD.CommandArgs<Id>) => Promise<HandlerResult> } = {
	help: async (h, args) => {
		const listing = CMDH.resolveHelpListing(Settings.GLOBAL_SETTINGS.commands, args.section)
		if (listing.code === 'err:unknown-section') {
			return await h.nearMiss('section', {
				msg: h.ctx.tr.text(listing.msg),
				typed: args.section!,
				cause: 'no-match',
				choices: listing.choices,
			})
		}
		await h.reply(CMD_Msgs.help(Settings.GLOBAL_SETTINGS.commands, args.section))
		return { code: 'ok' }
	},

	startVote: async (h) => {
		const res = await Vote.startVote(h.ctx, { initiator: h.user })
		switch (res.code) {
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
				return await h.error('no-vote-in-progress', h.ctx.tr.text(V_Msgs.noVoteInProgress()))
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
				return await h.error('no-vote-in-progress', h.ctx.tr.text(V_Msgs.noVoteInProgress()))
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
		await h.reply(SS_Msgs.slmUpdatesStatus(res.enabled, res.disabledByIngameVote))
		return { code: 'ok' }
	},

	requestFeedback: async (h, args) => {
		const res = await LayerQueue.requestFeedback(h.ctx, h.sender.ids.username, args.number)
		switch (res.code) {
			case 'err:empty':
			case 'err:not-found':
				return await h.error('not-found', h.ctx.tr.text(CMD_Msgs.itemNotFound()))
			case 'ok':
				return { code: 'ok' }
			default:
				assertNever(res)
		}
	},

	swapNow: async (h, args) => {
		const target = args.player
		if (!target.teamId) return await h.error('no-team', h.ctx.tr.text(CMD_Msgs.playerNotOnTeam(target.ids.username)))
		const currentMatch = await MatchHistory.getCurrentMatch(h.ctx)
		const toTeam = oppositeNormedTeam(currentMatch, target.teamId)
		const playerId = SM.PlayerIds.getPlayerId(target.ids)
		const errors = await Teamswaps.dispatchSwapNow(h.ctx, new Map([[playerId, { toTeam, source: h.user }]]), h.user)
		if (errors.length > 0) {
			const err = errors[0] as TSW.OpError
			if (err.code === 'err:currently-swapping') {
				return await h.error('currently-swapping', h.ctx.tr.text(CMD_Msgs.swapInProgress()))
			}
		}
		await h.reply(CMD_Msgs.swappingNow(target.ids.username, TSW_Msgs.destination(toTeam, MH.getNormedTeamFaction(currentMatch, toTeam))))
		return { code: 'ok' }
	},

	swapNext: async (h, args) => {
		const target = args.player
		if (!target.teamId) return await h.error('no-team', h.ctx.tr.text(CMD_Msgs.playerNotOnTeam(target.ids.username)))
		const currentMatch = await MatchHistory.getCurrentMatch(h.ctx)
		const toTeam = oppositeNormedTeam(currentMatch, target.teamId)
		const playerId = SM.PlayerIds.getPlayerId(target.ids)
		const errors = await Teamswaps.dispatchSwapNext(h.ctx, new Map([[playerId, { toTeam, source: h.user }]]))
		if (errors.length > 0) {
			const err = errors[0] as TSW.OpError
			if (err.code === 'err:currently-swapping') {
				return await h.error('currently-swapping', h.ctx.tr.text(CMD_Msgs.swapInProgress()))
			}
			if (err.code === 'err:already-marked') {
				return await h.error('already-marked', h.ctx.tr.text(CMD_Msgs.alreadyMarkedForSwap(target.ids.username)))
			}
		}
		await h.reply(CMD_Msgs.queuedSwapNext(target.ids.username))
		return { code: 'ok' }
	},

	swapSquadNow: async (h, args) => {
		const { squad, players } = args.squad
		if (players.length === 0) return await h.error('empty-squad', h.ctx.tr.text(CMD_Msgs.squadHasNoPlayers(squad.squadName)))
		const currentMatch = await MatchHistory.getCurrentMatch(h.ctx)
		const swaps: Map<SM.PlayerId, { toTeam: MH.NormedTeamId; source: USR.GuiOrChatUserId }> = new Map()
		for (const p of players) {
			swaps.set(SM.PlayerIds.getPlayerId(p.ids), { toTeam: oppositeNormedTeam(currentMatch, p.teamId!), source: h.user })
		}
		const errors = await Teamswaps.dispatchSwapNow(h.ctx, swaps, h.user)
		if (errors.length > 0) {
			const err = errors[0] as TSW.OpError
			if (err.code === 'err:currently-swapping') {
				return await h.error('currently-swapping', h.ctx.tr.text(CMD_Msgs.swapInProgress()))
			}
		}
		await h.reply(CMD_Msgs.swappingSquadNow(players.length, squad.squadName))
		return { code: 'ok' }
	},

	swapSquadNext: async (h, args) => {
		const { squad, players } = args.squad
		if (players.length === 0) return await h.error('empty-squad', h.ctx.tr.text(CMD_Msgs.squadHasNoPlayers(squad.squadName)))
		const currentMatch = await MatchHistory.getCurrentMatch(h.ctx)
		const nextSwaps: TSW.TeamswapCollection = new Map(
			players.map(
				(p) => [SM.PlayerIds.getPlayerId(p.ids), { toTeam: oppositeNormedTeam(currentMatch, p.teamId!), source: h.user }] as const,
			),
		)
		const errors = await Teamswaps.dispatchSwapNext(h.ctx, nextSwaps)
		const alreadyMarked = errors.filter((e) => (e as TSW.OpError).code === 'err:already-marked').length
		if (alreadyMarked === nextSwaps.size) {
			return await h.error('already-marked', h.ctx.tr.text(CMD_Msgs.squadAlreadyMarkedForSwap(squad.squadName)))
		}
		if (errors.some((e) => (e as TSW.OpError).code === 'err:currently-swapping')) {
			return await h.error('currently-swapping', h.ctx.tr.text(CMD_Msgs.swapInProgress()))
		}
		const queued = nextSwaps.size - alreadyMarked
		await h.reply(CMD_Msgs.queuedSquadSwapNext(queued, squad.squadName))
		return { code: 'ok' }
	},

	swaps: async (h) => {
		const currentMatch = await MatchHistory.getCurrentMatch(h.ctx)
		const layer = L.toLayer(currentMatch.layerId)
		const swaps = h.ctx.teamswaps.session.state.savedSwaps

		if (swaps.size === 0) {
			await h.reply(CMD_Msgs.noSwapsQueued())
			return { code: 'ok' }
		}

		const factionA = layer[MH.getTeamNormalizedFactionProp(currentMatch.ordinal, 'A')]
		const factionB = layer[MH.getTeamNormalizedFactionProp(currentMatch.ordinal, 'B')]
		const destA = h.ctx.tr.text(TSW_Msgs.destination('A', factionA))
		const destB = h.ctx.tr.text(TSW_Msgs.destination('B', factionB))

		const toA: SM.PlayerId[] = []
		const toB: SM.PlayerId[] = []
		for (const [playerId, sw] of swaps) {
			if (sw.toTeam === 'A') toA.push(playerId)
			else toB.push(playerId)
		}

		const parts = [toA.length > 0 ? `${toA.length} to ${destA}` : null, toB.length > 0 ? `${toB.length} to ${destB}` : null].filter(
			Boolean,
		)
		const header = `Swaps: ${parts.join(', ')}`

		if (swaps.size <= 8) {
			const teamsStateRes = await h.ctx.squadRcon.teams.get(h.ctx)
			const players = teamsStateRes.code === 'ok' ? teamsStateRes.players : []
			const getName = (playerId: SM.PlayerId) => SM.PlayerIds.find(players, (p) => p.ids, playerId)?.ids.username ?? playerId
			const lines = [header]
			if (toA.length > 0) {
				lines.push(`\nto ${destA}:`)
				for (const id of toA) lines.push(getName(id))
			}
			if (toB.length > 0) {
				lines.push(`\nto ${destB}:`)
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
				await h.reply(CMD_Msgs.noTeamswapsQueued())
				return { code: 'ok' }
			}
			if (err.code === 'err:currently-swapping' || err.code === 'err:pending-swap') {
				return await h.error('currently-swapping', h.ctx.tr.text(CMD_Msgs.swapInProgress()))
			}
			return await h.error('unexpected', h.ctx.tr.text(CMD_Msgs.clearSwapsFailed()))
		}
		await h.reply(CMD_Msgs.swapsCleared())
		return { code: 'ok' }
	},

	flag: async (h, args) => {
		if (!Battlemetrics.isEnabled()) return await h.error('battlemetrics-disabled', h.ctx.tr.text(CMD_Msgs.battlemetricsDisabled()))
		const target = args.player
		const flags = await Battlemetrics.getOrgFlags(h.ctx)
		const flagRes = await resolveFlagArg(h, flags, args.flag)
		if (flagRes.code !== 'ok') return flagRes.result

		const flagToUpdate = flagRes.flag
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
			return await h.error('not-in-battlemetrics', h.ctx.tr.text(CMD_Msgs.playerNotInBattlemetrics(targetIds.username)))
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
			const noteAdded = await Battlemetrics.addPlayerNote(h.ctx, bmPlayerData.bmPlayerId, note)
				.then(() => true)
				.catch((err) => {
					log.warn({ err, targetIds }, 'failed to post BM note after adding flag')
					return false
				})
			await Battlemetrics.invalidateAndRefetchPlayer(h.ctx, targetIds.eos)
			await h.reply(
				`Added flag "${flagToUpdate.name}" to ${targetIds.username}'s BM profile` +
					(noteAdded ? '' : ', but failed to post the accompanying note'),
			)
			return { code: 'ok' }
		}
		assertNever(res)
	},

	removeFlag: async (h, args) => {
		if (!Battlemetrics.isEnabled()) return await h.error('battlemetrics-disabled', h.ctx.tr.text(CMD_Msgs.battlemetricsDisabled()))
		const target = args.player
		const flags = await Battlemetrics.getOrgFlags(h.ctx)
		const flagRes = await resolveFlagArg(h, flags, args.flag)
		if (flagRes.code !== 'ok') return flagRes.result

		const flagToRemove = flagRes.flag
		const bmPlayerData = await Battlemetrics.fetchSinglePlayerBmData(h.ctx, target.ids)
		if (!bmPlayerData) {
			return await h.error('not-in-battlemetrics', h.ctx.tr.text(CMD_Msgs.playerNotInBattlemetrics(target.ids.username)))
		}
		if (!bmPlayerData.flagIds.includes(flagToRemove.id)) {
			return await h.error('not-found', h.ctx.tr.text(CMD_Msgs.playerLacksFlag(target.ids.username, flagToRemove.name)))
		}

		const [status] = await Battlemetrics.removePlayerFlags(h.ctx, bmPlayerData.bmPlayerId, [flagToRemove.id])
		if (status === 'already-removed') {
			return await h.error('already-removed', h.ctx.tr.text(CMD_Msgs.flagAlreadyRemoved(flagToRemove.name, target.ids.username)))
		}
		const note = BM.flagChangeNote({
			action: 'removed',
			flagName: flagToRemove.name,
			actor: `${h.sender.ids.username} (Steam ${h.sender.ids.steam})`,
			reason: args.reason?.trim(),
		})
		const noteAdded = await Battlemetrics.addPlayerNote(h.ctx, bmPlayerData.bmPlayerId, note)
			.then(() => true)
			.catch((err) => {
				log.warn({ err, targetIds: target.ids }, 'failed to post BM note after removing flag')
				return false
			})
		await Battlemetrics.invalidateAndRefetchPlayer(h.ctx, target.ids.eos)
		await h.reply(
			`Removed flag "${flagToRemove.name}" from ${target.ids.username}'s BM profile` +
				(noteAdded ? '' : ', but failed to post the accompanying note'),
		)
		return { code: 'ok' }
	},

	listFlags: async (h, args) => {
		if (!Battlemetrics.isEnabled()) return await h.error('battlemetrics-disabled', h.ctx.tr.text(CMD_Msgs.battlemetricsDisabled()))
		function formatFlagList(flags: BM.PlayerFlag[]) {
			if (flags.length === 0) {
				return 'none'
			}
			return Arr.paged(
				flags.map((f) => f.name),
				4,
			).map((g) => g.join('\n'))
		}
		const flags = await Battlemetrics.getOrgFlags(h.ctx)

		if (!args.player) {
			await h.reply(formatFlagList(flags))
			return { code: 'ok' }
		}

		const bmPlayerData = await Battlemetrics.fetchSinglePlayerBmData(h.ctx, args.player.ids)
		if (!bmPlayerData) {
			return await h.error('not-in-battlemetrics', h.ctx.tr.text(CMD_Msgs.playerNotInBattlemetrics(args.player.ids.username)))
		}
		const playerFlags = flags.filter((f) => bmPlayerData.flagIds.includes(f.id))

		await h.reply(formatFlagList(playerFlags))
		return { code: 'ok' }
	},

	// the only command a non-admin runs against admins, so the ping names who sent it and which team they are on
	pingAdmins: async (h, args) => {
		await SquadRcon.warnAllAdmins(h.ctx, CMD_Msgs.PingAdmins.ping(h.sender, args.message))
		await h.reply(CMD_Msgs.PingAdmins.confirmed())
		return { code: 'ok' }
	},

	warn: async (h, args) => {
		const target = args.player
		const targetId = SM.PlayerIds.getPlayerId(target.ids)
		const applied = CMD.applyResolvedReason('warn', args.reason, SquadServer.messageVars())
		const message = AAR.renderAppliedReason(applied)
		await SquadServer.warnPlayers(h.ctx, [targetId], message, ingameActor(h.sender), { reasonLabel: applied.label })
		// echo the exact delivered text so the admin sees what the player got (preset labels are embedded in it)
		await h.reply(CMD_Msgs.warned(target.ids.username, message))
		return { code: 'ok' }
	},

	listWarnReasons: async (h) => {
		const reasons = Settings.GLOBAL_SETTINGS.adminActionReasons
		if (reasons.length === 0) {
			await h.reply(CMD_Msgs.noReasonsConfigured())
			return { code: 'ok' }
		}
		// label + aliases + the actions each reason is set up for; the texts themselves are looked up at use time
		const actionsFor = (r: AAR.AdminActionReason) =>
			AAR.ADMIN_ACTION_TYPE.options
				.filter((a) => r.actionTexts[a] !== undefined)
				.map((a) => AAR.ADMIN_ACTIONS[a].displayName)
				.join(', ')
		const entries = reasons.map((r) => {
			const head = `${r.label} (${r.keywords.join(', ')})`
			return `${head}\n${actionsFor(r)}`
		})
		// each reason is a 2-line block (label, then its actions); blank line between blocks
		await h.reply(Arr.paged(entries, 3).map((g) => g.join('\n\n')))
		return { code: 'ok' }
	},

	warnSquad: async (h, args) => {
		const { squad, players } = args.squad
		if (players.length === 0) return await h.error('empty-squad', h.ctx.tr.text(CMD_Msgs.squadHasNoPlayers(squad.squadName)))
		const targetIds = players.map((p) => SM.PlayerIds.getPlayerId(p.ids))
		const applied = CMD.applyResolvedReason('warn', args.reason, SquadServer.messageVars())
		// squad warns carry the same @Squad tag the web squad warn box prepends
		const message = AAR.renderAppliedReason(applied, { audienceTag: SM.squadWarnTag(squad) })
		await SquadServer.warnPlayers(h.ctx, targetIds, message, ingameActor(h.sender), { reasonLabel: applied.label })
		const currentMatch = await MatchHistory.getCurrentMatch(h.ctx)
		const squadLabel = SM.squadAdminLabel(squad, MH.getTeamFaction(currentMatch, args.squad.teamId))
		await h.reply(CMD_Msgs.warnedSquad(squadLabel, message))
		return { code: 'ok' }
	},

	kill: async (h, args) => {
		const g = await requireReasonGuard(h, 'kill', !!args.reason)
		if (g) return g
		const target = args.player
		const applied = args.reason && CMD.applyResolvedReason('kill', args.reason, SquadServer.messageVars())
		// the kill notify delivers the rendered reason verbatim (see h.ctx.tr.warn(SM_Msgs.notifyKilled()))
		const reason = applied && AAR.renderAppliedReason(applied)
		await SquadServer.killPlayersAction(h.ctx, [SM.PlayerIds.getPlayerId(target.ids)], ingameActor(h.sender), reason, applied?.label)
		await h.reply(applied?.label ? `Killed ${target.ids.username} for ${applied.label}` : `Killed ${target.ids.username}`)
		return { code: 'ok' }
	},

	killSquad: async (h, args) => {
		const { squad, players } = args.squad
		if (players.length === 0) return await h.error('empty-squad', h.ctx.tr.text(CMD_Msgs.squadHasNoPlayers(squad.squadName)))
		const g = await requireReasonGuard(h, 'kill', !!args.reason)
		if (g) return g
		const targetIds = players.map((p) => SM.PlayerIds.getPlayerId(p.ids))
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
		if (target.squadId == null) return await h.error('not-in-squad', h.ctx.tr.text(CMD_Msgs.playerNotInSquad(target.ids.username)))
		const g = await requireReasonGuard(h, 'remove-from-squad', !!args.reason)
		if (g) return g
		const applied = args.reason && CMD.applyResolvedReason('remove-from-squad', args.reason, SquadServer.messageVars())
		await SquadServer.removePlayersFromSquad(h.ctx, [SM.PlayerIds.getPlayerId(target.ids)], ingameActor(h.sender), applied || undefined)
		await h.reply(CMD_Msgs.removedFromSquad(target.ids.username, applied?.label))
		return { code: 'ok' }
	},

	disbandSquad: async (h, args) => {
		const g = await requireReasonGuard(h, 'disband-squad', !!args.reason)
		if (g) return g
		const { squad, teamLabel } = args.squad
		const applied = args.reason && CMD.applyResolvedReason('disband-squad', args.reason, SquadServer.messageVars())
		await SquadServer.disbandSquadAction(h.ctx, args.squad.teamId, squad.squadId, ingameActor(h.sender), applied || undefined)
		await h.reply(CMD_Msgs.disbandedSquad(squad.squadName, teamLabel, applied?.label))
		return { code: 'ok' }
	},

	demoteCommander: async (h, args) => {
		const g = await requireReasonGuard(h, 'demote-commander', !!args.reason)
		if (g) return g
		const target = args.player
		const applied = args.reason && CMD.applyResolvedReason('demote-commander', args.reason, SquadServer.messageVars())
		await SquadServer.demoteCommanderAction(h.ctx, SM.PlayerIds.getPlayerId(target.ids), ingameActor(h.sender), applied || undefined)
		await h.reply(CMD_Msgs.demoted(target.ids.username, applied?.label))
		return { code: 'ok' }
	},

	broadcast: async (h, args) => {
		const applied = CMD.applyResolvedReason('broadcast', args.reason, SquadServer.messageVars())
		const message = AAR.renderAppliedReason(applied)
		await SquadRcon.broadcast(h.ctx, message)
		return { code: 'ok' }
	},

	kick: async (h, args) => {
		return await executeKick(h, [args.player], args.reason, args.player.ids.username)
	},

	kickSquad: async (h, args) => {
		const { squad, players } = args.squad
		if (players.length === 0) return await h.error('empty-squad', h.ctx.tr.text(CMD_Msgs.squadHasNoPlayers(squad.squadName)))
		return await executeKick(h, players, args.reason, squadSubjectLabel(squad.squadName, players.length))
	},

	timeout: async (h, args) => {
		return await executeTimeout(h, [args.player], args.duration, args.reason, args.player.ids.username)
	},

	timeoutSquad: async (h, args) => {
		const { squad, players } = args.squad
		if (players.length === 0) return await h.error('empty-squad', h.ctx.tr.text(CMD_Msgs.squadHasNoPlayers(squad.squadName)))
		return await executeTimeout(h, players, args.duration, args.reason, squadSubjectLabel(squad.squadName, players.length))
	},

	clearTimeout: async (h, args) => {
		const denyRes = await Rbac.tryDenyPermissionsForPlayer({ ...h.ctx }, SM.Grants.anyTimeout(h.ctx.serverId))
		if (denyRes) return await h.error('permission-denied', h.ctx.tr.text(RBAC_Msgs.permissionDenied(denyRes)))

		// the target may be offline, so match against players holding active timeouts rather than the roster
		const active = await Timeouts.listActiveTimeouts(h.ctx)
		const token = args.player
		let matches = active.filter((t) => t.playerId === token || t.steamId?.toString() === token)
		if (matches.length === 0) {
			const lower = token.toLowerCase()
			matches = active.filter((t) => (t.username ?? '').toLowerCase().includes(lower))
		}
		const matchedPlayerIds = new Set(matches.map((t) => t.playerId))
		// a player can hold more than one timeout row, but they are one thing to pick, named by the player id the
		// token is matched against first
		const distinct = [...new Map(active.map((t) => [t.playerId, t] as const)).values()]
		const timeoutChoices = (timeouts: typeof distinct) => timeouts.map((t) => ({ tokens: [t.playerId], label: t.username ?? t.playerId }))
		if (matchedPlayerIds.size === 0) {
			return await h.nearMiss('player', {
				msg: `No active timeout matches "${token}"`,
				typed: token,
				cause: 'no-match',
				choices: timeoutChoices(Str.nearestBy(token, distinct, (t) => t.username ?? '', CMD.MAX_CHOICES)),
			})
		}
		if (matchedPlayerIds.size > 1) {
			return await h.nearMiss('player', {
				msg: `${matchedPlayerIds.size} timed-out players match "${token}"`,
				typed: token,
				cause: 'ambiguous',
				choices: timeoutChoices(distinct.filter((t) => matchedPlayerIds.has(t.playerId)).slice(0, CMD.MAX_CHOICES)),
			})
		}
		for (const timeout of matches) {
			await Timeouts.cancelTimeout(h.ctx, { timeoutId: timeout.id, actor: ingameActor(h.sender), serverCtx: h.ctx })
		}
		await h.reply(CMD_Msgs.timeoutsCancelled(matches.length, matches[0].username ?? token))
		return { code: 'ok' }
	},

	requestLayer: async (h, args) => {
		const tokens = args.request.split(/\s+/).filter((t) => t.length > 0)
		const filterEntities = Array.from(FilterEntity.state.filters.values()).map((f) => ({ id: f.id, name: f.name }))
		const resolveRes = BB.resolveRequestTokens({ tokens, components: L.StaticLayerComponents, filterEntities })
		if (resolveRes.code === 'err:unknown-token' || resolveRes.code === 'err:ambiguous-token') {
			// only one word of the request is wrong, so each choice is the whole request with that word corrected:
			// the argument's window is the request, and a pick replaces all of it
			const offending = resolveRes.token
			return await h.nearMiss('request', {
				msg: resolveRes.msg,
				typed: offending,
				cause: resolveRes.code === 'err:unknown-token' ? 'no-match' : 'ambiguous',
				choices: resolveRes.suggestions.slice(0, CMD.MAX_CHOICES).map((suggestion) => ({
					// a suggestion with spaces is still one request word: matching folds whitespace away
					tokens: tokens.map((t) => (t === offending ? suggestion.replace(/\s+/g, '') : t)),
					label: suggestion,
				})),
			})
		}
		if (resolveRes.code !== 'ok') return await h.error('invalid-request', resolveRes.msg)
		const source = await resolveChatOwner(h)
		const res = await LayerQueue.addBackburnerRequestFromChat(h.ctx, {
			source,
			filter: resolveRes.value.filter,
		})
		switch (res.code) {
			case 'err:permission-denied':
				return await h.error('permission-denied', h.ctx.tr.text(RBAC_Msgs.permissionDenied(res)))
			case 'err:no-solutions':
				return await h.error('no-solutions', h.ctx.tr.text(BB_Msgs.noSolutions(args.request.trim())))
			case 'err:backburner-full':
				return await h.error('backburner-full', h.ctx.tr.text(BB_Msgs.backburnerFull(res.max)))
			case 'ok': {
				const ownCount = BB.ownedItems(LayerQueue.getSavedBackburner(h.ctx), source).length
				await h.reply(BB_Msgs.added(resolveRes.value.parts, ownCount, res.evicted.length))
				return { code: 'ok' }
			}
			default:
				assertNever(res)
		}
	},

	listLayerRequests: async (h) => {
		const items = LayerQueue.getSavedBackburner(h.ctx)
		if (items.length === 0) {
			await h.reply(BB_Msgs.empty())
			return { code: 'ok' }
		}
		const owner = await resolveChatOwner(h)
		const pages = Arr.paged(BB.getLayerRequestSummary(items, LayerQueue.backburnerFilterName, owner), 4).map((page) => page.join('\n'))
		for (const page of pages) await h.reply(page)
		return { code: 'ok' }
	},

	removeLayerRequest: async (h, args) => {
		const items = LayerQueue.getSavedBackburner(h.ctx)
		const owner = await resolveChatOwner(h)
		let target: BB.BackburnerItem | undefined
		if (args.number !== undefined) {
			target = items[args.number - 1]
			if (!target) return await h.error('not-found', h.ctx.tr.text(CMD_Msgs.noLayerRequestNumber(args.number)))
		} else {
			const own = BB.ownedItems(items, owner)
			target = own[own.length - 1]
			if (!target) return await h.error('not-found', h.ctx.tr.text(CMD_Msgs.noLayerRequests()))
		}
		if (!BB.sameOwner(target.source, owner)) {
			// removing someone else's request needs queue:write
			const denyRes = await Rbac.tryDenyPermissionsForPlayer(h.ctx, RBAC.perm('queue:write', { serverId: h.ctx.serverId }))
			if (denyRes) return await h.error('permission-denied', h.ctx.tr.text(RBAC_Msgs.permissionDenied(denyRes)))
		}
		await LayerQueue.removeBackburnerRequestsFromChat(h.ctx, { itemIds: [target.itemId], source: owner })
		await h.reply(BB_Msgs.removed(BB.describeTemplate(target.filter, LayerQueue.backburnerFilterName)))
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
	const reason = resolvedReason && CMD.applyResolvedReason('kick', resolvedReason, SquadServer.messageVars())
	await SquadServer.kickPlayersAction(
		h.ctx,
		targets.map((t) => SM.PlayerIds.getPlayerId(t.ids)),
		ingameActor(h.sender),
		reason || undefined,
	)
	await h.reply(CMD_Msgs.kicked(subjectLabel, reason?.label))
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
	const denyRes = await Rbac.tryDenyPermissionsForPlayer(h.ctx, SM.Grants.satisfyingTimeout(h.ctx.serverId, durationMs))
	if (denyRes) return await h.error('permission-denied', h.ctx.tr.text(RBAC_Msgs.permissionDenied(denyRes)))
	const vars = SquadServer.messageVars({ duration: ZodUtils.formatHumanTime(durationMs) })
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
	await h.reply(
		[
			`Timed out ${subjectLabel} for ${ZodUtils.formatHumanTime(durationMs)}${reason?.label ? ` for ${reason.label}` : ''}`,
			...(skipped.length > 0 ? [`Skipped (already timed out): ${skipped.join(', ')}`] : []),
		].join('\n'),
	)
	return { code: 'ok' }
}

async function toggleSlmUpdates(h: HandlerCtx, disabled: boolean): Promise<HandlerResult> {
	const reason = disabled ? ({ type: 'manual', by: SquadServer.actorFromUser(h.ctx, h.user) } as const) : null
	await LayerQueue.toggleUpdatesToSquadServer({ ctx: h.ctx, input: { disabled: reason } })
	return { code: 'ok' }
}
