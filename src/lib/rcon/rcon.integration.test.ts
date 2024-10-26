import { beforeAll, expect, test } from 'vitest'

import { ENV, setupEnv } from '@/server/env'
import { baseLogger, setupLogger } from '@/server/logger'

import Rcon from './rcon-core'
import SquadRcon from './rcon-squad'

let rcon!: SquadRcon

beforeAll(async () => {
	setupEnv()
	await setupLogger()
	rcon = new SquadRcon({ host: ENV.RCON_HOST, port: ENV.RCON_PORT, password: ENV.RCON_PASSWORD }, baseLogger)
	await rcon.connect()
})

test('Rcon should be connected', () => {
	expect(rcon.connected).toBe(true)
})

test('can get current layer', async () => {
	const layer = await rcon.getCurrentLayer()
	expect(layer).toBeDefined()
})

test.only('can set next layer', async () => {
	const nextLayerOptions = {
		Layer: 'GooseBay_RAAS_v1',
		Faction_1: 'USA',
		SubFac_1: 'CombinedArms',
		Faction_2: 'RGF',
		SubFac_2: 'CombinedArms',
	}
	await rcon.setNextLayer(nextLayerOptions)
	const nextLayer = await rcon.getNextLayer()
	expect(nextLayer).toBeDefined()
	expect(nextLayer?.Layer).toBe(nextLayerOptions.Layer)
})
