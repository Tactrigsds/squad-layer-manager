import * as Obj from '@/lib/object'
import { BasicStrNoWhitespace, tryParseHumanTimeToken } from '@/lib/zod'
import * as AAR from '@/models/admin-action-reasons.models'
import * as LP from '@/models/labeled-presets.models'
import type * as SM from '@/models/squad.models.ts'

import StringComparison from 'string-comparison'
import { z } from 'zod'

export const COMMAND_SCOPES = z.enum(['admin', 'public'])
export type CommandScope = z.infer<typeof COMMAND_SCOPES>

export const CHAT_SCOPE_MAPPINGS = {
	[COMMAND_SCOPES.enum.admin]: ['ChatAdmin'],
	[COMMAND_SCOPES.enum.public]: ['ChatTeam', 'ChatSquad', 'ChatAll'],
}
export type CommandConfig = {
	strings: string[]
	scopes: CommandScope[]
	enabled: boolean
}

export type CommandConfigs = { [k in CommandId]: CommandConfig }

// Args are declared with a kind so token assignment, resolution, and usage strings are all derived centrally
// (see assignArgTokens + resolveArgs in commands.server). Handlers receive typed values via CommandArgs<Id>.
export type ArgDef =
	// single token, passed through as-is
	| { kind: 'string'; name: string; optional?: true }
	// single token, coerced to an integer
	| { kind: 'int'; name: string; optional?: true }
	// single token, a HumanTime duration like 2h or 30m, resolved to milliseconds
	| { kind: 'duration'; name: string; optional?: true }
	// single token, resolved to a unique player by id or username substring
	| { kind: 'player'; name: string; optional?: true }
	// 1-2 tokens: [team] <squad>; team = 1|2|A|B|faction, caller's team when omitted
	| { kind: 'squad'; name: string }
	// rest: raw remainder joined with spaces
	| { kind: 'text'; name: string; optional?: true }
	// rest: a single token must match a configured reason (label/alias); 2+ tokens are a custom message
	| { kind: 'reason'; name: string; action: AAR.AdminActionType; optional?: true }
	// single token, configured reason only
	| { kind: 'preset-reason'; name: string; action: AAR.AdminActionType; optional?: true }
	// rest: a single token must match a configured broadcast (label/alias); 2+ tokens are broadcast verbatim
	| { kind: 'broadcast'; name: string }

const REST_KINDS: ArgDef['kind'][] = ['text', 'reason', 'broadcast']

// structural rules the token-assignment logic depends on; violations are programmer errors caught at module load
function assertValidArgDefs(id: string, args: readonly ArgDef[]) {
	args.forEach((def, i) => {
		if (REST_KINDS.includes(def.kind) && i !== args.length - 1) {
			throw new Error(`command ${id}: rest arg "${def.name}" must be last`)
		}
		if (def.kind === 'squad' && args.slice(i + 1).some((d) => d.kind === 'squad')) {
			throw new Error(`command ${id}: at most one squad arg is supported`)
		}
	})
}

function declareCommand<Id extends string, const Args extends readonly ArgDef[]>(
	id: Id,
	opts: { args: Args; defaults: CommandConfig },
) {
	assertValidArgDefs(id, opts.args)
	return {
		[id]: {
			id,
			defaults: opts.defaults,
			args: opts.args,
		},
	} as { [K in Id]: { id: Id; defaults: CommandConfig; args: Args } }
}

