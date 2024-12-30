import { trpcReact } from '@/lib/trpc.client'
import * as M from '@/models.ts'
import React from 'react'

export function useFilter(
	filterId?: string,
	options?: {
		onDelete?: () => void
		onUpdate?: (update: M.UserEntityMutation<M.FilterEntity>) => void
	}
) {
	const [filter, setFilter] = React.useState<M.FilterEntity | undefined>(undefined)

	trpcReact.filters.watchFilter.useSubscription(filterId ?? '__trash_default_value__', {
		enabled: !!filterId,
		onData: (data) => {
			if (data.code === 'err:not-found') {
				setFilter(undefined)
			}
			if (data.code === 'initial-value') {
				setFilter(data.entity)
			} else if (data.code === 'mutation') {
				if (data.mutation.type === 'delete') {
					options?.onDelete?.()
				} else if (data.mutation.type === 'update') {
					options?.onUpdate?.(data.mutation)
					setFilter(data.mutation.value)
				}
			}
		},
	})

	return filter
}
