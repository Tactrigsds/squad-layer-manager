// Detailed, per-command help: what each argument accepts, and worked examples. Shared by the commands page and the
// in-game help command so both explain a command the same way.
//
// Everything here is derived from the command's declaration rather than written out per command. There are ~30
// commands and most of their arguments are the same handful of kinds, so the alternative -- prose and examples
// hand-maintained per command -- would be ~30 copies of the same four explanations, drifting apart as arg handling
// changes. Instead each ArgDef kind documents and samples itself once (ARG_KIND_HELP, sampleTokens), and a command's
// examples are those samples poured into its own signature.

import { assertNever } from '@/lib/type-guards'
import * as AAR from '@/models/admin-action-reasons.models'
import * as CMD from '@/models/command.models'
import type * as LP from '@/models/labeled-presets.models'

// what an arg kind accepts, explained once for every arg that uses it. `syntax` is the shape of the token(s);
// `description` is the prose shown beside it.
export const ARG_KIND_HELP: Record<CMD.ArgDef['kind'], { syntax: string; description: string }> = {
	string: { syntax: 'word', description: 'A single word. Matching is case-insensitive.' },
	int: { syntax: 'number', description: 'A whole number.' },
	duration: {
		syntax: '30m | 2h | 1d',
		description: 'A length of time: a number followed by s, m, h, d or w.',
	},
	player: {
		syntax: 'name | id',
		description: 'An online player, by ID (Steam, EOS or Epic) or by a piece of their username. The username has to match exactly one '
			+ 'player, so use enough of it to be unambiguous.',
	},
	squad: {
		syntax: '[team] squad',
		description: 'A squad by its in-game number, or "cmd" for the command squad. Prefix it with a team (1, 2, A, B, or the team\'s '
			+ 'faction) to target the other team; without one, your own team is used.',
	},
	text: { syntax: 'free text', description: 'Everything you type after this point, as-is.' },
	reason: {
		syntax: 'preset | free text',
		description: 'A single word picks a configured reason by its name or alias. Two or more words are sent verbatim as a custom reason.',
	},
	'preset-reason': {
		syntax: 'preset',
		description: 'A configured reason, by its name or alias. Custom text is not accepted here.',
	},
	broadcast: {
		syntax: 'preset | free text',
		description: 'A single word picks a configured broadcast by its name or alias. Two or more words are broadcast verbatim.',
	},
}

// the live values examples are filled from, so an example uses reasons and broadcasts this installation actually has
// configured rather than invented ones an admin would get an "unknown reason" error for
export type ExampleSeeds = {
	reasons: AAR.AdminActionReason[]
	broadcasts: LP.BroadcastPreset[]
}

export type ArgHelp = {
	name: string
	syntax: string
	description: string
	optional: boolean
	// the configured reasons/broadcasts this arg accepts, when it draws on them
	presets: string[]
}

// an arg is optional in the signature unless its declaration says otherwise, or the installation requires a reason
// for that action (mirrors formatArg's handling of requiredReasonActions)
function argOptional(def: CMD.ArgDef, requiredReasonActions: readonly AAR.AdminActionType[]): boolean {
	if (def.kind === 'reason' || def.kind === 'preset-reason') {
		return !requiredReasonActions.includes(def.action) && !!def.optional
	}
	if (def.kind === 'squad' || def.kind === 'broadcast') return false
	return !!def.optional
}

function presetsFor(def: CMD.ArgDef, seeds: ExampleSeeds): string[] {
	switch (def.kind) {
		case 'reason':
		case 'preset-reason':
			return AAR.reasonsForAction(seeds.reasons, def.action).map((r) => r.label)
		case 'broadcast':
			return seeds.broadcasts.map((b) => b.label)
		default:
			return []
	}
}

