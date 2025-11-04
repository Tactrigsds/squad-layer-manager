import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import { baseLogger, ensureLoggerSetup } from '@/server/logger'
import * as SquadRcon from '@/server/systems/squad-rcon.ts'
import { Mutex } from 'async-mutex'
import * as Rx from 'rxjs'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import Rcon from './core-rcon.ts'

let rcon!: Rcon
let baseCtx: CS.Log & C.Db & C.SquadRcon

const buildEnv = Env.getEnvBuilder({ ...Env.groups.testRcon })
let ENV!: ReturnType<typeof buildEnv>

const sub = new Rx.Subscription()

beforeAll(async () => {
	Env.ensureEnvSetup()
	ENV = buildEnv()
	ensureLoggerSetup()
	await DB.setup()
	rcon = new Rcon({
		serverId: 'test-server',
		settings: {
			host: ENV.TEST_RCON_HOST,
			port: ENV.TEST_RCON_PORT,
			password: ENV.TEST_RCON_PASSWORD,
		},
	})
	await rcon.connect(baseCtx)
	const ctx = DB.addPooledDb({
		log: baseLogger,
		rcon,
	})

	baseCtx = {
		...ctx,
		server: SquadRcon.initSquadRcon(ctx, 'test-server', {
			host: ENV.TEST_RCON_HOST,
			port: ENV.TEST_RCON_PORT,
			password: ENV.TEST_RCON_PASSWORD,
		}, sub),
		serverId: 'test-server',
	}
})

afterAll(() => {
	sub.unsubscribe()
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
	const layer1Id = L.getKnownLayerId({
		Gamemode: 'RAAS',
		Map: 'Fallujah',
		LayerVersion: 'V1',
		Faction_1: 'RGF',
		Faction_2: 'USA',
		Unit_1: 'CombinedArms',
		Unit_2: 'CombinedArms',
	})!
	// make sure currently set next layer is not the same as the one we are going to set
	await SquadRcon.setNextLayer(ctx, layer1Id)

	const status1 = await SquadRcon.getNextLayer(ctx)
	expect(status1.code).toBe('ok')
	if (status1.code !== 'ok') throw new Error('Failed to get server status')
	const nextLayer1 = status1.layer
	expect(nextLayer1).toBeDefined()
	if (!L.isKnownLayer(nextLayer1!)) {
		throw new Error('nextLayer1 is unknown')
	}
	expect(nextLayer1!.id).toBe(layer1Id)
	const layer2Id = L.getKnownLayerId({
		Gamemode: 'RAAS',
		Map: 'GooseBay',
		LayerVersion: 'V1',
		Faction_1: 'USA',
		Unit_1: 'CombinedArms',
		Faction_2: 'RGF',
		Unit_2: 'CombinedArms',
	})!
	await SquadRcon.setNextLayer(ctx, layer2Id)
	const status2 = await ctx.server.layersStatus.get(ctx)
	expect(status2.code).toBe('ok')
	if (status2.code !== 'ok') throw new Error('Failed to get server status')
	const nextLayer2 = status2.data.nextLayer
	expect(nextLayer2).toBeDefined()

	if (!L.isKnownLayer(nextLayer2!)) {
		throw new Error('nextLayer2 is unknown')
	}
	expect(nextLayer2!.id).toBe(layer2Id)
})

test('can get server status', async () => {
	const ctx = C.includeLogProperties(baseCtx, {
		test: 'can get server status',
	})
	const status = await ctx.server.layersStatus.get(ctx)
	ctx.log.info('server status %o', status)
	expect(status).toBeDefined()
})
