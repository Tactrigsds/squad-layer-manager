import { describe, expect, test } from 'vitest'

import * as AppEvents from './app-events.models'
import type * as LQY from './layer-queries.models'
import * as SETTINGS from './settings.models'

function settingsWith(mainPool: Partial<SETTINGS.PoolConfiguration>) {
	const settings = SETTINGS.PublicServerSettingsSchema.parse({})
	Object.assign(settings.queue.mainPool, mainPool)
	return settings
}

describe('pool configuration schema', () => {
	test('defaults to an unconstrained pool', () => {
		const settings = SETTINGS.PublicServerSettingsSchema.parse({})
		expect(settings.queue.mainPool.poolFilter).toBeNull()
		expect(settings.queue.mainPool.indicateMatches).toEqual([])
		expect(settings.queue.mainPool.defaultSelectable).toEqual([])
		expect(SETTINGS.getPoolMembershipConstraints(settings)).toEqual([])
	})

	test('parse is stable (no one-way coercions)', () => {
		const config = {
			poolFilter: { filterId: 'the-pool', mode: 'exclude' },
			indicateMatches: ['a-filter'],
			indicateMisses: ['a-filter', 'b-filter'],
			defaultSelectable: [{ filterId: 'a-filter', applyAs: 'inverted' }],
			warnFor: [{ filterId: 'b-filter', applyAs: 'regular' }],
			constrainGeneration: [{ filterId: 'the-pool', applyAs: 'regular' }],
			layerRequestFilters: [{ filterId: 'b-filter', applyAs: 'inverted' }],
			skipWarningsForTags: ['planned:aaaaaa'],
			repeatRules: [{ label: 'Map', field: 'Map', within: 4, warn: true, indicate: true }],
		}
		const parsed = SETTINGS.PoolConfigurationSchema.parse(config)
		expect(parsed).toEqual(config)
		expect(SETTINGS.PoolConfigurationSchema.parse(parsed)).toEqual(parsed)
	})
})

describe('pool membership constraint', () => {
	test('include mode requires a match', () => {
		const settings = settingsWith({ poolFilter: { filterId: 'the-pool', mode: 'include' } })
		const [constraint] = SETTINGS.getPoolMembershipConstraints(settings) as Extract<LQY.Constraint, { type: 'filter-entity' }>[]
		expect(constraint).toMatchObject({
			type: 'filter-entity',
			id: 'pool-filter',
			filterId: 'the-pool',
			poolFilterMode: 'include',
			filterApplState: 'regular',
			showIndicator: 'both',
			warn: 'disabled',
		})
	})

	test('exclude mode inverts the filter', () => {
		const settings = settingsWith({ poolFilter: { filterId: 'the-pool', mode: 'exclude' } })
		const [constraint] = SETTINGS.getPoolMembershipConstraints(settings)
		expect(constraint).toMatchObject({ poolFilterMode: 'exclude', filterApplState: 'inverted' })
	})
})

