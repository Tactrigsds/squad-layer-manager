import { z } from '@/lib/zod'
import type * as SM from '@/models/squad.models'

// The scenario verbs a sandbox server understands, defined once for all three front ends: the repl inside
// `pnpm dev:emu`, the one-shot `pnpm emuctl`, and the sandbox window's oRPC router. A verb added here reaches
// all of them, and none of them can grow one the others lack.
//
// Schemas only, so this stays importable from the client. The executor is src/emulator/verbs.ts.

export const PlayerNameSchema = z
	.string()
	.min(1)
	.max(32)
	.regex(/^[^\s]+$/, 'A player name cannot contain spaces: the command line addresses players by a single token.')

// Squad's Admins.cfg is colon- and comma-delimited, so a group name holding either would render a file that parses
// back as something else
export const GroupNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[^:,\s]+$/, {
		error: 'A group name cannot contain spaces, colons or commas',
	})

// A real squad server holds 100, and the app's own player-count handling is written against that. Fabricating a
// 101st player would be testing against a world that cannot exist.
export const MAX_PLAYERS = 100

// The channels a player can actually speak in. Broadcast is deliberately absent: on a real server it is an RCON
// command, not something a player can do, and the emulator matches that.
export const PLAYER_CHAT_CHANNEL = z.enum(['ChatAll', 'ChatTeam', 'ChatSquad', 'ChatAdmin'])
export type PlayerChatChannel = z.infer<typeof PLAYER_CHAT_CHANNEL>

const NoArgs = z.object({})

// `tokens` maps the positional command-line form onto the same input the router takes, so the two front ends
// cannot drift in what they accept. It throws with the usage line when the tokens do not fit.
type VerbDef<T extends z.ZodType> = {
	usage: string
	summary: string
	input: T
	tokens: (tokens: string[]) => z.input<T>
	// verbs that change who exists or what is playing, as opposed to reads and fault injection
	mutatesWorld?: boolean
}

function def<T extends z.ZodType>(d: VerbDef<T>): VerbDef<T> {
	return d
}

function requireTokens(tokens: string[], count: number, usage: string): void {
	if (tokens.length < count || tokens.some((t) => !t)) throw new Error(`usage: ${usage}`)
}

