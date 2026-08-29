import { describe, expect, it } from 'vitest'

import * as RBAC from '@/rbac.models'

function timeoutPerm(maxDurationMs: number | null, serverId: string | null = null): RBAC.Permission {
	return RBAC.perm('squad-server:timeout-players', { serverId, maxDurationMs })
}

describe('maxTimeoutDurationMs', () => {
	it('returns undefined with no timeout grant', () => {
		expect(RBAC.maxTimeoutDurationMs([], 's1', RBAC.NO_SCOPED_SERVERS)).toBeUndefined()
		expect(
			RBAC.maxTimeoutDurationMs([RBAC.perm('squad-server:warn-players', { serverId: null })], 's1', RBAC.NO_SCOPED_SERVERS),
		).toBeUndefined()
	})

	it('returns the max across grants', () => {
		expect(
			RBAC.maxTimeoutDurationMs([timeoutPerm(60_000), timeoutPerm(3_600_000), timeoutPerm(600_000)], 's1', RBAC.NO_SCOPED_SERVERS),
		).toBe(3_600_000)
	})

	it('null (unlimited) short-circuits', () => {
		expect(RBAC.maxTimeoutDurationMs([timeoutPerm(60_000), timeoutPerm(null)], 's1', RBAC.NO_SCOPED_SERVERS)).toBeNull()
	})

	it('only counts grants that reach the server asked about', () => {
		const perms = [timeoutPerm(60_000, 's1'), timeoutPerm(3_600_000, 's2')]
		expect(RBAC.maxTimeoutDurationMs(perms, 's1', RBAC.NO_SCOPED_SERVERS)).toBe(60_000)
		expect(RBAC.maxTimeoutDurationMs(perms, 's3', RBAC.NO_SCOPED_SERVERS)).toBeUndefined()
		// a null serverId asks for the cap that holds everywhere, which no per-server grant provides
		expect(RBAC.maxTimeoutDurationMs(perms, null, RBAC.NO_SCOPED_SERVERS)).toBeUndefined()
		expect(RBAC.maxTimeoutDurationMs([timeoutPerm(60_000)], null, RBAC.NO_SCOPED_SERVERS)).toBe(60_000)
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
		expect(RBAC.serverSettingsWriteAccess(perms, 's1', RBAC.NO_SCOPED_SERVERS)).toEqual({
			kind: 'paths',
			paths: ['queue.mainPool', 'navLinks'],
		})
		expect(RBAC.serverSettingsWriteAccess(perms, 's2', RBAC.NO_SCOPED_SERVERS)).toEqual({ kind: 'paths', paths: ['navLinks'] })
		expect(
			RBAC.serverSettingsWriteAccess(
				[RBAC.perm('server-settings:write', { serverId: null, paths: null })],
				'anything',
				RBAC.NO_SCOPED_SERVERS,
			),
		).toEqual({
			kind: 'all',
		})
	})

	it('server read is implied by write and write-sensitive grants for that server', () => {
		expect(RBAC.canReadServerSettings([RBAC.perm('server-settings:read', { serverId: 's1' })], 's1', RBAC.NO_SCOPED_SERVERS)).toBe(true)
		expect(RBAC.canReadServerSettings([RBAC.perm('server-settings:read', { serverId: 's1' })], 's2', RBAC.NO_SCOPED_SERVERS)).toBe(false)
		expect(
			RBAC.canReadServerSettings(
				[RBAC.perm('server-settings:write', { serverId: 's1', paths: ['queue'] })],
				's1',
				RBAC.NO_SCOPED_SERVERS,
			),
		).toBe(true)
		expect(
			RBAC.canReadServerSettings([RBAC.perm('server-settings:write-sensitive', { serverId: null })], 's1', RBAC.NO_SCOPED_SERVERS),
		).toBe(true)
	})

	it('write-sensitive matches by server id', () => {
		const perms = [RBAC.perm('server-settings:write-sensitive', { serverId: 's1' })]
		expect(RBAC.canWriteSensitiveServerSettings(perms, 's1', RBAC.NO_SCOPED_SERVERS)).toBe(true)
		expect(RBAC.canWriteSensitiveServerSettings(perms, 's2', RBAC.NO_SCOPED_SERVERS)).toBe(false)
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
		expect(RBAC.permSubsumedBy(RBAC.perm('site:authorized'), [RBAC.perm('site:authorized')], RBAC.NO_SCOPED_SERVERS)).toBe(true)
		expect(RBAC.permSubsumedBy(RBAC.perm('site:authorized'), [RBAC.perm('filters:create')], RBAC.NO_SCOPED_SERVERS)).toBe(false)
		expect(RBAC.permSubsumedBy(RBAC.perm('site:authorized'), [], RBAC.NO_SCOPED_SERVERS)).toBe(false)
	})

	it('server-scoped perms are covered by an all-servers grant but not by another server', () => {
		const onS1 = [RBAC.perm('queue:write', { serverId: 's1' })]
		expect(RBAC.permSubsumedBy(RBAC.perm('queue:write', { serverId: 's1' }), onS1, RBAC.NO_SCOPED_SERVERS)).toBe(true)
		expect(RBAC.permSubsumedBy(RBAC.perm('queue:write', { serverId: 's2' }), onS1, RBAC.NO_SCOPED_SERVERS)).toBe(false)
		// the all-servers grant covers any specific server, but not the reverse
		const allServers = [RBAC.perm('queue:write', { serverId: null })]
		expect(RBAC.permSubsumedBy(RBAC.perm('queue:write', { serverId: 's2' }), allServers, RBAC.NO_SCOPED_SERVERS)).toBe(true)
		expect(RBAC.permSubsumedBy(RBAC.perm('queue:write', { serverId: null }), onS1, RBAC.NO_SCOPED_SERVERS)).toBe(false)
		// and it does not leak across permission types
		expect(RBAC.permSubsumedBy(RBAC.perm('vote:manage', { serverId: 's1' }), allServers, RBAC.NO_SCOPED_SERVERS)).toBe(false)
	})

	// A plugin action is one permission carrying the plugin's id, rather than a type of its own: which plugins
	// exist is not known when the permission table is built, and a grant has to outlive its plugin.
	it('plugin actions match on plugin, action and server together', () => {
		const held = [RBAC.pluginAction('seed-roller', 'roll', 's1')]
		expect(RBAC.permSubsumedBy(RBAC.pluginAction('seed-roller', 'roll', 's1'), held, RBAC.NO_SCOPED_SERVERS)).toBe(true)
		expect(RBAC.permSubsumedBy(RBAC.pluginAction('seed-roller', 'roll', 's2'), held, RBAC.NO_SCOPED_SERVERS)).toBe(false)
		expect(RBAC.permSubsumedBy(RBAC.pluginAction('seed-roller', 'cancel', 's1'), held, RBAC.NO_SCOPED_SERVERS)).toBe(false)
		// the id is namespaced, so two plugins naming their actions the same do not share a grant
		expect(RBAC.permSubsumedBy(RBAC.pluginAction('other-plugin', 'roll', 's1'), held, RBAC.NO_SCOPED_SERVERS)).toBe(false)

		// a grant naming no servers is the all-servers grant, which is also what a plugin-global action asks for
		const anyServer = [RBAC.pluginAction('seed-roller', 'roll', null)]
		expect(RBAC.permSubsumedBy(RBAC.pluginAction('seed-roller', 'roll', 's9'), anyServer, RBAC.NO_SCOPED_SERVERS)).toBe(true)
		expect(RBAC.permSubsumedBy(RBAC.pluginAction('seed-roller', 'roll', null), held, RBAC.NO_SCOPED_SERVERS)).toBe(false)
	})

	// the super-user grant, which cannot enumerate plugins the host has never heard of
	it('the plugin-action wildcard covers every plugin and action', () => {
		const superUser = [RBAC.pluginAction(RBAC.ANY_PLUGIN_ACTION, RBAC.ANY_PLUGIN_ACTION, null)]
		expect(RBAC.permSubsumedBy(RBAC.pluginAction('anything', 'at-all', 's1'), superUser, RBAC.NO_SCOPED_SERVERS)).toBe(true)
		// scoped to one server, it stops at that server
		const owner = [RBAC.pluginAction(RBAC.ANY_PLUGIN_ACTION, RBAC.ANY_PLUGIN_ACTION, 's1')]
		expect(RBAC.permSubsumedBy(RBAC.pluginAction('anything', 'at-all', 's1'), owner, RBAC.NO_SCOPED_SERVERS)).toBe(true)
		expect(RBAC.permSubsumedBy(RBAC.pluginAction('anything', 'at-all', 's2'), owner, RBAC.NO_SCOPED_SERVERS)).toBe(false)
	})

	it('filter-scoped perms match on their args', () => {
		expect(
			RBAC.permSubsumedBy(
				RBAC.perm('filters:write', { filterId: 'f1' }),
				[RBAC.perm('filters:write', { filterId: 'f1' })],
				RBAC.NO_SCOPED_SERVERS,
			),
		).toBe(true)
		expect(
			RBAC.permSubsumedBy(
				RBAC.perm('filters:write', { filterId: 'f1' }),
				[RBAC.perm('filters:write', { filterId: 'f2' })],
				RBAC.NO_SCOPED_SERVERS,
			),
		).toBe(false)
	})

	it('a timeout grant on one server does not cover another', () => {
		expect(RBAC.permSubsumedBy(timeoutPerm(60_000, 's1'), [timeoutPerm(600_000, 's1')], RBAC.NO_SCOPED_SERVERS)).toBe(true)
		expect(RBAC.permSubsumedBy(timeoutPerm(60_000, 's2'), [timeoutPerm(600_000, 's1')], RBAC.NO_SCOPED_SERVERS)).toBe(false)
		expect(RBAC.permSubsumedBy(timeoutPerm(60_000, 's2'), [timeoutPerm(600_000)], RBAC.NO_SCOPED_SERVERS)).toBe(true)
	})

	it('timeouts are subsumed by an equal or longer grant', () => {
		expect(RBAC.permSubsumedBy(timeoutPerm(60_000), [timeoutPerm(600_000)], RBAC.NO_SCOPED_SERVERS)).toBe(true)
		expect(RBAC.permSubsumedBy(timeoutPerm(60_000), [timeoutPerm(60_000)], RBAC.NO_SCOPED_SERVERS)).toBe(true)
		expect(RBAC.permSubsumedBy(timeoutPerm(600_000), [timeoutPerm(60_000)], RBAC.NO_SCOPED_SERVERS)).toBe(false)
		expect(RBAC.permSubsumedBy(timeoutPerm(600_000), [timeoutPerm(null)], RBAC.NO_SCOPED_SERVERS)).toBe(true)
		// unlimited is only subsumed by unlimited
		expect(RBAC.permSubsumedBy(timeoutPerm(null), [timeoutPerm(600_000)], RBAC.NO_SCOPED_SERVERS)).toBe(false)
		expect(RBAC.permSubsumedBy(timeoutPerm(60_000), [], RBAC.NO_SCOPED_SERVERS)).toBe(false)
	})

	it('settings path grants are subsumed by any covering prefix', () => {
		const restricted = [RBAC.perm('global-settings:write', { paths: ['queue'] })]
		expect(
			RBAC.permSubsumedBy(RBAC.perm('global-settings:write', { paths: ['queue.mainPool'] }), restricted, RBAC.NO_SCOPED_SERVERS),
		).toBe(true)
		expect(
			RBAC.permSubsumedBy(RBAC.perm('global-settings:write', { paths: ['queue', 'vote'] }), restricted, RBAC.NO_SCOPED_SERVERS),
		).toBe(false)
		// an unrestricted grant is only subsumed by another unrestricted one
		expect(RBAC.permSubsumedBy(RBAC.perm('global-settings:write', { paths: null }), restricted, RBAC.NO_SCOPED_SERVERS)).toBe(false)
		expect(
			RBAC.permSubsumedBy(
				RBAC.perm('global-settings:write', { paths: null }),
				[RBAC.perm('global-settings:write', { paths: null })],
				RBAC.NO_SCOPED_SERVERS,
			),
		).toBe(true)
	})

	it('server settings grants respect both server id and paths', () => {
		const perms = [RBAC.perm('server-settings:write', { serverId: 's1', paths: ['queue'] })]
		expect(
			RBAC.permSubsumedBy(
				RBAC.perm('server-settings:write', { serverId: 's1', paths: ['queue.mainPool'] }),
				perms,
				RBAC.NO_SCOPED_SERVERS,
			),
		).toBe(true)
		expect(
			RBAC.permSubsumedBy(RBAC.perm('server-settings:write', { serverId: 's2', paths: ['queue'] }), perms, RBAC.NO_SCOPED_SERVERS),
		).toBe(false)
		expect(
			RBAC.permSubsumedBy(RBAC.perm('server-settings:write', { serverId: 's1', paths: ['vote'] }), perms, RBAC.NO_SCOPED_SERVERS),
		).toBe(false)
		// an all-servers grant needs an all-servers grant behind it, not a per-server one
		expect(
			RBAC.permSubsumedBy(RBAC.perm('server-settings:write', { serverId: null, paths: ['queue'] }), perms, RBAC.NO_SCOPED_SERVERS),
		).toBe(false)
		expect(
			RBAC.permSubsumedBy(
				RBAC.perm('server-settings:read', { serverId: null }),
				[RBAC.perm('server-settings:read', { serverId: 's1' })],
				RBAC.NO_SCOPED_SERVERS,
			),
		).toBe(false)
		expect(
			RBAC.permSubsumedBy(
				RBAC.perm('server-settings:read', { serverId: 's1' }),
				[RBAC.perm('server-settings:read', { serverId: null })],
				RBAC.NO_SCOPED_SERVERS,
			),
		).toBe(true)
	})
})

