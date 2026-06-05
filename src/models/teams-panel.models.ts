import * as Obj from '@/lib/object'
import * as BM from '@/models/battlemetrics.models'
import * as MH from '@/models/match-history.models'
import * as SquadServer from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import type { PublicConfig } from '@/server/config'

export type EnrichedPlayer = SM.Player & {
	bmProfile: Omit<BM.PlayerFlagsAndProfile, 'playerIds'> | undefined
	grouping?: string
}

export namespace Select {
	export function playersForTeam(teamId: MH.NormedTeamId | SM.TeamId) {
		return (
			store: SquadServer.ChatStore,
			currentMatch: MH.MatchDetails | undefined,
			bmData: BM.PublicPlayerBmData,
			bmStore: BM.StoreState,
			config: PublicConfig | undefined,
		) => {
			if (bmStore.selectedModeId || !config) return []
			const players = SquadServer.Select.playersForTeam(teamId)(store, currentMatch)
			const orgFlags = bmStore.orgFlags

			const playerFlagPairs: [SM.PlayerId, BM.PlayerFlag[]][] = players
				.filter(p => p.ids.eos != null)
				.map(p => {
					const eosId = p.ids.eos!
					const flagIds = bmData[eosId]?.flagIds ?? []
					const flags = BM.resolveFlags(flagIds, orgFlags)
					return [eosId, flags]
				})
			const allGroups = BM.resolvePlayerFlagGroups(playerFlagPairs, config.playerFlagGroupings ?? [], bmStore.selectedModeId)
			return players.map((p): EnrichedPlayer => {
				const profile = bmData[SM.PlayerIds.getPlayerId(p.ids)]
				return {
					...p,
					bmProfile: profile ? Obj.omit(profile, ['playerIds']) : undefined,
					grouping: allGroups.get(SM.PlayerIds.getPlayerId(p.ids)),
				}
			})
		}
	}
}
