import * as ChatPrt from '@/frame-partials/chat.partial'
import * as Obj from '@/lib/object'
import * as RSel from '@/lib/reselect'
import * as BM from '@/models/battlemetrics.models'
import type * as CHAT from '@/models/chat.models'
import type * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import type { PublicSettings } from '@/systems/settings.server'

export type EnrichedPlayer = SM.Player & {
	bmProfile: Omit<BM.PlayerFlagsAndProfile, 'playerIds'> | undefined
	grouping?: string
	stats: CHAT.PlayerStats | undefined
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
	// grouping/selection actions) so the enrichment logic lives in one place.
	export const allEnrichedPlayers = RSel.createDeepSelector(
		[
			(...args: Inputs) => playersForTeam('A')(...args),
			(...args: Inputs) => playersForTeam('B')(...args),
		],
		(a, b) => [...a, ...b],
	)

	export const playersForTeam = RSel.memoizeFactory((teamId: MH.NormedTeamId | SM.TeamId) =>
		RSel.createDeepSelector(
			[
				(...[store, currentMatch]: Inputs) => ChatPrt.Sel.playersForTeam(teamId)(store, currentMatch),
				(...[store]: Inputs) => ChatPrt.Sel.chatState(store).playerStats,
				(...[, , bmData]: Inputs) => bmData,
				(...[, , , bmStore]: Inputs) => bmStore.selectedModeId,
				(...[, , , bmStore]: Inputs) => bmStore.orgFlags,
				(...[, , , , settings]: Inputs) => settings?.playerFlagGroupings,
			],
			(players, playerStats, bmData, selectedModeId, orgFlags, groupings) => {
				const playerFlagGroupings = groupings ?? []
				const modeIds = BM.getGroupingModeIds(playerFlagGroupings)
				const activeModeId = selectedModeId !== null && modeIds.includes(selectedModeId)
					? selectedModeId
					: modeIds[0] ?? null

				const playerFlagPairs: [SM.PlayerId, BM.PlayerFlag[]][] = players
					.filter(p => p.ids.eos != null)
					.map(p => {
						const eosId = p.ids.eos!
						const flagIds = bmData[eosId]?.flagIds ?? []
						const flags = BM.resolveFlags(flagIds, orgFlags)
						return [eosId, flags]
					})
				const allGroups = activeModeId !== null
					? BM.resolvePlayerFlagGroups(playerFlagPairs, playerFlagGroupings, activeModeId)
					: new Map<SM.PlayerId, string>()

				return players.map((p): EnrichedPlayer => {
					const playerId = SM.PlayerIds.getPlayerId(p.ids)
					const profile = bmData[playerId]
					return {
						...p,
						bmProfile: profile ? Obj.omit(profile, ['playerIds']) : undefined,
						grouping: allGroups.get(playerId),
						stats: playerStats[playerId],
					}
				})
			},
		)
	)
}
