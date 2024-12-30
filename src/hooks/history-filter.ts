import { trpcReact } from '@/lib/trpc.client'
import * as M from '@/models'
export function useHistoryFilterNode(props: { historyFilters: M.HistoryFilter[]; layerQueue: M.LayerQueueItem[]; enabled?: boolean }) {
	const res = trpcReact.getHistoryFilter.useQuery(
		{
			historyFilters: props.historyFilters,
			layerQueue: props.layerQueue,
		},
		{ enabled: props.enabled }
	)
	return res
}
