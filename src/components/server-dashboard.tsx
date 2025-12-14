import LayersPanel from '@/components/layers-panel.tsx'
import ServerActivityPanel from '@/components/server-activity-panel.tsx'
import { TeamIndicator } from '@/components/teams-display.tsx'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import React from 'react'
import * as Zus from 'zustand'
import { ServerActionsDropdown } from './server-actions-dropdown.tsx'
import { Label } from './ui/label.tsx'
import { Switch } from './ui/switch.tsx'
import TabsList from './ui/tabs-list.tsx'

export default function ServerDashboard() {
	const [activeTab, setActiveTab] = React.useState<'layers' | 'server-activity'>('layers')
	const [isDesktop, setIsDesktop] = React.useState(false)

	React.useEffect(() => {
		const mediaQuery = window.matchMedia('(min-width: 1280px)')
		setIsDesktop(mediaQuery.matches)

		const handleChange = (e: MediaQueryListEvent) => {
			setIsDesktop(e.matches)
		}

		mediaQuery.addEventListener('change', handleChange)
		return () => mediaQuery.removeEventListener('change', handleChange)
	}, [])

	return (
		<div className="mx-auto grid place-items-center">
			{!isDesktop && (
				/* Mobile/tablet: Single column with tabs */
				<div className="flex flex-col gap-2">
					{/* Top line - always visible */}
					<div className="justify-between flex items-center">
						<div className="flex items-center gap-2">
							<TabsList
								options={[
									{ value: 'layers', label: 'Layers' },
									{ value: 'server-activity', label: 'Server Activity' },
								]}
								active={activeTab}
								setActive={setActiveTab}
							/>
							<NormTeamsSwitch />
						</div>
						<ServerActionsDropdown />
					</div>

					<div style={{ visibility: activeTab === 'layers' ? 'visible' : 'hidden', height: activeTab === 'layers' ? 'auto' : '0' }}>
						<LayersPanel />
					</div>
					<div
						style={{
							visibility: activeTab === 'server-activity' ? 'visible' : 'hidden',
							height: activeTab === 'server-activity' ? 'auto' : '0',
						}}
					>
						<ServerActivityPanel />
					</div>
				</div>
			)}

			{isDesktop && (
				/* Desktop: Two column layout */
				<div className="grid grid-cols-[auto,auto] gap-2">
					{/* Top line */}
					<div className="col-span-2 justify-between flex">
						<NormTeamsSwitch />
						<ServerActionsDropdown />
					</div>
					{/* left column */}
					<div className="flex flex-col gap-2">
						<LayersPanel />
					</div>
					{/* right column */}
					<div className="flex gap-2">
						<ServerActivityPanel />
					</div>
				</div>
			)}
		</div>
	)
}

function NormTeamsSwitch() {
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
