import React from 'react'

import { Card } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as APP_Msgs from '@/messages/app.messages'
import * as UP from '@/models/user-presence'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import { tr } from '@/systems/messages.client'

import BackburnerPanel from './backburner-panel.tsx'
import { IngameVoteAlert, QueuePanelContent, SlmUpdatesDisabledAlert } from './layer-queue-panel.tsx'
import { MatchHistoryPanelContent } from './match-history-panel'
import { PluginSlot } from './plugin-slot.tsx'
import StatsPanel from './stats-panel.tsx'
import TeamsPanel from './teams-panel.tsx'
import UserPresencePanel, { sortEditingPresence } from './user-presence-panel.tsx'

type PanelTab = 'queue' | 'teams'

// stable ids so each tab and its panel can point at each other (aria-controls / aria-labelledby)
const tabId = (value: string) => `primary-panel-tab-${value}`
const tabPanelId = (value: string) => `primary-panel-panel-${value}`

function TabBar<T extends string>({
	tabs,
	value,
	onChange,
	className,
	trailing,
}: {
	tabs: { value: T; label: React.ReactNode; count?: number }[]
	value: T | null
	onChange: (value: T) => void
	className?: string
	trailing?: React.ReactNode
}) {
	return (
		<div role="tablist" className={cn('fd-tabs shrink-0', className)}>
			{tabs.map((tab) => (
				<button
					key={tab.value}
					type="button"
					role="tab"
					id={tabId(tab.value)}
					aria-selected={value === tab.value}
					aria-controls={tabPanelId(tab.value)}
					data-state={value === tab.value ? 'active' : 'inactive'}
					// only the active tab is in the tab order; arrow keys are the expected way to move between
					// tabs, and roving tabindex is what tells assistive tech that
					tabIndex={value === tab.value ? 0 : -1}
					className="fd-tab min-w-0"
					onClick={() => onChange(tab.value)}
				>
					{tab.label}
					{tab.count !== undefined && <span className="fd-tab-cnt">{tab.count}</span>}
				</button>
			))}
			{trailing && <span className="ml-auto flex min-w-0 items-end gap-2 pb-1">{trailing}</span>}
		</div>
	)
}

/**
 * Match History, the Teams Breakdown and the Queue / Teams tabs. `part` picks which of those this instance
 * renders: the two-column dashboard stacks them all in one column, the three-column one splits history and
 * breakdown from the tabs.
 */
export default function PrimaryPanel(props: {
	stores: SquadServerFrame.KeyProp
	part?: 'all' | 'history' | 'tabs'
	// whether the breakdown sits here (the single-column layout keeps it with Server Activity instead)
	withStats?: boolean
	statsWide?: boolean
}) {
	const part = props.part ?? 'all'
	return (
		<div className="flex flex-col gap-2.5 flex-1 min-h-0 min-w-0 @container">
			{part !== 'tabs' && (
				<>
					<Card className="shrink-0">
						<MatchHistoryPanelContent stores={props.stores} />
					</Card>
					<PluginSlot anchor="server-dashboard:alerts" anchorProps={{ serverId: props.stores.squadServer.serverId }} />
					{props.withStats && (
						<React.Suspense fallback={null}>
							<StatsPanel stores={props.stores} wide={props.statsWide} className="shrink-0" />
						</React.Suspense>
					)}
				</>
			)}
			{part !== 'history' && <QueueTeamsTabs stores={props.stores} />}
		</div>
	)
}

