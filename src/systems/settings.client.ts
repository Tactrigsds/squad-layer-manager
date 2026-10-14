import type * as React from 'react'

import * as ReactRx from '@/lib/react-rxjs'
import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import type * as AMS from '@/models/admin-message-shorthands.models'
import type * as RRS from '@/models/repeat-rulesets.models'
import * as RPC from '@/orpc.client'
import type { PublicSettings } from '@/systems/settings.server'

export type { PublicSettings }

// ============================== public settings: safe global settings + server registry, for any connected client ==============================

export const PublicSettingsStore = Zus.createStore<PublicSettings | undefined>(() => undefined)

export function getSettings() {
	return PublicSettingsStore.getState()
}

const NO_REPEAT_RULESETS: readonly RRS.Ruleset[] = []

export function getRepeatRulesets(): readonly RRS.Ruleset[] {
	return PublicSettingsStore.getState()?.repeatRulesets ?? NO_REPEAT_RULESETS
}

export function selectRepeatRulesets(s: PublicSettings | undefined): readonly RRS.Ruleset[] {
	return s?.repeatRulesets ?? NO_REPEAT_RULESETS
}

// whether the given admin action is configured to require a reason (enforced server-side; used to gate web dialogs).
// warns aren't configurable here: they always require one.
export function useReasonRequired(action: AMS.RequirableAdminActionType): boolean {
	return Zus.useStore(PublicSettingsStore, (s) => s?.requireReasonFor.includes(action) ?? false)
}

// a server is only usable when the backend has a live managed server for it, which happens exactly for enabled, non-broken servers.
// disabled/broken servers still appear in the registry (e.g. for admin UI) but their dashboard can't be loaded.
export function isServerUsable(entry: PublicSettings['servers'][number] | undefined): entry is PublicSettings['servers'][number] {
	return !!entry && entry.enabled && !entry.broken
}

// the inline style the `fd-tint` class reads a server's color from; undefined for a server without one
export function serverTintStyle(color: string | null): React.CSSProperties | undefined {
	return color === null ? undefined : ({ '--tint': color } as React.CSSProperties)
}

export async function fetchSettings() {
	const settings = PublicSettingsStore.getState()
	if (settings) return settings
	return await Rx.firstValueFrom(Zus.toStream(PublicSettingsStore).pipe(Rx.filter(Boolean)))
}

// ============================== global settings: full object, needs global-settings read access ==============================

// the encoded (pre-decode) form, e.g. HumanTime fields as '5m' strings rather than milliseconds -- meant for display/editing.
// the deny response is kept in the stream (not filtered) so the Suspense boundary always resolves; a denied user (e.g. after an
// rbac change left their session with stale perms) is handled by the consumer instead of hanging forever.
export const [useGlobalSettings, globalSettings$] = ReactRx.bind(
	'settings.globalSettings',
	RPC.observe('settings.global.watchSettings', () => RPC.orpc.settings.global.watchSettings.call()),
)

// per-server settings (EditSettingsStore) now live on the squadServer frame's server-settings partial, see @/frame-partials/server-settings.partial

// ============================== setup ==============================

export function setup() {
	RPC.observe('settings.public.watchPublicSettings', () => RPC.orpc.settings.public.watchPublicSettings.call()).subscribe((settings) => {
		PublicSettingsStore.setState(settings)
	})
}