describe('getSettingsConstraints', () => {
	const settings = settingsWith({
		poolFilter: { filterId: 'the-pool', mode: 'include' },
		indicateMatches: ['a-filter', 'c-filter'],
		indicateMisses: ['b-filter', 'c-filter'],
		defaultSelectable: [{ filterId: 'a-filter', applyAs: 'regular' }],
		warnFor: [
			{ filterId: 'b-filter', applyAs: 'inverted' },
			{ filterId: 'd-filter', applyAs: 'regular' },
		],
		constrainGeneration: [{ filterId: 'e-filter', applyAs: 'inverted' }],
		// deliberately sharing a label, which rules may do: only their position tells them apart
		repeatRules: [
			{ label: 'Repeats', field: 'Map', within: 4, warn: true, indicate: true },
			{ label: 'Repeats', field: 'Layer', within: 2, autogen: true, warn: true, indicate: true },
		],
	})

	test('selection/status context: pool warns on a miss, lists merge into indication constraints', () => {
		const constraints = SETTINGS.getSettingsConstraints(settings)
		const byId = new Map(constraints.map((c) => [c.id, c]))

		// include-mode pool filter warns when the layer does NOT match
		expect(byId.get('pool-filter')).toMatchObject({ filterApplState: 'regular', showIndicator: 'both', warn: 'inverted' })

		expect(byId.get('filter-cfg:a-filter')).toMatchObject({ filterApplState: 'disabled', showIndicator: 'regular', warn: 'disabled' })
		expect(byId.get('filter-cfg:b-filter')).toMatchObject({ showIndicator: 'inverted', warn: 'inverted' })
		expect(byId.get('filter-cfg:c-filter')).toMatchObject({ showIndicator: 'both' })
		// warn-only: no indication configured, but the warn still needs the constraint present
		expect(byId.get('filter-cfg:d-filter')).toMatchObject({ showIndicator: 'disabled', warn: 'regular' })

		// all repeat rules apply in selection/status contexts, autogen-flagged or not, and the two same-labelled
		// rules stay distinct
		expect(byId.get('layer-pool:mainPool:0')).toMatchObject({ type: 'do-not-repeat', rule: { field: 'Map' } })
		expect(byId.get('layer-pool:mainPool:1')).toMatchObject({ type: 'do-not-repeat', rule: { field: 'Layer' } })
		// generation-only config stays out of selection contexts
		expect(constraints.some((c) => c.type === 'filter-entity' && c.filterId === 'e-filter')).toBe(false)
	})

	test('generation context: pool filter always constrains, constrainGeneration and autogen rules apply', () => {
		const constraints = SETTINGS.getSettingsConstraints(settings, { generatingLayers: true })
		const byId = new Map(constraints.map((c) => [c.id, c]))

		expect(byId.get('pool-filter')).toMatchObject({ filterApplState: 'regular', warn: 'disabled' })
		expect(byId.get('gen:e-filter')).toMatchObject({ filterApplState: 'inverted' })
		// only autogen-flagged repeat rules constrain generation, and the id still names their position in the
		// whole list rather than among the ones that survived
		expect(byId.has('layer-pool:mainPool:1')).toBe(true)
		expect(byId.has('layer-pool:mainPool:0')).toBe(false)
		// indication lists don't constrain generation
		expect(byId.has('filter-cfg:a-filter')).toBe(false)
	})
})

describe('installed mods', () => {
	test('a server that says nothing runs stock Squad', () => {
		expect(SETTINGS.PublicServerSettingsSchema.parse({}).installedMods).toEqual(['OWI'])
	})

	test('an empty list is rejected: a server that can load nothing is not a configuration', () => {
		expect(SETTINGS.PublicServerSettingsSchema.safeParse({ installedMods: [] }).success).toBe(false)
	})

	test('selection contexts indicate but do not filter, so an unsupported layer is shown greyed out', () => {
		const settings = SETTINGS.PublicServerSettingsSchema.parse({ installedMods: ['OWI', 'GC'] })
		const constraint = SETTINGS.getSettingsConstraints(settings).find((c) => c.type === 'installed-mods')
		expect(constraint).toMatchObject({ collections: ['OWI', 'GC'], filterApplState: 'disabled', showIndicator: 'both' })
	})

	test('generation filters unsupported layers out', () => {
		const settings = SETTINGS.PublicServerSettingsSchema.parse({ installedMods: ['OWI'] })
		const constraint = SETTINGS.getSettingsConstraints(settings, { generatingLayers: true }).find((c) => c.type === 'installed-mods')
		expect(constraint).toMatchObject({ collections: ['OWI'], filterApplState: 'regular' })
	})
})

describe('message variable cycles', () => {
	const parse = (messageVariables: { name: string; value: string }[]) => SETTINGS.parseGlobalSettings({ messageVariables })
	const messageVariableIssues = (res: ReturnType<typeof parse>) =>
		res.success ? [] : res.error.issues.filter((i) => i.path[0] === 'messageVariables')

	test('accepts variables that reference each other acyclically', () => {
		const res = parse([
			{ name: 'discord', value: 'discord.gg/x' },
			{ name: 'appeal', value: 'Appeal at {{discord}}' },
		])
		expect(messageVariableIssues(res)).toEqual([])
	})

	test('rejects a cycle, flagging every variable on it', () => {
		const res = parse([
			{ name: 'a', value: '{{b}}' },
			{ name: 'b', value: '{{a}}' },
			{ name: 'c', value: 'fine' },
		])
		const issues = messageVariableIssues(res)
		expect(issues.map((i) => i.path)).toEqual([
			['messageVariables', 0, 'value'],
			['messageVariables', 1, 'value'],
		])
		expect(issues[0].message).toContain('a -> b -> a')
	})

	test('rejects a variable that references itself', () => {
		expect(messageVariableIssues(parse([{ name: 'a', value: 'loop {{a}}' }]))).toHaveLength(1)
	})
})

