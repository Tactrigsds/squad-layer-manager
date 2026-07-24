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
		expect(RBAC.settingsPathOverlaps(access, ['queue', 'layerRequests'])).toBe(false)
		// strict check must not accept the parent
		expect(RBAC.settingsPathAllowed(access, ['queue', 'mainPool'])).toBe(false)
	})
})

describe('permSubsumedBy', () => {
	it('global perms match on identity', () => {
		expect(RBAC.permSubsumedBy(RBAC.perm('vote:manage'), [RBAC.perm('vote:manage')])).toBe(true)
		expect(RBAC.permSubsumedBy(RBAC.perm('vote:manage'), [RBAC.perm('queue:write')])).toBe(false)
		expect(RBAC.permSubsumedBy(RBAC.perm('vote:manage'), [])).toBe(false)
	})

	it('filter-scoped perms match on their args', () => {
		expect(RBAC.permSubsumedBy(RBAC.perm('filters:write', { filterId: 'f1' }), [RBAC.perm('filters:write', { filterId: 'f1' })])).toBe(true)
		expect(RBAC.permSubsumedBy(RBAC.perm('filters:write', { filterId: 'f1' }), [RBAC.perm('filters:write', { filterId: 'f2' })])).toBe(
			false,
		)
	})

	it('timeouts are subsumed by an equal or longer grant', () => {
		expect(RBAC.permSubsumedBy(timeoutPerm(60_000), [timeoutPerm(600_000)])).toBe(true)
		expect(RBAC.permSubsumedBy(timeoutPerm(60_000), [timeoutPerm(60_000)])).toBe(true)
		expect(RBAC.permSubsumedBy(timeoutPerm(600_000), [timeoutPerm(60_000)])).toBe(false)
		expect(RBAC.permSubsumedBy(timeoutPerm(600_000), [timeoutPerm(null)])).toBe(true)
		// unlimited is only subsumed by unlimited
		expect(RBAC.permSubsumedBy(timeoutPerm(null), [timeoutPerm(600_000)])).toBe(false)
		expect(RBAC.permSubsumedBy(timeoutPerm(60_000), [])).toBe(false)
	})

	it('settings path grants are subsumed by any covering prefix', () => {
		const restricted = [RBAC.perm('global-settings:write', { paths: ['queue'] })]
		expect(RBAC.permSubsumedBy(RBAC.perm('global-settings:write', { paths: ['queue.mainPool'] }), restricted)).toBe(true)
		expect(RBAC.permSubsumedBy(RBAC.perm('global-settings:write', { paths: ['queue', 'vote'] }), restricted)).toBe(false)
		// an unrestricted grant is only subsumed by another unrestricted one
		expect(RBAC.permSubsumedBy(RBAC.perm('global-settings:write', { paths: null }), restricted)).toBe(false)
		expect(
			RBAC.permSubsumedBy(RBAC.perm('global-settings:write', { paths: null }), [RBAC.perm('global-settings:write', { paths: null })]),
		).toBe(true)
	})

	it('server settings grants respect both server id and paths', () => {
		const perms = [RBAC.perm('server-settings:write', { serverId: 's1', paths: ['queue'] })]
		expect(RBAC.permSubsumedBy(RBAC.perm('server-settings:write', { serverId: 's1', paths: ['queue.mainPool'] }), perms)).toBe(true)
		expect(RBAC.permSubsumedBy(RBAC.perm('server-settings:write', { serverId: 's2', paths: ['queue'] }), perms)).toBe(false)
		expect(RBAC.permSubsumedBy(RBAC.perm('server-settings:write', { serverId: 's1', paths: ['vote'] }), perms)).toBe(false)
		// an all-servers grant needs an all-servers grant behind it, not a per-server one
		expect(RBAC.permSubsumedBy(RBAC.perm('server-settings:write', { serverId: null, paths: ['queue'] }), perms)).toBe(false)
		expect(
			RBAC.permSubsumedBy(RBAC.perm('server-settings:read', { serverId: null }), [RBAC.perm('server-settings:read', { serverId: 's1' })]),
		).toBe(false)
		expect(
			RBAC.permSubsumedBy(RBAC.perm('server-settings:read', { serverId: 's1' }), [RBAC.perm('server-settings:read', { serverId: null })]),
		).toBe(true)
	})
})

describe('tryDenyPermissions', () => {
	const traced = (perm: RBAC.Permission) => ({ ...perm, allowedByRoles: [], negated: false, negating: false })

	it('an all-servers grant satisfies a specific-server check', () => {
		const perms = [traced(RBAC.perm('server-settings:read', { serverId: null }))]
		expect(RBAC.tryDenyPermissions(perms, RBAC.perm('server-settings:read', { serverId: 's1' }))).toBe(null)
	})

	it('a per-server grant does not satisfy a different server', () => {
		const perms = [traced(RBAC.perm('server-settings:read', { serverId: 's1' }))]
		expect(RBAC.tryDenyPermissions(perms, RBAC.perm('server-settings:read', { serverId: 's1' }))).toBe(null)
		expect(RBAC.tryDenyPermissions(perms, RBAC.perm('server-settings:read', { serverId: 's2' }))?.code).toBe('err:permission-denied')
	})

	it('unscoped perms still match exactly', () => {
		const perms = [traced(RBAC.perm('vote:manage'))]
		expect(RBAC.tryDenyPermissions(perms, RBAC.perm('vote:manage'))).toBe(null)
		expect(RBAC.tryDenyPermissions(perms, RBAC.perm('queue:write'))?.code).toBe('err:permission-denied')
	})
})

describe('addTracedPerms', () => {
	const roleA = RBAC.userDefinedRole('a')
	const roleB = RBAC.userDefinedRole('b')

	it('merges roles onto a matching perm without dropping the perms that follow it', () => {
		const perms = [RBAC.tracedPerm('site:authorized', [roleA])]
		RBAC.addTracedPerms(
			perms,
			RBAC.tracedPerm('site:authorized', [roleB]),
			RBAC.tracedPerm('vote:manage', [roleB]),
			RBAC.tracedPerm('queue:write', [roleB]),
		)
		expect(perms.map((p) => p.type).sort()).toEqual(['queue:write', 'site:authorized', 'vote:manage'])
		const authorized = perms.find((p) => p.type === 'site:authorized')!
		expect(authorized.allowedByRoles).toEqual([roleA, roleB])
	})
})
