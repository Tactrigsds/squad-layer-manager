import type * as SETTINGS from '@/models/settings.models'
import * as RPC from '@/orpc.client'
import type { PublicSettings } from '@/systems/settings.server'
import * as ReactRx from '@react-rxjs/core'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { toStream } from 'zustand-rx'

// ============================== public settings: safe global settings + server registry, for any connected client ==============================

export const PublicSettingsStore = Zus.createStore<PublicSettings | undefined>(() => undefined)

export function getSettings() {
	return PublicSettingsStore.getState()
}

export async function fetchSettings() {
	const settings = PublicSettingsStore.getState()
	if (settings) return settings
	return await Rx.firstValueFrom(toStream(PublicSettingsStore).pipe(Rx.filter(Boolean)))
}

// ============================== global settings: full object, admin:manage-global-settings only ==============================

// the encoded (pre-decode) form, e.g. HumanTime fields as '5m' strings rather than milliseconds -- meant for display/editing
export const [useGlobalSettings, globalSettings$] = ReactRx.bind(
	RPC.observe(() => RPC.orpc.settings.global.watchSettings.call()).pipe(
		Rx.filter((value): value is SETTINGS.GlobalSettingsInput => !('code' in value)),
	),
)

// per-server settings (EditSettingsStore) now live on the squadServer frame's server-settings partial, see @/frame-partials/server-settings.partial

// ============================== setup ==============================

export function setup() {
	RPC.observe(() => RPC.orpc.settings.public.watchPublicSettings.call()).subscribe(settings => {
		PublicSettingsStore.setState(settings)
	})
}
