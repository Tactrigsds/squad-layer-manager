import { Observable } from 'rxjs'

import { resolvePromises } from '@/lib/async'
import { MockSquadRcon } from '@/lib/rcon/rcon-squad-mock'
import * as SM from '@/lib/rcon/squad-models'

import { ENV } from '../env'
import { baseLogger } from '../logger'

export let server!: SM.ISquadRcon
export let mockServer: MockSquadRcon | undefined
export let squadEvent$: Observable<SM.SquadEvent>

export async function setupSquadServer() {
	if (ENV.MOCK_SQUAD_SERVER) {
		const log = baseLogger
		mockServer = new MockSquadRcon({}, { log })
		server = mockServer
		squadEvent$ = mockServer.event$
	} else {
		throw new Error('implement actual squad server setup')
	}
	await server.connect()
}

export async function getServerStatus() {
	return (await resolvePromises({
		name: server.info.name,
		currentLayer: server.getCurrentLayer(),
		nextLayer: server.getNextLayer(),
		currentPlayers: server.getListPlayers().then((p) => p.length),
		currentPlayersInQueue: server.getPlayerQueueLength(),
		maxPlayers: server.info.maxPlayers,
	})) as SM.ServerStatus
}
