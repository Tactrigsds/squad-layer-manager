import StringComparison from 'string-comparison'
import { z } from 'zod'

import * as Obj from '@/lib/object-utils'
import * as Str from '@/lib/string-utils'
import { renderTemplate, templateVars } from '@/lib/templating'
import * as ZodUtils from '@/lib/zod-utils'
import * as AAR from '@/models/admin-action-reasons.models'
import * as LP from '@/models/labeled-presets.models'
import type * as SM from '@/models/squad.models.ts'
import type * as RBAC from '@/rbac.models'

export const CHAT_GROUPS = z.enum(['admin', 'public'])
export type ChatGroup = z.infer<typeof CHAT_GROUPS>

export const CHAT_GROUP_CHANNELS = {
	[CHAT_GROUPS.enum.admin]: ['ChatAdmin'],
	[CHAT_GROUPS.enum.public]: ['ChatTeam', 'ChatSquad', 'ChatAll'],
}

// A string that runs a command. A bare string passes whatever follows it straight through as the command's arguments
// (`/timeout Alice 2h spam`). An object pins some of them with a template over the words typed after it, which is what
// used to be a separate "command alias": `{ string: '/to2h', args: '{{arg1}} 2h {{rest2}}' }`. See docs/configuring.md.
export type CommandTrigger = string | { string: string; args: string }

// The indices count the words the CALLER TYPES after the trigger, not the words of the command that ends up running:
// pinned text occupies no index, so `{{arg1}} 2h {{rest2}}` takes a player and a reason, never a duration. `{{restN}}`
// is the Nth typed word onwards joined by spaces, `{{rest}}` is all of them. 1-based, matching how they read in chat.
export const TRIGGER_ARG_SYNTAX =
	'{{arg1}} for the first word typed after the trigger, {{arg2}} for the second, {{rest2}} for the second onwards'

export function triggerString(trigger: CommandTrigger): string {
	return typeof trigger === 'string' ? trigger : trigger.string
}

// the argument template, or undefined for a plain trigger, which takes the command's arguments exactly as typed
export function triggerArgs(trigger: CommandTrigger): string | undefined {
	return typeof trigger === 'string' ? undefined : trigger.args
}

export function withTriggerString(trigger: CommandTrigger, string: string): CommandTrigger {
	return typeof trigger === 'string' ? string : { ...trigger, string }
}

// the trigger a command is named by wherever one has to be picked: its first plain one, since a trigger that pins
// arguments describes a shortcut rather than the command itself
export function primaryTrigger(config: CommandConfig): CommandTrigger | undefined {
	return config.triggers.find((t) => typeof t === 'string') ?? config.triggers[0]
}

