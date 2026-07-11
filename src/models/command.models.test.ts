import type * as AAR from '@/models/admin-action-reasons.models'
import * as CMD from '@/models/command.models'
import { describe, expect, it } from 'vitest'

const noPreds: CMD.AssignPredicates = { isTeamToken: () => false, isPresetToken: () => false }
const preds = (opts: { teams?: string[]; presets?: string[] }): CMD.AssignPredicates => ({
	isTeamToken: t => (opts.teams ?? []).includes(t),
	isPresetToken: (_a, t) => (opts.presets ?? []).includes(t),
})

function reason(label: string, opts: Partial<AAR.AdminActionReason> = {}): AAR.AdminActionReason {
	return { label, message: `${label} message`, aliases: [], actionTexts: {}, ...opts }
}

describe('assignArgTokens', () => {
	it('enforces required single-token args and allows optional ones', () => {
		const args = [{ kind: 'player', name: 'player' }, { kind: 'string', name: 'flag', optional: true }] as const
		expect(CMD.assignArgTokens(args, [], noPreds)).toEqual({ code: 'err:missing-arg', argName: 'player' })
		expect(CMD.assignArgTokens(args, ['bob'], noPreds)).toEqual({
			code: 'ok',
			windows: { player: ['bob'], flag: undefined },
		})
	})

	it('captures the remainder for rest args and enforces required rest', () => {
		const args = [{ kind: 'player', name: 'player' }, { kind: 'reason', name: 'reason', action: 'warn' }] as const
		expect(CMD.assignArgTokens(args, ['bob'], noPreds)).toEqual({ code: 'err:missing-arg', argName: 'reason' })
		expect(CMD.assignArgTokens(args, ['bob', 'stop', 'that'], noPreds)).toEqual({
			code: 'ok',
			windows: { player: ['bob'], reason: ['stop', 'that'] },
		})
	})

	describe('squad windows', () => {
		const disbandArgs = [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'preset-reason', name: 'reason', action: 'disband-squad', optional: true },
		] as const
		const p = preds({ teams: ['1', '2', 'A', 'B'], presets: ['afk', 'tk'] })

		it.each([
			[['3'], { squad: ['3'], reason: undefined }],
			[['2', '3'], { squad: ['2', '3'], reason: undefined }],
			[['2', 'afk'], { squad: ['2'], reason: ['afk'] }],
			[['afkers', 'tk'], { squad: ['afkers'], reason: ['tk'] }],
			[['A', 'cmd', 'afk'], { squad: ['A', 'cmd'], reason: ['afk'] }],
		])('disband %j', (tokens, windows) => {
			expect(CMD.assignArgTokens(disbandArgs, tokens as string[], p)).toEqual({ code: 'ok', windows })
		})

		it('a bare number followed by a non-squad token is a current-team squad; the rest is the reason', () => {
			// "2" is a squad on the caller's team, "afq" (typo'd preset) is the reason -> did-you-mean later
			expect(CMD.assignArgTokens(disbandArgs, ['2', 'afq'], p)).toEqual({ code: 'ok', windows: { squad: ['2'], reason: ['afq'] } })
		})

		it('kicksquad (squad + duration + reason) keeps the duration out of the squad window', () => {
			const kickSquadArgs = [
				{ kind: 'squad', name: 'squad' },
				{ kind: 'duration', name: 'duration' },
				{ kind: 'reason', name: 'reason', action: 'kick', optional: true },
			] as const
			// a lone squad number + duration: "2" is the squad on the caller's team, "2h" is the duration
			expect(CMD.assignArgTokens(kickSquadArgs, ['2', '2h', 'tk'], p)).toEqual({
				code: 'ok',
				windows: { squad: ['2'], duration: ['2h'], reason: ['tk'] },
			})
			// explicit team + squad + duration + reason
			expect(CMD.assignArgTokens(kickSquadArgs, ['2', '3', '2h', 'stop', 'it'], p)).toEqual({
				code: 'ok',
				windows: { squad: ['2', '3'], duration: ['2h'], reason: ['stop', 'it'] },
			})
		})

		it('with a trailing rest reason, only pairs a leading team with a squad-like second token', () => {
			const warnSquadArgs = [{ kind: 'squad', name: 'squad' }, { kind: 'reason', name: 'reason', action: 'warn' }] as const
			// team + numeric squad -> pair
			expect(CMD.assignArgTokens(warnSquadArgs, ['2', '3', 'tk'], p)).toEqual({
				code: 'ok',
				windows: { squad: ['2', '3'], reason: ['tk'] },
			})
			// a lone number is a squad on the caller's team; the rest is the reason
			expect(CMD.assignArgTokens(warnSquadArgs, ['2', 'tk'], p)).toEqual({
				code: 'ok',
				windows: { squad: ['2'], reason: ['tk'] },
			})
			// team letter + numeric squad -> pair
			expect(CMD.assignArgTokens(warnSquadArgs, ['A', '3', 'get', 'moving'], p)).toEqual({
				code: 'ok',
				windows: { squad: ['A', '3'], reason: ['get', 'moving'] },
			})
			expect(CMD.assignArgTokens(warnSquadArgs, ['afkers', 'get', 'moving'], p)).toEqual({
				code: 'ok',
				windows: { squad: ['afkers'], reason: ['get', 'moving'] },
			})
		})
	})
})

