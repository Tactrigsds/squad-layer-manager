import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import React from 'react'
import { QueuePanelContent } from './layer-queue-dashboard'
import { MatchHistoryPanelContent } from './match-history-panel'
import UserPresencePanel from './user-presence-panel'

export default function CombinedDashboardPanel() {
	return (
		<Card>
			<MatchHistoryPanelContent />
			<Separator />
			<CardHeader className="flex flex-row items-center justify-between">
				<CardTitle>Recent Users</CardTitle>
				<UserPresencePanel />
			</CardHeader>
			<Separator />
			<QueuePanelContent />
		</Card>
	)
}