export type CommandConfig = {
	triggers: CommandTrigger[]
	allowedChats: ChatGroup[]
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
	layerRequests: { label: 'Layer Requests' },
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
// settings (reason) or are self-evident (player, duration) sample themselves; set this for `string` and
// `int` args, whose name is all the generator would otherwise have to go on.
type ArgCommon = { name: string; describe?: string; sample?: string }
export type ArgDef =
	// single token, passed through as-is
	| (ArgCommon & { kind: 'string'; optional?: true })
	// single token, coerced to an integer
	| (ArgCommon & { kind: 'int'; optional?: true })
	// single token, a HumanTime duration like 2h or 30m, resolved to milliseconds
	| (ArgCommon & { kind: 'duration'; optional?: true })
	// single token, resolved to a unique player by id or username substring
	| (ArgCommon & { kind: 'player'; optional?: true })
	// 1-2 tokens: [team] <squad>; team = 1|2|A|B|faction, caller's team when omitted
	| (ArgCommon & { kind: 'squad' })
	// rest: raw remainder joined with spaces
	| (ArgCommon & { kind: 'text'; optional?: true })
	// rest: a single token must match one of a configured reason's keywords; 2+ tokens are a custom message
	| (ArgCommon & { kind: 'reason'; action: AAR.AdminActionType; optional?: true })
	// single token, configured reason only
	| (ArgCommon & { kind: 'preset-reason'; action: AAR.AdminActionType; optional?: true })

const REST_KINDS: ArgDef['kind'][] = ['text', 'reason']

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

// What the dispatcher requires before running a command. `null` means the command needs no up-front permission:
// either it only reads, or its grant is a comparator ("a timeout up to N") or depends on the target's owner, both of
// which can only be checked once the arguments are resolved -- those commands check in their handler instead.
//
// Required rather than optional on purpose: a new command must state its answer, so one can't be added unguarded.
export type CommandPermission = RBAC.ServerPermissionType | 'battlemetrics:write-flags' | null

function declareCommand<Id extends string, const Args extends readonly ArgDef[]>(
	id: Id,
	opts: { section: CommandSection; permission: CommandPermission; args: Args; defaults: CommandConfig },
) {
	assertValidArgDefs(id, opts.args)
	return {
		[id]: {
			id,
			section: opts.section,
			permission: opts.permission,
			defaults: opts.defaults,
			args: opts.args,
		},
	} as { [K in Id]: { id: Id; section: CommandSection; permission: CommandPermission; defaults: CommandConfig; args: Args } }
}

// `quickReference` seeds the default cheat sheet: the handful of commands an admin reaches for in a normal shift,
// which is what a bare `!help` in the middle of a match should answer with. Admins re-pick it per installation.
export const COMMAND_DECLARATIONS = {
	...declareCommand('help', {
		section: 'general',
		permission: null,
		args: [
			{
				kind: 'string',
				name: 'section',
				optional: true,
				sample: 'moderation',
				describe:
					`One of ${COMMAND_SECTION_IDS.join(', ')}, or "${ALL_SECTIONS_TOKEN}" for every command. ` +
					'Lists the quick reference when omitted.',
			},
		],
		defaults: {
			allowedChats: ['admin'],
			triggers: ['help', 'h'],
			enabled: true,
			quickReference: true,
		},
	}),
	...declareCommand('requestFeedback', {
		section: 'general',
		permission: null,
		// queue numbers accept dotted forms like "2.1", so this stays a string arg
		args: [
			{
				kind: 'string',
				name: 'number',
				optional: true,
				sample: '2.1',
				describe: 'A queue item number like 2 or 2.1. Defaults to the next item.',
			},
		],
		defaults: { allowedChats: ['admin'], triggers: ['feedback', 'fb'], enabled: true, quickReference: false },
	}),
	...declareCommand('startVote', {
		section: 'votes',
		permission: 'vote:manage',
		args: [],
		defaults: {
			allowedChats: ['admin'],
			triggers: ['startvote', 'sv'],
			enabled: true,
			quickReference: false,
		},
	}),
	...declareCommand('abortVote', {
		section: 'votes',
		permission: 'vote:manage',
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['abortvote', 'av'], enabled: true, quickReference: false },
	}),
	...declareCommand('endVoteEarly', {
		section: 'votes',
		permission: 'vote:manage',
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['endvote', 'ev'], enabled: true, quickReference: false },
	}),
	...declareCommand('showNext', {
		section: 'general',
		permission: null,
		args: [],
		defaults: { allowedChats: ['admin', 'public'], triggers: ['shownext', 'sn'], enabled: true, quickReference: true },
	}),
	...declareCommand('enableSlmUpdates', {
		section: 'votes',
		permission: 'squad-server:disable-slm-updates',
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['enableslm'], enabled: true, quickReference: false },
	}),
	...declareCommand('disableSlmUpdates', {
		section: 'votes',
		permission: 'squad-server:disable-slm-updates',
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['disableslm'], enabled: true, quickReference: false },
	}),
	...declareCommand('getSlmUpdatesEnabled', {
		section: 'votes',
		permission: null,
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['slmstatus'], enabled: true, quickReference: false },
	}),
	...declareCommand('requestLayer', {
		section: 'layerRequests',
		permission: null,
		args: [
			{
				kind: 'text',
				name: 'request',
				sample: 'goro adf pla',
				describe:
					'Any mix of map, gamemode, size, faction, alliance, unit or filter names. Map and filter names match loosely; ' +
					'everything else must match exactly. Two factions (or alliances/units) mean a matchup.',
			},
		],
		defaults: {
			allowedChats: ['admin', 'public'],
			triggers: ['requestlayer', 'reqlayer', 'rql'],
			enabled: true,
			quickReference: false,
		},
	}),
	...declareCommand('listLayerRequests', {
		section: 'layerRequests',
		permission: null,
		args: [],
		defaults: { allowedChats: ['admin', 'public'], triggers: ['reqs', 'listreqs'], enabled: true, quickReference: false },
	}),
	...declareCommand('removeLayerRequest', {
		section: 'layerRequests',
		permission: null,
		args: [
			{
				kind: 'int',
				name: 'number',
				optional: true,
				sample: '2',
				describe: 'The request number from the list. Removes your newest request when omitted.',
			},
		],
		defaults: { allowedChats: ['admin', 'public'], triggers: ['unreqlayer', 'rmreq'], enabled: true, quickReference: false },
	}),
	...declareCommand('swapNow', {
		section: 'teamswaps',
		permission: 'squad-server:manage-players',
		args: [{ kind: 'player', name: 'player' }],
		defaults: { allowedChats: ['admin'], triggers: ['swapnow'], enabled: true, quickReference: true },
	}),
	...declareCommand('swapNext', {
		section: 'teamswaps',
		permission: 'squad-server:manage-players',
		args: [{ kind: 'player', name: 'player' }],
		defaults: { allowedChats: ['admin'], triggers: ['swapnext'], enabled: true, quickReference: true },
	}),
	...declareCommand('swapSquadNow', {
		section: 'teamswaps',
		permission: 'squad-server:manage-players',
		args: [{ kind: 'squad', name: 'squad' }],
		defaults: { allowedChats: ['admin'], triggers: ['swapsquadnow'], enabled: true, quickReference: false },
	}),
	...declareCommand('swapSquadNext', {
		section: 'teamswaps',
		permission: 'squad-server:manage-players',
		args: [{ kind: 'squad', name: 'squad' }],
		defaults: { allowedChats: ['admin'], triggers: ['swapsquadnext'], enabled: true, quickReference: false },
	}),
	...declareCommand('swaps', {
		section: 'teamswaps',
		permission: null,
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['swaps'], enabled: true, quickReference: true },
	}),
	...declareCommand('clearSwaps', {
		section: 'teamswaps',
		permission: 'squad-server:manage-players',
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['clearswaps'], enabled: true, quickReference: false },
	}),
	...declareCommand('flag', {
		section: 'flags',
		permission: 'battlemetrics:write-flags',
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'string', name: 'flag', sample: 'cheater', describe: 'The name of a BattleMetrics flag in your organization.' },
			{
				kind: 'text',
				name: 'reason',
				optional: true,
				describe: "Posted as a note on the player's BM profile. Some flags require one.",
			},
		],
		defaults: { allowedChats: ['admin'], triggers: ['flag'], enabled: true, quickReference: true },
	}),
	...declareCommand('removeFlag', {
		section: 'flags',
		permission: 'battlemetrics:write-flags',
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'string', name: 'flag', sample: 'cheater', describe: 'The name of a BattleMetrics flag currently on the player.' },
			{ kind: 'text', name: 'reason', optional: true, describe: "Posted as a note on the player's BM profile." },
		],
		defaults: { allowedChats: ['admin'], triggers: ['removeFlag', 'rf'], enabled: true, quickReference: false },
	}),
	...declareCommand('listFlags', {
		section: 'flags',
		permission: null,
		args: [{ kind: 'player', name: 'player', optional: true, describe: 'Lists every flag in the organization when omitted.' }],
		defaults: { enabled: true, allowedChats: ['admin'], triggers: ['listflags', 'lf'], quickReference: false },
	}),
	...declareCommand('pingAdmins', {
		section: 'moderation',
		permission: 'ping-admins',
		defaults: { enabled: true, allowedChats: ['public', 'admin'], triggers: ['admin'], quickReference: true },
		args: [{ kind: 'text', name: 'message', describe: 'The message you want to send to the admins.' }],
	}),
	...declareCommand('warn', {
		section: 'moderation',
		permission: 'squad-server:warn-players',
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'reason', name: 'reason', action: 'warn' },
		],
		defaults: { allowedChats: ['admin'], triggers: ['warn'], enabled: true, quickReference: true },
	}),
	...declareCommand('listWarnReasons', {
		section: 'moderation',
		permission: null,
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['warnreasons', 'warns'], enabled: true, quickReference: false },
	}),
	...declareCommand('warnSquad', {
		section: 'moderation',
		permission: 'squad-server:warn-players',
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'reason', name: 'reason', action: 'warn' },
		],
		defaults: { allowedChats: ['admin'], triggers: ['warnsquad', 'ws'], enabled: true, quickReference: false },
	}),
	...declareCommand('kill', {
		section: 'moderation',
		permission: 'squad-server:manage-players',
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'reason', name: 'reason', action: 'kill', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['kill'], enabled: true, quickReference: false },
	}),
	...declareCommand('killSquad', {
		section: 'moderation',
		permission: 'squad-server:manage-players',
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'reason', name: 'reason', action: 'kill', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['killsquad'], enabled: true, quickReference: false },
	}),
	...declareCommand('removeFromSquad', {
		section: 'moderation',
		permission: 'squad-server:manage-players',
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'reason', name: 'reason', action: 'remove-from-squad', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['rfs', 'removefromsquad'], enabled: true, quickReference: false },
	}),
	...declareCommand('disbandSquad', {
		section: 'moderation',
		permission: 'squad-server:manage-players',
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'reason', name: 'reason', action: 'disband-squad', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['disband'], enabled: true, quickReference: false },
	}),
	...declareCommand('demoteCommander', {
		section: 'moderation',
		permission: 'squad-server:manage-players',
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'reason', name: 'reason', action: 'demote-commander', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['demote'], enabled: true, quickReference: false },
	}),
	...declareCommand('broadcast', {
		section: 'messaging',
		permission: 'squad-server:broadcast',
		args: [{ kind: 'reason', name: 'reason', action: 'broadcast' }],
		defaults: { allowedChats: ['admin'], triggers: ['broadcast', 'b'], enabled: true, quickReference: true },
	}),
	...declareCommand('kick', {
		section: 'moderation',
		permission: 'squad-server:kick-players',
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'reason', name: 'reason', action: 'kick', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['kick'], enabled: true, quickReference: true },
	}),
	...declareCommand('kickSquad', {
		section: 'moderation',
		permission: 'squad-server:kick-players',
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'reason', name: 'reason', action: 'kick', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['kicksquad'], enabled: true, quickReference: false },
	}),
	...declareCommand('timeout', {
		section: 'moderation',
		permission: null,
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'duration', name: 'duration' },
			{ kind: 'reason', name: 'reason', action: 'timeout', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['timeout', 'to'], enabled: true, quickReference: true },
	}),
	...declareCommand('timeoutSquad', {
		section: 'moderation',
		permission: null,
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'duration', name: 'duration' },
			{ kind: 'reason', name: 'reason', action: 'timeout', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['timeoutsquad', 'tos'], enabled: true, quickReference: false },
	}),
	// the target may be offline, so the arg is a plain token resolved against players with active timeouts
	...declareCommand('clearTimeout', {
		section: 'moderation',
		permission: null,
		args: [
			{
				kind: 'string',
				name: 'player',
				sample: 'Alice',
				describe: 'A player id, or a username substring matched against players with an active timeout.',
			},
		],
		defaults: { allowedChats: ['admin'], triggers: ['cleartimeout', 'ct'], enabled: true, quickReference: false },
	}),
}

