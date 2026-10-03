import { createFileRoute } from '@tanstack/react-router'

import FiltersIndex from '@/components/filter-index'
import * as APP_Msgs from '@/messages/app.messages'
import * as F_Msgs from '@/messages/filter.messages'
import * as RPC from '@/orpc.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'

export const Route = createFileRoute('/_app/filters/')({
	component: RouteComponent,
	// not awaited: the cards render without it, so it only needs a head start on their mount
	loader: () => {
		void RPC.queryClient.prefetchQuery(FilterEntityClient.getAllFilterRoleContributorsBase())
	},

	head: () => ({
		meta: [{ title: tr.text(APP_Msgs.pageTitle(tr.text(F_Msgs.filtersHeading()))) }],
	}),
})

function RouteComponent() {
	return <FiltersIndex />
}
