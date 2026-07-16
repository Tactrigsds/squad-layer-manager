import { describe, expect, test } from 'vitest'

import * as PermRows from '@/models/rbac-perm-rows'

// the editor renders rowsFromConfig and writes back configFromRows, so anything that survives one round trip is a config
// the user can open and save without the meaning drifting under them.
function roundTrip(cfg: PermRows.RoleConfig): PermRows.RoleConfig {
	return PermRows.configFromRows(cfg, PermRows.rowsFromConfig(cfg))
}

describe('rowsFromConfig', () => {
	test('a bare global expression is one allow row with no scope args', () => {
		const rows = PermRows.rowsFromConfig({ permissions: ['queue:write'] })
		expect(rows).toMatchObject([{ type: 'queue:write', effect: 'allow' }])
		expect(rows[0].paths).toBeUndefined()
		expect(rows[0].serverIds).toBeUndefined()
	})

	test('a !-prefixed expression becomes a deny row on the same permission', () => {
		const rows = PermRows.rowsFromConfig({ permissions: ['!admin:restart-slm'] })
		expect(rows).toMatchObject([{ type: 'admin:restart-slm', effect: 'deny' }])
	})

	test('allow and deny on one permission sort adjacently, allow first', () => {
		const rows = PermRows.rowsFromConfig({ permissions: ['!queue:write', 'queue:write'] })
		expect(rows.map((r) => r.effect)).toEqual(['allow', 'deny'])
	})

	test('a bare settings expression is an unrestricted row: empty args, not absent args', () => {
		const [row] = PermRows.rowsFromConfig({ permissions: ['server-settings:write'] })
		expect(row).toMatchObject({ type: 'server-settings:write', effect: 'allow', serverIds: [], paths: [] })
	})

	test('restricted grants become rows carrying their scope args', () => {
		const rows = PermRows.rowsFromConfig({
			globalSettingsGrants: ['vote', 'queue.mainPool'],
			serverSettingsGrants: [{ access: 'write', serverIds: ['eu-1'], paths: ['queue'] }],
		})
		expect(rows).toMatchObject([
			{ type: 'global-settings:write', effect: 'allow', paths: ['vote', 'queue.mainPool'] },
			{ type: 'server-settings:write', effect: 'allow', serverIds: ['eu-1'], paths: ['queue'] },
		])
	})

	test('maxTimeout becomes a timeout-players row', () => {
		const rows = PermRows.rowsFromConfig({ maxTimeout: '2h' })
		expect(rows).toMatchObject([{ type: 'squad-server:timeout-players', effect: 'allow', maxTimeout: '2h' }])
	})

	test('each server grant is its own row', () => {
		const rows = PermRows.rowsFromConfig({
			serverSettingsGrants: [
				{ access: 'write', serverIds: ['eu-1'], paths: [] },
				{ access: 'write', serverIds: ['us-1'], paths: ['vote'] },
			],
		})
		expect(rows).toHaveLength(2)
		expect(rows.map((r) => r.id)).toEqual([...new Set(rows.map((r) => r.id))])
	})

	test('a read grant carries no paths, since the schema rejects them there', () => {
		const [row] = PermRows.rowsFromConfig({ serverSettingsGrants: [{ access: 'read', serverIds: ['eu-1'] }] })
		expect(row.paths).toBeUndefined()
	})

	test('rows are ordered by permission declaration order regardless of stored order', () => {
		const rows = PermRows.rowsFromConfig({ permissions: ['admin:restart-slm', 'queue:write', '*', 'vote:manage'] })
		expect(rows.map((r) => r.type)).toEqual(['*', 'queue:write', 'vote:manage', 'admin:restart-slm'])
	})

	test('ids are deterministic across re-derivation of the same config', () => {
		const cfg = {
			permissions: ['queue:write'],
			serverSettingsGrants: [{ access: 'write', serverIds: ['a'] }, { access: 'write', serverIds: ['b'] }],
		}
		expect(PermRows.rowsFromConfig(cfg).map((r) => r.id)).toEqual(PermRows.rowsFromConfig(cfg).map((r) => r.id))
	})

	test('inferred-only filters:write never becomes a row', () => {
		expect(PermRows.ADDABLE_TYPES).not.toContain('filters:write')
		expect(PermRows.rowsFromConfig({ permissions: ['filters:write'] })).toEqual([])
	})
})

