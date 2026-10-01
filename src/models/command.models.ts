import * as Obj from '@/lib/object-utils'
import * as Str from '@/lib/string-utils'
import * as Templating from '@/lib/templating'
import { z } from '@/lib/zod'
import * as ZodUtils from '@/lib/zod-utils'
import * as AAR_Msgs from '@/messages/admin-action-reasons.messages'
import * as AAR from '@/models/admin-action-reasons.models'
import * as LP from '@/models/labeled-presets.models'
import { t, type TString } from '@/models/messages.models'
import * as SDoc from '@/models/schema-docs.models'
import type * as SM from '@/models/squad.models.ts'
import * as RBAC from '@/rbac.models'

export const CHAT_GROUPS = z.enum(['admin', 'public'])
export type ChatGroup = z.infer<typeof CHAT_GROUPS>

export const CHAT_GROUP_CHANNELS = {
	[CHAT_GROUPS.enum.admin]: ['ChatAdmin'],
	[CHAT_GROUPS.enum.public]: ['ChatTeam', 'ChatSquad', 'ChatAll'],
}

// A string that runs a command. A bare string passes whatever follows it straight through as the command's arguments
// (`/timeout Alice 2h spam`). An object pins some of them with a template over the words typed after it, which is what
// used to be a separate "command alias": `{ string: '/to2h', args: '{{arg1}} 2h {{rest}}' }`. See docs/command_triggers.md.
export type CommandTrigger = string | { string: string; args: string }

// The indices count the words the CALLER TYPES after the trigger, not the words of the command that ends up running:
// pinned text occupies no index, so `{{arg1}} 2h {{rest}}` takes a player and a reason, never a duration. `{{rest}}`
// is every typed word after the highest `{{argN}}`, joined by spaces. 1-based, matching how they read in chat.
export const TRIGGER_ARG_SYNTAX =
	'{{arg1}} for the first word typed after the trigger, {{arg2}} for the second, {{rest}} for every word after the highest-numbered one'

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

// Core commands plus whatever plugins contribute, keyed by dispatch id. Every trigger string across the two is one
// namespace, so anything that matches or lists commands takes this rather than the core-only record.
export type AnyCommandConfigs = Record<string, CommandConfig>

// -------- sections --------

// The section a command belongs to. Declared per command rather than configured: sections are the axis both the
// commands page's table of contents and `!help <section>` navigate by, so they have to stay exhaustive as commands
// are added, and a section an admin renamed out from under a stored alias would be a needless failure mode.
export const COMMAND_SECTIONS = {
	general: { label: t('General') },
	votes: { label: t('Votes & SLM Updates') },
	layerRequests: { label: t('Layer Requests') },
	teamswaps: { label: t('Teamswaps') },
	switchRequests: { label: t('Switch Requests') },
	flags: { label: t('Player Flags') },
	moderation: { label: t('Moderation') },
	messaging: { label: t('Messaging') },
} as const satisfies Record<string, { label: TString }>

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
	return COMMAND_SECTION_IDS.find((id) => id.toLowerCase() === t || COMMAND_SECTIONS[id].label.original.toLowerCase() === t)
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
type ArgCommon = { name: string; describe?: TString; sample?: string }
export type ArgDef =
	// single token, passed through as-is
	| (ArgCommon & { kind: 'string'; optional?: true })
	// single token, coerced to an integer
	| (ArgCommon & { kind: 'int'; optional?: true })
	// single token, a HumanTime duration like 2h or 30m, resolved to milliseconds
	| (ArgCommon & { kind: 'duration'; optional?: true })
	// single token, resolved to a unique player by id or username substring
	| (ArgCommon & { kind: 'player'; optional?: true })
	// single token, like `player`, but falls back to anyone who has taken part in the current match
	| (ArgCommon & { kind: 'recent-player'; optional?: true })
	// single token naming a team: 1|2|A|B|faction of the current layer
	| (ArgCommon & { kind: 'team'; optional?: true })
	// single token, `[team:]squad`; team = 1|2|A|B|faction, caller's team when omitted
	| (ArgCommon & { kind: 'squad'; optional?: true })
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
	})
}

// What the dispatcher requires before running a command, evaluated against the server it runs on. Required on purpose: a
// new command must state its answer, so one can't be added unguarded. What a command's arguments decide (a timeout's
// duration against the caller's cap, whose request is being removed) is checked by its handler, under `in-handler`.
export type CommandAccess = RBAC.Access<{ serverId: string }>

const { Access } = RBAC

function onServer(type: RBAC.ServerPermissionType): CommandAccess {
	return Access.req((i: { serverId: string }) => RBAC.Req.perm(type, { serverId: i.serverId }))
}

const TIMEOUT_ACCESS = Access.inHandler("the duration is checked against the caller's cap once it is parsed", (i: { serverId: string }) =>
	RBAC.Req.timeout(i.serverId),
)

function declareCommand<Id extends string, const Args extends readonly ArgDef[]>(
	id: Id,
	opts: { label: TString; section: CommandSection; access: CommandAccess; args: Args; defaults: CommandConfig },
) {
	assertValidArgDefs(id, opts.args)
	return {
		[id]: {
			id,
			label: opts.label,
			section: opts.section,
			access: opts.access,
			defaults: opts.defaults,
			args: opts.args,
		},
	} as { [K in Id]: { id: Id; label: TString; section: CommandSection; access: CommandAccess; defaults: CommandConfig; args: Args } }
}

const SWAP_DESTINATION_HELP = t(
	'Where to send them. The other team when omitted. Name it to avoid accidental duplicate swaps: anyone already on that team is left alone.',
)

