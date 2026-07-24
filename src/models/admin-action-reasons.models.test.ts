import * as AAR from '@/models/admin-action-reasons.models'
import { describe, expect, it } from 'vitest'

function reason(label: string, opts: Partial<AAR.AdminActionReason> = {}): AAR.AdminActionReason {
	return { label, aliases: [], actionTexts: { warn: `${label} warn text` }, ...opts }
}

describe('AdminActionReasonsSchema', () => {
	it('accepts distinct labels and aliases', () => {
		const res = AAR.AdminActionReasonsSchema.safeParse([
			reason('Teamkilling', { aliases: ['tk'] }),
			reason('Toxicity', { aliases: ['tox'], actionTexts: { kill: 'kill text' } }),
		])
		expect(res.success).toBe(true)
	})

	it('rejects duplicate labels case-insensitively', () => {
		const res = AAR.AdminActionReasonsSchema.safeParse([reason('Teamkilling'), reason('teamkilling')])
		expect(res.success).toBe(false)
		expect(res.error!.issues[0].path).toEqual([1, 'label'])
	})

	it('rejects duplicate aliases across reasons', () => {
		const res = AAR.AdminActionReasonsSchema.safeParse([
			reason('Teamkilling', { aliases: ['tk'] }),
			reason('Trolling', { aliases: ['TK'] }),
		])
		expect(res.success).toBe(false)
		expect(res.error!.issues[0].path).toEqual([1, 'aliases', 0])
	})

	it("rejects aliases colliding with another reason's label", () => {
		const res = AAR.AdminActionReasonsSchema.safeParse([
			reason('Teamkilling'),
			reason('Trolling', { aliases: ['teamkilling'] }),
		])
		expect(res.success).toBe(false)
	})

	it("accepts an alias matching its own reason's label", () => {
		const res = AAR.AdminActionReasonsSchema.safeParse([reason('Teamkilling', { aliases: ['teamkilling'] })])
		expect(res.success).toBe(true)
	})

	it('requires text for at least one action', () => {
		const res = AAR.AdminActionReasonsSchema.safeParse([{ label: 'Teamkilling', aliases: [], actionTexts: {} }])
		expect(res.success).toBe(false)
	})
})

describe('reason applicability and text', () => {
	const reasons = [
		reason('Teamkilling', { aliases: ['tk'], actionTexts: { warn: 'Teamkilling warn text', kill: 'Teamkilling kill text' } }),
		reason('AFK', { actionTexts: { 'remove-from-squad': 'AFK rfs text' } }),
		reason('Mic', { actionTexts: { warn: 'Mic warn text' } }),
	]

	it('an action only offers the reasons carrying text for it', () => {
		expect(AAR.reasonsForAction(reasons, 'warn').map(r => r.label)).toEqual(['Teamkilling', 'Mic'])
		expect(AAR.reasonsForAction(reasons, 'kill').map(r => r.label)).toEqual(['Teamkilling'])
		expect(AAR.resolveReason(reasons, 'kill', 'AFK').code).toBe('err:reason-not-applicable')
		expect(AAR.resolveReason(reasons, 'warn', 'AFK').code).toBe('err:reason-not-applicable')
	})

	it('kick and timeout are independent actions', () => {
		const kickOnly = reason('Toxicity', { actionTexts: { kick: 'Toxicity kick text' } })
		expect(AAR.reasonsForAction([kickOnly], 'kick').map(r => r.label)).toEqual(['Toxicity'])
		expect(AAR.reasonsForAction([kickOnly], 'timeout')).toEqual([])
		expect(AAR.resolveReason([kickOnly], 'timeout', 'Toxicity').code).toBe('err:reason-not-applicable')
	})

	it('resolves by alias case-insensitively', () => {
		const res = AAR.resolveReason(reasons, 'kill', 'TK')
		expect(res.code).toBe('ok')
		if (res.code === 'ok') expect(res.reason.label).toBe('Teamkilling')
	})

	it('errors on unknown token', () => {
		expect(AAR.resolveReason(reasons, 'warn', 'Ghosting').code).toBe('err:reason-not-found')
	})

	it('reasonText picks the per-action text', () => {
		expect(AAR.reasonText('warn', reasons[0])).toBe('Teamkilling warn text')
		expect(AAR.reasonText('kill', reasons[0])).toBe('Teamkilling kill text')
	})

	it('formatAppliedReason renders the per-action text verbatim (no wrapper), tagging squads', () => {
		const r = reason('Teamkilling', { actionTexts: { 'disband-squad': 'Teamkilling disband text' } })
		expect(AAR.formatAppliedReason('disband-squad', r, { audienceTag: '@Squad3' })).toBe('@Squad3 Teamkilling disband text')
	})

	it('formatAppliedReason exposes label + duration + custom template variables', () => {
		const templated = reason('Teamkilling', {
			actionTexts: { timeout: 'Kicked for {{label}} ({{duration}}). See {{discord}}.' },
		})
		expect(AAR.formatAppliedReason('timeout', templated, { vars: { duration: '2h', discord: 'discord.gg/x' } }))
			.toBe('Kicked for Teamkilling (2h). See discord.gg/x.')
	})
})

describe('applied reason snapshots', () => {
	const timeoutReason = reason('Toxicity', {
		actionTexts: { timeout: 'Kicked for {{label}}. See {{discord}}.{{#duration}} Able to rejoin in {{duration}}.{{/duration}}' },
	})

	it('applyReason snapshots the template and vars; render uses the snapshot, not current settings', () => {
		const applied = AAR.applyReason('timeout', timeoutReason, { duration: '2h', discord: 'discord.gg/x' })
		expect(applied.label).toBe('Toxicity')
		expect(applied.template).toContain('{{discord}}')
		expect(AAR.renderAppliedReason(applied)).toBe('Kicked for Toxicity. See discord.gg/x. Able to rejoin in 2h.')
	})

	it('renderAppliedReason substitutes extraVars over the snapshot (remaining timeout duration)', () => {
		const applied = AAR.applyReason('timeout', timeoutReason, { duration: '2h', discord: 'discord.gg/x' })
		expect(AAR.renderAppliedReason(applied, { extraVars: { duration: '1h 29m' } }))
			.toBe('Kicked for Toxicity. See discord.gg/x. Able to rejoin in 1h 29m.')
		// empty duration drops the {{#duration}} section entirely
		expect(AAR.renderAppliedReason(applied, { extraVars: { duration: '' } }))
			.toBe('Kicked for Toxicity. See discord.gg/x.')
	})

	it('applyCustomReason renders free text with the snapshotted vars and no label', () => {
		const applied = AAR.applyCustomReason('Go touch grass. {{discord}}', { discord: 'discord.gg/x' })
		expect(applied.label).toBeUndefined()
		expect(AAR.renderAppliedReason(applied)).toBe('Go touch grass. discord.gg/x')
		expect(AAR.renderAppliedReason(applied, { audienceTag: '@Squad3' })).toBe('@Squad3 Go touch grass. discord.gg/x')
	})
})
