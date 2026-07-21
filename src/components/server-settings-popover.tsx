import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as ServerSettingsPrt from '@/frame-partials/server-settings.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as ZusUtils from '@/lib/zustand'
import * as UP from '@/models/user-presence'
import * as UPClient from '@/systems/user-presence.client'
import * as Icons from 'lucide-react'
import React from 'react'
import { useStorePoolConfigApi } from './pool-config-panels.helpers.ts'
import { PoolFiltersPanel, RepeatRulesPanel } from './pool-config-panels.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'

export default function ServerSettingsPopover(
	props: {
		children: React.ReactNode
		stores: SquadServerFrame.KeyProp
	},
) {
	const stores = props.stores

	const [open, _setOpen] = UPClient.useActivityState(UP.Trans.viewingSettings(stores.squadServer!.serverId))
	const setOpen = (open: boolean) => {
		if (!open) {
			ServerSettingsPrt.Actions.reset({ settings: stores.squadServer! })
		}
		_setOpen(open)
	}

	const [settingsChanged, saving, validationErrors] = ZusUtils.useStore(
		stores.squadServer!,
		ZusUtils.useShallow(s => [s.settings.modified, s.settings.saving, s.settings.validationErrors]),
	)

	const mainPoolApi = useStorePoolConfigApi(stores.squadServer!, ['queue', 'mainPool'])
	// with no write access the popover is a read-only viewer: the panels disable their controls, and the
	// save/reset affordances disappear (pool config itself is public data, so viewing stays available)
	const readOnly = !!mainPoolApi.writeDenied

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent
				className="w-200 flex flex-col space-y-4 p-6"
				side="left"
				align="start"
			>
				<div className="flex items-center justify-between border-b pb-3">
					<h3 className="text-lg font-semibold flex items-center gap-2">
						Pool Configuration
						{readOnly && <span className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">Read-only</span>}
					</h3>
					<div className="flex items-center space-x-2">
						{!readOnly && (
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
						)}
					</div>
				</div>
				<div className="space-y-6">
					<PoolFiltersPanel api={mainPoolApi} />
					<RepeatRulesPanel api={mainPoolApi} />
				</div>
				<div className="flex justify-end gap-2 pt-4 border-t">
					<div className="flex flex-col gap-2">
						{validationErrors && validationErrors.map((error) => (
							<Alert key={error} variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						))}
					</div>
					<Button
						variant="outline"
						onClick={() => setOpen(false)}
					>
						Close
					</Button>
					{!readOnly && (
						<Button
							disabled={!settingsChanged || saving || !!validationErrors}
							onClick={async () => {
								const saved = await ServerSettingsPrt.Actions.save({ settings: stores.squadServer! })
								if (saved) _setOpen(false)
							}}
							className="min-w-30"
						>
							<Spinner className="invisible data-[saving=true]:visible" data-saving={saving} />
							Save Changes
							<Spinner className="invisible" />
						</Button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	)
}
