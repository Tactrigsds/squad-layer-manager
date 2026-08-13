import { describe, expect, it } from 'vitest'

import type * as AAR from '@/models/admin-action-reasons.models'
import * as CMD from '@/models/command.models'

const noPreds: CMD.AssignPredicates = { isTeamToken: () => false, isPresetToken: () => false }
const preds = (opts: { teams?: string[]; presets?: string[] }): CMD.AssignPredicates => ({
	isTeamToken: (t) => (opts.teams ?? []).includes(t),
	isPresetToken: (_a, t) => (opts.presets ?? []).includes(t),
})

function reason(label: string, opts: Partial<AAR.AdminActionReason> = {}): AAR.AdminActionReason {
	return { label, keywords: [label.toLowerCase()], actionTexts: { warn: `${label} warn text` }, ...opts }
}

describe('assignArgTokens', () => {
	it('enforces required single-token args and allows optional ones', () => {
		const args = [
			{ kind: 'player', name: 'player' },
			{ kind: 'string', name: 'flag', optional: true },
		] as const
		expect(CMD.assignArgTokens(args, [], noPreds)).toEqual({ code: 'err:missing-arg', argName: 'player' })
		expect(CMD.assignArgTokens(args, ['bob'], noPreds)).toEqual({
			code: 'ok',
			windows: { player: ['bob'], flag: undefined },
			ranges: { player: { start: 0, len: 1 } },
		})
	})

	it('captures the remainder for rest args and enforces required rest', () => {
		const args = [
			{ kind: 'player', name: 'player' },
			{ kind: 'reason', name: 'reason', action: 'warn' },
		] as const
		expect(CMD.assignArgTokens(args, ['bob'], noPreds)).toEqual({ code: 'err:missing-arg', argName: 'reason' })
		expect(CMD.assignArgTokens(args, ['bob', 'stop', 'that'], noPreds)).toEqual({
			code: 'ok',
			windows: { player: ['bob'], reason: ['stop', 'that'] },
			ranges: { player: { start: 0, len: 1 }, reason: { start: 1, len: 2 } },
		})
	})

	describe('squad windows', () => {
		const disbandArgs = [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'preset-reason', name: 'reason', action: 'disband-squad', optional: true },
		] as const
		const p = preds({ teams: ['1', '2', 'A', 'B'], presets: ['afk', 'tk'] })

		it.each([
			[['3'], { squad: ['3'], reason: undefined }, { squad: { start: 0, len: 1 } }],
			[['2', '3'], { squad: ['2', '3'], reason: undefined }, { squad: { start: 0, len: 2 } }],
			[['2', 'afk'], { squad: ['2'], reason: ['afk'] }, { squad: { start: 0, len: 1 }, reason: { start: 1, len: 1 } }],
			[['afkers', 'tk'], { squad: ['afkers'], reason: ['tk'] }, { squad: { start: 0, len: 1 }, reason: { start: 1, len: 1 } }],
			[['A', 'cmd', 'afk'], { squad: ['A', 'cmd'], reason: ['afk'] }, { squad: { start: 0, len: 2 }, reason: { start: 2, len: 1 } }],
		])('disband %j', (tokens, windows, ranges) => {
			expect(CMD.assignArgTokens(disbandArgs, tokens as string[], p)).toEqual({ code: 'ok', windows, ranges })
		})

		it('a bare number followed by a non-squad token is a current-team squad; the rest is the reason', () => {
			// "2" is a squad on the caller's team, "afq" (typo'd preset) is the reason -> did-you-mean later
			expect(CMD.assignArgTokens(disbandArgs, ['2', 'afq'], p)).toEqual({
				code: 'ok',
				windows: { squad: ['2'], reason: ['afq'] },
				ranges: { squad: { start: 0, len: 1 }, reason: { start: 1, len: 1 } },
			})
		})

		it('timeoutsquad (squad + duration + reason) keeps the duration out of the squad window', () => {
			const timeoutSquadArgs = CMD.COMMAND_DECLARATIONS.timeoutSquad.args
			// a lone squad number + duration: "2" is the squad on the caller's team, "2h" is the duration
			expect(CMD.assignArgTokens(timeoutSquadArgs, ['2', '2h', 'tk'], p)).toEqual({
				code: 'ok',
				windows: { squad: ['2'], duration: ['2h'], reason: ['tk'] },
				ranges: { squad: { start: 0, len: 1 }, duration: { start: 1, len: 1 }, reason: { start: 2, len: 1 } },
			})
			// explicit team + squad + duration + reason
			expect(CMD.assignArgTokens(timeoutSquadArgs, ['2', '3', '2h', 'stop', 'it'], p)).toEqual({
				code: 'ok',
				windows: { squad: ['2', '3'], duration: ['2h'], reason: ['stop', 'it'] },
				ranges: { squad: { start: 0, len: 2 }, duration: { start: 2, len: 1 }, reason: { start: 3, len: 2 } },
			})
		})

		it('with a trailing rest reason, only pairs a leading team with a squad-like second token', () => {
			const warnSquadArgs = [
				{ kind: 'squad', name: 'squad' },
				{ kind: 'reason', name: 'reason', action: 'warn' },
			] as const
			// team + numeric squad -> pair
			expect(CMD.assignArgTokens(warnSquadArgs, ['2', '3', 'tk'], p)).toEqual({
				code: 'ok',
				windows: { squad: ['2', '3'], reason: ['tk'] },
				ranges: { squad: { start: 0, len: 2 }, reason: { start: 2, len: 1 } },
			})
			// a lone number is a squad on the caller's team; the rest is the reason
			expect(CMD.assignArgTokens(warnSquadArgs, ['2', 'tk'], p)).toEqual({
				code: 'ok',
				windows: { squad: ['2'], reason: ['tk'] },
				ranges: { squad: { start: 0, len: 1 }, reason: { start: 1, len: 1 } },
			})
			// team letter + numeric squad -> pair
			expect(CMD.assignArgTokens(warnSquadArgs, ['A', '3', 'get', 'moving'], p)).toEqual({
				code: 'ok',
				windows: { squad: ['A', '3'], reason: ['get', 'moving'] },
				ranges: { squad: { start: 0, len: 2 }, reason: { start: 2, len: 2 } },
			})
			expect(CMD.assignArgTokens(warnSquadArgs, ['afkers', 'get', 'moving'], p)).toEqual({
				code: 'ok',
				windows: { squad: ['afkers'], reason: ['get', 'moving'] },
				ranges: { squad: { start: 0, len: 1 }, reason: { start: 1, len: 2 } },
			})
		})
	})
})