// `quickReference` seeds the default cheat sheet: the handful of commands an admin reaches for in a normal shift,
// which is what a bare `!help` in the middle of a match should answer with. Admins re-pick it per installation.
export const COMMAND_DECLARATIONS = {
	...declareCommand('help', {
		label: t('Help', undefined, { context: 'command' }),
		section: 'general',
		access: Access.PUBLIC,
		args: [
			{
				kind: 'string',
				name: 'section',
				optional: true,
				sample: 'moderation',
				describe: t('One of {sections}, or "{allToken}" for every command. Lists the quick reference when omitted.', {
					sections: COMMAND_SECTION_IDS.join(', '),
					allToken: ALL_SECTIONS_TOKEN,
				}),
			},
		],
		defaults: {
			allowedChats: ['admin'],
			triggers: ['help', 'h'],
			enabled: true,
			quickReference: true,
		},
	}),
	// Public chat as well as admin: proving you own a steam account is what earns admin here, so requiring admin to
	// do it would leave everyone who has not linked yet unable to.
	...declareCommand('linkSteamAccount', {
		label: t('Link Steam Account', undefined, { context: 'command' }),
		section: 'general',
		access: Access.SELF,
		args: [
			{
				kind: 'string',
				name: 'code',
				sample: 'K7M2QP',
				describe: t('The code shown on the SLM website.'),
			},
		],
		defaults: { allowedChats: ['admin', 'public'], triggers: ['link'], enabled: true, quickReference: false },
	}),
	...declareCommand('requestFeedback', {
		label: t('Request Feedback', undefined, { context: 'command' }),
		section: 'general',
		access: Access.PUBLIC,
		// queue numbers accept dotted forms like "2.1", so this stays a string arg
		args: [
			{
				kind: 'string',
				name: 'number',
				optional: true,
				sample: '2.1',
				describe: t('A queue item number like 2 or 2.1. Defaults to the next item.'),
			},
		],
		defaults: { allowedChats: ['admin'], triggers: ['feedback', 'fb'], enabled: true, quickReference: false },
	}),
	...declareCommand('startVote', {
		label: t('Start Vote', undefined, { context: 'command' }),
		section: 'votes',
		access: onServer('vote:manage'),
		args: [],
		defaults: {
			allowedChats: ['admin'],
			triggers: ['startvote', 'sv'],
			enabled: true,
			quickReference: false,
		},
	}),
	...declareCommand('abortVote', {
		label: t('Abort Vote', undefined, { context: 'command' }),
		section: 'votes',
		access: onServer('vote:manage'),
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['abortvote', 'av'], enabled: true, quickReference: false },
	}),
	...declareCommand('endVoteEarly', {
		label: t('End Vote Early', undefined, { context: 'command' }),
		section: 'votes',
		access: onServer('vote:manage'),
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['endvote', 'ev'], enabled: true, quickReference: false },
	}),
	...declareCommand('showNext', {
		label: t('Show Next', undefined, { context: 'command' }),
		section: 'general',
		access: Access.PUBLIC,
		args: [],
		defaults: { allowedChats: ['admin', 'public'], triggers: ['shownext', 'sn'], enabled: true, quickReference: true },
	}),
	...declareCommand('enableSlmUpdates', {
		label: t('Enable SLM Updates', undefined, { context: 'command' }),
		section: 'votes',
		access: onServer('squad-server:disable-slm-updates'),
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['enableslm'], enabled: true, quickReference: false },
	}),
	...declareCommand('disableSlmUpdates', {
		label: t('Disable SLM Updates', undefined, { context: 'command' }),
		section: 'votes',
		access: onServer('squad-server:disable-slm-updates'),
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['disableslm'], enabled: true, quickReference: false },
	}),
	...declareCommand('getSlmUpdatesEnabled', {
		label: t('Check SLM Updates', undefined, { context: 'command' }),
		section: 'votes',
		access: Access.PUBLIC,
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['slmstatus'], enabled: true, quickReference: false },
	}),
	...declareCommand('requestLayer', {
		label: t('Request Layer', undefined, { context: 'command' }),
		section: 'layerRequests',
		access: Access.inHandler('how many requests a caller may hold is capped per grant, and counted against the queue'),
		args: [
			{
				kind: 'text',
				name: 'request',
				sample: 'goro adf pla',
				describe: t(
					'Any mix of map, gamemode, size, faction, alliance, unit or filter names. Map and filter names match loosely; everything else must match exactly. Two factions (or alliances/units) mean a matchup.',
				),
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
		label: t('List Layer Requests', undefined, { context: 'command' }),
		section: 'layerRequests',
		access: Access.PUBLIC,
		args: [],
		defaults: { allowedChats: ['admin', 'public'], triggers: ['reqs', 'listreqs'], enabled: true, quickReference: false },
	}),
	...declareCommand('removeLayerRequest', {
		label: t('Remove Layer Request', undefined, { context: 'command' }),
		section: 'layerRequests',
		access: Access.inHandler("removing your own request is free, and removing someone else's needs queue:write"),
		args: [
			{
				kind: 'int',
				name: 'number',
				optional: true,
				sample: '2',
				describe: t('The request number from the list. Removes your newest request when omitted.'),
			},
		],
		defaults: { allowedChats: ['admin', 'public'], triggers: ['unreqlayer', 'rmreq'], enabled: true, quickReference: false },
	}),
	...declareCommand('swapNow', {
		label: t('Swap Now', undefined, { context: 'command' }),
		section: 'teamswaps',
		access: onServer('squad-server:manage-players'),
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'team', name: 'toTeam', optional: true, describe: SWAP_DESTINATION_HELP },
		],
		defaults: { allowedChats: ['admin'], triggers: ['swapnow'], enabled: true, quickReference: true },
	}),
	...declareCommand('swapNext', {
		label: t('Swap Next', undefined, { context: 'command' }),
		section: 'teamswaps',
		access: onServer('squad-server:manage-players'),
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'team', name: 'toTeam', optional: true, describe: SWAP_DESTINATION_HELP },
		],
		defaults: { allowedChats: ['admin'], triggers: ['swapnext'], enabled: true, quickReference: true },
	}),
	...declareCommand('swapSquadNow', {
		label: t('Swap Squad Now', undefined, { context: 'command' }),
		section: 'teamswaps',
		access: onServer('squad-server:manage-players'),
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'team', name: 'toTeam', optional: true, describe: SWAP_DESTINATION_HELP },
		],
		defaults: { allowedChats: ['admin'], triggers: ['swapsquadnow'], enabled: true, quickReference: false },
	}),
	...declareCommand('swapSquadNext', {
		label: t('Swap Squad Next', undefined, { context: 'command' }),
		section: 'teamswaps',
		access: onServer('squad-server:manage-players'),
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'team', name: 'toTeam', optional: true, describe: SWAP_DESTINATION_HELP },
		],
		defaults: { allowedChats: ['admin'], triggers: ['swapsquadnext'], enabled: true, quickReference: false },
	}),
	...declareCommand('swaps', {
		label: t('Swaps', undefined, { context: 'command' }),
		section: 'teamswaps',
		access: Access.PUBLIC,
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['swaps'], enabled: true, quickReference: true },
	}),
	...declareCommand('clearSwaps', {
		label: t('Clear Swaps', undefined, { context: 'command' }),
		section: 'teamswaps',
		access: onServer('squad-server:manage-players'),
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['clearswaps'], enabled: true, quickReference: false },
	}),
	...declareCommand('requestSwitch', {
		label: t('Request Switch', undefined, { context: 'command' }),
		section: 'switchRequests',
		access: Access.SELF,
		args: [],
		defaults: { allowedChats: ['admin', 'public'], triggers: ['switch'], enabled: true, quickReference: true },
	}),
	...declareCommand('cancelSwitch', {
		label: t('Cancel Switch', undefined, { context: 'command' }),
		section: 'switchRequests',
		access: Access.SELF,
		args: [],
		defaults: { allowedChats: ['admin', 'public'], triggers: ['cancelswitch'], enabled: true, quickReference: false },
	}),
	...declareCommand('flag', {
		label: t('Flag', undefined, { context: 'command' }),
		section: 'flags',
		access: Access.req(RBAC.Req.perm('battlemetrics:write-flags')),
		args: [
			{ kind: 'recent-player', name: 'player' },
			{ kind: 'string', name: 'flag', sample: 'cheater', describe: t('The name of a BattleMetrics flag in your organization.') },
			{
				kind: 'text',
				name: 'reason',
				optional: true,
				describe: t("Posted as a note on the player's BM profile. Some flags require one."),
			},
		],
		defaults: { allowedChats: ['admin'], triggers: ['flag'], enabled: true, quickReference: true },
	}),
	...declareCommand('removeFlag', {
		label: t('Remove Flag', undefined, { context: 'command' }),
		section: 'flags',
		access: Access.req(RBAC.Req.perm('battlemetrics:write-flags')),
		args: [
			{ kind: 'recent-player', name: 'player' },
			{ kind: 'string', name: 'flag', sample: 'cheater', describe: t('The name of a BattleMetrics flag currently on the player.') },
			{ kind: 'text', name: 'reason', optional: true, describe: t("Posted as a note on the player's BM profile.") },
		],
		defaults: { allowedChats: ['admin'], triggers: ['removeFlag', 'rf'], enabled: true, quickReference: false },
	}),
	...declareCommand('listFlags', {
		label: t('List Flags', undefined, { context: 'command' }),
		section: 'flags',
		access: Access.PUBLIC,
		args: [{ kind: 'recent-player', name: 'player', optional: true, describe: t('Lists every flag in the organization when omitted.') }],
		defaults: { enabled: true, allowedChats: ['admin'], triggers: ['listflags', 'lf'], quickReference: false },
	}),
	...declareCommand('pingAdmins', {
		label: t('Ping Admins', undefined, { context: 'command' }),
		section: 'moderation',
		access: onServer('ping-admins'),
		defaults: { enabled: true, allowedChats: ['public', 'admin'], triggers: ['admin'], quickReference: true },
		args: [{ kind: 'text', name: 'message', describe: t('The message you want to send to the admins.') }],
	}),
	...declareCommand('warn', {
		label: t('Warn', undefined, { context: 'command' }),
		section: 'moderation',
		access: onServer('squad-server:warn-players'),
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'reason', name: 'reason', action: 'warn' },
		],
		defaults: { allowedChats: ['admin'], triggers: ['warn'], enabled: true, quickReference: true },
	}),
	...declareCommand('listWarnReasons', {
		label: t('List Warn Reasons', undefined, { context: 'command' }),
		section: 'moderation',
		access: Access.PUBLIC,
		args: [],
		defaults: { allowedChats: ['admin'], triggers: ['warnreasons', 'warns'], enabled: true, quickReference: false },
	}),
	...declareCommand('warnSquad', {
		label: t('Warn Squad', undefined, { context: 'command' }),
		section: 'moderation',
		access: onServer('squad-server:warn-players'),
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'reason', name: 'reason', action: 'warn' },
		],
		defaults: { allowedChats: ['admin'], triggers: ['warnsquad', 'ws'], enabled: true, quickReference: false },
	}),
	...declareCommand('kill', {
		label: t('Kill', undefined, { context: 'command' }),
		section: 'moderation',
		access: onServer('squad-server:manage-players'),
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'reason', name: 'reason', action: 'kill', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['kill'], enabled: true, quickReference: false },
	}),
	...declareCommand('killSquad', {
		label: t('Kill Squad', undefined, { context: 'command' }),
		section: 'moderation',
		access: onServer('squad-server:manage-players'),
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'reason', name: 'reason', action: 'kill', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['killsquad'], enabled: true, quickReference: false },
	}),
	...declareCommand('removeFromSquad', {
		label: t('Remove from Squad', undefined, { context: 'command' }),
		section: 'moderation',
		access: onServer('squad-server:manage-players'),
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'reason', name: 'reason', action: 'remove-from-squad', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['rfs', 'removefromsquad'], enabled: true, quickReference: false },
	}),
	...declareCommand('disbandSquad', {
		label: t('Disband Squad', undefined, { context: 'command' }),
		section: 'moderation',
		access: onServer('squad-server:manage-players'),
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'reason', name: 'reason', action: 'disband-squad', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['disband'], enabled: true, quickReference: false },
	}),
	...declareCommand('demoteCommander', {
		label: t('Demote Commander', undefined, { context: 'command' }),
		section: 'moderation',
		access: onServer('squad-server:manage-players'),
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'reason', name: 'reason', action: 'demote-commander', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['demote'], enabled: true, quickReference: false },
	}),
	...declareCommand('broadcast', {
		label: t('Broadcast', undefined, { context: 'command' }),
		section: 'messaging',
		access: onServer('squad-server:broadcast'),
		args: [{ kind: 'reason', name: 'reason', action: 'broadcast' }],
		defaults: { allowedChats: ['admin'], triggers: ['broadcast', 'b'], enabled: true, quickReference: true },
	}),
	...declareCommand('kick', {
		label: t('Kick', undefined, { context: 'command' }),
		section: 'moderation',
		access: onServer('squad-server:kick-players'),
		args: [
			{ kind: 'player', name: 'player' },
			{ kind: 'reason', name: 'reason', action: 'kick', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['kick'], enabled: true, quickReference: true },
	}),
	...declareCommand('kickSquad', {
		label: t('Kick Squad', undefined, { context: 'command' }),
		section: 'moderation',
		access: onServer('squad-server:kick-players'),
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'reason', name: 'reason', action: 'kick', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['kicksquad'], enabled: true, quickReference: false },
	}),
	...declareCommand('timeout', {
		label: t('Timeout', undefined, { context: 'command' }),
		section: 'moderation',
		access: TIMEOUT_ACCESS,
		args: [
			{ kind: 'recent-player', name: 'player' },
			{ kind: 'duration', name: 'duration' },
			{ kind: 'reason', name: 'reason', action: 'timeout', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['timeout', 'to'], enabled: true, quickReference: true },
	}),
	...declareCommand('timeoutSquad', {
		label: t('Timeout Squad', undefined, { context: 'command' }),
		section: 'moderation',
		access: TIMEOUT_ACCESS,
		args: [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'duration', name: 'duration' },
			{ kind: 'reason', name: 'reason', action: 'timeout', optional: true },
		],
		defaults: { allowedChats: ['admin'], triggers: ['timeoutsquad', 'tos'], enabled: true, quickReference: false },
	}),
	// the target may be offline, so the arg is a plain token resolved against players with active timeouts
	...declareCommand('clearTimeout', {
		label: t('Clear Timeout', undefined, { context: 'command' }),
		section: 'moderation',
		access: Access.inHandler('needs the timeout row to know which server issued it'),
		args: [
			{
				kind: 'string',
				name: 'player',
				sample: 'Alice',
				describe: t('A player id, or a username substring matched against players with an active timeout.'),
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

export const PrefixConfigSchema = z.object({
	prefix: PrefixSchema.meta(SDoc.of({ label: t('Prefix') })),
	replyToUnknown: z
		.boolean()
		.prefault(true)
		.meta(
			SDoc.of({
				label: t('Reply To Unknown'),
				description: t(
					"Tell an admin who types an unrecognised command with this prefix that it is unrecognised. Turn it off for a prefix another bot also answers on: there an unrecognised command is usually that bot's, not a typo of one of ours.",
				),
			}),
		),
})
export type PrefixConfig = z.infer<typeof PrefixConfigSchema>

// which allowed prefix a command string uses: the longest one it starts with, so "!!" wins over "!"
export function prefixUsedBy<T extends { prefix: string }>(prefixes: readonly T[], str: string): T | undefined {
	let best: T | undefined
	for (const p of prefixes) {
		if (p.prefix && str.startsWith(p.prefix) && (best === undefined || p.prefix.length > best.prefix.length)) best = p
	}
	return best
}

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
		string: ZodUtils.BasicStrNoWhitespace.meta(SDoc.of({ label: t('Trigger') })),
		args: z
			.string()
			.min(1)
			.meta(
				SDoc.of({
					label: t('Arguments'),
					description: t(
						"The arguments this trigger runs the command with. A template over the words typed after it: '{{arg1}}' for the first word typed after the trigger, '{{arg2}}' for the second, '{{rest}}' for every word after the highest-numbered one",
					),
				}),
			),
	}),
])

