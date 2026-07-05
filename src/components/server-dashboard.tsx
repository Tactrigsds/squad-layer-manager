import React from 'react'

import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { useIsDesktopSize } from '@/lib/browser.ts'
import * as WarnChat from '@/systems/warn-chat.client'

import PrimaryPanel from './primary-panel.tsx'
import SecondaryPanel from './secondary-panel.tsx'
import TabsList from './ui/tabs-list.tsx'

export default function ServerDashboard(props: { stores: SquadServerFrame.KeyProp }) {
	const [activeTab, setActiveTab] = React.useState<'layers' | 'secondary'>('layers')
	const isDesktop = useIsDesktopSize()

	// "warn selected" routes to the server activity panel; in single-column mode that panel lives behind a
	// tab, so bring it forward (harmless in desktop, where both panels are always visible)
	WarnChat.useWarnFocusRequest(t => t.kind === 'server-activity', () => setActiveTab('secondary'))

	return (
		<div className="w-full h-full flex flex-col overflow-x-auto">
			{!isDesktop && (
				/* Mobile/tablet: Single column with tabs */
				<div className="flex flex-col gap-2 h-full min-h-0">
					{/* Top line - always visible */}
					<div className="justify-between flex items-center shrink-0">
						<div className="flex items-center gap-2">
							<TabsList
								options={[
									{ value: 'layers', label: 'Layers & Teams' },
									{ value: 'secondary', label: 'Server Activity' },
								]}
								active={activeTab}
								setActive={setActiveTab}
							/>
						</div>
					</div>

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
				/* Desktop: Two column layout */
				<div className="flex gap-2 h-full min-h-0 w-full justify-center">
					{/* left column — grows into free space (capped) to give the teams grid more room */}
					<div className="flex flex-col gap-2 shrink-0 min-w-0 grow max-w-[1250px]">
						<PrimaryPanel stores={props.stores} />
					</div>
					{/* right column — explicit width matches SecondaryPanel max-w so justify-center works */}
					<div className="flex min-h-0 min-w-0 w-[800px] shrink">
						<SecondaryPanel stores={props.stores} />
					</div>
				</div>
			)}
		</div>
	)
}
