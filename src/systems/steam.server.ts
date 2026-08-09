import { z } from 'zod'

import type * as CS from '@/models/context-shared'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'

// Builds a join link out of steam's own data, for a server the squad browser cannot resolve. A player in game
// reports the lobby their session belongs to, and steam://joinlobby takes that lobby plus any member of it, so
// a populated server can be joined without anything indexing it.
// https://partner.steamgames.com/doc/webapi/ISteamUser#GetPlayerSummaries

const getEnv = Env.getEnvBuilder({ ...Env.groups.steam })
const module = initModule('steam')

let ENV!: ReturnType<typeof getEnv>
let log!: ReturnType<typeof module.getLogger>

export function isEnabled() {
	return ENV?.STEAM_ENABLED ?? false
}

export function setup() {
	log = module.getLogger()
	ENV = getEnv()
	if (!ENV.STEAM_ENABLED) {
		log.info('Steam integration is off (STEAM_ENABLED=false); join links come from the squad browser alone')
	}
}

export type JoinLinkRes =
	| { code: 'ok'; joinUrl: string }
	| { code: 'err:disabled' }
	| { code: 'err:no-lobby' }
	| { code: 'err:request-failed'; msg: string }

const SQUAD_APP_ID = '393380'
const SUMMARIES_PATH = '/ISteamUser/GetPlayerSummaries/v2/'
// the api's own cap on one request
const MAX_IDS_PER_REQUEST = 100

const SummariesSchema = z.object({
	response: z.object({
		players: z.array(
			z.object({
				steamid: z.string(),
				// both are absent for a player whose game details are not public, and lobbysteamid alone for one
				// whose lobby nobody may join
				gameid: z.string().optional(),
				lobbysteamid: z.string().optional(),
			}),
		),
	}),
})

type LobbyMember = { steamId: string; lobbyId: string }

// Not cached, unlike the squad browser lookup: steam's quota is per day rather than per hour, and the link
// embeds a player who has to still be in the lobby when it is followed.
export async function getJoinLink(ctx: CS.Ctx & CS.AbortSignal, playerSteamIds: string[]): Promise<JoinLinkRes> {
	if (!isEnabled()) return { code: 'err:disabled' }

	for (let i = 0; i < playerSteamIds.length; i += MAX_IDS_PER_REQUEST) {
		const res = await fetchLobbyMembers(ctx, playerSteamIds.slice(i, i + MAX_IDS_PER_REQUEST))
		if (res.code !== 'ok') return res
		const member = pickLobbyMember(res.members)
		if (member) return { code: 'ok', joinUrl: `steam://joinlobby/${SQUAD_APP_ID}/${member.lobbyId}/${member.steamId}` }
	}
	return { code: 'err:no-lobby' }
}

// The roster is read over rcon and cached, so it can still name a player who has moved to another server, and
// their lobby would send whoever clicked there instead. Taking the lobby the most players agree on costs
// nothing, and falls back to a lone report only when there is nothing to compare it against.
function pickLobbyMember(members: LobbyMember[]): LobbyMember | undefined {
	const counts = new Map<string, number>()
	for (const member of members) counts.set(member.lobbyId, (counts.get(member.lobbyId) ?? 0) + 1)

	let best: LobbyMember | undefined
	for (const member of members) {
		if (!best || counts.get(member.lobbyId)! > counts.get(best.lobbyId)!) best = member
	}
	return best
}

async function fetchLobbyMembers(
	ctx: CS.Ctx & CS.AbortSignal,
	steamIds: string[],
): Promise<{ code: 'ok'; members: LobbyMember[] } | { code: 'err:request-failed'; msg: string }> {
	// the key travels in the query string because the api has no other way to authenticate; otel.server redacts
	// it out of the span this fetch produces
	const query = new URLSearchParams({ key: ENV.STEAM_API_KEY!, steamids: steamIds.join(',') })

	let response: Response
	try {
		response = await fetch(`${ENV.STEAM_HOST}${SUMMARIES_PATH}?${query}`, { signal: ctx.signal })
	} catch (error) {
		log.warn(error, 'Steam player-summaries request failed')
		return { code: 'err:request-failed', msg: 'Could not reach steam' }
	}

	if (!response.ok) {
		// the key is deploy config, so a 401 or 403 here is a misconfiguration an operator has to see
		log.warn('Steam player-summaries request returned %d for %d players', response.status, steamIds.length)
		return { code: 'err:request-failed', msg: `Steam returned ${response.status}` }
	}

	const parsed = SummariesSchema.safeParse(await response.json().catch(() => null))
	if (!parsed.success) {
		log.warn(parsed.error, 'Could not parse the steam player-summaries response')
		return { code: 'err:request-failed', msg: 'Steam returned an unexpected response' }
	}

	const members = parsed.data.response.players.flatMap((player) =>
		player.lobbysteamid && player.gameid === SQUAD_APP_ID ? [{ steamId: player.steamid, lobbyId: player.lobbysteamid }] : [],
	)
	return { code: 'ok', members }
}
