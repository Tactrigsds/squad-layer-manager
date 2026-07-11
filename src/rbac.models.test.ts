import * as RBAC from '@/rbac.models'
import { describe, expect, it } from 'vitest'

function timeoutPerm(maxDurationMs: number | null): RBAC.Permission {
	return RBAC.perm('squad-server:timeout-players', { maxDurationMs })
}

describe('maxTimeoutDurationMs', () => {
	it('returns undefined with no timeout grant', () => {
		expect(RBAC.maxTimeoutDurationMs([])).toBeUndefined()
		expect(RBAC.maxTimeoutDurationMs([RBAC.perm('squad-server:warn-players')])).toBeUndefined()
	})

	it('returns the max across grants', () => {
		expect(RBAC.maxTimeoutDurationMs([timeoutPerm(60_000), timeoutPerm(3_600_000), timeoutPerm(600_000)])).toBe(3_600_000)
	})

	it('null (unlimited) short-circuits', () => {
		expect(RBAC.maxTimeoutDurationMs([timeoutPerm(60_000), timeoutPerm(null)])).toBeNull()
	})
})

describe('settings access aggregation', () => {
	it('global write: none without grants, all on unrestricted, merged paths otherwise', () => {
		expect(RBAC.globalSettingsWriteAccess([])).toEqual({ kind: 'none' })
		expect(RBAC.globalSettingsWriteAccess([RBAC.perm('global-settings:read')])).toEqual({ kind: 'none' })
		expect(RBAC.globalSettingsWriteAccess([RBAC.perm('global-settings:write', { paths: null })])).toEqual({ kind: 'all' })
		expect(
			RBAC.globalSettingsWriteAccess([
				RBAC.perm('global-settings:write', { paths: ['vote'] }),
				RBAC.perm('global-settings:write', { paths: ['commands'] }),
			]),
		).toEqual({ kind: 'paths', paths: ['vote', 'commands'] })
		// an unrestricted grant wins over restricted ones
		expect(
			RBAC.globalSettingsWriteAccess([
				RBAC.perm('global-settings:write', { paths: ['vote'] }),
				RBAC.perm('global-settings:write', { paths: null }),
			]),
		).toEqual({ kind: 'all' })
	})

	it('global read is implied by any write grant', () => {
		expect(RBAC.canReadGlobalSettings([])).toBe(false)
		expect(RBAC.canReadGlobalSettings([RBAC.perm('global-settings:read')])).toBe(true)
		expect(RBAC.canReadGlobalSettings([RBAC.perm('global-settings:write', { paths: ['vote'] })])).toBe(true)
	})

	it('server write: serverId must match (null = all servers)', () => {
		const perms = [
			RBAC.perm('server-settings:write', { serverId: 's1', paths: ['queue.mainPool'] }),
			RBAC.perm('server-settings:write', { serverId: null, paths: ['navLinks'] }),
		]
		expect(RBAC.serverSettingsWriteAccess(perms, 's1')).toEqual({ kind: 'paths', paths: ['queue.mainPool', 'navLinks'] })
		expect(RBAC.serverSettingsWriteAccess(perms, 's2')).toEqual({ kind: 'paths', paths: ['navLinks'] })
		expect(RBAC.serverSettingsWriteAccess([RBAC.perm('server-settings:write', { serverId: null, paths: null })], 'anything'))
			.toEqual({ kind: 'all' })
	})

	it('server read is implied by write and write-sensitive grants for that server', () => {
		expect(RBAC.canReadServerSettings([RBAC.perm('server-settings:read', { serverId: 's1' })], 's1')).toBe(true)
		expect(RBAC.canReadServerSettings([RBAC.perm('server-settings:read', { serverId: 's1' })], 's2')).toBe(false)
		expect(RBAC.canReadServerSettings([RBAC.perm('server-settings:write', { serverId: 's1', paths: ['queue'] })], 's1')).toBe(true)
		expect(RBAC.canReadServerSettings([RBAC.perm('server-settings:write-sensitive', { serverId: null })], 's1')).toBe(true)
	})

	it('write-sensitive matches by server id', () => {
		const perms = [RBAC.perm('server-settings:write-sensitive', { serverId: 's1' })]
		expect(RBAC.canWriteSensitiveServerSettings(perms, 's1')).toBe(true)
		expect(RBAC.canWriteSensitiveServerSettings(perms, 's2')).toBe(false)
	})

	it('settingsPathAllowed: prefix must land on a segment boundary', () => {
		const access: RBAC.SettingsWriteAccess = { kind: 'paths', paths: ['queue.mainPool', 'vote'] }
		expect(RBAC.settingsPathAllowed(access, 'queue.mainPool')).toBe(true)
		expect(RBAC.settingsPathAllowed(access, ['queue', 'mainPool', 'filters', 0, 'inPool'])).toBe(true)
		expect(RBAC.settingsPathAllowed(access, 'vote.voteDuration')).toBe(true)
		expect(RBAC.settingsPathAllowed(access, 'queue.mainPoolExtra')).toBe(false)
		expect(RBAC.settingsPathAllowed(access, 'queue')).toBe(false)
		expect(RBAC.settingsPathAllowed({ kind: 'all' }, 'anything')).toBe(true)
		expect(RBAC.settingsPathAllowed({ kind: 'none' }, 'anything')).toBe(false)
	})

	it('settingsPathOverlaps also accepts grants pointing inside the subtree', () => {
		const access: RBAC.SettingsWriteAccess = { kind: 'paths', paths: ['queue.mainPool.repeatRules'] }
		expect(RBAC.settingsPathOverlaps(access, ['queue', 'mainPool'])).toBe(true)
		expect(RBAC.settingsPathOverlaps(access, ['queue', 'mainPool', 'repeatRules', 0])).toBe(true)
		expect(RBAC.settingsPathOverlaps(access, ['queue', 'generationPool'])).toBe(false)
		// strict check must not accept the parent
		expect(RBAC.settingsPathAllowed(access, ['queue', 'mainPool'])).toBe(false)
	})
})