function CommandConfigSchema(commandId: CommandId) {
	const declared = COMMAND_DECLARATIONS[commandId].defaults
	return z
		.object({
			triggers: z.array(CommandTriggerSchema).meta(
				SDoc.of({
					label: t('Triggers'),
					description: t(
						'Strings that run this command, each starting with one of the allowed prefixes. A plain string takes the command\'s arguments as typed; give one an "args" template instead to pin some of them (what used to be a command alias)',
					),
				}),
			),
			allowedChats: z
				.array(CHAT_GROUPS)
				.prefault(declared.allowedChats)
				.meta(SDoc.of({ label: t('Allowed Chats'), description: t('Which in-game chats accept this command') })),
			enabled: z
				.boolean()
				.prefault(declared.enabled)
				.meta(SDoc.of({ label: t('Enabled') })),
			quickReference: z
				.boolean()
				.prefault(declared.quickReference)
				.meta(
					SDoc.of({
						label: t('Quick Reference'),
						description: t(
							'Show this command on the quick reference: the top section of the commands page, and the only commands a bare help command lists',
						),
					}),
				),
		})
		.meta(SDoc.of({ label: COMMAND_DECLARATIONS[commandId].label }))
}

// no prefault on the object or on `triggers`: a command's default triggers depend on `defaultPrefix`, so they're
// seeded by seedCommandConfigs before parsing rather than baked into the schema
export const AllCommandConfigSchema = z.object(
	Object.fromEntries(Object.keys(COMMAND_DECLARATIONS).map((id) => [id, CommandConfigSchema(id as CommandId)])) as Record<
		CommandId,
		ReturnType<typeof CommandConfigSchema>
	>,
)