export const SANDBOX_VERBS = {
	join: def({
		usage: 'join <name>',
		summary: 'a player connects',
		input: z.object({ name: PlayerNameSchema }),
		tokens: ([name]) => {
			requireTokens([name], 1, 'join <name>')
			return { name }
		},
		mutatesWorld: true,
	}),
	leave: def({
		usage: 'leave <name>',
		summary: 'a player disconnects',
		input: z.object({ name: PlayerNameSchema }),
		tokens: ([name]) => {
			requireTokens([name], 1, 'leave <name>')
			return { name }
		},
		mutatesWorld: true,
	}),
	chat: def({
		usage: 'chat <name> <message>',
		summary: 'say something in all-chat (this is how you drive !commands)',
		input: z.object({
			name: PlayerNameSchema,
			message: z.string().min(1),
			channel: PLAYER_CHAT_CHANNEL.prefault('ChatAll'),
		}),
		tokens: ([name, ...rest]) => {
			requireTokens([name, rest.join(' ')], 2, 'chat <name> <message>')
			return { name, message: rest.join(' ') }
		},
		mutatesWorld: true,
	}),
	admchat: def({
		usage: 'admchat <name> <message>',
		summary: 'say something in admin chat',
		input: z.object({ name: PlayerNameSchema, message: z.string().min(1) }),
		tokens: ([name, ...rest]) => {
			requireTokens([name, rest.join(' ')], 2, 'admchat <name> <message>')
			return { name, message: rest.join(' ') }
		},
		mutatesWorld: true,
	}),
	'bulk-join': def({
		usage: 'bulk-join <count>',
		summary: 'connect several players at once, with default names',
		input: z.object({ count: z.int().min(1).max(MAX_PLAYERS) }),
		tokens: ([count]) => {
			const n = Number(count)
			if (!count || !Number.isInteger(n)) throw new Error('usage: bulk-join <count>')
			return { count: n }
		},
		mutatesWorld: true,
	}),
	'set-player-groups': def({
		usage: 'set-player-groups <name> [group...]',
		summary: 'set which admin-list groups a player is in (no groups = remove them from the list)',
		input: z.object({ name: PlayerNameSchema, groups: z.array(z.string().min(1)).prefault([]) }),
		tokens: ([name, ...groups]) => {
			requireTokens([name], 1, 'set-player-groups <name> [group...]')
			return { name, groups }
		},
		mutatesWorld: true,
	}),
	'define-group': def({
		usage: 'define-group <group> [perm...]',
		summary: 'create or redefine an admin-list group and the permissions it grants',
		input: z.object({ group: GroupNameSchema, permissions: z.array(z.string().min(1)).prefault([]) }),
		tokens: ([group, ...permissions]) => {
			requireTokens([group], 1, 'define-group <group> [perm...]')
			return { group, permissions }
		},
		mutatesWorld: true,
	}),
	'delete-group': def({
		usage: 'delete-group <group>',
		summary: 'remove an admin-list group, and every membership of it',
		input: z.object({ group: GroupNameSchema }),
		tokens: ([group]) => {
			requireTokens([group], 1, 'delete-group <group>')
			return { group }
		},
		mutatesWorld: true,
	}),
	players: def({
		usage: 'players',
		summary: 'who is connected',
		input: NoArgs,
		tokens: () => ({}),
	}),
	squad: def({
		usage: 'squad <name> <squad name>',
		summary: 'a player creates and leads a squad',
		input: z.object({ name: PlayerNameSchema, squadName: z.string().min(1) }),
		tokens: ([name, ...rest]) => {
			requireTokens([name, rest.join(' ')], 2, 'squad <name> <squad name>')
			return { name, squadName: rest.join(' ') }
		},
		mutatesWorld: true,
	}),
	squads: def({
		usage: 'squads',
		summary: 'the squads on each team, and who is in them',
		input: NoArgs,
		tokens: () => ({}),
	}),
	'join-squad': def({
		usage: 'join-squad <name> <squad id|squad name>',
		summary: 'a player joins an existing squad on their team',
		input: z.object({ name: PlayerNameSchema, squad: z.string().min(1) }),
		tokens: ([name, ...rest]) => {
			requireTokens([name, rest.join(' ')], 2, 'join-squad <name> <squad id|squad name>')
			return { name, squad: rest.join(' ') }
		},
		mutatesWorld: true,
	}),
	'leave-squad': def({
		usage: 'leave-squad <name>',
		summary: 'a player leaves their squad',
		input: z.object({ name: PlayerNameSchema }),
		tokens: ([name]) => {
			requireTokens([name], 1, 'leave-squad <name>')
			return { name }
		},
		mutatesWorld: true,
	}),
	'set-team': def({
		usage: 'set-team <name> <1|2>',
		summary: 'move a player onto a team, leaving their squad behind',
		input: z.object({ name: PlayerNameSchema, teamId: z.union([z.literal(1), z.literal(2)]) }),
		tokens: ([name, team]) => {
			requireTokens([name, team], 2, 'set-team <name> <1|2>')
			if (team !== '1' && team !== '2') throw new Error('usage: set-team <name> <1|2>')
			return { name, teamId: Number(team) as 1 | 2 }
		},
		mutatesWorld: true,
	}),
	cam: def({
		usage: 'cam <name> [off]',
		summary: 'a player enters admin camera, or leaves it with `off`',
		input: z.object({ name: PlayerNameSchema, off: z.boolean().prefault(false) }),
		tokens: ([name, off]) => {
			requireTokens([name], 1, 'cam <name> [off]')
			if (off && off !== 'off') throw new Error('usage: cam <name> [off]')
			return { name, off: off === 'off' }
		},
		mutatesWorld: true,
	}),
	kill: def({
		usage: 'kill <victim> <attacker>',
		summary: 'one player kills another',
		input: z.object({ victim: PlayerNameSchema, attacker: PlayerNameSchema }),
		tokens: ([victim, attacker]) => {
			requireTokens([victim, attacker], 2, 'kill <victim> <attacker>')
			return { victim, attacker }
		},
		mutatesWorld: true,
	}),
	end: def({
		usage: 'end [1|2]',
		summary: 'end the match, optionally naming the winning team',
		input: z.object({
			winnerTeamId: z
				.union([z.literal(1), z.literal(2)])
				.nullable()
				.prefault(null),
		}),
		tokens: ([team]) => {
			if (team && team !== '1' && team !== '2') throw new Error('usage: end [1|2]')
			return { winnerTeamId: team ? (Number(team) as 1 | 2) : null }
		},
		mutatesWorld: true,
	}),
	vote: def({
		usage: 'vote [layer|faction] [choice ...]',
		summary: "open one of the Squad server's own votes, as AdminEnableVoting does",
		input: z.object({
			kind: z.enum(['layer', 'faction']).prefault('layer'),
			choices: z.array(z.string()).prefault([]),
		}),
		tokens: ([kind, ...choices]) => {
			if (kind && kind !== 'layer' && kind !== 'faction') throw new Error('usage: vote [layer|faction] [choice ...]')
			return { kind: (kind as 'layer' | 'faction') ?? 'layer', choices }
		},
		mutatesWorld: true,
	}),
	rcon: def({
		usage: 'rcon <command>',
		summary: 'run a raw rcon command against the world',
		input: z.object({ command: z.string().min(1) }),
		tokens: (tokens) => {
			requireTokens([tokens.join(' ')], 1, 'rcon <command>')
			return { command: tokens.join(' ') }
		},
		mutatesWorld: true,
	}),
	cycle: def({
		usage: 'cycle',
		summary: 'drop and restore rcon, as a server restart would',
		input: NoArgs,
		tokens: () => ({}),
	}),
	rotate: def({
		usage: 'rotate',
		summary: 'rotate the log file, as the game does',
		input: NoArgs,
		tokens: () => ({}),
	}),
} as const

