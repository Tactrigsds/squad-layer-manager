import * as Env from '@/server/env.ts'
import { ensureLoggerSetup } from '@/server/logger.ts'
import * as Cli from '@/server/systems/cli.ts'

await Cli.ensureCliParsed()
Env.ensureEnvSetup()
ensureLoggerSetup()

const ENV = Env.getEnvBuilder({ ...Env.groups.battlemetrics })()

const { BM_HOST, BM_PAT } = ENV
// Test with a specific player to avoid rate limits
const testPlayerId = '963447959'
console.log(`Fetching player ${testPlayerId} with flags...`)

const response = await fetch(
	`${BM_HOST}/players/${testPlayerId}?include=flagPlayer,playerFlag&fields[playerFlag]=name,color,description,icon`,
	{
		headers: {
			Authorization: `Bearer ${BM_PAT}`,
			Accept: 'application/json',
		},
	},
)

if (!response.ok) {
	throw new Error(`BattleMetrics API error: ${response.status} ${response.statusText}`)
}

const data = await response.json()
console.log('Full response:', JSON.stringify(data, null, 2))

// icon url example https://cdn.battlemetrics.com/app/assets/verified_user-24px.bb33b.svg
