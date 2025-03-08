import * as M from '@/models'
import { trpc } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'
import superjson from 'superjson'

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
