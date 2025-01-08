import { trpc } from '@/lib/trpc.client'
import superjson from 'superjson'
import * as M from '@/models'
import { useQuery } from '@tanstack/react-query'

export function useHistoryFilterNode(props: { historyFilters: M.HistoryFilter[]; layerQueue: M.LayerListItem[]; enabled?: boolean }) {
	const input = {
		historyFilters: props.historyFilters,
		layerQueue: props.layerQueue,
	}

	return useQuery({
		queryKey: ['getHistoryFilter', superjson.serialize(input)],
		queryFn: () => trpc.getHistoryFilter.query(input),
		enabled: props.enabled,
	})
}
