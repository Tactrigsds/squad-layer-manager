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
import * as LP from '@/models/labeled-presets.models'
import { t, type TString } from '@/models/messages.models'

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
		description:
			'An online player, by ID (Steam, EOS or Epic) or by a piece of their username. The username has to match exactly one ' +
			'player, so use enough of it to be unambiguous.',
	},
	squad: {
		syntax: '[team] squad',
		description:
			'A squad by its in-game number, or "cmd" for the command squad. Prefix it with a team (1, 2, A, B, or the team\'s ' +
			'faction) to target the other team; without one, your own team is used.',
	},
	text: { syntax: 'free text', description: 'Everything you type after this point, as-is.' },
	reason: {
		syntax: 'preset | free text',
		description:
			'A single word picks a configured reason by one of its keywords. Two or more words are sent verbatim as a custom reason.',
	},
	'preset-reason': {
		syntax: 'preset',
		description: 'A configured reason, by one of its keywords. Custom text is not accepted here.',
	},
}

// the live values examples are filled from, so an example uses reasons this installation actually has
// configured rather than invented ones an admin would get an "unknown reason" error for
export type ExampleSeeds = {
	reasons: AAR.AdminActionReason[]
}

export type ArgHelp = {
	name: string
	syntax: string
	description: string
	optional: boolean
	// the configured reasons this arg accepts, when it draws on them
	presets: string[]
}

// an arg is optional in the signature unless its declaration says otherwise, or the installation requires a reason
// for that action (mirrors formatArg's handling of requiredReasonActions)
function argOptional(def: CMD.ArgDef, requiredReasonActions: readonly AAR.AdminActionType[]): boolean {
	if (def.kind === 'reason' || def.kind === 'preset-reason') {
		return !requiredReasonActions.includes(def.action) && !!def.optional
	}
	if (def.kind === 'squad') return false
	return !!def.optional
}

// The token that picks this preset in chat: its first keyword. Keywords carry no whitespace and at least one is
// required, so unlike the label a preset is always reachable by one.
function presetToken(preset: { keywords: string[] }): string | undefined {
	return preset.keywords[0]
}

function argPresets(def: CMD.ArgDef, seeds: ExampleSeeds): { label: string; keywords: string[] }[] {
	switch (def.kind) {
		case 'reason':
		case 'preset-reason':
			return AAR.reasonsForAction(seeds.reasons, def.action)
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
			presets: argPresets(def, seeds).map(LP.describePreset),
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
			// the first preset that can actually be picked by a single token, not just the first configured one
			const token = firstPresetToken(AAR.reasonsForAction(seeds.reasons, def.action))
			// `preset-reason` takes presets only, so it has no free-text form to demonstrate
			if (def.kind === 'preset-reason') return { token }
			return { token, alt: { token: 'stop doing that', note: 'With a custom reason' } }
		}
		default:
			assertNever(def)
	}
}

function firstPresetToken(presets: { keywords: string[] }[]): string | undefined {
	for (const preset of presets) {
		const token = presetToken(preset)
		if (token !== undefined) return token
	}
	return undefined
}

// how far down the arg list an example fills. Examples are built by walking the args in order, so a variant is a
// cutoff plus whether the last filled arg takes its alternate form; anything past the cutoff is left off.
type Variant = { note: string; upTo: number; useAlt?: true }

function renderExample(cmdString: string, args: readonly CMD.ArgDef[], seeds: ExampleSeeds, variant: Variant): string | undefined {
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
	const primary = CMD.primaryTrigger(config)
	const cmdString = primary ? CMD.triggerString(primary) : id
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
// handful of commands they actually use, not thirty lines paged into chat. A command's shortcut triggers ride along
// with it rather than being listed separately: they are the same command, reached a different way.
export type HelpListing =
	| { code: 'ok'; title: TString; commands: CMD.CommandId[]; hint?: TString }
	// `choices` are the sections close enough to what was typed to offer back; the message names the rest only when
	// there are none, so a caller is never read a list twice
	| { code: 'err:unknown-section'; msg: TString; choices: CMD.ArgChoice[] }

const sectionOptions = () => CMD.sectionTokens().join(', ')

// resolves what `!help [section]` should list. Only enabled commands are listed: a disabled one cannot be run.
export function resolveHelpListing(configs: CMD.CommandConfigs, sectionToken: string | undefined): HelpListing {
	const runnable = (id: CMD.CommandId) => configs[id].enabled

	if (sectionToken === undefined) {
		const commands = CMD.COMMAND_IDS.filter((id) => runnable(id) && configs[id].quickReference)
		const primary = CMD.primaryTrigger(configs.help)
		const helpString = primary ? CMD.triggerString(primary) : 'help'
		return {
			code: 'ok',
			title: t('Commands'),
			commands,
			// the placeholder is syntax rather than prose, and passing it in keeps the pattern free of a literal '<'
			hint: t('More: {helpString} {placeholder} -- {options}', { helpString, placeholder: '<section>', options: sectionOptions() }),
		}
	}

	if (sectionToken.trim().toLowerCase() === CMD.ALL_SECTIONS_TOKEN) {
		return { code: 'ok', title: t('All commands'), commands: CMD.COMMAND_IDS.filter(runnable) }
	}

	const section = CMD.resolveSectionToken(sectionToken)
	if (!section) {
		const choices = CMD.nearest(sectionToken, CMD.sectionTokens()).map((token) => ({ tokens: [token], label: token }))
		return {
			code: 'err:unknown-section',
			msg:
				choices.length > 0
					? t('Unknown section "{sectionToken}"', { sectionToken })
					: t('Unknown section "{sectionToken}". Try one of: {options}', { sectionToken, options: sectionOptions() }),
			choices,
		}
	}
	return {
		code: 'ok',
		title: t('{label} commands', { label: CMD.COMMAND_SECTIONS[section].label }),
		commands: CMD.commandsInSection(section).filter(runnable),
	}
}

// groups command ids into their declared sections, dropping empty ones. Section order follows COMMAND_SECTIONS.
export function splitCommandsBySection(ids: CMD.CommandId[]): { section: CMD.CommandSection; label: string; ids: CMD.CommandId[] }[] {
	return CMD.COMMAND_SECTION_IDS.map((section) => ({
		section,
		label: CMD.COMMAND_SECTIONS[section].label,
		ids: ids.filter((id) => CMD.COMMAND_DECLARATIONS[id].section === section),
	})).filter((s) => s.ids.length > 0)
}
