import * as RM from '@/lib/rcon/squad-models'
import * as M from '@/models'
import { z } from 'zod'

export const GetPlayersResponseSchema = z.object({ players: z.array(RM.PlayerSchema) })
export async function getPlayers() {
	const res = await fetch('https://tt-roles.tacticaltriggernometry.com/api/playerlist')
	if (!res.ok) {
		throw new Error('Failed to fetch player list')
	}
	const { players } = GetPlayersResponseSchema.parse(await res.json())
	return players
}
export async function fetchServerStatus(): Promise<RM.ServerStatus> {
	const res = await fetch('https://tt-roles.tacticaltriggernometry.com/api/serverinfo')
	if (!res.ok) {
		throw new Error('Failed to fetch player list')
	}
	const rawInfo = RM.ServerStatusRawSchema.parse(await res.json())
	const currentLayer = parseLayer(rawInfo.currentMap, rawInfo.currentFactions)
	const nextLayer = parseLayer(rawInfo.nextMap, rawInfo.nextFactions)
	const status = {
		name: rawInfo.name,
		maxPlayers: rawInfo.maxPlayers,
		reserveSlots: rawInfo.reserveSlots,
		currentPlayers: rawInfo.currentPlayers,
		currentPlayersInQueue: rawInfo.currentPlayersInQueue,
		currentLayer,
		nextLayer,
	}
	return status
}

type ParsedFaction = {
	faction: string
	subFaction: string | null
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
	const miniLayer = {
		...layerIdArgs,
		id: M.getLayerId(layerIdArgs),
		Layer: layer,
	} as M.MiniLayer
	return M.MiniLayerSchema.parse(miniLayer)
}

function parseLayerFactions(factionsRaw: string) {
	const parsedFactions: ParsedFaction[] = []
	for (const factionRaw of factionsRaw.split(/\s/)) {
		const [faction, subFaction] = factionRaw.split('+')
		parsedFactions.push({
			faction: faction.trim(),
			subFaction: subFaction?.trim() ?? null,
		})
	}
	return parsedFactions as [ParsedFaction, ParsedFaction]
}
