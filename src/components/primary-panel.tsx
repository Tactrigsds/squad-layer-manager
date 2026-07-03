import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Typo from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as UP from '@/models/user-presence'

import React from 'react'

import { MatchHistoryPanelContent } from './match-history-panel'

import * as UserPresenceClient from '@/systems/user-presence.client.ts'
import { QueuePanelContent, SlmUpdatesDisabledAlert } from './layer-queue-panel.tsx'
import TeamsPanel from './teams-panel.tsx'
import UserPresencePanel, { sortEditingPresence } from './user-presence-panel.tsx'

function TabBar<T extends string>({
	tabs,
	value,
	onChange,
}: {
	tabs: { value: T; label: React.ReactNode }[]
	value: T | null
	onChange: (value: T) => void
}) {
	return (
		<div className="grid divide-x" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
			{tabs.map(tab => (
				<button
					key={tab.value}
					className={cn(
						'py-2 px-4 text-sm font-medium transition-colors',
						value === tab.value
							? 'border-b-2 border-b-primary'
							: 'text-muted-foreground hover:text-foreground hover:bg-muted',
					)}
					onClick={() => onChange(tab.value)}
				>
					{tab.label}
				</button>
			))}
		</div>
	)
}

export default function PrimaryPanel(props: { stores: SquadServerFrame.KeyProp }) {
	const serverId = props.stores.squadServer.serverId
	const [_tab, setTab] = UserPresenceClient.useVariantActivityState({
		queue: UP.Trans.viewingQueue(serverId),
		teams: UP.Trans.viewingTeams(serverId),
	})
	const tab = _tab ?? 'queue'

	return (
		<Card className="flex flex-col flex-1 min-h-0">
			<ScrollArea className="flex-1">
				<MatchHistoryPanelContent stores={props.stores} />
				<Separator />
				<TabBar
					tabs={[
						{
							value: 'queue',
							label: (
								<div className="flex justify-between">
									<span>Queue</span>
									<UserPresencePanel
										stores={props.stores}
										sourcePresenceFn={sortEditingPresence}
										matchActivity={UP.Trans.viewingQueue(serverId).match}
										className="min-w-0"
									/>
								</div>
							),
						},
						{
							value: 'teams',
							label: (
								<div className="flex justify-between">
									<span>Teams</span>
									<UserPresencePanel
										stores={props.stores}
										sourcePresenceFn={sortEditingPresence}
										matchActivity={UP.Trans.viewingTeams(serverId).match}
										className="min-w-0"
									/>
								</div>
							),
						},
					]}
					value={tab}
					onChange={setTab}
				/>
				<Separator />
				<div className="grid">
					<div className={cn('[grid-area:1/1]', tab !== 'queue' && 'invisible -z-20')}>
						<SlmUpdatesDisabledAlert stores={props.stores} />
						<QueuePanelContent stores={props.stores} />
					</div>
					<div className={cn('[grid-area:1/1]', tab !== 'teams' && 'invisible -z-20')}>
						<TeamsPanel stores={props.stores} />
					</div>
				</div>
			</ScrollArea>
		</Card>
	)
}
