import { describe, expect, it } from 'vitest'

import * as I18n from '@/messages/i18n'
import type * as AAR from '@/models/admin-action-reasons.models'
import * as CMDH from '@/models/command-help.models'
import * as CMD from '@/models/command.models'

function reason(label: string, actions: AAR.AdminActionType[]): AAR.AdminActionReason {
	return {
		label,
		keywords: [label.toLowerCase().replace(/[^a-z0-9]+/g, '-')],
		actionTexts: Object.fromEntries(actions.map((a) => [a, `${label} text`])),
	}
}

const seeds: CMDH.ExampleSeeds = {
	reasons: [reason('toxicity', ['warn', 'kick', 'timeout']), reason('teamkilling', ['warn'])],
}
const noSeeds: CMDH.ExampleSeeds = { reasons: [] }

// the real configs, with every command's declared strings under the default prefix
const configs = CMD.seedCommandConfigs({}, CMD.DEFAULT_PREFIX) as unknown as CMD.CommandConfigs
const P = CMD.DEFAULT_PREFIX

function withConfig(id: CMD.CommandId, patch: Partial<CMD.CommandConfig>): CMD.CommandConfigs {
	return { ...configs, [id]: { ...configs[id], ...patch } }
}

const pinned45m = (string: string): CMD.CommandTrigger => ({ string, args: '{{arg1}} 45m' })

function withTimeoutTriggers(triggers: CMD.CommandTrigger[]): CMD.CommandConfig {
	return { ...configs.timeout, triggers }
}

// the help models hand back TStrings; these resolve them, so an assertion reads as the text an admin is shown
const examplesOf = (...args: Parameters<typeof CMDH.buildExamples>) =>
	CMDH.buildExamples(...args).map((example) => ({ ...example, note: I18n.ambient.text(example.note) }))
const argsOf = (...args: Parameters<typeof CMDH.describeArgs>) =>
	CMDH.describeArgs(...args).map((arg) => ({ ...arg, description: I18n.ambient.text(arg.description) }))

describe('buildExamples', () => {
	it('gives an argless command exactly one example', () => {
		expect(examplesOf('swaps', configs.swaps, seeds)).toEqual([{ command: `${P}swaps`, note: 'Run it' }])
	})

	it('escalates from the required args to each optional one, then the free-text form', () => {
		// timeout is <player> <duration> [reason], and reason has both a preset and a custom form
		expect(examplesOf('timeout', configs.timeout, seeds)).toEqual([
			{ command: `${P}timeout Alice 2h`, note: 'The shortest form' },
			{ command: `${P}timeout Alice 2h toxicity`, note: 'With reason' },
			{ command: `${P}timeout Alice 2h stop doing that`, note: 'With a custom reason' },
		])
	})

	it('fills reason args from the configured reasons applicable to the action', () => {
		// teamkilling is warn-only, so kick must not offer it
		const [, withReason] = examplesOf('kick', configs.kick, seeds)
		expect(withReason.command).toBe(`${P}kick Alice toxicity`)
	})

	it('omits the preset example when the installation has no applicable reasons configured', () => {
		expect(examplesOf('kick', configs.kick, noSeeds)).toEqual([
			{ command: `${P}kick Alice`, note: 'The shortest form' },
			{ command: `${P}kick Alice stop doing that`, note: 'With a custom reason' },
		])
	})

	it('treats a reason as required when the installation requires one for that action', () => {
		const examples = examplesOf('kick', configs.kick, seeds, ['kick'])
		expect(examples[0]).toEqual({ command: `${P}kick Alice toxicity`, note: 'The shortest form' })
		expect(examples.every((e) => e.command !== `${P}kick Alice`)).toBe(true)
	})

	it('names a preset by its keyword, never its label', () => {
		// a two-word label typed verbatim would be read as a custom reason, not this preset; the keyword is what
		// chat matches, and one is always configured
		const multiWord: CMDH.ExampleSeeds = {
			...seeds,
			reasons: [{ ...reason('No SLKit', ['warn']), keywords: ['slkit'] }],
		}
		expect(examplesOf('warn', configs.warn, multiWord)[0].command).toBe(`${P}warn Alice slkit`)
	})

	it('uses the declared sample token for string args', () => {
		expect(examplesOf('flag', configs.flag, seeds)[0].command).toBe(`${P}flag Alice cheater`)
	})

	it('follows the command string an admin actually configured', () => {
		expect(examplesOf('swaps', { ...configs.swaps, triggers: ['.showswaps'] }, seeds)[0].command).toBe('.showswaps')
	})

	it('shows only what the primary trigger takes when it pins the rest', () => {
		// !to pins the duration and passes no reason on, so both would be words the trigger throws away
		expect(examplesOf('timeout', withTimeoutTriggers([pinned45m('!to')]), seeds)).toEqual([
			{ command: '!to Alice', note: 'The shortest form' },
		])
	})

	it('takes an optional word from the placeholder default that fills its argument', () => {
		const config = { ...configs.warn, triggers: [{ string: '!warnsp', args: '{{arg1}} {{^rest2}}spam{{/rest2}}{{rest2}}' }] }
		expect(examplesOf('warn', config, seeds)).toEqual([
			{ command: '!warnsp Alice', note: 'The shortest form' },
			{ command: '!warnsp Alice toxicity', note: 'With reason' },
			{ command: '!warnsp Alice stop doing that', note: 'With a custom reason' },
		])
	})

	it('gives no examples for a trigger whose placeholder part-fills an argument', () => {
		const config = { ...configs.broadcast, triggers: [{ string: '!eta', args: 'Round ends in {{arg1}} minutes' }] }
		expect(examplesOf('broadcast', config, seeds)).toEqual([])
	})
})

