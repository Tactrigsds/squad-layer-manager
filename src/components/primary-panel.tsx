import React from 'react'

import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { useStackWhenItFits } from '@/hooks/use-stack-when-it-fits'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as APP_Msgs from '@/messages/app.messages'
import * as UP from '@/models/user-presence'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import { tr } from '@/systems/messages.client'
import * as SquadServerClient from '@/systems/squad-server.client'

import BackburnerPanel from './backburner-panel.tsx'
import { IngameVoteAlert, QueuePanelContent, SlmUpdatesDisabledAlert } from './layer-queue-panel.tsx'
import { MatchHistoryPanelContent } from './match-history-panel'
import { PluginSlot } from './plugin-slot.tsx'
import StatsPanel from './stats-panel.tsx'
import { StickyGroup } from './sticky-group.tsx'
import TeamsPanel from './teams-panel.tsx'
import UserPresencePanel, { sortEditingPresence } from './user-presence-panel.tsx'

type PanelTab = 'queue' | 'teams'

// stable ids so a section's title and its body can point at each other (aria-controls / aria-labelledby)
const titleId = (value: string) => `primary-panel-tab-${value}`
const bodyId = (value: string) => (value === 'teams' ? SquadServerClient.TEAMS_PANEL_ELEMENT_ID : `primary-panel-panel-${value}`)

