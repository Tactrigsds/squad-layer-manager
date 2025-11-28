import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import React from 'react'
import { CurrentLayerCardContent } from './current-layer-card'
import { QueuePanelContent } from './layer-queue-dashboard'
import { MatchHistoryPanelContent } from './match-history-panel'

export default function CombinedDashboardPanel() {
	return (
		<Card>
			<MatchHistoryPanelContent />
			<Separator />
			<CurrentLayerCardContent />
			<Separator />
			<QueuePanelContent />
		</Card>
	)
}
