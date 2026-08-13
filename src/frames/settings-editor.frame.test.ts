import { describe, expect, it } from 'vitest'

// @vitest-environment happy-dom
import * as PermRows from '@/models/rbac-perm-rows'
import * as SETTINGS from '@/models/settings.models'

import * as Editor from './settings-editor.frame'

// deriveComputed is pure, so it runs against a state shape rather than a live frame. The cases below all follow the same
// shape: take the baseline the server hands back, apply an edit the rbac editor actually makes, and check the change list
// is empty once the same value has been saved -- a section that still reads dirty there can never be saved clean.

// what watchSettings streams: the parsed settings encoded back to the input shape
const baseline: any = SETTINGS.GlobalSettingsSchema.encode(SETTINGS.parseGlobalSettings({}).data!)

function globalState(draft: any): Editor.SettingsEditor {
	return { kind: 'global', mode: 'gui', saved: baseline, draft, yamlValid: null } as Editor.SettingsEditor
}

function withRole(roleId: string, cfg: any) {
	return { ...baseline, rbac: { ...baseline.rbac, roles: { ...baseline.rbac.roles, [roleId]: cfg } } }
}

// the state after a save: `saved` is the round-tripped draft, exactly what the server sends back
function afterSaving(draft: any): Editor.SettingsEditor {
	const parsed = SETTINGS.parseGlobalSettings(draft)
	if (!parsed.success) throw new Error(`draft does not parse: ${parsed.error.message}`)
	return { ...globalState(draft), saved: SETTINGS.GlobalSettingsSchema.encode(parsed.data) }
}

const changePaths = (state: Editor.SettingsEditor) => Editor.deriveComputed(state).changes.map((c) => c.path)

describe('deriveComputed changes', () => {
	it('reports nothing for an untouched draft', () => {
		expect(changePaths(globalState(baseline))).toEqual([])
	})

	it('reports the edit before it is saved', () => {
		const draft = withRole('admins', { ...baseline.rbac.roles.admins, permissions: [] })
		expect(changePaths(globalState(draft))).toEqual(['rbac.roles.admins.permissions'])
	})

	it('clears once a newly added role is saved', () => {
		// RbacBody.addRole seeds only `permissions`; the schema prefaults the grant lists and assignments back in
		expect(changePaths(afterSaving(withRole('new-role', { permissions: [] })))).toEqual([])
	})

	it('clears once a read-only server-settings grant is saved', () => {
		// the grant carries no `paths` (they only apply to write grants), and `paths` prefaults to []
		const cfg = baseline.rbac.roles.admins
		const rows = [...PermRows.rowsFromConfig(cfg), { id: 'x', type: 'server-settings:read', effect: 'allow', serverIds: ['server-1'] }]
		expect(changePaths(afterSaving(withRole('admins', PermRows.configFromRows(cfg, rows as PermRows.PermRow[]))))).toEqual([])
	})

	it('clears once a role stripped of its assignments is saved', () => {
		// the editor drops the whole `assignments` key when nothing is assigned
		const cfg = { ...baseline.rbac.roles.admins }
		delete cfg.assignments
		expect(changePaths(afterSaving(withRole('admins', cfg)))).toEqual([])
	})

	it('still diffs a draft that does not parse', () => {
		const draft = withRole('admins', { ...baseline.rbac.roles.admins, permissions: ['not-a-permission'] })
		expect(changePaths(globalState(draft))).toEqual(['rbac.roles.admins.permissions'])
		expect(Editor.deriveComputed(globalState(draft)).valid).toBe(false)
	})
})