export type SandboxVerb = keyof typeof SANDBOX_VERBS
export const SANDBOX_VERB = Object.keys(SANDBOX_VERBS) as SandboxVerb[]
export const SandboxVerbSchema = z.enum(SANDBOX_VERB as [SandboxVerb, ...SandboxVerb[]])

export type SandboxVerbInput<V extends SandboxVerb> = z.output<(typeof SANDBOX_VERBS)[V]['input']>

// One wire shape for every verb, so the router is a single procedure rather than one per verb. The args are
// validated against the named verb's own schema on the way in.
export const SandboxCommandSchema = z.object({
	verb: SandboxVerbSchema,
	args: z.unknown(),
})
export type SandboxCommand = z.infer<typeof SandboxCommandSchema>

export function parseVerbArgs<V extends SandboxVerb>(verb: V, args: unknown): SandboxVerbInput<V> {
	return SANDBOX_VERBS[verb].input.parse(args) as SandboxVerbInput<V>
}

export function usageLines(): string[] {
	const width = Math.max(...SANDBOX_VERB.map((v) => SANDBOX_VERBS[v].usage.length))
	return SANDBOX_VERB.map((v) => `  ${SANDBOX_VERBS[v].usage.padEnd(width)}  ${SANDBOX_VERBS[v].summary}`)
}

// ---- the emulated Admins.cfg ----
//
// Held as structure and rendered to the real file format on read, so what an emulated server hands out is what a
// squad server would be handed, and the parse path is the production one. Both emulated hosts share it: the
// sandbox keeps it in memory, and the dev host writes it to the file its app reads back.

export type EmulatedAdminList = {
	// group name -> the permissions it grants
	groups: Map<string, string[]>
	// player name -> the groups they are in
	memberships: Map<string, Set<string>>
}

// what the emulated list treats as marking an admin
export const IDENTIFYING_PERMS = ['canseeadminchat']

// The group an admin gets by default. Its permissions are the ones that actually gate things in SLM: seeing admin
// chat is what puts a player in scope for in-game commands.
export const DEFAULT_ADMIN_GROUP = 'Admin'

