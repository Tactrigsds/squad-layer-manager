import * as DB from '@/server/db'
import { baseLogger, setupLogger } from '@/server/logger'
import * as C from '@/server/context'
import { z } from 'zod'
import * as M from '@/models'
import { setupEnv, ENV } from '@/server/env'
import * as DH from '@/lib/display-helpers'
import fs from 'fs'
import Rcon from '@/lib/rcon/rcon-core'
import SquadRcon from '@/lib/rcon/squad-rcon'
import * as Schema from '@/server/schema'

setupEnv()
await setupLogger()
DB.setupDatabase()

const ctx = DB.addPooledDb({ log: baseLogger })
// setup
const config = {
	host: ENV.RCON_HOST,
	port: ENV.RCON_PORT,
	password: ENV.RCON_PASSWORD,
}

const rcon = new Rcon(config)
await rcon.connect(ctx)
const squadRcon = new SquadRcon(ctx, rcon)

await main()

async function main() {
	console.log(process.argv)
	const outfileArg = process.argv[2]
	if (!outfileArg) return console.error('Please provide a valid output file path')
	const layers = await ctx.db().select({ id: Schema.layers.id }).from(Schema.layers)
	fs.writeFileSync(outfileArg, 'id,layer_name\n')
	for (const { id } of layers) {
		await squadRcon.setNextLayer(ctx, M.getMiniLayerFromId(id))
		const { value: status } = await squadRcon.serverStatus.get(ctx, { ttl: 0 })
		if ((status as any).nextLayer.layer.id !== id) {
			fs.appendFileSync(outfileArg, `${id},${DH.toShortLayerNameFromId(id)}\n`)
		}
	}
}
