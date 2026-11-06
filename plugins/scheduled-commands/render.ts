import { formatInTimeZone } from 'date-fns-tz'

import * as L from 'slm/models/layer'
import * as MH from 'slm/models/match-history'
import type * as P from 'slm/plugin'
import * as MatchHistory from 'slm/systems/match-history'
import * as Settings from 'slm/systems/settings'
import * as SquadRcon from 'slm/systems/squad-rcon'

import type manifest from './plugin.ts'
import type * as Vars from './variables.ts'

type Ctx = P.ServerCtx<typeof manifest>

/**
 * The values of the variables in `used`, read when a run starts. A value that cannot be read, such as the next layer
 * while rcon is down, renders empty. Only the sources a used variable needs are read.
 */
export async function readVariables(ctx: Ctx, taskName: string, used: ReadonlySet<Vars.Variable>): Promise<Record<string, string>> {
	const vars: Partial<Record<Vars.Variable, string>> = {}
	const uses = (...names: Vars.Variable[]) => names.some((n) => used.has(n))

	if (used.has('task')) vars.task = taskName
	if (used.has('server')) vars.server = Settings.listServers().find((s) => s.id === ctx.serverId)?.displayName ?? ctx.serverId
	if (used.has('time')) vars.time = formatInTimeZone(Date.now(), Settings.server(ctx.serverId)?.timeZone ?? 'UTC', 'HH:mm')

	if (uses('layer', 'fullLayerName', 'map', 'gamemode', 'team1', 'team2', 'matchId', 'matchMinutes')) {
		const match = await MatchHistory.getCurrentMatch(ctx)
		if (match) {
			vars.matchId = String(match.historyEntryId)
			const layer = toLayerOrNull(match.layerId)
			vars.layer = layer?.Layer ?? ''
			vars.fullLayerName = layer ? fullLayerName(layer) : ''
			vars.map = layer?.Map ?? ''
			vars.gamemode = layer?.Gamemode ?? ''
			vars.team1 = MH.getTeamFaction(match, 1) ?? ''
			vars.team2 = MH.getTeamFaction(match, 2) ?? ''
			if (match.status === 'in-progress' && match.startTime) {
				vars.matchMinutes = String(Math.floor((Date.now() - match.startTime.getTime()) / 60_000))
			}
		}
	}

	if (uses('nextLayer', 'nextMap')) {
		const status = await SquadRcon.getLayerStatus(ctx)
		const next = status.code === 'ok' ? status.data.nextLayer : null
		if (status.code !== 'ok') ctx.log.warn('could not read the next layer: %s', status.msg)
		if (next) {
			vars.nextLayer = next.Layer
			vars.nextMap = next.Map ?? ''
		}
	}

	if (uses('players', 'maxPlayers', 'queue')) {
		const info = await SquadRcon.getServerInfo(ctx)
		if (info.code === 'ok') {
			vars.players = String(info.data.playerCount)
			vars.maxPlayers = String(info.data.maxPlayerCount)
			vars.queue = String((info.data.queueLength ?? 0) + (info.data.reserveQueueLength ?? 0))
		} else ctx.log.warn('could not read server info: %s', info.msg)
	}

	return vars
}

// The layer, then each team's faction-unit, joined by `__`. Safe as a file name on every OS and in a URL: anything
// outside [A-Za-z0-9._-] in a part becomes `_`.
function fullLayerName(layer: L.UnvalidatedLayer) {
	const safe = (part: string) => part.replace(/[^A-Za-z0-9._-]/g, '_')
	const team = (faction: string | undefined, unit: string | undefined) =>
		faction ? (unit ? `${safe(faction)}-${safe(unit)}` : safe(faction)) : null
	return [safe(layer.Layer), team(layer.Faction_1, layer.Unit_1), team(layer.Faction_2, layer.Unit_2)]
		.filter((part) => part !== null)
		.join('__')
}

function toLayerOrNull(id: L.LayerId) {
	try {
		return L.toLayer(id)
	} catch {
		return null
	}
}