export function describeArgs(
	id: CMD.CommandId,
	seeds: ExampleSeeds,
	requiredReasonActions: readonly AAR.AdminActionType[] = [],
): ArgHelp[] {
	const args = CMD.COMMAND_DECLARATIONS[id].args as readonly CMD.ArgDef[]
	return args.map((def) => {
		const kindHelp = ARG_KIND_HELP[def.kind]
		return {
			name: def.name,
			syntax: kindHelp.syntax,
			// the kind explains the general shape; `describe` says what this arg means for this command
			description: def.describe ? `${def.describe} ${kindHelp.description}` : kindHelp.description,
			optional: argOptional(def, requiredReasonActions),
			presets: presetsFor(def, seeds),
		}
	})
}

// -------- examples --------

export type CommandExample = {
	command: string
	// what this example demonstrates over the previous one, e.g. "with a custom reason"
	note: string
}

// the token(s) an arg is filled with in an example. `token` is the arg's ordinary form. `alt` is a second form worth demonstrating in its own right -- free text where
// the ordinary form is a preset lookup, or an explicit team on a squad -- and carries the note explaining it, since
// what makes it worth showing differs by kind. `token` is absent when nothing can fill the arg (a reason on an
// installation with none configured for that action).
type Sample = { token?: string; alt?: { token: string; note: string } }

function sampleTokens(def: CMD.ArgDef, seeds: ExampleSeeds): Sample {
	if (def.sample) return { token: def.sample }
	switch (def.kind) {
		case 'string':
			return { token: def.name }
		case 'int':
			return { token: '3' }
		case 'duration':
			return { token: '2h' }
		case 'player':
			return { token: 'Alice' }
		case 'squad':
			return { token: '3', alt: { token: '2 3', note: "Targeting the other team's squad" } }
		case 'text':
			return { token: 'some text' }
		case 'reason':
		case 'preset-reason': {
			const token = AAR.reasonsForAction(seeds.reasons, def.action)[0]?.label
			// `preset-reason` takes presets only, so it has no free-text form to demonstrate
			if (def.kind === 'preset-reason') return { token }
			return { token, alt: { token: 'stop doing that', note: 'With a custom reason' } }
		}
		case 'broadcast':
			return {
				token: seeds.broadcasts[0]?.label,
				alt: { token: 'Server restarting in 5 minutes', note: 'With a custom message' },
			}
		default:
			assertNever(def)
	}
}

// how far down the arg list an example fills. Examples are built by walking the args in order, so a variant is a
// cutoff plus whether the last filled arg takes its alternate form; anything past the cutoff is left off.
type Variant = { note: string; upTo: number; useAlt?: true }

function renderExample(
	cmdString: string,
	args: readonly CMD.ArgDef[],
	seeds: ExampleSeeds,
	variant: Variant,
): string | undefined {
	const tokens: string[] = []
	for (let i = 0; i < variant.upTo; i++) {
		const sample = sampleTokens(args[i], seeds)
		const token = variant.useAlt && i === variant.upTo - 1 ? sample.alt?.token : sample.token
		// nothing to fill this arg with, so the example would be a lie about what the command accepts. The alternate
		// form usually still renders, and covers the arg on its own
		if (token === undefined) return undefined
		tokens.push(token)
	}
	return [cmdString, ...tokens].join(' ')
}

