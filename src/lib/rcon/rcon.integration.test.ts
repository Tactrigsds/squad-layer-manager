import * as M from '@/models.ts'
import * as C from '@/server/context'
import * as Env from '@/server/env'
import { baseLogger, ensureLoggerSetup } from '@/server/logger'
import { Mutex } from 'async-mutex'
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import Rcon from './core-rcon.ts'
import SquadRcon from './squad-rcon.ts'

let squadRcon!: SquadRcon
let rcon!: Rcon
let baseCtx: C.Log

beforeAll(async () => {
	Env.ensureEnvSetup()
	ensureLoggerSetup()
	const ENV = Env.getEnvBuilder({ ...Env.groups.rcon })()
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
	const layer1Id = M.getLayerId({
		Gamemode: 'RAAS',
		Map: 'Fallujah',
		LayerVersion: 'V1',
		Faction_1: 'RGF',
		Faction_2: 'USA',
		Unit_1: 'CombinedArms',
		Unit_2: 'CombinedArms',
	})
	// make sure currently set next layer is not the same as the one we are going to set
	await squadRcon.setNextLayer(ctx, layer1Id)

	const status1 = (await squadRcon.serverStatus.get(ctx)).value
	expect(status1.code).toBe('ok')
	if (status1.code !== 'ok') throw new Error('Failed to get server status')
	const nextLayer1 = status1.data.nextLayer
	expect(nextLayer1).toBeDefined()
	if (nextLayer1!.code === 'raw') {
		throw new Error('nextLayer1 is unknown')
	}
	expect(nextLayer1!.id).toBe(layer1Id)
	const layer2Id = M.getLayerId({
		Gamemode: 'RAAS',
		Map: 'GooseBay',
		LayerVersion: 'V1',
		Faction_1: 'USA',
		Unit_1: 'CombinedArms',
		Faction_2: 'RGF',
		Unit_2: 'CombinedArms',
	})
	await squadRcon.setNextLayer(ctx, layer2Id)
	const status2 = (await squadRcon.serverStatus.get(ctx)).value
	expect(status2.code).toBe('ok')
	if (status2.code !== 'ok') throw new Error('Failed to get server status')
	const nextLayer2 = status2.data.nextLayer
	expect(nextLayer2).toBeDefined()

	if (nextLayer2!.code === 'raw') {
		throw new Error('nextLayer2 is unknown')
	}
	expect(nextLayer2!.id).toBe(layer2Id)
})

test('can get server status', async () => {
	const ctx = C.includeLogProperties(baseCtx, {
		test: 'can get server status',
	})
	const status = await squadRcon.serverStatus.get(ctx)
	ctx.log.info('server status %o', status)
	expect(status).toBeDefined()
})
