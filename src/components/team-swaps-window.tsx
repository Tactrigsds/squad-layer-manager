import * as Icons from 'lucide-react'
import React from 'react'

import { MatchTeamDisplay } from '@/components/teams-display'
import * as ChatPrt from '@/frame-partials/chat.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as MapUtils from '@/lib/map-utils'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as SM_Msgs from '@/messages/squad.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import type * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as TSWClient from '@/systems/teamswaps.client'
import * as UPClient from '@/systems/user-presence.client'

import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import type { TeamSwapsWindowProps } from './team-swaps-window.helpers'
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
} from './ui/alert-dialog'
import { Button, buttonVariants } from './ui/button'
import { ButtonGroup } from './ui/button-group'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowTitle } from './ui/draggable-window'

// The phone's home for editing team swaps. The Teams list only summarises them there: a 390px list has no room
// for the desktop panel's badges and five controls above every roster row.
DraggableWindowStore.getState().registerDefinition<TeamSwapsWindowProps, unknown>({
	type: WINDOW_ID.enum['team-swaps'],
	component: TeamSwapsWindow,
	initialPosition: 'viewport-center',
	resizable: true,
	minWidth: 320,
	minHeight: 320,
	defaultWidth: 420,
	defaultHeight: 560,
	getId: (props) => `team-swaps:${props.stores.squadServer.serverId}`,
})

function TeamSwapsWindow({ stores }: TeamSwapsWindowProps) {
	const squadServer = stores.squadServer
	const serverId = squadServer.serverId

	const match = MatchHistoryClient.useCurrentMatch(serverId)
	const selectedIds = Zus.useStore(squadServer, (s: SquadServerFrame.State) => {
		const sel = SquadServerFrame.Sel.playerSelection(s)
		return Object.keys(sel).filter((id) => sel[id])
	})
	const canQueueSelected = Zus.useStore(squadServer, TSWClient.Sel.someCanQueue(selectedIds))
	const canExecute = Zus.useStore(squadServer, TSWClient.Sel.canExecuteSavedTeamswaps)
	const swapsModified = Zus.useStore(squadServer, TSWClient.Sel.swapsModified)
	const [isEditing, setIsEditing] = UPClient.useEditingTeamswapsState(serverId)
	const numEditors = Zus.useStore(UPClient.Store, (s) => s.teamswapEditors.size)
	const [forceSave, setForceSave] = React.useState(false)
	const manageDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players', { serverId }))

	const finishOrSave = () => {
		const shouldSave = swapsModified && (numEditors <= 1 || forceSave)
		setIsEditing(false)
		if (shouldSave) TSWClient.Actions.save(stores)
		setForceSave(false)
	}
	const saveLabel = forceSave ? 'Force Save' : numEditors <= 1 && swapsModified ? 'Save' : 'Finish Editing'

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>
					{tr.text(SM_Msgs.teamSwapsTitle())}
					{numEditors > 1 && <span className="ml-1 font-normal text-muted-foreground">({numEditors})</span>}
				</DraggableWindowTitle>
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 pt-2 text-sm">
				<MatchTeamDisplay teamId="A" showAltTeamIndicator stores={stores} />
				<AfterSwapCounts stores={stores} />
				<span className="flex justify-end">
					<MatchTeamDisplay teamId="B" showAltTeamIndicator stores={stores} />
				</span>
			</div>
			<div className="px-3 py-2">
				<PermissionDeniedTooltip denied={manageDenied}>
					<Button
						className="w-full"
						disabled={!!manageDenied || selectedIds.length === 0 || !canQueueSelected}
						onClick={() => TSWClient.Actions.swapNext(stores, selectedIds)}
					>
						<Icons.Plus />
						{tr.text(SM_Msgs.addSelectedToSwaps(selectedIds.length))}
					</Button>
				</PermissionDeniedTooltip>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{(['A', 'B'] as const).map((team) => (
					<DestinationSection key={team} team={team} match={match} stores={stores} />
				))}
				<p className="mx-3 my-2 rounded-[3px] border border-line-soft bg-[#3a3a3d] px-2.5 py-2 text-xs text-text-2">
					{tr.text(SM_Msgs.swapsRunAtMatchStart())}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1.5 border-t border-line px-3 py-2 shadow-[inset_0_1px_0_var(--line-soft)]">
				<Button
					variant="ghost"
					size="icon-sm"
					disabled={!isEditing || !swapsModified}
					onClick={() => TSWClient.Actions.revertToSaved(stores)}
					title={tr.text(SM_Msgs.revertToSaved())}
				>
					<Icons.Undo2 />
				</Button>
				{isEditing ? (
					<ButtonGroup>
						<Button
							size="icon-sm"
							variant={forceSave ? 'destructive' : 'default'}
							onClick={() => setForceSave(!forceSave)}
							title={tr.text(SM_Msgs.toggleForceSaveHint())}
						>
							<Icons.Sword />
						</Button>
						<Button size="sm" variant={forceSave ? 'destructive' : 'primary'} onClick={finishOrSave}>
							{saveLabel}
						</Button>
					</ButtonGroup>
				) : (
					<PermissionDeniedTooltip denied={manageDenied}>
						<Button size="sm" disabled={!!manageDenied} onClick={() => setIsEditing(true)}>
							<Icons.Edit />
							{tr.text(SM_Msgs.startEditing())}
						</Button>
					</PermissionDeniedTooltip>
				)}
				<span className="flex-1" />
				<AlertDialog>
					<AlertDialogTrigger asChild>
						<Button size="sm" className="text-[#ef7c7a]" disabled={!canExecute || numEditors > 0}>
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
				<Button
					variant="ghost"
					size="icon-sm"
					title={tr.text(SM_Msgs.clearAllSwaps())}
					onClick={() => {
						TSWClient.Actions.clearTeamSwaps(stores, 'A')
						TSWClient.Actions.clearTeamSwaps(stores, 'B')
					}}
				>
					<Icons.Trash2 />
				</Button>
			</div>
		</div>
	)
}

