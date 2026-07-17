import React from 'react'

import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { useIsDesktopSize } from '@/lib/browser.ts'
import * as ZusUtils from '@/lib/zustand'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as WarnChat from '@/systems/warn-chat.client'

import PrimaryPanel from './primary-panel.tsx'
import SecondaryPanel from './secondary-panel.tsx'

export default function ServerDashboard(props: { stores: SquadServerFrame.KeyProp }) {
	const activeTab = ZusUtils.useStore(SquadServerClient.DashboardTabStore, s => s.activeTab)
	const isDesktop = useIsDesktopSize()

	// "warn selected" routes to the server activity panel; in single-column mode that panel lives behind a
	// tab, so bring it forward (harmless in desktop, where both panels are always visible)
	WarnChat.useWarnFocusRequest(t => t.kind === 'server-activity', () => SquadServerClient.DashboardTabActions.setActiveTab('secondary'))

	return (
		<div className="w-full h-full flex flex-col overflow-x-auto">
			{!isDesktop && (
				/* Mobile/tablet: single column; the tab switcher lives in the NavBar */
				<div className="flex flex-col gap-2 h-full min-h-0">
					<div className="flex-1 min-h-0" style={{ display: activeTab === 'layers' ? 'flex' : 'none' }}>
						<PrimaryPanel stores={props.stores} />
					</div>
					<div
						className="flex-1 min-h-0"
						style={{ display: activeTab === 'secondary' ? 'flex' : 'none' }}
					>
						<SecondaryPanel stores={props.stores} />
					</div>
				</div>
			)}

			{isDesktop && (
				/* Desktop: two proportional columns. `minmax(0,...)` on both tracks lets them share the give, so
				   the right column no longer absorbs all the shrink and starve (the left used to be grow+shrink-0,
				   which greedily took the space and forced the right one to collapse). Capped and centered so
				   ultrawide gutters rather than stretching the panels past a readable width. */
				<div className="grid gap-2 h-full min-h-0 w-full max-w-[2050px] mx-auto grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
					<div className="flex flex-col gap-2 min-h-0 min-w-0">
						<PrimaryPanel stores={props.stores} />
					</div>
					<div className="flex min-h-0 min-w-0">
						<SecondaryPanel stores={props.stores} />
					</div>
				</div>
			)}
		</div>
	)
}