export const COMMAND_DECLARATIONS = {
	...declareCommand('help', {
		args: [],
		defaults: {
			scopes: ['admin'],
			strings: ['help', 'h'],
			enabled: true,
		},
	}),
	...declareCommand('requestFeedback', {
		// queue numbers accept dotted forms like "2.1", so this stays a string arg
		args: [{ kind: 'string', name: 'number', optional: true }],
		defaults: { scopes: ['admin'], strings: ['feedback', 'fb'], enabled: true },
	}),
	...declareCommand('startVote', {
		args: [],
		defaults: {
			scopes: ['admin'],
			strings: ['startvote', 'sv'],
			enabled: true,
		},
	}),
	...declareCommand('abortVote', { args: [], defaults: { scopes: ['admin'], strings: ['abortvote', 'av'], enabled: true } }),
	...declareCommand('endVoteEarly', { args: [], defaults: { scopes: ['admin'], strings: ['endvote', 'ev'], enabled: true } }),
	...declareCommand('showNext', { args: [], defaults: { scopes: ['admin'], strings: ['shownext', 'sn'], enabled: true } }),
	...declareCommand('enableSlmUpdates', { args: [], defaults: { scopes: ['admin'], strings: ['enableslm'], enabled: true } }),
	...declareCommand('disableSlmUpdates', { args: [], defaults: { scopes: ['admin'], strings: ['disableslm'], enabled: true } }),
	...declareCommand('getSlmUpdatesEnabled', { args: [], defaults: { scopes: ['admin'], strings: ['slmstatus'], enabled: true } }),
	...declareCommand('swapNow', {
		args: [{ kind: 'player', name: 'player' }],
		defaults: { scopes: ['admin'], strings: ['swapnow'], enabled: true },
	}),
	...declareCommand('swapNext', {
		args: [{ kind: 'player', name: 'player' }],
		defaults: { scopes: ['admin'], strings: ['swapnext'], enabled: true },
	}),
	...declareCommand('swapSquadNow', {
		args: [{ kind: 'squad', name: 'squad' }],
		defaults: { scopes: ['admin'], strings: ['swapsquadnow'], enabled: true },
	}),
	...declareCommand('swapSquadNext', {
		args: [{ kind: 'squad', name: 'squad' }],
		defaults: { scopes: ['admin'], strings: ['swapsquadnext'], enabled: true },
	}),
	...declareCommand('swaps', { args: [], defaults: { scopes: ['admin'], strings: ['swaps'], enabled: true } }),
	...declareCommand('clearSwaps', { args: [], defaults: { scopes: ['admin'], strings: ['clearswaps'], enabled: true } }),
	...declareCommand('flag', {
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'string', name: 'flag' },
			{ kind: 'text', name: 'reason', optional: true },
		],
		defaults: { scopes: ['admin'], strings: ['flag'], enabled: true },
	}),
	...declareCommand('removeFlag', {
		args: [{ kind: 'player', name: 'player' }, { kind: 'string', name: 'flag' }],
		defaults: { scopes: ['admin'], strings: ['removeFlag', 'rf'], enabled: true },
	}),
	...declareCommand('listFlags', {
		args: [{ kind: 'player', name: 'player', optional: true }],
		defaults: { enabled: true, scopes: ['admin'], strings: ['listflags', 'lf'] },
	}),
	...declareCommand('warn', {
		args: [{ kind: 'player', name: 'player' }, { kind: 'reason', name: 'reason', action: 'warn' }],
		defaults: { scopes: ['admin'], strings: ['warn'], enabled: true },
	}),
	...declareCommand('listWarnReasons', {
		args: [],
		defaults: { scopes: ['admin'], strings: ['warnreasons', 'warns'], enabled: true },
	}),
	...declareCommand('warnSquad', {
		args: [{ kind: 'squad', name: 'squad' }, { kind: 'reason', name: 'reason', action: 'warn' }],
		defaults: { scopes: ['admin'], strings: ['warnsquad', 'ws'], enabled: true },
	}),
	...declareCommand('kill', {
		args: [{ kind: 'player', name: 'player' }, { kind: 'reason', name: 'reason', action: 'kill', optional: true }],
		defaults: { scopes: ['admin'], strings: ['kill'], enabled: true },
	}),
	...declareCommand('killSquad', {
		args: [{ kind: 'squad', name: 'squad' }, { kind: 'reason', name: 'reason', action: 'kill', optional: true }],
		defaults: { scopes: ['admin'], strings: ['killsquad'], enabled: true },
	}),
	...declareCommand('removeFromSquad', {
		args: [{ kind: 'player', name: 'player' }, { kind: 'reason', name: 'reason', action: 'remove-from-squad', optional: true }],
		defaults: { scopes: ['admin'], strings: ['rfs', 'removefromsquad'], enabled: true },
	}),
	...declareCommand('disbandSquad', {
		args: [{ kind: 'squad', name: 'squad' }, { kind: 'reason', name: 'reason', action: 'disband-squad', optional: true }],
		defaults: { scopes: ['admin'], strings: ['disband'], enabled: true },
	}),
	...declareCommand('demoteCommander', {
		args: [{ kind: 'player', name: 'player' }, { kind: 'reason', name: 'reason', action: 'demote-commander', optional: true }],
		defaults: { scopes: ['admin'], strings: ['demote'], enabled: true },
	}),
	...declareCommand('broadcast', {
		args: [{ kind: 'broadcast', name: 'message' }],
		defaults: { scopes: ['admin'], strings: ['broadcast', 'b'], enabled: true },
	}),
	...declareCommand('kick', {
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'reason', name: 'reason', action: 'kick', optional: true },
		],
		defaults: { scopes: ['admin'], strings: ['kick'], enabled: true },
	}),
	...declareCommand('kickSquad', {
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'reason', name: 'reason', action: 'kick', optional: true },
		],
		defaults: { scopes: ['admin'], strings: ['kicksquad'], enabled: true },
	}),
	...declareCommand('timeout', {
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'duration', name: 'duration' },
			{ kind: 'reason', name: 'reason', action: 'timeout', optional: true },
		],
		defaults: { scopes: ['admin'], strings: ['timeout', 'to'], enabled: true },
	}),
	...declareCommand('timeoutSquad', {
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'duration', name: 'duration' },
			{ kind: 'reason', name: 'reason', action: 'timeout', optional: true },
		],
		defaults: { scopes: ['admin'], strings: ['timeoutsquad', 'tos'], enabled: true },
	}),
	// the target may be offline, so the arg is a plain token resolved against players with active timeouts
	...declareCommand('clearTimeout', {
		args: [{ kind: 'string', name: 'player' }],
		defaults: { scopes: ['admin'], strings: ['cleartimeout', 'ct'], enabled: true },
	}),
}