describe('describeArgs', () => {
	it('lists the configured presets a reason arg accepts, scoped to its action', () => {
		const [, reasonArg] = argsOf('warn', configs.warn, seeds)
		expect(reasonArg.presets).toEqual(['toxicity', 'teamkilling'])
		expect(argsOf('kick', configs.kick, seeds)[1].presets).toEqual(['toxicity'])
	})

	it("names every section in the help command's section arg", () => {
		const [sectionArg] = argsOf('help', configs.help, seeds)
		for (const token of CMD.sectionTokens()) expect(sectionArg.description).toContain(token)
	})

	it('prepends the per-arg note to its kind description', () => {
		const [flagArg] = argsOf('listFlags', configs.listFlags, seeds)
		expect(flagArg.description).toContain('Lists every flag in the organization when omitted.')
		expect(flagArg.description).toContain(I18n.ambient.text(CMDH.ARG_KIND_HELP.player.description))
	})

	it('keeps an argument described as typed while any trigger takes it', () => {
		// the shortcut pins the duration, but !timeout still asks for one
		const config = withTimeoutTriggers(['!timeout', pinned45m('!to')])
		const [player, duration, reason] = argsOf('timeout', config, seeds)
		expect([player.name, duration.name, reason.name]).toEqual(['player', 'duration', 'reason'])
		expect(duration.fixed).toEqual([])
	})

	it('describes an argument every trigger pins by the value they pin it to', () => {
		const config = withTimeoutTriggers([pinned45m('!to'), pinned45m('!timeout')])
		const [player, duration, ...rest] = argsOf('timeout', config, seeds)
		expect(player.fixed).toEqual([])
		expect(duration.fixed).toEqual([{ value: '45m', triggers: ['!to', '!timeout'] }])
		// no trigger passes a reason on, so there is no way to give one
		expect(rest).toEqual([])
	})

	it('names the trigger behind each value where the triggers pin different ones', () => {
		const config = withTimeoutTriggers([pinned45m('!to'), { string: '!to2h', args: '{{arg1}} 2h' }])
		const [, duration] = argsOf('timeout', config, seeds)
		expect(duration.fixed).toEqual([
			{ value: '45m', triggers: ['!to'] },
			{ value: '2h', triggers: ['!to2h'] },
		])
	})
})

