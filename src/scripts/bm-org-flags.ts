import * as Env from '@/server/env.ts'
import { ensureLoggerSetup } from '@/server/logger.ts'
import * as Cli from '@/systems/cli.server'

await Cli.ensureCliParsed()
Env.ensureEnvSetup()
ensureLoggerSetup()

const ENV = Env.getEnvBuilder({ ...Env.groups.battlemetrics })()

const { BM_HOST, BM_PAT, BM_ORG_ID } = ENV

console.log(`Fetching org flags for org ${BM_ORG_ID}...`)

const response = await fetch(
	`${BM_HOST}/player-flags?page[size]=100&filter[personal]=false&include=organization`,
	{
		headers: {
			Authorization: `Bearer ${BM_PAT}`,
			Accept: 'application/json',
		},
	},
)

const data = await response.json()

if (!response.ok) {
	console.error('Response:', JSON.stringify(data, null, 2))
	throw new Error(`BattleMetrics API error: ${response.status} ${response.statusText}`)
}

if (data.data && Array.isArray(data.data)) {
	const orgFlags = data.data.filter((flag: any) => flag.relationships?.organization?.data?.id === BM_ORG_ID)
	console.log(`\nFound ${orgFlags.length} org flag(s) for org ${BM_ORG_ID}:\n`)
	for (const flag of orgFlags) {
		console.log(`  [${flag.id}] ${flag.attributes?.name}`)
		if (flag.attributes?.color) console.log(`    Color: ${flag.attributes.color}`)
		if (flag.attributes?.description) console.log(`    Description: ${flag.attributes.description}`)
		if (flag.attributes?.icon) console.log(`    Icon: ${flag.attributes.icon}`)
		console.log()
	}
} else {
	console.log('No flags found.')
}
