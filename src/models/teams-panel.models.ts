import * as ChatPrt from '@/frame-partials/chat.partial'
import * as Obj from '@/lib/object-utils'
import * as RSel from '@/lib/reselect'
import * as BM from '@/models/battlemetrics.models'
import type * as CHAT from '@/models/chat.models'
import type * as MH from '@/models/match-history.models'
import * as PG from '@/models/player-groupings.models'
import * as SM from '@/models/squad.models'
import type { PublicSettings } from '@/systems/settings.server'

export type EnrichedPlayer = SM.Player & {
	bmProfile: Omit<BM.PlayerFlagsAndProfile, 'playerIds'> | undefined
	group?: string
	stats: CHAT.PlayerStats | undefined
	inAdminCam: boolean
}

type Enrichment = {
	profile: BM.PlayerFlagsAndProfile | undefined
	group: string | undefined
	stats: CHAT.PlayerStats | undefined
	inAdminCam: boolean
	enriched: EnrichedPlayer
}

// One enriched object per roster entry, reused while its inputs are unchanged, so the teams panel's memoized rows
// skip every player a kill or a chat message did not touch.
const enrichments = new WeakMap<SM.Player, Enrichment>()

function enrich(
	player: SM.Player,
	profile: BM.PlayerFlagsAndProfile | undefined,
	group: string | undefined,
	stats: CHAT.PlayerStats | undefined,
	inAdminCam: boolean,
): EnrichedPlayer {
	const cached = enrichments.get(player)
	if (cached && cached.profile === profile && cached.group === group && cached.stats === stats && cached.inAdminCam === inAdminCam) {
		return cached.enriched
	}
	const enriched: EnrichedPlayer = {
		...player,
		bmProfile: profile ? Obj.omit(profile, ['playerIds']) : undefined,
		group,
		stats,
		inAdminCam,
	}
	enrichments.set(player, { profile, group, stats, inAdminCam, enriched })
	return enriched
}

export namespace Sel {
	type Inputs = [
		store: ChatPrt.Store,
		currentMatch: MH.MatchDetails | undefined,
		bmData: BM.PublicPlayerBmData,
		bmStore: BM.StoreState,
		settings: PublicSettings | undefined,
	]
	// Enriched players across both teams. Shared by call sites that need the whole roster (e.g. the
	// group/selection actions) so the enrichment logic lives in one place.
	export const allEnrichedPlayers = RSel.createDeepSelector(
		[(...args: Inputs) => playersForTeam('A')(...args), (...args: Inputs) => playersForTeam('B')(...args)],
		(a, b) => [...a, ...b],
	)

	const teamRoster =
		(teamId: MH.NormedTeamId | SM.TeamId) =>
		(...[store, currentMatch]: Inputs) =>
			ChatPrt.Sel.playersForTeam(teamId)(store, currentMatch)

	// apart from playersForTeam so that a kill, which changes only the stats, does not resolve every group again
	const groupsForTeam = RSel.memoizeFactory((teamId: MH.NormedTeamId | SM.TeamId) =>
		RSel.createSelector(
			[
				teamRoster(teamId),
				(...[, , bmData]: Inputs) => bmData,
				(...[, , , bmStore]: Inputs) => bmStore.selectedGroupingId,
				(...[, , , bmStore]: Inputs) => bmStore.orgFlags,
				(...[, , , , settings]: Inputs) => settings?.playerGroupings,
			],
			(players, bmData, selectedGroupingId, orgFlags, settingsGroupings) => {
				const playerGroupings = settingsGroupings ?? PG.EMPTY_PLAYER_GROUPINGS
				const groupingIds = PG.groupingIdsWithParty(playerGroupings)
				const activeGroupingId =
					selectedGroupingId !== null && groupingIds.includes(selectedGroupingId) ? selectedGroupingId : (groupingIds[0] ?? null)

				const playerFacts: [SM.PlayerId, PG.PlayerFacts][] = players
					.filter((p) => p.ids.eos != null)
					.map((p) => {
						const eosId = p.ids.eos!
						const flagIds = bmData[eosId]?.flagIds ?? []
						return [eosId, PG.playerFacts(p, BM.resolveFlags(flagIds, orgFlags))]
					})
				return PG.resolvePlayerGroups(playerFacts, playerGroupings, activeGroupingId)
			},
		),
	)

	export const playersForTeam = RSel.memoizeFactory((teamId: MH.NormedTeamId | SM.TeamId) =>
		RSel.createDeepSelector(
			[
				teamRoster(teamId),
				groupsForTeam(teamId),
				(...[store]: Inputs) => ChatPrt.Sel.chatState(store).playerStats,
				(...[store]: Inputs) => ChatPrt.Sel.chatState(store).adminCamPlayerIds,
				(...[, , bmData]: Inputs) => bmData,
			],
			(players, groups, playerStats, adminCamPlayerIds, bmData) =>
				players.map((p) => {
					const playerId = SM.PlayerIds.getPlayerId(p.ids)
					return enrich(p, bmData[playerId], groups.get(playerId), playerStats[playerId], adminCamPlayerIds.includes(playerId))
				}),
		),
	)
}
