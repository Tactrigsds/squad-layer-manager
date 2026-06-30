import React from 'react'

import { useIsDesktopSize } from '@/lib/browser.ts'

import PrimaryPanel from './primary-panel.tsx'
import SecondaryPanel from './secondary-panel.tsx'
import TabsList from './ui/tabs-list.tsx'

export default function ServerDashboard() {
	const [activeTab, setActiveTab] = React.useState<'layers' | 'secondary'>('layers')
	const isDesktop = useIsDesktopSize()

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
						<PrimaryPanel />
					</div>
					<div
						className="flex-1 min-h-0"
						style={{ display: activeTab === 'secondary' ? 'flex' : 'none' }}
					>
						<SecondaryPanel />
					</div>
				</div>
			)}

			{isDesktop && (
				/* Desktop: Two column layout */
				<div className="flex gap-2 h-full min-h-0 w-full justify-center">
					{/* left column */}
					<div className="flex flex-col gap-2 shrink-0 min-w-0">
						<PrimaryPanel />
					</div>
					{/* right column — explicit width matches SecondaryPanel max-w so justify-center works */}
					<div className="flex min-h-0 min-w-0 w-[800px] shrink">
						<SecondaryPanel />
					</div>
				</div>
			)}
		</div>
	)
}
