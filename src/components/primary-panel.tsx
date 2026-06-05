import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

import React from 'react'

import { MatchHistoryPanelContent } from './match-history-panel'

import { QueuePanelContent, SlmUpdatesDisabledAlert } from './layer-queue-panel.tsx'
import UserPresencePanel, { sortEditingPresence } from './user-presence-panel.tsx'

export default function PrimaryPanel() {
	type Tab = 'layer-queue' | 'teams'
	const [tab, setTab] = React.useState<Tab>('layer-queue')
	return (
		<Card className="flex flex-col flex-1 min-h-0">
			<ScrollArea className="flex-1">
				<MatchHistoryPanelContent />
				<Separator />
				<CardHeader className="flex flex-row items-center justify-between">
					<CardTitle>Recent Users</CardTitle>
					<UserPresencePanel sourcePresenceFn={sortEditingPresence} />
				</CardHeader>
				<Separator />
				<SlmUpdatesDisabledAlert />
				<QueuePanelContent />
			</ScrollArea>
		</Card>
	)
}
