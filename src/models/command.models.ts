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

// How a scope is labelled wherever it's shown. A scope is a restriction on where a command may be typed, but a bare
// "admin" badge reads as "admins can use this" rather than "only admin chat accepts this", which is what it means.
export const COMMAND_SCOPE_LABELS: Record<CommandScope, string> = {
	admin: 'admin only',
	public: 'public',
}
export type CommandConfig = {
	strings: string[]
	scopes: CommandScope[]
	enabled: boolean
	// whether the command appears on the quick reference: the commands page's top section, and the only commands
	// bare `!help` lists (see Messages.WARNS.commands.help)
	quickReference: boolean
}

export type CommandConfigs = { [k in CommandId]: CommandConfig }

// -------- sections --------

// The section a command belongs to. Declared per command rather than configured: sections are the axis both the
// commands page's table of contents and `!help <section>` navigate by, so they have to stay exhaustive as commands
// are added, and a section an admin renamed out from under a stored alias would be a needless failure mode.
export const COMMAND_SECTIONS = {
	general: { label: 'General' },
	votes: { label: 'Votes & SLM Updates' },
	teamswaps: { label: 'Teamswaps' },
	flags: { label: 'Player Flags' },
	moderation: { label: 'Moderation' },
	messaging: { label: 'Messaging' },
} as const satisfies Record<string, { label: string }>

export type CommandSection = keyof typeof COMMAND_SECTIONS
export const COMMAND_SECTION_IDS = Object.keys(COMMAND_SECTIONS) as CommandSection[]

// the reserved `!help` argument listing every command regardless of section. Not a section itself, so it can't
// collide with one
export const ALL_SECTIONS_TOKEN = 'all'

// Every token the help command's `section` arg accepts, in declaration order. Always derive listings of the sections
// from this rather than writing them out: a section added to COMMAND_SECTIONS has to show up everywhere it's
// advertised, and the ids (never the labels) are what's typeable -- see resolveSectionToken's caveat.
export function sectionTokens(): string[] {
	return [...COMMAND_SECTION_IDS, ALL_SECTIONS_TOKEN]
}

// Resolves a user-typed section token (`!help moderation`), matching the id or the label case-insensitively. A label
// is only ever reachable when it's a single word, since `section` is a single-token arg -- so only ids are advertised
// (see sectionTokens); matching labels is a convenience for the ones that happen to be typeable.
export function resolveSectionToken(token: string): CommandSection | undefined {
	const t = token.trim().toLowerCase()
	return COMMAND_SECTION_IDS.find((id) => id.toLowerCase() === t || COMMAND_SECTIONS[id].label.toLowerCase() === t)
}

export function commandsInSection(section: CommandSection): CommandId[] {
	return COMMAND_IDS.filter((id) => COMMAND_DECLARATIONS[id].section === section)
}

// Args are declared with a kind so token assignment, resolution, and usage strings are all derived centrally
// (see assignArgTokens + resolveArgs in commands.server). Handlers receive typed values via CommandArgs<Id>.
//
// `describe` is an optional per-arg note for the detailed help on the commands page. Each kind already carries its own
// generic explanation (see ARG_KIND_HELP in command-help.models), so only set this where the kind's blurb doesn't say
// what this particular arg means.
//
// `sample` overrides the token the generated examples fill this arg with. Kinds whose values are drawn from live
// settings (reason, broadcast) or are self-evident (player, duration) sample themselves; set this for `string` and
// `int` args, whose name is all the generator would otherwise have to go on.
type ArgCommon = { name: string; describe?: string; sample?: string }
export type ArgDef =
	// single token, passed through as-is
	| ArgCommon & { kind: 'string'; optional?: true }
	// single token, coerced to an integer
	| ArgCommon & { kind: 'int'; optional?: true }
	// single token, a HumanTime duration like 2h or 30m, resolved to milliseconds
	| ArgCommon & { kind: 'duration'; optional?: true }
	// single token, resolved to a unique player by id or username substring
	| ArgCommon & { kind: 'player'; optional?: true }
	// 1-2 tokens: [team] <squad>; team = 1|2|A|B|faction, caller's team when omitted
	| ArgCommon & { kind: 'squad' }
	// rest: raw remainder joined with spaces
	| ArgCommon & { kind: 'text'; optional?: true }
	// rest: a single token must match a configured reason (label/alias); 2+ tokens are a custom message
	| ArgCommon & { kind: 'reason'; action: AAR.AdminActionType; optional?: true }
	// single token, configured reason only
	| ArgCommon & { kind: 'preset-reason'; action: AAR.AdminActionType; optional?: true }
	// rest: a single token must match a configured broadcast (label/alias); 2+ tokens are broadcast verbatim
	| ArgCommon & { kind: 'broadcast' }

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
	opts: { section: CommandSection; args: Args; defaults: CommandConfig },
) {
	assertValidArgDefs(id, opts.args)
	return {
		[id]: {
			id,
			section: opts.section,
			defaults: opts.defaults,
			args: opts.args,
		},
	} as { [K in Id]: { id: Id; section: CommandSection; defaults: CommandConfig; args: Args } }
}

