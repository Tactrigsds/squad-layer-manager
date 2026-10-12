import { createFileRoute, useNavigate } from '@tanstack/react-router'

import FiltersIndex from '@/components/filter-index'
import * as APP_Msgs from '@/messages/app.messages'
import * as F_Msgs from '@/messages/filter.messages'
import * as FIDX from '@/models/filter-index.models'
import * as RPC from '@/orpc.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'

// the search, author and sort choices live in the url, so a filtered view can be linked and survives a reload
export const Route = createFileRoute('/_app/filters/')({
	component: RouteComponent,
	validateSearch: (search): FIDX.IndexSearch => FIDX.parseIndexSearch(search),
	search: { middlewares: [({ search, next }) => FIDX.compactIndexSearch(next(search))] },
	// not awaited: the cards render without it, so it only needs a head start on their mount
	loader: () => {
		void RPC.queryClient.prefetchQuery(FilterEntityClient.getAllFilterRoleContributorsBase())
	},

	head: () => ({
		meta: [{ title: tr.text(APP_Msgs.pageTitle(tr.text(F_Msgs.filtersHeading()))) }],
	}),
})

function RouteComponent() {
	const search = Route.useSearch()
	const navigate = useNavigate()
	return <FiltersIndex search={search} onSearchChange={(next) => void navigate({ to: '/filters', search: next, replace: true })} />
}