// the redundancy the old two-subsection UI could express but never explained: a bare grant and a restricted grant for the
// same permission. The bare one already wins server-side, so the table shows one unrestricted row.
describe('bare grants subsume restricted grants', () => {
	test('a bare global-settings:write collapses the restricted path grants into one unrestricted row', () => {
		const rows = PermRows.rowsFromConfig({ permissions: ['global-settings:write'], globalSettingsGrants: ['vote'] })
		expect(rows).toMatchObject([{ type: 'global-settings:write', paths: [] }])
	})

	test('the collapse is semantically lossless: saving drops the dead restricted grant', () => {
		const out = roundTrip({ permissions: ['global-settings:write'], globalSettingsGrants: ['vote'] })
		expect(out.permissions).toEqual(['global-settings:write'])
		expect(out.globalSettingsGrants).toEqual([])
	})

	test('a bare server-settings:write subsumes restricted server grants of the same access only', () => {
		const rows = PermRows.rowsFromConfig({
			permissions: ['server-settings:write'],
			serverSettingsGrants: [
				{ access: 'write', serverIds: ['eu-1'], paths: [] },
				{ access: 'read', serverIds: ['us-1'] },
			],
		})
		expect(rows).toMatchObject([
			{ type: 'server-settings:read', serverIds: ['us-1'] },
			{ type: 'server-settings:write', serverIds: [], paths: [] },
		])
	})
})

describe('configFromRows', () => {
	test('empty scope args distribute to a bare expression, not a restricted grant', () => {
		const cfg = PermRows.configFromRows({}, [{ id: 'x', type: 'global-settings:write', effect: 'allow', paths: [] }])
		expect(cfg.permissions).toEqual(['global-settings:write'])
		expect(cfg.globalSettingsGrants).toEqual([])
	})

	test('non-empty scope args distribute to a restricted grant, not a bare expression', () => {
		const cfg = PermRows.configFromRows({}, [{ id: 'x', type: 'global-settings:write', effect: 'allow', paths: ['vote'] }])
		expect(cfg.permissions).toEqual([])
		expect(cfg.globalSettingsGrants).toEqual(['vote'])
	})

	test('a server-settings:write row with paths but no servers is still a restricted grant', () => {
		const cfg = PermRows.configFromRows({}, [{ id: 'x', type: 'server-settings:write', effect: 'allow', serverIds: [], paths: ['vote'] }])
		expect(cfg.permissions).toEqual([])
		expect(cfg.serverSettingsGrants).toEqual([{ access: 'write', serverIds: [], paths: ['vote'] }])
	})

	test('a timeout row with a blank duration falls back rather than persisting an invalid empty cap', () => {
		const cfg = PermRows.configFromRows({}, [{ id: 'x', type: 'squad-server:timeout-players', effect: 'allow', maxTimeout: '' }])
		expect(cfg.maxTimeout).toBe(PermRows.DEFAULT_MAX_TIMEOUT)
	})

	// the lists prefault to [] in the schema, so writing them empty (rather than dropping them) is what keeps a saved
	// draft from reading back as "1 setting changed" forever
	test('emptying the table writes empty lists, matching what the schema reads back', () => {
		const cfg = PermRows.configFromRows(
			{ permissions: ['queue:write'], globalSettingsGrants: ['vote'], serverSettingsGrants: [{ access: 'read' }] },
			[],
		)
		expect(cfg.permissions).toEqual([])
		expect(cfg.globalSettingsGrants).toEqual([])
		expect(cfg.serverSettingsGrants).toEqual([])
	})

	// maxTimeout is the exception: it's optional, and absent is the only way to say "cannot issue timeouts"
	test('removing the timeout row drops maxTimeout rather than writing a falsy cap', () => {
		expect(PermRows.configFromRows({ maxTimeout: '2h' }, [])).not.toHaveProperty('maxTimeout')
	})

	test('assignments are untouched: the table edits permissions only', () => {
		const assignments = { discordRoleIds: ['123'], everyMember: true }
		expect(PermRows.configFromRows({ assignments }, []).assignments).toEqual(assignments)
	})

	test('duplicate rows collapse instead of writing a duplicated expression', () => {
		const cfg = PermRows.configFromRows({}, [
			{ id: 'a', type: 'queue:write', effect: 'allow' },
			{ id: 'b', type: 'queue:write', effect: 'allow' },
		])
		expect(cfg.permissions).toEqual(['queue:write'])
	})
})

