import * as Zus from '@/lib/zustand'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as FeatureFlags from '@/systems/feature-flags.client'

// December by the browser's clock. Read once at load, so a page left open into December 1st turns cheer on at its next reload.
const IN_SEASON = new Date().getMonth() === 11

export namespace Sel {
	export function available(flags: FeatureFlags.FeatureFlagsState) {
		return IN_SEASON || flags.flags.christmasCheer
	}
	export function active(flags: FeatureFlags.FeatureFlagsState, settings: ClientOnlySettings.ClientOnlySettingsStore) {
		return available(flags) && !settings.christmasCheerDisabled
	}
}

export function useAvailable() {
	return Zus.useStore(FeatureFlags.Store, Sel.available)
}

export function useActive() {
	return Zus.useStore(FeatureFlags.Store, ClientOnlySettings.Store, Sel.active)
}
