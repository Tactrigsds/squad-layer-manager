import Rcon from '@/lib/rcon/rcon-core'
import SquadRcon from '@/lib/rcon/squad-rcon'
import { baseLogger, setupLogger } from '@/server/logger'
import * as M from '@/models'
import { setupEnv } from '@/server/env'

const PORTS = process.argv[2].split(',').map((x) => parseInt(x))

await main()
async function main() {
	setupEnv()
	await setupLogger()
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
		const layer1: M.MiniLayer = M.getMiniLayerFromId(
			M.getLayerId({
				Level: 'Yehorivka',
				LayerVersion: 'V1',
				Gamemode: 'RAAS',
				Faction_1: 'USA',
				Faction_2: 'RGF',
				SubFac_1: 'CombinedArms',
				SubFac_2: 'CombinedArms',
			})
		)

		await squadRcon.setNextLayer(ctx, layer1)
		const returned = (await squadRcon.serverStatus.get(ctx)).value.nextLayer
		if (returned && returned.code === 'unknown') {
			throw new Error('nextLayer1 is unknown')
		}
		const returnedLayer = returned?.layer

		ctx.log.info('returned layer: %o', returnedLayer)
		ctx.log.info('expected layer: %o', layer1)
	}
}
