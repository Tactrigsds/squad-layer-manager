import { createFileRoute, useNavigate } from '@tanstack/react-router'
import React from 'react'

import HistoryPage from '@/components/history-page'
import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager'
import * as HistoryFrame from '@/frames/history.frame'
import * as HQ from '@/models/history.models'

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

function RouteComponent() {
	const search = Route.useSearch()
	const navigate = useNavigate()
	const input = React.useMemo(() => ({ initial: search }), [search])
	const frameKey = useFrameLifecycle(HistoryFrame.frame, { input })
	useFrameTeardownOnUnmount(frameKey)
	return (
		<HistoryPage stores={{ history: frameKey }} executed={search} onRun={(query) => void navigate({ to: '/history', search: query })} />
	)
}