// Every consumer of "which fields are credentials" reads the one marker on the schema. These pin down what the
// marker covers and how the walks over it behave, so a credential added to either schema is sealed, masked and
// redacted without any of them being touched.
describe('secret settings', () => {
	const sftp: SETTINGS.ServerConnection = {
		type: 'sftp',
		rcon: { host: 'h', port: 1, password: 'rcon-pw' },
		sftp: {
			host: 'h',
			port: 22,
			username: 'u',
			password: 'sftp-pw',
			logFile: '/log',
			pollInterval: 1000,
			reconnectInterval: 5000,
			maxReconnectAttempts: 10,
		},
	}

	test('the marker covers the connection secrets, the integration tokens and the admin-list sftp password, and nothing else', () => {
		expect([...SETTINGS.SECRET_SETTING_PATHS].sort()).toEqual([
			'adminLists.*.source.password',
			'connections.rcon.password',
			'connections.sftp.password',
			'connections.token',
			'integrations.battlemetrics.token',
			'integrations.squadBrowser.token',
			'integrations.steam.token',
		])
	})

	test('every server secret lives under connections, the subtree write-sensitive gates and the audit log replaces', () => {
		for (const path of SETTINGS.SECRET_SETTING_PATHS) {
			if (!path.startsWith('connections.')) continue
			expect(SETTINGS.redactSettingValue(path, 'pw')).toBe(AppEvents.REDACTED_SETTING)
		}
		expect(SETTINGS.redactSettingValue('connections.rcon.host', 'host')).toBe(AppEvents.REDACTED_SETTING)
	})

	test('transforms every secret of a connection, and returns one without any by reference', () => {
		const sealed = SETTINGS.transformConnectionSecretValues(sftp, (v) => `sealed:${v}`) as typeof sftp
		expect(sealed.rcon.password).toBe('sealed:rcon-pw')
		expect(sealed.sftp.password).toBe('sealed:sftp-pw')
		expect(sealed.sftp.host).toBe('h')
		const agent: SETTINGS.ServerConnection = { type: 'server-agent', token: 'tok' }
		expect(SETTINGS.transformConnectionSecretValues(agent, (v) => `sealed:${v}`)).toEqual({ type: 'server-agent', token: 'sealed:tok' })
		const sandbox: SETTINGS.ServerConnection = { type: 'sandbox', serverName: 'Sandbox', maxPlayers: 10 }
		expect(SETTINGS.transformConnectionSecretValues(sandbox, (v) => `sealed:${v}`)).toBe(sandbox)
	})

	test('masks a secret scalar and the secret leaves inside a whole object, leaving an empty one empty', () => {
		expect(SETTINGS.maskSecretSettingValue('connections.rcon.password', 'pw')).toBe(SETTINGS.SECRET_SETTING_MASK)
		expect(SETTINGS.maskSecretSettingValue('connections.rcon.host', 'host')).toBe('host')
		expect(SETTINGS.maskSecretSettingValue('connections', sftp)).toEqual({
			...sftp,
			rcon: { host: 'h', port: 1, password: SETTINGS.SECRET_SETTING_MASK },
			sftp: { ...sftp.sftp, password: SETTINGS.SECRET_SETTING_MASK },
		})
		const integrations = { battlemetrics: { enabled: true, token: 'bm', orgId: '1' }, steam: { enabled: true, token: '' } }
		expect(SETTINGS.maskSecretSettingValue('integrations', integrations)).toEqual({
			battlemetrics: { enabled: true, token: SETTINGS.SECRET_SETTING_MASK, orgId: '1' },
			steam: { enabled: true, token: '' },
		})
	})

	test('walks a whole document by reference where it holds no secret to change', () => {
		const settings = SETTINGS.parseGlobalSettings({}).data!
		expect(SETTINGS.maskSecretSettingValue('', settings)).toBe(settings)
		const withToken = SETTINGS.parseGlobalSettings({ integrations: { steam: { token: 'k' } } }).data!
		const masked = SETTINGS.maskSecretSettingValue('', withToken) as SETTINGS.GlobalSettings
		expect(masked).not.toBe(withToken)
		expect(masked.integrations.steam.token).toBe(SETTINGS.SECRET_SETTING_MASK)
		expect(masked.commands).toBe(withToken.commands)
	})

	test('a placeholder sent back stands for the stored secret, and anything else replaces it', () => {
		const stored = {
			integrations: {
				battlemetrics: { enabled: true, token: 'stored-bm', orgId: '1' },
				steam: { enabled: true, token: 'stored-steam' },
			},
		}
		const submitted = {
			integrations: {
				battlemetrics: { enabled: false, token: SETTINGS.SECRET_SETTING_MASK, orgId: '2' },
				steam: { enabled: true, token: 'new-steam' },
				squadBrowser: { enabled: true, token: SETTINGS.SECRET_SETTING_MASK },
			},
		}
		expect(SETTINGS.restoreMaskedSecrets(submitted, stored)).toEqual({
			integrations: {
				battlemetrics: { enabled: false, token: 'stored-bm', orgId: '2' },
				steam: { enabled: true, token: 'new-steam' },
				// a placeholder for a secret that was never stored is an empty one
				squadBrowser: { enabled: true, token: '' },
			},
		})
	})

	test('finds a secret under a record by its key, from the whole document or from a change path', () => {
		const sftpList = { source: { type: 'sftp', host: 'h', port: 22, username: 'u', password: 'list-pw', filePath: '/a' } }
		const remoteList = { source: { type: 'remote', source: 'https://example.com/admins.cfg' } }
		const masked = SETTINGS.maskSecretSettingValue('', { adminLists: { Main: sftpList, Remote: remoteList } })
		expect(masked.adminLists.Main.source.password).toBe(SETTINGS.SECRET_SETTING_MASK)
		expect(masked.adminLists.Remote).toBe(remoteList)

		expect(SETTINGS.isSecretSettingPath('adminLists.Main.source.password')).toBe(true)
		expect(SETTINGS.isSecretSettingPath('adminLists.Main.source.host')).toBe(false)
		expect(SETTINGS.maskSecretSettingValue('adminLists.Main', sftpList).source.password).toBe(SETTINGS.SECRET_SETTING_MASK)

		const restored = SETTINGS.restoreMaskedSecrets({ adminLists: { Main: masked.adminLists.Main } }, { adminLists: { Main: sftpList } })
		expect(restored.adminLists.Main.source.password).toBe('list-pw')
	})

	test('an integration is on when switched on with a token', () => {
		expect(SETTINGS.integrationEnabled({ enabled: true, token: 'x' })).toBe(true)
		expect(SETTINGS.integrationEnabled({ enabled: true, token: '' })).toBe(false)
		expect(SETTINGS.integrationEnabled({ enabled: false, token: 'x' })).toBe(false)
	})
})

