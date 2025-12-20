import * as Env from '@/server/env.ts'
import { ensureLoggerSetup } from '@/server/logger.ts'
import * as Cli from '@/systems/cli.server'

await Cli.ensureCliParsed()
Env.ensureEnvSetup()
ensureLoggerSetup()

const ENV = Env.getEnvBuilder({ ...Env.groups.battlemetrics })()

const { BM_HOST, BM_PAT, BM_ORG_ID } = ENV

console.log(`Fetching servers and player flags for organization ${BM_ORG_ID}...`)

// Fetch organization servers
console.log('\n=== Fetching Servers ===')
const serversResponse = await fetch(
	`${BM_HOST}/servers?filter[organizations]=${BM_ORG_ID}`,
	{
		headers: {
			Authorization: `Bearer ${BM_PAT}`,
			Accept: 'application/json',
		},
	},
)

if (!serversResponse.ok) {
	throw new Error(`BattleMetrics API error (servers): ${serversResponse.status} ${serversResponse.statusText}`)
}

const serversData = await serversResponse.json()
console.log('Servers:', JSON.stringify(serversData, null, 2))

// Fetch player flags (tags)
console.log('\n=== Fetching Player Flags (Tags) ===')
const flagsResponse = await fetch(
	`${BM_HOST}/player-flags`,
	{
		headers: {
			Authorization: `Bearer ${BM_PAT}`,
			Accept: 'application/json',
		},
	},
)

if (!flagsResponse.ok) {
	throw new Error(`BattleMetrics API error (flags): ${flagsResponse.status} ${flagsResponse.statusText}`)
}

const flagsData = await flagsResponse.json()
console.log('Player Flags:', JSON.stringify(flagsData, null, 2))