// A group an emulated server's admin list ships with, and how a grouping built from it presents that group. The
// two travel together because they are the same thing seen from either end: `name` is the token in Admins.cfg
// that an `admin-list` rule matches on, `label` and `color` are what the rule's group looks like on a chart.
export type SeededAdminGroup = { name: string; perms: SM.PlayerPerm[]; label: string; color: string }

// Enough of a spread that a breakdown of an emulated server shows something, and a plausible one: an admin list is
// mostly not admins. Only Admin grants an identifying permission -- the rest are the reserve-slot and tagging
// groups a community actually keeps, which is exactly what grouping on an admin list is for.
export const SEEDED_ADMIN_GROUPS: SeededAdminGroup[] = [
	{
		name: DEFAULT_ADMIN_GROUP,
		perms: ['canseeadminchat', 'balance', 'cameraman', 'teamchange', 'kick', 'ban'],
		label: 'Admin',
		color: '#d1495b',
	},
	// no permissions at all: a watchlist marks a player, it does not give them anything
	{ name: 'Watchlist', perms: [], label: 'Watchlist', color: '#e08e45' },
	{ name: 'ArmorPlayer', perms: ['reserve'], label: 'Armor Player', color: '#3d7dd9' },
	{ name: 'SquadLeader', perms: ['reserve'], label: 'Squad Leader', color: '#3f9e6b' },
	{ name: 'Regular', perms: ['reserve'], label: 'Regular', color: '#8367c7' },
]

// Which groups the nth player to connect to an emulated server lands in. A fixed pattern rather than a random
// draw, so the same scenario produces the same breakdown twice, and it repeats, so a roster of any size is spread
// across every group. Some players are in two groups and some in none: both are the interesting cases, since rule
// order is what decides the first and "Other" is what shows the second.
const SEEDED_MEMBERSHIP_PATTERN: string[][] = [
	['Admin', 'Regular'],
	['Regular'],
	['SquadLeader'],
	['ArmorPlayer'],
	[],
	['Regular'],
	['Watchlist'],
	['SquadLeader'],
	[],
	['ArmorPlayer', 'Regular'],
	['Admin'],
	[],
]

export function seededGroupsFor(joinIndex: number): string[] {
	return [...SEEDED_MEMBERSHIP_PATTERN[joinIndex % SEEDED_MEMBERSHIP_PATTERN.length]]
}

// The name an unnamed player gets, by the order they connect. Sequential rather than random so a scenario written
// against Player1 keeps meaning the same thing -- and so anything written about them in advance names them right.
export function defaultPlayerName(index: number): string {
	return `Player${index + 1}`
}

// the index behind such a name, or null for a player a scenario named itself
export function defaultPlayerIndex(name: string): number | null {
	const match = /^Player(\d+)$/.exec(name)
	if (!match) return null
	const ordinal = Number(match[1])
	return ordinal > 0 ? ordinal - 1 : null
}

export function initAdminList(): EmulatedAdminList {
	return { groups: new Map(SEEDED_ADMIN_GROUPS.map((g) => [g.name, [...g.perms]])), memberships: new Map() }
}

// Squad's Admins.cfg format. A player the caller cannot resolve to a steam id cannot appear, and neither can a
// membership of a group that has since been deleted.
export function renderAdminsCfg(list: EmulatedAdminList, steamIdFor: (playerName: string) => string | undefined): string {
	const lines: string[] = []
	for (const [group, perms] of list.groups) lines.push(`Group=${group}:${perms.join(',')}`)
	for (const [name, groups] of list.memberships) {
		const steamId = steamIdFor(name)
		if (!steamId) continue
		for (const group of groups) {
			if (!list.groups.has(group)) continue
			lines.push(`Admin=${steamId}:${group}`)
		}
	}
	return lines.length > 0 ? lines.join('\n') + '\n' : ''
}

// One group and the ids in it, for callers that hold steam ids rather than a roster to resolve names against.
export function renderAdminsCfgGroup(group: string, perms: readonly SM.PlayerPerm[], steamIds: readonly string[]): string {
	return [`Group=${group}:${perms.join(',')}`, ...steamIds.map((steamId) => `Admin=${steamId}:${group}`)].join('\n') + '\n'
}