// configurable fixed-duration timeout aliases (e.g. !yeet = timeout with 2h) share these args: a player and an
// optional reason. shared so both the command dispatcher and the help listings can describe them.
export const TIMEOUT_ALIAS_ARG_DEFS = [
	{ kind: 'player', name: 'player' },
	{ kind: 'reason', name: 'reason', action: 'timeout', optional: true },
] as const satisfies readonly ArgDef[]

export type CommandId = keyof typeof COMMAND_DECLARATIONS
export const COMMAND_ID = z.enum(Object.keys(COMMAND_DECLARATIONS) as [CommandId, ...CommandId[]])
export type CommandDeclaration<Id extends CommandId> = (typeof COMMAND_DECLARATIONS)[Id]

// description is not configurable, rest of properties are
const COMMAND_DEFAULTS: CommandConfigs = Object.fromEntries(
	Object.entries(COMMAND_DECLARATIONS).map(([id, declaration]) => [id, declaration.defaults]),
) as CommandConfigs

function CommandConfigSchema(commandId: CommandId) {
	const defaultConfig = COMMAND_DEFAULTS[commandId]
	return z.object({
		strings: z.array(BasicStrNoWhitespace).prefault(defaultConfig.strings).describe(
			'Command strings that trigger this command when prefixed with the command prefix',
		),
		scopes: z.array(COMMAND_SCOPES).prefault(defaultConfig.scopes).describe('Scopes in which this command is available'),
		enabled: z.boolean().prefault(defaultConfig.enabled),
	}).prefault(defaultConfig)
}

export const AllCommandConfigSchema = z.object(
	Object.fromEntries(Object.keys(COMMAND_DECLARATIONS).map(id => [id, CommandConfigSchema(id as CommandId)])) as Record<
		CommandId,
		ReturnType<typeof CommandConfigSchema>
	>,
).default(COMMAND_DEFAULTS)

// -------- resolved argument shapes --------

export type ResolvedReasonArg = { type: 'preset'; reason: AAR.AdminActionReason } | { type: 'custom'; text: string }
export type ResolvedBroadcastArg = { type: 'preset'; preset: LP.BroadcastPreset } | { type: 'custom'; text: string }
// resolved by the server layer (needs the live roster); declared here so CommandArgs stays self-contained
export type ResolvedSquadArg = { teamId: SM.TeamId; teamLabel: string; squad: SM.Squad; players: SM.Player[] }

