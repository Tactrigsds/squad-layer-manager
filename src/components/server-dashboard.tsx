import LayersPanel from '@/components/layers-panel.tsx'
import ServerActivityPanel from '@/components/server-activity-panel.tsx'
import { TeamIndicator } from '@/components/teams-display.tsx'
import { GlobalSettingsStore } from '@/systems/global-settings.client'
import React from 'react'
import * as Zus from 'zustand'

import { useIsDesktopSize } from '@/lib/browser.ts'
import { Label } from './ui/label.tsx'
import { Switch } from './ui/switch.tsx'
import TabsList from './ui/tabs-list.tsx'

export function NormTeamsSwitch() {
	const globalSettings = Zus.useStore(GlobalSettingsStore)
	const switchId = React.useId()

	const onCheckedChange = (checked: boolean | 'indeterminate') => {
		if (checked === 'indeterminate') return
		globalSettings.setDisplayTeamsNormalized(checked)
	}

	return (
		<div className="flex space-x-1 items-center p-2">
			<Switch
				id={switchId}
				defaultChecked={globalSettings.displayTeamsNormalized}
				onCheckedChange={onCheckedChange}
			/>
			<Label className="cursor-pointer" htmlFor={switchId}>
				Normalize Teams {globalSettings.displayTeamsNormalized
					? (
						<span>
							(left: <TeamIndicator team="A" /> right: <TeamIndicator team="B" />)
						</span>
					)
					: (
						<span>
							(left: <TeamIndicator team={1} /> right: <TeamIndicator team={2} />)
						</span>
					)}
			</Label>
		</div>
	)
}

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
						<NormTeamsSwitch />
					</div>

					<div className="flex-1 min-h-0" style={{ display: activeTab === 'layers' ? 'flex' : 'none' }}>
						<LayersPanel />
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
						<LayersPanel />
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
