import * as Obj from '@/lib/object'
import { BasicStrNoWhitespace } from '@/lib/zod'
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
export type ArgDefinition<Name extends string = string> = {
	name: Name
	// default false
	optional?: boolean
} | Name

function declareCommand<Id extends string, Args extends ArgDefinition[]>(
	id: Id,
	opts: { args: Args; defaults: CommandConfig },
) {
	return {
		[id]: {
			id,
			defaults: opts.defaults,
			args: opts.args,
		},
	} as const
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
		args: [{ name: 'number', optional: true }],
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
	...declareCommand('showNext', { args: [], defaults: { scopes: ['admin'], strings: ['shownext', 'sn'], enabled: true } }),
	...declareCommand('enableSlmUpdates', { args: [], defaults: { scopes: ['admin'], strings: ['enable-slm'], enabled: true } }),
	...declareCommand('disableSlmUpdates', { args: [], defaults: { scopes: ['admin'], strings: ['disable-slm'], enabled: true } }),
	...declareCommand('getSlmUpdatesEnabled', { args: [], defaults: { scopes: ['admin'], strings: ['get-slm-status'], enabled: true } }),
	...declareCommand('linkSteamAccount', {
		args: ['code'],
		defaults: { scopes: ['admin'], strings: ['link-steam-account'], enabled: true },
	}),
	...declareCommand('flag', { args: ['player', 'flag'], defaults: { scopes: ['admin'], strings: ['flag'], enabled: true } }),
	...declareCommand('removeFlag', { args: ['player', 'flag'], defaults: { scopes: ['admin'], strings: ['removeFlag', 'rf'], enabled: true } }),
	...declareCommand('listFlags', { args: [{ name: 'player', optional: true }], defaults: { enabled: true, scopes: ['admin'], strings: ['listFlags', 'lf'] } }),
}

export type CommandId = (typeof COMMAND_DECLARATIONS)[number]['id']
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

// ------- Helpers --------
//

export function parseCommand(msg: SM.RconEvents.ChatMessage, configs: CommandConfigs, commandPrefix: string) {
	const words = msg.message.split(/\s+/)
	const cmdText = words[0].slice(1)
	// const args = words.slice(1)
	const cmd = matchCommandText(configs, cmdText)
	if (!cmd) {
		const allCommandStrings = Obj.objValues(configs)
			.filter((c) => chatInScope(c.scopes, msg.channelType))
			.flatMap((c) => c.strings)
			.map((s) => commandPrefix + s)
		const sortedMatches = StringComparison.diceCoefficient.sortMatch(words[0], allCommandStrings)
		if (sortedMatches.length === 0) {
			return { code: 'err:unknown-command' as const, msg: `Unknown command "${words[0]}"` }
		}
		const matched = sortedMatches[sortedMatches.length - 1].member
		return {
			code: 'err:unknown-command' as const,
			msg: `Unknown command "${words[0]}". Did you mean ${matched}?`,
		}
	}
	const args = extractArgs(cmd, words)
	return { code: 'ok' as const, cmd, args }
}

function extractArgs(id: CommandId, words: string[]) {
	const config = COMMAND_DECLARATIONS[id]
	if (!config?.args) {
		return {}
	}
	const result: Record<string, string> = {}
	words.slice(1).forEach((word, index) => {
		if (config.args && config.args[index]) {
			const name = typeof config.args[index] === 'string' ? config.args[index] : config.args[index].name
			result[name] = word
		}
	})
	return result
}

function matchCommandText(configs: CommandConfigs, cmdText: string) {
	for (const [cmd, config] of Object.entries(configs)) {
		if (config.strings.includes(cmdText)) {
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
	const argSubstring = declaration.args?.map((arg) => {
		if (typeof arg === 'string') return arg
		return argObj[arg.name]
	}).join(' ')
	return config.strings
		.sort((a, b) => b.length - a.length)
		.map(str => {
			return `${unrealConsoleCommand} ${prefix}${str} ${argSubstring}`.trim()
		})
}