export type CommandId = keyof typeof COMMAND_DECLARATIONS
export const COMMAND_ID = z.enum(Object.keys(COMMAND_DECLARATIONS) as [CommandId, ...CommandId[]])
export const COMMAND_IDS = Object.keys(COMMAND_DECLARATIONS) as CommandId[]
export type CommandDeclaration<Id extends CommandId> = (typeof COMMAND_DECLARATIONS)[Id]

// the prefix a fresh install seeds command strings with, and what `defaultPrefix` starts as. An install migrated
// from before prefixes were configurable keeps the '!' migration 0074 gave it; this is only what a new one starts
// with, so the two deliberately no longer agree.
export const DEFAULT_PREFIX = '/'

// a command prefix: one or more ASCII special (punctuation/symbol) characters. Letters, digits, whitespace and
// non-ASCII are excluded so a prefix can't be mistaken for the command word itself. Exported so the settings editor
// can validate the prefix inputs the same way the schema does.
export const PREFIX_ERROR = 'Prefix must be one or more ASCII special characters (e.g. ! . @ #)'
const ASCII_SPECIAL = /^[!-/:-@[-`{-~]+$/
export function isValidPrefix(s: string): boolean {
	return ASCII_SPECIAL.test(s)
}
export const PrefixSchema = z.string().min(1).regex(ASCII_SPECIAL, PREFIX_ERROR)

// declared triggers are bare (`help`); the stored ones carry a prefix (`!help`), which is attached by
// seedCommandConfigs using the installation's configured defaultPrefix
function prefixed(prefix: string, config: CommandConfig): CommandConfig {
	return { ...config, triggers: config.triggers.map((t) => withTriggerString(t, prefix + triggerString(t))) }
}

// fills in every command the installation hasn't stored a config for yet, prefixing its declared triggers with
// `defaultPrefix`. Runs before the settings schema parses raw data (see Settings.loadGlobalSettings): a command
// added by a later release must be seeded with a prefix the installation actually allows, and zod can't express a
// prefault that depends on a sibling field. Configs already present are passed through untouched.
export function seedCommandConfigs(commands: unknown, defaultPrefix: string): Record<string, unknown> {
	const stored = commands && typeof commands === 'object' ? (commands as Record<string, unknown>) : {}
	const seeded: Record<string, unknown> = { ...stored }
	for (const [id, declaration] of Object.entries(COMMAND_DECLARATIONS)) {
		if (seeded[id] === undefined) seeded[id] = prefixed(defaultPrefix, declaration.defaults)
	}
	return seeded
}

export const CommandTriggerSchema = z.union([
	ZodUtils.BasicStrNoWhitespace,
	z.object({
		string: ZodUtils.BasicStrNoWhitespace,
		args: z
			.string()
			.min(1)
			.describe(`The arguments this trigger runs the command with. A template over the words typed after it: ${TRIGGER_ARG_SYNTAX}`),
	}),
])

function CommandConfigSchema(commandId: CommandId) {
	const declared = COMMAND_DECLARATIONS[commandId].defaults
	return z.object({
		triggers: z
			.array(CommandTriggerSchema)
			.describe(
				"Strings that run this command, each starting with one of the allowed prefixes. A plain string takes the command's " +
					'arguments as typed; give one an "args" template instead to pin some of them (what used to be a command alias)',
			),
		allowedChats: z.array(CHAT_GROUPS).prefault(declared.allowedChats).describe('Which in-game chats accept this command'),
		enabled: z.boolean().prefault(declared.enabled),
		quickReference: z
			.boolean()
			.prefault(declared.quickReference)
			.describe(
				'Show this command on the quick reference: the top section of the commands page, and the only commands a bare help command lists',
			),
	})
}

// no prefault on the object or on `triggers`: a command's default triggers depend on `defaultPrefix`, so they're
// seeded by seedCommandConfigs before parsing rather than baked into the schema
export const AllCommandConfigSchema = z.object(
	Object.fromEntries(Object.keys(COMMAND_DECLARATIONS).map((id) => [id, CommandConfigSchema(id as CommandId)])) as Record<
		CommandId,
		ReturnType<typeof CommandConfigSchema>
	>,
)

// -------- resolved argument shapes --------

export type ResolvedReasonArg = { type: 'preset'; reason: AAR.AdminActionReason } | { type: 'custom'; text: string }
// resolved by the server layer (needs the live roster); declared here so CommandArgs stays self-contained
export type ResolvedSquadArg = { teamId: SM.TeamId; teamLabel: string; squad: SM.Squad; players: SM.Player[] }

type ArgValue<D extends ArgDef> = D extends { kind: 'string' }
	? string
	: D extends { kind: 'int' }
		? number
		: D extends { kind: 'duration' }
			? number
			: D extends { kind: 'player' }
				? SM.Player
				: D extends { kind: 'squad' }
					? ResolvedSquadArg
					: D extends { kind: 'text' }
						? string
						: D extends { kind: 'reason' }
							? ResolvedReasonArg
							: D extends { kind: 'preset-reason' }
								? AAR.AdminActionReason
								: never

export type ResolvedArgs<Args extends readonly ArgDef[]> = {
	[D in Args[number] as D['name']]: D extends { optional: true } ? ArgValue<D> | undefined : ArgValue<D>
}
export type CommandArgs<Id extends CommandId> = ResolvedArgs<CommandDeclaration<Id>['args']>

// -------- Helpers --------

// Trigger strings carry their own prefix (`!help`), so the whole first word is matched as-is. A trigger with an args
// template feeds the words after it through that template; a plain one passes them straight through, which is the
// same thing with nothing pinned.
export function parseCommand(msg: SM.RconEvents.ChatMessage, configs: CommandConfigs) {
	const words = msg.message
		.trim()
		.split(/\s+/)
		.filter((w) => w !== '')
	const match = matchCommandText(configs, words[0] ?? '')
	if (!match) {
		const allTriggerStrings = Obj.objValues(configs)
			.filter((c) => chatAllowed(c.allowedChats, msg.channelType))
			.flatMap((c) => c.triggers.map(triggerString))
		const sortedMatches = StringComparison.diceCoefficient.sortMatch((words[0] ?? '').toLowerCase(), allTriggerStrings)
		if (sortedMatches.length === 0) {
			return { code: 'err:unknown-command' as const, msg: `Unknown command "${words[0] ?? ''}"` }
		}
		const matched = sortedMatches[sortedMatches.length - 1].member
		return {
			code: 'err:unknown-command' as const,
			msg: `Unknown command "${words[0]}". Did you mean ${matched}?`,
		}
	}
	const typed = words.slice(1)
	const args = triggerArgs(match.trigger)
	return {
		code: 'ok' as const,
		cmd: match.cmdId,
		trigger: match.trigger,
		tokens: args === undefined ? typed : expandTriggerArgs(args, typed),
	}
}

// a token that can name a squad without a roster: an in-game squad number or the "cmd" command-squad alias
// (squad names are resolved against the roster server-side, so they aren't recognized here)
function isSquadToken(token: string): boolean {
	return /^\d+$/.test(token) || token.toLowerCase() === 'cmd'
}

export type ArgTokenWindows = Record<string, string[] | undefined>

// where an argument's window sits in the token list, so a picked choice can be spliced back over exactly the
// words that failed to resolve (see spliceArgTokens)
export type ArgTokenRange = { start: number; len: number }
export type ArgTokenRanges = Record<string, ArgTokenRange | undefined>

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
): { code: 'ok'; windows: ArgTokenWindows; ranges: ArgTokenRanges } | { code: 'err:missing-arg'; argName: string } {
	const windows: ArgTokenWindows = {}
	const ranges: ArgTokenRanges = {}
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
				ranges[def.name] = { start: i, len: 1 }
				i += 1
				break
			}
			case 'text':
			case 'reason': {
				if (rem.length === 0) {
					if (!def.optional) return { code: 'err:missing-arg', argName: def.name }
					windows[def.name] = undefined
					break
				}
				windows[def.name] = rem
				ranges[def.name] = { start: i, len: rem.length }
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
				ranges[def.name] = { start: i, len: windowLen }
				i += windowLen
				break
			}
			default:
				def satisfies never
		}
	}
	return { code: 'ok', windows, ranges }
}

// -------- near misses --------

// A replacement offered when a typed token doesn't resolve. `tokens` are spliced back over the argument's window
// and resolved again, so they have to name the choice unambiguously: a steam id rather than a username, "1 3"
// rather than a squad name.
export type ArgChoice = { tokens: string[]; label: string }

// A failure the caller can fix by picking rather than by retyping. `msg` is the resolver's own account of what went
// wrong, which heads the prompt: only the resolver knows whether "1" failed as a team or as a squad.
export type NearMiss = { argName: string; typed: string; cause: 'no-match' | 'ambiguous'; msg: string; choices: ArgChoice[] }

// A Squad warn holds only a few lines, and a caller who has to read past three options is better served by the
// usage line.
export const MAX_CHOICES = 3

// Below this the closest match is noise, and offering a wrong player next to a right one invites picking it. Set at
// half, which is exactly where a one-character slip in a two-character reason keyword ("tq" for "tk") lands: the
// coarsest case that still has to survive.
const MIN_SIMILARITY = 0.5

// How close a typed token is to one candidate. Scored against the candidate's words as well as the whole of it, so
// a clan tag or a suffix ("[7CAV] Alice_G") doesn't drown out the part the caller was aiming at. Levenshtein rather
// than the dice coefficient: these strings are often short, where bigram overlap is degenerate.
function similarity(typed: string, candidate: string): number {
	const target = Str.normalizeForMatch(typed)
	if (target === '') return 0
	const parts = [candidate, ...candidate.split(/[^\p{L}\p{N}]+/u)].map(Str.normalizeForMatch).filter((p) => p !== '')
	return Math.max(0, ...parts.map((p) => StringComparison.levenshtein.similarity(target, p)))
}

// the items whose text is closest to what was typed, best first
export function nearestBy<T>(typed: string, items: readonly T[], text: (item: T) => string, limit = MAX_CHOICES): T[] {
	return items
		.map((item) => ({ item, score: similarity(typed, text(item)) }))
		.filter((scored) => scored.score >= MIN_SIMILARITY)
		.toSorted((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((scored) => scored.item)
}

export function nearest(typed: string, candidates: readonly string[], limit = MAX_CHOICES): string[] {
	return nearestBy(typed, candidates, (candidate) => candidate, limit)
}

// Applies picked choices back over the tokens the caller typed. Right to left, since a choice's token count need
// not match the window it replaces: a squad typed as one word comes back as "1 3".
export function spliceArgTokens(tokens: readonly string[], picks: { range: ArgTokenRange; tokens: string[] }[]): string[] {
	const out = [...tokens]
	for (const pick of picks.toSorted((a, b) => b.range.start - a.range.start)) {
		out.splice(pick.range.start, pick.range.len, ...pick.tokens)
	}
	return out
}

export function coerceIntArg(name: string, token: string): { code: 'ok'; value: number } | { code: 'err:invalid-int'; msg: string } {
	if (!/^-?\d+$/.test(token)) return { code: 'err:invalid-int', msg: `${name} must be an integer, got "${token}"` }
	return { code: 'ok', value: parseInt(token, 10) }
}

export function resolveDurationArg(
	name: string,
	token: string,
): { code: 'ok'; value: number } | { code: 'err:invalid-duration'; msg: string } {
	const value = ZodUtils.tryParseHumanTimeToken(token)
	if (value === undefined) {
		return { code: 'err:invalid-duration', msg: `${name} must be a duration like 30m, 2h or 1d, got "${token}"` }
	}
	return { code: 'ok', value }
}

// "Available: label (keyword1, keyword2), ..." listing the reasons valid for an action, for error hints
function reasonOptionsHint(applicable: AAR.AdminActionReason[]): string {
	if (applicable.length === 0) return 'No reasons are configured for this action.'
	return `Available: ${applicable.map(LP.describePreset).join(', ')}`
}

// The reasons closest to what was typed, one choice per reason: a reason with several near keywords is still one
// thing to pick, and the keyword that stands for it only has to resolve, not to be the closest.
function reasonChoices(applicable: AAR.AdminActionReason[], token: string): ArgChoice[] {
	const choices: ArgChoice[] = []
	for (const keyword of nearest(token, LP.keywordStrings(applicable), MAX_CHOICES * 2)) {
		const reason = LP.findByKeyword(applicable, keyword)
		if (!reason) continue
		const label = LP.describePreset(reason)
		if (choices.some((choice) => choice.label === label)) continue
		choices.push({ tokens: [keyword], label })
		if (choices.length === MAX_CHOICES) break
	}
	return choices
}

// resolves a single reason token against ALL reasons for the action, distinguishing "no such reason" from
// "exists but isn't set up for this action"
export function resolveReasonToken(
	allReasons: AAR.AdminActionReason[],
	action: AAR.AdminActionType,
	token: string,
): { code: 'ok'; reason: AAR.AdminActionReason } | { code: 'err:unknown-preset'; msg: string; choices: ArgChoice[] } {
	const res = AAR.resolveReason(allReasons, action, token)
	if (res.code === 'ok') return { code: 'ok', reason: res.reason }
	const applicable = AAR.reasonsForAction(allReasons, action)
	const choices = reasonChoices(applicable, token)
	const what =
		res.code === 'err:reason-not-applicable'
			? `Reason "${token}" isn't set up for ${AAR.ADMIN_ACTIONS[action].displayName}.`
			: `Unknown reason "${token}".`
	// The choices are the suggestion. Listing every configured reason under them repeats most of the same words in a
	// warn that holds a few lines, so the hint is what stands in for a list nobody can pick from.
	return { code: 'err:unknown-preset', msg: choices.length > 0 ? what : `${what} ${reasonOptionsHint(applicable)}`, choices }
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
): { code: 'ok'; value: ResolvedReasonArg } | { code: 'err:unknown-preset'; msg: string; choices: ArgChoice[] } {
	if (tokens.length === 1) {
		const res = resolveReasonToken(allReasons, action, tokens[0])
		if (res.code !== 'ok') return res
		return { code: 'ok', value: { type: 'preset', reason: res.reason } }
	}
	return { code: 'ok', value: { type: 'custom', text: tokens.join(' ') } }
}

// whether an arg may be left out. `requiredReasonActions` (typically GlobalSettings.requireReasonFor) forces a
// reason/preset-reason arg to count as required even when its declaration marks it optional.
export function argOptional(def: ArgDef, requiredReasonActions: readonly AAR.AdminActionType[] = []): boolean {
	if (def.kind === 'squad') return false
	if ((def.kind === 'reason' || def.kind === 'preset-reason') && requiredReasonActions.includes(def.action)) return false
	return !!def.optional
}

// `reason` accepts free text, so it reads as `name|message`; `preset-reason` is preset-only
function argLabel(def: ArgDef): string {
	return def.kind === 'reason' ? `${def.name}|message` : def.name
}

// renders a single arg's usage token, so signatures reflect the configured reason requirement
export function formatArg(def: ArgDef, requiredReasonActions: readonly AAR.AdminActionType[] = []): string {
	if (def.kind === 'squad') return '[team] <squad>'
	return argOptional(def, requiredReasonActions) ? `[${argLabel(def)}]` : `<${argLabel(def)}>`
}

export function formatArgSignature(args: readonly ArgDef[], requiredReasonActions: readonly AAR.AdminActionType[] = []): string {
	return args
		.map((def) => formatArg(def, requiredReasonActions))
		.join(' ')
		.trim()
}

// the usage line for a command reached through a given trigger; without one it describes the command's primary
// trigger, which is what a caller who typed nothing recognizable should be pointed at
export function formatUsage(
	id: CommandId,
	config: CommandConfig,
	trigger?: CommandTrigger,
	requiredReasonActions: readonly AAR.AdminActionType[] = [],
): string {
	const t = trigger ?? primaryTrigger(config) ?? id
	return `Usage: ${formatTriggerUsage(id, t, requiredReasonActions)}`.trim()
}

// Every trigger string across every command is one namespace, so the first match is the only match (the settings
// schema rejects duplicates). Matching is case-insensitive, as it has always been.
function matchCommandText(configs: CommandConfigs, cmdText: string): { cmdId: CommandId; trigger: CommandTrigger } | null {
	for (const [cmd, config] of Object.entries(configs)) {
		const trigger = config.triggers.find((t) => triggerString(t).toLowerCase() === cmdText.toLowerCase())
		if (trigger !== undefined) return { cmdId: cmd as CommandId, trigger }
	}
	return null
}

// -------- trigger argument templates --------

export type TriggerRef = { name: string; index: number; rest: boolean }

const ARG_REF = /^arg([1-9]\d*)$/
const REST_REF = /^rest([1-9]\d*)?$/

export function parseTriggerRef(name: string): TriggerRef | undefined {
	const arg = ARG_REF.exec(name)
	if (arg) return { name, index: Number(arg[1]), rest: false }
	const rest = REST_REF.exec(name)
	if (rest) return { name, index: rest[1] ? Number(rest[1]) : 1, rest: true }
	return undefined
}

function templateRefs(template: string): TriggerRef[] {
	const refs: TriggerRef[] = []
	for (const { name } of templateVars(template) ?? []) {
		const ref = parseTriggerRef(name)
		if (ref) refs.push(ref)
	}
	return refs
}

// An unsupplied word renders empty, leaving a gap where its token was, so the result is re-split rather than trusted
// as written. That collapse is what makes a trigger parameter optional: the token simply isn't there.
export function expandTriggerArgs(template: string, words: readonly string[]): string[] {
	const vars = Object.fromEntries(
		templateRefs(template).map((r) => [r.name, r.rest ? words.slice(r.index - 1).join(' ') : (words[r.index - 1] ?? '')]),
	)
	return renderTemplate(template, vars)
		.split(/\s+/)
		.filter((w) => w !== '')
}

// which of the command's arguments a placeholder ends up filling. `wholeSlot` is false when the placeholder only
// part-fills one (`args: 'Round ends in {{arg1}} minutes'`), where the argument's own name would misdescribe it.
// `hasDefault` marks a placeholder with an inverted-section fallback (`{{^arg2}}spam{{/arg2}}`), which is what lets a
// caller omit a word that fills a required argument.
export type TriggerParam = { ref: TriggerRef; def: ArgDef; wholeSlot: boolean; hasDefault: boolean }

export type TriggerArgsResolution = { code: 'ok'; params: TriggerParam[] } | { code: 'err:invalid-args'; msg: string }

// a placeholder stands in as one word during analysis, so the real assignment logic decides which argument it fills.
// NUL can't reach here from chat, which keeps the marker distinguishable from anything an admin typed literally.
const sentinel = (name: string) => `\u0000${name}\u0000`

// Static validation of a trigger's args template: everything checkable without the live roster or the configured
// reasons. Checks that the arguments assign (all required ones present) and that literal int and duration tokens
// parse, and reports which argument each placeholder fills. Player/squad/reason tokens can only be checked at
// dispatch, so they're taken on faith.
export function resolveTriggerArgs(cmdId: CommandId, template: string): TriggerArgsResolution {
	const vars = templateVars(template)
	if (vars === undefined) {
		return { code: 'err:invalid-args', msg: 'The arguments are not a valid template. Check for an unclosed {{#section}}.' }
	}
	const refs: (TriggerRef & { hasDefault: boolean })[] = []
	for (const { name, inverted } of vars) {
		const ref = parseTriggerRef(name)
		if (!ref) return { code: 'err:invalid-args', msg: `Unknown placeholder "{{${name}}}". Use ${TRIGGER_ARG_SYNTAX}.` }
		refs.push({ ...ref, hasDefault: inverted })
	}
	// a skipped index would make the caller type a word the trigger throws away, and no honest usage string could be
	// written for it
	const highest = refs.reduce((max, r) => Math.max(max, r.index), 0)
	for (let i = 1; i <= highest; i++) {
		if (!refs.some((r) => r.index === i || (r.rest && r.index <= i))) {
			return { code: 'err:invalid-args', msg: `{{arg${i}}} is skipped. The words typed after a trigger have to be used in order.` }
		}
	}

	// every placeholder supplied, which is the shape that says what the trigger can accept at most
	const expanded = renderTemplate(template, Object.fromEntries(refs.map((r) => [r.name, sentinel(r.name)])))
	const tokens = expanded.split(/\s+/).filter((w) => w !== '')
	const args = COMMAND_DECLARATIONS[cmdId].args as readonly ArgDef[]
	// permissive predicates: a team can be named by the current layer's faction, which isn't knowable here, and
	// treating no token as a configured reason keeps the squad window from being narrowed on a guess
	const assigned = assignArgTokens(args, tokens, { isTeamToken: () => true, isPresetToken: () => false })
	if (assigned.code === 'err:missing-arg') {
		return { code: 'err:invalid-args', msg: `Missing <${assigned.argName}>. The command takes ${formatArgSignature(args)}`.trim() }
	}

	const params: TriggerParam[] = []
	for (const def of args) {
		const window = assigned.windows[def.name]
		if (!window || window.length === 0) continue
		const filling = refs.filter((r) => window.some((t) => t.includes(sentinel(r.name))))
		for (const ref of filling) {
			if (ref.rest && !REST_KINDS.includes(def.kind)) {
				return {
					code: 'err:invalid-args',
					msg: `{{${ref.name}}} can expand to several words, but it fills <${def.name}>, which takes one. Use {{arg${ref.index}}}.`,
				}
			}
			if (params.some((p) => p.ref.name === ref.name)) continue
			params.push({
				ref: { name: ref.name, index: ref.index, rest: ref.rest },
				def,
				wholeSlot: window.length === 1 && window[0] === sentinel(ref.name),
				hasDefault: ref.hasDefault,
			})
		}
		if (filling.length > 0) continue
		if (def.kind === 'int') {
			const res = coerceIntArg(def.name, window[0])
			if (res.code !== 'ok') return { code: 'err:invalid-args', msg: res.msg }
		}
		if (def.kind === 'duration') {
			const res = resolveDurationArg(def.name, window[0])
			if (res.code !== 'ok') return { code: 'err:invalid-args', msg: res.msg }
		}
	}

	const stranded = refs.find((r) => !params.some((p) => p.ref.name === r.name))
	if (stranded) {
		if (!expanded.includes(sentinel(stranded.name))) {
			return {
				code: 'err:invalid-args',
				msg: `{{${stranded.name}}} only decides whether other text appears, so the word it stands for would be thrown away.`,
			}
		}
		const signature = formatArgSignature(args)
		return {
			code: 'err:invalid-args',
			msg: `{{${stranded.name}}} has nowhere to go: the command takes ${signature || 'no arguments'}.`,
		}
	}

	params.sort((a, b) => a.ref.index - b.ref.index || Number(a.ref.rest) - Number(b.ref.rest))
	return { code: 'ok', params }
}

// The placeholder that fills each of a command's arguments, for showing an admin what a template can refer to. Derived
// by resolving a generated full template rather than by walking the arg list, so what's advertised is exactly what
// validation accepts (argTemplateSignature covers every command in the tests).
export function argTemplateSignature(
	cmdId: CommandId,
	requiredReasonActions: readonly AAR.AdminActionType[] = [],
): { ref: string; arg: string }[] {
	const args = COMMAND_DECLARATIONS[cmdId].args as readonly ArgDef[]
	// one placeholder per argument, in order: every kind takes a single word except the rest kinds, which take the
	// remainder, and squad, whose optional leading team is left out
	const template = args.map((def, i) => (REST_KINDS.includes(def.kind) ? `{{rest${i + 1}}}` : `{{arg${i + 1}}}`)).join(' ')
	const res = resolveTriggerArgs(cmdId, template)
	if (res.code !== 'ok') return []
	return res.params.map((p) => ({ ref: `{{${p.ref.name}}}`, arg: formatArg(p.def, requiredReasonActions) }))
}

// What a caller types to run a command through this trigger. A plain trigger takes the command's own signature; one
// with an args template takes only what that template leaves open, and a placeholder with a default reads as optional
// even where the argument it fills is required, since omitting the word still leaves the argument filled.
export function formatTriggerUsage(
	cmdId: CommandId,
	trigger: CommandTrigger,
	requiredReasonActions: readonly AAR.AdminActionType[] = [],
): string {
	const template = triggerArgs(trigger)
	if (template === undefined) {
		return `${triggerString(trigger)} ${formatArgSignature(COMMAND_DECLARATIONS[cmdId].args, requiredReasonActions)}`.trim()
	}
	const res = resolveTriggerArgs(cmdId, template)
	if (res.code !== 'ok') return triggerString(trigger)
	const parts = res.params.map((p) => {
		if (p.wholeSlot && p.def.kind === 'squad') return formatArg(p.def)
		const inner = p.wholeSlot ? argLabel(p.def) : p.ref.name
		return p.hasDefault || argOptional(p.def, requiredReasonActions) ? `[${inner}]` : `<${inner}>`
	})
	return [triggerString(trigger), ...parts].join(' ').trim()
}

// the command text a trigger with pinned arguments stands for, for anywhere that shows what a shortcut expands to
export function describeTriggerExpansion(config: CommandConfig, trigger: CommandTrigger): string {
	const template = triggerArgs(trigger)
	const primary = primaryTrigger(config)
	const head = primary ? triggerString(primary) : ''
	return template === undefined ? head : `${head} ${template}`.trim()
}

export function chatAllowed(allowedChats: ChatGroup[], msgChat: SM.ChatChannelType) {
	for (const group of allowedChats) {
		if (CHAT_GROUP_CHANNELS[group].includes(msgChat)) {
			return true
		}
	}
	return false
}

export function buildCommand(id: CommandId, argObj: Record<string, string>, configs: CommandConfigs, excludeConsoleCommand = false) {
	const declaration = COMMAND_DECLARATIONS[id]
	const config = configs[id]
	let unrealConsoleCommand: string
	if (excludeConsoleCommand) unrealConsoleCommand = ''
	else if (config.allowedChats.includes('admin')) unrealConsoleCommand = 'ChatToAdmin'
	else if (config.allowedChats.includes('public')) unrealConsoleCommand = 'ChatToAll'
	else throw new Error(`Command ${id} allows no chats`)
	const argSubstring = (declaration.args as readonly ArgDef[]).map((arg) => argObj[arg.name] ?? '').join(' ')
	// only plain triggers: one that pins arguments has a signature of its own, and is listed as a shortcut instead
	return config.triggers
		.filter((t) => triggerArgs(t) === undefined)
		.map(triggerString)
		.toSorted((a, b) => b.length - a.length)
		.map((str) => {
			return `${unrealConsoleCommand} ${str} ${argSubstring}`.trim()
		})
}
