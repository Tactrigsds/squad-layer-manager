import type * as AAR from '@/models/admin-action-reasons.models'
import * as CMDH from '@/models/command-help.models'
import * as CMD from '@/models/command.models'
import { describe, expect, it } from 'vitest'

function reason(label: string, actions: AAR.AdminActionType[]): AAR.AdminActionReason {
	return { label, aliases: [], actionTexts: Object.fromEntries(actions.map((a) => [a, `${label} text`])) }
}

const seeds: CMDH.ExampleSeeds = {
	reasons: [reason('toxicity', ['warn', 'kick', 'timeout']), reason('teamkilling', ['warn'])],
	broadcasts: [{ label: 'restart', aliases: [], message: 'Server restarting' }],
}
const noSeeds: CMDH.ExampleSeeds = { reasons: [], broadcasts: [] }

// the real configs, with every command's declared strings under the fallback prefix
const configs = CMD.seedCommandConfigs({}, CMD.FALLBACK_PREFIX) as unknown as CMD.CommandConfigs

function withConfig(id: CMD.CommandId, patch: Partial<CMD.CommandConfig>): CMD.CommandConfigs {
	return { ...configs, [id]: { ...configs[id], ...patch } }
}

describe('buildExamples', () => {
	it('gives an argless command exactly one example', () => {
		expect(CMDH.buildExamples('swaps', configs.swaps, seeds)).toEqual([{ command: '!swaps', note: 'Run it' }])
	})

	it('escalates from the required args to each optional one, then the free-text form', () => {
		// timeout is <player> <duration> [reason], and reason has both a preset and a custom form
		expect(CMDH.buildExamples('timeout', configs.timeout, seeds)).toEqual([
			{ command: '!timeout Alice 2h', note: 'The shortest form' },
			{ command: '!timeout Alice 2h toxicity', note: 'With reason' },
			{ command: '!timeout Alice 2h stop doing that', note: 'With a custom reason' },
		])
	})

	it('fills reason args from the configured reasons applicable to the action', () => {
		// teamkilling is warn-only, so kick must not offer it
		const [, withReason] = CMDH.buildExamples('kick', configs.kick, seeds)
		expect(withReason.command).toBe('!kick Alice toxicity')
	})

	it('omits the preset example when the installation has no applicable reasons configured', () => {
		expect(CMDH.buildExamples('kick', configs.kick, noSeeds)).toEqual([
			{ command: '!kick Alice', note: 'The shortest form' },
			{ command: '!kick Alice stop doing that', note: 'With a custom reason' },
		])
	})

	it('treats a reason as required when the installation requires one for that action', () => {
		const examples = CMDH.buildExamples('kick', configs.kick, seeds, ['kick'])
		expect(examples[0]).toEqual({ command: '!kick Alice toxicity', note: 'The shortest form' })
		expect(examples.every((e) => e.command !== '!kick Alice')).toBe(true)
	})

	it('picks a preset by a single-token alias when its label has whitespace', () => {
		// a two-word label typed verbatim would be read as a custom reason, not this preset, so the example has to
		// reach it by its alias
		const multiWord: CMDH.ExampleSeeds = {
			...seeds,
			reasons: [{ ...reason('No SLKit', ['warn']), aliases: ['slkit'] }],
		}
		expect(CMDH.buildExamples('warn', configs.warn, multiWord)[0].command).toBe('!warn Alice slkit')
	})

	it('skips the preset example when no configured preset can be named in one token', () => {
		const unreachable: CMDH.ExampleSeeds = { ...seeds, reasons: [reason('No SLKit', ['warn'])] }
		// warn's reason is required, so the preset form is the shortest one -- and it has to fall away entirely
		expect(CMDH.buildExamples('warn', configs.warn, unreachable)).toEqual([
			{ command: '!warn Alice stop doing that', note: 'With a custom reason' },
		])
	})

	it('uses the declared sample token for string args', () => {
		expect(CMDH.buildExamples('flag', configs.flag, seeds)[0].command).toBe('!flag Alice cheater')
	})

	it('follows the command string an admin actually configured', () => {
		expect(CMDH.buildExamples('swaps', { ...configs.swaps, strings: ['.showswaps'] }, seeds)[0].command).toBe('.showswaps')
	})
})

