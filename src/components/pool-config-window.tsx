import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as ServerSettingsPrt from '@/frame-partials/server-settings.partial'
import * as ZusUtils from '@/lib/zustand'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as UP from '@/models/user-presence'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import * as UPClient from '@/systems/user-presence.client'
import * as Icons from 'lucide-react'
import React from 'react'
import { useStorePoolConfigApi } from './pool-config-panels.helpers.ts'
import { NextLayerPanel, PoolFiltersPanel, RepeatRulesPanel } from './pool-config-panels.tsx'
import type { PoolConfigWindowProps } from './pool-config-window.helpers.ts'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowPinToggle, DraggableWindowTitle } from './ui/draggable-window'
import TabsList from './ui/tabs-list.tsx'

DraggableWindowStore.getState().registerDefinition<PoolConfigWindowProps, unknown>({
	type: WINDOW_ID.enum['pool-config'],
	component: PoolConfigWindow,
	initialPosition: 'left',
	resizable: true,
	minWidth: 560,
	minHeight: 400,
	defaultWidth: 800,
	defaultHeight: 640,
	getId: (props) => `pool-config:${props.stores.squadServer!.serverId}`,
})

function PoolConfigWindow(props: PoolConfigWindowProps) {
	const stores = props.stores

	const serverId = stores.squadServer!.serverId
	// memoized so the effect below doesn't re-run (and discard pending edits) on every render
	const viewingSettingsTrans = React.useMemo(() => UP.Trans.viewingSettings(serverId), [serverId])
	const [, setViewingSettings] = UPClient.useActivityState(viewingSettingsTrans)
	// presence + pending-edit lifecycle follows the window: closing it withdraws the viewing activity and
	// discards unsaved edits, same as closing the old popover did
	React.useEffect(() => {
		setViewingSettings(true)
		return () => {
			setViewingSettings(false)
			ServerSettingsPrt.Actions.reset({ settings: stores.squadServer! })
		}
	}, [setViewingSettings, stores.squadServer])

	const [settingsChanged, saving, validationErrors] = ZusUtils.useStore(
		stores.squadServer!,
		ZusUtils.useShallow(s => [s.settings.modified, s.settings.saving, s.settings.validationErrors]),
	)

	const mainPoolApi = useStorePoolConfigApi(stores.squadServer!, ['queue', 'mainPool'])
	// the next-layer settings sit outside the pool subtree, so each gets its own api and its own write check
	const nextLayerApis = {
		overrideAdminSetNextLayer: useStorePoolConfigApi(stores.squadServer!, ['overrideAdminSetNextLayer']),
		warnOnNextLayerChange: useStorePoolConfigApi(stores.squadServer!, ['warnOnNextLayerChange']),
	}
	// with write access to nothing in the window it is a read-only viewer: the panels disable their controls, and
	// the save/reset affordances disappear (this is all public data, so viewing stays available)
	const readOnly = !!mainPoolApi.writeDenied && Object.values(nextLayerApis).every((api) => !!api.writeDenied)

	const [tab, setTab] = React.useState<'filters' | 'repeatRules' | 'nextLayer'>('filters')

	return (
		<div className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>
					<span className="flex items-center gap-2">
						Pool Configuration
						{readOnly && <span className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">Read-only</span>}
					</span>
				</DraggableWindowTitle>
				<TabsList
					options={[
						{ label: 'Filters', value: 'filters' },
						{ label: 'Repeat Rules', value: 'repeatRules' },
						{ label: 'Next Layer', value: 'nextLayer' },
					]}
					active={tab}
					setActive={setTab}
				/>
				<DraggableWindowPinToggle />
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-6">
				{tab === 'filters'
					? <PoolFiltersPanel api={mainPoolApi} />
					: tab === 'repeatRules'
					? <RepeatRulesPanel api={mainPoolApi} />
					: <NextLayerPanel apis={nextLayerApis} />}
			</div>
			{!readOnly && (
				<div className="flex items-center justify-end gap-2 px-6 py-3 border-t">
					<div className="flex flex-col gap-2 mr-auto">
						{validationErrors && validationErrors.map((error) => (
							<Alert key={error} variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						))}
					</div>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								size="icon"
								variant="ghost"
								disabled={!settingsChanged || saving}
								onClick={() => {
									ServerSettingsPrt.Actions.reset({ settings: stores.squadServer! })
								}}
							>
								<Icons.Trash className="h-4 w-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Reset changes</p>
						</TooltipContent>
					</Tooltip>
					<Button
						disabled={!settingsChanged || saving || !!validationErrors}
						onClick={() => void ServerSettingsPrt.Actions.save({ settings: stores.squadServer! })}
						className="min-w-30"
					>
						<Spinner className="invisible data-[saving=true]:visible" data-saving={saving} />
						Save Changes
						<Spinner className="invisible" />
					</Button>
				</div>
			)}
		</div>
	)
}
