import * as Env from '@/server/env.ts'
import { ensureLoggerSetup } from '@/server/logger.ts'
import * as Cli from '@/systems/cli.server'

await Cli.ensureCliParsed()
Env.ensureEnvSetup()
ensureLoggerSetup()

const ENV = Env.getEnvBuilder({ ...Env.groups.battlemetrics })()

const { BM_HOST, BM_PAT } = ENV

const serverId = '13961631'

const now = new Date().toISOString()
console.log(`Fetching current playerlist for server ${serverId} at ${now}...`)

async function bmFetch(url: URL) {
	const response = await fetch(url.toString(), {
		headers: { Authorization: `Bearer ${BM_PAT}`, Accept: 'application/json' },
	})
	if (!response.ok) {
		const body = await response.text()
		throw new Error(`BattleMetrics API error: ${response.status} ${response.statusText}\n${body}`)
	}
	return response.json()
}

// Request 1: server info with current player list
const serverUrl = new URL(`${BM_HOST}/servers/${serverId}`)
serverUrl.searchParams.set('include', 'player')
const serverData = await bmFetch(serverUrl)

const players: any[] = (serverData.included ?? []).filter((item: any) => item.type === 'player')
const playerIds = players.map(p => p.id)

// Request 2+: fetch each player individually (in parallel) to get their flags
const playerDetails = await Promise.all(playerIds.map(id => {
	const u = new URL(`${BM_HOST}/players/${id}`)
	u.searchParams.set('include', 'flagPlayer,playerFlag')
	u.searchParams.set('fields[playerFlag]', 'name,color,description')
	return bmFetch(u)
}))

const flagsByPlayer = new Map<string, string[]>()
for (const detail of playerDetails) {
	const included: any[] = detail.included ?? []
	const flagDefs = new Map(included.filter((i: any) => i.type === 'playerFlag').map((f: any) => [f.id, f.attributes]))
	for (const fp of included.filter((i: any) => i.type === 'flagPlayer')) {
		const playerId = fp.relationships?.player?.data?.id
		const flagId = fp.relationships?.playerFlag?.data?.id
		const flag = flagDefs.get(flagId)
		if (playerId && flag) {
			if (!flagsByPlayer.has(playerId)) flagsByPlayer.set(playerId, [])
			flagsByPlayer.get(playerId)!.push(flag.name)
		}
	}
}

console.log(`\n=== Current Players (${serverData.data.attributes.players}) ===`)
for (const player of players) {
	const flags = flagsByPlayer.get(player.id)
	const flagStr = flags?.length ? ` [${flags.join(', ')}]` : ''
	console.log(`  - ${player.attributes?.name} (ID: ${player.id})${flagStr}`)
}