type ArgValue<D extends ArgDef> = D extends { kind: 'string' } ? string
	: D extends { kind: 'int' } ? number
	: D extends { kind: 'duration' } ? number
	: D extends { kind: 'player' } ? SM.Player
	: D extends { kind: 'squad' } ? ResolvedSquadArg
	: D extends { kind: 'text' } ? string
	: D extends { kind: 'reason' } ? ResolvedReasonArg
	: D extends { kind: 'preset-reason' } ? AAR.AdminActionReason
	: D extends { kind: 'broadcast' } ? ResolvedBroadcastArg
	: never

export type ResolvedArgs<Args extends readonly ArgDef[]> = {
	[D in Args[number] as D['name']]: D extends { optional: true } ? ArgValue<D> | undefined : ArgValue<D>
}
export type CommandArgs<Id extends CommandId> = ResolvedArgs<CommandDeclaration<Id>['args']>

// -------- Helpers --------

export function parseCommand(msg: SM.RconEvents.ChatMessage, configs: CommandConfigs, commandPrefix: string) {
	const words = msg.message.split(/\s+/)
	const cmdText = words[0].slice(1)
	const cmd = matchCommandText(configs, cmdText)
	if (!cmd) {
		const allCommandStrings = Obj.objValues(configs)
			.filter((c) => chatInScope(c.scopes, msg.channelType))
			.flatMap((c) => c.strings)
			.map((s) => (commandPrefix + s))
		const sortedMatches = StringComparison.diceCoefficient.sortMatch(words[0].toLowerCase(), allCommandStrings)
		if (sortedMatches.length === 0) {
			return { code: 'err:unknown-command' as const, msg: `Unknown command "${words[0]}"` }
		}
		const matched = sortedMatches[sortedMatches.length - 1].member
		return {
			code: 'err:unknown-command' as const,
			msg: `Unknown command "${words[0]}". Did you mean ${matched}?`,
		}
	}
	return { code: 'ok' as const, cmd, tokens: words.slice(1) }
}

// a token that can name a squad without a roster: an in-game squad number or the "cmd" command-squad alias
// (squad names are resolved against the roster server-side, so they aren't recognized here)
function isSquadToken(token: string): boolean {
	return /^\d+$/.test(token) || token.toLowerCase() === 'cmd'
}

export type ArgTokenWindows = Record<string, string[] | undefined>
export type AssignPredicates = {
	// whether a token parses as a team specifier (1|2|A|B|faction of the current layer)
	isTeamToken: (token: string) => boolean
	// whether a token matches a configured reason (label/alias) applicable to the action
	isPresetToken: (action: AAR.AdminActionType, token: string) => boolean
}

// splits the raw arg tokens into per-arg windows, enforcing required args. Pure; ctx-dependent knowledge
// (teams, configured presets) is injected via predicates so the squad window sizing can disambiguate.
export function assignArgTokens(
	args: readonly ArgDef[],
	tokens: string[],
	preds: AssignPredicates,
): { code: 'ok'; windows: ArgTokenWindows } | { code: 'err:missing-arg'; argName: string } {
	const windows: ArgTokenWindows = {}
	let i = 0
	for (let a = 0; a < args.length; a++) {
		const def = args[a]
		const rem = tokens.slice(i)
		switch (def.kind) {
			case 'string':
			case 'int':
			case 'duration':
			case 'player':
			case 'preset-reason': {
				if (rem.length === 0) {
					if (!def.optional) return { code: 'err:missing-arg', argName: def.name }
					windows[def.name] = undefined
					break
				}
				windows[def.name] = [rem[0]]
				i += 1
				break
			}
			case 'text':
			case 'reason':
			case 'broadcast': {
				const optional = def.kind !== 'broadcast' && def.optional
				if (rem.length === 0) {
					if (!optional) return { code: 'err:missing-arg', argName: def.name }
					windows[def.name] = undefined
					break
				}
				windows[def.name] = rem
				i = tokens.length
				break
			}
			case 'squad': {
				if (rem.length === 0) return { code: 'err:missing-arg', argName: def.name }
				const next = args[a + 1]
				let candidates = rem
				if (next?.kind === 'preset-reason' && rem.length >= 2 && preds.isPresetToken(next.action, rem[rem.length - 1])) {
					// the trailing token is a configured reason, so it can't be part of the squad spec
					candidates = rem.slice(0, -1)
				}
				let windowLen: number
				if (a === args.length - 1) {
					// squad is the final arg (e.g. swapsquadnow): the whole remainder is the "[team] <squad>" spec
					windowLen = Math.min(2, candidates.length)
				} else {
					// more args follow (duration, reason, ...), so a bare number is ambiguous (team or squad). Only take
					// a [team] <squad> pair when the first token is a team AND the second is squad-like (a number or
					// "cmd"); otherwise the first token is a squad on the caller's team and the rest belongs to later args.
					windowLen = candidates.length >= 2 && preds.isTeamToken(candidates[0]) && isSquadToken(candidates[1]) ? 2 : 1
				}
				windows[def.name] = candidates.slice(0, windowLen)
				i += windowLen
				break
			}
			default:
				def satisfies never
		}
	}
	return { code: 'ok', windows }
}