// Worked examples for a command, in escalating order: the shortest form that runs, then one adding each optional arg,
// then the last arg's alternate form. Only the last arg can have one (the kinds that take free text must be declared
// last, and it's the distinction admins trip on: one word means "look this preset up", two or more means "send it
// verbatim"). Duplicates collapse, so an argless command gets exactly one example.
export function buildExamples(
	id: CMD.CommandId,
	config: CMD.CommandConfig,
	seeds: ExampleSeeds,
	requiredReasonActions: readonly AAR.AdminActionType[] = [],
): CommandExample[] {
	const args = CMD.COMMAND_DECLARATIONS[id].args as readonly CMD.ArgDef[]
	const cmdString = config.strings[0] ?? id
	const firstOptional = args.findIndex((def) => argOptional(def, requiredReasonActions))
	const minimal = firstOptional === -1 ? args.length : firstOptional

	const variants: Variant[] = [{ note: args.length === 0 ? 'Run it' : 'The shortest form', upTo: minimal }]
	for (let i = minimal + 1; i <= args.length; i++) {
		variants.push({ note: `With ${args[i - 1].name}`, upTo: i })
	}
	const alt = args.length > 0 ? sampleTokens(args[args.length - 1], seeds).alt : undefined
	if (alt) variants.push({ note: alt.note, upTo: args.length, useAlt: true })

	const examples: CommandExample[] = []
	for (const variant of variants) {
		const command = renderExample(cmdString, args, seeds, variant)
		if (command === undefined) continue
		if (examples.some((e) => e.command === command)) continue
		examples.push({ command, note: variant.note })
	}
	return examples
}

// -------- help listings --------

// what a help command lists. A bare `!help` answers with the quick reference, since an admin mid-match wants the
// handful of commands they actually use, not thirty lines paged into chat.
export type HelpListing =
	| { code: 'ok'; title: string; commands: CMD.CommandId[]; aliases: CMD.CommandAlias[] }
	| { code: 'err:unknown-section'; msg: string }

const sectionOptions = () => [...CMD.COMMAND_SECTION_IDS.map((s) => CMD.COMMAND_SECTIONS[s].label), CMD.ALL_SECTIONS_TOKEN].join(', ')

// resolves what `!help [section]` should list. Only enabled commands are listed, and aliases whose target is disabled
// or missing are dropped: neither can actually be run.
export function resolveHelpListing(
	configs: CMD.CommandConfigs,
	aliases: readonly CMD.CommandAlias[],
	sectionToken: string | undefined,
): HelpListing {
	const runnable = (id: CMD.CommandId) => configs[id].enabled
	const aliasesFor = (section: CMD.CommandSection | 'all' | 'quick-reference') =>
		aliases.filter((a) => {
			const res = CMD.resolveAliasCommand(a.command, configs)
			if (res.code !== 'ok' || !configs[res.cmdId].enabled) return false
			if (section === 'all') return true
			if (section === 'quick-reference') return configs[res.cmdId].quickReference
			return CMD.COMMAND_DECLARATIONS[res.cmdId].section === section
		})

	if (sectionToken === undefined) {
		const commands = CMD.COMMAND_IDS.filter((id) => runnable(id) && configs[id].quickReference)
		const helpString = configs.help.strings[0] ?? 'help'
		return {
			code: 'ok',
			title: `Commands (${helpString} ${sectionOptions()} for more)`,
			commands,
			aliases: aliasesFor('quick-reference'),
		}
	}

	if (sectionToken.trim().toLowerCase() === CMD.ALL_SECTIONS_TOKEN) {
		return { code: 'ok', title: 'All commands', commands: CMD.COMMAND_IDS.filter(runnable), aliases: aliasesFor('all') }
	}

	const section = CMD.resolveSectionToken(sectionToken)
	if (!section) {
		return { code: 'err:unknown-section', msg: `Unknown section "${sectionToken}". Try one of: ${sectionOptions()}` }
	}
	return {
		code: 'ok',
		title: `${CMD.COMMAND_SECTIONS[section].label} commands`,
		commands: CMD.commandsInSection(section).filter(runnable),
		aliases: aliasesFor(section),
	}
}

// groups command ids into their declared sections, dropping empty ones. Section order follows COMMAND_SECTIONS.
export function splitCommandsBySection(ids: CMD.CommandId[]): { section: CMD.CommandSection; label: string; ids: CMD.CommandId[] }[] {
	return CMD.COMMAND_SECTION_IDS
		.map((section) => ({
			section,
			label: CMD.COMMAND_SECTIONS[section].label,
			ids: ids.filter((id) => CMD.COMMAND_DECLARATIONS[id].section === section),
		}))
		.filter((s) => s.ids.length > 0)
}
