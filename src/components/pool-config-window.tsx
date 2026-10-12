import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as ServerSettingsPrt from '@/frame-partials/server-settings.partial'
import { useFrameLifecycle } from '@/frames/frame-manager'
import * as RepeatRulesetEditorFrame from '@/frames/repeat-ruleset-editor.frame'
import { useState_withGlobalHandle } from '@/lib/use-state-with-global-handle'
import * as Zus from '@/lib/zustand'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as TUT from '@/models/tutorial.models'
import * as UP from '@/models/user-presence.models'
import { DraggableWindowStore, frameDependency } from '@/systems/draggable-window.client'
import { tr } from '@/systems/messages.client'
import * as UPClient from '@/systems/user-presence.client'

import { useStorePoolConfigApi } from './pool-config-panels.helpers.ts'
import { GenerationPanel, NextLayerPanel, PoolFiltersPanel, PoolRepeatRulesetPanel } from './pool-config-panels.tsx'
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
	// the repeat rules table is the widest thing in here and wants 1047px of content; the 2 extra are the border
	defaultWidth: 1049,
	defaultHeight: 640,
	getId: (props) => `pool-config:${props.stores.squadServer!.serverId}`,
	dependsOn: (props) => [frameDependency(props.stores.squadServer!)],
})

// The rules go first: they are saved into the ruleset the server already uses, or the one it is being switched to,
// and a server pointed at a ruleset whose rules failed to save would apply rules nobody chose.
async function saveAll(stores: ServerSettingsPrt.KeyProp & RepeatRulesetEditorFrame.KeyProp) {
	if (!(await RepeatRulesetEditorFrame.Actions.save(stores))) return
	if (Zus.getState(stores.settings).settings.modified) await ServerSettingsPrt.Actions.save(stores)
}

function PoolConfigWindow(props: PoolConfigWindowProps) {
	const stores = props.stores

	const serverId = stores.squadServer!.serverId
	// memoized so the effect below doesn't re-run (and discard pending edits) on every render
	const viewingSettingsTrans = UP.Trans.viewingSettings(serverId)
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

	const [serverSettingsChanged, serverSettingsSaving, validationErrors] = Zus.useStore(
		stores.squadServer!,
		Zus.useShallow((s) => [s.settings.modified, s.settings.saving, s.settings.validationErrors]),
	)
	const repeatRulesetEditor = useFrameLifecycle(RepeatRulesetEditorFrame.frame, {
		input: { source: { type: 'server', settingsKey: stores.squadServer! } },
	})
	const [rulesChanged, rulesSaving] = Zus.useStore(
		repeatRulesetEditor,
		Zus.useShallow((s) => [s.modified, s.saving]),
	)
	const settingsChanged = serverSettingsChanged || rulesChanged
	const saving = serverSettingsSaving || rulesSaving

	const mainPoolApi = useStorePoolConfigApi(stores.squadServer!, ['queue', 'mainPool'])
	// the next-layer settings sit outside the pool subtree, so each gets its own api and its own write check
	const nextLayerApis = {
		overrideAdminSetNextLayer: useStorePoolConfigApi(stores.squadServer!, ['overrideAdminSetNextLayer']),
		warnOnNextLayerChange: useStorePoolConfigApi(stores.squadServer!, ['warnOnNextLayerChange']),
	}
	// with write access to nothing in the window it is a read-only viewer: the panels disable their controls, and
	// the save/reset affordances disappear (this is all public data, so viewing stays available)
	const readOnly = !!mainPoolApi.writeDenied && Object.values(nextLayerApis).every((api) => !!api.writeDenied)

	const [tab, setTab] = useState_withGlobalHandle<'filters' | 'repeatRules' | 'generation' | 'nextLayer'>(
		TUT.TOUR_HANDLES.poolConfigTab,
		'filters',
	)

	return (
		<div className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>
					<span className="flex items-center gap-2">
						{tr.text(SETTINGS_Msgs.poolConfigTitle())}
						{readOnly && (
							<span className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
								{tr.text(SETTINGS_Msgs.readOnlyBadge())}
							</span>
						)}
					</span>
				</DraggableWindowTitle>
				<span data-tour="pool-config-tabs">
					<TabsList
						options={[
							{ label: tr.text(SETTINGS_Msgs.poolFiltersTab()), value: 'filters' },
							{ label: tr.text(SETTINGS_Msgs.repeatRules()), value: 'repeatRules' },
							{ label: tr.text(SETTINGS_Msgs.generationTab()), value: 'generation' },
							{ label: tr.text(SETTINGS_Msgs.nextLayer()), value: 'nextLayer' },
						]}
						active={tab}
						setActive={setTab}
					/>
				</span>
				<DraggableWindowPinToggle />
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<div data-tour="pool-config-body" className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-6">
				{tab === 'filters' ? (
					<PoolFiltersPanel api={mainPoolApi} />
				) : tab === 'repeatRules' ? (
					<PoolRepeatRulesetPanel poolApi={mainPoolApi} repeatRulesetEditor={repeatRulesetEditor} />
				) : tab === 'generation' ? (
					<GenerationPanel api={mainPoolApi} />
				) : (
					<NextLayerPanel apis={nextLayerApis} />
				)}
			</div>
			{!readOnly && (
				<div className="flex items-center justify-end gap-2 px-6 py-3 border-t">
					<div className="flex flex-col gap-2 me-auto">
						{validationErrors &&
							validationErrors.map((error) => (
								<Alert key={error} variant="destructive">
									<AlertDescription>{error}</AlertDescription>
								</Alert>
							))}
					</div>
					<Tooltip help>
						<TooltipTrigger asChild>
							<Button
								size="icon"
								variant="ghost"
								disabled={!settingsChanged || saving}
								onClick={() => {
									ServerSettingsPrt.Actions.reset({ settings: stores.squadServer! })
									RepeatRulesetEditorFrame.Actions.reset({ repeatRulesetEditor })
								}}
							>
								<Icons.Undo className="h-4 w-4 rtl:-scale-x-100" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>{tr.text(SETTINGS_Msgs.resetChanges())}</p>
						</TooltipContent>
					</Tooltip>
					<Button
						variant="primary"
						disabled={!settingsChanged || saving || !!validationErrors}
						onClick={() => void saveAll({ settings: stores.squadServer!, repeatRulesetEditor })}
						className="min-w-30"
					>
						<Spinner
							className="invisible animate-none data-[saving=true]:visible data-[saving=true]:animate-spin"
							data-saving={saving}
						/>
						{tr.text(SETTINGS_Msgs.saveChanges())}
						<Spinner className="invisible animate-none" />
					</Button>
				</div>
			)}
		</div>
	)
}
