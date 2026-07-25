import { z } from 'zod'

// The scenario verbs a sandbox server understands, defined once for all three front ends: the repl inside
// `pnpm dev:emu`, the one-shot `pnpm emuctl`, and the sandbox window's oRPC router. A verb added here reaches
// all of them, and none of them can grow one the others lack.
//
// Schemas only, so this stays importable from the client. The executor is src/emulator/verbs.ts.

export const PlayerNameSchema = z.string().min(1).max(32).regex(
	/^[^\s]+$/,
	'A player name cannot contain spaces: the command line addresses players by a single token.',
)

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
		input: z.object({ name: PlayerNameSchema, message: z.string().min(1) }),
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
		input: z.object({ winnerTeamId: z.union([z.literal(1), z.literal(2)]).nullable().prefault(null) }),
		tokens: ([team]) => {
			if (team && team !== '1' && team !== '2') throw new Error('usage: end [1|2]')
			return { winnerTeamId: team ? (Number(team) as 1 | 2) : null }
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

export type SandboxVerbInput<V extends SandboxVerb> = z.output<typeof SANDBOX_VERBS[V]['input']>

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
