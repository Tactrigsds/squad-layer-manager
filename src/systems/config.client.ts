import { useQuery } from '@tanstack/react-query'

import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import * as DS from '@/models/docs-site.models'
import * as LC from '@/models/layer-columns'
import type * as LQY from '@/models/layer-queries.models'
import * as RPC from '@/orpc.client'
import type { PublicConfigForClient } from '@/server/config.server'

// static, deploy-time constants (env vars). Runtime, admin-editable state lives in settings.client.ts; the layer db's
// column definitions come with the layer data (LC.getEffectiveColumnConfig defaults to L.StaticExtraColumns).
export const Store = Zus.createStore<PublicConfigForClient | undefined>(() => undefined)

// the server re-pushes the config whenever global settings change, so the settings-derived parts of it
// (layerTable, layerGeneration) arrive here live. fireImmediately so a late subscriber sees the config that's
// already loaded rather than waiting for the next push (toStream is change-only by default)
export const config$: Rx.Observable<PublicConfigForClient> = Zus.toStream(Store, undefined, { fireImmediately: true }).pipe(
	Rx.filter((config) => !!config),
)

// An integration reads as off until the config lands, so a control that will never work is never briefly offered.
export const Sel = {
	battlemetricsEnabled: (config: PublicConfigForClient | undefined) => config?.integrations.battlemetrics ?? false,
	discordEnabled: (config: PublicConfigForClient | undefined) => config?.integrations.discord ?? false,
	// only a definite no: unknown reads as fine, so nothing warns before the bot has logged in
	discordMissingMessageContent: (config: PublicConfigForClient | undefined) => config?.discordMessageContent === false,
	// either integration can answer for a join link, and neither is asked until the button is clicked
	joinLinkEnabled: (config: PublicConfigForClient | undefined) =>
		(config?.integrations.squadBrowser || config?.integrations.steam) ?? false,
}

// The docs for the version this instance runs (DS.docsUrlFor). Only a release needs the site's version index, to tell
// whether it is still the newest; GitHub Pages lets any origin read it, and caches it for ten minutes.
export function useDocsUrl() {
	const config = Zus.useStore(Store)
	const isRelease = !!config && !config.version.includes('+')
	const index = useQuery({
		queryKey: ['docs-version-index', config?.docsRootUrl],
		enabled: isRelease,
		staleTime: 10 * 60_000,
		retry: false,
		queryFn: async ({ signal }) => {
			const res = await fetch(`${config!.docsRootUrl}versions.json`, { signal })
			if (!res.ok) return null
			return (await res.json()) as DS.VersionIndex
		},
	})
	return config && DS.docsUrlFor(config.docsRootUrl, config.version, index.data ?? null)
}

// just hope the config exists already (probably will)
export function getConfig() {
	return Store.getState()
}
export function getColConfig() {
	const config = Store.getState()!
	return {
		...LC.getEffectiveColumnConfig(),
		...config.layerTable,
	}
}

export async function fetchConfig() {
	const config = Store.getState()
	if (config) return config
	const value = await Rx.firstValueFrom(Zus.toStream(Store).pipe(Rx.filter(Boolean)))
	return value
}

export function setup() {
	RPC.observe('config.watchConfig', () => RPC.orpc.config.watchConfig.call()).subscribe((config) => {
		Store.setState(config)
	})
}

export async function fetchEffectiveColConfig(): Promise<LQY.EffectiveColumnAndTableConfig> {
	const config = await fetchConfig()
	return {
		...LC.getEffectiveColumnConfig(),
		...config.layerTable,
	}
}

export function useEffectiveColConfig(): LQY.EffectiveColumnAndTableConfig | undefined {
	const config = Zus.useStore(Store)

	return config ? { ...LC.getEffectiveColumnConfig(), ...config.layerTable } : undefined
}