describe('tryDenyPermissions', () => {
	const traced = (perm: RBAC.Permission) => ({ ...perm, allowedByRoles: [], negated: false, negating: false })

	it('an all-servers grant satisfies a specific-server check', () => {
		const perms = [traced(RBAC.perm('server-settings:read', { serverId: null }))]
		expect(RBAC.tryDenyPermissions(perms, RBAC.perm('server-settings:read', { serverId: 's1' }), RBAC.NO_SCOPED_SERVERS)).toBe(null)
	})

	it('a per-server grant does not satisfy a different server', () => {
		const perms = [traced(RBAC.perm('server-settings:read', { serverId: 's1' }))]
		expect(RBAC.tryDenyPermissions(perms, RBAC.perm('server-settings:read', { serverId: 's1' }), RBAC.NO_SCOPED_SERVERS)).toBe(null)
		expect(RBAC.tryDenyPermissions(perms, RBAC.perm('server-settings:read', { serverId: 's2' }), RBAC.NO_SCOPED_SERVERS)?.code).toBe(
			'err:permission-denied',
		)
	})

	it('unscoped perms still match exactly', () => {
		const perms = [traced(RBAC.perm('site:authorized'))]
		expect(RBAC.tryDenyPermissions(perms, RBAC.perm('site:authorized'), RBAC.NO_SCOPED_SERVERS)).toBe(null)
		expect(RBAC.tryDenyPermissions(perms, RBAC.perm('filters:create'), RBAC.NO_SCOPED_SERVERS)?.code).toBe('err:permission-denied')
	})

	it('a sandbox-only grant does not authorize an action on another server', () => {
		const perms = [traced(RBAC.perm('squad-server:kick-players', { serverId: 'sandbox' }))]
		expect(RBAC.tryDenyPermissions(perms, RBAC.perm('squad-server:kick-players', { serverId: 'sandbox' }), RBAC.NO_SCOPED_SERVERS)).toBe(
			null,
		)
		expect(
			RBAC.tryDenyPermissions(perms, RBAC.perm('squad-server:kick-players', { serverId: 'prod' }), RBAC.NO_SCOPED_SERVERS)?.code,
		).toBe('err:permission-denied')
	})
})

