import { createFileRoute, useNavigate } from '@tanstack/react-router'
import React from 'react'

import HistoryPage from '@/components/history-page'
import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager'
import * as HistoryFrame from '@/frames/history.frame'
import * as Zus from '@/lib/zustand'
import * as HQ from '@/models/history.models'
import * as SettingsClient from '@/systems/settings.client'

// The whole query lives in the url's search params: running a query navigates, and loading a saved or
// recent one is nothing but a navigation. The frame holds only the in-progress draft.
export const Route = createFileRoute('/_app/history')({
	component: RouteComponent,
	validateSearch: (search): HQ.Query => {
		const res = HQ.QuerySchema.safeParse(search)
		return res.success ? res.data : HQ.DEFAULT_QUERY
	},
	head: () => ({
		meta: [{ title: 'SLM - History' }],
	}),
})

// A bare visit lands scoped to the default server and on the DEFAULT quick filter, since a cross-server
// search over every event kind is rarely the question and the whole history is the expensive one. Only a
// bare visit: a shared link, a saved query, or a search the user has already narrowed all carry their own
// scope (or deliberately none), and are left alone.
function useBareVisitDefaults(search: HQ.Query) {
	const navigate = useNavigate()
	const defaultServer = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers.find((server) => server.defaultServer)?.id)
	const bare = search.servers === undefined && JSON.stringify(search) === JSON.stringify(HQ.DEFAULT_QUERY)
	React.useEffect(() => {
		if (!bare || !defaultServer) return
		void navigate({ to: '/history', search: { ...HQ.DEFAULT_QUERY, servers: [defaultServer], feed: 'DEFAULT' }, replace: true })
	}, [bare, defaultServer, navigate])
}

function RouteComponent() {
	const search = Route.useSearch()
	const navigate = useNavigate()
	useBareVisitDefaults(search)
	// re-serialized because the router hands back null-prototype objects, which the frame manager's
	// deep-equal over instance keys chokes on
	const input = React.useMemo(() => ({ initial: JSON.parse(JSON.stringify(search)) as HQ.Query }), [search])
	const frameKey = useFrameLifecycle(HistoryFrame.frame, { input })
	useFrameTeardownOnUnmount(frameKey)
	return (
		<HistoryPage stores={{ history: frameKey }} executed={search} onRun={(query) => void navigate({ to: '/history', search: query })} />
	)
}
