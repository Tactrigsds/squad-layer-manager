import { createFileRoute, useNavigate } from '@tanstack/react-router'
import React from 'react'

import HistoryPage from '@/components/history-page'
import { PermissionDeniedPanel } from '@/components/permission-denied-tooltip'
import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager'
import * as HistoryFrame from '@/frames/history.frame'
import * as Zus from '@/lib/zustand'
import * as HQ from '@/models/history.models'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'

// The whole query lives in the url's search params: running a query navigates, and loading a saved or
// recent one is nothing but a navigation. The frame holds only the in-progress draft. `sel` rides alongside
// the query without being part of it (see HQ.SearchExtras).
export const Route = createFileRoute('/_app/history')({
	component: RouteComponent,
	validateSearch: (search): HQ.Search => HQ.parseSearch(search),
	head: () => ({
		meta: [{ title: 'SLM - History' }],
	}),
})

// A bare visit lands scoped to the default server and on the DEFAULT quick filter, since a cross-server
// search over every event kind is rarely the question and the whole history is the expensive one. Only a
// bare visit: a shared link, a saved query, or a search the user has already narrowed all carry their own
// scope (or deliberately none), and are left alone.
function useBareVisitDefaults(search: HQ.Search) {
	const navigate = useNavigate()
	const defaultServer = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers.find((server) => server.defaultServer)?.id)
	const bare = search.servers === undefined && JSON.stringify(search) === JSON.stringify(HQ.DEFAULT_QUERY)
	React.useEffect(() => {
		if (!bare || !defaultServer) return
		void navigate({ to: '/history', search: { ...HQ.DEFAULT_QUERY, servers: [defaultServer], feed: 'DEFAULT' }, replace: true })
	}, [bare, defaultServer, navigate])
}

function RouteComponent() {
	// the server refuses the queries themselves; this is so the page says why rather than showing failures
	const denied = RbacClient.usePermsCheck(RBAC.perm('history:query'))
	if (denied) return <PermissionDeniedPanel denied={denied} />
	return <HistoryRoute />
}

function HistoryRoute() {
	const search = Route.useSearch()
	const navigate = useNavigate()
	useBareVisitDefaults(search)
	// the page loads further results in place, so a url's cursor only means something to a text request
	const { query: rest, sel } = HQ.splitSearch(search)
	// Keyed by its json so a selection change leaves the query's identity, and so the frame's draft and the
	// results, alone. Re-serialized because the router hands back null-prototype objects, which the frame
	// manager's deep-equal over instance keys chokes on.
	const queryJson = JSON.stringify(rest)
	const query = React.useMemo(() => JSON.parse(queryJson) as HQ.Query, [queryJson])
	const input = React.useMemo(() => ({ initial: query }), [query])
	const frameKey = useFrameLifecycle(HistoryFrame.frame, { input })
	useFrameTeardownOnUnmount(frameKey)
	return (
		<HistoryPage
			stores={{ history: frameKey }}
			executed={query}
			selection={sel}
			onRun={(query) => void navigate({ to: '/history', search: query })}
			onSelect={(sel) => void navigate({ to: '/history', search: { ...query, sel }, replace: true, resetScroll: false })}
		/>
	)
}
