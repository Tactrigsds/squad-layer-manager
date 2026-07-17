import { Card } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as UP from '@/models/user-presence'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'

import React from 'react'

import { MatchHistoryPanelContent } from './match-history-panel'

import { QueuePanelContent, SlmUpdatesDisabledAlert } from './layer-queue-panel.tsx'
import { StickyGroup } from './sticky-group.tsx'
import TeamsPanel from './teams-panel.tsx'
import UserPresencePanel, { sortEditingPresence } from './user-presence-panel.tsx'

// stable ids so each tab and its panel can point at each other (aria-controls / aria-labelledby)
const tabId = (value: string) => `primary-panel-tab-${value}`
const tabPanelId = (value: string) => `primary-panel-panel-${value}`

function TabBar<T extends string>({
	tabs,
	value,
	onChange,
	className,
	ref,
}: {
	tabs: { value: T; label: React.ReactNode }[]
	value: T | null
	onChange: (value: T) => void
	className?: string
	ref?: React.RefObject<HTMLDivElement>
}) {
	return (
		<div
			ref={ref}
			role="tablist"
			className={cn('grid divide-x', className)}
			style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}
		>
			{tabs.map(tab => (
				<button
					key={tab.value}
					type="button"
					role="tab"
					id={tabId(tab.value)}
					aria-selected={value === tab.value}
					aria-controls={tabPanelId(tab.value)}
					// only the active tab is in the tab order; arrow keys are the expected way to move between
					// tabs, and roving tabindex is what tells assistive tech that
					tabIndex={value === tab.value ? 0 : -1}
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
	// the visible panel is client-only state; presence mirrors it while the client is engaged (see the
	// dashboard route effect). tab switches persist and drive display without needing a presence entry.
	const tab = ZusUtils.useStore(ClientOnlySettings.Store, s => s.primaryPanelTab === 'VIEWING_TEAMS' ? 'teams' : 'queue')

	const queueLength = ZusUtils.useStore(props.stores.squadServer, s => s.queue.layerList.length)
	const playerCount = ZusUtils.useStore(props.stores.squadServer, s => ChatPrt.Sel.chatState(s).players.length)

	// subjects are created once per frame instance, so reading them outside a selector is fine
	const frameState = ZusUtils.getState(props.stores.squadServer)
	const queueEvent$ = frameState.queue.presenceEvent$
	const teamswapEvent$ = frameState.teamswaps.presenceEvent$

	const headerRef = React.useRef<HTMLDivElement>(null)

	return (
		<Card className="flex flex-col flex-1 min-h-0 @container">
			<ScrollArea className="flex-1">
				<MatchHistoryPanelContent stores={props.stores} />
				<Separator />
				<div className="bg-background" ref={headerRef}>
					<TabBar
						tabs={[
							{
								value: 'queue',
								label: (
									<div className="flex justify-between">
										<span>Queue ({queueLength})</span>
										<UserPresencePanel
											stores={props.stores}
											sourcePresenceFn={sortEditingPresence}
											matchActivity={root => UP.Trans.viewingQueue(serverId).match(root) || UP.Trans.editingQueue(serverId).match(root)}
											matchActivityForStatusText={root =>
												UP.Trans.editingQueue(serverId).match(root) || UP.Trans.viewingQueue(serverId).match(root)}
											event$={queueEvent$}
											transitionMessages={[
												{
													matchActivity: root => UP.Trans.editingQueue(serverId).match(root),
													leaveMessage: 'Finished editing',
												},
											]}
											className="min-w-0"
										/>
									</div>
								),
							},
							{
								value: 'teams',
								label: (
									<div className="flex justify-between">
										<span>Teams ({playerCount})</span>
										<UserPresencePanel
											stores={props.stores}
											sourcePresenceFn={sortEditingPresence}
											matchActivity={root => UP.Trans.viewingTeams(serverId).match(root) || UP.Trans.editingTeamswaps(serverId).match(root)}
											matchActivityForStatusText={root =>
												UP.Trans.editingTeamswaps(serverId).match(root) || UP.Trans.viewingTeams(serverId).match(root)}
											event$={teamswapEvent$}
											className="min-w-0"
										/>
									</div>
								),
							},
						]}
						value={tab}
						onChange={(value) => ClientOnlySettings.Actions.setPrimaryPanelTab(value === 'teams' ? 'VIEWING_TEAMS' : 'VIEWING_QUEUE')}
					/>
					<Separator />
				</div>
				<StickyGroup stickyRef={headerRef}>
					<div className="grid">
						{
							/* both panels stay mounted (they hold live state) and share one grid cell. `inert` takes the
						    inactive one out of the a11y tree and the tab order while leaving that layout intact --
						    `invisible` alone does neither, so its buttons stayed focusable */
						}
						<div
							role="tabpanel"
							id={tabPanelId('queue')}
							aria-labelledby={tabId('queue')}
							inert={tab !== 'queue'}
							className={cn('[grid-area:1/1]', tab !== 'queue' && 'invisible -z-20')}
						>
							<SlmUpdatesDisabledAlert stores={props.stores} />
							<QueuePanelContent stores={props.stores} />
						</div>
						<div
							role="tabpanel"
							id={tabPanelId('teams')}
							aria-labelledby={tabId('teams')}
							inert={tab !== 'teams'}
							className={cn('[grid-area:1/1]', tab !== 'teams' && 'invisible -z-20')}
						>
							<TeamsPanel stores={props.stores} />
						</div>
					</div>
				</StickyGroup>
			</ScrollArea>
		</Card>
	)
}
