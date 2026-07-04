import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { useToast } from '@/hooks/use-toast'
import * as ZusUtils from '@/lib/zustand'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswitches.client'
import * as UPClient from '@/systems/user-presence.client'
import React from 'react'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import { contextMenuSlots, PlayerCopyIdsSub, PlayerOpenLinksSub } from './player-context-menu-options'
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuShortcut } from './ui/context-menu'
import { useAlertDialog, useCloseAlertDialog } from './ui/lazy-alert-dialog'

export default function PlayerBulkContextMenuOptions(
	{ playerIds, stores }: { playerIds: SM.PlayerId[]; stores: SquadServerFrame.KeyProp },
) {
	const openDialog = useAlertDialog()
	const closeDialog = useCloseAlertDialog()
	const { toast } = useToast()

	const warnMutation = SquadServerClient.useWarnPlayerMutation()
	const removeFromSquadMutation = SquadServerClient.useRemoveFromSquadMutation()
	const serverId = stores.squadServer.serverId

	const manageDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players'))
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players'))
	const canSwitchNow = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.canSwitchNow(playerIds))
	const canQueue = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.canQueue(playerIds))

	// Run per-player server mutations without one failure aborting the rest, then summarize.
	async function runForEach(action: string, run: (playerId: SM.PlayerId) => Promise<unknown>) {
		const results = await Promise.allSettled(playerIds.map(run))
		const failed = results.filter(r => r.status === 'rejected').length
		if (failed > 0) {
			toast({
				title: `${action} partially failed`,
				description: `${playerIds.length - failed} of ${playerIds.length} succeeded, ${failed} failed`,
				variant: 'destructive',
			})
		}
	}

	async function switchNow() {
		const initialState = TSWClient.Sel.localState(ZusUtils.getState(stores.squadServer))
		const initialTeams = new Map(playerIds.map(id => [id, initialState.players.get(id)]))
		const unsubscribe = ZusUtils.resolveReadStore(stores.squadServer).subscribe(state => {
			const current = TSWClient.Sel.localState(state)
			if (playerIds.some(id => current.players.get(id) !== initialTeams.get(id))) closeDialog()
		})
		try {
			await UPClient.Actions.withPlayerDialogue('SWITCHING_PLAYERS', async () => {
				const result = await openDialog({
					title: 'Switch Players Now',
					description: `Move ${playerIds.length} players to the opposite team immediately?`,
					buttons: [{ id: 'confirm', label: 'Switch Now', variant: 'destructive' }],
				})
				if (result === 'dismissed') {
					toast({ title: 'Switch cancelled', description: 'One or more players changed teams', variant: 'destructive' })
					return
				}
				if (result !== 'confirm') return
				TSWClient.Actions.switchNow(stores, playerIds)
			})
		} finally {
			unsubscribe()
		}
	}

	async function warn() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		await UPClient.Actions.withPlayerDialogue('WARNING_PLAYERS', async () => {
			let reason = ''
			const allPlayers = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer)).players
			const usernames = playerIds.map(id => SM.PlayerIds.find(allPlayers, p => p.ids, id)?.ids.username ?? id)
			const result = await openDialog({
				title: `Warn ${playerIds.length} Players`,
				description: usernames.join(', '),
				content: (
					<input
						className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						placeholder="Warn reason"
						autoFocus
						onChange={e => {
							reason = e.target.value
						}}
					/>
				),
				buttons: [{ id: 'confirm', label: 'Send Warning' }],
			})
			if (result !== 'confirm' || !reason.trim()) return
			const trimmed = reason.trim()
			await runForEach('Warn', playerId => warnMutation.mutateAsync({ serverId, playerId, reason: trimmed }))
		})
	}

	async function removeFromSquad() {
		TSWClient.Actions.ensureViewingTeams(serverId)
		await UPClient.Actions.withPlayerDialogue('REMOVING_FROM_SQUAD', async () => {
			const result = await openDialog({
				title: 'Remove from Squad',
				description: `Remove ${playerIds.length} players from their squads?`,
				buttons: [{ id: 'confirm', label: 'Remove' }],
			})
			if (result !== 'confirm') return
			await runForEach('Remove from squad', playerId => removeFromSquadMutation.mutateAsync({ serverId, playerId }))
		})
	}

	return (
		<>
			<ContextMenuLabel>{playerIds.length} players selected</ContextMenuLabel>
			<ContextMenuItem onClick={() => SquadServerClient.Actions.invertSelection(stores)}>
				Invert Selection
				<ContextMenuShortcut>Alt+Ctrl+click select-all box</ContextMenuShortcut>
			</ContextMenuItem>
			<ContextMenuSeparator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<ContextMenuItem onClick={() => TSWClient.Actions.switchNext(stores, playerIds)} disabled={!!manageDenied || !canQueue}>
					Switch Next
				</ContextMenuItem>
			</PermissionDeniedTooltip>
			<ContextMenuSeparator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<ContextMenuItem
					className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600"
					onClick={switchNow}
					disabled={!!manageDenied || !canSwitchNow}
				>
					Switch Now
				</ContextMenuItem>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<ContextMenuItem onClick={() => TSWClient.Actions.removeSwitch(stores, playerIds)} disabled={!!manageDenied}>
					Delete Switches
				</ContextMenuItem>
			</PermissionDeniedTooltip>
			<ContextMenuSeparator />
			<PlayerOpenLinksSub playerIds={playerIds} slots={contextMenuSlots} stores={stores} />
			<PlayerCopyIdsSub playerIds={playerIds} slots={contextMenuSlots} stores={stores} />
			<ContextMenuSeparator />
			<PermissionDeniedTooltip denied={warnDenied}>
				<ContextMenuItem onClick={warn} disabled={!!warnDenied}>Warn</ContextMenuItem>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<ContextMenuItem onClick={removeFromSquad} disabled={!!manageDenied}>Remove from Squad</ContextMenuItem>
			</PermissionDeniedTooltip>
		</>
	)
}
