import * as ZusUtils from '@/lib/zustand'
import type * as AAR from '@/models/admin-action-reasons.models'
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

// whether the given admin action is configured to require a reason (enforced server-side; used to gate web dialogs)
export function useReasonRequired(action: AAR.AdminActionType): boolean {
	return ZusUtils.useStore(PublicSettingsStore, s => s?.requireReasonFor.includes(action) ?? false)
}

// a server is only usable when the backend has a live slice for it, which happens exactly for enabled, non-broken servers.
// disabled/broken servers still appear in the registry (e.g. for admin UI) but their dashboard can't be loaded.
export function isServerUsable(
	entry: PublicSettings['servers'][number] | undefined,
): entry is PublicSettings['servers'][number] {
	return !!entry && entry.enabled && !entry.broken
}

export async function fetchSettings() {
	const settings = PublicSettingsStore.getState()
	if (settings) return settings
	return await Rx.firstValueFrom(toStream(PublicSettingsStore).pipe(Rx.filter(Boolean)))
}

// ============================== global settings: full object, needs global-settings read access ==============================

// the encoded (pre-decode) form, e.g. HumanTime fields as '5m' strings rather than milliseconds -- meant for display/editing.
// the deny response is kept in the stream (not filtered) so the Suspense boundary always resolves; a denied user (e.g. after an
// rbac change left their session with stale perms) is handled by the consumer instead of hanging forever.
export const [useGlobalSettings, globalSettings$] = ReactRx.bind(
	RPC.observe(() => RPC.orpc.settings.global.watchSettings.call()),
)

// per-server settings (EditSettingsStore) now live on the squadServer frame's server-settings partial, see @/frame-partials/server-settings.partial

// ============================== setup ==============================

export function setup() {
	RPC.observe(() => RPC.orpc.settings.public.watchPublicSettings.call()).subscribe(settings => {
		PublicSettingsStore.setState(settings)
	})
}
