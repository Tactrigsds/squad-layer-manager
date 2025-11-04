import FiltersIndex from '@/components/filter-index'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/filters/')({
	component: RouteComponent,
})

function RouteComponent() {
	return <FiltersIndex />
}