describe('triggerGroups', () => {
	it('groups the triggers sharing a template, plain ones first', () => {
		const config = withTimeoutTriggers([pinned45m('!to'), '!timeout', pinned45m('!to45'), '!t'])
		const groups = CMDH.triggerGroups('timeout', config)
		expect(groups.map((g) => g.strings)).toEqual([
			['!timeout', '!t'],
			['!to', '!to45'],
		])
		expect(groups[0].signature).toBe('<player> <duration> [reason|message]')
		expect(groups[1]).toMatchObject({ signature: '<player>', expansion: '!timeout {{arg1}} 45m' })
	})

	it('leaves a shortcut with no plainer trigger to stand for describing what it pins instead', () => {
		const groups = CMDH.triggerGroups('timeout', withTimeoutTriggers([pinned45m('!to')]))
		expect(groups).toEqual([
			{ strings: ['!to'], signature: '<player>', pins: [{ name: 'duration', value: '45m' }], expansion: undefined },
		])
	})
})

describe('resolveHelpListing', () => {
	it('lists only quick-reference commands when no section is given', () => {
		const listing = CMDH.resolveHelpListing(configs, undefined)
		expect(listing.code).toBe('ok')
		if (listing.code !== 'ok') return
		expect(listing.commands).toContain('help')
		expect(listing.commands.every((id) => configs[id].quickReference)).toBe(true)
		expect(listing.commands).not.toContain('clearTimeout')
	})

	it('lists every enabled command for the "all" token', () => {
		const listing = CMDH.resolveHelpListing(withConfig('kick', { enabled: false }), 'all')
		if (listing.code !== 'ok') throw new Error('expected ok')
		expect(listing.commands).toContain('clearTimeout')
		expect(listing.commands).not.toContain('kick')
	})

	it('resolves a section by id or by label, case-insensitively', () => {
		const byId = CMDH.resolveHelpListing(configs, 'moderation')
		const byLabel = CMDH.resolveHelpListing(configs, 'Player Flags')
		if (byId.code !== 'ok' || byLabel.code !== 'ok') throw new Error('expected ok')
		expect(byId.commands).toContain('kick')
		expect(byId.commands).not.toContain('swapNow')
		expect(byLabel.commands).toEqual(['flag', 'removeFlag', 'listFlags'])
	})

	it('advertises sections by id, never by a label that could not be typed', () => {
		// `section` is a single-token arg, so "Player Flags" would never match -- only `flags` can be advised
		const listing = CMDH.resolveHelpListing(configs, 'zzzzzzzz')
		expect(listing.code).toBe('err:unknown-section')
		if (listing.code !== 'err:unknown-section') return
		const msg = I18n.ambient.text(listing.msg)
		expect(msg).toContain('flags')
		expect(msg).toContain('all')
		expect(msg).not.toContain('Player Flags')
	})

	it('offers the section a shortening was aiming at, instead of listing every one', () => {
		const listing = CMDH.resolveHelpListing(configs, 'mod')
		expect(listing.code).toBe('err:unknown-section')
		if (listing.code !== 'err:unknown-section') return
		expect(listing.choices).toEqual([{ tokens: ['moderation'], label: 'moderation' }])
		expect(I18n.ambient.text(listing.msg)).not.toContain('teamswaps')
	})

	it('trails the quick reference with a hint naming the single-token sections', () => {
		const listing = CMDH.resolveHelpListing(configs, undefined)
		if (listing.code !== 'ok') throw new Error('expected ok')
		expect(I18n.ambient.text(listing.title)).toBe('Commands')
		expect(I18n.ambient.text(listing.hint!)).toBe(
			`More: ${P}help <section> -- general, votes, layerRequests, teamswaps, flags, moderation, messaging, all`,
		)
	})

	// a shortcut trigger is the same command, so it is listed with it rather than separately -- and a disabled
	// command takes its shortcuts out of the listing with it
	it('lists a command with shortcut triggers once, under its own section', () => {
		const withShortcut = withConfig('kick', { triggers: [...configs.kick.triggers, { string: '!tox', args: '{{arg1}} toxicity' }] })
		const listing = CMDH.resolveHelpListing(withShortcut, 'moderation')
		if (listing.code !== 'ok') throw new Error('expected ok')
		expect(listing.commands.filter((id) => id === 'kick')).toEqual(['kick'])

		const disabled = CMDH.resolveHelpListing(withConfig('kick', { ...withShortcut.kick, enabled: false }), 'moderation')
		if (disabled.code !== 'ok') throw new Error('expected ok')
		expect(disabled.commands).not.toContain('kick')
	})
})
