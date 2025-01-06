import { trpc } from '@/lib/trpc.client'
import * as M from '@/models.ts'
import { useMutation, useQuery } from '@tanstack/react-query'
import React from 'react'

export function useFilters() {
	return useQuery({
		queryKey: ['getFilters'],
		queryFn: () => trpc.filters.getFilters.query(),
	})
}

export function useFilter(
	filterId?: string,
	options?: {
		onDelete?: () => void
		onUpdate?: (update: M.UserEntityMutation<M.FilterEntity>) => void
	}
) {
	const [filter, setFilter] = React.useState<M.FilterEntity | undefined>(undefined)
	const optionsRef = React.useRef(options)
	optionsRef.current = options

	React.useEffect(() => {
		if (!filterId) return
		const sub = trpc.filters.watchFilter.subscribe(filterId, {
			onData: (data) => {
				if (data.code === 'err:not-found') {
					setFilter(undefined)
				}
				if (data.code === 'initial-value') {
					setFilter(data.entity)
				} else if (data.code === 'mutation') {
					if (data.mutation.type === 'delete') {
						optionsRef.current?.onDelete?.()
					} else if (data.mutation.type === 'update') {
						optionsRef.current?.onUpdate?.(data.mutation)
						setFilter(data.mutation.value)
					}
				}
			},
		})
		return () => sub.unsubscribe()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return filter
}

export function useFilterCreate() {
	return useMutation({
		mutationFn: trpc.filters.createFilter.mutate,
	})
}

export function useFilterUpdate() {
	return useMutation({
		mutationFn: trpc.filters.updateFilter.mutate,
	})
}

export function useFilterDelete() {
	return useMutation({
		mutationFn: trpc.filters.deleteFilter.mutate,
	})
}
