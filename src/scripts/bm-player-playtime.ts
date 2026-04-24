import * as Env from '@/server/env.ts'
import { ensureLoggerSetup } from '@/server/logger.ts'
import * as Cli from '@/systems/cli.server'

// Extract player identifier from positional args before commander parses process.argv
const rawArgs = process.argv.slice(2)
const knownFlagValues = new Set<number>()
for (let i = 0; i < rawArgs.length; i++) {
	if (rawArgs[i] === '--env-file' || rawArgs[i] === '--config') knownFlagValues.add(i + 1)
}
const positionalIdx = rawArgs.findIndex((a, i) => !a.startsWith('--') && !knownFlagValues.has(i))
const playerArg = positionalIdx !== -1 ? rawArgs[positionalIdx] : undefined

if (!playerArg) {
	console.error('Usage: bm-player-playtime.ts [--env-file <path>] <bmPlayerId|steamId>')
	process.exit(1)
}

// Remove positional from process.argv so commander doesn't reject it
process.argv.splice(2 + positionalIdx, 1)

await Cli.ensureCliParsed()
Env.ensureEnvSetup()
ensureLoggerSetup()

const ENV = Env.getEnvBuilder({ ...Env.groups.battlemetrics })()
const { BM_HOST, BM_PAT, BM_ORG_ID } = ENV

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

// Resolve BM player ID — if arg looks like a steamID (17-digit, starts with 7656) use match endpoint
async function resolvePlayerId(arg: string): Promise<{ id: string; name: string }> {
	const isSteamId = /^7656\d{13}$/.test(arg)
	if (isSteamId) {
		const matchUrl = new URL(`${BM_HOST}/players/match`)
		const response = await fetch(matchUrl.toString(), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${BM_PAT}`,
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				data: [{ type: 'identifier', attributes: { type: 'steamID', identifier: arg } }],
			}),
		})
		if (!response.ok) {
			const body = await response.text()
			throw new Error(`BattleMetrics API error: ${response.status} ${response.statusText}\n${body}`)
		}
		const data = await response.json()
		const player = data.data?.[0]?.relationships?.player?.data
		if (!player) throw new Error(`No player found for steamID ${arg}`)
		// fetch player name
		const playerData = await bmFetch(new URL(`${BM_HOST}/players/${player.id}`))
		return { id: player.id, name: playerData.data.attributes.name }
	}
	// Assume it's already a BM player ID
	const playerData = await bmFetch(new URL(`${BM_HOST}/players/${arg}`))
	return { id: arg, name: playerData.data.attributes.name }
}

// Fetch all org servers (paginated)
async function fetchOrgServers(): Promise<Array<{ id: string; name: string }>> {
	const servers: Array<{ id: string; name: string }> = []
	let url: URL | null = new URL(`${BM_HOST}/servers`)
	url.searchParams.set('filter[organizations]', BM_ORG_ID)
	url.searchParams.set('fields[server]', 'name')
	url.searchParams.set('page[size]', '100')

	while (url) {
		const data = await bmFetch(url)
		for (const s of data.data ?? []) {
			servers.push({ id: s.id, name: s.attributes?.name ?? s.id })
		}
		const nextUrl = data.links?.next
		url = nextUrl ? new URL(nextUrl) : null
	}
	return servers
}

const { id: playerId, name: playerName } = await resolvePlayerId(playerArg)
console.log(`\nFetching playtime for player: ${playerName} (ID: ${playerId})`)
console.log(`Org: ${BM_ORG_ID}\n`)

const servers = await fetchOrgServers()
console.log(`Found ${servers.length} org server(s). Fetching per-server playtime...\n`)

const results = await Promise.all(
	servers.map(async server => {
		try {
			const url = new URL(`${BM_HOST}/players/${playerId}/servers/${server.id}`)
			const data = await bmFetch(url)
			return { server, timePlayed: data.data?.attributes?.timePlayed ?? 0 }
		} catch {
			return { server, timePlayed: 0 }
		}
	}),
)

// Sort by time played descending, filter out zeros
const played = results.filter(r => r.timePlayed > 0).sort((a, b) => b.timePlayed - a.timePlayed)
const totalSeconds = results.reduce((sum, r) => sum + r.timePlayed, 0)

function formatDuration(seconds: number): string {
	const h = Math.floor(seconds / 3600)
	const m = Math.floor((seconds % 3600) / 60)
	return `${h}h ${m}m`
}

console.log(`=== Playtime for ${playerName} across org servers ===\n`)
if (played.length === 0) {
	console.log('  No playtime recorded on any org server.')
} else {
	for (const { server, timePlayed } of played) {
		console.log(`  ${formatDuration(timePlayed).padEnd(10)} ${server.name}`)
	}
}
console.log(`\n  Total: ${formatDuration(totalSeconds)} across ${played.length}/${servers.length} servers`)
