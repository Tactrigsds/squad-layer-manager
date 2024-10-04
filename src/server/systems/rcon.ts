import * as M from '@/models'
import { z } from 'zod'

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
	// could parse currentMap and currentFactions more strictly here, and apply an enum for allowed values
	currentMap: z.string(),
	currentFactions: z.string(),
	nextMap: z.string(),
	nextFactions: z.string(),
	isLicensedServer: z.boolean(),
	infoUpdatedAt: z.string().datetime(),
})

export type ServerInfoRaw = z.infer<typeof ServerInfoSchema>

export async function fetchServerStatus(): Promise<M.ServerStatus> {
	const res = await fetch('https://tt-roles.tacticaltriggernometry.com/api/serverinfo')
	if (!res.ok) {
		throw new Error('Failed to fetch player list')
	}
	const rawInfo = ServerInfoSchema.parse(await res.json())
	const currentLayer = parseLayer(rawInfo.currentMap, rawInfo.currentFactions)
	const nextLayer = parseLayer(rawInfo.nextMap, rawInfo.nextFactions)
	return {
		...rawInfo,
		currentLayer,
		nextLayer,
	}
}

type ParsedFaction = {
	faction: string
	subFaction: string
}
function parseLayer(layer: string, factions: string): M.MiniLayer {
	const { level, gamemode, version } = M.parseLayerString(layer)
	const [faction1, faction2] = parseLayerFactions(factions)
	const layerIdArgs: M.LayerIdArgs = {
		Level: level,
		Gamemode: gamemode,
		LayerVersion: version,
		Faction_1: faction1.faction,
		SubFac_1: faction1.subFaction as M.MiniLayer['SubFac_1'],
		Faction_2: faction2.faction,
		SubFac_2: faction2.subFaction as M.MiniLayer['SubFac_2'],
	}
	const miniLayer: M.MiniLayer = {
		...layerIdArgs,
		id: M.getLayerId(layerIdArgs),
		Layer: layer,
	} as M.MiniLayer
	return miniLayer
}

function parseLayerFactions(factionsRaw: string) {
	const parsedFactions: ParsedFaction[] = []
	for (const factionRaw of factionsRaw.split(/\s/)) {
		const [faction, subFaction] = factionRaw.split('+')
		parsedFactions.push({
			faction: faction.trim(),
			subFaction: subFaction.trim(),
		})
	}
	return parsedFactions as [ParsedFaction, ParsedFaction]
}
