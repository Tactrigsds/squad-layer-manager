import * as ServerSettingsPrt from '@/frame-partials/server-settings.partial'
import * as Zus from '@/lib/zustand'
import * as SETTINGS from '@/models/settings.models'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'

// Data access abstraction for the shared pool-configuration panels (see pool-config-panels.tsx). The same UI is
// mounted against two very different editing substrates: the dashboard popover's ops-based settings store, and the
// settings page's draft BehaviorSubject (SettingsForm override). Paths are relative to the pool object
// (queue.mainPool).
export type PoolConfigApi = {
	// the substrate the panels read from, plus how to project a pool-relative path out of its state
	source: Zus.AnyInput<any>
	read: (state: any, path: SETTINGS.SettingsPath) => unknown
	getValue: (path: SETTINGS.SettingsPath) => unknown
	set: (path: SETTINGS.SettingsPath, value: unknown) => void
	writeDenied: RBAC.PermissionDeniedResponse | null
	// bumped when uncontrolled inputs must re-seed from the current value (structural change / reset-to-saved)
	resetKey: number
}

// api over the per-server settings partial (dashboard popover): edits are recorded as ops via Actions.set
export function useStorePoolConfigApi(key: ServerSettingsPrt.Key, base: SETTINGS.SettingsPath): PoolConfigApi {
	const serverId = Zus.useStore(key, (s) => s.settings.serverId)
	const perms = RbacClient.useSuspendableLoggedInUserPerms()
	// loose overlap check: the panel stays editable if any path under its pool subtree is writable (individual
	// out-of-grant edits are still rejected server-side)
	const access = RBAC.serverSettingsWriteAccess(perms, serverId)
	const writeDenied = RBAC.settingsPathOverlaps(access, base)
		? null
		: RBAC.permissionDenied('all', [`server-settings:write on ${RBAC.dottedSettingsPath(base)}`])
	return {
		source: key,
		read: (s, path) => SETTINGS.derefSettingsValue(s.settings.edited, [...base, ...path]),
		getValue: (path) => SETTINGS.derefSettingsValue(Zus.getState(key).settings.edited, [...base, ...path]),
		set: (path, value) => ServerSettingsPrt.Actions.set({ settings: key }, { path: [...base, ...path], value }),
		writeDenied,
		resetKey: 0,
	}
}

// subscribes to the value at `path`, re-rendering when it changes. A module-scope hook rather than a method on the
// api object: React Compiler only treats a call as a hook when it resolves to the same function on every render, so
// a per-render closure hanging off `api` bails out every panel that reads through it.
export function usePoolValue(api: PoolConfigApi, path: SETTINGS.SettingsPath): unknown {
	// callers build the path inline, so key the selector on the path's contents rather than its identity
	const key = JSON.stringify(path)
	return Zus.useStore(api.source, (s) => api.read(s, JSON.parse(key) as SETTINGS.SettingsPath))
}