function AfterSwapCounts({ stores }: { stores: SquadServerFrame.KeyProp }) {
	const serverId = stores.squadServer.serverId
	const counts = Zus.useStore(stores.squadServer, MatchHistoryClient.currentMatch$(serverId), (s, match) => ({
		A: ChatPrt.Sel.playersForTeam('A')(s, match).length,
		B: ChatPrt.Sel.playersForTeam('B')(s, match).length,
		dA: TSWClient.Sel.diffAfterSwapsForTeam('A')(s),
		dB: TSWClient.Sel.diffAfterSwapsForTeam('B')(s),
	}))
	const changed = counts.dA !== 0 || counts.dB !== 0
	return (
		<span className="font-mono text-sm font-semibold">
			{counts.A}v{counts.B}
			{changed && (
				<>
					<span className="mx-1 text-text-3">→</span>
					<span className="text-pri">
						{counts.A + counts.dA}v{counts.B + counts.dB}
					</span>
				</>
			)}
		</span>
	)
}

function DestinationSection({
	team,
	match,
	stores,
}: {
	team: MH.NormedTeamId
	match: MH.MatchDetails | undefined
	stores: SquadServerFrame.KeyProp
}) {
	const swaps = Zus.useStore(stores.squadServer, (s: TSWClient.Store & ChatPrt.Store) =>
		TSWClient.Sel.swapsToTeamEnrichedWithMutations(s, team),
	)
	const pending = [...swaps.values()].filter((s) => !s.mutation.removed).length
	return (
		<section>
			<h3 className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-sm font-bold shadow-[inset_0_1px_0_var(--line-soft)]">
				<span className="text-text-3">→</span>
				<MatchTeamDisplay teamId={team} showAltTeamIndicator stores={stores} />
				<span className="font-normal text-text-3">{tr.text(SM_Msgs.swapsPending(pending))}</span>
			</h3>
			{swaps.size === 0 && <p className="px-3 py-2 text-xs text-text-3">{tr.text(SM_Msgs.noSwapsYet())}</p>}
			{MapUtils.mapToArray(swaps, (playerId, swap_) => (
				<SwapRow key={playerId} playerId={playerId} swap={swap_} match={match} stores={stores} />
			))}
		</section>
	)
}

function SwapRow({
	playerId,
	swap,
	match,
	stores,
}: {
	playerId: SM.PlayerId
	swap: TSWClient.Sel.EnrichedTeamswapWithMutation
	match: MH.MatchDetails | undefined
	stores: SquadServerFrame.KeyProp
}) {
	const { mutation, player } = swap
	return (
		<div
			className={cn(
				'grid min-h-(--row) grid-cols-[minmax(0,1fr)_auto_var(--ctl)] items-center gap-2 border-b border-[#2d2d2f] bg-[rgba(230,180,34,0.10)] pl-3',
				mutation.added && 'shadow-[inset_3px_0_0_var(--ok)]',
				mutation.removed && 'opacity-60',
			)}
		>
			<span className={cn('truncate font-bold', mutation.removed && 'line-through')}>{player.ids.username}</span>
			<span className="whitespace-nowrap text-xs text-text-2">
				{player.teamId !== null && match && <MatchTeamDisplay matchId={match.historyEntryId} teamId={player.teamId} stores={stores} />}
				{player.squadId !== null && <> · {tr.text(SM_Msgs.squadWithId(player.squadId))}</>}
			</span>
			{!mutation.removed ? (
				<Button
					variant="ghost"
					size="icon"
					onClick={() => TSWClient.Actions.removeSwap(stores, [playerId])}
					title={tr.text(SM_Msgs.deleteSwapAction())}
				>
					<Icons.X />
				</Button>
			) : (
				<span />
			)}
		</div>
	)
}
