import { Mutex } from 'async-mutex'
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import * as C from '@/server/context'
import { ENV, setupEnv } from '@/server/env'
import { baseLogger, setupLogger } from '@/server/logger'

import Rcon from './rcon-core'
import SquadRcon from './squad-rcon'

let squadRcon!: SquadRcon
let rcon!: Rcon
let baseCtx: C.Log

beforeAll(async () => {
	setupEnv()
	await setupLogger()
	baseCtx = { log: baseLogger }
	rcon = new Rcon({ host: ENV.RCON_HOST, port: ENV.RCON_PORT, password: ENV.RCON_PASSWORD })
	await rcon.connect(baseCtx)
	squadRcon = new SquadRcon(rcon)
})

const mtx = new Mutex()
let release: (() => void) | undefined
beforeEach(async () => {
	release = await mtx.acquire()
})
afterEach(() => {
	release?.()
})

test('Rcon should be connected', () => {
	expect(rcon.connected).toBe(true)
})

test('can get current layer', async () => {
	const ctx = C.includeLogProperties(baseCtx, { test: 'can get current layer' })
	const layer = await squadRcon.getCurrentLayer(ctx)
	expect(layer).toBeDefined()
})

test('can set next layer', async () => {
	const ctx = C.includeLogProperties(baseCtx, { test: 'can set next layer' })
	// make sure currently set next layer is not the same as the one we are going to set
	await squadRcon.setNextLayer(ctx, {
		Layer: 'Fallujah_RAAS_v1',
		Faction_1: 'RGF',
		Faction_2: 'USA',
		SubFac_1: 'CombinedArms',
		SubFac_2: 'CombinedArms',
	})

	const nextLayerOptions = {
		Layer: 'GooseBay_RAAS_v1',
		Faction_1: 'USA',
		SubFac_1: 'CombinedArms',
		Faction_2: 'RGF',
		SubFac_2: 'CombinedArms',
	}
	await squadRcon.setNextLayer(ctx, nextLayerOptions)
	const nextLayer = await squadRcon.getNextLayer(ctx)
	expect(nextLayer).toBeDefined()
	expect(nextLayer?.Layer).toBe(nextLayerOptions.Layer)
})

test('can get server status', async () => {
	const ctx = C.includeLogProperties(baseCtx, { test: 'can get server status' })
	const status = await squadRcon.getServerStatus(ctx)
	ctx.log.info('server status %o', status)
	expect(status).toBeDefined()
})
