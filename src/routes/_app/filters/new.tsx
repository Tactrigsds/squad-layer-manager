import FilterNew from '@/components/filter-new'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/filters/new')({
	component: RouteComponent,
})

function RouteComponent() {
	return <FilterNew />
}
