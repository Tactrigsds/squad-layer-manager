import { createFileRoute } from '@tanstack/react-router'

import FiltersIndex from '@/components/filter-index'
import * as APP_Msgs from '@/messages/app.messages'
import * as F_Msgs from '@/messages/filter.messages'
import { tr } from '@/systems/messages.client'

export const Route = createFileRoute('/_app/filters/')({
	component: RouteComponent,

	head: () => ({
		meta: [{ title: tr.text(APP_Msgs.pageTitle(tr.text(F_Msgs.filtersHeading()))) }],
	}),
})

function RouteComponent() {
	return <FiltersIndex />
}
