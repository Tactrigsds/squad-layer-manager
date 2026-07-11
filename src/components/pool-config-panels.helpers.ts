import * as ServerSettingsPrt from '@/frame-partials/server-settings.partial'
import * as ZusUtils from '@/lib/zustand'
import * as SETTINGS from '@/models/settings.models'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'

// Data access abstraction for the shared pool-configuration panels (see pool-config-panels.tsx). The same UI is
// mounted against two very different editing substrates: the dashboard popover's ops-based settings store, and the
// settings page's draft BehaviorSubject (SettingsForm override). Paths are relative to the pool object
// (queue.mainPool / queue.generationPool).
export type PoolConfigApi = {
	// hook: subscribes to the value at `path`, re-rendering when it changes
	useValue: (path: SETTINGS.SettingsPath) => unknown
	getValue: (path: SETTINGS.SettingsPath) => unknown
	set: (path: SETTINGS.SettingsPath, value: unknown) => void
	writeDenied: RBAC.PermissionDeniedResponse | null
	// bumped when uncontrolled inputs must re-seed from the current value (structural change / reset-to-saved)
	resetKey: number
}

// api over the per-server settings partial (dashboard popover): edits are recorded as ops via Actions.set
export function useStorePoolConfigApi(key: ServerSettingsPrt.Key, base: SETTINGS.SettingsPath): PoolConfigApi {
	const writeDenied = RbacClient.usePermsCheck(RBAC.perm('settings:write'))
	return {
		useValue: (path) =>
			// oxlint-disable-next-line rules-of-hooks -- stable call site inside the panel components
			ZusUtils.useStore(key, (s) => SETTINGS.derefSettingsValue(s.settings.edited, [...base, ...path])),
		getValue: (path) => SETTINGS.derefSettingsValue(ZusUtils.getState(key).settings.edited, [...base, ...path]),
		set: (path, value) => ServerSettingsPrt.Actions.set({ settings: key }, { path: [...base, ...path], value }),
		writeDenied,
		resetKey: 0,
	}
}