describe('near misses', () => {
	describe('splicing picks back over the caller"s words', () => {
		const p = preds({ teams: ['1', '2', 'A', 'B'], presets: ['tk'] })
		const warnSquadArgs = [
			{ kind: 'squad', name: 'squad' },
			{ kind: 'reason', name: 'reason', action: 'warn' },
		] as const

		// a squad picked as "<team> <squad>" is two words where one was typed, so splicing left to right would
		// misplace every range after it
		it('a pick may be wider than the window it replaces, and later args keep their own', () => {
			const tokens = ['alpha', 'tq']
			const assigned = CMD.assignArgTokens(warnSquadArgs, tokens, p)
			if (assigned.code !== 'ok') throw new Error(assigned.code)
			const spliced = CMD.spliceArgTokens(tokens, [
				{ range: assigned.ranges.squad!, tokens: ['1', '3'] },
				{ range: assigned.ranges.reason!, tokens: ['tk'] },
			])
			expect(spliced).toEqual(['1', '3', 'tk'])
		})

		it('a spliced pick re-assigns to the argument it answered for', () => {
			const spliced = ['1', '3', 'tk']
			expect(CMD.assignArgTokens(warnSquadArgs, spliced, p)).toEqual({
				code: 'ok',
				windows: { squad: ['1', '3'], reason: ['tk'] },
				ranges: { squad: { start: 0, len: 2 }, reason: { start: 2, len: 1 } },
			})
		})

		it('leaves the words nobody was asked about alone', () => {
			const tokens = ['alise', '2h', 'stop', 'that']
			const assigned = CMD.assignArgTokens(CMD.COMMAND_DECLARATIONS.timeout.args, tokens, noPreds)
			if (assigned.code !== 'ok') throw new Error(assigned.code)
			expect(CMD.spliceArgTokens(tokens, [{ range: assigned.ranges.player!, tokens: ['76561198000000009'] }])).toEqual([
				'76561198000000009',
				'2h',
				'stop',
				'that',
			])
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

describe('kick and timeout arg windows', () => {
	const kickArgs = CMD.COMMAND_DECLARATIONS.kick.args
	const timeoutArgs = CMD.COMMAND_DECLARATIONS.timeout.args

	it('a kick takes no duration: everything after the player is the reason', () => {
		expect(CMD.assignArgTokens(kickArgs, ['bob', 'stop', 'that'], noPreds)).toEqual({
			code: 'ok',
			windows: { player: ['bob'], reason: ['stop', 'that'] },
			ranges: { player: { start: 0, len: 1 }, reason: { start: 1, len: 2 } },
		})
		expect(CMD.assignArgTokens(kickArgs, ['bob'], noPreds)).toEqual({
			code: 'ok',
			windows: { player: ['bob'], reason: undefined },
			ranges: { player: { start: 0, len: 1 } },
		})
		expect(CMD.assignArgTokens(kickArgs, [], noPreds)).toEqual({ code: 'err:missing-arg', argName: 'player' })
	})

	it('a timeout splits player, duration and reason tail', () => {
		expect(CMD.assignArgTokens(timeoutArgs, ['bob', '2h', 'tk'], noPreds)).toEqual({
			code: 'ok',
			windows: { player: ['bob'], duration: ['2h'], reason: ['tk'] },
			ranges: { player: { start: 0, len: 1 }, duration: { start: 1, len: 1 }, reason: { start: 2, len: 1 } },
		})
		expect(CMD.assignArgTokens(timeoutArgs, ['bob', '2h', 'stop', 'that'], noPreds)).toEqual({
			code: 'ok',
			windows: { player: ['bob'], duration: ['2h'], reason: ['stop', 'that'] },
			ranges: { player: { start: 0, len: 1 }, duration: { start: 1, len: 1 }, reason: { start: 2, len: 2 } },
		})
	})

	it('a timeout reason is optional but its player and duration are required', () => {
		expect(CMD.assignArgTokens(timeoutArgs, ['bob', '2h'], noPreds)).toEqual({
			code: 'ok',
			windows: { player: ['bob'], duration: ['2h'], reason: undefined },
			ranges: { player: { start: 0, len: 1 }, duration: { start: 1, len: 1 } },
		})
		expect(CMD.assignArgTokens(timeoutArgs, ['bob'], noPreds)).toEqual({ code: 'err:missing-arg', argName: 'duration' })
	})
})

describe('resolveReasonArg', () => {
	const reasons = [reason('Teamkilling', { keywords: ['tk'], actionTexts: { warn: 'tk warn text', kick: 'tk kick text' } }), reason('AFK')]

	it('one token resolves a preset by label or alias', () => {
		const res = CMD.resolveReasonArg(reasons, 'warn', ['TK'])
		expect(res.code).toBe('ok')
		if (res.code === 'ok') expect(res.value).toEqual({ type: 'preset', reason: reasons[0] })
	})

	it('one unknown token errors, leaving the suggesting to the choices', () => {
		const res = CMD.resolveReasonArg(reasons, 'warn', ['tq'])
		expect(res.code).toBe('err:unknown-preset')
		if (res.code === 'err:unknown-preset') {
			expect(res.msg).toContain('Unknown reason "tq"')
			expect(res.msg).not.toContain('Available:')
		}
	})

	it('lists the available reasons when nothing is close enough to offer', () => {
		const res = CMD.resolveReasonArg(reasons, 'warn', ['sdfghj'])
		expect(res.code).toBe('err:unknown-preset')
		if (res.code === 'err:unknown-preset') {
			expect(res.choices).toEqual([])
			expect(res.msg).toContain('Available:')
		}
	})

	it('an unknown token offers the closest reasons to pick from', () => {
		const res = CMD.resolveReasonArg(reasons, 'warn', ['tq'])
		expect(res.code).toBe('err:unknown-preset')
		if (res.code === 'err:unknown-preset') expect(res.choices).toEqual([{ tokens: ['tk'], label: 'Teamkilling (tk)' }])
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

describe('usage strings', () => {
	it('formats signatures per kind', () => {
		expect(CMD.formatArgSignature(CMD.COMMAND_DECLARATIONS.warn.args)).toBe('<player> <reason|message>')
		expect(CMD.formatArgSignature(CMD.COMMAND_DECLARATIONS.kill.args)).toBe('<player> [reason|message]')
		expect(CMD.formatArgSignature(CMD.COMMAND_DECLARATIONS.disbandSquad.args)).toBe('[team] <squad> [reason|message]')
		expect(CMD.formatArgSignature(CMD.COMMAND_DECLARATIONS.broadcast.args)).toBe('<reason|message>')
		// requireReasonFor forces an otherwise-optional reason arg to render as required
		expect(CMD.formatArgSignature(CMD.COMMAND_DECLARATIONS.kill.args, ['kill'])).toBe('<player> <reason|message>')
	})

	it('formatUsage uses the primary trigger', () => {
		const usage = CMD.formatUsage('warn', { triggers: ['!warn'], allowedChats: ['admin'], enabled: true, quickReference: false })
		expect(usage).toBe('Usage: !warn <player> <reason|message>')
	})

	// a trigger that pins arguments is a shortcut, so the command is named by a plain one
	it('formatUsage skips a trigger with pinned args when picking the primary', () => {
		const config: CMD.CommandConfig = {
			triggers: [{ string: '!warnsp', args: '{{arg1}} spam' }, '!warn'],
			allowedChats: ['admin'],
			enabled: true,
			quickReference: false,
		}
		expect(CMD.formatUsage('warn', config)).toBe('Usage: !warn <player> <reason|message>')
		expect(CMD.formatUsage('warn', config, config.triggers[0])).toBe('Usage: !warnsp <player>')
	})
})

describe('seedCommandConfigs', () => {
	it('seeds missing commands with prefixed default triggers and leaves stored ones alone', () => {
		const stored = { warn: { triggers: ['/w'], allowedChats: ['admin'], enabled: false } }
		const seeded = CMD.seedCommandConfigs(stored, '/')
		expect(seeded.warn).toEqual(stored.warn)
		expect(seeded.help).toEqual({ triggers: ['/help', '/h'], allowedChats: ['admin'], enabled: true, quickReference: true })
		expect(Object.keys(seeded).sort()).toEqual(Object.keys(CMD.COMMAND_DECLARATIONS).sort())
	})

	it('prefixes every declared trigger', () => {
		const seeded = CMD.seedCommandConfigs({}, '/') as Record<string, CMD.CommandConfig>
		expect(seeded.timeout.triggers).toEqual(['/timeout', '/to'])
	})
})

describe('parseCommand', () => {
	const configs = CMD.seedCommandConfigs({}, '!') as unknown as CMD.CommandConfigs
	const withTrigger = (id: CMD.CommandId, trigger: CMD.CommandTrigger): CMD.CommandConfigs => ({
		...configs,
		[id]: { ...configs[id], triggers: [...configs[id].triggers, trigger] },
	})
	const msg = (message: string) => ({ message, channelType: 'ChatAdmin' }) as any
	const prefixes = [{ prefix: '!', replyToUnknown: true }]

	it('passes the words through for a plain trigger', () => {
		expect(CMD.parseCommand(msg('!timeout Alice 2h griefing hard'), configs, prefixes)).toMatchObject({
			code: 'ok',
			cmd: 'timeout',
			tokens: ['Alice', '2h', 'griefing', 'hard'],
		})
	})

	// what a command alias used to do, now reached without a second lookup or a precedence rule
	it('feeds the words through a trigger that pins arguments', () => {
		const cfgs = withTrigger('timeout', { string: '!to2h', args: '{{arg1}} 2h {{rest2}}' })
		expect(CMD.parseCommand(msg('!to2h Alice spamming chat'), cfgs, prefixes)).toMatchObject({
			code: 'ok',
			cmd: 'timeout',
			tokens: ['Alice', '2h', 'spamming', 'chat'],
		})
		expect(CMD.parseCommand(msg('!to2h Alice'), cfgs, prefixes)).toMatchObject({ code: 'ok', tokens: ['Alice', '2h'] })
	})

	it('matches triggers case-insensitively and tolerates surrounding whitespace', () => {
		expect(CMD.parseCommand(msg('  !TIMEOUT   Alice  2h  '), configs, prefixes)).toMatchObject({ code: 'ok', cmd: 'timeout' })
	})

	it('suggests a near miss for an unknown command', () => {
		const res = CMD.parseCommand(msg('!timeuot Alice'), configs, prefixes)
		expect(res.code).toBe('err:unknown-command')
		expect(res.msg).toContain('!timeout')
	})

	// a prefix another bot answers on: its commands are not ours to correct
	it('offers nothing for an unknown command under a prefix that does not reply', () => {
		const res = CMD.parseCommand(msg('!timeuot Alice'), configs, [{ prefix: '!', replyToUnknown: false }])
		expect(res).toEqual({ code: 'err:unknown-command', msg: undefined })
	})
})

describe('argTemplateSignature', () => {
	it('names the placeholder that fills each argument', () => {
		expect(CMD.argTemplateSignature('timeout')).toEqual([
			{ ref: '{{arg1}}', arg: '<player>' },
			{ ref: '{{arg2}}', arg: '<duration>' },
			{ ref: '{{rest3}}', arg: '[reason|message]' },
		])
	})

	it('reflects the configured reason requirement', () => {
		expect(CMD.argTemplateSignature('timeout', ['timeout']).at(-1)).toEqual({ ref: '{{rest3}}', arg: '<reason|message>' })
	})

	it('is empty for a command that takes no arguments', () => {
		expect(CMD.argTemplateSignature('getSlmUpdatesEnabled')).toEqual([])
	})

	// what the settings editor advertises has to be a template an admin can actually save, for every command
	it('produces a template that resolves, for every command', () => {
		for (const id of CMD.COMMAND_IDS) {
			const template = CMD.argTemplateSignature(id)
				.map((p) => p.ref)
				.join(' ')
			const res = CMD.resolveTriggerArgs(id, template)
			expect(res.code, `${id}: ${res.code === 'ok' ? '' : res.msg}`).toBe('ok')
			expect(CMD.argTemplateSignature(id).length, `${id} advertises no placeholders`).toBe(CMD.COMMAND_DECLARATIONS[id].args.length)
		}
	})
})

describe('resolveTriggerArgs', () => {
	// the shape migration 0080 had to drop: the pinned argument sits between two the caller types
	it('maps placeholders onto the args they fill', () => {
		const res = CMD.resolveTriggerArgs('timeout', '{{arg1}} 2h {{rest2}}')
		expect(res.code === 'ok' && res.params.map((p) => [p.ref.name, p.def.name, p.wholeSlot])).toEqual([
			['arg1', 'player', true],
			['rest2', 'reason', true],
		])
	})

	it('reports the args the template fills from its own text', () => {
		const res = CMD.resolveTriggerArgs('timeout', '{{arg1}} 2h')
		// the reason is in neither: the template passes nothing on to it, so nobody can supply one
		expect(res.code === 'ok' && res.pinned).toEqual({ duration: '2h' })
		expect(CMD.resolveTriggerArgs('broadcast', 'Read the rules')).toMatchObject({ pinned: { reason: 'Read the rules' } })
	})

	it('skips the literal token checks for an arg a placeholder fills', () => {
		expect(CMD.resolveTriggerArgs('timeout', '{{arg1}} {{arg2}} {{rest3}}')).toMatchObject({ code: 'ok' })
		expect(CMD.resolveTriggerArgs('removeFromSquad', '{{arg1}} {{rest2}}')).toMatchObject({ code: 'ok' })
	})

	it('still checks literal int and duration tokens', () => {
		expect(CMD.resolveTriggerArgs('timeout', '{{arg1}} notaduration {{rest2}}')).toMatchObject({ code: 'err:invalid-args' })
		expect(CMD.resolveTriggerArgs('removeLayerRequest', 'notanint')).toMatchObject({ code: 'err:invalid-args' })
	})

	it('marks a placeholder that only part-fills an arg', () => {
		const res = CMD.resolveTriggerArgs('broadcast', 'Round ends in {{arg1}} minutes')
		expect(res.code === 'ok' && res.params.map((p) => [p.ref.name, p.def.name, p.wholeSlot])).toEqual([['arg1', 'reason', false]])
	})

	it('rejects an unknown placeholder', () => {
		expect(CMD.resolveTriggerArgs('broadcast', '{{palyer}}')).toMatchObject({ code: 'err:invalid-args' })
		expect(CMD.resolveTriggerArgs('broadcast', '{{arg}}')).toMatchObject({ code: 'err:invalid-args' })
		expect(CMD.resolveTriggerArgs('broadcast', '{{arg0}}')).toMatchObject({ code: 'err:invalid-args' })
	})

	it('rejects a malformed template rather than letting it render unexpanded', () => {
		expect(CMD.resolveTriggerArgs('broadcast', '{{#arg1}}oops')).toMatchObject({ code: 'err:invalid-args' })
	})

	// a multi-word value in a single-word slot would silently shift every argument after it
	it('rejects a rest placeholder in a single-word arg', () => {
		expect(CMD.resolveTriggerArgs('timeout', '{{rest}} 2h')).toMatchObject({ code: 'err:invalid-args' })
	})

	it('rejects a placeholder the command has no argument for', () => {
		expect(CMD.resolveTriggerArgs('startVote', '{{arg1}}')).toMatchObject({ code: 'err:invalid-args' })
	})

	// the caller's first word would be read as arg1's slot and thrown away, and no honest usage could be written
	it('rejects a skipped index', () => {
		expect(CMD.resolveTriggerArgs('broadcast', '{{arg2}}')).toMatchObject({ code: 'err:invalid-args' })
	})

	// referenced only as a condition, so the word it stands for is never actually used
	it('rejects a placeholder that only gates other text', () => {
		expect(CMD.resolveTriggerArgs('broadcast', 'rules {{^arg1}}please{{/arg1}}')).toMatchObject({ code: 'err:invalid-args' })
	})

	it('reports a required arg the template neither pins nor takes', () => {
		expect(CMD.resolveTriggerArgs('timeout', '{{arg1}}')).toMatchObject({ code: 'err:invalid-args' })
	})

	// a plain trigger is NOT sugar for {{rest}}: the analysis models a placeholder as one word, so {{rest}} alone
	// reads as "player only" and leaves <duration> missing. Pass-through has to stay its own state.
	it('does not accept a bare rest template as a stand-in for pass-through', () => {
		expect(CMD.resolveTriggerArgs('timeout', '{{rest}}')).toMatchObject({ code: 'err:invalid-args' })
		expect(CMD.resolveTriggerArgs('broadcast', '{{rest}}')).toMatchObject({ code: 'ok' })
	})
})

describe('expandTriggerArgs', () => {
	it('substitutes single words and the remainder', () => {
		expect(CMD.expandTriggerArgs('{{arg1}} 2h {{rest2}}', ['Alice', 'spamming', 'chat'])).toEqual(['Alice', '2h', 'spamming', 'chat'])
		expect(CMD.expandTriggerArgs('{{rest}}', ['back', 'in', '5'])).toEqual(['back', 'in', '5'])
	})

	// an omitted word leaves no token behind, which is what makes the argument it feeds optional
	it('collapses the gap an omitted word leaves', () => {
		expect(CMD.expandTriggerArgs('{{arg1}} 2h {{rest2}}', ['Alice'])).toEqual(['Alice', '2h'])
		expect(CMD.expandTriggerArgs('{{rest}}', [])).toEqual([])
	})

	it('falls back to an inverted section when the word is omitted', () => {
		const args = '{{arg1}} {{^rest2}}spam{{/rest2}}{{rest2}}'
		expect(CMD.expandTriggerArgs(args, ['Alice'])).toEqual(['Alice', 'spam'])
		expect(CMD.expandTriggerArgs(args, ['Alice', 'stop', 'that'])).toEqual(['Alice', 'stop', 'that'])
	})

	it('ignores words the template never references', () => {
		expect(CMD.expandTriggerArgs('Read the rules', ['and', 'then', 'some'])).toEqual(['Read', 'the', 'rules'])
	})

	// mustache does not re-render what it interpolates, so a caller cannot inject template syntax of their own
	it('leaves template syntax typed by the caller alone', () => {
		expect(CMD.expandTriggerArgs('{{rest}}', ['{{arg1}}', 'x'])).toEqual(['{{arg1}}', 'x'])
	})
})

describe('formatTriggerUsage', () => {
	it('names the arg a whole-slot placeholder fills, and the placeholder otherwise', () => {
		expect(CMD.formatTriggerUsage('timeout', { string: '!to2h', args: '{{arg1}} 2h {{rest2}}' })).toBe('!to2h <player> [reason|message]')
		expect(CMD.formatTriggerUsage('broadcast', { string: '!eta', args: 'Round ends in {{arg1}} minutes' })).toBe('!eta <arg1>')
	})

	it("gives a plain trigger the command's own signature", () => {
		expect(CMD.formatTriggerUsage('timeout', '!to')).toBe('!to <player> <duration> [reason|message]')
	})

	it('follows the configured reason requirement', () => {
		expect(CMD.formatTriggerUsage('kick', { string: '!k', args: '{{arg1}} {{rest2}}' }, ['kick'])).toBe('!k <player> <reason|message>')
		expect(CMD.formatTriggerUsage('kick', { string: '!k', args: '{{arg1}} {{rest2}}' })).toBe('!k <player> [reason|message]')
		expect(CMD.formatTriggerUsage('kick', '!kick', ['kick'])).toBe('!kick <player> <reason|message>')
	})

	// a default fills the arg when the word is left out, so the word itself is optional either way
	it('reads a placeholder with a default as optional', () => {
		const trigger = { string: '!warnsp', args: '{{arg1}} {{^rest2}}spam{{/rest2}}{{rest2}}' }
		expect(CMD.formatTriggerUsage('warn', trigger)).toBe('!warnsp <player> [reason|message]')
	})

	it('is just the string when the template pins everything', () => {
		expect(CMD.formatTriggerUsage('broadcast', { string: '!rules', args: 'Read the rules' })).toBe('!rules')
	})
})

describe('triggerPins', () => {
	it('names the args a trigger fills in, in declaration order', () => {
		expect(CMD.triggerPins('timeout', { string: '!to45', args: '{{arg1}} 45m' })).toEqual([{ name: 'duration', value: '45m' }])
		expect(CMD.triggerPins('broadcast', { string: '!rules', args: 'Read the rules' })).toEqual([
			{ name: 'reason', value: 'Read the rules' },
		])
	})

	it('is empty for a plain trigger, which fills nothing in', () => {
		expect(CMD.triggerPins('timeout', '!to')).toEqual([])
	})
})

describe('describeTriggerExpansion', () => {
	const config = (triggers: CMD.CommandTrigger[]): CMD.CommandConfig => ({
		triggers,
		allowedChats: ['admin'],
		enabled: true,
		quickReference: false,
	})
	const to45: CMD.CommandTrigger = { string: '!to45', args: '{{arg1}} 45m' }

	it('spells a shortcut out as the plain trigger it stands for', () => {
		expect(CMD.describeTriggerExpansion(config(['!timeout', to45]), to45)).toBe('!timeout {{arg1}} 45m')
	})

	// naming the shortcut's own string as what it expands to would say a trigger is a shortcut for itself
	it('has nothing to give when every trigger pins arguments', () => {
		expect(CMD.describeTriggerExpansion(config([to45]), to45)).toBeUndefined()
	})
})