describe('canViewServer', () => {
	it('is implied by any server-scoped grant on that server', () => {
		expect(RBAC.canViewServer([RBAC.perm('queue:write', { serverId: 's1' })], 's1', RBAC.NO_SCOPED_SERVERS)).toBe(true)
		expect(RBAC.canViewServer([RBAC.perm('queue:write', { serverId: 's1' })], 's2', RBAC.NO_SCOPED_SERVERS)).toBe(false)
		expect(RBAC.canViewServer([RBAC.perm('squad-server:kick-players', { serverId: null })], 's2', RBAC.NO_SCOPED_SERVERS)).toBe(true)
	})

	it('is granted on its own for the read-only case, and not by a global permission', () => {
		expect(RBAC.canViewServer([RBAC.perm('squad-server:view', { serverId: 's1' })], 's1', RBAC.NO_SCOPED_SERVERS)).toBe(true)
		expect(RBAC.canViewServer([RBAC.perm('site:authorized')], 's1', RBAC.NO_SCOPED_SERVERS)).toBe(false)
		expect(RBAC.canViewServer([], 's1', RBAC.NO_SCOPED_SERVERS)).toBe(false)
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

describe('scoped servers', () => {
	// a scoped server (the id passed as the scoped set) is reachable only through a grant naming it explicitly, so a
	// wildcard (all-servers) grant a non-owner holds does not reach it, while the owner's explicit grant does.
	const scoped = new Set(['tut'])
	const wildcardView = RBAC.perm('squad-server:view', { serverId: null })
	const explicitView = RBAC.perm('squad-server:view', { serverId: 'tut' })

	it('a wildcard grant reaches a public server but not a scoped one', () => {
		expect(RBAC.canViewServer([wildcardView], 'pub', scoped)).toBe(true)
		expect(RBAC.canViewServer([wildcardView], 'tut', scoped)).toBe(false)
	})

	it('an explicit grant reaches the scoped server it names', () => {
		expect(RBAC.canViewServer([explicitView], 'tut', scoped)).toBe(true)
	})

	it('tryDenyPermissions denies a wildcard-only holder on a scoped server and allows an explicit holder', () => {
		const req = RBAC.perm('queue:write', { serverId: 'tut' })
		expect(RBAC.tryDenyPermissions([RBAC.perm('queue:write', { serverId: null })], req, scoped)).not.toBeNull()
		expect(RBAC.tryDenyPermissions([RBAC.perm('queue:write', { serverId: 'tut' })], req, scoped)).toBeNull()
	})

	it('a comparator grant (timeout) follows the same rule', () => {
		const wildcard = RBAC.perm('squad-server:timeout-players', { serverId: null, maxDurationMs: null })
		expect(RBAC.maxTimeoutDurationMs([wildcard], 'pub', scoped)).toBeNull()
		expect(RBAC.maxTimeoutDurationMs([wildcard], 'tut', scoped)).toBeUndefined()
	})
})
