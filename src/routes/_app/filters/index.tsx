import { createFileRoute } from '@tanstack/react-router'

import FiltersIndex from '@/components/filter-index'

export const Route = createFileRoute('/_app/filters/')({
	component: RouteComponent,

	head: () => ({
		meta: [{ title: 'SLM - Filters' }],
	}),
})

function RouteComponent() {
	return <FiltersIndex />
}