// `quickReference` seeds the default cheat sheet: the handful of commands an admin reaches for in a normal shift,
// which is what a bare `!help` in the middle of a match should answer with. Admins re-pick it per installation.
export const COMMAND_DECLARATIONS = {
	...declareCommand('help', {
		section: 'general',
		args: [{
			kind: 'string',
			name: 'section',
			optional: true,
			sample: 'moderation',
			describe: `One of ${COMMAND_SECTION_IDS.join(', ')}, or "${ALL_SECTIONS_TOKEN}" for every command. `
				+ 'Lists the quick reference when omitted.',
		}],
		defaults: {
			scopes: ['admin'],
			strings: ['help', 'h'],
			enabled: true,
			quickReference: true,
		},
	}),
	...declareCommand('requestFeedback', {
		section: 'general',
		// queue numbers accept dotted forms like "2.1", so this stays a string arg
		args: [{
			kind: 'string',
			name: 'number',
			optional: true,
			sample: '2.1',
			describe: 'A queue item number like 2 or 2.1. Defaults to the next item.',
		}],
		defaults: { scopes: ['admin'], strings: ['feedback', 'fb'], enabled: true, quickReference: false },
	}),
	...declareCommand('startVote', {
		section: 'votes',
		args: [],
		defaults: {
			scopes: ['admin'],
			strings: ['startvote', 'sv'],
			enabled: true,
			quickReference: false,
		},
	}),
	...declareCommand('abortVote', {
		section: 'votes',
		args: [],
		defaults: { scopes: ['admin'], strings: ['abortvote', 'av'], enabled: true, quickReference: false },
	}),
	...declareCommand('endVoteEarly', {
		section: 'votes',
		args: [],
		defaults: { scopes: ['admin'], strings: ['endvote', 'ev'], enabled: true, quickReference: false },
	}),
	...declareCommand('showNext', {
		section: 'general',
		args: [],
		defaults: { scopes: ['admin', 'public'], strings: ['shownext', 'sn'], enabled: true, quickReference: true },
	}),
	...declareCommand('enableSlmUpdates', {
		section: 'votes',
		args: [],
		defaults: { scopes: ['admin'], strings: ['enableslm'], enabled: true, quickReference: false },
	}),
	...declareCommand('disableSlmUpdates', {
		section: 'votes',
		args: [],
		defaults: { scopes: ['admin'], strings: ['disableslm'], enabled: true, quickReference: false },
	}),
	...declareCommand('getSlmUpdatesEnabled', {
		section: 'votes',
		args: [],
		defaults: { scopes: ['admin'], strings: ['slmstatus'], enabled: true, quickReference: false },
	}),
	...declareCommand('swapNow', {
		section: 'teamswaps',
		args: [{ kind: 'player', name: 'player' }],
		defaults: { scopes: ['admin'], strings: ['swapnow'], enabled: true, quickReference: true },
	}),
	...declareCommand('swapNext', {
		section: 'teamswaps',
		args: [{ kind: 'player', name: 'player' }],
		defaults: { scopes: ['admin'], strings: ['swapnext'], enabled: true, quickReference: true },
	}),
	...declareCommand('swapSquadNow', {
		section: 'teamswaps',
		args: [{ kind: 'squad', name: 'squad' }],
		defaults: { scopes: ['admin'], strings: ['swapsquadnow'], enabled: true, quickReference: false },
	}),
	...declareCommand('swapSquadNext', {
		section: 'teamswaps',
		args: [{ kind: 'squad', name: 'squad' }],
		defaults: { scopes: ['admin'], strings: ['swapsquadnext'], enabled: true, quickReference: false },
	}),
	...declareCommand('swaps', {
		section: 'teamswaps',
		args: [],
		defaults: { scopes: ['admin'], strings: ['swaps'], enabled: true, quickReference: true },
	}),
	...declareCommand('clearSwaps', {
		section: 'teamswaps',
		args: [],
		defaults: { scopes: ['admin'], strings: ['clearswaps'], enabled: true, quickReference: false },
	}),
	...declareCommand('flag', {
		section: 'flags',
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'string', name: 'flag', sample: 'cheater', describe: 'The name of a BattleMetrics flag in your organization.' },
			{ kind: 'text', name: 'reason', optional: true, describe: "Posted as a note on the player's BM profile. Some flags require one." },
		],
		defaults: { scopes: ['admin'], strings: ['flag'], enabled: true, quickReference: true },
	}),
	...declareCommand('removeFlag', {
		section: 'flags',
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'string', name: 'flag', sample: 'cheater', describe: 'The name of a BattleMetrics flag currently on the player.' },
			{ kind: 'text', name: 'reason', optional: true, describe: "Posted as a note on the player's BM profile." },
		],
		defaults: { scopes: ['admin'], strings: ['removeFlag', 'rf'], enabled: true, quickReference: false },
	}),
	...declareCommand('listFlags', {
		section: 'flags',
		args: [{ kind: 'player', name: 'player', optional: true, describe: 'Lists every flag in the organization when omitted.' }],
		defaults: { enabled: true, scopes: ['admin'], strings: ['listflags', 'lf'], quickReference: false },
	}),
	...declareCommand('warn', {
		section: 'moderation',
		args: [{ kind: 'player', name: 'player' }, { kind: 'reason', name: 'reason', action: 'warn' }],
		defaults: { scopes: ['admin'], strings: ['warn'], enabled: true, quickReference: true },
	}),
	...declareCommand('listWarnReasons', {
		section: 'moderation',
		args: [],
		defaults: { scopes: ['admin'], strings: ['warnreasons', 'warns'], enabled: true, quickReference: false },
	}),
	...declareCommand('warnSquad', {
		section: 'moderation',
		args: [{ kind: 'squad', name: 'squad' }, { kind: 'reason', name: 'reason', action: 'warn' }],
		defaults: { scopes: ['admin'], strings: ['warnsquad', 'ws'], enabled: true, quickReference: false },
	}),
	...declareCommand('kill', {
		section: 'moderation',
		args: [{ kind: 'player', name: 'player' }, { kind: 'reason', name: 'reason', action: 'kill', optional: true }],
		defaults: { scopes: ['admin'], strings: ['kill'], enabled: true, quickReference: false },
	}),
	...declareCommand('killSquad', {
		section: 'moderation',
		args: [{ kind: 'squad', name: 'squad' }, { kind: 'reason', name: 'reason', action: 'kill', optional: true }],
		defaults: { scopes: ['admin'], strings: ['killsquad'], enabled: true, quickReference: false },
	}),
	...declareCommand('removeFromSquad', {
		section: 'moderation',
		args: [{ kind: 'player', name: 'player' }, { kind: 'reason', name: 'reason', action: 'remove-from-squad', optional: true }],
		defaults: { scopes: ['admin'], strings: ['rfs', 'removefromsquad'], enabled: true, quickReference: false },
	}),
	...declareCommand('disbandSquad', {
		section: 'moderation',
		args: [{ kind: 'squad', name: 'squad' }, { kind: 'reason', name: 'reason', action: 'disband-squad', optional: true }],
		defaults: { scopes: ['admin'], strings: ['disband'], enabled: true, quickReference: false },
	}),
	...declareCommand('demoteCommander', {
		section: 'moderation',
		args: [{ kind: 'player', name: 'player' }, { kind: 'reason', name: 'reason', action: 'demote-commander', optional: true }],
		defaults: { scopes: ['admin'], strings: ['demote'], enabled: true, quickReference: false },
	}),
	...declareCommand('broadcast', {
		section: 'messaging',
		args: [{ kind: 'broadcast', name: 'message' }],
		defaults: { scopes: ['admin'], strings: ['broadcast', 'b'], enabled: true, quickReference: true },
	}),
	...declareCommand('kick', {
		section: 'moderation',
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'reason', name: 'reason', action: 'kick', optional: true },
		],
		defaults: { scopes: ['admin'], strings: ['kick'], enabled: true, quickReference: true },
	}),
	...declareCommand('kickSquad', {
		section: 'moderation',
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'reason', name: 'reason', action: 'kick', optional: true },
		],
		defaults: { scopes: ['admin'], strings: ['kicksquad'], enabled: true, quickReference: false },
	}),
	...declareCommand('timeout', {
		section: 'moderation',
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'duration', name: 'duration' },
			{ kind: 'reason', name: 'reason', action: 'timeout', optional: true },
		],
		defaults: { scopes: ['admin'], strings: ['timeout', 'to'], enabled: true, quickReference: true },
	}),
	...declareCommand('timeoutSquad', {
		section: 'moderation',
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'duration', name: 'duration' },
			{ kind: 'reason', name: 'reason', action: 'timeout', optional: true },
		],
		defaults: { scopes: ['admin'], strings: ['timeoutsquad', 'tos'], enabled: true, quickReference: false },
	}),
	// the target may be offline, so the arg is a plain token resolved against players with active timeouts
	...declareCommand('clearTimeout', {
		section: 'moderation',
		args: [{
			kind: 'string',
			name: 'player',
			sample: 'Alice',
			describe: 'A player id, or a username substring matched against players with an active timeout.',
		}],
		defaults: { scopes: ['admin'], strings: ['cleartimeout', 'ct'], enabled: true, quickReference: false },
	}),
}