describe('coerceIntArg', () => {
	it('accepts integers and rejects everything else', () => {
		expect(CMD.coerceIntArg('n', '-12')).toEqual({ code: 'ok', value: -12 })
		expect(CMD.coerceIntArg('n', '2.1').code).toBe('err:invalid-int')
		expect(CMD.coerceIntArg('n', 'x').code).toBe('err:invalid-int')
	})
})

describe('resolveDurationArg', () => {
	it('accepts HumanTime tokens and resolves to ms', () => {
		expect(CMD.resolveDurationArg('duration', '2h')).toEqual({ code: 'ok', value: 2 * 60 * 60 * 1000 })
		expect(CMD.resolveDurationArg('duration', '30m')).toEqual({ code: 'ok', value: 30 * 60 * 1000 })
		expect(CMD.resolveDurationArg('duration', '1.5h')).toEqual({ code: 'ok', value: 1.5 * 60 * 60 * 1000 })
		expect(CMD.resolveDurationArg('duration', '500ms')).toEqual({ code: 'ok', value: 500 })
	})

	it('rejects non-durations', () => {
		expect(CMD.resolveDurationArg('duration', '2x').code).toBe('err:invalid-duration')
		expect(CMD.resolveDurationArg('duration', 'h').code).toBe('err:invalid-duration')
		expect(CMD.resolveDurationArg('duration', '120').code).toBe('err:invalid-duration')
	})
})

describe('kick arg windows', () => {
	const kickArgs = CMD.COMMAND_DECLARATIONS.kick.args

	it('splits player, duration and reason tail', () => {
		expect(CMD.assignArgTokens(kickArgs, ['bob', '2h', 'tk'], noPreds)).toEqual({
			code: 'ok',
			windows: { player: ['bob'], duration: ['2h'], reason: ['tk'] },
		})
		expect(CMD.assignArgTokens(kickArgs, ['bob', '2h', 'stop', 'that'], noPreds)).toEqual({
			code: 'ok',
			windows: { player: ['bob'], duration: ['2h'], reason: ['stop', 'that'] },
		})
	})

	it('reason is optional but player and duration are required', () => {
		expect(CMD.assignArgTokens(kickArgs, ['bob', '2h'], noPreds)).toEqual({
			code: 'ok',
			windows: { player: ['bob'], duration: ['2h'], reason: undefined },
		})
		expect(CMD.assignArgTokens(kickArgs, ['bob'], noPreds)).toEqual({ code: 'err:missing-arg', argName: 'duration' })
	})
})

describe('resolveReasonArg', () => {
	const reasons = [
		reason('Teamkilling', { aliases: ['tk'], actionTexts: { kick: 'tk kick text' } }),
		reason('AFK'),
	]

	it('one token resolves a preset by label or alias', () => {
		const res = CMD.resolveReasonArg(reasons, 'warn', ['TK'])
		expect(res.code).toBe('ok')
		if (res.code === 'ok') expect(res.value).toEqual({ type: 'preset', reason: reasons[0] })
	})

	it('one unknown token errors with a did-you-mean suggestion and lists available reasons', () => {
		const res = CMD.resolveReasonArg(reasons, 'warn', ['tq'])
		expect(res.code).toBe('err:unknown-preset')
		if (res.code === 'err:unknown-preset') {
			expect(res.msg).toContain('Did you mean tk?')
			expect(res.msg).toContain('Available:')
		}
	})

	it('a real reason that is not set up for the action gets a distinct message', () => {
		// AFK only has warn text, so it is not available for kick
		const res = CMD.resolveReasonArg(reasons, 'kick', ['AFK'])
		expect(res.code).toBe('err:unknown-preset')
		if (res.code === 'err:unknown-preset') {
			expect(res.msg).toContain("isn't set up for Kick")
			expect(res.msg).not.toContain('Unknown reason')
		}
	})

	it('two or more tokens are a custom message, verbatim', () => {
		expect(CMD.resolveReasonArg(reasons, 'warn', ['tk', 'seriously'])).toEqual({
			code: 'ok',
			value: { type: 'custom', text: 'tk seriously' },
		})
	})
})

describe('resolveBroadcastArg', () => {
	const presets = [{ label: 'Seeding', message: 'seeding rules...', aliases: ['seed'] }]

	it('one token = preset only, multi-token = verbatim', () => {
		const one = CMD.resolveBroadcastArg(presets, ['seed'])
		expect(one.code).toBe('ok')
		if (one.code === 'ok') expect(one.value.type).toBe('preset')
		expect(CMD.resolveBroadcastArg(presets, ['sed']).code).toBe('err:unknown-preset')
		expect(CMD.resolveBroadcastArg(presets, ['hello', 'all'])).toEqual({
			code: 'ok',
			value: { type: 'custom', text: 'hello all' },
		})
	})
})

describe('usage strings', () => {
	it('formats signatures per kind', () => {
		expect(CMD.formatArgSignature(CMD.COMMAND_DECLARATIONS.warn.args)).toBe('<player> <reason|message>')
		expect(CMD.formatArgSignature(CMD.COMMAND_DECLARATIONS.kill.args)).toBe('<player> [reason|message]')
		expect(CMD.formatArgSignature(CMD.COMMAND_DECLARATIONS.disbandSquad.args)).toBe('[team] <squad> [reason]')
		expect(CMD.formatArgSignature(CMD.COMMAND_DECLARATIONS.broadcast.args)).toBe('<preset|message>')
	})

	it('formatUsage uses the first configured string', () => {
		const usage = CMD.formatUsage('warn', { strings: ['warn'], scopes: ['admin'], enabled: true }, '!')
		expect(usage).toBe('Usage: !warn <player> <reason|message>')
	})
})
