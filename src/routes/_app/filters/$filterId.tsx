import FilterWrapper from '@/components/filter-edit'
import { createFileRoute, useParams } from '@tanstack/react-router'
import { z } from 'zod'

export const Route = createFileRoute('/_app/filters/$filterId')({
	component: RouteComponent,
})

function RouteComponent() {
	const filterId = Route.useParams().filterId
	return <FilterWrapper filterId={filterId} />
}
