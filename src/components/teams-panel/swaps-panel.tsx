import * as Icons from 'lucide-react'
import React from 'react'

import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { MatchTeamDisplay } from '@/components/teams-display'
import { teamCountsAfterSwap } from '@/components/teams-panel/teams-panel.helpers'
import type { TeamswapsHelpWindowProps } from '@/components/teamswaps-help-window.helpers'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { OpenWindowInteraction } from '@/components/ui/draggable-window'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import type * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as MapUtils from '@/lib/map-utils'
import { cn } from '@/lib/utils.ts'
import * as Zus from '@/lib/zustand'
import * as SM_Msgs from '@/messages/squad.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import type * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models.ts'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as TSWClient from '@/systems/teamswaps.client'
import * as UPClient from '@/systems/user-presence.client'

function TeamsAfterSwap(props: { leftTeam: MH.NormedTeamId; rightTeam: MH.NormedTeamId; stores: SquadServerFrame.KeyProp }) {
	const counts = Zus.useStore(
		props.stores.squadServer!,
		MatchHistoryClient.currentMatch$(props.stores.squadServer!.serverId),
		teamCountsAfterSwap,
	)
	return (
		<div className="flex flex-col items-center">
			<span className="text-xs text-text-3">{tr.text(SM_Msgs.teamsAfterSwap())}</span>
			<span className="inline-flex font-mono">
				<span>{counts[props.leftTeam]}</span>v<span>{counts[props.rightTeam]}</span>
			</span>
		</div>
	)
}

export function SwapsPanel({
	className,
	leftTeam,
	rightTeam,
	stores,
}: {
	className?: string
	leftTeam: MH.NormedTeamId
	rightTeam: MH.NormedTeamId
	stores: SquadServerFrame.KeyProp
}) {
	const canExecute = Zus.useStore(stores.squadServer!, TSWClient.Sel.canExecuteSavedTeamswaps)
	const swapsModified = Zus.useStore(stores.squadServer!, TSWClient.Sel.swapsModified)
	const [isEditing, setIsEditing] = UPClient.useEditingTeamswapsState(stores.squadServer!.serverId)
	const numEditors = Zus.useStore(UPClient.Store, (s) => s.teamswapEditors.size)
	const [forceSave, setForceSave] = React.useState(false)
	const startEditingDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players', { serverId: stores.squadServer!.serverId }))

	const handleFinishOrSave = () => {
		const shouldSave = swapsModified && (numEditors <= 1 || forceSave)
		// clears teamswap editing across all of this user's clients via the presence reducer fan-out
		setIsEditing(false)
		if (shouldSave) {
			TSWClient.Actions.save(stores)
		}
		setForceSave(false)
	}

	const saveButtonLabel = tr.text(
		forceSave ? UI_Msgs.forceSave() : numEditors <= 1 && swapsModified ? UI_Msgs.save() : UI_Msgs.finishEditing(),
	)

	return (
		<div data-tour="swaps-panel" className={cn('grid grid-cols-[1fr_auto_1fr] items-start divide-x divide-line', className)}>
			<TeamSwapsDisplay teamId={leftTeam} className="pe-2" stores={stores} />
			<div className="flex flex-col items-center gap-1 px-2">
				<div className="flex items-center gap-1">
					<Tooltip help>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={!isEditing || !swapsModified}
								onClick={() => TSWClient.Actions.revertToSaved(stores)}
							>
								<Icons.Undo2 className="rtl:-scale-x-100" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{tr.text(SM_Msgs.revertToSaved())}</TooltipContent>
					</Tooltip>
					{isEditing ? (
						<ButtonGroup>
							<Tooltip help>
								<TooltipTrigger asChild>
									<Button size="icon-sm" variant={forceSave ? 'destructive' : 'default'} onClick={() => setForceSave(!forceSave)}>
										<Icons.Sword />
									</Button>
								</TooltipTrigger>
								<TooltipContent>{tr.text(SM_Msgs.toggleForceSaveHint())}</TooltipContent>
							</Tooltip>
							<Button data-tour="swaps-save" size="sm" variant={forceSave ? 'destructive' : 'primary'} onClick={handleFinishOrSave}>
								{saveButtonLabel}
							</Button>
						</ButtonGroup>
					) : (
						<PermissionDeniedTooltip denied={startEditingDenied}>
							<Button size="sm" disabled={!!startEditingDenied} onClick={() => setIsEditing(true)}>
								<Icons.Edit />
								{tr.text(SM_Msgs.startEditing())}
							</Button>
						</PermissionDeniedTooltip>
					)}
					<AlertDialog>
						<AlertDialogTrigger asChild>
							<Button data-tour="swaps-execute" size="sm" className="text-[#ef7c7a]" disabled={!canExecute || numEditors > 0}>
								{tr.text(SM_Msgs.swapNowLabel())}
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>{tr.text(SM_Msgs.executeSwapsTitle())}</AlertDialogTitle>
								<AlertDialogDescription>{tr.text(SM_Msgs.executeSwapsBlurb())}</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>{tr.text(SM_Msgs.cancel())}</AlertDialogCancel>
								<AlertDialogAction
									className={buttonVariants({ variant: 'destructive' })}
									onClick={() => TSWClient.Actions.executeTeamswaps(stores)}
								>
									{tr.text(SM_Msgs.swapNowLabel())}
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
					<OpenWindowInteraction
						windowId={WINDOW_ID.enum['teamswaps-help']}
						windowProps={{} satisfies TeamswapsHelpWindowProps}
						preload="intent"
						render={({ ref, ...props }: { ref?: React.Ref<HTMLButtonElement> } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
							<Button ref={ref} variant="ghost" size="icon-sm" title={tr.text(SM_Msgs.help())} {...props}>
								<Icons.CircleHelp />
							</Button>
						)}
					/>
				</div>
				<TeamsAfterSwap leftTeam={leftTeam} rightTeam={rightTeam} stores={stores} />
			</div>
			<TeamSwapsDisplay teamId={rightTeam} align="end" className="ps-2" stores={stores} />
		</div>
	)
}

