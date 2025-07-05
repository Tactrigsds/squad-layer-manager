import * as AR from '@/app-routes'
import { LayerDb } from '@/models/layer-db'
import { baseLogger } from '@/server/systems/logger.client'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as Rx from 'rxjs'
import { SQLocalDrizzle } from 'sqlocal/drizzle'
import * as Zus from 'zustand'

type LayerDbStore = {
	layerDb: LayerDb | null
}

export const LayerDbStore = Zus.createStore<LayerDbStore>(() => ({
	layerDb: null,
}))

const setupComplete$ = new Rx.Subject<void>()

export async function setup() {
	const { driver, overwriteDatabaseFile } = new SQLocalDrizzle({ databasePath: 'layers.sqlite3' })
	const hash = localStorage.getItem('layers-db-hash:v1')
	const headers = hash ? { 'X-Hash': hash } : undefined
	const res = await fetch(AR.link('/layers.sqlite3'), { headers })
	if (res.status === 304) {
		console.log('layers are up-to-date')
	} else {
		if (res.headers.get('Content-Type') !== 'application/x-sqlite3') {
			throw new Error('Invalid database file type: ' + res.headers.get('Content-Type'))
		}
		localStorage.setItem('layers-db-hash:v1', res.headers.get('X-Hash')!)
		const databaseFile = await res.blob()
		await overwriteDatabaseFile(databaseFile)
		console.log('database file updated')
	}
	LayerDbStore.setState({
		layerDb: drizzle(driver, {
			logger: {
				logQuery(query, params) {
					baseLogger.info({ params }, 'LDB: %s', query)
				},
			},
		}) as unknown as LayerDb,
	})
	setupComplete$.next()
	console.log('setup complete')
}

export function useLayerDb() {
	return Zus.useStore(LayerDbStore, state => state.layerDb)
}

export async function fetchLayerDb() {
	await Rx.firstValueFrom(setupComplete$)
	return LayerDbStore.getState().layerDb!
}