// -------- plugin commands --------

// A command a plugin contributes. Declared at activation rather than in COMMAND_DECLARATIONS, whose ids are a
// compile-time union: the typed argument machinery (windows, prompts, near misses) needs a declaration the host can
// see, so a plugin command instead takes the words after its trigger exactly as they were typed.
export type PluginCommandDeclaration = {
	// unique within the plugin. The dispatch id is pluginCommandId(pluginId, name)
	name: string
	// one line, for the commands page and the in-game help listing
	description: string
	// unprefixed here (`rolltoseed`); defaultPrefix is attached unless an admin has configured the command
	triggers: string[]
	allowedChats: ChatGroup[]
	// what follows the trigger, for the usage line, e.g. '<duration>'. Omit for a command taking nothing
	usage?: string
	quickReference?: boolean
	// what the caller needs, checked by the host before the handler runs
	access: CommandAccess
}

// The declaration as it reaches the browser, for the commands page. A PluginCommandDeclaration is assignable to
// this, which is where the shapes are checked against each other (see plugins.server listRuntimeInfo).
export const PluginCommandInfoSchema = z.object({
	name: z.string(),
	description: z.string(),
	triggers: z.array(z.string()),
	allowedChats: z.array(CHAT_GROUPS),
	usage: z.string().optional(),
	quickReference: z.boolean().optional(),
})
export type PluginCommandInfo = z.infer<typeof PluginCommandInfoSchema>