describe('describeArgs', () => {
	it('lists the configured presets a reason arg accepts, scoped to its action', () => {
		const [, reasonArg] = CMDH.describeArgs('warn', seeds)
		expect(reasonArg.presets).toEqual(['toxicity', 'teamkilling'])
		expect(CMDH.describeArgs('kick', seeds)[1].presets).toEqual(['toxicity'])
	})

	it('prepends the per-arg note to its kind description', () => {
		const [flagArg] = CMDH.describeArgs('listFlags', seeds)
		expect(flagArg.description).toContain('Lists every flag in the organization when omitted.')
		expect(flagArg.description).toContain(CMDH.ARG_KIND_HELP.player.description)
	})
})

describe('resolveHelpListing', () => {
	it('lists only quick-reference commands when no section is given', () => {
		const listing = CMDH.resolveHelpListing(configs, [], undefined)
		expect(listing.code).toBe('ok')
		if (listing.code !== 'ok') return
		expect(listing.commands).toContain('help')
		expect(listing.commands.every((id) => configs[id].quickReference)).toBe(true)
		expect(listing.commands).not.toContain('clearTimeout')
	})

	it('lists every enabled command for the "all" token', () => {
		const listing = CMDH.resolveHelpListing(withConfig('kick', { enabled: false }), [], 'all')
		if (listing.code !== 'ok') throw new Error('expected ok')
		expect(listing.commands).toContain('clearTimeout')
		expect(listing.commands).not.toContain('kick')
	})

	it('resolves a section by id or by label, case-insensitively', () => {
		const byId = CMDH.resolveHelpListing(configs, [], 'moderation')
		const byLabel = CMDH.resolveHelpListing(configs, [], 'Player Flags')
		if (byId.code !== 'ok' || byLabel.code !== 'ok') throw new Error('expected ok')
		expect(byId.commands).toContain('kick')
		expect(byId.commands).not.toContain('swapNow')
		expect(byLabel.commands).toEqual(['flag', 'removeFlag', 'listFlags'])
	})

	it('advertises sections by id, never by a label that could not be typed', () => {
		// `section` is a single-token arg, so "Player Flags" would never match -- only `flags` can be advised
		const listing = CMDH.resolveHelpListing(configs, [], 'nonsense')
		expect(listing.code).toBe('err:unknown-section')
		if (listing.code !== 'err:unknown-section') return
		expect(listing.msg).toContain('flags')
		expect(listing.msg).toContain('all')
		expect(listing.msg).not.toContain('Player Flags')
	})

	it('trails the quick reference with a hint naming the single-token sections', () => {
		const listing = CMDH.resolveHelpListing(configs, [], undefined)
		if (listing.code !== 'ok') throw new Error('expected ok')
		expect(listing.title).toBe('Commands')
		expect(listing.hint).toBe('More: !help <section> -- general, votes, teamswaps, flags, moderation, messaging, all')
	})

	it("lists an alias under its target command's section, and drops it when the target is disabled", () => {
		const aliases = [{ alias: '!tox', command: '!kick Alice toxicity' }]
		const listing = CMDH.resolveHelpListing(configs, aliases, 'moderation')
		if (listing.code !== 'ok') throw new Error('expected ok')
		expect(listing.aliases).toEqual(aliases)

		const disabled = CMDH.resolveHelpListing(withConfig('kick', { enabled: false }), aliases, 'moderation')
		if (disabled.code !== 'ok') throw new Error('expected ok')
		expect(disabled.aliases).toEqual([])
	})
})
