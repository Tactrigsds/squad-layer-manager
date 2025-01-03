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
	const config = {
		host: ENV.RCON_HOST,
		port: ENV.RCON_PORT,
		password: ENV.RCON_PASSWORD,
	}
	rcon = new Rcon(config)
	await rcon.connect(baseCtx)
	squadRcon = new SquadRcon(baseCtx, rcon)
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

test('can set next layer', async () => {
	const ctx = C.includeLogProperties(baseCtx, { test: 'can set next layer' })
	const layer1Options = {
		Layer: 'Fallujah_RAAS_v1',
		Faction_1: 'RGF',
		Faction_2: 'USA',
		SubFac_1: 'CombinedArms',
		SubFac_2: 'CombinedArms',
	}
	// make sure currently set next layer is not the same as the one we are going to set
	await squadRcon.setNextLayer(ctx, layer1Options)

	const nextLayer1 = (await squadRcon.serverStatus.get(ctx)).value.nextLayer
	expect(nextLayer1).toBeDefined()
	if (nextLayer1!.code === 'unknown') {
		throw new Error('nextLayer1 is unknown')
	}
	expect(nextLayer1!.layer.Layer).toBe(layer1Options.Layer)
	const layer2Options = {
		Layer: 'GooseBay_RAAS_v1',
		Faction_1: 'USA',
		SubFac_1: 'CombinedArms',
		Faction_2: 'RGF',
		SubFac_2: 'CombinedArms',
	}
	await squadRcon.setNextLayer(ctx, layer2Options)
	const nextLayer2 = (await squadRcon.serverStatus.get(ctx)).value.nextLayer
	expect(nextLayer2).toBeDefined()

	if (nextLayer2!.code === 'unknown') {
		throw new Error('nextLayer2 is unknown')
	}
	expect(nextLayer2!.layer.Layer).toBe(layer2Options.Layer)
})

test('can get server status', async () => {
	const ctx = C.includeLogProperties(baseCtx, {
		test: 'can get server status',
	})
	const status = await squadRcon.serverStatus.get(ctx)
	ctx.log.info('server status %o', status)
	expect(status).toBeDefined()
})