export type CommandId = keyof typeof COMMAND_DECLARATIONS
export const COMMAND_ID = z.enum(Object.keys(COMMAND_DECLARATIONS) as [CommandId, ...CommandId[]])
export const COMMAND_IDS = Object.keys(COMMAND_DECLARATIONS) as CommandId[]
export type CommandDeclaration<Id extends CommandId> = (typeof COMMAND_DECLARATIONS)[Id]

// the prefix a fresh install seeds command strings with, when no settings exist yet to read `defaultPrefix` from.
// matches the prefix migration 0074 falls back to, so a fresh install and a migrated one agree on what to type.
export const FALLBACK_PREFIX = '!'

// a command prefix: one or more ASCII special (punctuation/symbol) characters. Letters, digits, whitespace and
// non-ASCII are excluded so a prefix can't be mistaken for the command word itself. Exported so the settings editor
// can validate the prefix inputs the same way the schema does.
export const PREFIX_ERROR = 'Prefix must be one or more ASCII special characters (e.g. ! . @ #)'
const ASCII_SPECIAL = /^[!-/:-@[-`{-~]+$/
export function isValidPrefix(s: string): boolean {
	return ASCII_SPECIAL.test(s)
}
export const PrefixSchema = z.string().min(1).regex(ASCII_SPECIAL, PREFIX_ERROR)

// declared strings are bare (`help`); the stored ones carry a prefix (`!help`), which is attached by
// seedCommandConfigs using the installation's configured defaultPrefix
function prefixed(prefix: string, config: CommandConfig): CommandConfig {
	return { ...config, strings: config.strings.map((s) => prefix + s) }
}

// fills in every command the installation hasn't stored a config for yet, prefixing its declared strings with
// `defaultPrefix`. Runs before the settings schema parses raw data (see Settings.loadGlobalSettings): a command
// added by a later release must be seeded with a prefix the installation actually allows, and zod can't express a
// prefault that depends on a sibling field. Configs already present are passed through untouched.
export function seedCommandConfigs(commands: unknown, defaultPrefix: string): Record<string, unknown> {
	const stored = (commands && typeof commands === 'object') ? commands as Record<string, unknown> : {}
	const seeded: Record<string, unknown> = { ...stored }
	for (const [id, declaration] of Object.entries(COMMAND_DECLARATIONS)) {
		if (seeded[id] === undefined) seeded[id] = prefixed(defaultPrefix, declaration.defaults)
	}
	return seeded
}

function CommandConfigSchema(commandId: CommandId) {
	const declared = COMMAND_DECLARATIONS[commandId].defaults
	return z.object({
		strings: z.array(BasicStrNoWhitespace).describe(
			'Command strings that trigger this command. Each must start with one of the allowed prefixes',
		),
		scopes: z.array(COMMAND_SCOPES).prefault(declared.scopes).describe('Scopes in which this command is available'),
		enabled: z.boolean().prefault(declared.enabled),
		quickReference: z.boolean().prefault(declared.quickReference).describe(
			'Show this command on the quick reference: the top section of the commands page, and the only commands a bare help command lists',
		),
	})
}

// no prefault on the object or on `strings`: a command's default strings depend on `defaultPrefix`, so they're
// seeded by seedCommandConfigs before parsing rather than baked into the schema
export const AllCommandConfigSchema = z.object(
	Object.fromEntries(Object.keys(COMMAND_DECLARATIONS).map(id => [id, CommandConfigSchema(id as CommandId)])) as Record<
		CommandId,
		ReturnType<typeof CommandConfigSchema>
	>,
)

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

// command strings carry their own prefix (`!help`), so the whole first word is matched as-is
export function parseCommand(msg: SM.RconEvents.ChatMessage, configs: CommandConfigs) {
	const words = msg.message.split(/\s+/)
	const cmd = matchCommandText(configs, words[0])
	if (!cmd) {
		const allCommandStrings = Obj.objValues(configs)
			.filter((c) => chatInScope(c.scopes, msg.channelType))
			.flatMap((c) => c.strings)
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

export function formatUsage(id: CommandId, config: CommandConfig): string {
	const cmdString = config.strings[0] ?? id
	return `Usage: ${cmdString} ${formatArgSignature(COMMAND_DECLARATIONS[id].args)}`.trim()
}

function matchCommandText(configs: CommandConfigs, cmdText: string) {
	for (const [cmd, config] of Object.entries(configs)) {
		if (config.strings.some(s => s.toLowerCase() === cmdText.toLowerCase())) {
			return cmd as CommandId
		}
	}
	return null
}

// -------- command aliases --------

// A shortcut to a complete command invocation: `/rules` -> `/broadcast Read the rules`. The aliased command carries
// all of its own arguments and tokens typed after the alias are ignored, so an alias is a plain text substitution.
//
// If aliases ever need to take arguments, pin them by name (`/timeout duration=2h`, leaving `player` and `reason` to
// be typed in chat) rather than splicing tokens positionally: a positional splice can only fix arguments that come
// first, which can't express the old fixed-duration timeout aliases (`duration` sits between `player` and `reason`).
export type CommandAlias = { alias: string; command: string }

export type AliasResolution =
	// the target is resolved but may be disabled; callers decide whether that's an error (dispatch) or a display
	// concern (the settings editor and help listings, which show it as unavailable)
	| { code: 'ok'; cmdId: CommandId; tokens: string[] }
	// the first word matches no configured command string. Not a schema error: a later SLM release can rename a
	// command's strings out from under a stored alias, and that must not stop the settings from loading
	| { code: 'err:unknown-command'; msg: string }
	| { code: 'err:invalid-args'; msg: string }

// Static validation of an alias's command text: everything checkable without the live roster or the configured
// reasons. Resolves the command string, then checks the args assign (all required ones present) and that int and
// duration tokens parse. Player/squad/reason tokens can only be checked at dispatch, so they're taken on faith.
export function resolveAliasCommand(command: string, configs: CommandConfigs): AliasResolution {
	const words = command.trim().split(/\s+/).filter((w) => w !== '')
	if (words.length === 0) return { code: 'err:unknown-command', msg: 'No command given' }
	const cmdId = matchCommandText(configs, words[0])
	if (!cmdId) return { code: 'err:unknown-command', msg: `"${words[0]}" is not a configured command string` }

	const tokens = words.slice(1)
	const args = COMMAND_DECLARATIONS[cmdId].args as readonly ArgDef[]
	// permissive predicates: a team can be named by the current layer's faction, which isn't knowable here, and
	// treating no token as a configured reason keeps the squad window from being narrowed on a guess
	const assigned = assignArgTokens(args, tokens, { isTeamToken: () => true, isPresetToken: () => false })
	if (assigned.code === 'err:missing-arg') {
		return { code: 'err:invalid-args', msg: `Missing <${assigned.argName}>. Usage: ${words[0]} ${formatArgSignature(args)}`.trim() }
	}
	for (const def of args) {
		const window = assigned.windows[def.name]
		if (!window || window.length === 0) continue
		if (def.kind === 'int') {
			const res = coerceIntArg(def.name, window[0])
			if (res.code !== 'ok') return { code: 'err:invalid-args', msg: res.msg }
		}
		if (def.kind === 'duration') {
			const res = resolveDurationArg(def.name, window[0])
			if (res.code !== 'ok') return { code: 'err:invalid-args', msg: res.msg }
		}
	}
	return { code: 'ok', cmdId, tokens }
}

// a real command string always wins on collision, so an alias is only consulted when the token matches none
export function findAlias(aliases: readonly CommandAlias[], configs: CommandConfigs, token: string): CommandAlias | undefined {
	if (matchCommandText(configs, token)) return undefined
	return aliases.find((a) => a.alias.toLowerCase() === token.toLowerCase())
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
		.toSorted((a, b) => b.length - a.length)
		.map(str => {
			return `${unrealConsoleCommand} ${str} ${argSubstring}`.trim()
		})
}