const PLUGIN_COMMAND_PREFIX = 'plugin:'

/** The dispatch id of a plugin's command. Carries a colon, which no core command id can. */
export function pluginCommandId(pluginId: string, name: string): string {
	return `${PLUGIN_COMMAND_PREFIX}${pluginId}:${name}`
}

export function isPluginCommandId(id: string): boolean {
	return id.startsWith(PLUGIN_COMMAND_PREFIX)
}

// plugin ids cannot contain a colon, so the first one after the prefix ends it
export function pluginIdOfCommand(id: string): string {
	const rest = id.slice(PLUGIN_COMMAND_PREFIX.length)
	return rest.slice(0, rest.indexOf(':'))
}

export const PluginCommandConfigSchema = z.object({
	triggers: z
		.array(ZodUtils.BasicStrNoWhitespace)
		.min(1)
		.meta(
			SDoc.of({ label: t('Triggers'), description: t('Strings that run this command, each starting with one of the allowed prefixes') }),
		),
	allowedChats: z
		.array(CHAT_GROUPS)
		.min(1)
		.meta(SDoc.of({ label: t('Allowed Chats'), description: t('Which in-game chats accept this command') })),
	enabled: z.boolean().meta(SDoc.of({ label: t('Enabled') })),
	quickReference: z
		.boolean()
		.meta(
			SDoc.of({ label: t('Quick Reference'), description: t('Show this command on the quick reference, and in a bare help command') }),
		),
})
export type PluginCommandConfig = z.infer<typeof PluginCommandConfigSchema>

// One plugin's overrides, keyed by command name. A name with no entry runs under what the plugin declares.
export const PluginCommandConfigsSchema = z.record(z.string(), PluginCommandConfigSchema)
export type PluginCommandConfigs = z.infer<typeof PluginCommandConfigsSchema>

export type PluginCommandConfigIssue = { name: string; index: number; message: string }

/**
 * What refuses a save of one plugin's overrides: a trigger without an allowed prefix, or one that core, another
 * configured plugin command, or this plugin's own configs already hold. `others` are the other plugins' overrides,
 * keyed by dispatch id. Declared defaults are not checked: resolvePluginCommandTriggers ranks them below these.
 */
export function pluginCommandConfigIssues(
	pluginId: string,
	configs: PluginCommandConfigs,
	ctx: { core: AnyCommandConfigs; allowedPrefixes: readonly PrefixConfig[]; others: Record<string, PluginCommandConfig> },
): PluginCommandConfigIssue[] {
	const prefixList = ctx.allowedPrefixes.map((p) => p.prefix).join(', ')
	const owner = new Map<string, string>()
	for (const [id, config] of Object.entries(ctx.core)) {
		for (const trigger of config.triggers) owner.set(triggerString(trigger).toLowerCase(), id)
	}
	for (const [id, config] of Object.entries(ctx.others)) {
		for (const trigger of config.triggers) {
			const key = trigger.toLowerCase()
			if (!owner.has(key)) owner.set(key, id)
		}
	}
	const issues: PluginCommandConfigIssue[] = []
	for (const [name, config] of Object.entries(configs)) {
		const id = pluginCommandId(pluginId, name)
		config.triggers.forEach((string, index) => {
			if (!ctx.allowedPrefixes.some((p) => string.startsWith(p.prefix))) {
				issues.push({ name, index, message: `Trigger "${string}" must start with one of the allowed prefixes (${prefixList})` })
			}
			const key = string.toLowerCase()
			const existing = owner.get(key)
			if (existing !== undefined) {
				issues.push({
					name,
					index,
					message:
						existing === id
							? `Duplicate trigger "${string}"`
							: `Trigger "${string}" is already used by the "${existing}" command. Pick a different string.`,
				})
				return
			}
			owner.set(key, id)
		})
	}
	return issues
}