export function coerceIntArg(name: string, token: string): { code: 'ok'; value: number } | { code: 'err:invalid-int'; msg: string } {
	if (!/^-?\d+$/.test(token)) return { code: 'err:invalid-int', msg: `${name} must be an integer, got "${token}"` }
	return { code: 'ok', value: parseInt(token, 10) }
}

export function resolveDurationArg(
	name: string,
	token: string,
): { code: 'ok'; value: number } | { code: 'err:invalid-duration'; msg: string } {
	const value = tryParseHumanTimeToken(token)
	if (value === undefined) {
		return { code: 'err:invalid-duration', msg: `${name} must be a duration like 30m, 2h or 1d, got "${token}"` }
	}
	return { code: 'ok', value }
}

function unknownPresetMsg(noun: string, token: string, presets: { label: string; aliases: string[] }[]) {
	const suggestion = LP.didYouMean(token, LP.labelAliasStrings(presets))
	return `Unknown ${noun} "${token}".${suggestion ? ` Did you mean ${suggestion}?` : ''}`
}

// "Available: label (alias1, alias2), ..." listing the reasons valid for an action, for error hints
function reasonOptionsHint(applicable: AAR.AdminActionReason[]): string {
	if (applicable.length === 0) return 'No reasons are configured for this action.'
	const list = applicable.map(r => r.aliases.length > 0 ? `${r.label} (${r.aliases.join(', ')})` : r.label).join(', ')
	return `Available: ${list}`
}

// resolves a single reason token against ALL reasons for the action, distinguishing "no such reason" from
// "exists but isn't set up for this action", and listing the valid options in either case
export function resolveReasonToken(
	allReasons: AAR.AdminActionReason[],
	action: AAR.AdminActionType,
	token: string,
): { code: 'ok'; reason: AAR.AdminActionReason } | { code: 'err:unknown-preset'; msg: string } {
	const res = AAR.resolveReason(allReasons, action, token)
	if (res.code === 'ok') return { code: 'ok', reason: res.reason }
	const applicable = AAR.reasonsForAction(allReasons, action)
	if (res.code === 'err:reason-not-applicable') {
		return {
			code: 'err:unknown-preset',
			msg: `Reason "${token}" isn't set up for ${AAR.ADMIN_ACTIONS[action].displayName}. ${reasonOptionsHint(applicable)}`,
		}
	}
	const suggestion = LP.didYouMean(token, LP.labelAliasStrings(applicable))
	return {
		code: 'err:unknown-preset',
		msg: `Unknown reason "${token}".${suggestion ? ` Did you mean ${suggestion}?` : ''} ${reasonOptionsHint(applicable)}`,
	}
}

// snapshots a chat-resolved reason arg into an AppliedReason (see AAR.AppliedReason)
export function applyResolvedReason(
	action: AAR.AdminActionType,
	resolved: ResolvedReasonArg,
	vars: Record<string, string>,
): AAR.AppliedReason {
	return resolved.type === 'preset' ? AAR.applyReason(action, resolved.reason, vars) : AAR.applyCustomReason(resolved.text, vars)
}

// one token must match a configured reason set up for the action; two or more tokens are a custom message verbatim
export function resolveReasonArg(
	allReasons: AAR.AdminActionReason[],
	action: AAR.AdminActionType,
	tokens: string[],
): { code: 'ok'; value: ResolvedReasonArg } | { code: 'err:unknown-preset'; msg: string } {
	if (tokens.length === 1) {
		const res = resolveReasonToken(allReasons, action, tokens[0])
		if (res.code !== 'ok') return res
		return { code: 'ok', value: { type: 'preset', reason: res.reason } }
	}
	return { code: 'ok', value: { type: 'custom', text: tokens.join(' ') } }
}