function TabBar<T extends string>({
	tabs,
	value,
	onChange,
	className,
	trailing,
	ref,
}: {
	tabs: { value: T; label: React.ReactNode; count?: number }[]
	value: T | null
	onChange: (value: T) => void
	className?: string
	trailing?: React.ReactNode
	ref?: React.RefObject<HTMLDivElement | null>
}) {
	return (
		<div ref={ref} role="tablist" className={cn('fd-tabs shrink-0', className)}>
			{tabs.map((tab) => (
				<button
					key={tab.value}
					type="button"
					role="tab"
					id={titleId(tab.value)}
					aria-selected={value === tab.value}
					aria-controls={bodyId(tab.value)}
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

function QueuePresence(props: { stores: SquadServerFrame.KeyProp }) {
	const serverId = props.stores.squadServer.serverId
	// subjects are created once per frame instance, so reading them outside a selector is fine
	const event$ = Zus.getState(props.stores.squadServer).queue.presenceEvent$
	return (
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
			event$={event$}
			transitionMessages={[
				{
					matchActivity: (root) => UP.Trans.editingQueue(serverId).match(root) || UP.Trans.editingLayerRequests(serverId).match(root),
					leaveMessage: tr.text(APP_Msgs.finishedEditing()),
				},
			]}
			className="min-w-0"
		/>
	)
}

function TeamsPresence(props: { stores: SquadServerFrame.KeyProp }) {
	const serverId = props.stores.squadServer.serverId
	const event$ = Zus.getState(props.stores.squadServer).teamswaps.presenceEvent$
	return (
		<UserPresencePanel
			stores={props.stores}
			sourcePresenceFn={sortEditingPresence}
			matchActivity={(root) => UP.Trans.viewingTeams(serverId).match(root) || UP.Trans.editingTeamswaps(serverId).match(root)}
			matchActivityForStatusText={(root) =>
				UP.Trans.editingTeamswaps(serverId).match(root) || UP.Trans.viewingTeams(serverId).match(root)
			}
			event$={event$}
			className="min-w-0"
		/>
	)
}

function QueueBody(props: { stores: SquadServerFrame.KeyProp }) {
	return (
		<>
			<IngameVoteAlert stores={props.stores} />
			<SlmUpdatesDisabledAlert stores={props.stores} />
			<PluginSlot anchor="server-dashboard:queue-alerts" anchorProps={{ serverId: props.stores.squadServer.serverId }} />
			{/* the tour's queue anchor stops here: layer requests (the backburner) are not part of the queue */}
			<div data-tour="queue-panel">
				<QueuePanelContent stores={props.stores} />
			</div>
			<BackburnerPanel stores={props.stores} />
		</>
	)
}

// The queue with a heading of its own, for every layout that shows it beside the teams rather than behind a tab.
function QueueCard(props: { stores: SquadServerFrame.KeyProp; onTouch?: () => void; ref?: React.RefObject<HTMLDivElement | null> }) {
	const queueLength = Zus.useStore(props.stores.squadServer, (s) => s.queue.layerList.length)
	return (
		<Card
			ref={props.ref}
			role="region"
			aria-labelledby={titleId('queue')}
			onPointerDownCapture={props.onTouch}
			onFocusCapture={props.onTouch}
		>
			<CardHeader>
				<CardTitle id={titleId('queue')} data-tour="queue-editors">
					{tr.text(APP_Msgs.queueTab(queueLength))}
				</CardTitle>
				<span className="ml-auto flex min-w-0 items-center gap-2">
					<QueuePresence stores={props.stores} />
				</span>
			</CardHeader>
			<QueueBody stores={props.stores} />
		</Card>
	)
}

function TeamsCard(props: { stores: SquadServerFrame.KeyProp; onTouch?: () => void; ref?: React.RefObject<HTMLDivElement | null> }) {
	const playerCount = Zus.useStore(props.stores.squadServer, (s) => ChatPrt.Sel.players(s).length)
	const titleRef = React.useRef<HTMLDivElement>(null)
	return (
		<Card
			ref={props.ref}
			id={bodyId('teams')}
			role="region"
			aria-labelledby={titleId('teams')}
			onPointerDownCapture={props.onTouch}
			onFocusCapture={props.onTouch}
		>
			{/* the title stays on screen while the tables scroll under it; the teams panel's own header stacks below */}
			<StickyGroup stickyRef={titleRef}>
				<CardHeader ref={titleRef}>
					<CardTitle id={titleId('teams')}>{tr.text(APP_Msgs.teamsTab(playerCount))}</CardTitle>
					<span className="ml-auto flex min-w-0 items-center gap-2">
						<TeamsPresence stores={props.stores} />
					</span>
				</CardHeader>
				<TeamsPanel stores={props.stores} />
			</StickyGroup>
		</Card>
	)
}

/**
 * Match History, the Teams Breakdown, the Queue and the Teams. `part` picks which of those this instance
 * renders: the one- and two-column dashboards stack them all in one column, the three-column one splits them
 * down the middle, history with the queue and the breakdown with the teams. `stacked` shows the queue and the
 * teams at once, one above the other, instead of behind tabs, and `'when-it-fits'` picks between the two from
 * whether they both do.
 */
export default function PrimaryPanel(props: {
	stores: SquadServerFrame.KeyProp
	part?: 'all' | 'history-queue' | 'stats-teams'
	// whether the breakdown sits here; implied by `stats-teams`. The single-column layout keeps it with
	// Server Activity instead.
	withStats?: boolean
	statsWide?: boolean
	stacked?: boolean | 'when-it-fits'
}) {
	const part = props.part ?? 'all'
	// Split across two columns, both sections are on screen at once, which is what `stacked` means to presence:
	// there is no tab to report, so it follows the section last interacted with.
	const split = part !== 'all'
	React.useEffect(() => {
		if (split) SquadServerClient.PrimaryPanelActions.setStacked(true)
	}, [split])
	const touch = (section: ClientOnlySettings.PrimaryPanelTab) => () => SquadServerClient.PrimaryPanelActions.touchStackedSection(section)

	const content = (
		<div className="flex flex-col gap-2.5 flex-1">
			{part !== 'stats-teams' && (
				<>
					<Card>
						<MatchHistoryPanelContent stores={props.stores} />
					</Card>
					<PluginSlot anchor="server-dashboard:alerts" anchorProps={{ serverId: props.stores.squadServer.serverId }} />
				</>
			)}
			{(props.withStats || part === 'stats-teams') && (
				<React.Suspense fallback={null}>
					<StatsPanel stores={props.stores} wide={props.statsWide} />
				</React.Suspense>
			)}
			{part === 'all' && <QueueTeamsTabs stores={props.stores} stacked={props.stacked} />}
			{part === 'history-queue' && <QueueCard stores={props.stores} onTouch={touch('VIEWING_QUEUE')} />}
			{part === 'stats-teams' && <TeamsCard stores={props.stores} onTouch={touch('VIEWING_TEAMS')} />}
		</div>
	)
	// One scroller for the whole column, so everything in it moves together. `stats-teams` is the exception: it
	// is the half of the ultrawide split that scrolls the page, so its scroller is the dashboard's. The other
	// half is pinned to the window there, and scrolls within that.
	if (part === 'stats-teams') return <div className="min-w-0 @container">{content}</div>
	return (
		<ScrollArea fill className="flex-1 min-h-0 min-w-0 @container">
			{content}
		</ScrollArea>
	)
}

function QueueTeamsTabs(props: { stores: SquadServerFrame.KeyProp; stacked?: boolean | 'when-it-fits' }) {
	// the visible panel is client-only state; presence mirrors it while the client is engaged (see the
	// dashboard route effect). tab switches persist and drive display without needing a presence entry.
	const tab: PanelTab = Zus.useStore(ClientOnlySettings.Store, (s) => (s.primaryPanelTab === 'VIEWING_TEAMS' ? 'teams' : 'queue'))

	const queueLength = Zus.useStore(props.stores.squadServer, (s) => s.queue.layerList.length)
	const playerCount = Zus.useStore(props.stores.squadServer, (s) => ChatPrt.Sel.players(s).length)

	const rootRef = React.useRef<HTMLDivElement>(null)
	// the scroller is never this panel's own: in the two-column layout it is the enclosing column's, shared
	// with Match History and the breakdown, and in the tablet one it is the same column's. So this reads
	// upwards rather than down, and takes whichever comes first.
	const findScroller = () => rootRef.current?.closest<HTMLElement>('[data-radix-scroll-area-viewport],[data-dashboard-scroller]')

	// what the column can show at once is what decides between the two layouts, so the budget is the
	// scroller's visible height rather than the panel's own, which is as tall as its content
	const fit = useStackWhenItFits({ enabled: props.stacked === 'when-it-fits', getBudgetEl: findScroller })
	const stacked = props.stacked === 'when-it-fits' ? fit.stacked : (props.stacked ?? false)
	React.useEffect(() => {
		SquadServerClient.PrimaryPanelActions.setStacked(stacked)
	}, [stacked])
	// both panels share that one scroller, so without this a switch carries the previous tab's scroll
	// position over and clamps it against the new tab's height
	const scrollPositions = React.useRef<Record<PanelTab, number>>({ queue: 0, teams: 0 })
	const scrolledTabRef = React.useRef(tab)

	React.useEffect(() => {
		if (stacked) return
		const viewport = findScroller()
		if (!viewport) return
		const onScroll = () => {
			scrollPositions.current[scrolledTabRef.current] = viewport.scrollTop
		}
		viewport.addEventListener('scroll', onScroll, { passive: true })
		return () => viewport.removeEventListener('scroll', onScroll)
	}, [stacked])

	React.useLayoutEffect(() => {
		if (stacked) return
		scrolledTabRef.current = tab
		const viewport = findScroller()
		if (!viewport) return
		viewport.scrollTop = scrollPositions.current[tab]
	}, [tab, stacked])

	const tabBarRef = React.useRef<HTMLDivElement>(null)

	if (stacked) {
		// Both panels at once, scrolling with the rest of the page. Presence follows the section last touched
		// (see viewedPrimaryPanel$); capture-phase React handlers see clicks inside portals too, so a player
		// dialog counts as the teams.
		const touch = (section: ClientOnlySettings.PrimaryPanelTab) => () =>
			SquadServerClient.PrimaryPanelActions.touchStackedSection(section)
		return (
			<div ref={rootRef} className="flex flex-col gap-2.5">
				<QueueCard stores={props.stores} ref={fit.firstRef} onTouch={touch('VIEWING_QUEUE')} />
				<TeamsCard stores={props.stores} ref={fit.secondRef} onTouch={touch('VIEWING_TEAMS')} />
			</div>
		)
	}

	return (
		<div ref={rootRef} className="flex flex-col flex-1 min-w-0">
			{/* the column scrolls as one, so the tab bar would leave with Match History: pin it, since it is
			    what switches away from whatever you scrolled down to. `bg-ground` because the tabs have gaps
			    between them and the content passes underneath */}
			<StickyGroup stickyRef={tabBarRef}>
				<TabBar
					ref={tabBarRef}
					className="bg-ground"
					tabs={[
						{ value: 'queue', label: <span data-tour="queue-editors">{tr.text(APP_Msgs.queueTab(queueLength))}</span> },
						{ value: 'teams', label: tr.text(APP_Msgs.teamsTab(playerCount)) },
					]}
					value={tab}
					onChange={(value) => ClientOnlySettings.Actions.setPrimaryPanelTab(value === 'teams' ? 'VIEWING_TEAMS' : 'VIEWING_QUEUE')}
					trailing={
						<>
							<QueuePresence stores={props.stores} />
							<TeamsPresence stores={props.stores} />
						</>
					}
				/>
				<div className="fd-tabbody flex flex-col flex-1 relative">
					<div className="grid">
						{/* both panels stay mounted, since they hold local state (table sorting, selection) that a
						    remount would drop. the inactive one is `display: none` rather than `invisible` so it
						    contributes no height: sharing a grid cell, it would otherwise leave the shorter tab
						    scrolling past its own content */}
						<div
							role="tabpanel"
							id={bodyId('queue')}
							aria-labelledby={titleId('queue')}
							className={cn('[grid-area:1/1]', tab !== 'queue' && 'hidden')}
						>
							<QueueBody stores={props.stores} />
						</div>
						<div
							role="tabpanel"
							id={bodyId('teams')}
							aria-labelledby={titleId('teams')}
							className={cn('[grid-area:1/1]', tab !== 'teams' && 'hidden')}
						>
							<TeamsPanel stores={props.stores} />
						</div>
					</div>
				</div>
			</StickyGroup>
		</div>
	)
}
