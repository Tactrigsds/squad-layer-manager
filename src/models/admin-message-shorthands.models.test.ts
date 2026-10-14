import { describe, expect, it } from 'vitest'

import * as AMS from '@/models/admin-message-shorthands.models'

function shorthand(label: string, opts: Partial<AMS.AdminMessageShorthand> = {}): AMS.AdminMessageShorthand {
	return { label, keywords: [label.toLowerCase()], actionTexts: { warn: `${label} warn text` }, ...opts }
}

describe('AdminMessageShorthandsSchema', () => {
	it('accepts distinct labels and keywords', () => {
		const res = AMS.AdminMessageShorthandsSchema.safeParse([
			shorthand('Teamkilling', { keywords: ['tk'] }),
			shorthand('Toxicity', { keywords: ['tox'], actionTexts: { kill: 'kill text' } }),
		])
		expect(res.success).toBe(true)
	})

	it('rejects duplicate labels case-insensitively', () => {
		const res = AMS.AdminMessageShorthandsSchema.safeParse([shorthand('Teamkilling'), shorthand('teamkilling')])
		expect(res.success).toBe(false)
		expect(res.error!.issues[0].path).toEqual([1, 'label'])
	})

	it('rejects duplicate keywords across shorthands', () => {
		const res = AMS.AdminMessageShorthandsSchema.safeParse([
			shorthand('Teamkilling', { keywords: ['tk'] }),
			shorthand('Trolling', { keywords: ['TK'] }),
		])
		expect(res.success).toBe(false)
		expect(res.error!.issues[0].path).toEqual([1, 'keywords', 0])
	})

	it('requires at least one keyword', () => {
		const res = AMS.AdminMessageShorthandsSchema.safeParse([shorthand('Teamkilling', { keywords: [] })])
		expect(res.success).toBe(false)
	})

	it('requires text for at least one action', () => {
		const res = AMS.AdminMessageShorthandsSchema.safeParse([{ label: 'Teamkilling', keywords: ['tk'], actionTexts: {} }])
		expect(res.success).toBe(false)
	})
})

