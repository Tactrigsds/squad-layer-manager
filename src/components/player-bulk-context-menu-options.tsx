import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { useToast } from '@/hooks/use-toast'
import * as ZusUtils from '@/lib/zustand'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import { useOpenOrFocusWindow } from '@/systems/draggable-window.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswitches.client'
import * as UPClient from '@/systems/user-presence.client'
import * as WarnChat from '@/systems/warn-chat.client'
import React from 'react'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import { contextMenuSlots, PlayerCopyIdsSub, PlayerOpenLinksSub } from './player-context-menu-options'
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuShortcut } from './ui/context-menu'
import { useAlertDialog, useCloseAlertDialog } from './ui/lazy-alert-dialog'

// When the selection is exactly one squad's full membership (and nothing else), returns that squad so the
// warn action can route to the squad details window; otherwise null (mixed/partial selection).
function detectFullSquadSelection(
	selectedIds: SM.PlayerId[],
	players: SM.Player[],
	squads: SM.UniqueSquad[],
): SM.UniqueSquad | null {
	if (selectedIds.length === 0) return null
	const first = SM.PlayerIds.find(players, p => p.ids, selectedIds[0])
	if (!first || first.squadId === null || first.teamId === null) return null
	const { squadId, teamId } = first
	for (const id of selectedIds) {
		const p = SM.PlayerIds.find(players, p => p.ids, id)
		if (!p || p.squadId !== squadId || p.teamId !== teamId) return null
	}
	const memberCount = players.filter(p => p.squadId === squadId && p.teamId === teamId).length
	if (memberCount !== selectedIds.length) return null
	return squads.find(s => s.squadId === squadId && s.teamId === teamId) ?? null
}

export default function PlayerBulkContextMenuOptions(
	{ playerIds, stores }: { playerIds: SM.PlayerId[]; stores: SquadServerFrame.KeyProp },
) {
	const openDialog = useAlertDialog()
	const closeDialog = useCloseAlertDialog()
	const { toast } = useToast()

	const removePlayersFromSquadMutation = SquadServerClient.useRemovePlayersFromSquadMutation()
	const serverId = stores.squadServer.serverId
	const openOrFocusWindow = useOpenOrFocusWindow()

	const manageDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players'))
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players'))
	const canSwitchNow = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.canSwitchNow(playerIds))
	const canQueue = ZusUtils.useStore(stores.squadServer, TSWClient.Sel.someCanQueue(playerIds))

	// when the selection is exactly one full squad, the warn action targets the squad details window and the
	// menu item reads "Warn Squad"; otherwise it routes to the server activity "selected" warn box
	const fullSquad = ZusUtils.useStore(
		stores.squadServer,
		(chatStore: ChatPrt.Store) => {
			const state = ChatPrt.Sel.chatState(chatStore)
			return detectFullSquadSelection(playerIds, state.players, state.squads)
		},
	)

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

	// a full-squad selection warns via the squad details window (prefixed @Squad); anything else routes to the
	// server activity "selected" warn box, which warns exactly the current selection
	function warn() {
		if (fullSquad) {
			openOrFocusWindow(WINDOW_ID.enum['squad-details'], { uniqueSquadId: fullSquad.uniqueId, stores })
			WarnChat.requestWarnFocus({ kind: 'squad', uniqueSquadId: fullSquad.uniqueId })
		} else {
			WarnChat.requestWarnFocus({ kind: 'server-activity' })
		}
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
			// one call for the whole batch: the server aggregates the resulting squad-leaves under a single app event
			try {
				await removePlayersFromSquadMutation.mutateAsync({ serverId, playerIds })
			} catch {
				toast({ title: 'Remove from squad failed', description: `Failed to remove ${playerIds.length} players`, variant: 'destructive' })
			}
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
				<ContextMenuItem onClick={warn} disabled={!!warnDenied}>{fullSquad ? 'Warn Squad' : 'Warn'}</ContextMenuItem>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<ContextMenuItem onClick={removeFromSquad} disabled={!!manageDenied}>Remove from Squad</ContextMenuItem>
			</PermissionDeniedTooltip>
		</>
	)
}