export function resolveBroadcastArg(
	presets: LP.BroadcastPreset[],
	tokens: string[],
): { code: 'ok'; value: ResolvedBroadcastArg } | { code: 'err:unknown-preset'; msg: string } {
	if (tokens.length === 1) {
		const preset = LP.findByLabelOrAlias(presets, tokens[0])
		if (!preset) return { code: 'err:unknown-preset', msg: unknownPresetMsg('broadcast', tokens[0], presets) }
		return { code: 'ok', value: { type: 'preset', preset } }
	}
	return { code: 'ok', value: { type: 'custom', text: tokens.join(' ') } }
}

// renders a single arg's usage token. `requiredReasonActions` (typically GlobalSettings.requireReasonFor) forces a
// reason/preset-reason arg to render as required (<...>) even when its declaration marks it optional, so signatures
// reflect the configured requirement. `reason` accepts free text (shown as `name|message`); `preset-reason` is preset-only.
export function formatArg(def: ArgDef, requiredReasonActions: readonly AAR.AdminActionType[] = []): string {
	const reasonRequired = (def.kind === 'reason' || def.kind === 'preset-reason') && requiredReasonActions.includes(def.action)
	const optional = !reasonRequired && def.kind !== 'squad' && def.kind !== 'broadcast' && def.optional
	let inner: string
	switch (def.kind) {
		case 'squad':
			return '[team] <squad>'
		case 'reason':
			inner = `${def.name}|message`
			break
		case 'broadcast':
			inner = 'preset|message'
			break
		default:
			inner = def.name
	}
	return optional ? `[${inner}]` : `<${inner}>`
}

export function formatArgSignature(args: readonly ArgDef[], requiredReasonActions: readonly AAR.AdminActionType[] = []): string {
	return args.map((def) => formatArg(def, requiredReasonActions)).join(' ').trim()
}

export function formatUsage(id: CommandId, config: CommandConfig, prefix: string): string {
	const cmdString = config.strings[0] ?? id
	return `Usage: ${prefix}${cmdString} ${formatArgSignature(COMMAND_DECLARATIONS[id].args)}`.trim()
}

function matchCommandText(configs: CommandConfigs, cmdText: string) {
	for (const [cmd, config] of Object.entries(configs)) {
		if (config.strings.some(s => s.toLowerCase() === cmdText.toLowerCase())) {
			return cmd as CommandId
		}
	}
	return null
}

export function chatInScope(scopes: CommandScope[], msgChat: SM.ChatChannelType) {
	for (const scope of scopes) {
		if (CHAT_SCOPE_MAPPINGS[scope].includes(msgChat)) {
			return true
		}
	}
	return false
}

export function getScopesForChat(chat: SM.ChatChannelType): CommandScope[] {
	const matches: CommandScope[] = []
	for (const [scope, chats] of Object.entries(CHAT_SCOPE_MAPPINGS)) {
		if (chats.includes(chat)) {
			matches.push(scope as CommandScope)
		}
	}
	return matches
}

export function buildCommand(
	id: CommandId,
	argObj: Record<string, string>,
	configs: CommandConfigs,
	prefix: string,
	excludeConsoleCommand = false,
) {
	const declaration = COMMAND_DECLARATIONS[id]
	const config = configs[id]
	let unrealConsoleCommand: string
	if (excludeConsoleCommand) unrealConsoleCommand = ''
	else if (config.scopes.includes('admin')) unrealConsoleCommand = 'ChatToAdmin'
	else if (config.scopes.includes('public')) unrealConsoleCommand = 'ChatToAll'
	else throw new Error(`Invalid scope for command ${id}`)
	const argSubstring = (declaration.args as readonly ArgDef[]).map((arg) => argObj[arg.name] ?? '').join(' ')
	return config.strings
		.sort((a, b) => b.length - a.length)
		.map(str => {
			return `${unrealConsoleCommand} ${prefix}${str} ${argSubstring}`.trim()
		})
}
