import FiltersIndex from '@/components/filter-index'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/filters/')({
	component: RouteComponent,

	head: () => ({
		meta: [
			{ title: 'Filters - SLM' },
		],
	}),
})

function RouteComponent() {
	return <FiltersIndex />
}
