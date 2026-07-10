import * as ZusUtils from '@/lib/zustand'
import * as LC from '@/models/layer-columns'
import type * as LQY from '@/models/layer-queries.models'
import * as RPC from '@/orpc.client'
import type { PublicConfigForClient } from '@/server/config.server'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { toStream } from 'zustand-rx'

// static, deploy-time constants (env vars + the JSONC config file). Runtime, admin-editable state lives in settings.client.ts.
export const Store = Zus.createStore<PublicConfigForClient | undefined>(() => undefined)

// just hope the config exists already (probably will)
export function getConfig() {
	return Store.getState()
}
export function getColConfig() {
	const config = Store.getState()!
	return {
		...LC.getEffectiveColumnConfig(config.extraColumnsConfig),
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
	RPC.observe(() => RPC.orpc.config.watchConfig.call()).subscribe(config => {
		Store.setState(config)
	})
}

export async function fetchEffectiveColConfig(): Promise<LQY.EffectiveColumnAndTableConfig> {
	const config = await fetchConfig()
	return {
		...LC.getEffectiveColumnConfig(config.extraColumnsConfig),
		...config.layerTable,
	}
}

export function useEffectiveColConfig(): LQY.EffectiveColumnAndTableConfig | undefined {
	const config = ZusUtils.useStore(Store)

	return React.useMemo(() => {
		if (!config) return
		return {
			...LC.getEffectiveColumnConfig(config.extraColumnsConfig),
			...config.layerTable,
		}
	}, [config])
}
