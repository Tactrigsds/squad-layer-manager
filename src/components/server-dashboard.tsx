import React from 'react'

import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { useIsDesktopSize, useIsSmallViewport, useIsUltrawide, useIsWideDesktop } from '@/lib/browser.ts'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as WarnChat from '@/systems/warn-chat.client'

import PhoneDashboard from './phone-dashboard.tsx'
import PrimaryPanel from './primary-panel.tsx'
import SecondaryPanel from './secondary-panel.tsx'
import ServerActivityPanel from './server-activity-panel.tsx'

/**
 * Where the panels sit, by viewport width. The panels themselves do not change between tiers.
 *
 *   < 640      phone: one panel at a time behind a bottom tab bar (phone-dashboard.tsx)
 *   640..1099  one column; the nav bar's switch picks between the layers side and Server Activity
 *   1100..2099 two columns: history, breakdown and the tabs on the left, Server Activity full height on the right
 *   >= 2100    three columns: history + breakdown, the queue above the teams, Server Activity
 */
export default function ServerDashboard(props: { stores: SquadServerFrame.KeyProp }) {
	const activeTab = SquadServerClient.dashboardSide(SquadServerClient.useDashboardTab())
	const isDesktop = useIsDesktopSize()
	const isUltrawide = useIsUltrawide()
	const isWideDesktop = useIsWideDesktop()
	const isPhone = useIsSmallViewport()

	// "warn selected" routes to the server activity panel; in single-column mode that panel lives behind a
	// tab, so bring it forward (harmless in desktop, where both panels are always visible)
	WarnChat.useWarnFocusRequest(
		(t) => t.kind === 'server-activity',
		() => SquadServerClient.DashboardTabActions.setSide('secondary'),
	)

	if (isPhone) return <PhoneDashboard stores={props.stores} />

	return (
		<div className="w-full h-full flex flex-col overflow-x-auto">
			{!isDesktop && (
				/* Tablet: single column; the tab switcher lives in the NavBar. The hidden panel is
				   `display: none`, so only the visible one's floor decides whether this scrolls. */
				<div className="flex flex-col gap-2 h-full min-h-0">
					<div className="flex-1 min-h-0 min-w-[860px]" style={{ display: activeTab === 'layers' ? 'flex' : 'none' }}>
						<PrimaryPanel stores={props.stores} />
					</div>
					<div className="flex-1 min-h-0" style={{ display: activeTab === 'secondary' ? 'flex' : 'none' }}>
						<SecondaryPanel stores={props.stores} />
					</div>
				</div>
			)}

			{isDesktop && !isUltrawide && (
				/* Two proportional columns that share the give above their floors, and stop shrinking at them:
				   660 + 400 + gaps fits the 1100 breakpoint without a sideways scroll. Below the floors the
				   dashboard outgrows the viewport and this container's `overflow-x-auto` scrolls the whole page. */
				<div className="grid gap-2.5 h-full min-h-0 w-full grid-cols-[minmax(660px,1.6fr)_minmax(400px,1fr)]">
					<PrimaryPanel stores={props.stores} withStats statsWide={isWideDesktop} />
					<div className="flex min-h-0 min-w-0">
						<ServerActivityPanel stores={props.stores} />
					</div>
				</div>
			)}

			{isDesktop && isUltrawide && (
				/* Spend the width on a third column rather than gutters: history and the breakdown stack on the
				   left, the queue and the teams stack in the middle, Server Activity gets a full-height column. */
				<div className="grid gap-2.5 h-full min-h-0 w-full grid-cols-[600px_minmax(0,1fr)_680px]">
					<PrimaryPanel stores={props.stores} part="history" withStats />
					<PrimaryPanel stores={props.stores} part="tabs" stacked />
					<div className="flex min-h-0 min-w-0">
						<ServerActivityPanel stores={props.stores} />
					</div>
				</div>
			)}
		</div>
	)
}
