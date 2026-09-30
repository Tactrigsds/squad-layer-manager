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

// The secret marker on the schema, the seal switch and the audit redaction each know which fields are credentials.
// These hold them to one answer, so a credential added to the schema without the others catching up fails here
// rather than reaching the database or the audit log in plaintext.
describe('secret settings', () => {
	const connections: SETTINGS.ServerConnection[] = [
		{ type: 'local', logFile: '/log', rcon: { host: 'h', port: 1, password: 'rcon-pw' } },
		{
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
		},
		{ type: 'server-agent', token: 'tok' },
	]

	// every leaf the seal switch rewrites, as a dotted path under `connections`
	function sealedPaths(connection: SETTINGS.ServerConnection): Set<string> {
		const sealed = SETTINGS.transformConnectionSecretValues(connection, (v) => `sealed:${v}`)
		const out = new Set<string>()
		const walk = (value: unknown, path: string) => {
			if (typeof value === 'string' && value.startsWith('sealed:')) out.add(path)
			else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`)
		}
		walk(sealed, 'connections')
		return out
	}

	test('the schema marks exactly the fields the seal switch rewrites', () => {
		const marked = new Set(SETTINGS.SECRET_SETTING_PATHS)
		const sealed = new Set(connections.flatMap((c) => [...sealedPaths(c)]))
		expect([...marked].sort()).toEqual([...sealed].sort())
		expect(marked.size).toBeGreaterThan(0)
	})

	test('every secret lives under connections, the subtree write-sensitive gates and the audit log redacts', () => {
		for (const path of SETTINGS.SECRET_SETTING_PATHS) {
			expect(path.startsWith('connections.')).toBe(true)
			const [change] = AppEvents.redactSettingChanges([{ path, from: 'old', to: 'new' }])!
			expect(change.from).not.toBe('old')
			expect(change.to).not.toBe('new')
		}
	})

	test('masks a secret scalar, and the secret leaves inside a whole connections object', () => {
		expect(SETTINGS.maskSecretSettingValue('connections.rcon.password', 'pw')).toBe(SETTINGS.SECRET_SETTING_MASK)
		expect(SETTINGS.maskSecretSettingValue('connections.rcon.host', 'host')).toBe('host')
		expect(SETTINGS.maskSecretSettingValue('connections', connections[1])).toEqual({
			...connections[1],
			rcon: { host: 'h', port: 1, password: SETTINGS.SECRET_SETTING_MASK },
			sftp: { ...(connections[1] as Extract<SETTINGS.ServerConnection, { type: 'sftp' }>).sftp, password: SETTINGS.SECRET_SETTING_MASK },
		})
	})
})
