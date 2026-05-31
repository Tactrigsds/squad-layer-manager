import ServerActivityPanel from '@/components/server-activity-panel.tsx'

import React from 'react'

import { useIsDesktopSize } from '@/lib/browser.ts'

import LayerQueuePanel from './layer-queue-panel.tsx'
import TabsList from './ui/tabs-list.tsx'

export default function ServerDashboard() {
	const [activeTab, setActiveTab] = React.useState<'layers' | 'server-activity'>('layers')
	const isDesktop = useIsDesktopSize()

	return (
		<div className="w-full h-full flex flex-col">
			{!isDesktop && (
				/* Mobile/tablet: Single column with tabs */
				<div className="flex flex-col gap-2 h-full min-h-0">
					{/* Top line - always visible */}
					<div className="justify-between flex items-center shrink-0">
						<div className="flex items-center gap-2">
							<TabsList
								options={[
									{ value: 'layers', label: 'Layers' },
									{ value: 'server-activity', label: 'Server Activity' },
								]}
								active={activeTab}
								setActive={setActiveTab}
							/>
						</div>
					</div>

					<div className="flex-1 min-h-0" style={{ display: activeTab === 'layers' ? 'flex' : 'none' }}>
						<LayerQueuePanel />
					</div>
					<div
						className="flex-1 min-h-0"
						style={{
							display: activeTab === 'server-activity' ? 'flex' : 'none',
						}}
					>
						<ServerActivityPanel />
					</div>
				</div>
			)}

			{isDesktop && (
				/* Desktop: Two column layout */
				<div className="flex gap-2 h-full min-h-0 mx-auto">
					{/* left column */}
					<div className="flex flex-col gap-2 shrink-0">
						<LayerQueuePanel />
					</div>
					{/* right column */}
					<div className="flex gap-2 flex-1 min-h-0">
						<ServerActivityPanel />
					</div>
				</div>
			)}
		</div>
	)
}