describe('round trip', () => {
	const cases: Record<string, PermRows.RoleConfig> = {
		'empty': {},
		'global perms': { permissions: ['queue:write', 'vote:manage'] },
		'wildcard': { permissions: ['*'] },
		'allow + deny': { permissions: ['queue:write', '!admin:restart-slm'] },
		'unrestricted settings': { permissions: ['global-settings:write', 'server-settings:write'] },
		'restricted global settings': { globalSettingsGrants: ['vote', 'queue.mainPool'] },
		'restricted server settings': { serverSettingsGrants: [{ access: 'write', serverIds: ['eu-1'], paths: ['vote'] }] },
		'multiple server grants': {
			serverSettingsGrants: [
				{ access: 'write', serverIds: ['eu-1'], paths: ['vote'] },
				{ access: 'read', serverIds: ['us-1'] },
			],
		},
		'server grant over all servers': { serverSettingsGrants: [{ access: 'write', serverIds: [], paths: ['vote'] }] },
		'timeout': { maxTimeout: '2h' },
		'everything at once': {
			permissions: ['queue:write', 'vote:manage', '!admin:restart-slm'],
			maxTimeout: '30m',
			globalSettingsGrants: ['vote'],
			serverSettingsGrants: [{ access: 'write', serverIds: ['eu-1'], paths: ['queue'] }],
			assignments: { discordRoleIds: ['123'], everyMember: false },
		},
	}

	// Two things a round trip is allowed to change without changing meaning, both of which the schema erases on read:
	// an absent list is the same as an empty one (`prefault([])`), and server grants are an unordered set, so listing them
	// in permission-declaration order may reorder the array. The ordering itself is pinned below.
	function normalized(cfg: PermRows.RoleConfig) {
		return {
			...cfg,
			permissions: cfg.permissions ?? [],
			globalSettingsGrants: cfg.globalSettingsGrants ?? [],
			serverSettingsGrants: [...(cfg.serverSettingsGrants ?? [])].map((g) => JSON.stringify(g)).sort(),
		}
	}

	for (const [name, cfg] of Object.entries(cases)) {
		test(`${name} survives a round trip`, () => {
			expect(normalized(roundTrip(cfg))).toEqual(normalized(cfg))
		})

		test(`${name} is stable under a second round trip`, () => {
			const once = roundTrip(cfg)
			expect(roundTrip(once)).toEqual(once)
		})
	}

	test('a round trip reorders server grants into permission-declaration order, and leaves them there', () => {
		const cfg = {
			serverSettingsGrants: [
				{ access: 'write', serverIds: ['eu-1'], paths: ['vote'] },
				{ access: 'read', serverIds: ['us-1'] },
			],
		}
		expect(roundTrip(cfg).serverSettingsGrants?.map((g) => g.access)).toEqual(['read', 'write'])
	})
})

describe('deny affordance', () => {
	test('every addable permission except the wildcard and the timeout cap can be denied', () => {
		expect(PermRows.canDeny('queue:write')).toBe(true)
		expect(PermRows.canDeny('global-settings:write')).toBe(true)
		// `!squad-server:timeout-players` is not in the expression grammar; you drop the row instead
		expect(PermRows.canDeny('squad-server:timeout-players')).toBe(false)
		expect(PermRows.canDeny(PermRows.ALL_PERMISSIONS)).toBe(false)
	})

	test('rowScope covers every addable permission', () => {
		for (const type of PermRows.ADDABLE_TYPES) expect(() => PermRows.rowScope(type)).not.toThrow()
	})

	test('a row exists for every role-grantable permission, so the table can express any config', () => {
		for (const type of PermRows.ADDABLE_TYPES) {
			if (!PermRows.canDeny(type)) continue
			expect(roundTrip({ permissions: [type] }).permissions).toEqual([type])
			expect(roundTrip({ permissions: [`!${type}`] }).permissions).toEqual([`!${type}`])
		}
	})
})
