import { ServerActivityCharts } from '@/components/server-activity-charts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as ZusUtils from '@/lib/zustand'
import * as RPC from '@/orpc.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

export default function StatsPanel(props: { stores: SquadServerFrame.KeyProp }) {
	const serverId = props.stores.squadServer!.serverId
	const selectedMatchOrdinal = ZusUtils.useStore(props.stores.squadServer!, s => s.chat.selectedMatchOrdinal)
	const currentMatch = MatchHistoryClient.useCurrentMatch(serverId)
	const recentMatches = MatchHistoryClient.useRecentMatches(serverId)
	const serverInfoRes = SquadServerClient.useServerInfoRes(serverId)
	const maxPlayerCount = serverInfoRes.code === 'ok' ? serverInfoRes.data.maxPlayerCount : undefined

	const historicalEventsQuery = useQuery({
		queryKey: [...RPC.orpc.matchHistory.getMatchEvents.key(), selectedMatchOrdinal],
		queryFn: async () => {
			if (selectedMatchOrdinal === null) return null
			return RPC.selectLoaded(await RPC.orpc.matchHistory.getMatchEvents.call({ serverId, ordinal: selectedMatchOrdinal })) ?? null
		},
		enabled: selectedMatchOrdinal !== null && selectedMatchOrdinal !== undefined,
		staleTime: Infinity,
	})

	const displayMatch = React.useMemo(() => {
		if (selectedMatchOrdinal === null) return currentMatch
		return recentMatches.find(m => m.ordinal === selectedMatchOrdinal)
	}, [selectedMatchOrdinal, currentMatch, recentMatches])

	return (
		<Card className="w-full">
			<CardHeader className="flex flex-row items-center pb-3">
				<CardTitle className="flex items-center gap-2">
					<Icons.BarChart2 className="h-5 w-5" />
					Stats
				</CardTitle>
			</CardHeader>
			<CardContent>
				<ServerActivityCharts
					historicalEvents={selectedMatchOrdinal !== null ? (historicalEventsQuery.data?.events ?? null) : null}
					maxPlayerCount={maxPlayerCount}
					currentMatchOrdinal={selectedMatchOrdinal ?? currentMatch?.ordinal}
					currentMatchId={displayMatch?.historyEntryId}
					layerId={displayMatch?.layerId}
					stores={props.stores}
				/>
			</CardContent>
		</Card>
	)
}
