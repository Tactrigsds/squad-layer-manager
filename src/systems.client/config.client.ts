import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import type { PublicConfig } from '@/server/config'
import { trpc } from '@/trpc.client'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { toStream } from 'zustand-rx'

const Store = Zus.createStore<PublicConfig | undefined>(() => undefined)

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
		const config = await trpc.config.query()
		Store.setState(config)
	})()
}

export function invalidateConfig() {
	Store.setState(undefined)
	setup()
}

export async function fetchEffectiveConfig(): Promise<LQY.EffectiveColumnAndTableConfig> {
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
