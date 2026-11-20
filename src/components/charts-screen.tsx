import React from 'react'

import { ScrollArea } from '@/components/ui/scroll-area'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as MH_Msgs from '@/messages/match-history.messages'
import { tr } from '@/systems/messages.client'

import { AllCharts } from './stats-panel.tsx'

// the Charts screen of the single-column and phone dashboards: every chart at once, scrolling as one column
export default function ChartsScreen(props: { stores: SquadServerFrame.KeyProp; wide?: boolean }) {
	return (
		<ScrollArea orientation="vertical" className="flex-1 min-h-0 w-full">
			<section aria-label={tr.text(MH_Msgs.chartsTitle())}>
				<React.Suspense fallback={null}>
					<AllCharts stores={props.stores} wide={props.wide} className="fd-tabbody" />
				</React.Suspense>
			</section>
		</ScrollArea>
	)
}