describe('shorthand applicability and text', () => {
	const shorthands = [
		shorthand('Teamkilling', { keywords: ['tk'], actionTexts: { warn: 'Teamkilling warn text', kill: 'Teamkilling kill text' } }),
		shorthand('AFK', { actionTexts: { 'remove-from-squad': 'AFK rfs text' } }),
		shorthand('Mic', { actionTexts: { warn: 'Mic warn text' } }),
	]

	it('an action only offers the shorthands carrying text for it', () => {
		expect(AMS.shorthandsForAction(shorthands, 'warn').map((r) => r.label)).toEqual(['Teamkilling', 'Mic'])
		expect(AMS.shorthandsForAction(shorthands, 'kill').map((r) => r.label)).toEqual(['Teamkilling'])
		expect(AMS.resolveShorthand(shorthands, 'kill', 'afk').code).toBe('err:shorthand-not-applicable')
		expect(AMS.resolveShorthand(shorthands, 'warn', 'afk').code).toBe('err:shorthand-not-applicable')
	})

	it('kick and timeout are independent actions', () => {
		const kickOnly = shorthand('Toxicity', { actionTexts: { kick: 'Toxicity kick text' } })
		expect(AMS.shorthandsForAction([kickOnly], 'kick').map((r) => r.label)).toEqual(['Toxicity'])
		expect(AMS.shorthandsForAction([kickOnly], 'timeout')).toEqual([])
		expect(AMS.resolveShorthand([kickOnly], 'timeout', 'toxicity').code).toBe('err:shorthand-not-applicable')
	})

	it('resolves by keyword case-insensitively', () => {
		const res = AMS.resolveShorthand(shorthands, 'kill', 'TK')
		expect(res.code).toBe('ok')
		if (res.code === 'ok') expect(res.shorthand.label).toBe('Teamkilling')
	})

	it('errors on unknown token, including a bare label', () => {
		expect(AMS.resolveShorthand(shorthands, 'warn', 'Ghosting').code).toBe('err:shorthand-not-found')
		expect(AMS.resolveShorthand(shorthands, 'kill', 'Teamkilling').code).toBe('err:shorthand-not-found')
	})

	// the web GUI picks a shorthand from a menu and sends its label, so that lookup is by label and stays that way
	it('resolveShorthandByLabel matches the label, not the keyword', () => {
		const byLabel = AMS.resolveShorthandByLabel(shorthands, 'kill', 'Teamkilling')
		expect(byLabel.code).toBe('ok')
		if (byLabel.code === 'ok') expect(byLabel.shorthand.keywords).toEqual(['tk'])
		expect(AMS.resolveShorthandByLabel(shorthands, 'kill', 'tk').code).toBe('err:shorthand-not-found')
		expect(AMS.resolveShorthandByLabel(shorthands, 'kill', 'AFK').code).toBe('err:shorthand-not-applicable')
	})

	it('shorthandText picks the per-action text', () => {
		expect(AMS.shorthandText('warn', shorthands[0])).toBe('Teamkilling warn text')
		expect(AMS.shorthandText('kill', shorthands[0])).toBe('Teamkilling kill text')
	})

	it('formatShorthand renders the per-action text verbatim (no wrapper), tagging squads', () => {
		const r = shorthand('Teamkilling', { actionTexts: { 'disband-squad': 'Teamkilling disband text' } })
		expect(AMS.formatShorthand('disband-squad', r, { audienceTag: '@Squad3' })).toBe('@Squad3 Teamkilling disband text')
	})

	it('formatShorthand exposes label + duration + custom template variables', () => {
		const templated = shorthand('Teamkilling', {
			actionTexts: { timeout: 'Kicked for {{label}} ({{duration}}). See {{discord}}.' },
		})
		expect(AMS.formatShorthand('timeout', templated, { vars: { duration: '2h', discord: 'discord.gg/x' } })).toBe(
			'Kicked for Teamkilling (2h). See discord.gg/x.',
		)
	})
})

describe('applied reason snapshots', () => {
	const timeoutShorthand = shorthand('Toxicity', {
		actionTexts: { timeout: 'Kicked for {{label}}. See {{discord}}.{{#duration}} Able to rejoin in {{duration}}.{{/duration}}' },
	})

	it('applyShorthand snapshots the template and vars; render uses the snapshot, not current settings', () => {
		const applied = AMS.applyShorthand('timeout', timeoutShorthand, { duration: '2h', discord: 'discord.gg/x' })
		expect(applied.label).toBe('Toxicity')
		expect(applied.template).toContain('{{discord}}')
		expect(AMS.renderAppliedReason(applied)).toBe('Kicked for Toxicity. See discord.gg/x. Able to rejoin in 2h.')
	})

	it('renderAppliedReason substitutes extraVars over the snapshot (remaining timeout duration)', () => {
		const applied = AMS.applyShorthand('timeout', timeoutShorthand, { duration: '2h', discord: 'discord.gg/x' })
		expect(AMS.renderAppliedReason(applied, { extraVars: { duration: '1h 29m' } })).toBe(
			'Kicked for Toxicity. See discord.gg/x. Able to rejoin in 1h 29m.',
		)
		// empty duration drops the {{#duration}} section entirely
		expect(AMS.renderAppliedReason(applied, { extraVars: { duration: '' } })).toBe('Kicked for Toxicity. See discord.gg/x.')
	})

	it('applyCustomReason renders free text with the snapshotted vars and no label', () => {
		const applied = AMS.applyCustomReason('Go touch grass. {{discord}}', { discord: 'discord.gg/x' })
		expect(applied.label).toBeUndefined()
		expect(AMS.renderAppliedReason(applied)).toBe('Go touch grass. discord.gg/x')
		expect(AMS.renderAppliedReason(applied, { audienceTag: '@Squad3' })).toBe('@Squad3 Go touch grass. discord.gg/x')
	})
})