/**
 * What a plugin command actually runs under: the admin's stored config, or the plugin's declared defaults with
 * `defaultPrefix` attached. Read through rather than seeded, since a plugin is not active when settings load.
 */
export function pluginCommandConfig(
	decl: PluginCommandInfo,
	stored: PluginCommandConfig | undefined,
	defaultPrefix: string,
): CommandConfig {
	if (stored) return stored
	return {
		triggers: decl.triggers.map((t) => defaultPrefix + t),
		allowedChats: decl.allowedChats,
		enabled: true,
		quickReference: decl.quickReference ?? false,
	}
}

// A plugin command's trigger that something else already owns, so it never dispatches. `ownedBy` is the command
// id holding it: a core command id, or another plugin's.
export type CommandConflict = { commandId: string; trigger: string; ownedBy: string }

/**
 * Settles the one trigger namespace across core and the plugins, dropping every plugin trigger something else
 * already owns. Without this the loser is silently unreachable: dispatch takes the first match, so a plugin
 * declaring a trigger a core command (or an alphabetically earlier plugin) already uses would look installed and
 * do nothing.
 *
 * Precedence is core, then plugin commands an admin has configured, then declared defaults. Configuring a trigger
 * is an explicit decision, so it outranks whatever another plugin happens to declare -- which is also what makes
 * configuring a plugin's commands a real fix rather than a race against load order.
 */
export function resolvePluginCommandTriggers<T extends { id: string; config: CommandConfig; configured: boolean }>(
	core: AnyCommandConfigs,
	listings: readonly T[],
): { kept: T[]; conflicts: CommandConflict[] } {
	const owner = new Map<string, string>()
	for (const [id, config] of Object.entries(core)) {
		for (const trigger of config.triggers) owner.set(triggerString(trigger).toLowerCase(), id)
	}
	const rank = new Map(listings.map((l, i) => [l.id, i]))
	const kept: T[] = []
	const conflicts: CommandConflict[] = []
	for (const listing of [...listings.filter((l) => l.configured), ...listings.filter((l) => !l.configured)]) {
		const triggers: CommandTrigger[] = []
		for (const trigger of listing.config.triggers) {
			const string = triggerString(trigger)
			const existing = owner.get(string.toLowerCase())
			if (existing !== undefined) {
				conflicts.push({ commandId: listing.id, trigger: string, ownedBy: existing })
				continue
			}
			owner.set(string.toLowerCase(), listing.id)
			triggers.push(trigger)
		}
		// nothing left to type means the command cannot be reached at all, so it is not a command any more
		if (triggers.length > 0) kept.push({ ...listing, config: { ...listing.config, triggers } })
	}
	// precedence decided the survivors; the caller's order is what anything listing them should show
	kept.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
	return { kept, conflicts }
}

