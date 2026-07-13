import * as ZusUtils from '@/lib/zustand'
import * as LC from '@/models/layer-columns'
import type * as LQY from '@/models/layer-queries.models'
import * as RPC from '@/orpc.client'
import type { PublicConfigForClient } from '@/server/config.server'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { toStream } from 'zustand-rx'

// static, deploy-time constants (env vars). Runtime, admin-editable state lives in settings.client.ts; the layer db's
// column definitions come with the layer data (LC.getEffectiveColumnConfig defaults to L.StaticExtraColumns).
export const Store = Zus.createStore<PublicConfigForClient | undefined>(() => undefined)

// the server re-pushes the config whenever global settings change, so the settings-derived parts of it
// (layerTable, layerGeneration) arrive here live. fireImmediately so a late subscriber sees the config that's
// already loaded rather than waiting for the next push (toStream is change-only by default)
export const config$: Rx.Observable<PublicConfigForClient> = toStream(Store, undefined, { fireImmediately: true })
	.pipe(Rx.filter(config => !!config))

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
	const value = await Rx.firstValueFrom(toStream(Store).pipe(Rx.filter(Boolean)))
	return value
}

export function setup() {
	RPC.observe('config.watchConfig', () => RPC.orpc.config.watchConfig.call()).subscribe(config => {
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
	const config = ZusUtils.useStore(Store)

	return React.useMemo(() => {
		if (!config) return
		return {
			...LC.getEffectiveColumnConfig(),
			...config.layerTable,
		}
	}, [config])
}
