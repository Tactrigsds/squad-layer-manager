import React from 'react'

import ServerActivityPanel from '@/components/server-activity-panel'
import StatsPanel from '@/components/stats-panel'
import type * as SquadServerFrame from '@/frames/squad-server.frame'

// the single-column layout's "Server Activity" side: the breakdown in its narrow form over the feed
export default function SecondaryPanel(props: { stores: SquadServerFrame.KeyProp }) {
	return (
		<div className="flex flex-col gap-2.5 h-full min-h-0 w-full">
			<React.Suspense fallback={null}>
				<StatsPanel stores={props.stores} className="shrink-0" />
			</React.Suspense>
			<div className="flex-1 min-h-0 w-full">
				<ServerActivityPanel stores={props.stores} />
			</div>
		</div>
	)
}
