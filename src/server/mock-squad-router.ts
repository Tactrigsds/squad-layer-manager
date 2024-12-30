import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { MockSquadRcon, ServerState } from '@/lib/rcon/rcon-squad-mock.ts'
import { PlayerSchema, SquadSchema } from '@/lib/rcon/squad-models'
import * as M from '@/models'
import * as SquadServer from '@/server/systems/squad-server'

import { procedure, router } from './trpc'

export let mockSquadRouter: ReturnType<typeof setupMockSquadRouter>['router']

export function setupMockSquadRouter() {
	const server = SquadServer.mockServer!
	const _mockSquadRouter = router({
		connectPlayer: procedure.input(PlayerSchema).mutation(({ input }) => {
			server.connectPlayer(input)
		}),
		createSquad: procedure
			.input(
				z.object({
					squadName: SquadSchema.shape.squadName,
					creatorName: SquadSchema.shape.creatorName,
				})
			)
			.mutation(async ({ input }) => {
				const player = server.serverState.players.find((p) => p.name === input.creatorName)
				if (!player) {
					throw new TRPCError({
						code: 'BAD_REQUEST',
						message: `player with name ${input.creatorName} doesn't exist`,
					})
				}
				const squadId = server.serverState.squads.length + 1
				await server.createSquad({
					...input,
					size: 1,
					locked: false,
					squadID: squadId,
					teamID: player.teamID,
				})
			}),
		disconnectPlayer: procedure.input(PlayerSchema.shape.playerID).mutation(({ input }) => {
			server.disconnectPlayer(input)
		}),
		removeSquad: procedure.input(SquadSchema.shape.squadID).mutation(({ input }) => {
			server.removeSquad(input)
		}),
		getCurrentMap: procedure.query(async () => {
			return await server.getCurrentLayer()
		}),
		getNextMap: procedure.query(async () => {
			return await server.getNextLayer()
		}),
		getListPlayers: procedure.query(async () => {
			return await server.getListPlayers()
		}),
		getSquads: procedure.query(async () => {
			return await server.getSquads()
		}),
		broadcast: procedure.input(z.string()).mutation(({ input }) => {
			server.broadcast(input)
		}),
		setFogOfWar: procedure.input(z.string()).mutation(({ input }) => {
			server.setFogOfWar(input)
		}),
		warn: procedure.input(z.object({ anyID: z.string(), message: z.string() })).mutation(({ input }) => {
			server.warn(input.anyID, input.message)
		}),
		ban: procedure
			.input(
				z.object({
					anyID: z.string(),
					banLength: z.string(),
					message: z.string(),
				})
			)
			.mutation(({ input }) => {
				server.ban(input.anyID, input.banLength, input.message)
			}),
		switchTeam: procedure.input(z.number()).mutation(({ input }) => {
			server.switchTeam(input)
		}),
		leaveSquad: procedure.input(z.number()).mutation(({ input }) => {
			server.leaveSquad(input)
		}),
		setNextLayer: procedure.input(M.MiniLayerSchema).mutation(({ input }) => {
			server.setNextLayer(input)
		}),
		getServerState: procedure.query(async () => {
			return {
				currentMap: await server.getCurrentLayer(),
				nextMap: await server.getNextLayer(),
				players: await server.getListPlayers(),
				squads: await server.getSquads(),
				fogOfWar: server.serverState.fogOfWar,
			} as ServerState
		}),
		endMatch: procedure.mutation(async () => {
			await server.endGame()
		}),
	})
	mockSquadRouter = _mockSquadRouter

	return { router: _mockSquadRouter }
}
