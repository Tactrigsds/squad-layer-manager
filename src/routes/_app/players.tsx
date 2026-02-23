import { PlayerDisplay } from '@/components/player-display'
import * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'

import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/players')({
	component: RouteComponent,
})

function RouteComponent() {
	const res = useQuery(RPC.orpc.matchHistory.getMatchEvents.queryOptions({ input: 123 }))
	let players: SM.Player[] = []
	if (res.data?.events) {
		const seenIds = new Set<string>()
		for (const event of res.data.events) {
			if (event.type === 'PLAYER_CONNECTED') {
				const playerId = SM.PlayerIds.getPlayerId(event.player.ids)
				if (event.player && !seenIds.has(playerId)) {
					players.push(event.player)
					seenIds.add(playerId)
				}
			}
		}
	}

	return (
		<div className="w-full h-full grid place-items-center">
			<div>
				{players?.map(player => <PlayerDisplay key={player.ids.steam} player={player} matchId={698} />)}
			</div>
		</div>
	)
}
