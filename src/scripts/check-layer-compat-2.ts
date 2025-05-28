import Rcon from '@/lib/rcon/core-rcon.ts'
import SquadRcon from '@/lib/rcon/squad-rcon.ts'
import * as M from '@/models'
import { ensureEnvSetup } from '@/server/env'
import { baseLogger, ensureLoggerSetup } from '@/server/logger'

const PORTS = process.argv[2].split(',').map((x) => parseInt(x))

await main()
async function main() {
	ensureEnvSetup()
	await ensureLoggerSetup()
	const ctx = { log: baseLogger }

	ctx.log.info('Making HTTP requests to containers...')
	for (const port of PORTS) {
		const rcon = new Rcon({
			host: '0.0.0.0',
			port: port,
			password: 'testpassword',
		})
		await rcon.connect(ctx)
		const squadRcon = new SquadRcon(ctx, rcon)
		const layer1 = M.getLayerId({
			Map: 'Yehorivka',
			LayerVersion: 'V1',
			Gamemode: 'RAAS',
			Faction_1: 'USA',
			Faction_2: 'RGF',
			Unit_1: 'CombinedArms',
			Unit_2: 'CombinedArms',
		})

		await squadRcon.setNextLayer(ctx, layer1)
		const returnedRes = (await squadRcon.serverStatus.get(ctx)).value
		if (returnedRes.code === 'err:rcon') throw new Error('RCON error')
		const returned = returnedRes.data
		const returnedLayer = returned?.currentLayer

		ctx.log.info('returned layer: %o', returnedLayer)
		ctx.log.info('expected layer: %o', layer1)
	}
}
