import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as RPC from '@/orpc.client'
import type { PublicConfig } from '@/server/config'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { toStream } from 'zustand-rx'

const Store = Zus.createStore<PublicConfig | undefined>(() => undefined)

// just hope the config exists already (probably will)
export function getConfig() {
	return Store.getState()!
}
export function getColConfig() {
	const config = Store.getState()!
	return {
		...LC.getEffectiveColumnConfig(config.extraColumnsConfig),
		...config.layerTable,
	}
}

export function useConfig() {
	return Zus.useStore(Store)
}

export async function fetchConfig() {
	const config = Store.getState()
	if (config) return config
	const value = await Rx.firstValueFrom(toStream(Store).pipe(Rx.filter(Boolean)))
	return value
}

export function setup() {
	;(async () => {
		const config = await RPC.orpc.config.getPublicConfig.call()
		Store.setState(config)
	})()
}

export function invalidateConfig() {
	Store.setState(undefined)
	setup()
}

export async function fetchEffectiveColConfig(): Promise<LQY.EffectiveColumnAndTableConfig> {
	const config = await fetchConfig()
	return {
		...LC.getEffectiveColumnConfig(config.extraColumnsConfig),
		...config.layerTable,
	}
}

export function useEffectiveColConfig(): LQY.EffectiveColumnAndTableConfig | undefined {
	const config = useConfig()

	return React.useMemo(() => {
		if (!config) return
		return {
			...LC.getEffectiveColumnConfig(config.extraColumnsConfig),
			...config.layerTable,
		}
	}, [config])
}
