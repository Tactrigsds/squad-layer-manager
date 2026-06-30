import { useToast } from '@/hooks/use-toast'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswitches.client'
import React from 'react'
import { PermissionDeniedTooltip } from './permission-denied-tooltip'
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from './ui/context-menu'
import { useAlertDialog, useCloseAlertDialog } from './ui/lazy-alert-dialog'

export default function PlayerBulkContextMenuOptions({ playerIds }: { playerIds: SM.PlayerId[] }) {
	const openDialog = useAlertDialog()
	const closeDialog = useCloseAlertDialog()
	const { toast } = useToast()

	const warnMutation = SquadServerClient.useWarnPlayerMutation()
	const removeFromSquadMutation = SquadServerClient.useRemoveFromSquadMutation()

	const manageDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players'))
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players'))

	async function switchNow() {
		const initialState = TSWClient.Select.localState(TSWClient.Store.getState())
		const initialTeams = new Map(playerIds.map(id => [id, initialState.players.get(id)]))
		const unsubscribe = TSWClient.Store.subscribe(state => {
			const current = TSWClient.Select.localState(state)
			if (playerIds.some(id => current.players.get(id) !== initialTeams.get(id))) closeDialog()
		})
		const result = await openDialog({
			title: 'Switch Players Now',
			description: `Move ${playerIds.length} players to the opposite team immediately?`,
			buttons: [{ id: 'confirm', label: 'Switch Now' }],
		})
		unsubscribe()
		if (result === 'dismissed') {
			toast({ title: 'Switch cancelled', description: 'One or more players changed teams', variant: 'destructive' })
			return
		}
		if (result !== 'confirm') return
		TSWClient.Actions.switchNow(playerIds)
	}

	async function warn() {
		TSWClient.Actions.ensureViewingTeams()
		let reason = ''
		const allPlayers = SquadServerClient.ChatStore.getState().chatState.interpolatedState.players
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
		await Promise.all(playerIds.map(playerId => warnMutation.mutateAsync({ playerId, reason: reason.trim() })))
	}

	async function removeFromSquad() {
		TSWClient.Actions.ensureViewingTeams()
		const result = await openDialog({
			title: 'Remove from Squad',
			description: `Remove ${playerIds.length} players from their squads?`,
			buttons: [{ id: 'confirm', label: 'Remove' }],
		})
		if (result !== 'confirm') return
		await Promise.all(playerIds.map(id => removeFromSquadMutation.mutateAsync(id)))
	}

	return (
		<>
			<ContextMenuLabel>{playerIds.length} players selected</ContextMenuLabel>
			<ContextMenuSeparator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<ContextMenuItem onClick={switchNow} disabled={!!manageDenied}>Switch Now</ContextMenuItem>
			</PermissionDeniedTooltip>
			<ContextMenuSeparator />
			<PermissionDeniedTooltip denied={manageDenied}>
				<ContextMenuItem onClick={() => TSWClient.Actions.switchNext(playerIds)} disabled={!!manageDenied}>
					Switch Next
				</ContextMenuItem>
			</PermissionDeniedTooltip>
			<PermissionDeniedTooltip denied={manageDenied}>
				<ContextMenuItem onClick={() => TSWClient.Actions.removeSwitch(playerIds)} disabled={!!manageDenied}>
					Delete Switches
				</ContextMenuItem>
			</PermissionDeniedTooltip>
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