/** `/rolltoseed <duration>`: the line the commands page and the help listing show. */
export function pluginCommandUsage(decl: PluginCommandInfo, config: CommandConfig): string {
	const primary = primaryTrigger(config)
	const trigger = primary ? triggerString(primary) : decl.triggers[0]
	return decl.usage ? `${trigger} ${decl.usage}` : trigger
}

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
				: D extends { kind: 'recent-player' }
					? SM.RecentPlayer
					: D extends { kind: 'team' }
						? SM.TeamId
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
export function parseCommand(msg: SM.RconEvents.ChatMessage, configs: AnyCommandConfigs, prefixes: readonly PrefixConfig[]) {
	const words = msg.message
		.trim()
		.split(/\s+/)
		.filter((w) => w !== '')
	const match = matchCommandText(configs, words[0] ?? '')
	if (!match) {
		// a prefix shared with another bot has nothing to say about a word we don't recognise: it is far more likely
		// to be that bot's command than a typo of ours
		if (prefixUsedBy(prefixes, words[0] ?? '')?.replyToUnknown === false) {
			return { code: 'err:unknown-command' as const, msg: undefined }
		}
		const allTriggerStrings = Obj.objValues(configs)
			.filter((c) => chatAllowed(c.allowedChats, msg.channelType))
			.flatMap((c) => c.triggers.map(triggerString))
		// the one place a "did you mean" is still written into the message: an unknown command has nothing to offer
		// back, since a prompt can only replace an argument the command it belongs to has already been chosen for
		const [matched] = Str.nearest(words[0] ?? '', allTriggerStrings, 1)
		return {
			code: 'err:unknown-command' as const,
			msg: matched ? `Unknown command "${words[0]}". Did you mean ${matched}?` : `Unknown command "${words[0] ?? ''}"`,
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

export type ArgTokenWindows = Record<string, string[] | undefined>

// where an argument's window sits in the token list, so a picked choice can be spliced back over exactly the
// words that failed to resolve (see spliceArgTokens)
export type ArgTokenRange = { start: number; len: number }
export type ArgTokenRanges = Record<string, ArgTokenRange | undefined>

// splits the raw arg tokens into per-arg windows, enforcing required args. Every kind but the rest kinds takes exactly
// one token, so the split never depends on what the tokens say.
export function assignArgTokens(
	args: readonly ArgDef[],
	tokens: string[],
): { code: 'ok'; windows: ArgTokenWindows; ranges: ArgTokenRanges } | { code: 'err:missing-arg'; argName: string } {
	const windows: ArgTokenWindows = {}
	const ranges: ArgTokenRanges = {}
	let i = 0
	for (const def of args) {
		const rem = tokens.slice(i)
		switch (def.kind) {
			case 'string':
			case 'int':
			case 'duration':
			case 'player':
			case 'recent-player':
			case 'team':
			case 'squad':
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
			default:
				def satisfies never
		}
	}
	return { code: 'ok', windows, ranges }
}

// -------- near misses --------

// A replacement offered when a typed token doesn't resolve. `tokens` are spliced back over the argument's window
// and resolved again, so they have to name the choice unambiguously: a steam id rather than a username, "1:3"
// rather than a squad name.
export type ArgChoice = { tokens: string[]; label: string }

// A failure the caller can fix by picking rather than by retyping. `msg` is the resolver's own account of what went
// wrong, which heads the prompt: only the resolver knows whether "1" failed as a team or as a squad.
export type NearMiss = { argName: string; typed: string; cause: 'no-match' | 'ambiguous'; msg: string; choices: ArgChoice[] }

// A Squad warn holds only a few lines, and a caller who has to read past three options is better served by the
// usage line.
export const MAX_CHOICES = 3

// Applies picked choices back over the tokens the caller typed. Right to left, since a choice's token count need
// not match the window it replaces: a corrected layer request comes back whole.
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
	for (const keyword of Str.nearest(token, LP.keywordStrings(applicable), MAX_CHOICES * 2)) {
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
			? `Reason "${token}" isn't set up for ${AAR_Msgs.actionNames[action].original}.`
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
	if ((def.kind === 'reason' || def.kind === 'preset-reason') && requiredReasonActions.includes(def.action)) return false
	return !!def.optional
}

// `reason` accepts free text, so it reads as `name|message`; `preset-reason` is preset-only
function argLabel(def: ArgDef): string {
	return def.kind === 'reason' ? `${def.name}|message` : def.name
}

// renders a single arg's usage token, so signatures reflect the configured reason requirement
export function formatArg(def: ArgDef, requiredReasonActions: readonly AAR.AdminActionType[] = []): string {
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
function matchCommandText(configs: AnyCommandConfigs, cmdText: string): { cmdId: string; trigger: CommandTrigger } | null {
	for (const [cmd, config] of Object.entries(configs)) {
		const trigger = config.triggers.find((t) => triggerString(t).toLowerCase() === cmdText.toLowerCase())
		if (trigger !== undefined) return { cmdId: cmd, trigger }
	}
	return null
}

// -------- trigger argument templates --------

export type TriggerRef = { name: string; index: number; rest: boolean }
type TemplateRef = TriggerRef & { hasDefault: boolean }

const ARG_REF = /^arg([1-9]\d*)$/

// `{{rest}}` starts after the highest `{{argN}}`, so it never takes a word an `{{argN}}` already took
function triggerRefs(vars: readonly Templating.TemplateVar[]): { code: 'ok'; refs: TemplateRef[] } | { code: 'err:unknown'; name: string } {
	const refs: TemplateRef[] = []
	let highest = 0
	for (const { name, inverted } of vars) {
		const arg = ARG_REF.exec(name)
		if (arg) {
			const index = Number(arg[1])
			highest = Math.max(highest, index)
			refs.push({ name, index, rest: false, hasDefault: inverted })
		} else if (name === 'rest') {
			refs.push({ name, index: 0, rest: true, hasDefault: inverted })
		} else {
			return { code: 'err:unknown', name }
		}
	}
	for (const ref of refs) if (ref.rest) ref.index = highest + 1
	return { code: 'ok', refs }
}

// An unsupplied word renders empty, leaving a gap where its token was, so the result is re-split rather than trusted
// as written. That collapse is what makes a trigger parameter optional: the token simply isn't there.
export function expandTriggerArgs(template: string, words: readonly string[]): string[] {
	const res = triggerRefs(Templating.templateVars(template) ?? [])
	const refs = res.code === 'ok' ? res.refs : []
	const vars = Object.fromEntries(refs.map((r) => [r.name, r.rest ? words.slice(r.index - 1).join(' ') : (words[r.index - 1] ?? '')]))
	return Templating.renderTemplate(template, vars)
		.split(/\s+/)
		.filter((w) => w !== '')
}

// which of the command's arguments a placeholder ends up filling. `wholeSlot` is false when the placeholder only
// part-fills one (`args: 'Round ends in {{arg1}} minutes'`), where the argument's own name would misdescribe it.
// `hasDefault` marks a placeholder with an inverted-section fallback (`{{^arg2}}spam{{/arg2}}`), which is what lets a
// caller omit a word that fills a required argument.
export type TriggerParam = { ref: TriggerRef; def: ArgDef; wholeSlot: boolean; hasDefault: boolean }

// `pinned` holds the arguments the template fills entirely from its own text, keyed by argument name: a caller
// running the command through this trigger never types them, so they are the same every time. An argument in
// neither `params` nor `pinned` cannot be supplied through this trigger at all.
export type TriggerArgsResolution =
	| { code: 'ok'; params: TriggerParam[]; pinned: Record<string, string> }
	| { code: 'err:invalid-args'; msg: string }

// a placeholder stands in as one word during analysis, so the real assignment logic decides which argument it fills.
// NUL can't reach here from chat, which keeps the marker distinguishable from anything an admin typed literally.
const sentinel = (name: string) => `\u0000${name}\u0000`

// Static validation of a trigger's args template: everything checkable without the live roster or the configured
// reasons. Checks that the arguments assign (all required ones present) and that literal int and duration tokens
// parse, and reports which argument each placeholder fills. Player/squad/reason tokens can only be checked at
// dispatch, so they're taken on faith.
export function resolveTriggerArgs(cmdId: CommandId, template: string): TriggerArgsResolution {
	const vars = Templating.templateVars(template)
	if (vars === undefined) {
		return { code: 'err:invalid-args', msg: 'The arguments are not a valid template. Check for an unclosed {{#section}}.' }
	}
	const parsed = triggerRefs(vars)
	if (parsed.code === 'err:unknown') {
		return { code: 'err:invalid-args', msg: `Unknown placeholder "{{${parsed.name}}}". Use ${TRIGGER_ARG_SYNTAX}.` }
	}
	const refs = parsed.refs
	// a skipped index would make the caller type a word the trigger throws away, and no honest usage string could be
	// written for it
	const highest = refs.reduce((max, r) => (r.rest ? max : Math.max(max, r.index)), 0)
	for (let i = 1; i <= highest; i++) {
		if (!refs.some((r) => r.index === i)) {
			return { code: 'err:invalid-args', msg: `{{arg${i}}} is skipped. The words typed after a trigger have to be used in order.` }
		}
	}

	// every placeholder supplied, which is the shape that says what the trigger can accept at most
	const expanded = Templating.renderTemplate(template, Object.fromEntries(refs.map((r) => [r.name, sentinel(r.name)])))
	const tokens = expanded.split(/\s+/).filter((w) => w !== '')
	const args = COMMAND_DECLARATIONS[cmdId].args as readonly ArgDef[]
	const assigned = assignArgTokens(args, tokens)
	if (assigned.code === 'err:missing-arg') {
		return { code: 'err:invalid-args', msg: `Missing <${assigned.argName}>. The command takes ${formatArgSignature(args)}`.trim() }
	}

	const params: TriggerParam[] = []
	const pinned: Record<string, string> = {}
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
		pinned[def.name] = window.join(' ')
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
	return { code: 'ok', params, pinned }
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
	// remainder
	const template = args.map((def, i) => (REST_KINDS.includes(def.kind) ? '{{rest}}' : `{{arg${i + 1}}}`)).join(' ')
	const res = resolveTriggerArgs(cmdId, template)
	if (res.code !== 'ok') return []
	return res.params.map((p) => ({ ref: `{{${p.ref.name}}}`, arg: formatArg(p.def, requiredReasonActions) }))
}

// What a caller types after this trigger. A plain trigger takes the command's own signature; one with an args template
// takes only what that template leaves open, and a placeholder with a default reads as optional even where the
// argument it fills is required, since omitting the word still leaves the argument filled.
export function formatTriggerSignature(
	cmdId: CommandId,
	trigger: CommandTrigger,
	requiredReasonActions: readonly AAR.AdminActionType[] = [],
): string {
	const template = triggerArgs(trigger)
	if (template === undefined) return formatArgSignature(COMMAND_DECLARATIONS[cmdId].args, requiredReasonActions)
	const res = resolveTriggerArgs(cmdId, template)
	if (res.code !== 'ok') return ''
	return res.params
		.map((p) => {
			const inner = p.wholeSlot ? argLabel(p.def) : p.ref.name
			return p.hasDefault || argOptional(p.def, requiredReasonActions) ? `[${inner}]` : `<${inner}>`
		})
		.join(' ')
}

// the whole line a caller types to run a command through this trigger
export function formatTriggerUsage(
	cmdId: CommandId,
	trigger: CommandTrigger,
	requiredReasonActions: readonly AAR.AdminActionType[] = [],
): string {
	return `${triggerString(trigger)} ${formatTriggerSignature(cmdId, trigger, requiredReasonActions)}`.trim()
}

// The arguments a trigger fills from its own text, in declaration order: what running the command through it always
// does, whoever runs it. An argument the template leaves out entirely is in neither this nor the trigger's signature,
// since nothing can supply it.
export function triggerPins(cmdId: CommandId, trigger: CommandTrigger): { name: string; value: string }[] {
	const template = triggerArgs(trigger)
	if (template === undefined) return []
	const res = resolveTriggerArgs(cmdId, template)
	if (res.code !== 'ok') return []
	const args = COMMAND_DECLARATIONS[cmdId].args as readonly ArgDef[]
	return args.filter((def) => def.name in res.pinned).map((def) => ({ name: def.name, value: res.pinned[def.name] }))
}

// The command text a trigger with pinned arguments stands for, for anywhere that shows what a shortcut expands to.
// Undefined when the command has no plain trigger: there is then no fuller way to type it for the shortcut to stand
// for, and naming the shortcut's own string as what it expands to would be circular.
export function describeTriggerExpansion(config: CommandConfig, trigger: CommandTrigger): string | undefined {
	const template = triggerArgs(trigger)
	if (template === undefined) return undefined
	const plain = config.triggers.find((t) => triggerArgs(t) === undefined)
	if (plain === undefined) return undefined
	return `${triggerString(plain)} ${template}`.trim()
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
	const plain = config.triggers.filter((t) => triggerArgs(t) === undefined)
	// unless every trigger pins arguments, where they are the only way in and the caller has to be told one of them.
	// The arguments given are dropped: a trigger that pins them takes something else, so writing them out would be a
	// command that does not run.
	if (plain.length === 0) return config.triggers.map((t) => `${unrealConsoleCommand} ${formatTriggerUsage(id, t)}`.trim())
	return plain
		.map(triggerString)
		.toSorted((a, b) => b.length - a.length)
		.map((str) => {
			return `${unrealConsoleCommand} ${str} ${argSubstring}`.trim()
		})
}