describe('trimStaleSettingsGrants', () => {
	const grantsOf = (serverSettingsGrants: unknown[]) => ({ rbac: { roles: { mod: { serverSettingsGrants } } } })
	const trimmedGrants = (serverSettingsGrants: unknown[]) => {
		const { settings } = SETTINGS.trimStaleSettingsGrants(grantsOf(serverSettingsGrants))
		return (settings as ReturnType<typeof grantsOf>).rbac.roles.mod.serverSettingsGrants
	}

	test('drops a stale path and keeps the live ones', () => {
		expect(trimmedGrants([{ access: 'write', serverIds: [], paths: ['queue', 'noSuchSetting'] }])).toEqual([
			{ access: 'write', serverIds: [], paths: ['queue'] },
		])
	})

	test('narrows a write grant whose every path went stale to read, rather than to every setting', () => {
		expect(trimmedGrants([{ serverIds: ['a'], paths: ['noSuchSetting'] }])).toEqual([{ access: 'read', serverIds: ['a'], paths: [] }])
	})

	test('leaves an unrestricted write grant alone', () => {
		const grants = [{ access: 'write', serverIds: [], paths: [] }]
		expect(trimmedGrants(grants)).toBe(grants)
	})
})

describe('setting mutation paths', () => {
	test.each([
		[['__proto__', 'polluted']],
		[['queue', '__proto__', 'polluted']],
		[['constructor', 'prototype', 'polluted']],
		[['queue', 'toString', 'polluted']],
	])('rejects a path that walks off the settings into a prototype: %j', (path) => {
		expect(SETTINGS.SettingMutationSchema.safeParse({ path, value: 'yes' }).success).toBe(false)
	})

	test('refuses to apply a path through __proto__, leaving Object.prototype alone', () => {
		const settings = SETTINGS.PublicServerSettingsSchema.parse({})
		expect(() => SETTINGS.applySettingMutation(settings, ['queue', '__proto__', 'polluted'], 'yes')).toThrow()
		expect(({} as Record<string, unknown>).polluted).toBeUndefined()
	})

	test('still accepts a path to a real setting', () => {
		expect(SETTINGS.SettingMutationSchema.safeParse({ path: ['queue', 'mainPool', 'poolFilter'], value: null }).success).toBe(true)
	})
})
