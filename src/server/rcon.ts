import { z } from 'zod'
import {sleep} from '@/lib/promise.ts'
import { switchMap } from 'rxjs'

export const PlayerSchema = z.object({
	name: z.string(),
	steamId: z.string(),
	teamId: z.string(),
	isLeader: z.boolean(),
	role: z.string(),
})
export type Player = z.infer<typeof PlayerSchema>
export const GetPlayersResponseSchema = z.object({ players: z.array(PlayerSchema) })
export async function getPlayers() {
	const res = await fetch('https://tt-roles.tacticaltriggernometry.com/api/playerlist')
	if (!res.ok) {
		throw new Error('Failed to fetch player list')
	}
	const { players } = GetPlayersResponseSchema.parse(await res.json())
	return players
}

const ServerInfoSchema = z.object({
	name: z.string(),
	maxPlayers: z.number().int().positive(),
	reserveSlots: z.number().int().nonnegative(),
	currentPlayers: z.number().int().nonnegative(),
	currentPlayersInQueue: z.number().int().nonnegative(),
	currentVIPsInQueue: z.number().int().nonnegative(),
	gameMode: z.string(),
	currentMap: z.string(),
	currentFactions: z.string(),
	nextMap: z.string(),
	nextFactions: z.string(),
	isLicensedServer: z.boolean(),
	infoUpdatedAt: z.string().datetime(),
})

const pollServerinput = interval(5000).pipe(
switchMap(() => fetch('https://tt-roles.tacticaltriggernometry.com/api/serverinfo').then(res => res.json),
)
export type ServerInfo = z.infer<typeof ServerInfoSchema>

 async function fetchServerInfo() {
	const res = await fetch('https://tt-roles.tacticaltriggernometry.com/api/serverinfo')
	if (!res.ok) {
		throw new Error('Failed to fetch player list')
	}
	return ServerInfoSchema.parse(await res.json())
}
