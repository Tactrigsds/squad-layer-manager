// Detailed, per-command help: what each argument accepts, and worked examples. Shared by the commands page and the
// in-game help command so both explain a command the same way.
//
// Everything here is derived from the command's declaration rather than written out per command. There are ~30
// commands and most of their arguments are the same handful of kinds, so the alternative -- prose and examples
// hand-maintained per command -- would be ~30 copies of the same four explanations, drifting apart as arg handling
// changes. Instead each ArgDef kind documents and samples itself once (ARG_KIND_HELP, sampleTokens), and a command's
// examples are those samples poured into its own signature.

import * as Str from '@/lib/string-utils'
import { assertNever } from '@/lib/type-guards'
import * as AAR from '@/models/admin-action-reasons.models'
import * as CMD from '@/models/command.models'
import * as LP from '@/models/labeled-presets.models'
import { join, t, type TString } from '@/models/messages.models'

// what an arg kind accepts, explained once for every arg that uses it. `syntax` is the shape of the token(s), which is
// typed rather than read; `description` is the prose shown beside it.
export const ARG_KIND_HELP: Record<CMD.ArgDef['kind'], { syntax: string; description: TString }> = {
	string: { syntax: 'word', description: t('A single word. Matching is case-insensitive.') },
	int: { syntax: 'number', description: t('A whole number.') },
	duration: {
		syntax: '30m | 2h | 1d',
		description: t('A length of time: a number followed by s, m, h, d or w.'),
	},
	player: {
		syntax: 'name | id',
		description: t(
			'An online player, by ID (Steam, EOS or Epic) or by a piece of their username. The username has to match exactly one player, so use enough of it to be unambiguous.',
		),
	},
	team: {
		syntax: '1 | 2 | A | B | faction',
		description: t(
			"A team: 1 or 2 for the in-game slot, A or B for the side that stays the same across map changes, or the name of that team's faction in the current layer.",
		),
	},
	squad: {
		syntax: '[team] squad',
		description: t(
			'A squad by its in-game number, or "cmd" for the command squad. Prefix it with a team (1, 2, A, B, or the team\'s faction) to target the other team; without one, your own team is used.',
		),
	},
	text: { syntax: 'free text', description: t('Everything you type after this point, as-is.') },
	reason: {
		syntax: 'preset | free text',
		description: t(
			'A single word picks a configured reason by one of its keywords. Two or more words are sent verbatim as a custom reason.',
		),
	},
	'preset-reason': {
		syntax: 'preset',
		description: t('A configured reason, by one of its keywords. Custom text is not accepted here.'),
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
	description: TString
	optional: boolean
	// the configured reasons this arg accepts, when it draws on them
	presets: string[]
	// What the triggers fix this argument to, when none of them lets a caller type it: the value is then part of what
	// the command does rather than something to explain how to write. `triggers` names which strings set each value,
	// which only matters where they disagree.
	fixed: { value: string; triggers: string[] }[]
}

// how each of a command's triggers treats its arguments. A plain trigger takes them all as typed; one with an args
// template takes only what it leaves open and fixes the rest.
type TriggerArgUse = { trigger: CMD.CommandTrigger; typed: Set<string>; pinned: Record<string, string> }

function triggerArgUses(id: CMD.CommandId, config: CMD.CommandConfig): TriggerArgUse[] {
	const args = CMD.COMMAND_DECLARATIONS[id].args as readonly CMD.ArgDef[]
	return config.triggers.map((trigger) => {
		const template = CMD.triggerArgs(trigger)
		if (template === undefined) return { trigger, typed: new Set(args.map((def) => def.name)), pinned: {} }
		const res = CMD.resolveTriggerArgs(id, template)
		// an unresolvable template runs nothing, so it neither takes nor fixes anything
		if (res.code !== 'ok') return { trigger, typed: new Set<string>(), pinned: {} }
		return { trigger, typed: new Set(res.params.map((p) => p.def.name)), pinned: res.pinned }
	})
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

// The arguments as the command's triggers actually expose them. An argument no trigger lets a caller type is
// described by the value they fix it to instead, and one no trigger supplies at all is left out: explaining how to
// write a word nothing can carry is worse than saying nothing, since it reads as an argument the command takes.
export function describeArgs(
	id: CMD.CommandId,
	config: CMD.CommandConfig,
	seeds: ExampleSeeds,
	requiredReasonActions: readonly AAR.AdminActionType[] = [],
): ArgHelp[] {
	const args = CMD.COMMAND_DECLARATIONS[id].args as readonly CMD.ArgDef[]
	const uses = triggerArgUses(id, config)
	const help: ArgHelp[] = []
	for (const def of args) {
		const kindHelp = ARG_KIND_HELP[def.kind]
		const typed = uses.some((use) => use.typed.has(def.name))
		const fixed: ArgHelp['fixed'] = []
		if (!typed) {
			for (const use of uses) {
				const value = use.pinned[def.name]
				if (value === undefined) continue
				const existing = fixed.find((f) => f.value === value)
				if (existing) existing.triggers.push(CMD.triggerString(use.trigger))
				else fixed.push({ value, triggers: [CMD.triggerString(use.trigger)] })
			}
			if (fixed.length === 0) continue
		}
		help.push({
			name: def.name,
			syntax: kindHelp.syntax,
			// the kind explains the general shape; `describe` says what this arg means for this command
			description: def.describe ? join([def.describe, kindHelp.description], ' ') : kindHelp.description,
			optional: argOptional(def, requiredReasonActions),
			presets: argPresets(def, seeds).map(LP.describePreset),
			fixed,
		})
	}
	return help
}

// -------- triggers --------

// One way to run a command: the trigger strings that take the same thing from the caller, since a template is what
// decides that rather than the string in front of it. `expansion` is the fuller command text a shortcut stands for,
// and is absent for a group that is the command's own form -- the plain triggers, or every group where the command
// has no plain trigger and each way in is all there is.
export type TriggerGroup = {
	strings: string[]
	signature: string
	// what running the command this way always sets, whoever runs it
	pins: { name: string; value: string }[]
	expansion?: string
}

export function triggerGroups(
	id: CMD.CommandId,
	config: CMD.CommandConfig,
	requiredReasonActions: readonly AAR.AdminActionType[] = [],
): TriggerGroup[] {
	const groups: (TriggerGroup & { template?: string })[] = []
	for (const trigger of config.triggers) {
		const template = CMD.triggerArgs(trigger)
		const existing = groups.find((g) => g.template === template)
		if (existing) {
			existing.strings.push(CMD.triggerString(trigger))
			continue
		}
		groups.push({
			template,
			strings: [CMD.triggerString(trigger)],
			signature: CMD.formatTriggerSignature(id, trigger, requiredReasonActions),
			pins: CMD.triggerPins(id, trigger),
			expansion: CMD.describeTriggerExpansion(config, trigger),
		})
	}
	// the plain triggers first: the command in its fullest form, and what the shortcuts are shortcuts for
	return groups
		.map(({ template: _template, ...group }) => group)
		.toSorted((a, b) => Number(a.expansion !== undefined) - Number(b.expansion !== undefined))
}

// -------- examples --------

export type CommandExample = {
	command: string
	// what this example demonstrates over the previous one, e.g. "with a custom reason"
	note: TString
}

// the token(s) an arg is filled with in an example. `token` is the arg's ordinary form. `alt` is a second form worth
// demonstrating in its own right -- free text where the ordinary form is a preset lookup, an explicit team on a squad,
// a faction where the ordinary form is a team number -- and carries the note explaining it, since what makes it worth
// showing differs by kind. `token` is absent when nothing can fill the arg (a reason on an installation with none
// configured for that action).
type Sample = { token?: string; alt?: { token: string; note: TString } }

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
		case 'team':
			return { token: '2', alt: { token: 'CAF', note: t('Naming the team by its faction') } }
		case 'squad':
			return { token: '3', alt: { token: '2 3', note: t("Targeting the other team's squad") } }
		case 'text':
			return { token: 'some text' }
		case 'reason':
		case 'preset-reason': {
			// the first preset that can actually be picked by a single token, not just the first configured one
			const token = firstPresetToken(AAR.reasonsForAction(seeds.reasons, def.action))
			// `preset-reason` takes presets only, so it has no free-text form to demonstrate
			if (def.kind === 'preset-reason') return { token }
			return { token, alt: { token: 'stop doing that', note: t('With a custom reason') } }
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

// A word an example has to fill, in the order the caller types it. Not the same as the command's arguments: a trigger
// with an args template asks for only the words it leaves open, and `wholeSlot` is false where the word it asks for
// is one part of an argument rather than the whole of it (`args: 'Round ends in {{arg1}} minutes'`).
type Slot = { def: CMD.ArgDef; name: string; optional: boolean; wholeSlot: boolean }

// what the primary trigger takes from the caller, which is what an example of the command has to show them typing
function exampleSlots(
	id: CMD.CommandId,
	trigger: CMD.CommandTrigger | undefined,
	requiredReasonActions: readonly AAR.AdminActionType[],
): Slot[] {
	const args = CMD.COMMAND_DECLARATIONS[id].args as readonly CMD.ArgDef[]
	const template = trigger === undefined ? undefined : CMD.triggerArgs(trigger)
	if (template === undefined) {
		return args.map((def) => ({ def, name: def.name, optional: argOptional(def, requiredReasonActions), wholeSlot: true }))
	}
	const res = CMD.resolveTriggerArgs(id, template)
	if (res.code !== 'ok') return []
	return res.params.map((p) => ({
		def: p.def,
		name: p.wholeSlot ? p.def.name : p.ref.name,
		// a placeholder with a fallback can be left out even where the argument it fills is required
		optional: p.hasDefault || argOptional(p.def, requiredReasonActions),
		wholeSlot: p.wholeSlot,
	}))
}

// how far down the slot list an example fills, and which slot if any takes its alternate form. Examples are built by
// walking the slots in order, so a variant is a cutoff plus at most one slot demonstrating its second form; anything
// past the cutoff is left off.
type Variant = { note: TString; upTo: number; altAt?: number }

function renderExample(cmdString: string, slots: Slot[], seeds: ExampleSeeds, variant: Variant): string | undefined {
	const tokens: string[] = []
	for (let i = 0; i < variant.upTo; i++) {
		const sample = sampleTokens(slots[i].def, seeds)
		const token = i === variant.altAt ? sample.alt?.token : sample.token
		// nothing to fill this slot with, so the example would be a lie about what the command accepts. The alternate
		// form usually still renders, and covers the slot on its own
		if (token === undefined) return undefined
		tokens.push(token)
	}
	return [cmdString, ...tokens].join(' ')
}

// Worked examples for a command, in escalating order: the shortest form that runs, then one adding each optional word.
// A slot with a second form worth showing gets an example of its own, placed at the shortest length that reaches it so
// it demonstrates one thing at a time. Duplicates collapse, so a command taking nothing gets exactly one example.
//
// The examples are of the primary trigger, so they show what that trigger takes rather than what the command
// declares: an argument it pins is already filled, and copying an example that supplies one anyway would run
// something other than what it reads as.
export function buildExamples(
	id: CMD.CommandId,
	config: CMD.CommandConfig,
	seeds: ExampleSeeds,
	requiredReasonActions: readonly AAR.AdminActionType[] = [],
): CommandExample[] {
	const primary = CMD.primaryTrigger(config)
	const cmdString = primary ? CMD.triggerString(primary) : id
	const slots = exampleSlots(id, primary, requiredReasonActions)
	// A word standing for part of an argument (`args: 'Round ends in {{arg1}} minutes'`) is the trigger's own idea,
	// and nothing here knows what belongs there. Any word we filled it with would read as the shape it takes, so the
	// usage line is left to speak for it.
	if (slots.some((slot) => !slot.wholeSlot)) return []
	const firstOptional = slots.findIndex((slot) => slot.optional)
	const minimal = firstOptional === -1 ? slots.length : firstOptional

	// an alternate form rides along with the shortest example that reaches its slot, so it lands next to the plain
	// example it varies rather than at the end, where it would read as a further argument
	const alts = slots
		.map((slot, i) => {
			const alt = sampleTokens(slot.def, seeds).alt
			return alt && { note: alt.note, upTo: Math.max(minimal, i + 1), altAt: i }
		})
		.filter((variant) => !!variant)

	const variants: Variant[] = []
	for (let upTo = minimal; upTo <= slots.length; upTo++) {
		if (upTo === minimal) variants.push({ note: slots.length === 0 ? t('Run it') : t('The shortest form'), upTo })
		else variants.push({ note: t('With {arg}', { arg: slots[upTo - 1].name }), upTo })
		variants.push(...alts.filter((variant) => variant.upTo === upTo))
	}

	const examples: CommandExample[] = []
	for (const variant of variants) {
		const command = renderExample(cmdString, slots, seeds, variant)
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
		const choices = Str.nearest(sectionToken, CMD.sectionTokens(), CMD.MAX_CHOICES).map((token) => ({ tokens: [token], label: token }))
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

// The commands page's fragment for a command's full listing: its entry under its own declared section. The page also
// lists pinned and quick-reference copies, each under its own fragment, but a link from elsewhere wants the listing
// carrying the arguments and examples.
export function commandsPageAnchor(cmdId: CMD.CommandId): string {
	return `section:${CMD.COMMAND_DECLARATIONS[cmdId].section}/command:${cmdId}`
}

// the dotted global-settings path holding a command's configuration
export function commandSettingsPath(cmdId: CMD.CommandId): string {
	return `commands.${cmdId}`
}

// groups command ids into their declared sections, dropping empty ones. Section order follows COMMAND_SECTIONS.
export function splitCommandsBySection(ids: CMD.CommandId[]): { section: CMD.CommandSection; label: string; ids: CMD.CommandId[] }[] {
	return CMD.COMMAND_SECTION_IDS.map((section) => ({
		section,
		label: CMD.COMMAND_SECTIONS[section].label,
		ids: ids.filter((id) => CMD.COMMAND_DECLARATIONS[id].section === section),
	})).filter((s) => s.ids.length > 0)
}
