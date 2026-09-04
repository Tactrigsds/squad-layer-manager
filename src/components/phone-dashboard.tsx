import * as Icons from 'lucide-react'
import React from 'react'

import { Card } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Zus from '@/lib/zustand'
import * as APP_Msgs from '@/messages/app.messages'
import * as UP from '@/models/user-presence'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as SquadServerClient from '@/systems/squad-server.client'

import BackburnerPanel from './backburner-panel.tsx'
import { IngameVoteAlert, QueuePanelContent, SlmUpdatesDisabledAlert } from './layer-queue-panel.tsx'
import { MatchHistoryPanelContent } from './match-history-panel'
import PhoneTabBar from './phone-tab-bar.tsx'
import { PluginSlot } from './plugin-slot.tsx'
import ServerActivityPanel from './server-activity-panel.tsx'
import ShortLayerName from './short-layer-name.tsx'
import StatsPanel from './stats-panel.tsx'
import TeamsPanel from './teams-panel.tsx'
import { Timer } from './timer.tsx'
import UserPresencePanel, { sortEditingPresence } from './user-presence-panel.tsx'

type Screen = SquadServerClient.PhoneScreen

/**
 * Below 640px the dashboard is one panel at a time: the same panels as the desktop layout, behind a bottom tab
 * bar. The current layer rides in a strip under the top bar on every screen but Matches, which already shows it
 * as the highlighted history row.
 */
export default function PhoneDashboard(props: { stores: SquadServerFrame.KeyProp }) {
	const screen = Zus.useStore(SquadServerClient.DashboardTabStore, (s) => s.phoneScreen)
	const queueLength = Zus.useStore(props.stores.squadServer, (s) => s.queue.layerList.length)
	const playerCount = Zus.useStore(props.stores.squadServer, (s) => ChatPrt.Sel.players(s).length)
	const serverId = props.stores.squadServer.serverId
	const badges: Partial<Record<Screen, number>> = { queue: queueLength, teams: playerCount }

	return (
		<div className="flex h-full w-full flex-col min-h-0 -m-2">
			{screen !== 'matches' && <CurrentLayerStrip stores={props.stores} />}
			<div className="flex flex-col flex-1 min-h-0 p-2 gap-2">
				{screen === 'matches' && (
					<ScrollArea className="flex-1 min-h-0">
						<div className="flex flex-col gap-2">
							<Card className="@container">
								<MatchHistoryPanelContent stores={props.stores} />
							</Card>
							<PluginSlot anchor="server-dashboard:alerts" anchorProps={{ serverId }} />
							<React.Suspense fallback={null}>
								<StatsPanel stores={props.stores} />
							</React.Suspense>
						</div>
					</ScrollArea>
				)}
				{screen === 'queue' && (
					<div className="fd-tabbody flex flex-col flex-1 min-h-0">
						<PresenceRow>
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
								event$={Zus.getState(props.stores.squadServer).queue.presenceEvent$}
								className="min-w-0"
							/>
						</PresenceRow>
						<ScrollArea className="flex-1 min-h-0">
							<IngameVoteAlert stores={props.stores} />
							<SlmUpdatesDisabledAlert stores={props.stores} />
							<PluginSlot anchor="server-dashboard:queue-alerts" anchorProps={{ serverId }} />
							<QueuePanelContent stores={props.stores} />
							<BackburnerPanel stores={props.stores} />
						</ScrollArea>
					</div>
				)}
				{screen === 'teams' && (
					<div className="fd-tabbody flex flex-col flex-1 min-h-0">
						<PresenceRow>
							<UserPresencePanel
								stores={props.stores}
								sourcePresenceFn={sortEditingPresence}
								matchActivity={(root) =>
									UP.Trans.viewingTeams(serverId).match(root) || UP.Trans.editingTeamswaps(serverId).match(root)
								}
								matchActivityForStatusText={(root) =>
									UP.Trans.editingTeamswaps(serverId).match(root) || UP.Trans.viewingTeams(serverId).match(root)
								}
								event$={Zus.getState(props.stores.squadServer).teamswaps.presenceEvent$}
								className="min-w-0"
							/>
						</PresenceRow>
						<ScrollArea className="flex-1 min-h-0">
							<TeamsPanel stores={props.stores} />
						</ScrollArea>
					</div>
				)}
				{screen === 'activity' && (
					<div className="flex flex-1 min-h-0">
						<ServerActivityPanel stores={props.stores} />
					</div>
				)}
			</div>
			<PhoneTabBar active={screen} badges={badges} onSelect={SquadServerClient.DashboardTabActions.setPhoneScreen} />
		</div>
	)
}

function PresenceRow(props: { children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2 h-[22px] px-2 border-b border-line shrink-0">
			<span className="text-xs text-text-3">{tr.text(APP_Msgs.phoneHere())}</span>
			<span className="flex min-w-0 items-center gap-2.5">{props.children}</span>
		</div>
	)
}

function CurrentLayerStrip(props: { stores: SquadServerFrame.KeyProp }) {
	const serverId = props.stores.squadServer.serverId
	const current = MatchHistoryClient.useCurrentMatch(serverId)
	if (!current) return null
	return (
		<div className="flex items-center gap-1.5 h-[26px] px-2.5 bg-[rgba(95,183,106,0.12)] border-b border-line text-xs whitespace-nowrap overflow-hidden shrink-0">
			<Icons.Play className="size-[11px] text-ok" />
			<ShortLayerName layerId={current.layerId} teamParity={current.ordinal} allowShowInfo={false} className="font-mono font-semibold" />
			<span className="flex-1" />
			{current.startTime && current.status === 'in-progress' && (
				<span className="font-mono font-light">
					<Timer zeros start={current.startTime.getTime()} />
				</span>
			)}
		</div>
	)
}