export function QueueTeamsTabs(props: { stores: SquadServerFrame.KeyProp; className?: string }) {
	const serverId = props.stores.squadServer.serverId
	// the visible panel is client-only state; presence mirrors it while the client is engaged (see the
	// dashboard route effect). tab switches persist and drive display without needing a presence entry.
	const tab: PanelTab = Zus.useStore(ClientOnlySettings.Store, (s) => (s.primaryPanelTab === 'VIEWING_TEAMS' ? 'teams' : 'queue'))

	const queueLength = Zus.useStore(props.stores.squadServer, (s) => s.queue.layerList.length)
	const playerCount = Zus.useStore(props.stores.squadServer, (s) => ChatPrt.Sel.players(s).length)

	// subjects are created once per frame instance, so reading them outside a selector is fine
	const frameState = Zus.getState(props.stores.squadServer)
	const queueEvent$ = frameState.queue.presenceEvent$
	const teamswapEvent$ = frameState.teamswaps.presenceEvent$

	const scrollRootRef = React.useRef<HTMLDivElement>(null)
	// both panels share one scroller, so without this a switch carries the previous tab's scroll
	// position over and clamps it against the new tab's height
	const scrollPositions = React.useRef<Record<PanelTab, number>>({ queue: 0, teams: 0 })
	const scrolledTabRef = React.useRef(tab)

	React.useEffect(() => {
		const viewport = scrollRootRef.current?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')
		if (!viewport) return
		const onScroll = () => {
			scrollPositions.current[scrolledTabRef.current] = viewport.scrollTop
		}
		viewport.addEventListener('scroll', onScroll, { passive: true })
		return () => viewport.removeEventListener('scroll', onScroll)
	}, [])

	React.useLayoutEffect(() => {
		scrolledTabRef.current = tab
		const viewport = scrollRootRef.current?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')
		if (!viewport) return
		viewport.scrollTop = scrollPositions.current[tab]
	}, [tab])

	const presence = (
		<>
			<UserPresencePanel
				stores={props.stores}
				sourcePresenceFn={sortEditingPresence}
				matchActivity={(root) =>
					UP.Trans.viewingQueue(serverId).match(root) ||
					UP.Trans.editingQueue(serverId).match(root) ||
					UP.Trans.editingLayerRequests(serverId).match(root)
				}
				matchActivityForStatusText={(root) =>
					UP.Trans.editingQueue(serverId).match(root) ||
					UP.Trans.editingLayerRequests(serverId).match(root) ||
					UP.Trans.viewingQueue(serverId).match(root)
				}
				event$={queueEvent$}
				transitionMessages={[
					{
						matchActivity: (root) =>
							UP.Trans.editingQueue(serverId).match(root) || UP.Trans.editingLayerRequests(serverId).match(root),
						leaveMessage: tr.text(APP_Msgs.finishedEditing()),
					},
				]}
				className="min-w-0"
			/>
			<UserPresencePanel
				stores={props.stores}
				sourcePresenceFn={sortEditingPresence}
				matchActivity={(root) => UP.Trans.viewingTeams(serverId).match(root) || UP.Trans.editingTeamswaps(serverId).match(root)}
				matchActivityForStatusText={(root) =>
					UP.Trans.editingTeamswaps(serverId).match(root) || UP.Trans.viewingTeams(serverId).match(root)
				}
				event$={teamswapEvent$}
				className="min-w-0"
			/>
		</>
	)

	return (
		<div className={cn('flex flex-col flex-1 min-h-0 min-w-0', props.className)}>
			<TabBar
				tabs={[
					{ value: 'queue', label: <span data-tour="queue-editors">{tr.text(APP_Msgs.queueTab(queueLength))}</span> },
					{ value: 'teams', label: tr.text(APP_Msgs.teamsTab(playerCount)) },
				]}
				value={tab}
				onChange={(value) => ClientOnlySettings.Actions.setPrimaryPanelTab(value === 'teams' ? 'VIEWING_TEAMS' : 'VIEWING_QUEUE')}
				trailing={presence}
			/>
			<div className="fd-tabbody flex flex-col flex-1 min-h-0 relative">
				<ScrollArea ref={scrollRootRef} className="flex-1 min-h-0">
					<div className="grid">
						{/* both panels stay mounted, since they hold local state (table sorting, selection) that a
						    remount would drop. the inactive one is `display: none` rather than `invisible` so it
						    contributes no height: sharing a grid cell, it would otherwise size the scroller to the
						    taller of the two and leave the shorter tab scrolling past its own content */}
						<div
							role="tabpanel"
							id={tabPanelId('queue')}
							aria-labelledby={tabId('queue')}
							className={cn('[grid-area:1/1]', tab !== 'queue' && 'hidden')}
						>
							<IngameVoteAlert stores={props.stores} />
							<SlmUpdatesDisabledAlert stores={props.stores} />
							<PluginSlot anchor="server-dashboard:queue-alerts" anchorProps={{ serverId }} />
							{/* the tour's queue anchor stops here: layer requests (the backburner) are not part of the queue */}
							<div data-tour="queue-panel">
								<QueuePanelContent stores={props.stores} />
							</div>
							<BackburnerPanel stores={props.stores} />
						</div>
						<div
							role="tabpanel"
							id={tabPanelId('teams')}
							aria-labelledby={tabId('teams')}
							className={cn('[grid-area:1/1]', tab !== 'teams' && 'hidden')}
						>
							<TeamsPanel stores={props.stores} />
						</div>
					</div>
				</ScrollArea>
			</div>
		</div>
	)
}
