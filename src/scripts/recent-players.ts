import * as Env from '@/server/env.ts'
import { ensureLoggerSetup } from '@/server/logger.ts'
import * as Cli from '@/server/systems/cli.ts'

await Cli.ensureCliParsed()
Env.ensureEnvSetup()
ensureLoggerSetup()

const ENV = Env.getEnvBuilder({ ...Env.groups.battlemetrics })()

const { BM_HOST, BM_PAT } = ENV

const serverId = '13961631'
const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
const now = new Date().toISOString()

console.log(`Fetching players on server ${serverId} from the last 6 hours...`)
console.log(`Time range: ${sixHoursAgo} to ${now}`)

// Fetch players with sessions filter and include flags
const playersResponse = await fetch(
	`${BM_HOST}/players?filter[servers]=${serverId}&filter[lastSeen]=${sixHoursAgo}:${now}&include=flagPlayer,playerFlag&fields[playerFlag]=name,color,description,icon`,
	{
		headers: {
			Authorization: `Bearer ${BM_PAT}`,
			Accept: 'application/json',
		},
	},
)

if (!playersResponse.ok) {
	throw new Error(`BattleMetrics API error: ${playersResponse.status} ${playersResponse.statusText}`)
}

const playersData = await playersResponse.json()

console.log('\nFull response:', JSON.stringify(playersData, null, 2))

// Process players and their flags
if (playersData.data && Array.isArray(playersData.data)) {
	// Create a map of playerFlags from included data
	const playerFlagsMap = new Map()
	if (playersData.included && Array.isArray(playersData.included)) {
		for (const item of playersData.included) {
			if (item.type === 'playerFlag') {
				playerFlagsMap.set(item.id, {
					name: item.attributes?.name,
					color: item.attributes?.color,
					description: item.attributes?.description,
					icon: item.attributes?.icon,
				})
			}
		}
	}

	console.log(`\n=== Summary ===`)
	console.log(`Total players: ${playersData.data.length}`)
	console.log('\nPlayers:')

	for (const player of playersData.data) {
		console.log(`  - ${player.attributes?.name} (ID: ${player.id})`)
		console.log(`    Last seen: ${player.attributes?.updatedAt}`)

		// Get flags for this player
		const flagPlayers = playersData.included?.filter(
			(item: any) =>
				item.type === 'flagPlayer'
				&& item.relationships?.player?.data?.id === player.id,
		) || []

		if (flagPlayers.length > 0) {
			console.log(`    Flags:`)
			for (const flagPlayer of flagPlayers) {
				const flagId = flagPlayer.relationships?.playerFlag?.data?.id
				const flag = playerFlagsMap.get(flagId)
				if (flag) {
					console.log(`      • ${flag.name} (${flag.color})${flag.description ? ` - ${flag.description}` : ''}`)
				}
			}
		} else {
			console.log(`    Flags: None`)
		}
	}
}
