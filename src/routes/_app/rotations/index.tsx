import { createFileRoute, useNavigate } from '@tanstack/react-router'

import RotationsIndex from '@/components/rotations-index'
import * as APP_Msgs from '@/messages/app.messages'
import * as ROT_Msgs from '@/messages/rotations.messages'
import * as ROT from '@/models/rotations.models'
import { tr } from '@/systems/messages.client'

// the search, tag, author and sort choices live in the url, so a filtered view can be linked and survives a reload
export const Route = createFileRoute('/_app/rotations/')({
	component: RouteComponent,
	validateSearch: (search): ROT.IndexSearch => ROT.parseIndexSearch(search),
	search: { middlewares: [({ search, next }) => ROT.compactIndexSearch(next(search))] },
	head: () => ({
		meta: [{ title: tr.text(APP_Msgs.pageTitle(tr.text(ROT_Msgs.pageTitle()))) }],
	}),
})

function RouteComponent() {
	const search = Route.useSearch()
	const navigate = useNavigate()
	return <RotationsIndex search={search} onSearchChange={(next) => void navigate({ to: '/rotations', search: next, replace: true })} />
}