function TeamSwapsDisplay(props: {
	teamId: MH.NormedTeamId
	align?: 'start' | 'end'
	className?: string
	stores: SquadServerFrame.KeyProp
}) {
	const swaps = Zus.useStore(props.stores.squadServer!, (frameState: TSWClient.Store & ChatPrt.Store) =>
		TSWClient.Sel.swapsToTeamEnrichedWithMutations(frameState, props.teamId),
	)

	const hasLocal = [...swaps.values()].some((s) => !s.mutation.removed)
	const alignEnd = props.align === 'end'

	return (
		<div className={cn('flex flex-col gap-0.5', alignEnd && 'items-end', props.className)}>
			<h3 className="text-sm">
				{tr.text(SM_Msgs.swapsToCurrent())} <MatchTeamDisplay teamId={props.teamId} showAltTeamIndicator={true} stores={props.stores} />
			</h3>
			<div className={cn('flex flex-wrap items-center gap-1', alignEnd && 'justify-end')}>
				{swaps.size > 0 && <span className="text-xs text-text-3 shrink-0">({swaps.size})</span>}
				{swaps.size === 0 && <span className="text-text-3">{tr.text(SM_Msgs.noSwapsYet())}</span>}
				{MapUtils.mapToArray(swaps, (playerId, s) => (
					<SwapBadge swap={s} key={playerId} stores={props.stores} />
				))}
				{hasLocal && (
					<Button
						variant="ghost"
						size="icon-sm"
						className="shrink-0"
						onClick={() => TSWClient.Actions.clearTeamSwaps(props.stores, props.teamId)}
						title={tr.text(SM_Msgs.clearAllSwaps())}
					>
						<Icons.Trash2 />
					</Button>
				)}
			</div>
		</div>
	)
}

function SwapBadge(props: { swap: TSWClient.Sel.EnrichedTeamswapWithMutation; stores: SquadServerFrame.KeyProp }) {
	const { mutation } = props.swap
	const playerId = SM.PlayerIds.getPlayerId(props.swap.player.ids)
	const variant = mutation.added ? 'added' : mutation.removed ? 'removed' : 'secondary'

	return (
		<Badge
			data-tour="swap-badge"
			variant={variant}
			className="flex items-center gap-1"
			title={mutation.removed ? undefined : tr.text(SM_Msgs.middleClickDeleteSwap())}
			onMouseDown={(e) => {
				// prevent middle-click autoscroll
				if (e.button === 1) e.preventDefault()
			}}
			onAuxClick={(e) => {
				if (e.button !== 1 || mutation.removed) return
				TSWClient.Actions.removeSwap(props.stores, [playerId])
			}}
		>
			<span className={mutation.removed ? 'line-through opacity-60' : undefined}>{props.swap.player.ids.username}</span>
			{!mutation.removed && (
				<button
					type="button"
					onClick={() => TSWClient.Actions.removeSwap(props.stores, [playerId])}
					className="ms-0.5 opacity-70 hover:opacity-100"
					title={tr.text(SM_Msgs.deleteSwapAction())}
				>
					<Icons.X className="size-2.5" />
				</button>
			)}
		</Badge>
	)
}
